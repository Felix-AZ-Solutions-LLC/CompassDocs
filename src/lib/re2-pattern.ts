// Why the linear-time pattern engine (re2js) refuses a pattern, in one
// sentence a person can act on. Shared by the helpdesk automation rules
// (lib/helpdesk/automation-body-shared) and the directory mapping engine
// (lib/directory-mapping), so both say the same thing. Client-safe.

const UNSUPPORTED = /\(\?<?[=!]|\\[1-9]/;

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

/**
 * `The pattern "…" can't be used: <why>`, without a closing period, for the
 * error re2js threw compiling `pattern`. Lookarounds and backreferences are
 * named plainly; anything else gives the engine's own reason.
 */
export function re2Refusal(pattern: string, e: unknown): string {
  const why = String(e instanceof Error ? e.message : e)
    .replace(/^error parsing regexp:\s*/i, "")
    .replace(/:\s*`[\s\S]*`$/, "")
    .trim();
  return UNSUPPORTED.test(pattern)
    ? `The pattern "${short(pattern)}" can't be used: lookarounds and backreferences aren't supported`
    : `The pattern "${short(pattern)}" can't be used: ${why || "it isn't a valid regular expression"}`;
}
