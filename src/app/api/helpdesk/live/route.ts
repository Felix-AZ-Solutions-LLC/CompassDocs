// GET /api/helpdesk/live            → text/event-stream of "your queues changed" signals
//   `retry` (2-6 s, random per stream), then `event: hello` (id: the cursor,
//   data: {}), then `event: changed` (id: the cursor, data: {}) a moment
//   after a ticket in the caller's scope (their teams' and their own;
//   everything with agent_all, exactly the queue API's scope) is created,
//   changed or deleted, folded to one signal per gap; a `: hb` comment every
//   25 s; the stream ends after five to five and a half minutes and the
//   browser reconnects. A signal carries no ticket: the desk reloads the
//   list and the counts through their own APIs. The cursor is the server's
//   clock (lib/helpdesk/live-shared), never a count. With Last-Event-ID (the
//   browser's reconnect) or ?since=<cursor>, a change in scope missed in
//   between is signalled (spread like any other).
// GET /api/helpdesk/live?wait=<1-25>&since=<cursor>
//   the long-poll fallback (a proxy that buffers streams): holds until a
//   change in scope or `wait` seconds → { changed, cursor }.
// 429 past 6 streams and long polls a person (counted before anything is
// awaited) or 30 connections a person a minute; 503 { fallback: "poll" }
// while the server can't listen (the desk falls back); 503 { draining: true }
// with Retry-After while this server shuts down (1.21.0: no new stream holds
// it open; the desk reconnects, to another replica if there is one).
// Helpdesk 1.20.19 (helpdesk.agent).

import { NextResponse } from "next/server";
import { hdRateLimited, helpdeskGate, tooMany } from "@/lib/helpdesk/access";
import { changedSince, deskSessionValid, ensureListening, liveCursor, reserveLive, scheduleLiveSignal, subscribeLive } from "@/lib/helpdesk/live";
import { LIVE_LIMITS } from "@/lib/helpdesk/live-shared";
import { SESSION_COOKIE } from "@/lib/auth";
import { isDraining } from "@/lib/shutdown";

export const dynamic = "force-dynamic";

const unavailable = () =>
  NextResponse.json({ error: "Live updates are not available right now.", fallback: "poll" }, { status: 503, headers: { "Cache-Control": "no-store" } });

function sessionToken(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

const draining = () =>
  NextResponse.json(
    { error: "This server is restarting. Live updates resume in a moment.", fallback: "poll", draining: true },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "2" } }
  );

export async function GET(req: Request) {
  if (isDraining()) return draining();
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  // From here to the reservation nothing is awaited: parallel connects can't slip past the caps.
  if (hdRateLimited(`hd-live:${gate.id}`, LIVE_LIMITS.connectsPerMinute, 60_000)) return tooMany();
  const release = reserveLive(gate.id);
  if (release === "user") return tooMany();
  if (release === "process") return unavailable();
  let handedOff = false;
  try {
    if (isDraining()) return draining();
    if (!(await ensureListening())) return isDraining() ? draining() : unavailable();

    const url = new URL(req.url);
    const since = req.headers.get("last-event-id") || url.searchParams.get("since") || null;
    const waitRaw = url.searchParams.get("wait");
    const token = sessionToken(req);
    const valid = () => deskSessionValid(token, gate.id);

    if (waitRaw !== null) {
      const wait = Math.min(LIVE_LIMITS.maxWaitSeconds, Math.max(1, Math.floor(Number(waitRaw) || LIVE_LIMITS.maxWaitSeconds)));
      let done: (changed: boolean) => void = () => {};
      const outcome = new Promise<boolean>((resolve) => (done = resolve));
      handedOff = true;
      const { sub, close } = await subscribeLive(gate, { signal: () => done(true), end: () => done(false) }, { release, valid });
      if (changedSince(since, sub)) done(true);
      const timer = setTimeout(() => done(false), wait * 1000);
      const onAbort = () => done(false);
      req.signal?.addEventListener("abort", onAbort);
      const changed = await outcome;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      close();
      return NextResponse.json({ changed, cursor: liveCursor() }, { headers: { "Cache-Control": "no-store" } });
    }

    const enc = new TextEncoder();
    let cleanup = () => {};
    handedOff = true;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        let close = () => {};
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let lifetime: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (!open) return;
          open = false;
          if (heartbeat) clearInterval(heartbeat);
          if (lifetime) clearTimeout(lifetime);
          close();
          release();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        const write = (s: string) => {
          if (!open) return;
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            finish();
          }
        };
        cleanup = finish;
        let subscribed: Awaited<ReturnType<typeof subscribeLive>>;
        try {
          subscribed = await subscribeLive(gate, { signal: (cursor) => write(`id: ${cursor}\nevent: changed\ndata: {}\n\n`), end: finish }, { release, valid });
        } catch {
          finish();
          return;
        }
        close = subscribed.close;
        if (!open) return close();
        heartbeat = setInterval(() => write(": hb\n\n"), LIVE_LIMITS.heartbeatMs);
        // Spread the reconnects: a desk full of agents who opened at nine shouldn't all come back at once.
        lifetime = setTimeout(finish, LIVE_LIMITS.maxStreamMs + Math.floor(Math.random() * 30_000));
        if (req.signal?.aborted) return finish();
        req.signal?.addEventListener("abort", finish);
        write(`retry: ${2_000 + Math.floor(Math.random() * 4_000)}\nid: ${liveCursor()}\nevent: hello\ndata: {}\n\n`);
        // A missed change goes out like any other signal: at a random moment in the gap, through the bucket.
        if (changedSince(since, subscribed.sub)) scheduleLiveSignal(subscribed.sub);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } finally {
    if (!handedOff) release();
  }
}
