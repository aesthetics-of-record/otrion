#!/usr/bin/env bash
set -euo pipefail

assets_dir=$1
tag="$RELEASE_TAG"
version=${tag#v}
asset_names=$(node scripts/otrion/release-targets.mjs assets "$version")
download_table=$(node scripts/otrion/release-targets.mjs notes "$version" "$GITHUB_REPOSITORY")
expected=()
while IFS= read -r name; do
  expected+=("$name")
done <<< "$asset_names"

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
  notes=$(gh release view "$tag" --json body --jq .body)
  if [[ "$notes" != "$download_table" && "$notes" != "$download_table"$'\n'* ]]; then
    gh release edit "$tag" --notes "$download_table"$'\n\n'"$notes"
  fi
else
  gh release create "$tag" --verify-tag --draft --title "Otrion $version" --notes "$download_table" --generate-notes
fi
gh release upload "$tag" "${files[@]}" --clobber
gh release edit "$tag" --draft=false
