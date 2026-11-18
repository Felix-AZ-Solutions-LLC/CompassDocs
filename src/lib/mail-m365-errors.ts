// 1.20.31: Microsoft's refusals of the workspace's outgoing email, in one
// plain sentence each. The Graph client (lib/helpdesk/m365/graph) reports a
// refusal as an M365Error: the HTTP status (0 when nothing came back), the
// kind ("auth" for a refused sign-in), Graph's own error code or the
// AADSTS code of a refused sign-in, and Retry-After. Its message is worded
// for the helpdesk's mailboxes, so the workspace's mail says its own here.
// Pure: no server-only imports.

export interface M365Refusal {
  status: number;
  kind: string;
  code: string;
  retryAfterMs: number | null;
  message: string;
}

const SIGN_IN = "Microsoft 365 refused the app's sign-in";

/** The sentence for a refusal while sending as (or checking) `mailbox`. */
export function m365SendSentence(e: M365Refusal, mailbox: string): string {
  const code = (e.code || "").trim();
  const lc = code.toLowerCase();
  const mb = mailbox || "the sending mailbox";
  if (e.kind === "auth") {
    if (code === "AADSTS7000222") return `${SIGN_IN}: the client secret has expired. Create a new secret and paste it here.`;
    if (code === "AADSTS7000215") return `${SIGN_IN}: the client secret is wrong. Paste the secret's Value (not its Secret ID), or create a new one.`;
    if (code === "AADSTS700016") return `${SIGN_IN}: there is no app registration with that application (client) ID in the tenant.`;
    if (code === "AADSTS90002" || lc === "invalid_request") return `${SIGN_IN}: the tenant was not found. Check the tenant ID.`;
    if (code === "AADSTS7000112") return `${SIGN_IN}: the app is disabled in Entra.`;
    if (code === "AADSTS700024" || code === "AADSTS7000274") return `${SIGN_IN}: check the tenant ID, the application (client) ID and the secret.`;
    return `${SIGN_IN}${code ? ` (${code.slice(0, 40)})` : ""}: check the tenant ID, the application (client) ID and the secret.`;
  }
  if (e.status === 0) return e.message;
  if (e.status === 401) return `${SIGN_IN}: the client secret was not accepted. Create a new secret and paste it here.`;
  if (lc === "mailboxnotenabledforrestapi" || lc === "mailboxnotsupportedforrestapi") {
    return `${mb} has no Exchange Online mailbox that can send (it may be on-premises, unlicensed or switched off).`;
  }
  if (lc === "errorsendasdenied") return `Microsoft 365 refused the From address: ${mb} may send only as itself unless Exchange gives it Send As permission on that address.`;
  if (e.status === 403) return `The app isn't allowed to send as ${mb} (Mail.Send not granted or blocked by an application access policy).`;
  if (e.status === 404 || lc === "errorinvaliduser" || lc === "resourcenotfound" || lc === "request_resourcenotfound") {
    return `Microsoft 365 found no mailbox ${mb}. Enter the mailbox's sign-in name (user principal name) or its main address.`;
  }
  if (e.status === 429) {
    const secs = e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : 0;
    return `Microsoft 365 is limiting how fast this app sends. Try again ${secs ? `in ${secs} second${secs === 1 ? "" : "s"}` : "in a minute"}.`;
  }
  if (e.status === 413 || e.kind === "too_large") return "Microsoft 365 said the email was too large.";
  if (e.status >= 500) return `Microsoft 365 had a problem (error ${e.status}). Try again shortly.`;
  return `Microsoft 365 refused the email (error ${e.status}${code ? `, ${code.slice(0, 60)}` : ""}).`;
}
