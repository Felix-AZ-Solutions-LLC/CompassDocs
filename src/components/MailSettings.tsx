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
//
// 1.20.32: under the card, the Outbox (components/MailOutbox) while Microsoft
// 365 is chosen or mail is left in it. Switching to SMTP with mail still
// waiting asks first (the server's 409 "confirm" sentences, as switching to
// Microsoft 365 does), from the method picker and from the SMTP save.
//
// 1.21.5: email through Azure Communication Services (the operator's
// COMPASSDOCS_MAIL_TRANSPORT=acs; CompassDocs Cloud's way) is not a choice
// here: the card keeps its title and chip, the Segmented and both forms give
// way to AcsPanel (STYLEGUIDE "A setting the platform supplies": SetByPlatform
// with "Email is sent by CompassDocs Cloud from …"), and the one thing that
// stays the workspace's, where replies go, is a field with its own Save. The
// test email and the Outbox stay.

import { useState } from "react";
import { Check, KeyRound, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip, EnterpriseBadge } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { Field, FormError, Select, TextInput } from "@/components/form";
import { MsDeviceSetup } from "@/components/MsDeviceSetup";
import { MailOutbox } from "@/components/MailOutbox";
import type { OutboxView } from "@/lib/mail-outbox-shared";
import { Segmented } from "@/components/Segmented";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { SetByPlatform } from "@/components/CloudManaged";
import { confirmDialog } from "@/components/Dialog";
import {
  MAIL_M365_APP_NAME,
  MAIL_METHODS,
  accessPolicyCommands,
  accessPolicyUpdateCommands,
  mailM365Problem,
  methodLabel,
  rbacCommands,
  secretExpiry,
  sendingMailboxProblem,
  type ChosenMailMethod,
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

const goesOut = (m: MailMethod) => (m === "m365" ? "through Microsoft 365" : m === "acs" ? "through Azure Communication Services" : "by SMTP");

function attention(v: MailView): boolean {
  if (v.method !== "m365" || !v.configured) return false;
  const e = secretExpiry(v.m365.secret_expires);
  return v.m365.secret_unreadable || v.m365.last_check?.ok === false || v.m365.last_check?.limited === false || e.state === "soon" || e.state === "expired";
}

/**
 * A switch that changes something people notice (the From, the desk's
 * send-from addresses, the size limit) asks first: the server answers 409
 * code "confirm" with the sentences, and the same request goes again with
 * confirm: true once the admin agrees. Null: the admin said no.
 */
async function withConfirm(body: Record<string, unknown>, url = URL_): Promise<{ ok: boolean; status: number; data: any } | null> {
  const r = await patch(body, url);
  if (r.status !== 409 || r.data?.code !== "confirm") return r;
  const target: MailMethod = body.method === "smtp" || url === "/api/admin/smtp" ? "smtp" : "m365";
  const ok = await confirmSwitch(r.data.warnings ?? [], target);
  return ok ? patch({ ...body, confirm: true }, url) : null;
}

export async function confirmSwitch(warnings: string[], target: MailMethod = "m365"): Promise<boolean> {
  if (!warnings.length) return true;
  return (
    (await confirmDialog({
      title: target === "smtp" ? "Send email by SMTP?" : "Send email through Microsoft 365?",
      body: (
        <ul className="list-disc space-y-1 pl-5" data-testid="mail-switch-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ),
      confirmLabel: "Switch",
    })) === true
  );
}

export function MailSettings({ initial, outbox = null }: { initial: MailView; outbox?: OutboxView | null }) {
  const [v, setV] = useState(initial);
  if (v.method === "acs" && v.acs) return <AcsMail v={v} onSaved={setV} outbox={outbox} />;
  return <ChosenMail v={v} setV={setV} outbox={outbox} />;
}

function ChosenMail({ v, setV, outbox }: { v: MailView; setV: (v: MailView) => void; outbox: OutboxView | null }) {
  const [shown, setShown] = useState<ChosenMailMethod>(v.method === "acs" ? "smtp" : v.method);
  const [switching, setSwitching] = useState(false);
  const shownConfigured = shown === "m365" ? v.m365.configured : v.smtp.configured;

  async function choose(target: ChosenMailMethod) {
    if (target === shown) return;
    const ready = target === "m365" ? v.m365.configured : v.smtp.configured;
    if (target === v.method || !ready) {
      setShown(target);
      return;
    }
    setSwitching(true);
    const r = await withConfirm({ action: "method", method: target });
    setSwitching(false);
    if (!r) return;
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
    <>
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
            <Segmented<ChosenMailMethod> label="Send email with" options={MAIL_METHODS} value={shown} onChange={(m) => void choose(m)} />
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
          <TestRow method={shown} enabled={shownConfigured} platform={shown === "smtp" && v.smtp.platform} />
        </div>
      </Card>
      <MailOutbox initial={outbox} paced={v.method !== "smtp"} />
    </>
  );
}

// --- Azure Communication Services (1.21.5) ---------------------------------------------

function AcsMail({ v, onSaved, outbox }: { v: MailView; onSaved: (v: MailView) => void; outbox: OutboxView | null }) {
  const a = v.acs!;
  return (
    <>
      <Card
        id="email"
        className="scroll-mt-6"
        title="How email is sent"
        description="Notifications, reminders, digests, newsletters and helpdesk replies all go out this way."
        actions={
          <Chip tone={v.configured ? "ok" : "neutral"} size="sm">
            {v.configured ? "Set up" : "Not set up"}
          </Chip>
        }
      >
        <div data-testid="mail-settings" data-method="acs">
          <div data-testid="mail-acs">
            <SetByPlatform>
              {a.cloud ? "Email is sent by CompassDocs Cloud" : "Email is sent through Azure Communication Services"}
              {a.sender ? (
                <>
                  {" "}
                  from <span className="font-medium text-slate-700">{a.sender}</span>
                </>
              ) : null}
              .
            </SetByPlatform>
          </div>
          <ReplyToRow v={v} onSaved={onSaved} />
          <TestRow method="acs" enabled={v.configured} platform={a.cloud} />
        </div>
      </Card>
      <MailOutbox initial={outbox} paced />
    </>
  );
}

/** Where replies go: the sender takes none, so a message that names no Reply-To of its own gets this address. */
function ReplyToRow({ v, onSaved }: { v: MailView; onSaved: (v: MailView) => void }) {
  const a = v.acs!;
  const [reply, setReply] = useState(a.reply_to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = reply.trim() !== a.reply_to;

  async function save() {
    setBusy(true);
    setError("");
    const r = await patch({ action: "reply_to", reply_to: reply.trim() });
    setBusy(false);
    if (!r.ok) {
      setError(r.data?.error || "Could not save the reply address.");
      return;
    }
    onSaved(r.data.view);
    setReply(r.data.view?.acs?.reply_to ?? reply.trim());
    toast("ok", reply.trim() ? `Replies now go to ${reply.trim()}.` : "Reply address removed.");
  }

  const help = a.reply_to_default
    ? `Used when an email names no reply address of its own (helpdesk replies and newsletters do). Empty: ${a.reply_to_default}.`
    : "Used when an email names no reply address of its own (helpdesk replies and newsletters do). Empty: replies to the sender aren\u2019t read.";
  return (
    <div className="mt-5 border-t border-slate-100 pt-4" data-testid="mail-reply-to">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Replies go to" size="md" className="min-w-0 flex-1 basis-56" help={help} error={error || undefined}>
          <TextInput type="email" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="help@acme.com" spellCheck={false} autoComplete="off" />
        </Field>
        <Button variant="secondary" busy={busy} disabled={!changed} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

// --- Test email --------------------------------------------------------------------------

/** `platform`: SMTP is CompassDocs Cloud's relay (1.21.0), so there are no settings "saved above". */
function TestRow({ method, enabled, platform = false }: { method: MailMethod; enabled: boolean; platform?: boolean }) {
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
      <p className="mt-1 text-xs text-slate-500" data-testid="mail-test-hint">
        {platform
          ? method === "acs"
            ? "Sent by CompassDocs Cloud. The result is shown when it is known, within about 30 seconds."
            : "Sent through CompassDocs Cloud\u2019s relay."
          : method === "acs"
            ? enabled
              ? "Sent through Azure Communication Services. The result is shown when it is known, within about 30 seconds."
              : "Azure Communication Services isn\u2019t set up: the start-up log says why."
            : enabled
              ? `Sent ${goesOut(method)}, with the settings saved above.`
              : `Save the ${methodLabel(method)} settings first.`}
      </p>
      <FormError className="mt-2">{error}</FormError>
    </div>
  );
}

// --- SMTP --------------------------------------------------------------------------------

function SmtpForm({ v, use, onSaved }: { v: MailView; use: boolean; onSaved: (v: MailView) => void }) {
  const [s, setS] = useState(v.smtp);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  /** The platform's SMTP (1.21.0): only `use`, nothing about the relay. */
  async function switchToPlatform() {
    setBusy(true);
    const r = await withConfirm({ use: true }, "/api/admin/smtp");
    setBusy(false);
    if (!r) return;
    if (!r.ok || r.data?.error) {
      toast("error", r.data?.error || "Could not switch.");
      return;
    }
    const fresh = await fetch(URL_).then((x) => (x.ok ? x.json() : null), () => null);
    if (fresh) onSaved(fresh);
    toast("ok", "Email now goes out by SMTP.");
  }

  async function save() {
    setBusy(true);
    const r = await withConfirm({ host: s.host, port: s.port, secure: s.secure, user: s.user, ...(pass ? { pass } : {}), from: s.from, use }, "/api/admin/smtp");
    if (!r) {
      setBusy(false);
      return;
    }
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

  // 1.21.0: SMTP set by the platform (cloud mode, COMPASSDOCS_SMTP_*): the
  // relay and the From address are shown, nothing is editable, and choosing
  // SMTP as the way mail goes out still works.
  if (v.smtp.platform) {
    return (
      <div id="smtp" className="scroll-mt-6" data-testid="mail-smtp">
        <SetByPlatform>
          Email goes out through CompassDocs Cloud&rsquo;s relay{v.smtp.from ? <> from <span className="font-medium text-slate-700">{v.smtp.from}</span></> : null}.
        </SetByPlatform>
        {use && (
          <div className="mt-4 flex items-center gap-3">
            <Button busy={busy} onClick={() => void switchToPlatform()}>
              Send by SMTP
            </Button>
          </div>
        )}
      </div>
    );
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
                <span className="ink-ok inline-flex items-center gap-1">
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
  const [f, setF] = useState({ tenant: m.tenant, client_id: m.client_id, mailbox: m.mailbox, graph_user: m.graph_user, from_name: m.from_name });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [mailboxError, setMailboxError] = useState("");
  const appSame = m.has_secret && !m.secret_unreadable && f.client_id.trim().toLowerCase() === m.client_id && (!f.tenant.trim() || f.tenant.trim().toLowerCase() === m.tenant);
  // A new sending mailbox takes the secret again (the server refuses it without).
  const mailboxSame = f.mailbox.trim().toLowerCase() === m.mailbox && f.graph_user.trim().toLowerCase() === m.graph_user;
  const sameApp = appSame && mailboxSame;
  const exp = secretExpiry(m.secret_expires);
  const expiry =
    exp.state === "expired"
      ? `The client secret expired on ${fmt.day(exp.date)}. Create a new secret for the app in Entra and paste it here.`
      : exp.state === "soon"
        ? `The client secret expires on ${fmt.day(exp.date)} (${exp.days <= 1 ? "within a day" : `in ${exp.days} days`}). Create a new secret for the app in Entra and paste it here before then.`
        : "";
  const expiryState = exp.state;

  async function save() {
    // Same sentence as the server's refusal: say why the secret is asked for again.
    const problem =
      appSame && !mailboxSame && !secret.trim()
        ? "Enter the client secret again to change the sending mailbox (or run Set up with Microsoft). Whoever changes where email comes from must hold the app's secret."
        : mailM365Problem({ ...f, secret }, sameApp);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    const r = await withConfirm({ action: "m365", ...f, ...(secret ? { secret } : {}), use });
    setBusy(false);
    if (!r) return;
    if (!r.ok) {
      setError(r.data?.error || "Could not save.");
      return;
    }
    onSaved(r.data.view);
    setSecret("");
    setF({ tenant: r.data.view.m365.tenant, client_id: r.data.view.m365.client_id, mailbox: r.data.view.m365.mailbox, graph_user: r.data.view.m365.graph_user, from_name: r.data.view.m365.from_name });
    toast("ok", r.data.method_changed ? "Saved. Email now goes out through Microsoft 365." : "Microsoft 365 settings saved.");
  }

  async function check() {
    setChecking(true);
    setError("");
    const r = await patch({ action: "check" });
    setChecking(false);
    if (r.data?.view) onSaved(r.data.view);
    if (!r.data?.check?.ok) setError(r.data?.check?.message || r.data?.error || "The check failed.");
  }

  return (
    <div id="microsoft-365" className="scroll-mt-6" data-testid="mail-m365">
      <p className="mb-3 text-sm text-slate-500">
        Mail goes out through Microsoft Graph as one mailbox and lands in its Sent Items, so a copy of every notification, newsletter and helpdesk reply stays there: use a
        mailbox kept for this, such as a shared mailbox. No SMTP server, password or SMTP AUTH is needed. One email can be at most about 2.9 MB with its attachments, and
        Microsoft lets one mailbox send about 30 a minute and 10,000 a day. Helpdesk replies go out from this mailbox too, under the help address&apos;s name, with
        answers coming back to the help address.
      </p>
      {m.secret_unreadable && (
        <p className="notice-error mb-3 rounded-lg border px-3 py-2 text-sm" role="alert" data-testid="mail-secret-unreadable">
          The stored client secret can&apos;t be read: the server&apos;s secret key changed. Paste the client secret again below, or run Set up with Microsoft.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Sending mailbox's email address"
          error={mailboxError}
          help="The address recipients see (its primary SMTP address in Exchange). Microsoft doesn't let an app that may only send look it up, so it is asked for here. A shared mailbox works and needs no license."
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
        <Field
          label={<>Sign-in name or object ID <span className="text-slate-500">(only if different)</span></>}
          help="Only when the mailbox's sign-in name is not its email address, such as compassdocs@yourcompany.onmicrosoft.com. Microsoft is asked by this; mail still comes from the address above."
        >
          <TextInput value={f.graph_user} onChange={(e) => setF({ ...f, graph_user: e.target.value })} spellCheck={false} autoComplete="off" maxLength={200} />
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
              if (why) {
                setMailboxError(why);
                return false;
              }
              if (!use) return true;
              const w = await patch({ action: "warnings", method: "m365", mailbox: f.mailbox.trim() });
              return confirmSwitch(w.data?.warnings ?? []);
            }}
            startBody={() => ({ mailbox: f.mailbox.trim(), graph_user: f.graph_user.trim(), from_name: f.from_name, use })}
            doneMessage={(r) =>
              r?.verified === false
                ? "The app was set up in Entra and saved here. Microsoft is still activating it: press Check connection in a minute, then limit it to the sending mailbox below."
                : r?.reused
                  ? `Done. The app you already send with was given a new secret, and nothing else about it changed.${r?.secret_expires ? ` The secret is good until ${fmt.day(r.secret_expires)}.` : ""}${r?.old_secret_removed ? " Its previous secret from this setup was removed." : ""}`
                  : `Done. The app was created in Entra, Mail.Send was granted and the details were filled in.${r?.secret_expires ? ` The client secret is good until ${fmt.day(r.secret_expires)}.` : ""} Next, limit the app to ${r?.mailbox ?? "the sending mailbox"} with the commands below.`
            }
            doneWarn={(r) => r?.verified === false}
            onDone={(fresh: MailView) => {
              onSaved(fresh);
              setSecret("");
              setF({ tenant: fresh.m365.tenant, client_id: fresh.m365.client_id, mailbox: fresh.m365.mailbox, graph_user: fresh.m365.graph_user, from_name: fresh.m365.from_name });
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
                  <span className="ink-ok inline-flex items-center gap-1">
                    <Check className="h-3.5 w-3.5" aria-hidden /> (stored)
                  </span>
                ) : (
                  ""
                )}
              </>
            }
            help={
              appSame && !mailboxSame && !secret
                ? "Changing the sending mailbox takes the secret again."
                : m.has_secret && m.secret_expires && !secret
                  ? `Good until ${fmt.day(m.secret_expires)}. It is never shown.`
                  : "Its Value, not its Secret ID. It is never shown again."
            }
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
            {v.one_click === "available" ? " Or run Set up with Microsoft again: it gives this app a new secret and changes nothing else about it." : ""}
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
        <p className={`mt-2 text-xs ${m.last_check?.ok === false || m.last_check?.limited === false ? "ink-warn" : "text-slate-500"}`} data-testid="mail-check" aria-live="polite">
          {m.last_check
            ? `${m.last_check.message} Checked ${fmt.dateTime(m.last_check.at)}.`
            : "Check connection signs in and asks Microsoft whether the app may send as the mailbox, and as your own address (it should not). It sends nothing."}
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
  const later = accessPolicyUpdateCommands({ clientId: m.client_id, mailbox: m.mailbox });
  return (
    <section className="mt-6 border-t border-slate-100 pt-4" data-testid="mail-lockdown" aria-labelledby="mail-lockdown-title">
      <h4 id="mail-lockdown-title" className="text-sm font-semibold text-slate-900">
        Limit the app to {m.mailbox}
      </h4>
      <p className="mt-1 text-sm text-slate-600">
        Microsoft&apos;s Mail.Send permission lets an app send as any mailbox in your organization, not only this one. Limit it, so that the app, or anyone who gets hold of
        its secret, can send as {m.mailbox} and nobody else. Microsoft offers no way to do this from here: an Exchange administrator runs these commands once, in PowerShell
        with the ExchangeOnlineManagement module.
      </p>
      {m.last_check?.limited === false && (
        <p className="notice-warn mt-2 rounded-lg border px-3 py-2 text-sm" data-testid="mail-not-limited">
          Needs attention: the app can also send as {m.last_check.other}, so it can send as other mailboxes in your organization. Run the commands below, then press Check
          connection again.
        </p>
      )}
      {m.last_check?.limited === true && (
        <p className="ink-ok mt-2 text-sm" data-testid="mail-limited">
          The app can&apos;t send as {m.last_check.other}: it is limited, as it should be.
        </p>
      )}
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
            The first lines make a mail-enabled security group holding only {m.mailbox}, hidden from the address book and named after this app, so another CompassDocs in your
            organization makes its own; the policy lets the app reach that group&apos;s members
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
              <p className="mt-2 text-xs text-slate-500">Press Check connection once, so CompassDocs learns the app&apos;s object ID in your organization.</p>
            )}
          </details>
        </>
      ) : (
        <>
          <p className="mb-1 mt-3 text-xs font-medium text-slate-500">
            The app has no mail permission in Entra, so it can send as nobody yet. These commands give it Mail.Send for this mailbox only (RBAC for Applications)
          </p>
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
            <p className="mt-2 text-xs text-slate-500">Press Check connection once, so CompassDocs learns the app&apos;s object ID in your organization.</p>
          )}
        </>
      )}
    </section>
  );
}
