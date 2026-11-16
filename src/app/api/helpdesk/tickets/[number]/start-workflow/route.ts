// GET  /api/helpdesk/tickets/[number]/start-workflow   → HdStartWorkflowOptions
//        whether a workflow may be started from this ticket (`eligible`, else `reason`), what
//        would happen (`mode`: "this", the ticket becomes the request and the run lives on it;
//        "new", a new request for the same requester, linked by an internal note on each) and
//        the request types offered: switched on, starting a published workflow with steps, and
//        ones the ticket's requester could pick in Get help themselves (lib/helpdesk/workflow-start
//        startableTypes), each with its form and the requester's directory prefill (never a value
//        the directory hides from the caller). A customer-portal contact gets the portal's types;
//        a requester with no account or portal sign-in, or whose account can't use Get help, gets
//        `eligible: false` with the reason. For "new", only types whose team the caller may open
//        a request in (their own teams, workflows.start there; else POST answers 403)
// POST /api/helpdesk/tickets/[number]/start-workflow   { request_type_id, answers, client_start_id, expect?, subject? }
//        start it → 200 HdStartWorkflowResult ({ mode, started, duplicate, request, run_id, workflow }).
//        `answers` are checked as Get help checks them (validateAnswers: required fields, each
//        value's type) → 400 with the sentence. `client_start_id` (required, 16 to 64 of
//        [A-Za-z0-9_-]) is the dialog's key: the same key again answers the first try's outcome
//        with `duplicate: true` and does nothing. `expect` is the outcome the dialog showed: the
//        ticket changed meanwhile → 409 { error, code: "workflow_mode_changed", mode }. A ticket
//        solved, closed, merged, or a workflow task → 409 (code "workflow_not_startable"); a type
//        no longer offered → 409 (code "request_type_unavailable"). Every check is repeated
//        under the ticket's row lock. Audited helpdesk.workflow_run.started; the ticket(s) get
//        the internal note "Workflow started by <agent>: <workflow> (version n)".
// Helpdesk 1.20.21. Desk capability workflows.start in the ticket's team (403), for an agent who
// works the ticket (anyone else gets the same 404 as a missing ticket). POST: 30 a minute per person.

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { hdRateLimited, helpdeskGate, readJson, tooMany } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, originOf } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { startWorkflowFromTicket, startWorkflowOptions } from "@/lib/helpdesk/workflow-start";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

async function load(params: Ctx["params"]) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  if (!(await hdCan(gate, "workflows.start", { teamId: found.ticket.team_id }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  return { gate, ticket: found.ticket };
}

export async function GET(_req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json(await startWorkflowOptions(ctx.ticket, ctx.gate));
}

export async function POST(req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  const { gate, ticket } = ctx;
  if (hdRateLimited(`hd-wf-start:${gate.id}`, 30, 60_000)) return tooMany();
  const b = await readJson(req, 256 * 1024);
  if (!b) return badRequest("Send the request type and its answers as JSON.");
  const out = await startWorkflowFromTicket(gate, ticket.id, b, { origin: originOf(req), ip: ipFrom(req) });
  if (!out.ok) {
    return NextResponse.json({ error: out.error, ...(out.code ? { code: out.code } : {}), ...(out.mode ? { mode: out.mode } : {}) }, { status: out.status });
  }
  return NextResponse.json(out.result);
}
