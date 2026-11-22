#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

notarize=false
if [[ ${REQUIRE_MACOS_NOTARIZATION:-false} == true || -n ${APPLE_NOTARY_KEY_P8:-} || -n ${APPLE_NOTARY_KEY_ID:-} || -n ${APPLE_NOTARY_ISSUER_ID:-} ]]; then
  : "${APPLE_NOTARY_KEY_P8:?Missing App Store Connect team API private key}"
  : "${APPLE_NOTARY_KEY_ID:?Missing App Store Connect API key ID}"
  : "${APPLE_NOTARY_ISSUER_ID:?Missing App Store Connect API issuer ID}"
  notarize=true
fi

sign=false
if [[ "$notarize" == true || -n ${MACOS_CERTIFICATE_P12:-} || -n ${MACOS_CERTIFICATE_PASSWORD:-} ]]; then
  : "${MACOS_CERTIFICATE_P12:?Missing Developer ID Application certificate}"
  : "${MACOS_CERTIFICATE_PASSWORD:?Missing certificate password}"
  sign=true
fi

VSCODE_ARCH=$(node -p 'process.arch')
export VSCODE_ARCH
version=$(node -p "require('./product.json').otrionVersion")
bundle="../VSCode-darwin-$VSCODE_ARCH/Otrion.app"
output="dist/v$version/Otrion-$version-macos-$VSCODE_ARCH"
AGENT_TEMPDIRECTORY=$(mktemp -d)
export AGENT_TEMPDIRECTORY
keychain="$AGENT_TEMPDIRECTORY/buildagent.keychain-db"
dmg="$AGENT_TEMPDIRECTORY/Otrion.dmg"
cleanup() {
  if [[ -e "$keychain" ]]; then
    security delete-keychain "$keychain" >/dev/null 2>&1 || true
  fi
  rm -rf "$AGENT_TEMPDIRECTORY"
}
trap cleanup EXIT

create_dmg() {
  local contents="$AGENT_TEMPDIRECTORY/dmg-contents"
  mkdir "$contents"
  ditto "$bundle" "$contents/Otrion.app"
  ln -s /Applications "$contents/Applications"
  hdiutil create -srcfolder "$contents" -volname Otrion -fs HFS+ -format UDZO "$dmg"
}

if [[ "$sign" == false ]]; then
  echo "Packaging an ad hoc build with manual ZIP updates."
  create_dmg
  install -m 644 "$dmg" "$output.dmg"
  exit 0
fi
password=$(openssl rand -hex 32)
keychains=("$keychain")
while IFS= read -r entry; do
  keychains+=("$entry")
done < <(security list-keychains -d user | sed -E 's/^[[:space:]]*"//;s/"[[:space:]]*$//')
security create-keychain -p "$password" "$keychain"
security list-keychains -d user -s "${keychains[@]}"
export OTRION_SIGNING_KEYCHAIN="$keychain"
security unlock-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
(umask 077; printf '%s' "$MACOS_CERTIFICATE_P12" | base64 -D > "$AGENT_TEMPDIRECTORY/cert.p12")
security import "$AGENT_TEMPDIRECTORY/cert.p12" -k "$keychain" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
CODESIGN_IDENTITY=$(security find-identity -v -p codesigning "$keychain" | awk '/"Developer ID Application:/ { print $2; exit }')
if [[ -z "$CODESIGN_IDENTITY" ]]; then
  echo 'No Developer ID Application signing identity found.' >&2
  exit 1
fi
export CODESIGN_IDENTITY
unset MACOS_CERTIFICATE_P12 MACOS_CERTIFICATE_PASSWORD
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const product = JSON.parse(fs.readFileSync(file));
  product.otrionMacSignedUpdates = true;
  fs.writeFileSync(file, JSON.stringify(product, null, "\t"));
' "$bundle/Contents/Resources/app/product.json"
node build/darwin/sign.ts ..
codesign --verify --strict --deep "$bundle"
create_dmg
codesign --sign "$CODESIGN_IDENTITY" --keychain "$keychain" --identifier org.otrion.ide.dmg --timestamp "$dmg"
codesign --verify --strict "$dmg"

if [[ "$notarize" == true ]]; then
  key_path="$AGENT_TEMPDIRECTORY/AuthKey.p8"
  submission_result="$AGENT_TEMPDIRECTORY/notary-result.json"
  (umask 077; printf '%s\n' "$APPLE_NOTARY_KEY_P8" > "$key_path")
  unset APPLE_NOTARY_KEY_P8
  notary_args=(--key "$key_path" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")

  # Apple issues tickets for the disk image and the app it contains.
  if ! xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait --output-format json > "$submission_result" ||
     ! node -e 'process.exitCode = require(process.argv[1]).status === "Accepted" ? 0 : 1' "$submission_result"; then
    echo 'Apple notarization failed.' >&2
    cat "$submission_result" >&2
    submission_id=$(node -p 'require(process.argv[1]).id || ""' "$submission_result" 2>/dev/null) || submission_id=
    if [[ -n "$submission_id" ]]; then
      xcrun notarytool log "$submission_id" "${notary_args[@]}" >&2 || true
    fi
    exit 1
  fi
  cat "$submission_result"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  xcrun stapler staple "$bundle"
  xcrun stapler validate "$bundle"
fi

ditto -c -k --keepParent "$bundle" "$AGENT_TEMPDIRECTORY/signed.zip"
install -m 644 "$AGENT_TEMPDIRECTORY/signed.zip" "$output.zip"
install -m 644 "$dmg" "$output.dmg"
