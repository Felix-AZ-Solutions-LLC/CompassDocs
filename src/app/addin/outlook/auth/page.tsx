import { redirect } from "next/navigation";
import { currentSession, getCurrentUser, pendingStepHref } from "@/lib/auth";
import { AddinAuthClient } from "@/components/OutlookPane";

// Sign-in target for the Office dialog (displayDialogAsync). The dialog shares
// the task pane's cookie jar, so a login here signs the pane in too. Once a
// session exists this page messages the parent pane and the dialog closes.

export const dynamic = "force-dynamic";

export default async function AddinAuthPage() {
  // 1.20.27: a session that owes a new password or two-step set-up does it here first, then comes back.
  const pending = (await currentSession())?.pending;
  if (pending) redirect(pendingStepHref(pending, "/addin/outlook/auth"));
  const user = await getCurrentUser();
  return <AddinAuthClient authed={Boolean(user)} />;
}
