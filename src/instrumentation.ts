// Runs once when the server process starts. We use it to drive scheduled
// backups from within the app (no external cron needed). The check is cheap and
// advisory-lock guarded, so it's safe to run on an interval and with multiple
// instances.
//
// 1.21.0: cloud mode (lib/cloud) is checked first and refuses to start
// without its encryption key; in JSON logging mode every console line
// becomes a JSON object (lib/log); and every scheduler and background job
// goes through lib/shutdown (every / after / runJob), so SIGTERM stops new
// work, waits for what runs and then closes the database pool (start.cjs).
//
// 1.21.1: OpenTelemetry traces and metrics start first, before anything loads
// the Postgres driver, and only when APPLICATIONINSIGHTS_CONNECTION_STRING or
// OTEL_EXPORTER_OTLP_ENDPOINT is set (lib/telemetry-config); without one,
// nothing of it is loaded.
export async function register() {
  // Only in the Node.js server runtime — not during build or on the edge.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { installJsonConsole, logEvent } = await import("./lib/log");
  installJsonConsole();

  // 1.21.3: DATABASE_AUTH (lib/db-auth), in both modes: a setting that can't work
  // (entra with a password, without SSL, or without a role in DATABASE_URL)
  // exits here, saying which. Unset, nothing is said and nothing changes.
  if (!(await (await import("./lib/db-auth")).checkDatabaseAuthStartup(logEvent))) return;

  // Never fatal: a malformed setting or an SDK that fails to start is one warning, and the app runs without it.
  await (await import("./lib/telemetry-config")).startTelemetryIfConfigured(logEvent);

  const { isCloud } = await import("./lib/cloud");
  // Cloud mode without its encryption key (or database) exits here, saying why.
  if (isCloud()) await (await import("./lib/shutdown")).checkCloudStartup(logEvent);
  // Self-hosted: an encryption key in the environment that differs from the
  // key file exits here too, saying which to keep (lib/secretbox).
  else
    await (await import("./lib/secretbox")).checkSelfHostedKey(logEvent, undefined, async () => {
      // One sealed value says which key this install has been using (no
      // settings table yet: nothing is sealed).
      const { pool } = await import("./lib/db");
      const t = await pool().query<{ t: string | null }>("SELECT to_regclass('settings')::text AS t");
      if (!t.rows[0]?.t) return null;
      const r = await pool().query<{ value: string }>("SELECT value FROM settings WHERE value LIKE 'enc:v1:%' LIMIT 1");
      return r.rows[0]?.value ?? null;
    });

  // 1.21.2: the blob file store (lib/file-store), when it is chosen: a missing or invalid
  // setting exits here, saying which; an unreachable container is one error line and
  // /readyz stays not ready until it answers. Nothing for the uploads folder.
  await (await import("./lib/file-store")).checkFileStoreStartup(logEvent);

  const { every, after, runJob, jobError, onDrain, onClose, exposeLifecycle } = await import("./lib/shutdown");
  exposeLifecycle();
  // The desk's live streams end first (they would otherwise hold the server
  // open until the deadline); the pool closes last, once nothing uses it.
  onDrain("helpdesk-live", async () => {
    const { stopLive } = await import("./lib/helpdesk/live");
    await stopLive();
  });
  onClose("database-pool", async () => {
    const { closePool } = await import("./lib/db");
    await closePool();
  });

  // The origin for links sent from the background: the custom domain (as
  // before), or in cloud mode the platform's COMPASSDOCS_BASE_URL.
  const backgroundOrigin = async (): Promise<string> => {
    return ((await (await import("./lib/workspace-origin")).domainOrigin()) ?? "").replace(/\/+$/, "");
  };

  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

  // 1.20.27 (security review M11): a fresh install prints its first-run
  // setup token to the log, where only the operator can read it.
  void (async () => {
    try {
      const { needsSetup } = await import("./lib/db");
      if (await needsSetup()) (await import("./lib/setup-token")).printSetupToken("boot");
    } catch (e) {
      console.error("[setup] could not check for first-run setup:", e);
    }
  })();

  const tick = async () => {
    // Local backups are CompassDocs Cloud's in cloud mode (lib/cloud).
    if (!isCloud()) {
      try {
        const { runScheduledBackupIfDue } = await import("./lib/backup");
        await runScheduledBackupIfDue();
      } catch (e) {
        jobError("[backup] scheduler error:", e);
      }
    }
    // Content review reminders: emails approvers when a review comes due.
    // The claim is a single atomic UPDATE, so concurrent instances are safe.
    try {
      const { remindDueReviews } = await import("./lib/reviews");
      await remindDueReviews();
    } catch (e) {
      jobError("[reviews] scheduler error:", e);
    }
    // Weekly digest emails (Monday morning; claimed once per ISO week).
    try {
      const { maybeSendWeeklyDigests } = await import("./lib/digest");
      await maybeSendWeeklyDigests();
    } catch (e) {
      jobError("[digest] scheduler error:", e);
    }
    // Hourly and daily notification digests (1.19.0, lib/notify-policy):
    // queued emails, one summary per person; rows are claimed with SKIP
    // LOCKED, so every instance may run this. Never throws.
    try {
      const { sendNotificationDigests } = await import("./lib/notify-policy");
      await sendNotificationDigests();
    } catch (e) {
      jobError("[notify-digest] scheduler error:", e);
    }
    // Training due/overdue reminders (entitlement-gated inside; atomic claim).
    try {
      const { trainingHourly } = await import("./lib/training");
      await trainingHourly();
    } catch (e) {
      jobError("[training] scheduler error:", e);
    }
    // Read confirmations (Enterprise, policy_ack; gated inside): the
    // audience reconcile, expired exemptions, due and overdue reminders,
    // escalations and the re-confirmation cycles, each an atomic claim so
    // every instance may run this; the notices go through the outbox the
    // minute tick drains.
    try {
      const { complianceHourly } = await import("./lib/compliance");
      await complianceHourly();
    } catch (e) {
      jobError("[compliance] scheduler error:", e);
    }
    // The neutral weekly and monthly work (1.14.0): the team digest for
    // group leads, the monthly compliance evidence, the weekly compliance
    // report and the weekly channel summary, each gated inside on its
    // licence and claimed once per period (the settings table or a unique
    // index), so every instance may run this; each step has its own catch.
    try {
      const { runPeriodic } = await import("./lib/periodic");
      await runPeriodic();
    } catch (e) {
      jobError("[periodic] scheduler error:", e);
    }
    // Scheduled directory syncs (Enterprise): each provider on its own
    // schedule, one instance at a time, with an emailed report.
    try {
      const { runScheduledDirectorySyncs } = await import("./lib/directory-schedule");
      await runScheduledDirectorySyncs();
    } catch (e) {
      jobError("[directory] scheduler error:", e);
    }
    // Export presets that email themselves (weekly / monthly), one instance.
    try {
      const { runScheduledDirectoryExports } = await import("./lib/directory-export-schedule");
      await runScheduledDirectoryExports();
    } catch (e) {
      jobError("[directory] export scheduler error:", e);
    }
    // Housekeeping: purge expired sessions / OAuth codes so they don't
    // accumulate forever. Plain deletes — safe to run from every instance.
    try {
      const { runDbMaintenance } = await import("./lib/db");
      await runDbMaintenance();
    } catch (e) {
      jobError("[maintenance] scheduler error:", e);
    }
  };

  // First check shortly after boot, then hourly.
  after(60_000, () => runJob("hourly", tick));
  every(CHECK_INTERVAL_MS, () => runJob("hourly", tick));

  // Scheduled newsletters: check every minute. The claim is a single atomic
  // UPDATE, so overlapping instances can't double-send.
  const newsletterTick = async () => {
    try {
      const { sendDueNewsletters } = await import("./lib/newsletter-scheduler");
      await sendDueNewsletters();
    } catch (e) {
      jobError("[newsletter] scheduler error:", e);
    }
    // 1.20.31: newsletters going out through Microsoft 365, about 25 a minute
    // (lib/newsletter-delivery; one claimed job at a time, so every instance may run this).
    // 1.20.32: its sends are spread over the minute on the mailbox's shared budget, so the
    // batch is not waited on here (the job's claim keeps a second batch from starting).
    void runJob("newsletter-delivery", async () => {
      try {
        const { newsletterDeliveryTick } = await import("./lib/newsletter-delivery");
        await newsletterDeliveryTick();
      } catch (e) {
        jobError("[newsletter] delivery error:", e);
      }
    });
    // 1.20.32: the outbox of the workspace's email through Microsoft 365 (lib/mail-outbox):
    // rows a dead instance left half-sent are taken back, uncertain ones settled where the
    // mailbox can be read, and the worker started. Each enqueue starts it too; the claim
    // takes a row lock with SKIP LOCKED and one shared budget, so every instance may run this.
    try {
      const { outboxTick } = await import("./lib/mail-outbox");
      await outboxTick();
    } catch (e) {
      jobError("[mail-outbox] tick error:", e);
    }
    // Scheduled document publishes / auto-unpublishes (atomic claims too).
    try {
      const { runDueDocSchedules } = await import("./lib/doc-schedule");
      await runDueDocSchedules();
    } catch (e) {
      jobError("[doc-schedule] scheduler error:", e);
    }
    // SaaS status polling: the per-service claim limits real work to one poll
    // per service per POLL_INTERVAL, so a minutely call here is cheap.
    try {
      const { refreshDueStatuses } = await import("./lib/status");
      await refreshDueStatuses(await backgroundOrigin());
    } catch (e) {
      jobError("[status] scheduler error:", e);
    }
    // Helpdesk (Enterprise, helpdesk; gated inside): SLA breaches and
    // warnings, workflow waits and approval reminders, upload cleanup. Each
    // sweep claims its own rows, so every instance may run this.
    try {
      const { runHelpdeskSweeps } = await import("./lib/periodic");
      await runHelpdeskSweeps();
    } catch (e) {
      jobError("[helpdesk] sweep error:", e);
    }
    // Read-confirmation notices (Enterprise, policy_ack): drain the outbox.
    // The claim is one UPDATE with FOR UPDATE SKIP LOCKED, so every instance
    // may run this; a row is delivered once, keeps its claim fresh while it
    // is being delivered, and is taken again after a ten-minute reclaim only
    // when its instance died mid-send. Links use the custom domain; without
    // one, each row carries the origin of the request that queued it.
    try {
      const { featureEnabled } = await import("./lib/ee");
      if (await featureEnabled("policy_ack")) {
        const { deliverAckNotices } = await import("./lib/compliance");
        await deliverAckNotices({ origin: await backgroundOrigin() });
      }
    } catch (e) {
      jobError("[ack] notice outbox error:", e);
    }
  };
  // A custom domain waiting for its DNS (1.20.29, lib/domain-flow): checked
  // again every five minutes for 24 hours and switched on when it passes.
  // One settings read a minute when nothing is due; the check itself is
  // claimed with a compare-and-swap, so every instance may run this.
  const domainTick = async () => {
    try {
      const { recheckPendingDomain } = await import("./lib/domain-flow");
      const r = await recheckPendingDomain();
      if (r.status === "applied") console.log(`[domain] ${r.check?.domain} passed its check and is live`);
    } catch (e) {
      jobError("[domain] re-check error:", e);
    }
  };
  after(30_000, () => runJob("minutely", newsletterTick));
  every(60_000, () => runJob("minutely", newsletterTick));

  // 1.21.3: the license from the CompassDocs console (cloud mode with
  // COMPASSDOCS_LICENSE_URL, lib/license-pull): shortly after start, then about
  // every 6 hours; a console that can't be reached keeps the license in force.
  if (isCloud()) (await import("./lib/license-pull")).startLicensePull();

  // 1.21.4: support access (lib/support) and workspace exports
  // (lib/workspace-export), cloud mode only. Each minute: support requests
  // nobody decided lapse and sessions past their end end (in the audit log);
  // exports past their time are removed and one a restart cut short fails.
  // A drain stops an export being made (it is marked failed, its pieces removed).
  if (isCloud()) {
    onDrain("workspace-export", async () => {
      await (await import("./lib/workspace-export")).abortWorkspaceExports();
    });
    const cloudTick = async () => {
      try {
        await (await import("./lib/support")).sweepSupport();
      } catch (e) {
        jobError("[support] sweep error:", e);
      }
      try {
        await (await import("./lib/workspace-export")).sweepWorkspaceExports();
      } catch (e) {
        jobError("[workspace-export] sweep error:", e);
      }
    };
    after(20_000, () => runJob("cloud-minutely", cloudTick));
    every(60_000, () => runJob("cloud-minutely", cloudTick));
  }

  // The domain and the reverse proxy are CompassDocs Cloud's in cloud mode
  // (lib/cloud): no domain re-checks, nothing pushed to a proxy.
  if (isCloud()) return;
  every(60_000, () => runJob("domain", domainTick));

  // Re-apply the saved domain/TLS config to the reverse proxy so the database
  // stays the source of truth across restarts. No-op if no proxy is attached.
  after(15_000, () =>
    runJob("proxy", async () => {
      try {
        const { applyProxyConfigOnBoot } = await import("./lib/caddy");
        await applyProxyConfigOnBoot();
      } catch (e) {
        jobError("[proxy] boot apply error:", e);
      }
    })
  );
}
