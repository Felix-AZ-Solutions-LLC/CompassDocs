// GET /api/helpdesk/custom-fields → { fields: [{ key, label, type, options, archived, all_teams, team_ids }] }
// Helpdesk 1.20.8: the custom field definitions as the queue's Filter dialog and its filter strip read them
// (lib/helpdesk/custom-field-filters): every field in the settings page's order, archived ones included and
// marked (a saved view may still use one; the dialog offers only live ones). Definitions only, no values.
// Agents (the queue's own gate); editing stays in Desk settings → Custom fields (settings.manage).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { customFieldsSnapshot } from "@/lib/helpdesk/custom-fields";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const fields = await customFieldsSnapshot();
  return NextResponse.json({
    fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, archived: f.archived, all_teams: f.all_teams, team_ids: f.team_ids })),
  });
}
