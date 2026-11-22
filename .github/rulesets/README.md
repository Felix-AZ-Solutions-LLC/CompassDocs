# Branch ruleset for `main`

[`main.json`](main.json) is the ruleset for this repository's default
branch, in the JSON format GitHub's ruleset **Export** and **Import** use
(the body of the REST API's "create a repository ruleset"). GitHub does not
read it from here: an org owner imports it by hand once, and again whenever
it changes. The file is the record of what the ruleset should be.

## Importing it (5 steps)

1. On GitHub, open this repository → **Settings** → **Rules** →
   **Rulesets**.
2. **New ruleset** → **Import a ruleset**.
3. Choose `.github/rulesets/main.json` from a checkout of `main` (or
   download it from GitHub first).
4. Check what the form shows: name **Protect main**, enforcement
   **Active**, target **Default branch**, bypass list **Organization
   admin** (Always allow), and the required checks listed below.
5. **Create**. Then open a pull request and check that every required
   check reports on it (Merge box → each one green, none "Expected —
   Waiting for status to be reported").

Names are unique per repository: to change an existing **Protect main**,
edit it in place or delete it before importing again. If `main` still has a
classic branch protection rule (Settings → Branches), both apply; delete the
classic rule once the ruleset is active, so there is one place to look.

## What each rule does

| Rule | Effect |
| --- | --- |
| `deletion` | `main` can't be deleted. |
| `non_fast_forward` | No force-pushes to `main`; its history only grows. |
| `pull_request` | Changes reach `main` only through a pull request. **0** approvals are required (one maintainer can merge their own PR); stale approvals aren't dismissed on push, and code-owner review, last-push approval and resolved conversations aren't required. Merge, squash and rebase stay allowed (releases squash-merge; RELEASING.md). |
| `required_status_checks` | A PR can merge only when each check below has passed (a skipped job counts as passed) on its head commit. **Not strict**: the branch needn't be up to date with `main` first. `do_not_enforce_on_create` is off. |

**Bypass:** the **Organization admin** role (`actor_type: "OrganizationAdmin"`;
GitHub ignores `actor_id` for it and exports it as `1`), mode **Always**.
That keeps an emergency path for org owners, and it means their direct
pushes to `main` are let through too (GitHub reports the bypass, it
doesn't stop them). For the rules to apply to your own routine work, merge
through PRs anyway, or change the mode to **For pull requests only** (then
an owner can still tick "Merge without waiting for requirements" on a PR,
but can't push to `main` directly).

## Required checks

Each name is a check run's name exactly as a PR shows it, which for an
Actions job is its `name:` (or its id if it has none). `integration_id` is
unset, so a check of that name from any source counts.

| Check | From | Runs |
| --- | --- | --- |
| `e2e` | `.github/workflows/e2e.yml` | every PR |
| `Trivy scan (vulns + secrets)` | `.github/workflows/security.yml` | every PR |
| `npm audit (prod deps, high+)` | `.github/workflows/security.yml` | every PR |
| `Analyze (javascript-typescript)` | CodeQL default setup (Settings → Code security; no workflow file) | every PR to `main` |
| `Analyze (actions)` | CodeQL default setup | every PR to `main` |

Not required: **TLS smoke test** (`tls-smoke.yml`) runs only when its paths
change, and the `CodeQL` summary check is a result, not a job.

**Keep them reporting.** A required check that never reports blocks the PR
for good, so:

- don't add a `paths:` or `branches-ignore:` filter to `e2e.yml` or
  `security.yml` (security.yml lost its path filter for this reason);
- renaming one of these jobs (or switching CodeQL to an advanced-setup
  workflow with different job names) needs the ruleset changed **first**,
  in Settings, then `main.json` updated in the same PR as the rename;
- if CodeQL default setup is turned off or loses a language, remove its
  check from the ruleset.
