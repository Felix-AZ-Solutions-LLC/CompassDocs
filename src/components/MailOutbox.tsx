"use client";

// Settings → Notifications → Email → Outbox (1.20.32, lib/mail-outbox): the
// workspace's email through Microsoft 365 waits here and goes out paced
// under Exchange's limits, urgent mail first. Shown while Microsoft 365 is
// chosen, or while anything is left in it (after a switch to SMTP).
//
//   counts    waiting (and how many are urgent), sent in the last hour, and
//             the day's recipients against Microsoft's 10,000.
//   pause     Microsoft asked to slow down: a notice-warn with when it ends.
//             A refusal that every message would get: a notice-error with
//             Microsoft's reason, when it tries again by itself, and Try now.
//   problems  the failed and uncertain messages (subject, recipients, when,
//             why) with Retry and Discard. Retry on an uncertain one, and
//             Discard, ask first. Both are audited.
//
// The card reads the outbox again every 15 seconds while it is open.
//
// 1.21.5: email through Azure Communication Services waits here too
// (`paced`): the third count is the hour's sends against the hourly limit
// (ACS has no daily recipient cap), and the sentences name ACS.

import { useEffect, useState } from "react";
import { CircleHelp, Clock, Hourglass, Inbox, RefreshCw, RotateCw, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { SectionEmpty } from "@/components/form";
import { SubHeading } from "@/components/Heading";
import { RelativeTime } from "@/components/RelativeTime";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { MAIL_OUTBOX_KEEP_DAYS, PRIORITY, PRIORITY_LABEL, kindLabel, untilWords, type OutboxProblem, type OutboxView, type OutboxWaiting } from "@/lib/mail-outbox-shared";

const URL_ = "/api/admin/mail/outbox";
const n = (x: number) => x.toLocaleString("en-US");

async function act(body: Record<string, unknown>): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(URL_, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  return { ok: Boolean(res?.ok), data };
}

export function MailOutbox({ initial, paced }: { initial: OutboxView | null; paced: boolean }) {
  const [v, setV] = useState<OutboxView | null>(initial);
  const [busy, setBusy] = useState<string>("");
  const [now, setNow] = useState(() => Date.now());
  const fmt = useFormatDate();

  useEffect(() => {
    // No outbox from the server: the viewer may not read the mail settings (integration.smtp_read). Nothing to show or poll.
    if (!initial) return;
    let alive = true;
    const load = async () => {
      const res = await fetch(URL_).catch(() => null);
      if (res?.status === 403) {
        alive = false;
        clearInterval(t);
        return;
      }
      const fresh = res?.ok ? ((await res.json().catch(() => null)) as OutboxView | null) : null;
      if (alive && fresh) setV(fresh);
      if (alive) setNow(Date.now());
    };
    const t = setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [initial, paced]);

  if (!v || (!paced && !v.m365 && v.method !== "acs" && !v.queued && !v.problems_total)) return null;
  const acs = v.method === "acs";

  async function run(key: string, body: Record<string, unknown>, done: string) {
    setBusy(key);
    const r = await act(body);
    setBusy("");
    if (!r.ok) {
      toast("error", r.data?.error || "That didn't work.");
      return;
    }
    if (r.data?.outbox) setV(r.data.outbox);
    setNow(Date.now());
    toast("ok", done);
  }

  async function retry(p: OutboxProblem) {
    if (p.status === "uncertain") {
      const ok = await confirmDialog({
        title: "Send it again?",
        body: acs
          ? "Azure Communication Services didn't say whether it went out, so it may have already. Sending again may deliver a second copy."
          : "Microsoft didn't answer when it was sent, so it may have gone out already. Check the sending mailbox's Sent Items first: sending again may deliver a second copy.",
        confirmLabel: "Send again",
      });
      if (ok !== true) return;
    }
    await run(`retry-${p.id}`, { action: "retry", id: p.id }, "Queued to send again.");
  }

  async function discard(p: OutboxProblem) {
    const ok = await confirmDialog({
      title: "Discard this email?",
      body: `"${p.subject || "(no subject)"}" to ${p.recipients} is never sent, and its content is deleted. The audit log keeps that you discarded it.`,
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok !== true) return;
    await run(`discard-${p.id}`, { action: "discard", id: p.id }, "Discarded.");
  }

  async function discardWaiting(w: OutboxWaiting) {
    const ok = await confirmDialog({
      title: "Discard this email?",
      body: `"${w.subject || "(no subject)"}" to ${w.recipients} is never sent, and its content is deleted. The audit log keeps that you discarded it.`,
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok !== true) return;
    await run(`discard-${w.id}`, { action: "discard", id: w.id }, "Discarded.");
  }

  async function discardAll() {
    if (!v) return;
    const ok = await confirmDialog({
      title: `Discard ${v.queued === 1 ? "the email" : `all ${n(v.queued)} emails`} waiting?`,
      body: "None of them is sent, and their content is deleted. One being sent this very moment still goes. The audit log keeps that you discarded them, and how many.",
      confirmLabel: "Discard all waiting",
      danger: true,
    });
    if (ok !== true) return;
    setBusy("discard-all");
    const r = await act({ action: "discard_waiting" });
    setBusy("");
    if (!r.ok) {
      toast("error", r.data?.error || "That didn't work.");
      return;
    }
    if (r.data?.outbox) setV(r.data.outbox);
    toast("ok", `Discarded ${n(r.data?.discarded ?? 0)} waiting ${r.data?.discarded === 1 ? "email" : "emails"}.`);
  }

  const pausedUntil = v.paused?.until ? Date.parse(v.paused.until) : null;
  const dayOver = v.day_recipients >= v.daily_cap;

  return (
    <Card
      id="outbox"
      className="mt-6 scroll-mt-6"
      icon={<Inbox />}
      title="Outbox"
      description={
        acs
          ? `Email waits here and goes out at about ${v.per_minute} a minute and ${v.per_hour ?? "?"} an hour, with sign-in links and helpdesk replies first. Nothing is dropped when the email service asks to slow down.`
          : v.m365
          ? `Email through Microsoft 365 waits here and goes out at about ${v.per_minute} a minute, spread over the minute, with sign-in links and helpdesk replies first. Nothing is dropped when Microsoft asks to slow down.`
          : "Email that was waiting when you switched to SMTP goes out by SMTP from here."
      }
      actions={
        v.paused ? (
          <Chip tone={v.paused.kind === "refusal" ? "error" : "warn"} size="sm">
            Paused
          </Chip>
        ) : v.problems_total ? (
          <Chip tone="warn" size="sm">
            Needs attention
          </Chip>
        ) : (
          <Chip tone="ok" size="sm">
            Sending
          </Chip>
        )
      }
    >
      <div data-testid="mail-outbox" aria-live="polite">
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-canvas px-3 py-2">
            <dt className="text-xs text-slate-500">Waiting</dt>
            <dd className="text-lg font-semibold tabular-nums text-slate-900" data-testid="outbox-queued">
              {n(v.queued)}
            </dd>
            {v.queued_urgent > 0 && <dd className="text-xs text-slate-500">{n(v.queued_urgent)} urgent</dd>}
          </div>
          <div className="rounded-lg border border-slate-200 bg-canvas px-3 py-2">
            <dt className="text-xs text-slate-500">Sent in the last hour</dt>
            <dd className="text-lg font-semibold tabular-nums text-slate-900" data-testid="outbox-sent-hour">
              {n(v.sent_last_hour)}
            </dd>
          </div>
          {acs ? (
            <div className="rounded-lg border border-slate-200 bg-canvas px-3 py-2">
              <dt className="text-xs text-slate-500">Hourly limit</dt>
              <dd className="text-lg font-semibold tabular-nums text-slate-900" data-testid="outbox-hour">
                {n(v.per_hour ?? 0)}
              </dd>
              <dd className="text-xs text-slate-500">Emails in any hour, and {n(v.per_minute)} in any minute.</dd>
            </div>
          ) : (
          <div className="rounded-lg border border-slate-200 bg-canvas px-3 py-2">
            <dt className="text-xs text-slate-500">Recipients in the last 24 hours</dt>
            <dd className={`text-lg font-semibold tabular-nums ${dayOver ? "ink-warn" : "text-slate-900"}`} data-testid="outbox-day">
              {n(v.day_recipients)} <span className="text-sm font-normal text-slate-500">of {n(v.daily_limit)}</span>
            </dd>
            <dd className="text-xs text-slate-500">
              {dayOver ? `Over ${n(v.daily_cap)}: ordinary mail waits until older sends age out; urgent mail still goes.` : `Ordinary mail stops at ${n(v.daily_cap)}, leaving room for urgent mail.`}
            </dd>
          </div>
          )}
        </dl>

        {v.paused && v.paused.kind === "rate" && (
          <p className="notice-warn mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="outbox-paused" role="status">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              <strong className="font-semibold">Paused{pausedUntil ? ` until ${fmt.dateTime(v.paused.until)} (${untilWords(pausedUntil, now)})` : ""}.</strong>{" "}
              {acs ? "The email service asked to slow down." : "Microsoft 365 asked this mailbox to slow down."} Waiting email goes out after that, in order; none is lost.
            </span>
          </p>
        )}
        {v.paused && v.paused.kind === "refusal" && (
          <div className="notice-error mt-3 rounded-lg border px-3 py-2 text-sm" data-testid="outbox-paused" role="alert">
            <p className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <strong className="font-semibold">Paused:</strong> {v.paused.reason}
              </span>
            </p>
            <p className="mt-1 pl-6 text-xs">
              {acs ? "Waiting email goes out once this is fixed; press Try now after a change." : "Waiting email goes out once this is fixed: save the settings above or press Check connection."}
              {pausedUntil ? ` It tries again by itself ${untilWords(pausedUntil, now)}.` : ""}
            </p>
            <div className="mt-2 pl-6">
              <Button variant="secondary" size="sm" icon={<RefreshCw />} busy={busy === "resume"} onClick={() => void run("resume", { action: "resume" }, "Trying again now.")}>
                Try now
              </Button>
            </div>
          </div>
        )}

        {v.queued > 0 && (
          <div className="mt-5" data-testid="outbox-waiting">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SubHeading icon={<Hourglass />} className="mb-0">
                Waiting ({n(v.queued)})
              </SubHeading>
              <Button variant="danger" size="sm" icon={<Trash2 />} busy={busy === "discard-all"} onClick={() => void discardAll()}>
                Discard all waiting
              </Button>
            </div>
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label="Email waiting to go out">
              {v.waiting.map((w) => (
                <li key={w.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5" data-testid="outbox-waiting-row">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-900">{w.subject || "(no subject)"}</span>
                      <Chip tone={w.priority === PRIORITY.urgent ? "accent" : "neutral"} size="sm">
                        {w.status === "sending" ? "Sending" : PRIORITY_LABEL[w.priority]}
                      </Chip>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {kindLabel(w.kind)} to <span className="[overflow-wrap:anywhere]">{w.recipients}</span> · queued <RelativeTime value={w.queued_at} />
                    </p>
                    {w.reason && <p className="ink-warn mt-0.5 text-xs">{w.reason}</p>}
                  </div>
                  {w.status === "queued" && (
                    <Button variant="danger" size="sm" icon={<Trash2 />} busy={busy === `discard-${w.id}`} data-tt="Never send it" onClick={() => void discardWaiting(w)}>
                      Discard
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {v.queued > v.waiting.length && <p className="mt-2 text-xs text-slate-500">Showing the first {n(v.waiting.length)} of {n(v.queued)}, in the order they go out.</p>}
          </div>
        )}

        <div className="mt-5">
          <SubHeading icon={<TriangleAlert />}>Didn&apos;t go out{v.problems_total ? ` (${n(v.problems_total)})` : ""}</SubHeading>
          {v.problems.length === 0 ? (
            <SectionEmpty>Nothing failed. An email Microsoft refuses, or one that may not have gone out, waits here for you to retry or discard.</SectionEmpty>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label="Email that didn't go out" data-testid="outbox-problems">
              {v.problems.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5" data-testid="outbox-problem" data-status={p.status}>
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-900">{p.subject || "(no subject)"}</span>
                      {p.status === "failed" ? (
                        <Chip tone="error" size="sm">
                          Failed
                        </Chip>
                      ) : (
                        <Chip tone="warn" size="sm">
                          <CircleHelp className="h-3 w-3" aria-hidden /> May have gone out
                        </Chip>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {kindLabel(p.kind)} to <span className="[overflow-wrap:anywhere]">{p.recipients}</span> · queued <RelativeTime value={p.created_at} />
                    </p>
                    <p className={`mt-0.5 text-xs ${p.status === "failed" ? "text-red-600" : "ink-warn"}`}>{p.reason}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {p.can_retry && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<RotateCw />}
                        busy={busy === `retry-${p.id}`}
                        data-tt={p.status === "uncertain" ? "It may arrive twice" : "Send it again"}
                        onClick={() => void retry(p)}
                      >
                        Retry
                      </Button>
                    )}
                    <Button variant="danger" size="sm" icon={<Trash2 />} busy={busy === `discard-${p.id}`} data-tt="Never send it" onClick={() => void discard(p)}>
                      Discard
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {v.problems_total > v.problems.length && <p className="mt-2 text-xs text-slate-500">Showing the latest {v.problems.length}.</p>}
          <p className="mt-2 text-xs text-slate-500">
            A sent email&apos;s content is deleted at once; what was sent, to whom and when is kept {MAIL_OUTBOX_KEEP_DAYS} days. One that didn&apos;t go out keeps its content until it is
            retried or discarded.
          </p>
        </div>
      </div>
    </Card>
  );
}
