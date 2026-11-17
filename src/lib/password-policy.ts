// One password minimum everywhere (STYLEGUIDE §Forms): setup, the forced
// first-login change, Account → Security, and admin resets all used to
// disagree (8 vs 6). Pure, so client forms and API routes share it.
//
// 1.20.27 (security review M7): 12, the ASVS 2.1.1 floor. It applies to a
// password as it is set or changed; an existing account's password keeps
// working until its owner changes it (sign-in never checks the length).

export const PASSWORD_MIN = 12;

/** The longest password accepted: long passphrases are welcome, a megabyte of text is not hashed. */
export const PASSWORD_MAX = 256;

export const PASSWORD_HELP = `At least ${PASSWORD_MIN} characters.`;

/** The reason a password is refused, or undefined when it is acceptable. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return undefined;
}
