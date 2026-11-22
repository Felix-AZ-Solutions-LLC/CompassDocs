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

The merge to `main` triggers `docker-publish.yml` (~8 minutes, multi-arch):
it pushes `ghcr.io/felix-az-solutions-llc/compassdocs:main-<sha>` and moves
`:latest`, then copies the same manifest to the legacy path
`ghcr.io/mattny20/compassdocs` (see [Two image addresses](#two-image-addresses)).
Its last step pulls both paths anonymously and fails if either isn't public
or the two disagree. Verify it succeeded before proceeding — everything
downstream pulls this image. Check the run under Actions, or list runs via
the API and confirm `docker-publish` for the merge commit shows
`conclusion: success`.

## 3. GitHub release (manual dispatch)

Run the **release** workflow (`release.yml`, workflow_dispatch on `main`).
Leave `version` blank to use `package.json`. It tags `vX.Y.Z`, creates the
GitHub release with notes pulled from `CHANGELOG.md`, and adds `:X.Y.Z`,
`:X.Y` and `:latest` on both image paths. If either retag fails the job goes
red after trying both; the release itself already exists, so re-run the
workflow once the cause is fixed (it refreshes the notes and retags again).
The `notes only` input refreshes an existing release's notes without
touching tags or images — use it for changelog typo fixes.

## 4. Enterprise image (manual dispatch, separate repo)

In `Felix-AZ-Solutions-LLC/compassdocs-ee`, run **build-ee.yml** with input:

```json
{ "core_ref": "vX.Y.Z" }
```

It overlays `ee/` onto that core tag and pushes the private enterprise
image. The core tag must exist first — step 3 before step 4, always.

## 5. Cloud fleet (manual, separate repo)

Cloud tenants pin their image at machine-creation time — publishing
`:latest` changes nothing on running tenants. Roll the fleet from
`Felix-AZ-Solutions-LLC/compassdocs-cloud`, either:

- Staff console (console.compassdocscloud.com) → **Upgrade fleet**, or
- CLI: `npm run cli -- upgrade --all` (rolling, health-gated, stops on
  first failure; safe to re-run — already-upgraded tenants are skipped).

See that repo's `OPERATIONS.md` §10 for details and rollback.

## Two image addresses

The repository moved from the `mattny20` account to the
`Felix-AZ-Solutions-LLC` organization. GHCR can't move packages between
accounts, and every install made before the move has
`ghcr.io/mattny20/compassdocs` in its own `docker-compose.yml` and updates
with `docker compose pull`. So the community image is published to both:

| Path | Who pulls it | Pushed with |
| --- | --- | --- |
| `ghcr.io/felix-az-solutions-llc/compassdocs` | New installs (`deploy/docker-compose*.yml`, `install.sh`) | `GITHUB_TOKEN` |
| `ghcr.io/mattny20/compassdocs` (legacy) | Installs made before the move | `LEGACY_GHCR_TOKEN` |

Both paths carry the same digest under the same tags. The enterprise image
(`ghcr.io/mattny20/compassdocs-ee`) gets the same treatment in the
`compassdocs-ee` repo's build-ee.yml; until that repo publishes to both
addresses, the `-ee` compose files keep naming the mattny20 path.

**`LEGACY_GHCR_TOKEN`** — an Actions secret (org level or on this repo)
holding a **classic** personal access token from the **`mattny20`** account
with only the **`write:packages`** scope. `GITHUB_TOKEN` can only write
packages the org owns, so this is the only way to keep the legacy path
current. If it's missing, `docker-publish` and `release` fail with an error
saying so — on purpose: skipping would silently stop updates for every
existing install. Set an expiry on the token, put a reminder in the
calendar, and renew it (same name, same scope) **before** it expires; an
expired token fails both workflows the same way.

**Make the org package public — once.** GHCR creates
`ghcr.io/felix-az-solutions-llc/compassdocs` as private on its first
publish, so the first `docker-publish` run after the move fails its
anonymous-pull check. Then: Org → Packages → compassdocs → Package settings
→ Change visibility → Public, and re-run the failed job. It stays public
after that.

**How long the legacy path stays.** Until existing installs have moved to
the new address. An in-app notice telling admins to switch is a later task;
don't stop publishing to `ghcr.io/mattny20/compassdocs` before that has
shipped and installs have had time to act on it.

## If something goes wrong

- **Checks fail on the bump PR** — fix on the branch; never merge red.
- **docker-publish fails after merge** — re-run the workflow from the
  Actions tab; nothing downstream has happened yet. If the error names
  `LEGACY_GHCR_TOKEN` or says the org package isn't public, see
  [Two image addresses](#two-image-addresses) first.
- **Released the wrong thing** — do not delete tags or force-push main.
  Ship a patch release (X.Y.Z+1) through the same chain; the fleet upgrade
  in step 5 accepts any image reference if you need to roll tenants back
  to the previous version explicitly.
- **EE build fails** — it's isolated: community users and the cloud fleet
  are unaffected. Fix and re-dispatch with the same `core_ref`.
