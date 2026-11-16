// GET /api/helpdesk/desk-departments?feature=macros|canned|checklists|workflows|request_types|automations|recurring
//     → HdDeskDepartmentChoices { departments: [{ id, name, is_default, manageable }], can_all, default_id, filter }
// Helpdesk 1.20.23 (lib/helpdesk/desk-departments deskDepartmentChoices): what a content editor's
// Department field and its list's filter offer this person. Any desk agent (the names are not
// secret); `manageable` and `can_all` are the server's own rules, which every write checks again.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { deskDepartmentChoices, isDeskDepartmentFeature } from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const feature = new URL(req.url).searchParams.get("feature");
  if (!isDeskDepartmentFeature(feature)) return badRequest("feature is one of macros, canned, checklists, workflows, request_types, automations or recurring.");
  return NextResponse.json(await deskDepartmentChoices(gate, feature), { headers: { "Cache-Control": "no-store" } });
}
