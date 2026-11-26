import { NextResponse } from "next/server";
import { apiGuard, credentialSaveError, platformSettingRefusal } from "@/lib/api-auth";
import { getSmtpConfig, updateSmtpConfig, smtpConfigured, smtpFromPlatform } from "@/lib/smtp-config";
import { sendMailWith } from "@/lib/mailer";
import { MailConfigError, setMailMethod } from "@/lib/mail-config";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The SMTP password is write-only: GET only reports whether one is stored.
async function view() {
  const cfg = await getSmtpConfig();
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    has_pass: Boolean(cfg.pass),
    from: cfg.from,
    configured: smtpConfigured(cfg),
    platform: smtpFromPlatform(),
  };
}

export async function GET() {
  const gate = await apiGuard("admin", "integration.smtp_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "integration.smtp_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Test delivery to a given address using the SAVED configuration.
  if (body?.action === "test") {
    const to = String(body?.to ?? "").trim();
    if (!to.includes("@")) {
      return NextResponse.json({ error: "Enter a recipient address for the test." }, { status: 400 });
    }
    // 1.20.31: always by SMTP (this is the SMTP settings' test), whichever method is chosen.
    try {
      await sendMailWith("smtp", { to: [to], subject: "CompassDocs test email", text: "This test was sent by SMTP. Email from CompassDocs is set up." });
      await audit({ actor: actorFrom(user), action: "settings.mail_test", targetType: "settings", targetId: "mail", targetLabel: "Email", details: { method: "smtp", ok: true }, ip: ipFrom(req) });
      return NextResponse.json({ ok: true, status: `sent to ${to}` });
    } catch (e) {
      const error = e instanceof Error ? e.message : "Send failed.";
      await audit({ actor: actorFrom(user), action: "settings.mail_test", targetType: "settings", targetId: "mail", targetLabel: "Email", details: { method: "smtp", ok: false, error: error.slice(0, 300) }, ip: ipFrom(req) });
      return NextResponse.json({ ok: false, error }, { status: 502 });
    }
  }

  // 1.21.0: SMTP set by the platform (cloud mode, COMPASSDOCS_SMTP_*) is
  // read-only; choosing it as the way mail goes out (`use`) still works.
  if (smtpFromPlatform() && ["host", "port", "secure", "user", "pass", "clear_pass", "from"].some((k) => body?.[k] !== undefined)) {
    return platformSettingRefusal("SMTP");
  }

  const keyErr = await credentialSaveError(() => updateSmtpConfig({
    ...(body?.host !== undefined ? { host: String(body.host) } : {}),
    ...(body?.port !== undefined ? { port: Number(body.port) || 587 } : {}),
    ...(body?.secure !== undefined ? { secure: String(body.secure) } : {}),
    ...(body?.user !== undefined ? { user: String(body.user) } : {}),
    ...(typeof body?.pass === "string" && body.pass !== "" ? { pass: body.pass } : {}),
    ...(body?.clear_pass === true ? { pass: "" } : {}),
    ...(body?.from !== undefined ? { from: String(body.from) } : {}),
  }));
  if (keyErr) return keyErr;
  await audit({
    actor: actorFrom(user),
    action: "settings.smtp",
    details: { pass_changed: Boolean(body?.pass) || body?.clear_pass === true },
    ip: ipFrom(req),
  });
  // 1.20.31: saved from the SMTP panel while Microsoft 365 is chosen: `use` makes SMTP the way mail is sent.
  let method_changed = false;
  if (body?.use === true) {
    try {
      method_changed = await setMailMethod("smtp", { actor: actorFrom(user), ip: ipFrom(req) }, { confirm: body?.confirm === true });
    } catch (e) {
      // 1.20.32: mail still waiting in the Microsoft 365 outbox: the page asks first (its warnings), then sends confirm.
      if (e instanceof MailConfigError && e.code === "confirm") return NextResponse.json({ error: e.message, code: e.code, warnings: e.warnings, state: await view() }, { status: 409 });
      if (e instanceof MailConfigError) return NextResponse.json({ ok: true, state: await view(), error: e.message, method_changed: false });
      throw e;
    }
  }
  return NextResponse.json({ ok: true, state: await view(), method_changed });
}
