// 1.20.31: how the workspace's outgoing email is sent (Settings →
// Notifications → Email), and its Microsoft 365 configuration. The SMTP
// fields keep their own route (/api/admin/smtp).
//
//   GET    → MailView (lib/mail-m365-shared): the chosen method, both
//            configurations (secrets only as has_secret / has_pass)
//   PATCH  { action: "method", method: "smtp" | "m365", confirm? }
//            → choose; 409 while that method is not set up; 409 code
//              "confirm" with `warnings` when the switch changes something
//              people notice (lib/mail-config methodSwitchWarnings), until
//              confirm is true
//          { action: "warnings", method, mailbox? } → { warnings }
//          { action: "m365", tenant, client_id, secret?, mailbox, graph_user?, from_name?, use?, confirm? }
//            → save the Microsoft 365 configuration after signing in with it
//              (409 with Microsoft's reason in plain words when refused);
//              `use`: choose Microsoft 365 afterwards
//          { action: "test", method?, to }
//            → a test email by that method (default: the chosen one)
//          { action: "check" }
//            → sign in and ask Graph whether the app may send as the
//              mailbox, and as the admin's own address (it should not),
//              sending nothing; kept for the page, audited
//
// Same permissions as the SMTP settings: integration.smtp_read to look,
// integration.smtp_manage to change or test. Audited in lib/mail-config
// (settings.mail_method, settings.mail_m365, settings.mail_m365_secret) and
// here (settings.mail_test, settings.mail_check).

import { NextResponse } from "next/server";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { MailConfigError, getMailMethod, mailView, methodConfigured, methodSwitchWarnings, saveM365SendConfig, setMailMethod } from "@/lib/mail-config";
import { sendMailWith } from "@/lib/mailer";
import { probeM365Send } from "@/lib/mail-m365";
import { methodLabel, type MailMethod } from "@/lib/mail-m365-shared";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";
// The Microsoft 365 save signs in first; a test may wait out one Retry-After.
export const maxDuration = 90;

const asMethod = (v: unknown): MailMethod | null => (v === "smtp" || v === "m365" ? v : null);

export async function GET() {
  const gate = await apiGuard("admin", "integration.smtp_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await mailView());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "integration.smtp_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const by = { actor: actorFrom(user), ip: ipFrom(req) };

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = String(body?.action ?? "");

  try {
    if (action === "method") {
      const method = asMethod(body?.method);
      if (!method) return NextResponse.json({ error: "Choose SMTP or Microsoft 365." }, { status: 400 });
      const changed = await setMailMethod(method, by, { confirm: body?.confirm === true });
      return NextResponse.json({ ok: true, changed, view: await mailView() });
    }

    if (action === "warnings") {
      const method = asMethod(body?.method);
      if (!method) return NextResponse.json({ error: "Choose SMTP or Microsoft 365." }, { status: 400 });
      return NextResponse.json({ warnings: await methodSwitchWarnings(method, typeof body?.mailbox === "string" ? body.mailbox : undefined) });
    }

    if (action === "m365") {
      let result: Awaited<ReturnType<typeof saveM365SendConfig>> | null = null;
      const keyErr = await credentialSaveError(async () => {
        result = await saveM365SendConfig(
          { tenant: body?.tenant, client_id: body?.client_id, secret: body?.secret, mailbox: body?.mailbox, graph_user: body?.graph_user, from_name: body?.from_name },
          by,
          { setup: "manual", use: body?.use === true, confirm: body?.confirm === true }
        );
      });
      if (keyErr) return keyErr;
      const r = result!;
      return NextResponse.json({ ok: true, verified: r.verified, changed: r.changed, method_changed: r.method_changed, view: await mailView() });
    }

    if (action === "test") {
      const method = asMethod(body?.method) ?? (await getMailMethod());
      const to = String(body?.to ?? "").trim();
      if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(to)) return NextResponse.json({ error: "Enter a recipient address for the test." }, { status: 400 });
      if (!(await methodConfigured(method))) {
        return NextResponse.json({ error: `${methodLabel(method)} isn't set up yet. Save its settings first.` }, { status: 409 });
      }
      const line =
        method === "m365"
          ? "This test was sent through Microsoft 365. Email from CompassDocs is set up, and it is in the sending mailbox's Sent Items."
          : "This test was sent by SMTP. Email from CompassDocs is set up.";
      try {
        await sendMailWith(method, { to: [to], subject: "CompassDocs test email", text: line });
      } catch (e) {
        const error = e instanceof Error ? e.message : "Send failed.";
        await audit({ ...auditBase(by), action: "settings.mail_test", details: { method, ok: false, error: error.slice(0, 300) } });
        return NextResponse.json({ ok: false, error }, { status: 502 });
      }
      await audit({ ...auditBase(by), action: "settings.mail_test", details: { method, ok: true } });
      return NextResponse.json({ ok: true, status: `sent to ${to}`, method, view: await mailView() });
    }

    if (action === "check") {
      const check = await probeM365Send({ other: user.email || null });
      // 1.20.32: a check that passes lifts a pause for a refusal (lib/mail-outbox): what waited goes now.
      if (check.ok) await (await import("@/lib/mail-outbox")).resumeOutbox({ onlyRefusal: true }).catch(() => {});
      await audit({ ...auditBase(by), action: "settings.mail_check", details: { ok: check.ok, limited: check.limited ?? null, other: check.other || null, error: check.ok ? null : check.message.slice(0, 300) } });
      return NextResponse.json({ ok: check.ok, check, view: await mailView() });
    }
  } catch (e) {
    if (e instanceof MailConfigError) return NextResponse.json({ error: e.message, code: e.code || undefined, ...(e.warnings.length ? { warnings: e.warnings } : {}) }, { status: e.status });
    throw e;
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

const auditBase = (by: { actor: ReturnType<typeof actorFrom>; ip: string | null }) => ({
  actor: by.actor,
  targetType: "settings",
  targetId: "mail",
  targetLabel: "Email",
  ip: by.ip,
});
