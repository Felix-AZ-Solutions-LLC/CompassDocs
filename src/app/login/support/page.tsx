import { notFound } from "next/navigation";
import { getAllSettings } from "@/lib/db";
import { normalizeSettings } from "@/lib/settings";
import { getSignInLook } from "@/lib/sign-in-art";
import { supportAccessEnabled } from "@/lib/cloud";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthHeading } from "@/components/auth/AuthHeading";
import { SupportSignIn } from "@/components/support/SupportSignIn";

export const dynamic = "force-dynamic";
export const metadata = { title: "CompassDocs support sign-in", robots: { index: false, follow: false } };

// 1.21.4: where a CompassDocs staff member signs in to this workspace with a
// grant token from the console (lib/support, README "Support access"). The
// console opens /login/support#<token>: the token is in the fragment, which
// the browser never sends to a server, so it is in no log; the page posts it
// once, same-origin, when the person presses the button. Only in a
// CompassDocs Cloud workspace with support access configured.
export default async function SupportSignInPage() {
  if (!supportAccessEnabled()) notFound();
  const [raw, look] = await Promise.all([getAllSettings(), getSignInLook()]);
  const settings = normalizeSettings(raw);
  return (
    <AuthShell look={look} company={settings.company_name} logoUrl={settings.logo_url || undefined}>
      <AuthHeading title="CompassDocs support sign-in" subtitle={`For CompassDocs staff, with access ${settings.company_name} approved. Everything you do here is in the workspace's audit log.`} />
      <SupportSignIn />
    </AuthShell>
  );
}
