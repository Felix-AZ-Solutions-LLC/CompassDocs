"use client";

import { useEffect, useRef, useState } from "react";
import { Button, iconButtonClass } from "@/components/Button";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toasts";
import { SaveRow } from "@/components/SaveRow";
import { confirmDialog } from "@/components/Dialog";
import { RelativeTime } from "@/components/RelativeTime";
import { useFormatDate } from "@/components/SettingsProvider";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { TlsMode, SecureCookieMode } from "@/lib/settings";
import { Field, TextInput, Textarea } from "@/components/form";
import { Check, Clock, RefreshCw, X } from "lucide-react";
import { Spinner } from "@/components/Spinner";

interface ProxyStatus {
  managed: boolean;
  reachable: boolean;
}

/** lib/domain-check DomainCheckResult, as the page reads it. */
interface DomainCheck {
  ok: boolean;
  code: string;
  domain: string;
  addresses: string[];
  cname: string | null;
  message: string;
  checked_at: string;
}

/** lib/domain-flow PendingDomain. */
interface PendingDomain {
  domain: string;
  tls_mode: TlsMode;
  tls_email: string;
  requested_at: string;
  requested_by: { id: number | null; name: string };
  auto_until: string;
  next_check_at: string;
  attempts: number;
  last_check: DomainCheck;
  /** "verifying": switched, HTTPS being checked; the settings follow when it answers. */
  phase?: "waiting" | "verifying";
  verify?: { address: string; until: string; origin: string };
}

interface FallbackHost {
  host: string;
  source: "env" | "remembered";
  acme: boolean;
}

export interface DomainState {
  custom_domain: string;
  tls_mode: TlsMode;
  tls_email: string;
  secure_cookies: SecureCookieMode;
  has_custom_cert: boolean;
  proxy: ProxyStatus;
  pending: PendingDomain | null;
  fallbacks: FallbackHost[];
}

const TLS_OPTIONS: { value: TlsMode; label: string; hint: string }[] = [
  {
    value: "auto",
    label: "Automatic HTTPS (Let's Encrypt)",
    hint: "Free certificate, auto-renewed. The domain must be public and resolve to this server, with ports 80 and 443 reachable.",
  },
  {
    value: "internal",
    label: "Self-signed (internal CA)",
    hint: "For LAN or testing. Browsers show a warning unless you trust Caddy's local CA.",
  },
  {
    value: "custom",
    label: "Bring your own certificate",
    hint: "Paste a PEM certificate (with any chain) and private key. You're responsible for renewals.",
  },
  {
    value: "off",
    label: "Plain HTTP (terminate TLS elsewhere)",
    hint: "Serve HTTP only — use when a load balancer or Cloudflare already handles HTTPS in front of this server.",
  },
];

const COOKIE_OPTIONS: { value: SecureCookieMode; label: string; hint: string }[] = [
  {
    value: "auto",
    label: "Automatic (recommended)",
    hint: "Secure over HTTPS, not over plain HTTP — matches how each request arrives. Works whether or not you've set up TLS yet.",
  },
  {
    value: "always",
    label: "Always require HTTPS",
    hint: "Only send the session cookie over HTTPS. Choose this once your certificate is installed. Do NOT use it while still on plain HTTP — it will cause a login loop.",
  },
  {
    value: "never",
    label: "Never (plain HTTP only)",
    hint: "Never mark the cookie Secure. For deployments that will only ever be reached over plain HTTP.",
  },
];

export function DomainSettings({ initial }: { initial: DomainState }) {
  const router = useRouter();
  const fmt = useFormatDate();
  // A domain waiting for its check is what the admin asked for: the form
  // shows it, and the card under the field says why it isn't live yet.
  const [domain, setDomainRaw] = useState(initial.pending?.domain ?? initial.custom_domain);
  const [mode, setModeRaw] = useState<TlsMode>(initial.pending?.tls_mode ?? initial.tls_mode);
  const [email, setEmailRaw] = useState(initial.pending?.tls_email ?? initial.tls_email);
  const [live, setLive] = useState(initial.custom_domain);
  // The mode the live domain is served in: fallback links follow it, not the form (review L8).
  const [liveMode, setLiveMode] = useState<TlsMode>(initial.tls_mode);
  const [pending, setPending] = useState<PendingDomain | null>(initial.pending);
  const [fallbacks, setFallbacks] = useState<FallbackHost[]>(initial.fallbacks);
  const [checking, setChecking] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [cert, setCertRaw] = useState("");
  const [key, setKeyRaw] = useState("");
  const [hasCert, setHasCert] = useState(initial.has_custom_cert);
  const [secureCookies, setSecureCookiesRaw] = useState<SecureCookieMode>(initial.secure_cookies);

  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState("");

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(
    JSON.stringify([domain, mode, email, cert, key, secureCookies])
  );
  useLeaveGuard(dirty, hasUnsavedChanges);
  const setDomain = (v: string) => { markDirty(); setDomainRaw(v); };
  const setMode = (v: TlsMode) => { markDirty(); setModeRaw(v); };
  const setEmail = (v: string) => { markDirty(); setEmailRaw(v); };
  const setCert = (v: string) => { markDirty(); setCertRaw(v); };
  const setKey = (v: string) => { markDirty(); setKeyRaw(v); };
  const setSecureCookies = (v: SecureCookieMode) => { markDirty(); setSecureCookiesRaw(v); };

  const { managed, reachable } = initial.proxy;

  /** Take the server's state: what is live, what waits, the fallbacks. */
  function takeState(state: DomainState | undefined) {
    if (!state) return;
    setLive(state.custom_domain);
    setLiveMode(state.tls_mode);
    setPending(state.pending);
    setFallbacks(state.fallbacks ?? []);
    setDomainRaw(state.pending?.domain ?? state.custom_domain);
    setModeRaw(state.pending?.tls_mode ?? state.tls_mode);
    setEmailRaw(state.pending?.tls_email ?? state.tls_email);
    setHasCert(state.has_custom_cert);
    if (state.secure_cookies) setSecureCookiesRaw(state.secure_cookies);
  }

  async function save(force = false) {
    setSaving(true);
    setWarning("");
    const res = await fetch("/api/admin/domain", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        custom_domain: domain,
        tls_mode: mode,
        tls_email: email,
        secure_cookies: secureCookies,
        ...(cert || key ? { tls_cert: cert, tls_key: key } : {}),
        ...(force ? { force: true } : {}),
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return;
    }
    markClean();
    // Saved; the certificate is now stored server-side so clear the inputs.
    if (cert || key) {
      setCertRaw("");
      setKeyRaw("");
      setHasCert(true);
    }
    takeState(data?.state);
    if (data?.outcome === "verifying") {
      toast("ok", `${data.state?.pending?.domain} reaches this server. Checking HTTPS before switching for good.`);
    } else if (data?.outcome === "pending") {
      toast("error", `${data.state?.pending?.domain ?? "The domain"} isn't switched on yet. The reason is under the domain.`);
    } else if (!data.applied && data.proxyError) {
      setWarning(data.proxyError);
    } else if (data?.outcome === "applied") {
      toast("ok", `${data.state?.custom_domain} reaches this server. Domain settings saved and applied.`);
    } else if (data?.outcome === "forced") {
      toast("ok", `Switched to ${data.state?.custom_domain} without the check.`);
    } else {
      toast("ok", "Domain settings saved.");
    }
    router.refresh();
  }

  async function checkAgain() {
    setChecking(true);
    const res = await fetch("/api/admin/domain/pending", { method: "POST" });
    setChecking(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Couldn't check the domain again.");
      return;
    }
    takeState(data?.state);
    if (data.status === "applied") {
      if (data.proxyError) setWarning(data.proxyError);
      toast("ok", `${data.check?.domain} reaches this server and is live now.`);
    } else if (data.status === "verifying") {
      toast("ok", `${data.check?.domain} reaches this server. Checking HTTPS before switching for good.`);
    } else {
      toast("error", data.check?.message || "The domain still doesn't reach this server.");
    }
    router.refresh();
  }

  async function useAnyway() {
    if (!pending) return;
    const current = live || "the address you're using now";
    const ok = await confirmDialog({
      title: `Use ${pending.domain} without the check?`,
      body: (
        <>
          <p>
            The check couldn&rsquo;t confirm that {pending.domain} reaches this server. If it
            doesn&rsquo;t, {pending.domain} won&rsquo;t work and the proxy stops answering on{" "}
            {current}
            {fallbacks.length ? <> (it keeps answering on {fallbacks.map((f) => f.host).join(", ")})</> : null}.
          </p>
          <p className="mt-2">
            Use it only when something the check can&rsquo;t see is in front of this server, such as
            a load balancer or another proxy, or your DNS answers differently inside your network.
            The switch is recorded in the audit log.
          </p>
        </>
      ),
      confirmLabel: "Use it anyway",
      danger: true,
    });
    if (ok !== true) return;
    setForcing(true);
    const res = await fetch("/api/admin/domain", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        custom_domain: pending.domain,
        tls_mode: pending.tls_mode,
        tls_email: pending.tls_email,
        force: true,
      }),
    });
    setForcing(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Couldn't switch to the domain.");
      return;
    }
    markClean();
    takeState(data?.state);
    if (!data.applied && data.proxyError) setWarning(data.proxyError);
    else toast("ok", `Switched to ${data.state?.custom_domain} without the check.`);
    router.refresh();
  }

  async function keepCurrent() {
    if (!pending) return;
    const res = await fetch("/api/admin/domain/pending", { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Couldn't discard the waiting domain.");
      return;
    }
    markClean();
    takeState(data?.state);
    toast("ok", `Kept ${data.state?.custom_domain || "the current address"}. ${pending.domain} was discarded.`);
    router.refresh();
  }

  async function removeFallback(host: string) {
    // Not reversible from here when it is the address someone relies on (review M5).
    const ok = await confirmDialog({
      title: `Remove ${host}?`,
      body: (
        <p>
          CompassDocs stops answering at {host}. If {live || "the custom domain"} stops working, this
          address won&rsquo;t be a way back in. It comes back only when an administrator saves a domain
          while using it.
        </p>
      ),
      confirmLabel: "Remove address",
      danger: true,
    });
    if (ok !== true) return;
    const res = await fetch("/api/admin/domain/fallback", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || `Couldn't remove ${host}.`);
      return;
    }
    setFallbacks(data?.state?.fallbacks ?? []);
    if (data.proxyError) setWarning(data.proxyError);
    else toast("ok", `${host} no longer reaches CompassDocs.`);
    router.refresh();
  }

  const autoChecking = pending ? Date.parse(pending.auto_until) > Date.now() : false;
  const verifying = pending?.phase === "verifying";

  // While HTTPS on a switched domain is being verified, follow it here.
  const watched = useRef<string | null>(null);
  useEffect(() => {
    if (!verifying || !pending) return;
    watched.current = pending.domain;
    const timer = setInterval(async () => {
      const res = await fetch("/api/admin/domain").catch(() => null);
      if (!res?.ok) return;
      const state = (await res.json().catch(() => null)) as DomainState | null;
      if (!state || state.pending?.phase === "verifying") return;
      takeState(state);
      const name = watched.current;
      if (!state.pending && state.custom_domain === name) toast("ok", `${name} is live with HTTPS.`);
      else if (state.pending) toast("error", state.pending.last_check.message);
      router.refresh();
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifying, pending?.domain]);

  return (
    <div className="space-y-6">
      <div>
        <p className="mt-1 text-sm text-slate-500">
          Serve CompassDocs on your own domain with HTTPS. Changes are applied to the bundled
          reverse proxy immediately — no restart needed.
        </p>
      </div>

      {/* Proxy status banner */}
      {!managed ? (
        <div className="notice-warn rounded-xl border p-4 text-sm">
          <p className="font-semibold">No reverse proxy is attached to this deployment.</p>
          <p className="mt-1">
            These settings are saved but won&rsquo;t take effect until you run the HTTPS compose
            profile (<code className="font-mono">docker-compose.tls.yml</code>), which adds a Caddy
            proxy that CompassDocs configures for you.
          </p>
        </div>
      ) : reachable ? (
        <div className="notice-ok inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm">
          <Check className="h-4 w-4" aria-hidden /> Reverse proxy connected — configuration will apply live.
        </div>
      ) : (
        <div className="notice-error rounded-lg border px-3 py-2 text-sm">
          Reverse proxy is configured but not reachable right now. Saving will still store your
          settings; they&rsquo;ll apply once the proxy is back.
        </div>
      )}

      {/* Domain */}
      <div id="domain" className="scroll-mt-6 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">Custom domain</h3>
        <p className="mb-3 text-sm text-slate-500">
          Point an A/AAAA DNS record for this hostname at your server, then enter it here. Leave
          blank to serve on any hostname over plain HTTP.
          {managed && (
            <>
              {" "}
              Before switching, CompassDocs checks that the name reaches this server; until it
              does, it keeps serving the current address.
            </>
          )}
        </p>
        <div>
          <Field label="Domain" size="md">
            <TextInput
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="docs.example.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
        </div>

        {/* 1.20.29: switched, HTTPS being verified (review M3). */}
        {pending && verifying && (
          <div className="notice-info mt-4 rounded-lg border p-3 text-sm" data-testid="domain-verifying">
            <p className="flex items-center gap-2 font-semibold" role="status">
              <Spinner size="sm" />
              Switching to {pending.domain}: checking HTTPS
            </p>
            <p className="mt-1 text-xs">
              {pending.domain} reaches this server. The proxy serves it now and is getting its
              certificate, which can take up to 2 minutes; this address keeps working meanwhile. If
              HTTPS doesn&rsquo;t answer, CompassDocs goes back to {live || "the current address"} and
              says why here.
            </p>
          </div>
        )}

        {/* 1.20.29: the domain waiting for its check, with why and the ways on. */}
        {pending && !verifying && (
          <div className="notice-warn mt-4 rounded-lg border p-3 text-sm" data-testid="domain-pending">
            <p className="flex items-center gap-1.5 font-semibold">
              <Clock className="h-4 w-4 shrink-0" aria-hidden />
              {pending.domain} isn&rsquo;t switched on yet
            </p>
            <p className="mt-1" role="status">
              {pending.last_check.message}
            </p>
            <p className="mt-2 text-xs">
              Still serving {live || "every address this server is reached on"}. DNS answer:{" "}
              {pending.last_check.addresses.length ? pending.last_check.addresses.join(", ") : "none"}
              {pending.last_check.cname ? ` (CNAME ${pending.last_check.cname})` : ""}. Last checked{" "}
              <RelativeTime value={pending.last_check.checked_at} />.{" "}
              {autoChecking ? (
                <>
                  Checking again every 5 minutes until {fmt.dateTime(pending.auto_until)}; it
                  switches on by itself when it passes, and administrators get a notice.
                </>
              ) : (
                <>Automatic checks have stopped. Check again to start them for another 24 hours.</>
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" busy={checking} icon={<RefreshCw />} onClick={checkAgain}>
                Check again
              </Button>
              <Button variant="secondary" size="sm" busy={forcing} onClick={useAnyway}>
                Use it anyway
              </Button>
              <Button variant="ghost" size="sm" onClick={keepCurrent}>
                Keep {live || "the current address"}
              </Button>
            </div>
          </div>
        )}

        {/* 1.20.29: the way back in once a custom domain is live. */}
        {managed && live && fallbacks.length > 0 && (
          <div className="mt-4 text-sm" data-testid="domain-fallbacks">
            <p className="text-slate-700">Also reachable at</p>
            <ul className="mt-1 space-y-1">
              {fallbacks.map((f) => (
                <li key={f.host} className="flex min-w-0 items-center gap-2">
                  <a
                    className="link truncate font-mono text-xs"
                    href={`${liveMode === "off" ? "http" : "https"}://${f.host}/`}
                  >
                    {f.host}
                  </a>
                  {f.source === "env" ? (
                    <span className="shrink-0 text-xs text-slate-500">from COMPASSDOCS_FALLBACK_HOSTS</span>
                  ) : (
                    <>
                      <span className="shrink-0 text-xs text-slate-500">the address a domain was saved from</span>
                      <button
                        type="button"
                        className={iconButtonClass("quiet", "sm")}
                        data-tt="Remove"
                        aria-label={`Remove ${f.host} as a fallback address`}
                        onClick={() => removeFallback(f.host)}
                      >
                        <X />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-500">
              A way back in if the domain stops working. Links in email always use {live}.
            </p>
          </div>
        )}
      </div>

      {/* TLS mode */}
      <div id="tls" className="scroll-mt-6 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-3 font-semibold text-slate-900">HTTPS / TLS</h3>
        <div className="space-y-2">
          {TLS_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                mode === opt.value
                  ? "border-compass-400 bg-compass-50"
                  : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name="tls_mode"
                checked={mode === opt.value}
                onChange={() => setMode(opt.value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-slate-900">{opt.label}</span>
                <span className="block text-xs text-slate-500">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {/* Let's Encrypt email */}
        {mode === "auto" && (
          <div className="mt-4">
            <Field
              size="md"
              label={
                <>
                  Contact email <span className="text-slate-500">(optional, for renewal notices)</span>
                </>
              }
            >
              <TextInput
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
              />
            </Field>
          </div>
        )}

        {/* Bring-your-own cert */}
        {mode === "custom" && (
          <div className="mt-4 space-y-3">
            {hasCert && !cert && !key && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                A certificate is on file. Paste new PEM below to replace it, or leave blank to keep
                it.
              </p>
            )}
            <Field label="Certificate (PEM, including any chain)">
              <Textarea
                value={cert}
                onChange={(e) => setCert(e.target.value)}
                className="h-28 font-mono text-xs"
                placeholder="-----BEGIN CERTIFICATE-----&#10;…"
                spellCheck={false}
              />
            </Field>
            <Field label="Private key (PEM)">
              <Textarea
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="h-28 font-mono text-xs"
                placeholder="-----BEGIN PRIVATE KEY-----&#10;…"
                spellCheck={false}
              />
            </Field>
          </div>
        )}
      </div>

      {/* Cookie security */}
      <div id="cookies" className="scroll-mt-6 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">Session cookie security</h3>
        <p className="mb-3 text-sm text-slate-500">
          Controls when the login cookie is marked <code className="font-mono">Secure</code>.
          Browsers won&rsquo;t send a Secure cookie over plain HTTP, so leave this on{" "}
          <strong>Automatic</strong> until HTTPS is in place, then switch to{" "}
          <strong>Always require HTTPS</strong>.
        </p>
        <div className="space-y-2">
          {COOKIE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                secureCookies === opt.value
                  ? "border-compass-400 bg-compass-50"
                  : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name="secure_cookies"
                checked={secureCookies === opt.value}
                onChange={() => setSecureCookies(opt.value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-slate-900">{opt.label}</span>
                <span className="block text-xs text-slate-500">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Re-apply is a real use (the proxy lost its config), so pristine stays enabled. */}
      <SaveRow dirty={dirty} busy={saving} onSave={() => save()} label="Save & apply" allowPristine />
      {warning && (
        <div className="notice-warn rounded-lg border px-3 py-2 text-sm">
          Settings saved, but the proxy didn&rsquo;t apply them: {warning}
        </div>
      )}
    </div>
  );
}
