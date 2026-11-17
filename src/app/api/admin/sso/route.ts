import { NextResponse } from "next/server";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { getSsoConfig, updateSsoConfig, ssoAuthority, asSsoVendor } from "@/lib/sso-config";
import { adminsOutsideBreakGlass, countLocalPasswords, getSetting, setSetting } from "@/lib/db";
import { breakGlassIds, usableBreakGlass } from "@/lib/sign-in-security";
import { BREAK_GLASS_MAX, SIGN_IN_SECURITY_KEYS } from "@/lib/sign-in-security-shared";
import { featureEnabled, featureEnforced, eePresent } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["viewer", "editor", "approver", "admin"];

// The client secret is write-only: GET only reports whether one is stored.
async function view() {
  const [cfg, enabled, enforced, secretExpires, breakGlass] = await Promise.all([
    getSsoConfig(),
    featureEnabled("sso"),
    featureEnforced("sso"),
    getSetting("sso_secret_expires"),
    breakGlassIds(),
  ]);
  return {
    // 1.20.27 (security review H1): who may still use a password while SSO only is on, and how many others have one.
    break_glass_user_ids: breakGlass,
    local_password_count: await countLocalPasswords(breakGlass),
    // Second review M5: the administrators SSO only keeps out; M7: a lapsed licence (only relaxing changes save).
    admins_outside_break_glass: (await adminsOutsideBreakGlass(breakGlass)).map((a) => a.name || a.username),
    lapsed: !enabled && enforced,
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

/**
 * A save a lapsed licence allows (1.20.27, second review M7): it turns SSO
 * only off, changes the break-glass list or enters a new client secret, and
 * every other field it carries (the page sends the whole form) is as saved.
 */
function onlyRelaxing(body: Record<string, unknown>, cfg: Awaited<ReturnType<typeof getSsoConfig>>): boolean {
  const domains = (v: unknown) =>
    String(v ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean)
      .join(",");
  const same: Record<string, (v: unknown) => boolean> = {
    sso_enabled: (v) => Boolean(v) === cfg.enabled,
    tenant: (v) => String(v).trim() === cfg.tenant,
    client_id: (v) => String(v).trim() === cfg.clientId,
    authority: (v) => String(v).trim() === cfg.authority,
    auto_provision: (v) => Boolean(v) === cfg.autoProvision,
    default_role: (v) => v === cfg.defaultRole,
    allowed_domains: (v) => domains(v) === cfg.allowedDomains.join(","),
    vendor: (v) => asSsoVendor(String(v)) === cfg.vendor,
    // Off, or left on: never switched on.
    sso_only: (v) => v === false || (Boolean(v) && cfg.ssoOnly),
    clear_secret: (v) => v !== true,
  };
  const relaxing = new Set(["break_glass_user_ids", "client_secret"]);
  return Object.entries(body).every(([k, v]) => v === undefined || relaxing.has(k) || (same[k] ? same[k](v) : false));
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "identity.sso_manage");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // 1.20.27 (security review M4, second review M7): with the licence
  // lapsed, single sign-on and SSO only keep being enforced, and only the
  // changes that relax them or keep them working can be saved: turning SSO
  // only off, the break-glass list, and a new client secret (one that
  // expired during the lapse would otherwise leave nobody able to sign in).
  // Without a licence that ever granted SSO, nothing changes.
  if (!(await featureEnabled("sso"))) {
    const lapsed = await featureEnforced("sso");
    if (!lapsed || !onlyRelaxing(body ?? {}, await getSsoConfig())) {
      return NextResponse.json(
        {
          error: lapsed
            ? "Your licence has lapsed: you can turn SSO only off, change the break-glass accounts or enter a new client secret, and nothing else, until it is renewed."
            : "Your licence doesn't include single sign-on, so its settings can't be changed.",
        },
        { status: 402 }
      );
    }
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

  // 1.20.27 (second review H1): SSO only, and the list it keeps open, can
  // only be saved with a break-glass account that can actually get in (an
  // active administrator with a password): administrators are never linked
  // to single sign-on, so without one nobody could mend a broken identity
  // provider. Turning SSO only off is always allowed.
  const before = await getSsoConfig();
  const ssoOnlyAfter = body?.sso_only !== undefined ? Boolean(body.sso_only) : before.ssoOnly;
  const touchesRule = (body?.sso_only === true && !before.ssoOnly) || breakGlass !== null;
  if (ssoOnlyAfter && touchesRule && (await usableBreakGlass(breakGlass ? breakGlass.to : await breakGlassIds())).length === 0) {
    return NextResponse.json(
      {
        error:
          "Name at least one break-glass account first: an active administrator with a password, who can still sign in if single sign-on fails.",
        code: "break_glass_required",
      },
      { status: 409 }
    );
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
