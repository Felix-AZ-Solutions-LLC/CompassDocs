"use client";

// The SCIM card's "Set up provisioning with Microsoft" (1.20.27; the work is
// the enterprise overlay's, ee/scim-setup, through MsDeviceSetup). One
// sign-in as an Entra admin finds or makes an enterprise app Entra can
// provision, saves the Tenant URL and a new secret token in it, has
// Microsoft test the connection and, when ticked, starts provisioning.
// Choosing who is provisioned stays in Entra (Users and groups).
//
// What it says, because admins arrive here from Entra's own banner: an app
// made in App registrations (single sign-on's one-click setup before
// 1.20.27, or by hand) shows "Out of the box automatic provisioning to
// CompassDocs is not supported today", and Entra provisions only apps made
// from its non-gallery template. So for a setup made before 1.20.27,
// sign-on and provisioning are two apps.

import { useState, type ReactNode } from "react";
import { CircleCheck, CircleMinus, CircleX, ExternalLink, TriangleAlert } from "lucide-react";
import { MsDeviceSetup } from "@/components/MsDeviceSetup";
import { confirmDialog } from "@/components/Dialog";
import { SubHeading } from "@/components/Heading";
import { useFormatDate } from "@/components/SettingsProvider";
import { PROVISIONING_APP_NAME, entraAppUrl, type ScimSetupStep, type ScimStatus } from "@/lib/scim-setup-shared";

const STEP_ICON: Record<ScimSetupStep["status"], { icon: typeof CircleCheck; className: string; label: string }> = {
  done: { icon: CircleCheck, className: "text-emerald-600", label: "Done" },
  skipped: { icon: CircleMinus, className: "text-slate-500", label: "Not needed" },
  warning: { icon: TriangleAlert, className: "ink-warn", label: "Warning" },
  failed: { icon: CircleX, className: "text-red-600", label: "Failed" },
};

/** Each step of the setup, in words. */
function SetupSteps({ steps }: { steps: ScimSetupStep[] }) {
  if (!steps.length) return null;
  return (
    <ol className="mt-2 space-y-1.5 text-sm text-slate-700" aria-label="What the setup did">
      {steps.map((s, i) => {
        const look = STEP_ICON[s.status];
        const Icon = look.icon;
        return (
          <li key={`${s.key}-${i}`} className="flex items-start gap-2">
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${look.className}`} aria-hidden />
            <span>
              <span className="sr-only">{look.label}: </span>
              {s.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function EntraLink({ spId, appId, children }: { spId: string; appId: string; children: ReactNode }) {
  return (
    <a href={entraAppUrl(spId, appId)} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1 font-medium">
      {children}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

export function ScimMicrosoftSetup({ status, onState }: { status: ScimStatus; onState: (s: ScimStatus) => void }) {
  const fmt = useFormatDate();
  const [startNow, setStartNow] = useState(false);
  const entra = status.entra;

  const refresh = async () => {
    const r = await fetch("/api/admin/scim");
    if (r.ok) onState(await r.json());
  };

  return (
    <div className="border-t border-slate-100 pt-4">
      {/* The card's own title is an h2: the outline goes on at h3, the size stays the sub-heading tier. */}
      <SubHeading as="h3">Set up provisioning with Microsoft</SubHeading>
      <p className="mb-3 text-xs text-slate-500">
        Sign in once as a Microsoft Entra admin. CompassDocs finds or makes an enterprise app that Entra can
        provision, saves this Tenant URL and a new secret token in it, and has Microsoft test the connection.
        You then choose who is provisioned in Entra, under the app&rsquo;s <strong>Users and groups</strong>.
      </p>

      {entra && (
        <p className="mb-3 text-sm text-slate-600">
          Last run {fmt.dateTime(entra.at)}, on the Entra app{" "}
          <EntraLink spId={entra.sp_id} appId={entra.app_id}>
            {entra.display_name}
          </EntraLink>
          {entra.reused_sso_app ? " (your single sign-on app)" : ""}.{" "}
          {entra.verified ? "Microsoft's connection test passed" : "Microsoft's connection test did not pass"}
          {entra.started ? " and provisioning is running." : "; provisioning was not started."}
          {entra.base_url !== status.base_url && (
            <>
              {" "}
              Entra calls <code className="font-mono text-xs">{entra.base_url}</code> (this workspace&rsquo;s public address).
            </>
          )}
        </p>
      )}
      {status.entra_token_stale && (
        <div className="notice-warn mb-3 rounded-lg border px-3 py-2 text-sm">
          The secret token was rotated here after the setup saved its own in Entra, so Entra&rsquo;s copy no longer
          works. Run the setup again, or paste the new token into Entra.
        </div>
      )}

      <MsDeviceSetup
        startUrl="/api/ee/scim/setup/start"
        pollUrl="/api/ee/scim/setup/poll"
        refreshUrl="/api/admin/scim"
        label="Set up provisioning with Microsoft"
        blurb={
          status.token_set
            ? "Makes a new secret token: the current one stops working the moment Entra has the new one."
            : "Nothing to copy by hand. You can run it again; it finds the same app instead of making another."
        }
        beforeStart={async () =>
          !status.token_set ||
          (await confirmDialog({
            title: "Rotate the secret token?",
            body: `The setup puts a new secret token in Entra, and the current one stops working here. If you set up provisioning by hand in another Entra app, that app stops provisioning: turn its provisioning off once this is done.`,
            confirmLabel: "Rotate and set up",
            danger: true,
          })) === true
        }
        startBody={() => ({ start: startNow, rotate: true })}
        doneMessage={(r) =>
          r.started
            ? `Done. Provisioning runs on "${r.display_name}".`
            : `Done. "${r.display_name}" is ready; provisioning is not started yet.`
        }
        details={(r, failed) => (
          <div className="mt-2">
            <SetupSteps steps={Array.isArray(r?.steps) ? r.steps : []} />
            {failed && r?.token_rotated === false && (
              <p className="mt-2 text-xs text-slate-500">The current secret token was not changed and still works.</p>
            )}
            {!failed && r?.sp_id && (
              <p className="mt-2 text-sm text-slate-600">
                Next, in Entra:{" "}
                <EntraLink spId={r.sp_id} appId={r.app_id}>
                  open {r.display_name}
                </EntraLink>
                , then under <strong>Users and groups</strong> add the people or groups to provision
                {r.started ? "." : ", and under Provisioning choose Start provisioning."}
              </p>
            )}
          </div>
        )}
        onDone={(state) => onState(state)}
        onError={() => void refresh()}
      >
        <label className="mt-3 flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" className="mt-0.5" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
          <span>
            Start provisioning now
            <span className="block text-xs text-slate-500">
              Unticked, everything is set up and tested, and you start it in Entra once you have chosen who is provisioned.
            </span>
          </span>
        </label>
      </MsDeviceSetup>

      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer font-medium text-slate-600">
          Entra says &ldquo;Out of the box automatic provisioning to CompassDocs is not supported today&rdquo;
        </summary>
        <div className="mt-2 space-y-2">
          <p>
            Entra shows that, with <strong>Get started</strong> grayed out, on the Provisioning page of an app made
            in App registrations. Entra provisions only apps made from its non-gallery template (&ldquo;Integrate any
            other application you don&rsquo;t find in the gallery&rdquo;), which is the kind this setup finds or makes.
          </p>
          <p>
            {status.sso_app === "provisioning"
              ? "Your single sign-on app was made that way (single sign-on set up with Microsoft from 1.20.27), so sign-on and provisioning share one app."
              : `Single sign-on set up with Microsoft before 1.20.27 (or by hand in App registrations) made an app Entra can't provision, so sign-on and provisioning are two apps: your sign-on app and "${PROVISIONING_APP_NAME}". Both are fine to keep; people sign in through the first.`}
          </p>
        </div>
      </details>
    </div>
  );
}
