import { NextResponse } from "next/server";
import { dbReady, pool, schemaBootFailure, schemaReady } from "@/lib/db";
import { withoutDbRetry } from "@/lib/db-retry";
import { fileStoreKind, fileStoreReadiness } from "@/lib/file-store";
import { isDraining } from "@/lib/shutdown";
import { logEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/** How long the probe waits for the database (Container Apps' probe timeout must be longer). */
const TIMEOUT_MS = 3000;

let lastFailure = "";

/**
 * Readiness probe: 200 only when this replica can serve traffic. Load
 * balancers route on this (Container Apps: the readiness probe);
 * orchestrators restart on /healthz.
 *
 * 1.21.0: ready means all three of
 *   - not shutting down (lib/shutdown: after SIGTERM it answers 503
 *     "draining", so the platform stops routing here while requests finish);
 *   - the schema and its migrations applied in this process (lib/db
 *     dbReady; the first probe starts them if nothing has yet);
 *   - the database answering a query, within 3 seconds.
 * A failure is logged once per distinct reason, not on every probe. After
 * the migrations failed, a probe reports that failure (with when the next
 * try is) rather than starting them again, until the back-off is over
 * (lib/db schemaBootFailure: 5 s, doubling to a minute).
 *
 * 1.21.2: with the blob file store (lib/file-store), also its container
 * having answered once in this process (one listing call, tried again by
 * the next probe until it answers, then never again): a revision whose
 * storage is wrong or unreachable never takes traffic, while a storage blip
 * later does not take every replica (storage is shared) out of rotation.
 * The database is probed without waiting for it (lib/db-retry).
 */
export async function GET() {
  if (isDraining()) {
    return NextResponse.json({ status: "draining" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const failed = schemaReady() ? null : schemaBootFailure();
  if (failed) {
    return NextResponse.json(
      // The error itself is in the log (once), not in this public answer.
      { status: "unavailable", reason: "migrations could not run", retry_at: new Date(failed.retryAt).toISOString() },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
  });
  const at: { stage: "migrations" | "database" } = { stage: "migrations" };
  try {
    await Promise.race([
      // 1.21.2: never waits for the database (lib/db-retry): the probe answers within its timeout.
      withoutDbRetry(async () => {
        if (!schemaReady()) await dbReady();
        at.stage = "database";
        await pool().query("SELECT 1");
      }),
      timeout,
    ]);
    lastFailure = "";
    if (fileStoreKind() === "blob") {
      const problem = await fileStoreReadiness(Math.max(500, TIMEOUT_MS - (Date.now() - started)), logEvent);
      if (problem) {
        return NextResponse.json({ status: "unavailable", reason: "file storage unreachable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return NextResponse.json(
      {
        status: "ready",
        migrations: "applied",
        db_latency_ms: Date.now() - started,
        ...(fileStoreKind() === "blob" ? { file_store: "verified" } : {}),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const reason =
      at.stage === "database" ? "database unreachable" : error === "timeout" ? "migrations in progress" : "migrations could not run";
    if (lastFailure !== `${reason}|${error}`) {
      lastFailure = `${reason}|${error}`;
      logEvent("error", at.stage === "migrations" ? "readyz.not_migrated" : "readyz.db_unreachable", { reason, error });
    }
    return NextResponse.json({ status: "unavailable", reason }, { status: 503, headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(timer);
  }
}
