#!/usr/bin/env bash
set -euo pipefail

app=$1
version=$2
archive=$3
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="$stage/Otrion"
payload="$root/.otrion-versions/$version"
mkdir -p "$payload"
cp -a "$app/." "$payload"
ln -s ".otrion-versions/$version" "$root/current"
for entry in "$payload"/*; do
  name=${entry##*/}
  ln -s "current/$name" "$root/$name"
done
# Portable data lives outside the version that owns the running executable.
ln -s ../../data "$payload/data"
tar -czf "$archive" -C "$stage" Otrion
