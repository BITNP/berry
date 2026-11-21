#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes; commit or stash before publishing." >&2
  exit 1
fi

cli="${CONTAINER_CLI:-$(command -v podman || command -v docker)}"
version="${1:-v$(node -p 'require("./package.json").version')}"
revision="$(git rev-parse HEAD)"
short_revision="$(git rev-parse --short=12 HEAD)"
image="${BERRY_IMAGE:-git.bitnp.net/bitnp/berry}"
forgejo_remote="$(git remote get-url forgejo 2>/dev/null || printf '%s' 'ssh://git@git.bitnp.net:222/BITNP/berry.git')"

if git show-ref --verify --quiet "refs/tags/$version"; then
  tag_commit="$(git rev-list -n 1 "$version")"
  if [ "$tag_commit" != "$revision" ]; then
    echo "Tag $version already exists at $tag_commit (HEAD is $revision)." >&2
    exit 1
  fi
fi

tags=(
  "$image:$version"
  "$image:sha-$short_revision"
  "$image:latest"
)

"$cli" build \
  --platform linux/amd64 \
  --label "org.opencontainers.image.source=https://git.bitnp.net/BITNP/berry" \
  --label "org.opencontainers.image.revision=$revision" \
  --label "org.opencontainers.image.version=$version" \
  --tag "${tags[0]}" \
  --tag "${tags[1]}" \
  --tag "${tags[2]}" \
  .

git show-ref --verify --quiet "refs/tags/$version" ||
  git tag --sign --message "Release $version" "$version"

git push origin main "refs/tags/$version"
git push "$forgejo_remote" main "refs/tags/$version"

for tag in "${tags[@]}"; do
  "$cli" push "$tag"
done

printf 'Published %s (%s):\n' "$version" "$revision"
printf '  %s\n' "${tags[@]}"
printf '\nDeploy on bitnp-prod:\n'
printf "  ssh bitnp-prod 'podman pull %s && systemctl --user restart berry.service'\n" "$image:latest"
