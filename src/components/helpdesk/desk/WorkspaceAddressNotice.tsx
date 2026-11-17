"use client";

// 1.20.27 (STYLEGUIDE §Notices, "A workspace with no address"): links in
// desk and portal mail are built only from the workspace's configured
// address (lib/workspace-origin: the custom domain under Settings → Domain &
// HTTPS, or COMPASSDOCS_BASE_URL), never from whatever Host a request
// carried. With none set, desk emails go out without working links and the
// customer portal sends no sign-in links, so an admin is told, in one wording,
// in four places:
//   - Setup: the checklist's first step (AddressStep);
//   - Settings → Email and Customer portal: a notice (WorkspaceAddressNotice;
//     `notice-error` on the portal while it is on);
//   - anywhere in the desk, for desk admins: a dismissible strip under the
//     top bar (WorkspaceAddressBanner), gone for that browser once dismissed.
// The link to Domain & HTTPS is a link only for whoever can open it.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Globe, TriangleAlert, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { useCanOpenSettings } from "@/components/SettingsLink";

export const DOMAIN_SETTINGS_HREF = "/admin/domain";

/** "Set it under Settings → Domain & HTTPS, or with COMPASSDOCS_BASE_URL on the server." */
function WhereToSet({ canSet }: { canSet: boolean }) {
  const env = <code className="font-mono text-xs">COMPASSDOCS_BASE_URL</code>;
  return canSet ? (
    <>
      Set it under{" "}
      <Link href={DOMAIN_SETTINGS_HREF} className="link font-medium">
        Settings → Domain &amp; HTTPS
      </Link>
      , or with {env} on the server.
    </>
  ) : (
    <>A CompassDocs administrator sets it under Settings → Domain &amp; HTTPS, or with {env} on the server.</>
  );
}

/** The notice on Settings → Email and Customer portal. Renders nothing while an address is set. */
export function WorkspaceAddressNotice({
  address,
  portalOn,
  portal = false,
  className = "",
}: {
  /** The configured address, null when none, undefined while unknown (renders nothing). */
  address: string | null | undefined;
  /** On the portal page: the portal is switched on, so it cannot sign anyone in (notice-error). */
  portalOn?: boolean;
  portal?: boolean;
  className?: string;
}) {
  const canSet = useCanOpenSettings(DOMAIN_SETTINGS_HREF);
  if (address !== null) return null;
  const lead = portal
    ? portalOn
      ? "Customers can't sign in: the portal sends no sign-in links until your workspace has an address."
      : "The portal won't send sign-in links until your workspace has an address."
    : "Desk emails have no working links until your workspace has an address.";
  return (
    <div
      role="note"
      data-testid="workspace-address-notice"
      className={`${portal && portalOn ? "notice-error" : "notice-warn"} flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${className}`.trim()}
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{lead}</p>
        <p className="mt-1">
          Links in desk and portal mail are built only from it, never from the address someone happened to use, so replies, alerts and
          surveys arrive without a working link{portal ? "" : " and the customer portal can't send sign-in links"}.{" "}
          <WhereToSet canSet={canSet} />
        </p>
      </div>
    </div>
  );
}

/** Setup's first step: the workspace address (done once one is configured). */
export function AddressStep({ address }: { address: string | null }) {
  const canSet = useCanOpenSettings(DOMAIN_SETTINGS_HREF);
  const done = !!address;
  return (
    <li className="flex flex-wrap items-start gap-4 p-5 sm:flex-nowrap" data-testid="setup-address-step">
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
          done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
        }`}
        aria-hidden
      >
        {done ? <Check className="h-4.5 w-4.5" /> : <Globe className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold text-slate-900">
          1. Workspace address
          <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
        </h2>
        {done ? (
          <p className="mt-0.5 text-sm text-slate-600">Links in desk and portal mail point here.</p>
        ) : (
          <p className="mt-0.5 text-sm text-slate-600">
            Desk emails have no working links, and the customer portal can&apos;t send sign-in links, until your workspace has an address:
            mail links are built only from it. <WhereToSet canSet={canSet} />
          </p>
        )}
        {done && (
          <p className="mt-1.5 inline-flex items-center gap-1 text-xs ink-ok">
            <Check className="h-3.5 w-3.5" aria-hidden /> {address}
          </p>
        )}
      </div>
      {canSet && (
        <Button href={DOMAIN_SETTINGS_HREF} variant="secondary" aria-label={`${done ? "Edit" : "Set up"} workspace address`}>
          {done ? "Edit" : "Set up"}
        </Button>
      )}
    </li>
  );
}

const dismissKey = (userId: number) => `compass-desk-address-banner-dismissed:${userId}`;

/**
 * The desk-wide strip for desk admins while no address is configured.
 * Dismissed per person in this browser (a per-viewer convenience); the
 * setup step and the settings notices keep saying it.
 */
export function WorkspaceAddressBanner({ userId, canSet }: { userId: number; canSet: boolean }) {
  // Hidden until the browser has said whether it was dismissed, so it never flashes.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(dismissKey(userId)) === "1";
    } catch {
      /* storage blocked: show it */
    }
    setShown(!dismissed);
  }, [userId]);
  if (!shown) return null;
  return (
    <div role="note" data-testid="workspace-address-banner" className="notice-warn flex shrink-0 items-start gap-2 border-b px-4 py-2 text-sm print:hidden">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <b className="font-semibold">Desk emails have no working links.</b> Your workspace has no address, and mail links are built only
        from it, so the customer portal can&apos;t send sign-in links either. <WhereToSet canSet={canSet} />
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.setItem(dismissKey(userId), "1");
          } catch {
            /* storage blocked: gone for this page only */
          }
          setShown(false);
        }}
        aria-label="Dismiss the workspace address warning"
        data-tt="Dismiss"
        className={`${iconButtonClass("quiet", "sm")} -my-1 -mr-1 shrink-0`}
      >
        <X aria-hidden />
      </button>
    </div>
  );
}
