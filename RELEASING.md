# Releasing CompassDocs

The end-to-end chain for shipping a release: core image → GitHub release →
enterprise image → cloud fleet. Follow it in order; each stage depends on the
one before it.

## 0. Preconditions

- `main` is green (e2e, security, tls-smoke workflows).
- `CHANGELOG.md` has an entry for the new version at the top.
- **License-key guard** — the pinned Ed25519 public key in
  `src/lib/license.ts` must be intact and appear exactly once:

  ```bash
  grep -c "MCowBQYDK2VwAyEA3zj2D3VLyIij/SovtpZWwY1xFrX8F6n876GPISVnxE0=" src/lib/license.ts
  # must print: 1
  ```

  If it prints anything else, stop — every deployed instance verifies
  licenses against this key, and a changed key would silently invalidate
  all issued licenses (or worse, accept someone else's).

## 1. Version bump PR

1. Bump the version in **both** `package.json` and `package-lock.json`
   (the lockfile carries it twice: top-level and under `packages.""`).
2. Add/finalize the `CHANGELOG.md` entry.
3. Open a PR from a working branch. Wait for checks to finish (~9 minutes;
   don't merge early — the e2e suite is the slow one).
4. **Squash-merge** with the title format the changelog automation expects:

   ```
   X.Y.Z: one-line summary (#NNN)
   ```

5. After merging, reset your working branch to `origin/main` before any
   further work — the squash means your local branch history and main have
   diverged.

## 2. Community image (automatic)

The merge to `main` triggers `docker-publish.yml` (~8 minutes, multi-arch).
It never builds version tags; release.yml adds those (step 3). Two jobs
follow the builds:

- **Merge manifest & push main-<sha>** pushes
  `ghcr.io/felix-az-solutions-llc/compassdocs:main-<sha>`, copies it to
  `ghcr.io/mattny20/compassdocs:main-<sha>`, the path installs pull (see
  [Moving to the org](#moving-to-the-org)), and pulls both anonymously: it
  fails if either isn't public, the tag is missing, or the two digests
  differ. It has no concurrency group, so it's never cancelled while
  waiting; runs for different commits write different tags.
- **Move :latest to main's head** then reads the commit `main` is at *now*
  and, if that commit's `main-<sha>` is at both paths with one digest,
  points `:latest` at both to it and checks them. It copies the head, not
  necessarily its own build, because merge jobs can finish in any order:
  whichever of these jobs runs last leaves both paths on the head. If the
  head's `main-<sha>` isn't at both paths yet (its merge job is still
  running, or failed), it changes nothing and says so; the head's own run
  moves `:latest` when its merge job is done. These jobs run one at a time
  (`ghcr-latest` group, no cancel-in-progress), so a pair of copies is
  never interrupted halfway. GitHub keeps only the newest waiting one and
  cancels older waiting ones; that's harmless, as each copies the head
  anyway. A cancelled **Move :latest** is normal after quick successive
  pushes.

Verify the merge job succeeded before proceeding — the release (step 3)
tags its `main-<sha>`. Check the run under Actions, or list the run's jobs
via the API and confirm **Merge manifest & push main-<sha>** for the merge
commit shows `conclusion: success` (the run as a whole can show
`cancelled` because of its **Move :latest** job).

Re-running either job is safe at any time: the merge job only (re)writes
its own `main-<sha>`, and **Move :latest** points `:latest` at whatever
`main`'s head build is then. The per-arch digests the merge job
needs are kept for 14 days, so "Re-run failed jobs" works for that long;
after that, push again (or dispatch docker-publish on `main`) instead.

## 3. GitHub release (manual dispatch)

Run the **release** workflow (`release.yml`, workflow_dispatch on `main`).
Leave `version` blank to use `package.json`. It tags `vX.Y.Z`, creates the
GitHub release with notes pulled from `CHANGELOG.md`, and adds `:X.Y.Z` on
both image paths to the build of the commit `vX.Y.Z` points at
(`main-<first 7 of its sha>`), plus `:X.Y` while `vX.Y.Z` is the newest
`X.Y.*` release. It never touches `:latest`: docker-publish moves that to
each new head of `main`, which for a release is the version bump's build.

If either retag fails, the job goes red after trying both; the release
itself already exists. Fix the cause and dispatch a new run of release.yml
(or re-run the failed one). Either is safe at any time: it refreshes the
notes and adds only `:X.Y.Z` (and `:X.Y` if no newer `X.Y.*` exists) to the
same build. Release runs share the `release` concurrency group with each
other only. The `notes only` input refreshes an existing release's notes
without touching tags or images — use it for changelog typo fixes. Those
runs don't queue, and they fail if the release doesn't exist yet rather
than create it.

## 4. Enterprise image (manual dispatch, separate repo)

In `Felix-AZ-Solutions-LLC/compassdocs-ee`, run **build-ee.yml** with input:

```json
{ "core_ref": "vX.Y.Z" }
```

It overlays `ee/` onto that core tag and pushes the enterprise image to
public GHCR packages (its features unlock only with a license key). The
core tag must exist first — step 3 before step 4, always.

## 5. Cloud fleet (manual, separate repo)

Cloud tenants pin their image at machine-creation time — publishing
`:latest` changes nothing on running tenants. Roll the fleet from
`Felix-AZ-Solutions-LLC/compassdocs-cloud`, either:

- Staff console (console.compassdocscloud.com) → **Upgrade fleet**, or
- CLI: `npm run cli -- upgrade --all` (rolling, health-gated, stops on
  first failure; safe to re-run — already-upgraded tenants are skipped).

See that repo's `OPERATIONS.md` §10 for details and rollback.

## Moving to the org

All the CompassDocs repositories moved from the `mattny20` account to the
`Felix-AZ-Solutions-LLC` organization (core, compassdocs-ee, -cloud,
-licensing, -trust, -site, -docs). GitHub redirects the old repository
names, so old links, `raw.githubusercontent.com` URLs and the admin
console's update check (GitHub API) keep working.

> **Never create a repository named `mattny20/CompassDocs` or
> `mattny20/compassdocs-ee`** (or any other moved repo's old name). A new
> repo at an old name replaces GitHub's redirect: installs' update checks
> and the raw URLs that `install.sh` and the Azure template fetch would hit
> the new, empty repo instead.

GHCR can't move packages between accounts, and every install has
`ghcr.io/mattny20/compassdocs` (or `…/compassdocs-ee`) in its own
`docker-compose.yml` and updates with `docker compose pull`. So the move
happens in two releases:

**Release A (1.20.39): publish to both paths, change nothing for installs.**
docker-publish and release push every tag to the org path with
`GITHUB_TOKEN` and copy it to the legacy path with skopeo (same digest):

| Path | Who pulls it | Written with |
| --- | --- | --- |
| `ghcr.io/mattny20/compassdocs` (legacy) | Every install, for now | `LEGACY_GHCR_TOKEN` (environment "CompassDocs legacy image publishing") |
| `ghcr.io/felix-az-solutions-llc/compassdocs` | Nobody yet; installs from release B | `GITHUB_TOKEN` |

compassdocs-ee's build-ee.yml does the same for
`ghcr.io/mattny20/compassdocs-ee` and
`ghcr.io/felix-az-solutions-llc/compassdocs-ee`.

After release A's first docker-publish run, in this order:

1. **Make the org package public — once.** GHCR creates the org package as
   private on its first publish, so that run fails its anonymous-pull
   check. Org → Packages → compassdocs → Package settings → Change
   visibility → Public. Then re-run the failed job (safe at any time, see
   [step 2](#2-community-image-automatic)), or let the next push to `main`
   check again. Same for `compassdocs-ee` after its first build.
2. **Run the backfill — once.** Actions → **Backfill org image path**
   (`ghcr-backfill.yml`) → Run workflow. It copies every tag that exists
   only at `ghcr.io/mattny20/compassdocs` (older versions, `main-<sha>`
   builds) to the org path, skips tags already there with the same digest,
   leaves alone any tag already there with a different digest (the org
   path is newer) and checks every copied tag pulls anonymously. Leave the
   tag filter blank for everything, or pass a regex (e.g. `^[0-9]` for
   version tags only). Safe to re-run. compassdocs-ee has the same
   workflow for its image.

**Release B (later): switch installs.** `deploy/docker-compose*.yml` (and
so `install.sh`, which downloads them) name the org path; existing installs
move when they re-run the installer or follow an in-app notice. Only after
step 1 and 2 above, so every tag an install might pin exists at the new
address. The legacy path keeps getting every release until installs have
moved; don't stop publishing there before the in-app notice has shipped
and installs have had time to act on it.

### The legacy-publishing environment and LEGACY_GHCR_TOKEN

`LEGACY_GHCR_TOKEN` is a **classic** personal access token from the
**`mattny20`** account with only the **`write:packages`** scope.
`GITHUB_TOKEN` can only write packages the org owns, so it's the only way
to keep the legacy path current. It lives in a GitHub **Environment**
named **`CompassDocs legacy image publishing`**, not as a repo or org
secret, so only the jobs that need it (docker-publish's merge and
**Move :latest** jobs, release; build-ee's legacy job) can read it, and only
from `main`.
The workflows name the environment exactly; renaming it means updating
them (and, since an environment's secrets don't move with it, adding the
token again).

**Making the token.** Signed in as `mattny20`, open
<https://github.com/settings/tokens/new?scopes=write:packages&description=CompassDocs%20legacy%20image%20publishing>.
It preselects `write:packages` (which brings `read:packages` with it). Make
sure **nothing else is ticked**, `repo` above all: it would give the secret
full access to every `mattny20` repository. Every job that uses the token
checks its scopes first and fails, naming the extra scopes, unless they are
only `write:packages` and `read:packages`; to fix that, edit the token at
<https://github.com/settings/tokens>, untick the rest and save. The token
value doesn't change, so the secret needn't be updated.

**The environment**, in **each** of `Felix-AZ-Solutions-LLC/CompassDocs` and
`Felix-AZ-Solutions-LLC/compassdocs-ee`:

1. Settings → Environments → **New environment** → name it
   `CompassDocs legacy image publishing`. Create it before the first run: a
   job naming an environment that doesn't exist creates it with no rules.
2. Deployment branches and tags → **Selected branches and tags** → add the
   branch rule `main`. (A `v*` tag rule, if you added one earlier, is no
   longer needed: no job that uses the token runs on a tag.) No required
   reviewers, no wait timer.
3. Environment secrets → **Add secret** → `LEGACY_GHCR_TOKEN` → the token.

Each run of those jobs shows up as a deployment to that environment on the
repo's page; that's expected. If the secret is missing, ghcr.io refuses it
(expired, revoked) or it has any scope beyond `write:packages`/`read:packages`,
the job fails and says so —
on purpose: skipping would silently stop updates for every install. Set an
expiry on the token, put a reminder in the calendar, and renew it (same
name, same scope, in both repos' environments) **before** it expires.

## If something goes wrong

- **Checks fail on the bump PR** — fix on the branch; never merge red.
- **docker-publish fails after merge** — fix the cause, then re-run the
  failed job (within 14 days; see [step 2](#2-community-image-automatic)).
  That's safe even after newer pushes: only **Move :latest** touches
  `:latest`, and it always points it at `main`'s current head build. Nothing
  downstream has happened yet. If the error names `LEGACY_GHCR_TOKEN` or
  says the org package isn't public, see
  [Moving to the org](#moving-to-the-org) first.
- **Released the wrong thing** — do not delete tags or force-push main.
  Ship a patch release (X.Y.Z+1) through the same chain; the fleet upgrade
  in step 5 accepts any image reference if you need to roll tenants back
  to the previous version explicitly.
- **EE build fails** — it's isolated: community users and the cloud fleet
  are unaffected. Fix and re-dispatch with the same `core_ref`.
