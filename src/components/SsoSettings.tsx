"use client";

// Admin › Single sign-on. Three states, mirroring the directory Graph panel:
// community build → upsell; enterprise build without the `sso` entitlement →
// license nudge; licensed → the OIDC configuration form.

import { useState } from "react";
import { SaveRow } from "@/components/SaveRow";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { Check, ShieldAlert, UserX } from "lucide-react";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { Button } from "@/components/Button";
import { confirmDialog } from "@/components/Dialog";
import { EnterpriseBadge } from "@/components/Chip";
import { buttonClass } from "@/components/Button";
import { MsDeviceSetup } from "./MsDeviceSetup";
import { Field, TextInput, Toggle } from "@/components/form";
import { LicenseGate } from "@/components/LicenseGate";
import { toast } from "@/components/Toasts";

export interface SsoState {
  enabled: boolean; // bundled AND licensed
  bundled: boolean;
  sso_enabled: boolean;
  tenant: string;
  client_id: string;
  has_secret: boolean;
  authority: string;
  effective_authority: string;
  auto_provision: boolean;
  default_role: string;
  allowed_domains: string;
  sso_only: boolean;
  secret_expires: string;
  /** 1.20.27 (security review H1): the accounts that may still sign in with a password while SSO only is on. */
  break_glass_user_ids?: number[];
  /** Accounts other than those that still have a password ("Remove local passwords" would clear them). */
  local_password_count?: number;
  /** Administrators with a password who are not break-glass: SSO only keeps them out (second review M5). */
  admins_outside_break_glass?: string[];
  /** The licence lapsed (second review M7): SSO keeps working, and only relaxing changes save. */
  lapsed?: boolean;
}

export function SsoSettings({ initial, users = [], viewerId }: { initial: SsoState; users?: PickerOption[]; viewerId?: number }) {
  const [s, setSRaw] = useState(initial);
  const [secret, setSecretRaw] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify([s, secret]));
  useLeaveGuard(dirty, hasUnsavedChanges);
  // User edits dirty the form; what the server hands back does not.
  const setS = (v: typeof s) => { markDirty(); setSRaw(v); };
  const setSecret = (v: string) => { markDirty(); setSecretRaw(v); };
  const [showAdvanced, setShowAdvanced] = useState(Boolean(initial.authority));

  const header = (
    <div>
      <h2 className="text-lg font-semibold text-slate-900">OpenID Connect (OIDC)</h2>
      <p className="mb-4 text-sm text-slate-500">
        Let your team sign in with Microsoft Entra ID (or any OIDC provider) instead of a
        CompassDocs password.
      </p>
    </div>
  );

  if (!s.bundled) {
    return (
      <div>
        {header}
        {/* Community build: there is no licence to open, so no button. */}
        <LicenseGate feature="SSO">
          Sign in with Microsoft Entra ID, auto-provision accounts, and enforce SSO-only
          login. See{" "}
          <a href="https://compassdocs.io/pricing" className="link font-medium">
            pricing
          </a>
          .
        </LicenseGate>
      </div>
    );
  }

  // A lapsed licence keeps the form (second review M7): SSO only can be turned off, the break-glass list changed, the secret rotated.
  const lapsed = !s.enabled && Boolean(s.lapsed);
  if (!s.enabled && !lapsed) {
    return (
      <div>
        {header}
        {/* Settings → SSO is an admin page, so the viewer can open License too. */}
        <LicenseGate feature="SSO" entitlement="sso" canManage>
          This Enterprise build supports it, but your licence doesn&rsquo;t include it yet.
        </LicenseGate>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    const res = await fetch("/api/admin/sso", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sso_enabled: s.sso_enabled,
        tenant: s.tenant,
        client_id: s.client_id,
        ...(secret ? { client_secret: secret } : {}),
        authority: s.authority,
        auto_provision: s.auto_provision,
        default_role: s.default_role,
        allowed_domains: s.allowed_domains,
        sso_only: s.sso_only,
        break_glass_user_ids: s.break_glass_user_ids ?? [],
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return;
    }
    markClean();
    if (data?.state) setSRaw(data.state);
    setSecretRaw("");
    toast("ok", "Single sign-on settings saved.");
  }

  async function removePasswords() {
    const n = s.local_password_count ?? 0;
    const ok = await confirmDialog({
      title: `Remove ${n} local password${n === 1 ? "" : "s"}?`,
      body: "Every account except the break-glass accounts and the administrators loses its password, and with it its API tokens and connected apps. People keep signing in with single sign-on. Administrators keep their passwords, because they are never linked to single sign-on, but only the break-glass ones can sign in while SSO only is on. It can't be undone: a password can only be set again by an administrator's reset.",
      confirmLabel: "Remove passwords",
      danger: true,
      typeToConfirm: "REMOVE",
    });
    if (ok !== true) return;
    setRemoving(true);
    const res = await fetch("/api/admin/sso/remove-passwords", { method: "POST" });
    setRemoving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not remove the passwords.");
      return;
    }
    setSRaw({ ...s, local_password_count: 0 });
    toast("ok", `Removed ${data.removed ?? 0} local password${data.removed === 1 ? "" : "s"}.`);
  }

  const redirectUri =
    typeof window !== "undefined" ? `${window.location.origin}/api/ee/sso/callback` : "…/api/ee/sso/callback";
  const configured = Boolean(s.client_id && (s.has_secret || secret) && (s.tenant || s.authority));

  return (
    <div>
      {header}

      {lapsed && (
        <div className="notice-warn mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Your Enterprise licence has lapsed. Single sign-on keeps working while SSO only is on, but no new accounts are created at first
            sign-in. Until it is renewed you can turn SSO only off, change the break-glass accounts or enter a new client secret, and nothing
            else.
          </p>
        </div>
      )}

      <div id="oidc" className="scroll-mt-6 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="font-semibold text-slate-900">Microsoft Entra ID (OIDC)</h3>
          <EnterpriseBadge />
        </div>
        <p className="mb-3 text-sm text-slate-500">
          Register an app in Microsoft Entra (single-tenant, web platform) with redirect URI{" "}
          <code className="rounded-sm bg-slate-100 px-1 font-mono text-xs">{redirectUri}</code>, create
          a client secret, then enter the details here. No API permissions are needed — sign-in
          uses only OpenID Connect.
        </p>

        {!lapsed && <MsDeviceSetup
          startUrl="/api/ee/sso/setup/start"
          pollUrl="/api/ee/sso/setup/poll"
          refreshUrl="/api/admin/sso"
          blurb="Signs you in once as a tenant admin and creates the app registration, secret, and settings below — nothing to copy by hand. Since 1.20.27 the app is made from Entra's non-gallery template, so SCIM provisioning (below) can use it too."
          doneMessage="Done — the Entra app was created and the settings below were filled in and enabled."
          onDone={(state) => {
            markClean();
            setSRaw(state);
            setSecretRaw("");
          }}
        />}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tenant ID">
            <TextInput
              value={s.tenant}
              onChange={(e) => setS({ ...s, tenant: e.target.value })}
              disabled={lapsed}
              placeholder="00000000-0000-…"
              spellCheck={false}
            />
          </Field>
          <Field label="Client ID">
            <TextInput
              value={s.client_id}
              onChange={(e) => setS({ ...s, client_id: e.target.value })}
              disabled={lapsed}
              placeholder="app registration id"
              spellCheck={false}
            />
          </Field>
          <Field
            label={
              <>
                Client secret{" "}
                {s.has_secret && !secret ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600"><Check className="h-3.5 w-3.5" aria-hidden /> (stored — paste to replace)</span>
                ) : (
                  ""
                )}
              </>
            }
            help={
              s.secret_expires && s.has_secret && !secret
                ? `Expires ${s.secret_expires} — set a reminder to rotate it.`
                : undefined
            }
          >
            <TextInput
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={s.has_secret ? "••••••••" : "secret value"}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-600">
          <Toggle
            label="Create accounts on first sign-in"
            checked={s.auto_provision}
            onChange={(next) => setS({ ...s, auto_provision: next })}
            disabled={lapsed}
          />
          <label className="flex items-center gap-2">
            New accounts get role
            <select
              className="rounded-lg border border-slate-200 px-2 py-1 text-sm"
              value={s.default_role}
              onChange={(e) => setS({ ...s, default_role: e.target.value })}
              disabled={lapsed}
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="approver">approver</option>
              <option value="admin">admin</option>
            </select>
          </label>
        </div>

        <div className="mt-3">
          <Field
            size="lg"
            label={
              <>
                Allowed email domains{" "}
                <span className="text-slate-500">(optional, comma-separated)</span>
              </>
            }
            help="Since 1.16.0 these domains also route sign-in: someone who types an email at one of them goes straight to single sign-on, new colleagues included."
          >
            <TextInput
              value={s.allowed_domains}
              onChange={(e) => setS({ ...s, allowed_domains: e.target.value })}
              disabled={lapsed}
              placeholder="acme.com, acme.co.uk — blank allows any"
              spellCheck={false}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-600"
        >
          {showAdvanced ? "▾" : "▸"} Advanced
        </button>
        {showAdvanced && (
          <div className="mt-2">
            <Field
              size="lg"
              label={
                <>
                  Custom OIDC authority{" "}
                  <span className="text-slate-500">(overrides the tenant — for Okta, Auth0, …)</span>
                </>
              }
              help={
                s.effective_authority ? (
                  <>
                    In effect: <code className="font-mono">{s.effective_authority}</code>
                  </>
                ) : undefined
              }
            >
              <TextInput
                value={s.authority}
                onChange={(e) => setS({ ...s, authority: e.target.value })}
                disabled={lapsed}
                placeholder="https://your-idp.example.com"
                spellCheck={false}
              />
            </Field>
          </div>
        )}

        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600">
          <Toggle
            label="Enable “Sign in with Microsoft” on the login page"
            checked={s.sso_enabled}
            onChange={(next) => setS({ ...s, sso_enabled: next })}
            disabled={lapsed || (!configured && !s.sso_enabled)}
          />
          <Toggle
            label="SSO only: passwords sign in only the break-glass accounts"
            checked={s.sso_only}
            onChange={(next) => setS({ ...s, sso_only: next })}
            disabled={!s.sso_enabled || (lapsed && !s.sso_only)}
          />
          {s.sso_only && (
            <div id="break-glass" className="scroll-mt-6 border-t border-slate-100 pt-4">
              <h4 className="text-sm font-semibold text-slate-900">Break-glass accounts</h4>
              <p className="mb-2 mt-0.5 text-xs text-slate-500">
                With SSO only on, a password signs in only these accounts, at <code className="font-mono">/login?local=1</code>. Every one of
                their sign-ins is written to the audit log. Pick one or two administrators, give them long passwords and two-step sign-in,
                and keep the details somewhere safe.
              </p>
              <div className="max-w-xl">
                <EntityPicker
                  options={users}
                  value={s.break_glass_user_ids ?? []}
                  onChange={(ids) => setS({ ...s, break_glass_user_ids: ids })}
                  label="Break-glass accounts"
                  placeholder="Search people…"
                  emptyText="No account matches."
                />
              </div>
              {viewerId !== undefined && (s.break_glass_user_ids ?? []).length > 0 && !(s.break_glass_user_ids ?? []).includes(viewerId) && (
                <div className="notice-warn mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <p>
                    You aren&apos;t a break-glass account. While SSO only is on, you can&apos;t sign in again once this session ends unless your
                    account signs in with single sign-on.
                  </p>
                </div>
              )}
              {(s.admins_outside_break_glass ?? []).length > 0 && (
                <p className="mt-3 text-xs text-slate-500">
                  Administrators who can&apos;t sign in while SSO only is on (they have a password but aren&apos;t break-glass):{" "}
                  {(s.admins_outside_break_glass ?? []).join(", ")}. Add them above if they still need to get in.
                </p>
              )}
              {(s.break_glass_user_ids ?? []).length === 0 && (
                <div className="notice-warn mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <p>
                    No break-glass account. If single sign-on stops working, nobody can sign in with a password to fix it. Administrators are
                    never linked to single sign-on, so name at least one of them here.
                  </p>
                </div>
              )}
              {s.sso_only && !dirty && (s.local_password_count ?? 0) > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button variant="danger" size="sm" icon={<UserX />} busy={removing} onClick={() => void removePasswords()}>
                    Remove local passwords…
                  </Button>
                  <p className="min-w-0 flex-1 basis-64 text-xs text-slate-500">
                    {s.local_password_count} other account{s.local_password_count === 1 ? " still has" : "s still have"} a password
                    that can no longer sign in. Removing them also ends those accounts&apos; API tokens and app connections.
                    Administrators keep theirs.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save">
          {s.sso_enabled && configured && (
            <a href="/api/ee/sso/login" className={buttonClass("secondary")}>
              Test sign-in
            </a>
          )}
        </SaveRow>
      </div>
    </div>
  );
}
