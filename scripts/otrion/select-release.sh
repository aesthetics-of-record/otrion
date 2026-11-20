#!/usr/bin/env bash
set -euo pipefail

version=$(node -p "require('./product.json').otrionVersion")
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "otrionVersion must be a stable version such as 0.1.1." >&2
  exit 1
fi

tag="v$version"
build=true
publish=false
case "${GITHUB_EVENT_NAME}:${GITHUB_REF}" in
  push:refs/heads/main)
    previous=$(git show "$BEFORE:product.json" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).otrionVersion')
    if [[ "$previous" == "$version" ]]; then
      build=false
    else
      publish=true
    fi
    ;;
  push:refs/tags/*)
    if [[ "$GITHUB_REF" != "refs/tags/$tag" ]]; then
      echo "Pushed tag must match the product version ($tag)." >&2
      exit 1
    fi
    ;;
  workflow_dispatch:*)
    if [[ "${PUBLISH_REQUESTED:-false}" == true ]]; then
      if [[ "$GITHUB_REF" != refs/heads/main ]]; then
        echo "Publishing is available from main." >&2
        exit 1
      fi
      publish=true
    fi
    ;;
esac

matrix=$(node scripts/otrion/release-targets.mjs matrix "$version")
printf 'build=%s\npublish=%s\ntag=%s\nmatrix=%s\n' "$build" "$publish" "$tag" "$matrix" >> "$GITHUB_OUTPUT"
