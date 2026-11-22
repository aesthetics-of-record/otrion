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

if [[ "$notarize" == false && -z ${MACOS_CERTIFICATE_P12:-} && -z ${MACOS_CERTIFICATE_PASSWORD:-} ]]; then
  echo "Packaging an ad hoc build with manual ZIP updates."
  exit 0
fi
: "${MACOS_CERTIFICATE_P12:?Missing Developer ID Application certificate}"
: "${MACOS_CERTIFICATE_PASSWORD:?Missing certificate password}"
export AGENT_TEMPDIRECTORY=$(mktemp -d)
keychain="$AGENT_TEMPDIRECTORY/buildagent.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$AGENT_TEMPDIRECTORY"
}
trap cleanup EXIT
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
export CODESIGN_IDENTITY=$(security find-identity -v -p codesigning "$keychain" | awk '/"Developer ID Application:/ { print $2; exit }')
: "${CODESIGN_IDENTITY:?No Developer ID Application signing identity}"
unset MACOS_CERTIFICATE_P12 MACOS_CERTIFICATE_PASSWORD
export VSCODE_ARCH=$(node -p 'process.arch')
bundle="../VSCode-darwin-$VSCODE_ARCH/Otrion.app"
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const product = JSON.parse(fs.readFileSync(file));
  product.otrionMacSignedUpdates = true;
  fs.writeFileSync(file, JSON.stringify(product, null, "\t"));
' "$bundle/Contents/Resources/app/product.json"
node build/darwin/sign.ts ..
codesign --verify --strict --deep "$bundle"

if [[ "$notarize" == true ]]; then
  key_path="$AGENT_TEMPDIRECTORY/AuthKey.p8"
  submission_zip="$AGENT_TEMPDIRECTORY/notary.zip"
  submission_result="$AGENT_TEMPDIRECTORY/notary-result.json"
  (umask 077; printf '%s\n' "$APPLE_NOTARY_KEY_P8" > "$key_path")
  unset APPLE_NOTARY_KEY_P8
  notary_args=(--key "$key_path" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")

  ditto -c -k --keepParent "$bundle" "$submission_zip"
  if ! xcrun notarytool submit "$submission_zip" "${notary_args[@]}" --wait --output-format json > "$submission_result" ||
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
  xcrun stapler staple "$bundle"
  xcrun stapler validate "$bundle"
fi

version=$(node -p "require('./product.json').otrionVersion")
ditto -c -k --keepParent "$bundle" "$AGENT_TEMPDIRECTORY/signed.zip"
install -m 644 "$AGENT_TEMPDIRECTORY/signed.zip" "dist/v$version/Otrion-$version-macos-$VSCODE_ARCH.zip"
