# Shared by the workflow steps that write the pre-move image path
# ($LEGACY_IMAGE, ghcr.io/mattny20/...) and check both paths. Source it from a
# step that runs under `bash -eo pipefail` (the workflows set
# `defaults: run: shell: bash`).
#
# The steps provide: REGISTRY, IMAGE (the org path), LEGACY_IMAGE, LEGACY_USER,
# GITHUB_ACTOR, GITHUB_TOKEN, LEGACY_GHCR_TOKEN, RUNNER_TEMP, and RERUN (what
# to do once an error is fixed, appended to each error).
#
# Moving to the org: RELEASING.md in Felix-AZ-Solutions-LLC/CompassDocs.

# The environment holding LEGACY_GHCR_TOKEN. Core's is "ghcr-legacy";
# compassdocs-ee's copy of this file names its own ("CompassDocs legacy image
# publishing"). Environment secrets don't move with a rename.
LEGACY_ENV_NAME="ghcr-legacy"
# Until release B points installs at $IMAGE, nobody pulls it, so a private
# org package is only a warning (the org may not allow public packages yet).
# Release B sets this to true: from then on installs depend on it.
ORG_PUBLIC_REQUIRED=false
# The only scopes LEGACY_GHCR_TOKEN may have. write:packages brings
# read:packages, and GitHub's classic-token page now forces repo on with it
# (it can't be unticked, even from a ?scopes=write:packages link), so repo is
# accepted, with a warning on every run. Anything else (admin:org,
# delete:packages, workflow, ...) is refused.
LEGACY_ALLOWED_SCOPES="write:packages read:packages repo"

# org_login: logs GITHUB_TOKEN (reads and writes the org path) into its own
# auth file, SRC_AUTH. A trap removes every auth file these functions write
# when the step exits, however it exits.
org_login() {
  command -v skopeo >/dev/null || { sudo apt-get update -q && sudo apt-get install -y -q skopeo; }
  SRC_AUTH="$RUNNER_TEMP/ghcr-src-auth.json"
  DST_AUTH="$RUNNER_TEMP/ghcr-legacy-auth.json"
  trap 'rm -f "$SRC_AUTH" "$DST_AUTH" "$RUNNER_TEMP/legacy-token-headers.txt"' EXIT
  if ! printf '%s' "$GITHUB_TOKEN" | skopeo login --authfile "$SRC_AUTH" -u "$GITHUB_ACTOR" --password-stdin "$REGISTRY"; then
    echo "::error title=GITHUB_TOKEN login failed::Couldn't log in to $REGISTRY with this run's GITHUB_TOKEN. $RERUN"
    return 1
  fi
}

# legacy_login: checks LEGACY_GHCR_TOKEN is there, accepted and scoped to
# packages only, after org_login; the legacy token (writes the legacy path)
# goes into its own auth file, DST_AUTH.
legacy_login() {
  if [ -z "${LEGACY_GHCR_TOKEN:-}" ]; then
    echo "::error title=LEGACY_GHCR_TOKEN secret is missing::Installs pull $LEGACY_IMAGE and won't get this build. Add LEGACY_GHCR_TOKEN to this repo's \"$LEGACY_ENV_NAME\" environment: a classic personal access token from the $LEGACY_USER account with only the write:packages scope (RELEASING.md). $RERUN"
    return 1
  fi
  org_login
  local headers="$RUNNER_TEMP/legacy-token-headers.txt"
  if ! printf '%s' "$LEGACY_GHCR_TOKEN" | skopeo login --authfile "$DST_AUTH" -u "$LEGACY_USER" --password-stdin "$REGISTRY"; then
    echo "::error title=LEGACY_GHCR_TOKEN was refused::$REGISTRY refused the $LEGACY_USER token (expired or revoked?). Make a new classic token from $LEGACY_USER with only write:packages and replace LEGACY_GHCR_TOKEN in the \"$LEGACY_ENV_NAME\" environment (RELEASING.md). $RERUN"
    return 1
  fi

  # Only write:packages (with the read:packages and repo GitHub ties to it)
  # is allowed; see LEGACY_ALLOWED_SCOPES.
  local code scopes s
  local -a list extra=()
  code=$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' \
    -H "Authorization: token $LEGACY_GHCR_TOKEN" https://api.github.com/user) || code=000
  if [ "$code" != 200 ]; then
    rm -f "$headers"
    echo "::error title=Couldn't check LEGACY_GHCR_TOKEN's scopes::api.github.com answered $code. $RERUN"
    return 1
  fi
  scopes=$(tr -d '\r' < "$headers" | sed -n 's/^x-oauth-scopes: *//Ip')
  rm -f "$headers"
  echo "LEGACY_GHCR_TOKEN scopes: ${scopes:-none}"
  read -ra list <<< "${scopes//,/ }"
  for s in "${list[@]}"; do
    case " $LEGACY_ALLOWED_SCOPES " in
      *" $s "*) ;;
      *) extra+=("$s") ;;
    esac
  done
  if [ "${#extra[@]}" -gt 0 ]; then
    echo "::error title=LEGACY_GHCR_TOKEN has scopes it mustn't have::Remove ${extra[*]}. Signed in as $LEGACY_USER, open https://github.com/settings/tokens, edit this token, untick everything but write:packages (GitHub keeps repo ticked with it; that's expected) and save. The token value doesn't change, so the secret needn't be updated. $RERUN"
    return 1
  fi
  case " ${list[*]} " in
    *" repo "*)
      echo "::warning title=LEGACY_GHCR_TOKEN carries the repo scope::GitHub ties repo to write:packages on classic tokens, so this token can also change every repository $LEGACY_USER can reach. It is only exposed to main's publishing jobs (environment $LEGACY_ENV_NAME). RELEASING.md describes moving it to a bot account that has no repositories."
      ;;
  esac
  case " ${list[*]} " in
    *" write:packages "*) ;;
    *)
      echo "::error title=LEGACY_GHCR_TOKEN lacks write:packages::Signed in as $LEGACY_USER, open https://github.com/settings/tokens, edit this token, tick write:packages and save. $RERUN"
      return 1
      ;;
  esac
}

# legacy_copy <from-ref> <to-ref>: copies an image (every platform, same
# digest) with the auth files legacy_login made.
legacy_copy() {
  echo "Copying $1 -> $2"
  if ! skopeo copy --all --preserve-digests --retry-times 3 \
      --src-authfile "$SRC_AUTH" --dest-authfile "$DST_AUTH" \
      "docker://$1" "docker://$2"; then
    echo "::error title=Copy to ${2%:*} failed::Couldn't copy $1 to $2 (see the log above). $RERUN"
    return 1
  fi
}

# org_copy <from-ref> <to-ref>: the same, within the org path (needs only
# org_login).
org_copy() {
  echo "Copying $1 -> $2"
  if ! skopeo copy --all --preserve-digests --retry-times 3 \
      --src-authfile "$SRC_AUTH" --dest-authfile "$SRC_AUTH" \
      "docker://$1" "docker://$2"; then
    echo "::error title=Copy to ${2%:*} failed::Couldn't copy $1 to $2 (see the log above). $RERUN"
    return 1
  fi
}

# registry_digest <authfile> <ref>: prints the digest of the manifest as the
# registry serves it (sha256:...), or fails if it can't be read.
registry_digest() {
  local raw="$RUNNER_TEMP/manifest.raw"
  if ! skopeo inspect --raw --authfile "$1" "docker://$2" > "$raw" 2>/dev/null; then
    rm -f "$raw"
    return 1
  fi
  echo "sha256:$(sha256sum < "$raw" | cut -d' ' -f1)"
  rm -f "$raw"
}

# main_head: prints the commit main points at now (40 hex digits), from the
# GitHub API (needs GH_TOKEN), or fails after three tries. gh prints the API's
# error JSON on stdout even with --jq, so the answer must look like a sha.
main_head() {
  local out attempt
  for attempt in 1 2 3; do
    out=$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha 2>/dev/null) || out=""
    if [[ $out =~ ^[0-9a-f]{40}$ ]]; then
      echo "$out"
      return 0
    fi
    echo "Attempt $attempt to read the head of main failed${out:+: $out}" >&2
    if [ "$attempt" -lt 3 ]; then sleep 5; fi
  done
  return 1
}

# anon_manifest <registry/owner/name> <tag> -> "<http code> <digest>", as an
# anonymous client would see it.
anon_manifest() {
  local repo="${1#"$REGISTRY"/}" token code digest
  token=$(curl -fsS "https://$REGISTRY/token?scope=repository:$repo:pull" | jq -r '.token // empty') || true
  if [ -z "$token" ]; then echo "no-token -"; return 0; fi
  read -r code digest < <(curl -sS -o /dev/null -I \
    -w '%{http_code} %header{docker-content-digest}\n' \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://$REGISTRY/v2/$repo/manifests/$2") || true
  echo "${code:-000} ${digest:--}"
}

# check_public_pull <tag>...: every tag must pull anonymously from IMAGE and
# (when it differs) LEGACY_IMAGE, with the same digest at both. Fills DIGESTS
# ["<path>:<tag>"]. Returns 1 after printing an error for each problem.
declare -A DIGESTS
check_public_pull() {
  local path t code digest bad fail=0 a b
  local -a paths=("$IMAGE")
  if [ "$LEGACY_IMAGE" != "$IMAGE" ]; then paths+=("$LEGACY_IMAGE"); fi
  for path in "${paths[@]}"; do
    bad=""
    for t in "$@"; do
      read -r code digest < <(anon_manifest "$path" "$t") || true
      echo "$path:$t -> $code $digest"
      if [ "$code" = 200 ]; then DIGESTS["$path:$t"]="$digest"; else bad="$bad $t($code)"; fi
    done
    if [ -z "$bad" ]; then continue; fi
    if [ "$path" = "$IMAGE" ] && [ "$ORG_PUBLIC_REQUIRED" != true ]; then
      echo "::warning title=$IMAGE is not public yet::Anonymous pull failed for:$bad. Nothing pulls it until release B; before then, make the package public (Org settings → Packages → allow Public; then Org → Packages → ${IMAGE##*/} → Package settings → Change visibility → Public)."
      continue
    fi
    fail=1
    if [ "$path" = "$IMAGE" ]; then
      echo "::error title=$IMAGE is not public::Anonymous pull failed for:$bad. Make the package public once (Org → Packages → ${IMAGE##*/} → Package settings → Change visibility → Public). $RERUN"
    else
      echo "::error title=$path is missing this build::Anonymous pull failed for:$bad. Installs won't get it; see the copy step above. $RERUN"
    fi
  done
  if [ "${#paths[@]}" -gt 1 ]; then
    for t in "$@"; do
      a="${DIGESTS["$IMAGE:$t"]:-}" b="${DIGESTS["$LEGACY_IMAGE:$t"]:-}"
      if [ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ]; then
        echo "::error title=Digests differ for tag $t::$IMAGE:$t is $a but $LEGACY_IMAGE:$t is $b. $RERUN"
        fail=1
      fi
    done
  fi
  return "$fail"
}
