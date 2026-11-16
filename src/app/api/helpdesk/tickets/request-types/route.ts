// GET /api/helpdesk/tickets/request-types?requester_id=   → { request_types: HdStartableType[] }
//       New ticket's Request type picker: the request types the requester could pick in Get help
//       themselves, each with its form, the published workflow it starts (null: none) and the
//       requester's directory prefill, without any value the directory hides from the caller
//       (admins-only fields and contact columns: lib/directory-visibility, as every directory page
//       applies it). The requester is the caller when left out, as POST /api/helpdesk/tickets
//       defaults. POST files the ticket and starts the workflow (lib/helpdesk/workflow-start
//       newTicketWorkflowCheck). It reveals no more than New ticket itself does: which types that
//       person could use, and what the caller could already read in the directory.
// Helpdesk 1.20.21. Desk capability workflows.start (in any team; POST checks the ticket's), else 403.
// A requester who is not an active account that may use Get help (helpdesk.request: the rule the
// ticket path applies too) answers 400, the same for an unknown id.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { accountMayRequest, startableTypes } from "@/lib/helpdesk/workflow-start";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (!(await hdCan(gate, "workflows.start"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const raw = new URL(req.url).searchParams.get("requester_id");
  let requesterId = gate.id;
  if (raw !== null && raw !== "") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return badRequest("That person can't use Get help.");
    requesterId = n;
  }
  if (!(await accountMayRequest(requesterId))) return badRequest("That person can't use Get help.");
  return NextResponse.json({
    request_types: await startableTypes({ kind: "account", id: requesterId }, { workflowOnly: false, viewer: gate }),
  });
}
