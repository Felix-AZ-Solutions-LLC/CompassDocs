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
// 1.20.9: ?print=1 (with or without images=1) answers the print view instead (lib/helpdesk/email-html-print), the
// same reads and limit, under its own policy (originalPrintHeaders; next.config.js states it too). Not audited either.
// A repeated print (or images beside print=1): 400.
// 1.20.11: ?inline=1 (with or without images=1) answers the desk conversation's in-place variant: the same reads,
// limit and sanitiser, the quoted history folded for a reply (lib/helpdesk/email-html quoteFolding), and its own
// policy, which adds allow-same-origin to the sandbox (originalInlineHeaders says why; next.config.js states it
// too). Its document carries <meta name="compass-email" content="ok" data-remote-images data-quoted …>, which the
// desk reads; when the email is not shown (too complex, busy) the same status as the frame's with an empty page
// marked content="refused", and the desk shows the text. A browser that says it is opening this as a page or from
// another site (Sec-Fetch-Dest other than iframe, Sec-Fetch-Site other than same-origin, or none for a frame the
// person reloaded) gets 400 with a small marked page saying the email shows in the desk: it is the desk's frame
// and nothing else. inline beside print, or a repeated inline: 400. ?inline=1&format=info is the info, with
// `quoted`. Not audited.

import { NextResponse } from "next/server";
import { mfaRequired } from "@/lib/api-auth";
import { canWorkTicket, deskDuoBarsTicket, hdRateLimited, helpdeskGate, tooMany } from "@/lib/helpdesk/access";
import { hqOne } from "@/lib/helpdesk/db-core";
import { inlineRefusalPage, originalHeaders, originalInlineHeaders, originalView } from "@/lib/helpdesk/email-html";
import { originalPrintResponse, printQuery, repeatedPrintQuery } from "@/lib/helpdesk/email-html-print";
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
  const print = printQuery(url); // 1.20.9: ?print=1, the print view (lib/helpdesk/email-html-print)
  if (print === "repeated") return repeatedPrintQuery();
  const images = url.searchParams.get("images") === "1";
  // 1.20.11: ?inline=1, the desk conversation's frame.
  const inlineAsked = url.searchParams.getAll("inline");
  const inline = inlineAsked.length === 1 && inlineAsked[0] === "1";
  if (inlineAsked.length > 1 || (inline && print === "print")) {
    return NextResponse.json({ error: "Give inline once, and not with print." }, { status: 400, headers: NO_STORE });
  }
  const info = url.searchParams.get("format") === "info";
  if (inline && !info) {
    const dest = req.headers.get("sec-fetch-dest");
    const site = req.headers.get("sec-fetch-site");
    // 1.20.11 security review: a frame reloaded from its own menu says Sec-Fetch-Site: none (the person did it).
    if ((dest && dest !== "iframe") || (site && site !== "same-origin" && !(site === "none" && dest === "iframe"))) {
      // A plain page, as the frame would show it (never the JSON), marked refused: the desk shows the text.
      return new Response(inlineRefusalPage("not_here"), { status: 400, headers: originalHeaders(false) });
    }
  }
  const view = await originalView(id, { remoteImages: images, ...(inline ? { inline: { selfHost: requestHost(req, url) } } : {}) });
  if (info) {
    return NextResponse.json(view.info, { status: view.ok ? 200 : view.status, headers: NO_STORE });
  }
  if (print === "print" && (view.ok || view.status !== 404)) return originalPrintResponse(gate, t, id, view, images);
  if (inline) {
    if (!view.ok && view.status === 404) return notFound();
    if (!view.ok) return new Response(inlineRefusalPage(view.status === 503 ? "busy" : "too_complex"), { status: view.status, headers: originalInlineHeaders(false) });
    return new Response(view.html, { status: 200, headers: originalInlineHeaders(images) });
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

/** The desk's host name as the browser sees it, without a port (cookies are per host name; the inline variant drops pictures on it). */
function requestHost(req: Request, url: URL): string {
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || req.headers.get("host") || url.host;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return url.hostname.toLowerCase().replace(/\.+$/, "");
  }
}
