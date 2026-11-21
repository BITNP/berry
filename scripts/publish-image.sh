#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

cli="${CONTAINER_CLI:-$(command -v podman || command -v docker)}"
revision="$(git rev-parse HEAD)"
short_revision="$(git rev-parse --short=12 HEAD)"
image="${BERRY_IMAGE:-git.bitnp.net/bitnp/berry}"
extra_tag="${1:-}"

tags=(
  "$image:sha-$short_revision"
  "$image:latest"
)
if [ -n "$extra_tag" ]; then
  tags+=("$image:$extra_tag")
fi

build_args=(
  --platform linux/amd64
  --label "org.opencontainers.image.source=https://github.com/BITNP/berry"
  --label "org.opencontainers.image.revision=$revision"
)
for tag in "${tags[@]}"; do
  build_args+=(--tag "$tag")
done

"$cli" build "${build_args[@]}" .

for tag in "${tags[@]}"; do
  "$cli" push "$tag"
done

printf 'Published %s:\n' "$revision"
printf '  %s\n' "${tags[@]}"
