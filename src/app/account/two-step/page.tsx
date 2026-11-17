import { redirect } from "next/navigation";
import { preload } from "react-dom";
import { currentSession, requireUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { getSignInLook } from "@/lib/sign-in-art";
import { ART_SIZES } from "@/lib/sign-in-text";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthHeading } from "@/components/auth/AuthHeading";
import { TwoStepEnrolForm } from "@/components/auth/TwoStepEnrolForm";
import { safeReturnPath } from "@/lib/return-to";
import { signInLinks } from "@/components/auth/SignInLinksBar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up two-step sign-in", robots: { index: false, follow: false } };

// "Require two-step sign-in" (1.20.27, security review H3): someone the rule
// covers who signed in with a password and has no authenticator set up
// comes here first, and can use nothing else until it is done. It is the
// second half of signing in, so it wears the sign-in shell (STYLEGUIDE
// §Sign-in surfaces), like the forced password change.
export default async function TwoStepSetupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await requireUser("app", { allowPending: "two_step" });
  const next = safeReturnPath((await searchParams).next);
  // Nothing owed (set up already, or the rule changed): straight on.
  if ((await currentSession())?.pending !== "two_step") redirect(next);
  const [settings, look, links] = await Promise.all([getAppSettings(), getSignInLook(), signInLinks()]);
  if (look.art) {
    preload(look.art.src, { as: "image", imageSrcSet: look.art.srcSet, imageSizes: ART_SIZES, fetchPriority: "high" });
  }
  return (
    <AuthShell look={look} company={settings.company_name} logoUrl={settings.logo_url || undefined} links={links}>
      <AuthHeading
        title="Set up two-step sign-in"
        subtitle={`${settings.company_name} asks for a code from an authenticator app each time you sign in with your password.`}
      />
      <TwoStepEnrolForm account={user.username} next={next} />
    </AuthShell>
  );
}
