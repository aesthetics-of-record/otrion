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

## Remote SSH

Otrion Desktop bundles Open Remote - SSH. In the Command Palette, run `Remote-SSH: Connect to Host...` and select an SSH host or enter `user@host`. The extension reads your SSH configuration. Edit the built-in extension under `extensions/open-remote-ssh/`. Run `pnpm run gulp compile-extension:open-remote-ssh` from the repository root and reload the development window to try a change. The desktop build bundles the extension from the same sources. [Source layout and upstream revision](../../extensions/open-remote-ssh/README.md)

### Remote server for a desktop release

For first-time connections, publish an Otrion remote extension host archive for the target OS and architecture from the **same commit** as the packaged desktop client. The SSH extension reads that commit and the download URL template from the packaged client’s `product.json`. Source launches with `scripts/code.sh` can exercise the extension and host picker, but their root `product.json` has no packaged commit.

For example, on a Linux x64 build host, install the project dependencies and run these commands from the repository root:

```sh
pnpm run gulp vscode-reh-linux-x64-min
tar -czf otrion-reh-linux-x64.tar.gz -C .. vscode-reh-linux-x64
```

Attach the archive to an Otrion GitHub release tagged `ssh-<full-desktop-commit>`. Keep the top-level directory in the archive because the installer strips it when extracting. For private builds, set `remote.SSH.serverDownloadUrlTemplate` in User Settings to your own artifact endpoint. The remote installation uses `~/.otrion-server`. Open Remote - SSH keeps its default strict commit validation.

## Set up Codex and Claude Code

Open **Otrion → Preferences → Otrion Settings** on macOS or **File → Preferences → Otrion Settings** on Windows and Linux. **Editor Settings** opens the standard editor preferences and keeps the usual keyboard shortcut.

Each agent has its own **Install**, **Allow**, and **Sign In** controls. Install requires Node.js 22 or newer and npm on your PATH. Otrion downloads a versioned ACP adapter with its agent runtime to the extension’s local storage. Both agents start with chat access turned off. Enable the agents you want to use, then choose **Sign In** if you need to authenticate. The provider handles sign-in in a terminal and can reuse your existing CLI login. [OpenAI authentication](https://learn.chatgpt.com/docs/auth) · [Claude Code ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)

Otrion also detects existing adapters on your PATH. To select a specific executable, set `otrion.chat.codexAcpPath` or `otrion.chat.claudeAcpPath` in User Settings. A custom path takes precedence over an Otrion-managed install. Restore the default setting to use the managed version. On Windows, use the native executable for a custom path.

## Chat in the right sidebar

Open a trusted local folder and run `Otrion: Open Agent Chat` from the Command Palette. Choose **Codex** or **Claude Code** in the sidebar. Press Enter to send or Shift+Enter for a new line. The agent starts with the first message and uses the first workspace folder. An empty window uses a folder in Otrion Chat’s local storage.

Replies stream into the sidebar. **Stop** interrupts the current reply. **New chat**, switching agents, and reloading the window start a fresh conversation. Hiding the sidebar preserves the current conversation. Turning off an agent’s permission in Otrion Settings ends its active session. Otrion does not approve ACP tool permission requests on the user’s behalf.

## Try the Otrion Context extension

Select a few lines of code, open the Command Palette (⌘⇧P on macOS), and run `Otrion: Copy Selection with File Path`. Paste into a new document to see the file path, line range, and selected code. If you select multiple ranges, the command copies each excerpt with its own location.

## Where to add code

| Location | Purpose |
| --- | --- |
| `extensions/otrion-chat/` | The agent settings page, chat sidebar, and shared ACP client. The desktop build compiles its TypeScript sources. |
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
