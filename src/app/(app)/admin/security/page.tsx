import { requireSettingsSection } from "@/lib/auth";
import { userHolds } from "@/lib/access";
import { listAllBearerCredentials } from "@/lib/db";
import { getSignInSecurity } from "@/lib/sign-in-security";
import { SignInSecuritySettings } from "@/components/SignInSecuritySettings";
import { SettingsPage } from "@/components/SettingsPage";
import { settingsMetadata } from "@/lib/settings-sections";

export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/security");

// Settings → Sign-in security (1.20.27): two-step sign-in, the absolute
// session lifetime, and every account's API tokens and app connections.
export default async function SignInSecurityPage() {
  const user = await requireSettingsSection("/admin/security");
  const [sec, credentials, canRevoke] = await Promise.all([
    getSignInSecurity(),
    listAllBearerCredentials(),
    userHolds(user, "user.reset_password", { legacyMin: "admin" }),
  ]);
  return (
    <SettingsPage href="/admin/security">
      <SignInSecuritySettings
        initial={{ two_step: sec.twoStep, session_max_days: sec.sessionMaxDays, credentials: JSON.parse(JSON.stringify(credentials)) }}
        canRevoke={canRevoke}
      />
    </SettingsPage>
  );
}
