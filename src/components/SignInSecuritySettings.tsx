"use client";

// Settings → Sign-in security (1.20.27, security review H3, M8, H4): who
// must use two-step sign-in, how long a session may last, and every
// account's API tokens and app connections, each revocable. The first two
// cards share the page's one SaveRow; revoking acts at once and asks first.

import { useMemo, useState } from "react";
import { Ban, KeyRound, Plug } from "lucide-react";
import { Card } from "@/components/Card";
import { SaveRow } from "@/components/SaveRow";
import { Field, SectionEmpty, TextInput, rangeError } from "@/components/form";
import { RadioCards } from "@/components/PolicyFields";
import { ListFilter } from "@/components/ListFilter";
import { Table, TABLE_HEAD_ROW, TD, TH, TR, FIT } from "@/components/Table";
import { chipClass } from "@/components/Chip";
import { iconButtonClass } from "@/components/Button";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { RelativeTime } from "@/components/RelativeTime";
import { useFormatDate } from "@/components/SettingsProvider";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  SESSION_MAX_DAYS_MAX,
  SESSION_MAX_DAYS_MIN,
  TWO_STEP_HELP,
  TWO_STEP_LABEL,
  TWO_STEP_SCOPES,
  type TwoStepScope,
} from "@/lib/sign-in-security-shared";
import type { CredentialRow } from "@/lib/db";
import { ROLE_ORDER, type Role } from "@/lib/types";

export interface SignInSecurityState {
  two_step: TwoStepScope;
  session_max_days: number;
  credentials: CredentialRow[];
}

export function SignInSecuritySettings({
  initial,
  canRevoke,
  viewer,
}: {
  initial: SignInSecurityState;
  canRevoke: boolean;
  /** Who is looking (1.20.27): a row is revocable when it is theirs, they are an administrator, or its owner's role is below theirs. */
  viewer?: { id: number; role: Role };
}) {
  const [twoStep, setTwoStep] = useState<TwoStepScope>(initial.two_step);
  const [days, setDays] = useState(String(initial.session_max_days));
  const [credentials, setCredentials] = useState(initial.credentials);
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify([twoStep, days]));
  useLeaveGuard(dirty, hasUnsavedChanges);
  const daysError = rangeError(Number(days), SESSION_MAX_DAYS_MIN, SESSION_MAX_DAYS_MAX);

  async function save() {
    setTried(true);
    if (daysError) return;
    setSaving(true);
    const res = await fetch("/api/admin/sign-in-security", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ two_step: twoStep, session_max_days: Number(days) }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return;
    }
    markClean();
    setTwoStep(data.two_step);
    setDays(String(data.session_max_days));
    setCredentials(data.credentials ?? credentials);
    toast("ok", "Sign-in security saved.");
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        id="two-step"
        className="scroll-mt-6"
        title="Require two-step sign-in"
        description="Who must enter a code from an authenticator app when they sign in with a password. Single sign-on and Duo bring their own second step, so they are not asked again."
      >
        <RadioCards
          label="Who must use two-step sign-in"
          name="two-step"
          value={twoStep}
          onChange={(v) => {
            markDirty();
            setTwoStep(v);
          }}
          options={TWO_STEP_SCOPES.map((s) => ({ value: s, label: TWO_STEP_LABEL[s], description: TWO_STEP_HELP[s] }))}
        />
        {twoStep !== "off" && (
          <p className="mt-3 text-xs text-slate-500">
            Someone it covers who has not set an authenticator up is asked to at their next password sign-in, and can use nothing else until
            they have. They cannot turn it off afterwards. If someone loses their authenticator, reset two-step sign-in for them under Users.
          </p>
        )}
      </Card>

      <Card
        id="sessions"
        className="scroll-mt-6"
        title="Session lifetime"
        description="However active it is, a session ends this many days after it began, and its owner signs in again. The idle timeout (Workspace, Content) still applies within it."
      >
        <Field size="xs" label="Days a session lasts" error={tried || days !== String(initial.session_max_days) ? daysError : undefined} help={`From ${SESSION_MAX_DAYS_MIN} to ${SESSION_MAX_DAYS_MAX}. The default is 30.`}>
          <TextInput
            type="number"
            min={SESSION_MAX_DAYS_MIN}
            max={SESSION_MAX_DAYS_MAX}
            step={1}
            value={days}
            onChange={(e) => {
              markDirty();
              setDays(e.target.value);
            }}
          />
        </Field>
      </Card>

      <SaveRow dirty={dirty} busy={saving} onSave={save} disabled={Boolean(daysError)} label="Save" />

      <Credentials rows={credentials} setRows={setCredentials} canRevoke={canRevoke} viewer={viewer} />
    </div>
  );
}

function Credentials({
  rows,
  setRows,
  canRevoke,
  viewer,
}: {
  rows: CredentialRow[];
  setRows: (r: CredentialRow[]) => void;
  canRevoke: boolean;
  viewer?: { id: number; role: Role };
}) {
  // The server's rule (api/admin/sign-in-security mayRevokeFor), so no row offers a button that would be refused.
  const revocable = (r: CredentialRow) =>
    canRevoke &&
    (!viewer || viewer.role === "admin" || r.user_id === viewer.id || ROLE_ORDER.indexOf(r.user_role) < ROLE_ORDER.indexOf(viewer.role));
  const [q, setQ] = useState("");
  const fmt = useFormatDate();
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => `${r.username} ${r.user_name} ${r.name} ${r.prefix}`.toLowerCase().includes(term));
  }, [rows, q]);

  async function revoke(r: CredentialRow) {
    const what = r.kind === "token" ? `the token “${r.name}”` : `the app “${r.name || "Unnamed app"}”`;
    const ok = await confirmDialog({
      title: r.kind === "token" ? "Revoke this token?" : "Disconnect this app?",
      body: `This stops ${what} of ${r.user_name || r.username} working at once. It is written to the audit log.`,
      confirmLabel: r.kind === "token" ? "Revoke" : "Disconnect",
      danger: true,
    });
    if (ok !== true) return;
    const qs = r.kind === "token" ? `kind=token&id=${encodeURIComponent(r.id)}` : `kind=connector&id=${encodeURIComponent(r.id)}&user=${r.user_id}`;
    const res = await fetch(`/api/admin/sign-in-security?${qs}`, { method: "DELETE" });
    if (!res.ok) {
      toast("error", (await res.json().catch(() => ({})))?.error || "Could not revoke it.");
      return;
    }
    setRows(rows.filter((x) => !(x.kind === r.kind && x.id === r.id && x.user_id === r.user_id)));
    toast("ok", r.kind === "token" ? "Token revoked." : "App disconnected.");
  }

  const now = Date.now();
  return (
    <Card
      id="credentials"
      className="scroll-mt-6"
      padding="none"
      title="API tokens and app connections"
      description="Every account's personal API tokens and the apps (like Claude) people have connected. Each acts as its owner until it expires or is revoked. A password reset or change revokes the owner's automatically."
    >
      {rows.length > 8 && (
        <div className="border-b border-slate-100 px-4 py-3">
          <ListFilter value={q} onChange={setQ} label="Filter tokens and apps" placeholder="Filter by person or name" shown={shown.length} total={rows.length} noun="credentials" />
        </div>
      )}
      {rows.length === 0 ? (
        <SectionEmpty className="px-5 py-6">No one has an API token or a connected app.</SectionEmpty>
      ) : shown.length === 0 ? (
        <SectionEmpty className="px-5 py-6" action={{ label: "Clear the filter", onClick: () => setQ("") }}>
          Nothing matches “{q}”.
        </SectionEmpty>
      ) : (
        <Table scroll minWidth="44rem">
          <thead className={TABLE_HEAD_ROW}>
            <tr>
              <th className={TH}>Person</th>
              <th className={TH}>Token or app</th>
              <th className={`${TH} ${FIT}`}>Last used</th>
              <th className={`${TH} ${FIT}`}>Expires</th>
              {canRevoke && (
                <th className={`${TH} ${FIT}`}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const expired = r.expires_at && new Date(r.expires_at).getTime() < now;
              return (
                <tr key={`${r.kind}:${r.id}:${r.user_id}`} className={TR}>
                  <td className={TD}>
                    <span className="block font-medium text-slate-800">{r.user_name || r.username}</span>
                    <span className="block text-xs text-slate-500">{r.username}</span>
                  </td>
                  <td className={TD}>
                    <span className="flex items-center gap-2">
                      {r.kind === "token" ? (
                        <KeyRound className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                      ) : (
                        <Plug className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-slate-800">{r.name || (r.kind === "token" ? "token" : "Unnamed app")}</span>
                        <span className="block text-xs text-slate-500">
                          {r.kind === "token" ? (
                            <>
                              <code className="font-mono">{r.prefix}</code> · {Array.isArray(r.scopes) && r.scopes.includes("write") ? "read + write" : "read-only"}
                            </>
                          ) : (
                            "Connected app"
                          )}{" "}
                          · since {fmt.date(r.created_at)}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className={`${TD} ${FIT} text-slate-600`}>{r.last_used_at ? <RelativeTime value={r.last_used_at} /> : "Never"}</td>
                  <td className={`${TD} ${FIT}`}>
                    {!r.expires_at ? (
                      <span className={chipClass("warn", "sm")}>No expiry</span>
                    ) : expired ? (
                      <span className={chipClass("neutral", "sm")}>Expired</span>
                    ) : (
                      <span className="text-slate-600">{fmt.date(r.expires_at)}</span>
                    )}
                  </td>
                  {canRevoke && (
                    <td className={`${TD} ${FIT}`}>
                      {revocable(r) && <button
                        type="button"
                        onClick={() => void revoke(r)}
                        className={iconButtonClass("quiet", "sm")}
                        data-tt="Revoke"
                        aria-label={r.kind === "token" ? `Revoke the token ${r.name} of ${r.username}` : `Disconnect ${r.name || "the app"} for ${r.username}`}
                      >
                        <Ban className="h-4 w-4" />
                      </button>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
