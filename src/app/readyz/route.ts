import { NextResponse } from "next/server";
import { dbReady, pool, schemaReady } from "@/lib/db";
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
 * A failure is logged once per distinct reason, not on every probe.
 */
export async function GET() {
  if (isDraining()) {
    return NextResponse.json({ status: "draining" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
  });
  const at: { stage: "migrations" | "database" } = { stage: "migrations" };
  try {
    await Promise.race([
      (async () => {
        if (!schemaReady()) await dbReady();
        at.stage = "database";
        await pool().query("SELECT 1");
      })(),
      timeout,
    ]);
    lastFailure = "";
    return NextResponse.json(
      { status: "ready", migrations: "applied", db_latency_ms: Date.now() - started },
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
