#!/usr/bin/env bash
set -euo pipefail

assets_dir=$1
tag="$RELEASE_TAG"
version=${tag#v}
expected=()
for arch in x64 arm64; do
  expected+=(
    "Otrion-$version-windows-$arch-setup.exe"
    "Otrion-$version-macos-$arch.zip"
    "Otrion-$version-linux-$arch.tar.gz"
    "otrion-reh-win32-$arch.tar.gz"
    "otrion-reh-darwin-$arch.tar.gz"
    "otrion-reh-linux-$arch.tar.gz"
  )
done

shopt -s nullglob dotglob
files=("$assets_dir"/*)
if [[ "${#files[@]}" != "${#expected[@]}" ]]; then
  echo "Expected ${#expected[@]} release assets, found ${#files[@]}." >&2
  exit 1
fi
for name in "${expected[@]}"; do
  if [[ ! -f "$assets_dir/$name" || ! -s "$assets_dir/$name" ]]; then
    echo "Missing or empty release asset: $name" >&2
    exit 1
  fi
done

if git show-ref --verify --quiet "refs/tags/$tag"; then
  if [[ "$(git rev-parse "refs/tags/$tag^{commit}")" != "$GITHUB_SHA" ]]; then
    echo "Tag $tag already points to another commit." >&2
    exit 1
  fi
else
  git tag "$tag" "$GITHUB_SHA"
  git push origin "refs/tags/$tag"
fi

if draft=$(gh release view "$tag" --json isDraft --jq .isDraft); then
  if [[ "$draft" != true ]]; then
    echo "$tag is already published."
    exit 0
  fi
else
  gh release create "$tag" --verify-tag --draft --title "Otrion $version" --generate-notes
fi
gh release upload "$tag" "${files[@]}" --clobber
gh release edit "$tag" --draft=false
