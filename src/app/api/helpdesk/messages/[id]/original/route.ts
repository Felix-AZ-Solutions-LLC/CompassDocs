// GET /api/helpdesk/messages/[id]/original              the message's original email as a whole HTML document,
//                                                        sanitised (lib/helpdesk/email-html-sanitize), for the desk's
//                                                        "View original" frame. ?images=1: https pictures shown too.
// GET /api/helpdesk/messages/[id]/original?format=info  { ok, error?, remote_images, insecure_images, truncated, size }
//                                                        (HdOriginalInfo), read by the dialog before it draws the frame.
// Helpdesk 1.20.8 (helpdesk.agent). Only an agent who works the message's ticket, the same check the desk's ticket
// read makes (licence, desk role, queues, the Duo desk rule: mfa_required while it is owed); internal notes included,
// as the desk shows them to that agent). A requester, a CC or an approver (no desk role) gets 403, an agent who does
// not work the ticket 404, whatever they can read in Get help; so does a ticket in the recycle bin. A message with no
// original: 404. Too large or too complex to sanitise in bounded time (lib/helpdesk/email-html-sanitize: measured
// first, then 3 seconds in a worker): 422 with a sentence (the info read and, for the frame, a plain page saying
// it); 503 while the worker is busy with 8 emails waiting. `images` and `format` may each be given once: a repeated
// one is 400 (1.20.8 security review: this route and next.config.js's header rule must read the same value).
//
// The document's headers (lib/helpdesk/email-html originalHeaders): Content-Security-Policy default-src 'none';
// img-src data: (and https: with ?images=1); style-src 'unsafe-inline'; form-action 'none'; base-uri 'none';
// frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox. X-Content-Type-Options: nosniff,
// Referrer-Policy: no-referrer, Cache-Control: private, no-store. Not audited: viewing an original, or showing its
// pictures, is reading a message. 120 reads a minute per person.

import { NextResponse } from "next/server";
import { mfaRequired } from "@/lib/api-auth";
import { canWorkTicket, deskDuoBarsTicket, hdRateLimited, helpdeskGate, tooMany } from "@/lib/helpdesk/access";
import { hqOne } from "@/lib/helpdesk/db-core";
import { originalHeaders, originalView } from "@/lib/helpdesk/email-html";
import { HD_ORIGINAL_COPY } from "@/lib/helpdesk/email-html-shared";
import { notFound } from "@/lib/helpdesk/routes";
import { getTicketRow } from "@/lib/helpdesk/tickets";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return notFound();
  if (hdRateLimited(`hd-original:${gate.id}`, 120, 60_000)) return tooMany();
  const msg = await hqOne<{ ticket_id: number }>("SELECT ticket_id FROM hd_messages WHERE id = $1", [id]);
  if (!msg) return notFound();
  const t = await getTicketRow(msg.ticket_id);
  if (!t) return notFound();
  if (!(await canWorkTicket(gate, t))) return (await deskDuoBarsTicket(gate, t)) ? mfaRequired() : notFound();

  const url = new URL(req.url);
  if (url.searchParams.getAll("images").length > 1 || url.searchParams.getAll("format").length > 1) {
    return NextResponse.json({ error: "Give images and format once each." }, { status: 400, headers: NO_STORE });
  }
  const images = url.searchParams.get("images") === "1";
  const view = await originalView(id, { remoteImages: images });
  if (url.searchParams.get("format") === "info") {
    return NextResponse.json(view.info, { status: view.ok ? 200 : view.status, headers: NO_STORE });
  }
  if (!view.ok) {
    if (view.status === 404) return notFound();
    // The frame's own page says why, under the same policy as an email.
    const sentence = view.status === 503 ? HD_ORIGINAL_COPY.busy : HD_ORIGINAL_COPY.tooComplex;
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>html{font-family:system-ui,sans-serif;font-size:14px;color:#1f2937;background:#fff}</style></head><body><p>${sentence}</p></body></html>`;
    return new Response(page, { status: view.status, headers: originalHeaders(false) });
  }
  return new Response(view.html, { status: 200, headers: originalHeaders(images) });
}
