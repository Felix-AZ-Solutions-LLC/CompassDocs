// GET /api/helpdesk/reply-locks?numbers=101,102,…  → { enabled, locks: HdReplyLockBrief[] }
// Helpdesk 1.20.20 (lib/helpdesk/reply-lock): who is replying on the queue's tickets, for the
// row badges. Only tickets the caller works are answered (others are left out, as missing
// ones are); at most 200 numbers. 60 calls a minute per person.

import { NextResponse } from "next/server";
import { hdRateLimited, helpdeskGate, tooMany } from "@/lib/helpdesk/access";
import { replyLockBriefs } from "@/lib/helpdesk/reply-lock";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-reply-locks:${gate.id}`, 60, 60_000)) return tooMany();
  const raw = new URL(req.url).searchParams.get("numbers") ?? "";
  const numbers = [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 200);
  return NextResponse.json(await replyLockBriefs(gate, numbers));
}
