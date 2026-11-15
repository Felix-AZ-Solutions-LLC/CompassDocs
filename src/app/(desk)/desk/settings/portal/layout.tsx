// /desk/settings/portal/*: Customer portal (desk settings, Helpdesk 1.19.1;
// pages since 1.19.4, C3): Settings, Help centre and Customers under one
// header (STYLEGUIDE §Settings pages: a section with several jobs gets
// pages). Opens for a desk role holding settings.manage (every API behind
// these pages checks the same); the (desk) layout gates the licence first.
// 1.20.13: the header and the tab row are drawn by the settings layout's
// DeskSettingsChrome from the desk settings registry (section "portal").

import { requireUser } from "@/lib/auth";
import { hdCan } from "@/lib/helpdesk/roles";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";

export const dynamic = "force-dynamic";

export default async function PortalSettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!(await hdCan(user, "settings.manage").catch(() => false))) return <DeskPageForbidden what="Customer portal" />;
  return <>{children}</>;
}
