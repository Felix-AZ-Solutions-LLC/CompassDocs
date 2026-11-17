import { NextResponse } from "next/server";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { getSsoConfig, updateSsoConfig, ssoAuthority, asSsoVendor } from "@/lib/sso-config";
import { countLocalPasswords, getSetting, setSetting } from "@/lib/db";
import { breakGlassIds } from "@/lib/sign-in-security";
import { BREAK_GLASS_MAX, SIGN_IN_SECURITY_KEYS } from "@/lib/sign-in-security-shared";
import { featureEnabled, eePresent } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["viewer", "editor", "approver", "admin"];

// The client secret is write-only: GET only reports whether one is stored.
async function view() {
  const [cfg, enabled, secretExpires, breakGlass] = await Promise.all([
    getSsoConfig(),
    featureEnabled("sso"),
    getSetting("sso_secret_expires"),
    breakGlassIds(),
  ]);
  return {
    // 1.20.27 (security review H1): who may still use a password while SSO only is on, and how many others have one.
    break_glass_user_ids: breakGlass,
    local_password_count: await countLocalPasswords(breakGlass),
    secret_expires: secretExpires || "",
    enabled, // bundled AND licensed
    bundled: eePresent(),
    sso_enabled: cfg.enabled,
    tenant: cfg.tenant,
    client_id: cfg.clientId,
    has_secret: Boolean(cfg.clientSecret),
    authority: cfg.authority,
    effective_authority: ssoAuthority(cfg),
    auto_provision: cfg.autoProvision,
    default_role: cfg.defaultRole,
    allowed_domains: cfg.allowedDomains.join(", "),
    sso_only: cfg.ssoOnly,
    vendor: cfg.vendor,
  };
}

export async function GET() {
  const gate = await apiGuard("admin", "identity.sso_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "identity.sso_manage");
  if (gate instanceof NextResponse) return gate;
  // 1.20.27 (security review M4): with the licence lapsed, single sign-on
  // and SSO only keep being enforced, but their settings do not change.
  if (!(await featureEnabled("sso"))) {
    return NextResponse.json({ error: "Your licence doesn't include single sign-on, so its settings can't be changed." }, { status: 402 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let breakGlass: { from: number[]; to: number[] } | null = null;
  if (body?.break_glass_user_ids !== undefined) {
    if (!Array.isArray(body.break_glass_user_ids) || body.break_glass_user_ids.length > BREAK_GLASS_MAX) {
      return NextResponse.json({ error: `Name up to ${BREAK_GLASS_MAX} break-glass accounts.` }, { status: 400 });
    }
    const to = [...new Set(body.break_glass_user_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[];
    const from = await breakGlassIds();
    if (JSON.stringify([...to].sort()) !== JSON.stringify([...from].sort())) breakGlass = { from, to };
  }

  const keyErr = await credentialSaveError(() => updateSsoConfig({
    ...(body?.sso_enabled !== undefined ? { enabled: Boolean(body.sso_enabled) } : {}),
    ...(body?.tenant !== undefined ? { tenant: String(body.tenant) } : {}),
    ...(body?.client_id !== undefined ? { clientId: String(body.client_id) } : {}),
    // Only overwrite the stored secret when a new value is actually provided.
    ...(typeof body?.client_secret === "string" && body.client_secret !== ""
      ? { clientSecret: body.client_secret }
      : {}),
    ...(body?.clear_secret === true ? { clientSecret: "" } : {}),
    ...(body?.authority !== undefined ? { authority: String(body.authority) } : {}),
    ...(body?.auto_provision !== undefined
      ? { autoProvision: Boolean(body.auto_provision) }
      : {}),
    ...(ROLES.includes(body?.default_role) ? { defaultRole: body.default_role as Role } : {}),
    ...(body?.allowed_domains !== undefined
      ? { allowedDomains: String(body.allowed_domains) }
      : {}),
    ...(body?.sso_only !== undefined ? { ssoOnly: Boolean(body.sso_only) } : {}),
    ...(body?.vendor !== undefined ? { vendor: asSsoVendor(String(body.vendor)) } : {}),
  }));
  if (keyErr) return keyErr;
  if (breakGlass) await setSetting(SIGN_IN_SECURITY_KEYS.breakGlass, JSON.stringify(breakGlass.to));

  await audit({
    actor: actorFrom(gate),
    action: "settings.sso",
    details: {
      secret_changed: Boolean(body?.client_secret) || body?.clear_secret === true,
      ...(body?.sso_only !== undefined ? { sso_only: Boolean(body.sso_only) } : {}),
      ...(breakGlass ? { break_glass_user_ids: breakGlass } : {}),
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, state: await view() });
}
