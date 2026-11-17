import { AccountPage } from "@/components/AccountPage";
import { requireUser } from "@/lib/auth";
import { API_TOKEN_DAYS, API_TOKEN_DEFAULT_DAYS, listApiTokens, listOAuthGrants } from "@/lib/db";
import { mayMintForever } from "@/lib/sign-in-security";
import { ROLE_LABEL } from "@/lib/types";
import { ApiTokens } from "@/components/ApiTokens";

export const dynamic = "force-dynamic";
export const metadata = { title: "API tokens" };

export default async function ApiTokensPage() {
  const user = await requireUser();
  const [tokens, connections, neverAllowed] = await Promise.all([
    listApiTokens(user.id),
    listOAuthGrants(user.id),
    mayMintForever(user),
  ]);

  return (
    <AccountPage
      href="/account/tokens"
      description={
        <>Personal tokens for the Claude connector and other integrations. They act as you,
        with your role ({ROLE_LABEL[user.role]}).</>
      }
    >
      <div className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
        <ApiTokens
          initial={tokens}
          initialConnections={connections}
          expiry={{ days: [...API_TOKEN_DAYS], default_days: API_TOKEN_DEFAULT_DAYS, never_allowed: neverAllowed }}
        />
      </div>
    </AccountPage>
  );
}
