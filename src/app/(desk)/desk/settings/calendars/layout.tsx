// /desk/settings/calendars/* (1.19.0, agent L): business calendars. Office
// hours per calendar, holiday sets, and a due-time tester, as pages under
// one header (STYLEGUIDE §Settings pages: a section with several jobs gets
// pages). For the desk capability sla.manage ("SLA and business hours");
// the (desk) layout gates the licence first. 1.20.13: they are tabs of
// Reply targets (with the targets themselves, /desk/settings/sla); the
// header and the tab row are drawn by the settings layout's
// DeskSettingsChrome from the desk settings registry.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { deskAccess, deskRoleCaps } from "../../../desk-access";

export const dynamic = "force-dynamic";

export default async function CalendarsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [access, role] = await Promise.all([deskAccess(user), deskRoleCaps(user)]);
  if (!access.licensed) return null; // the (desk) layout shows the licence gate
  if (!role.can("sla.manage")) return <DeskPageForbidden what="Calendars" />;
  return <>{children}</>;
}
