# Otrion development guide

Otrion's `main` branch started at Microsoft's Code - OSS release tag `1.147.0`. The repository includes the upstream license and third-party notices in `LICENSE.txt` and `ThirdPartyNotices.txt`. The Otrion Context extension uses the MIT license.

## Build and run on macOS

Install Git, Xcode and its Command Line Tools, Python 3, and nvm. Run `xcode-select -p` to check which Xcode installation will build the native modules. Run the following commands from the repository root with an internet connection.

```sh
nvm install
nvm use
npm install -g "$(node -p "require('./package.json').packageManager")"
PNPM_CONFIG_FROZEN_LOCKFILE=true pnpm install --frozen-lockfile
pnpm run build-fast
env -u ELECTRON_RUN_AS_NODE ./scripts/code.sh .
```

The repository pins Node.js 24.22.1 in `.nvmrc` and pnpm 12.16.0 in the root `package.json`. If you already have the pinned version of pnpm, skip the global install. The launch command clears an environment variable that some IDE terminals set to run Electron in Node.js mode. On first launch, the script downloads Electron and additional built-in extensions.

Run `pnpm run build-fast` for incremental development builds or `pnpm run compile` for a full build with type checking. For continuous builds, run `pnpm run watch` in one terminal. Once the first build finishes, run `nvm use` and `env -u ELECTRON_RUN_AS_NODE ./scripts/code.sh .` in a second terminal. Linux uses the same shell launcher. On Windows, use `scripts\code.bat`. [Platform-specific build prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites)

## Desktop defaults

A new Otrion profile opens directly in the editor. The product disables core telemetry in development and packaged builds, turns off automatic crash reporting and experiments, and ships without the built-in Copilot Chat extension. The `defaultChatAgent.enabled` switch in `product.json` controls the bundled provider. The authentication API remains available to extensions that need a user-selected account. Third-party extensions can make their own network requests.

## Chat with Codex in the right sidebar

Otrion Chat is a built-in desktop extension. It starts a local Codex ACP adapter when you send your first message. The adapter uses your Codex credentials and sends requests to your configured model provider.

On macOS or Linux, install the adapter and Codex CLI, then sign in if you have not already done so.

```sh
npm install -g @agentclientprotocol/codex-acp @openai/codex
codex login
```

Open a trusted local folder and run `Otrion: Open Codex Chat` from the Command Palette. After rebuilding an existing checkout, run `Developer: Reload Window` first. Press Enter to send a message or Shift+Enter for a new line. Replies stream into the sidebar. Use **Stop** to interrupt a reply and **New chat** to start a fresh session. The conversation stays available when you hide and reopen the sidebar and clears on window reload.

The session starts in read-only mode in the first workspace folder. In an empty window it uses an empty folder in Otrion Chat's storage. If Otrion cannot find the adapter, set `otrion.chat.codexAcpPath` in User Settings to the absolute path printed by `command -v codex-acp`. On Windows, set it to the native adapter executable. [Codex ACP installation and releases](https://github.com/agentclientprotocol/codex-acp)

## Try the Otrion Context extension

Select a few lines of code, open the Command Palette (⌘⇧P on macOS), and run `Otrion: Copy Selection with File Path`. Paste into a new document to see the file path, line range, and selected code. If you select multiple ranges, the command copies each excerpt with its own location.

## Where to add code

| Location | Purpose |
| --- | --- |
| `extensions/otrion-chat/` | The Codex sidebar, webview, and ACP client. The desktop build compiles its TypeScript sources. |
| `extensions/otrion-context/` | A working built-in extension. Its manifest declares the command, and the extension host loads `extension.js` when the command runs. |
| `extensions/otrion-*/` | Add product features as extensions. For example, a model provider can live in its own extension, and a chat interface can use the VS Code Chat API. If an extension gains package dependencies, register it in the root `pnpm-workspace.yaml` and update the lockfile. |
| `product.json` | Configure the application name, data directories, URL scheme, and platform-specific application identifiers. |
| `src/vs/workbench/contrib/` | Add workbench UI that requires changes to the editor shell. Keep core changes in feature-specific commits so they are easier to review during upstream merges. |

The sample extension has no runtime package dependencies or separate compile step. After editing its code, run `Developer: Reload Window` in the development window to load your changes.

## Git remotes and upstream updates

To set up a new checkout, clone Otrion and add Microsoft's Code - OSS repository as `upstream`. Git names the Otrion remote `origin` automatically.

```sh
git clone https://github.com/aesthetics-of-record/otrion.git
cd otrion
git remote add -t main upstream https://github.com/microsoft/vscode.git
```

To merge a new upstream release, start with a clean working tree. Replace the baseline tag below with the release you want to merge.

```sh
tag=1.147.0
git switch main
git fetch upstream tag "$tag"
git switch -c "sync/vscode-$tag"
git merge --no-ff "$tag"
```

If conflicts arise, preserve Otrion's product identifiers and incorporate new upstream settings. Stage the resolved files with `git add` and finish the merge with `git merge --continue`. Repeat the build steps with the Node.js and pnpm versions pinned by the new release. Launch Otrion and check the context command before updating the baseline version in the README and this guide and merging the sync branch into `main`.

To review upstream development between releases, run `git fetch upstream main` followed by `git log --oneline HEAD..upstream/main`.
