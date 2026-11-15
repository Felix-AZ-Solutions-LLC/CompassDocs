// /desk/settings/assignment/* (1.19.0, agent N): how tickets find an owner.
// Teams (each team's mode, eligibility, capacity and people), Rules (the
// ordered rules that run first, for automations.manage) and On call (the
// rota), as pages under one header (STYLEGUIDE §Settings pages: a section
// with several jobs gets pages). Team pages are for agents.manage_team (a
// team's lead for their teams; teams.manage for every team); the (desk)
// layout gates the licence first. 1.20.13: the header and the tab row are
// drawn by the settings layout's DeskSettingsChrome from the desk settings
// registry (section "assignment"), showing the tabs the role opens.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { deskAccess, deskRoleCaps } from "../../../desk-access";

export const dynamic = "force-dynamic";

export default async function AssignmentLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [access, role] = await Promise.all([deskAccess(user), deskRoleCaps(user)]);
  if (!access.licensed) return null; // the (desk) layout shows the licence gate
  if (!role.can("agents.manage_team") && !role.can("automations.manage")) return <DeskPageForbidden what="Assignment" />;
  return <>{children}</>;
}
