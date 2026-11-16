// /desk/settings/departments: Desk departments (desk settings, 1.20.23). Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access: desk Admin, settings.manage).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { DeskDepartmentsSettings } from "@/components/helpdesk/desk/settings/DeskDepartmentsSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Desk departments" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "departments"))) return <DeskPageForbidden what="Desk departments" />;
  return <DeskDepartmentsSettings />;
}
