#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

platform=$(node -p 'process.platform')
arch=$(node -p 'process.arch')
version=$(node -p "require('./product.json').otrionVersion")
export BUILD_SOURCEVERSION=$(git rev-parse HEAD)
out="dist/v$version"
mkdir -p "$out"

verify_product() {
  node -e '
    const assert = require("node:assert/strict");
    const config = require(process.argv[1]);
    const source = require("./product.json");
    assert.equal(config.commit, process.env.BUILD_SOURCEVERSION);
    assert.equal(config.version, require("./package.json").version);
    assert.equal(config.otrionVersion, source.otrionVersion);
    assert.equal(config.serverDownloadUrlTemplate, "https://github.com/aesthetics-of-record/otrion/releases/download/v${otrionVersion}/otrion-reh-${os}-${arch}.tar.gz");
  ' "$1"
}

pnpm exec tsc -p extensions/otrion-chat
pnpm exec tsc -p extensions/otrion-dev-containers
pnpm exec tsc -p extensions/otrion-remote-ssh
node --test extensions/otrion-dev-containers/test/host.test.cjs
pnpm run gulp "vscode-$platform-$arch-min"
app="../VSCode-$platform-$arch"
resources="$app/resources/app"
if [[ "$platform" == darwin ]]; then
  resources="$app/Otrion.app/Contents/Resources/app"
fi
test -f "$resources/extensions/otrion-dev-containers/dist/extension.js"
test -f "$resources/extensions/otrion-dev-containers/resources/start-server.sh"
node "$resources/node_modules.asar.unpacked/@devcontainers/cli/devcontainer.js" --version
case "$platform" in
  darwin)
    verify_product "$app/Otrion.app/Contents/Resources/app/product.json"
    codesign --force --deep --sign - "$app/Otrion.app"
    codesign --verify --deep --strict "$app/Otrion.app"
    ditto -c -k --keepParent "$app/Otrion.app" "$out/Otrion-$version-macos-$arch.zip"
    ;;
  win32)
    verify_product "$app/resources/app/product.json"
    pnpm run gulp "vscode-win32-$arch-inno-updater"
    pnpm run gulp "vscode-win32-$arch-user-setup"
    cp ".build/win32-$arch/user-setup/VSCodeSetup.exe" "$out/Otrion-$version-windows-$arch-setup.exe"
    ;;
  linux)
    verify_product "$app/resources/app/product.json"
    bash scripts/otrion/package-linux.sh "$app" "$version" "$out/Otrion-$version-linux-$arch.tar.gz"
    ;;
esac

server="vscode-reh-$platform-$arch"
pnpm run gulp "${server}-min"
verify_product "../$server/product.json"
if [[ "$platform" == win32 ]]; then
  test -f "../$server/bin/otrion-server.cmd"
  runtime="../$server/node.exe"
else
  test -x "../$server/bin/otrion-server"
  runtime="../$server/node"
fi
test "$("$runtime" -p 'process.platform + "-" + process.arch')" = "$platform-$arch"
"$runtime" "../$server/node_modules/@devcontainers/cli/devcontainer.js" --version
OTRION_CHAT_TEST_EXTENSION="../$server/extensions/otrion-chat" "$runtime" --test extensions/otrion-chat/test/remoteChat.test.cjs
tar -czf "$out/otrion-reh-$platform-$arch.tar.gz" -C .. "$server"
