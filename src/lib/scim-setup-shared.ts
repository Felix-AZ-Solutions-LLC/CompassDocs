// SCIM provisioning with Microsoft Entra, set up in one click (1.20.27).
// Client-safe: the SCIM card (components/ScimPanel) renders these, the admin
// route and the settings page fill them (lib/scim), and the enterprise
// overlay's setup (ee/scim-setup) writes them.
//
// Why a setup of its own: Entra offers automatic provisioning only on an
// enterprise application made from its non-gallery application template
// ("Integrate any other application you don't find in the gallery"). An app
// made in App registrations (which is what single sign-on's own one-click
// setup made before 1.20.27, through POST /applications) shows "Out of the
// box automatic provisioning to CompassDocs is not supported today" on its
// Provisioning page, with Get started greyed out.

/** Microsoft's "non-gallery application" template: the same ID in every tenant. */
export const NON_GALLERY_TEMPLATE_ID = "8adf8e6e-67b2-4cf2-a259-e3dc5476c621";

/** The enterprise app the setup makes when there is none it can use. */
export const PROVISIONING_APP_NAME = "CompassDocs provisioning";

/** One step of the setup, in words, as the card lists them. */
export interface ScimSetupStep {
  key: "signin" | "app" | "sso_app" | "hide" | "job" | "mapping" | "secrets" | "token" | "validate" | "start";
  /** done: it happened; skipped: nothing to do, or left to the admin; warning: did not happen and need not; failed: stopped the setup. */
  status: "done" | "skipped" | "warning" | "failed";
  text: string;
}

/**
 * What the last setup with Microsoft did (the `scim_entra` setting, written
 * by the overlay). Never a secret: the token itself is only in Entra and, as
 * a hash, in `scim_token_hash`.
 */
export interface ScimEntraState {
  tenant: string;
  /** The enterprise application (service principal) provisioning runs on. */
  sp_id: string;
  app_id: string;
  display_name: string;
  job_id: string;
  /** The single sign-on app was reused (it was made from the non-gallery template). */
  reused_sso_app: boolean;
  /** The Tenant URL saved in Entra. */
  base_url: string;
  /** When the token Entra holds was made here (ISO); a later scim_token_at means Entra's copy is stale. */
  token_at: string;
  /** Microsoft's own connection test passed. */
  verified: boolean;
  /** The job was running when the setup finished. */
  started: boolean;
  /** When the setup last ran (ISO). */
  at: string;
}

/** Which kind of app single sign-on signs in through, as far as this workspace knows. */
export type SsoAppKind = "provisioning" | "sign_in_only" | "unknown" | "none";

export interface ScimStatus {
  licensed: boolean;
  enabled: boolean;
  token_set: boolean;
  last_request_at: string | null;
  base_url: string;
  /** 1.20.27: what the setup with Microsoft last did, if it ran. */
  entra: ScimEntraState | null;
  /** 1.20.27: the token was rotated here after the setup put it in Entra, so Entra's copy no longer works. */
  entra_token_stale: boolean;
  /** 1.20.27: whether the single sign-on app can also carry provisioning. */
  sso_app: SsoAppKind;
}

/** The Entra admin center page of an enterprise application. */
export function entraAppUrl(spId: string, appId: string): string {
  return `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Overview/objectId/${encodeURIComponent(spId)}/appId/${encodeURIComponent(appId)}`;
}
