// Settings → Sign-in security (1.20.27): the pure part, shared by the page,
// its API route and lib/sign-in-security. No server imports.

/**
 * "Require two-step sign-in" (security review H3). Who must have an
 * authenticator app (TOTP) when they sign in with a password. Off by
 * default. Each step includes the one before it.
 */
export type TwoStepScope = "off" | "admins" | "admins_agents" | "everyone";
export const TWO_STEP_SCOPES: TwoStepScope[] = ["off", "admins", "admins_agents", "everyone"];

export const TWO_STEP_LABEL: Record<TwoStepScope, string> = {
  off: "Nobody",
  admins: "Administrators",
  admins_agents: "Administrators and desk agents",
  everyone: "Everyone",
};

export const TWO_STEP_HELP: Record<TwoStepScope, string> = {
  off: "Two-step sign-in stays optional: each person can turn it on under Account → Security.",
  admins: "People who can administer users or workspace settings.",
  admins_agents: "Administrators, and anyone who works the desk or reads its reports.",
  everyone: "Every account that signs in with a password.",
};

export function asTwoStepScope(v: unknown): TwoStepScope {
  return TWO_STEP_SCOPES.includes(v as TwoStepScope) ? (v as TwoStepScope) : "off";
}

/**
 * Absolute session lifetime (security review M8): a session ends this many
 * days after it was opened, however active it is. The idle timeout still
 * applies within it.
 */
export const SESSION_MAX_DAYS_DEFAULT = 30;
export const SESSION_MAX_DAYS_MIN = 1;
export const SESSION_MAX_DAYS_MAX = 90;

export function clampSessionMaxDays(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return SESSION_MAX_DAYS_DEFAULT;
  return Math.min(SESSION_MAX_DAYS_MAX, Math.max(SESSION_MAX_DAYS_MIN, n));
}

/** The settings keys (one place, so the route and the reader cannot disagree). */
export const SIGN_IN_SECURITY_KEYS = {
  twoStep: "require_two_step",
  sessionMaxDays: "session_max_days",
  breakGlass: "sso_break_glass_user_ids",
} as const;

/** The break-glass list from its stored form: positive integers, no repeats, at most 20. */
export function parseBreakGlass(raw: string | null | undefined): number[] {
  try {
    const v = JSON.parse(raw || "[]");
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, BREAK_GLASS_MAX);
  } catch {
    return [];
  }
}

export const BREAK_GLASS_MAX = 20;

/** Why a session may not be used yet (lib/auth CurrentSession.pending). */
export type PendingStep = "password_change" | "two_step";

/** The `code` on the 403 an API answers while a step is owed (lib/api-auth). */
export const PENDING_CODE: Record<PendingStep, string> = {
  password_change: "password_change_required",
  two_step: "two_step_required",
};

export const PENDING_ERROR: Record<PendingStep, string> = {
  password_change: "Set a new password first.",
  two_step: "Set up two-step sign-in first.",
};
