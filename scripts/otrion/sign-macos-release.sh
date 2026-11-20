#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ -z ${MACOS_CERTIFICATE_P12:-} && -z ${MACOS_CERTIFICATE_PASSWORD:-} ]]; then
  echo "Packaging an ad hoc build with manual ZIP updates."
  exit 0
fi
: "${MACOS_CERTIFICATE_P12:?Missing Developer ID Application certificate}"
: "${MACOS_CERTIFICATE_PASSWORD:?Missing certificate password}"
export AGENT_TEMPDIRECTORY=$(mktemp -d)
keychain="$AGENT_TEMPDIRECTORY/buildagent.keychain"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$AGENT_TEMPDIRECTORY"
}
trap cleanup EXIT
password=$(openssl rand -hex 32)
security create-keychain -p "$password" "$keychain"
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
version=$(node -p "require('./product.json').otrionVersion")
ditto -c -k --keepParent "$bundle" "$AGENT_TEMPDIRECTORY/signed.zip"
install -m 644 "$AGENT_TEMPDIRECTORY/signed.zip" "dist/v$version/Otrion-$version-macos-$VSCODE_ARCH.zip"
