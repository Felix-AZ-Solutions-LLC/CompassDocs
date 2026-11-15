// /desk/settings/reply-lock: Reply lock (desk settings, 1.20.20, lib/helpdesk/reply-lock).
// Opens for a desk role holding settings.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ReplyLockSettings } from "@/components/helpdesk/desk/settings/ReplyLockSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reply lock" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "reply-lock"))) return <DeskPageForbidden what="Reply lock" />;
  return <ReplyLockSettings />;
}
