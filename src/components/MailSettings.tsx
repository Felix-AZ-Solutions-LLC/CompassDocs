"use client";

// Settings → Notifications → Email (1.20.31): how the workspace's outgoing
// email is sent. One card: a Segmented "Send email with" (SMTP or
// Microsoft 365) over the chosen method's settings.
//
//   choosing   picking a method that is set up switches to it at once
//              (toast). Picking one that is not shows its settings with a
//              notice: email keeps going out the old way until they are
//              saved, and saving them switches (`use`). Both configurations
//              stay stored either way.
//   SMTP       the fields as before (the SMTP panel moved here from
//              WebhooksPanel), saved through /api/admin/smtp.
//   Microsoft 365   the sending mailbox and an optional display name, then
//              the app registration: in Enterprise "Set up with Microsoft"
//              (MsDeviceSetup, ee/workspace-mail-setup) makes or finds it,
//              grants Mail.Send and fills it in; in every edition it can be
//              entered by hand. Saving signs in first; Microsoft's refusal
//              is shown in plain words (FormError). "Check connection"
//              signs in and asks whether the app may send as the mailbox,
//              sending nothing. Under it, "Limit the app to …": the
//              Exchange Online PowerShell for the app as it is (an access
//              policy when Mail.Send is granted in Entra, RBAC for
//              Applications when it is not), with a copy button.
//   test       "Send test email" sends with the method on screen (its saved
//              settings), so Microsoft 365 can be tried before switching.
//
// The status chip is the chosen method's: Not set up, Set up, or Needs
// attention (Microsoft 365's last check failed, or its secret ends within
// 30 days).

import { useState } from "react";
import { Check, KeyRound, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip, EnterpriseBadge } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { Field, FormError, Select, TextInput } from "@/components/form";
import { MsDeviceSetup } from "@/components/MsDeviceSetup";
import { Segmented } from "@/components/Segmented";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import {
  MAIL_M365_APP_NAME,
  MAIL_METHODS,
  accessPolicyCommands,
  accessPolicyUpdateCommands,
  mailM365Problem,
  methodLabel,
  rbacCommands,
  secretExpiry,
  secretExpirySentence,
  sendingMailboxProblem,
  type MailMethod,
  type MailView,
} from "@/lib/mail-m365-shared";

const URL_ = "/api/admin/mail";
const PRE = "whitespace-pre-wrap rounded-lg border border-slate-200 bg-canvas p-3 font-mono text-xs leading-5 text-slate-700 [overflow-wrap:anywhere]";
const SUMMARY = "cursor-pointer text-sm font-semibold text-slate-900";

async function patch(body: unknown, url = URL_): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const goesOut = (m: MailMethod) => (m === "m365" ? "through Microsoft 365" : "by SMTP");

function attention(v: MailView): boolean {
  if (v.method !== "m365" || !v.configured) return false;
  const e = secretExpiry(v.m365.secret_expires);
  return v.m365.last_check?.ok === false || e.state === "soon" || e.state === "expired";
}

export function MailSettings({ initial }: { initial: MailView }) {
  const [v, setV] = useState(initial);
  const [shown, setShown] = useState<MailMethod>(initial.method);
  const [switching, setSwitching] = useState(false);
  const shownConfigured = shown === "m365" ? v.m365.configured : v.smtp.configured;

  async function choose(target: MailMethod) {
    if (target === shown) return;
    const ready = target === "m365" ? v.m365.configured : v.smtp.configured;
    if (target === v.method || !ready) {
      setShown(target);
      return;
    }
    setSwitching(true);
    const r = await patch({ action: "method", method: target });
    setSwitching(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not change how email is sent.");
      setShown(target);
      return;
    }
    setV(r.data.view);
    setShown(target);
    toast("ok", `Email now goes out ${goesOut(target)}.`);
  }

  return (
    <Card
      id="email"
      className="scroll-mt-6"
      title="How email is sent"
      description="Notifications, reminders, digests, newsletters and helpdesk replies all go out this way."
      actions={
        !v.configured ? (
          <Chip tone="neutral" size="sm">
            Not set up
          </Chip>
        ) : attention(v) ? (
          <Chip tone="warn" size="sm">
            Needs attention
          </Chip>
        ) : (
          <Chip tone="ok" size="sm">
            Set up
          </Chip>
        )
      }
    >
      <div data-testid="mail-settings" data-method={v.method}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-slate-700" aria-hidden>
            Send email with
          </span>
          <Segmented<MailMethod> label="Send email with" options={MAIL_METHODS} value={shown} onChange={(m) => void choose(m)} />
          {switching && <span className="text-xs text-slate-500">Switching…</span>}
        </div>
        {shown !== v.method && (
          <p className="notice-info mt-3 rounded-lg border px-3 py-2 text-sm" data-testid="mail-draft">
            {v.configured ? `Email still goes out ${goesOut(v.method)}.` : "Email isn't set up yet, so nothing goes out."} Once the {methodLabel(shown)} settings below are saved, email goes out{" "}
            {goesOut(shown)} instead. Both settings are kept.
          </p>
        )}
        <div className="mt-4">
          {shown === "smtp" ? (
            <SmtpForm v={v} use={v.method !== "smtp"} onSaved={setV} />
          ) : (
            <M365Form v={v} use={v.method !== "m365"} onSaved={setV} />
          )}
        </div>
        <TestRow method={shown} enabled={shownConfigured} />
      </div>
    </Card>
  );
}

// --- Test email --------------------------------------------------------------------------

function TestRow({ method, enabled }: { method: MailMethod; enabled: boolean }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function test() {
    setBusy(true);
    setError("");
    const r = await patch({ action: "test", method, to });
    setBusy(false);
    if (!r.ok) {
      setError(r.data?.error || "The test could not be sent.");
      return;
    }
    toast("ok", `Test email ${r.data.status} ${goesOut(method)}.`);
  }

  return (
    <div className="mt-5 border-t border-slate-100 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Send a test to" size="md" className="min-w-0 flex-1 basis-56">
          <TextInput type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@acme.com" spellCheck={false} autoComplete="off" />
        </Field>
        <Button variant="secondary" icon={<Send />} busy={busy} disabled={!enabled || !to.trim()} onClick={() => void test()}>
          Send test email
        </Button>
      </div>
      <p className="mt-1 text-xs text-slate-500">{enabled ? `Sent ${goesOut(method)}, with the settings saved above.` : `Save the ${methodLabel(method)} settings first.`}</p>
      <FormError className="mt-2">{error}</FormError>
    </div>
  );
}

// --- SMTP --------------------------------------------------------------------------------

function SmtpForm({ v, use, onSaved }: { v: MailView; use: boolean; onSaved: (v: MailView) => void }) {
  const [s, setS] = useState(v.smtp);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const r = await patch({ host: s.host, port: s.port, secure: s.secure, user: s.user, ...(pass ? { pass } : {}), from: s.from, use }, "/api/admin/smtp");
    if (!r.ok) {
      setBusy(false);
      toast("error", r.data?.error || "Could not save.");
      return;
    }
    const fresh = await fetch(URL_).then((x) => (x.ok ? x.json() : null), () => null);
    setBusy(false);
    if (r.data?.state) setS(r.data.state);
    if (fresh) onSaved(fresh);
    setPass("");
    if (r.data?.error) toast("error", r.data.error);
    else toast("ok", r.data?.method_changed ? "SMTP settings saved. Email now goes out by SMTP." : "SMTP settings saved.");
  }

  return (
    <div id="smtp" className="scroll-mt-6" data-testid="mail-smtp">
      <p className="mb-3 text-sm text-slate-500">Any SMTP relay works: Microsoft 365, Google Workspace, SES, Postmark, or your own server.</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <Field label="SMTP host">
            <TextInput value={s.host} onChange={(e) => setS({ ...s, host: e.target.value })} placeholder="smtp.office365.com" spellCheck={false} />
          </Field>
        </div>
        <Field label="Port">
          <TextInput type="number" value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) })} />
        </Field>
        <Field label="Encryption">
          <Select value={s.secure} onChange={(e) => setS({ ...s, secure: e.target.value })}>
            <option value="starttls">STARTTLS (587)</option>
            <option value="tls">TLS (465)</option>
            <option value="none">None</option>
          </Select>
        </Field>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label={<>Username <span className="text-slate-500">(optional)</span></>}>
          <TextInput value={s.user} onChange={(e) => setS({ ...s, user: e.target.value })} spellCheck={false} />
        </Field>
        <Field
          label={
            <>
              Password{" "}
              {s.has_pass && !pass ? (
                <span className="inline-flex items-center gap-1 text-emerald-600">
                  <Check className="h-3.5 w-3.5" aria-hidden /> (stored)
                </span>
              ) : (
                ""
              )}
            </>
          }
        >
          <TextInput type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={s.has_pass ? "••••••••" : ""} autoComplete="off" />
        </Field>
        <Field label="From address">
          <TextInput value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} placeholder="compassdocs@acme.com" spellCheck={false} />
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button busy={busy} onClick={() => void save()}>
          {use ? "Save and send by SMTP" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// --- Microsoft 365 -----------------------------------------------------------------------

function M365Form({ v, use, onSaved }: { v: MailView; use: boolean; onSaved: (v: MailView) => void }) {
  const m = v.m365;
  const fmt = useFormatDate();
  const [f, setF] = useState({ tenant: m.tenant, client_id: m.client_id, mailbox: m.mailbox, from_name: m.from_name });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [mailboxError, setMailboxError] = useState("");
  const sameApp = m.has_secret && f.client_id.trim().toLowerCase() === m.client_id && (!f.tenant.trim() || f.tenant.trim().toLowerCase() === m.tenant);
  const expiry = secretExpirySentence(m.secret_expires);
  const expiryState = secretExpiry(m.secret_expires).state;

  async function save() {
    const problem = mailM365Problem({ ...f, secret }, sameApp);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    const r = await patch({ action: "m365", ...f, ...(secret ? { secret } : {}), use });
    setBusy(false);
    if (!r.ok) {
      setError(r.data?.error || "Could not save.");
      return;
    }
    onSaved(r.data.view);
    setSecret("");
    setF({ tenant: r.data.view.m365.tenant, client_id: r.data.view.m365.client_id, mailbox: r.data.view.m365.mailbox, from_name: r.data.view.m365.from_name });
    toast("ok", r.data.method_changed ? "Saved. Email now goes out through Microsoft 365." : "Microsoft 365 settings saved.");
  }

  async function check() {
    setChecking(true);
    setError("");
    const r = await patch({ action: "check" });
    setChecking(false);
    if (r.data?.view) onSaved(r.data.view);
    else setError(r.data?.error || "The check failed.");
  }

  return (
    <div id="microsoft-365" className="scroll-mt-6" data-testid="mail-m365">
      <p className="mb-3 text-sm text-slate-500">
        Mail goes out through Microsoft Graph as one mailbox, such as a shared mailbox, and lands in its Sent Items. No SMTP server, password or SMTP AUTH is needed.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Sending mailbox"
          error={mailboxError}
          help="Its sign-in name or main address. A shared mailbox works and needs no licence."
        >
          <TextInput
            type="email"
            value={f.mailbox}
            onChange={(e) => {
              setF({ ...f, mailbox: e.target.value });
              setMailboxError("");
            }}
            placeholder="compassdocs@acme.com"
            spellCheck={false}
            autoComplete="off"
            maxLength={200}
          />
        </Field>
        <Field label={<>Display name <span className="text-slate-500">(optional)</span></>} help="Shown as the sender's name. Empty: the mailbox's own name.">
          <TextInput value={f.from_name} onChange={(e) => setF({ ...f, from_name: e.target.value })} placeholder="CompassDocs" maxLength={80} />
        </Field>
      </div>

      <div className="mt-4">
        {v.one_click === "available" ? (
          <MsDeviceSetup
            startUrl="/api/ee/mail/setup/start"
            pollUrl="/api/ee/mail/setup/poll"
            refreshUrl={URL_}
            label="Set up with Microsoft"
            blurb={`Signs you in once as a tenant admin. Creates the "${MAIL_M365_APP_NAME}" app (or finds it) with only the Mail.Send permission, grants admin consent, makes a client secret and fills in the details below.`}
            beforeStart={async () => {
              const why = sendingMailboxProblem(f.mailbox);
              if (why) setMailboxError(why);
              return !why;
            }}
            startBody={() => ({ mailbox: f.mailbox.trim(), from_name: f.from_name, use })}
            doneMessage={(r) =>
              r?.verified === false
                ? "The app was set up in Entra and saved here. Microsoft is still activating it: press Check connection in a minute, then limit it to the sending mailbox below."
                : `Done. The app ${r?.reused ? "was found in Entra and given a new secret" : "was created in Entra"}, Mail.Send was granted and the details were filled in.${r?.secret_expires ? ` The client secret is good until ${r.secret_expires}.` : ""} Next, limit the app to ${r?.mailbox ?? "the sending mailbox"} with the commands below.`
            }
            doneWarn={(r) => r?.verified === false}
            onDone={(fresh: MailView) => {
              onSaved(fresh);
              setSecret("");
              setF({ tenant: fresh.m365.tenant, client_id: fresh.m365.client_id, mailbox: fresh.m365.mailbox, from_name: fresh.m365.from_name });
            }}
          />
        ) : (
          <p className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500" data-testid="mail-one-click-enterprise">
            <EnterpriseBadge />
            <span>Set up with Microsoft creates the app, grants it Mail.Send and fills this in for you in Enterprise. Here, register the app by hand.</span>
          </p>
        )}
      </div>

      <details className="text-sm text-slate-600" open={v.one_click !== "available" || Boolean(m.client_id)} data-testid="mail-m365-manual">
        <summary className={SUMMARY}>App registration</summary>
        <p className="mt-2 text-xs text-slate-500">
          In Entra, register an app (single tenant), add the Microsoft Graph application permission Mail.Send and grant admin consent, then add a client secret. Copy its values
          here.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Tenant ID">
            <TextInput value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} placeholder="00000000-0000-…" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Application (client) ID">
            <TextInput value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })} placeholder="00000000-0000-…" spellCheck={false} autoComplete="off" />
          </Field>
          <Field
            label={
              <>
                Client secret{" "}
                {m.has_secret && !secret && sameApp ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <Check className="h-3.5 w-3.5" aria-hidden /> (stored)
                  </span>
                ) : (
                  ""
                )}
              </>
            }
            help={m.has_secret && m.secret_expires && !secret ? `Good until ${m.secret_expires}. It is never shown.` : "Its Value, not its Secret ID. It is never shown again."}
          >
            <TextInput type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={m.has_secret && sameApp ? "••••••••" : ""} autoComplete="off" maxLength={400} />
          </Field>
        </div>
      </details>

      {expiry && (
        <p className={`${expiryState === "expired" ? "notice-error" : "notice-warn"} mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm`} data-testid="mail-secret-expiry">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {expiry}
            {v.one_click === "available" ? " Or run Set up with Microsoft again: it finds the app and makes a new secret." : ""}
          </span>
        </p>
      )}

      <FormError className="mt-3">{error}</FormError>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button busy={busy} onClick={() => void save()}>
          {use ? "Save and send through Microsoft 365" : "Save"}
        </Button>
        {m.configured && (
          <Button variant="secondary" icon={<ShieldCheck />} busy={checking} onClick={() => void check()}>
            Check connection
          </Button>
        )}
      </div>
      {m.configured && (
        <p className={`mt-2 text-xs ${m.last_check?.ok === false ? "ink-warn" : "text-slate-500"}`} data-testid="mail-check" aria-live="polite">
          {m.last_check
            ? `${m.last_check.message} Checked ${fmt.dateTime(m.last_check.at)}.`
            : "Check connection signs in and asks Microsoft whether the app may send as the mailbox. It sends nothing."}
        </p>
      )}

      {m.configured && <LockDown v={v} />}
    </div>
  );
}

function LockDown({ v }: { v: MailView }) {
  const m = v.m365;
  const policy = accessPolicyCommands({ clientId: m.client_id, mailbox: m.mailbox });
  const rbac = rbacCommands({ clientId: m.client_id, spObjectId: m.sp_object_id, mailbox: m.mailbox });
  const later = accessPolicyUpdateCommands(m.mailbox);
  return (
    <section className="mt-6 border-t border-slate-100 pt-4" data-testid="mail-lockdown" aria-labelledby="mail-lockdown-title">
      <h4 id="mail-lockdown-title" className="text-sm font-semibold text-slate-900">
        Limit the app to {m.mailbox}
      </h4>
      <p className="mt-1 text-sm text-slate-600">
        Microsoft&apos;s Mail.Send permission lets an app send as any mailbox in your organisation, not only this one. Limit it, so that the app, or anyone who gets hold of
        its secret, can send as {m.mailbox} and nobody else. Microsoft offers no way to do this from here: an Exchange administrator runs these commands once, in PowerShell
        with the ExchangeOnlineManagement module.
      </p>
      {m.entra_send === null ? (
        <p className="mt-2 text-xs text-slate-500" data-testid="mail-commands-empty">
          Press Check connection once, so CompassDocs learns how the app was given Mail.Send. The commands that fit it appear here.
        </p>
      ) : m.entra_send ? (
        <>
          <p className="mb-1 mt-3 text-xs font-medium text-slate-500">Mail.Send is granted in Entra, so an application access policy limits it</p>
          <pre className={PRE} data-testid="mail-commands">
            {policy}
          </pre>
          <div className="mt-2">
            <CopyButton text={policy ?? ""} label="Copy commands" />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            The first lines make a mail-enabled security group holding only {m.mailbox}, hidden from the address book; the policy lets the app reach that group&apos;s members
            and nobody else. Microsoft can take 30 minutes or more to apply it. The last command should then read Granted; run it with any other mailbox and it should read
            Denied.
          </p>
          {later && (
            <details className="mt-3 text-sm text-slate-600">
              <summary className={SUMMARY}>If you change the sending mailbox later</summary>
              <pre className={`${PRE} mt-2`}>{later}</pre>
              <div className="mt-2">
                <CopyButton text={later} label="Copy commands" />
              </div>
            </details>
          )}
          <details className="mt-3 text-sm text-slate-600">
            <summary className={SUMMARY}>Microsoft&apos;s newer way: RBAC for Applications</summary>
            <p className="mt-2 text-xs text-slate-500">
              Microsoft is moving from application access policies to RBAC for Applications, which the helpdesk&apos;s Microsoft 365 mailboxes use. It only limits an app that
              has no mail permission in Entra: first remove Mail.Send from the app&apos;s API permissions in Entra (and revoke its admin consent), then run these instead. Until
              they apply, nothing can be sent.
            </p>
            {rbac ? (
              <>
                <pre className={`${PRE} mt-2`} data-testid="mail-commands-rbac">
                  {rbac}
                </pre>
                <div className="mt-2">
                  <CopyButton text={rbac} label="Copy commands" />
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs text-slate-500">Press Check connection once, so CompassDocs learns the app&apos;s object ID in your organisation.</p>
            )}
          </details>
        </>
      ) : (
        <>
          <p className="mb-1 mt-3 text-xs font-medium text-slate-500">The app has no mail permission in Entra, so Exchange gives it Mail.Send for this mailbox only (RBAC for Applications)</p>
          {rbac ? (
            <>
              <pre className={PRE} data-testid="mail-commands">
                {rbac}
              </pre>
              <div className="mt-2">
                <CopyButton text={rbac} label="Copy commands" />
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Until these apply, the app can send as nobody. Microsoft can take from 30 minutes to 2 hours. The last command shows what Exchange has on record at once:
                InScope should read True.
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs text-slate-500">Press Check connection once, so CompassDocs learns the app&apos;s object ID in your organisation.</p>
          )}
        </>
      )}
    </section>
  );
}
