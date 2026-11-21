# Otrion development guide

Otrion's `main` branch started at Microsoft's Code - OSS release tag `1.147.0`. The repository includes the upstream license and third-party notices in `LICENSE.txt` and `ThirdPartyNotices.txt`.

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

On the first desktop launch, Otrion starts in Otrion Dark and opens a theme guide with screenshots of the editor. Select any theme card to apply it immediately. Switch between cards to compare themes, then select **Done** to close the guide. Later launches open directly in the editor. To reopen the guide, run **Otrion: Open Theme Guide** from the Command Palette. Use **Preferences: Color Theme** to change the selection later. The product disables core telemetry in development and packaged builds, turns off automatic crash reporting and experiments, and ships without the built-in Copilot Chat extension. The `defaultChatAgent.enabled` switch in `product.json` controls the bundled provider. The authentication API remains available to extensions that need a user-selected account. Third-party extensions can make their own network requests.

## Release packages

Update the version in a PR and merge to `main` to start the automatic release. [Release guide](release.md)

For a local build, run `bash scripts/otrion/package-release.sh` after installing dependencies on the target OS and CPU. The script writes packages under `dist/v<version>/`. Each target produces a desktop package and a Remote SSH server archive named `otrion-reh-<os>-<arch>.tar.gz`. The release version is tracked separately from the VS Code extension API version.

## Desktop updates

Packaged Otrion builds with the updater check GitHub Releases for a newer stable Otrion version. Open **Check for Updates** from the settings menu or Command Palette. Use `update.mode` in Editor Settings to control automatic checks.

| Installation | How updates are applied |
| --- | --- |
| Windows x64 user setup | Otrion verifies the installer and offers **Restart to Update**. Run the app as the installing user. |
| macOS Intel and Apple Silicon | Developer ID builds use Electron’s native updater and offer **Restart to Update**. Install the signed app in Applications. Ad hoc builds open the matching release ZIP for manual replacement. |
| Linux x64 and ARM64 | Extract the entire release archive into a writable directory and launch `Otrion/otrion`. Otrion verifies the SHA-256 digest and prepares the next version. **Restart to Update** switches the `current` link and reopens the app. Read-only, older flat, and administrator-managed sandbox installations open the release download. |

Install the first updater-enabled release from GitHub. Source runs through `scripts/code.sh` use the same Otrion display name and a separate development profile. Test the update flow with packaged builds. [GitHub Releases](https://github.com/aesthetics-of-record/otrion/releases)

On Linux, older payloads stay under `.otrion-versions/` so other running instances can finish using them. After closing all instances, you can remove unused versions. Keep the directory referenced by `current`. Portable user data lives in `Otrion/data/`.

## Remote SSH

Otrion Desktop bundles Otrion Remote SSH. In the Command Palette, run `Otrion Remote SSH: Connect to Host...` and select an SSH host or enter `user@host`. The extension reads your SSH configuration. Edit the built-in extension under `extensions/otrion-remote-ssh/`. Run `pnpm run gulp compile-extension:otrion-remote-ssh` from the repository root and reload the development window to try a change. The desktop build bundles the extension from the same sources. [Source layout and upstream revision](../../extensions/otrion-remote-ssh/README.md)

### Remote server for a desktop release

For first-time connections, publish an Otrion remote extension host archive for the target OS and architecture from the **same commit** as the packaged desktop client. The SSH extension reads that commit and the download URL template from the packaged client’s `product.json`. Source launches use the local Git release tag matching `otrionVersion` to identify the published server.

For example, on a Linux x64 build host, install the project dependencies and run these commands from the repository root:

```sh
pnpm run gulp vscode-reh-linux-x64-min
tar -czf otrion-reh-linux-x64.tar.gz -C .. vscode-reh-linux-x64
```

The release workflow attaches these archives to the matching GitHub Release. Keep the top-level directory in manually built archives because the installer strips it when extracting. For private builds, set `otrion.ssh.serverDownloadUrlTemplate` in User Settings to your own artifact endpoint. The remote installation uses `~/.otrion-server`. Otrion Remote SSH keeps its default strict commit validation.

## Dev Containers

Open a trusted project with a `.devcontainer/devcontainer.json` or `.devcontainer.json` file. Choose **Reopen in Container** in the notification, the remote status menu, or the Command Palette. You can start from a local folder or a folder already open through Otrion Remote SSH.

In **Remote Explorer**, use the selector beside the title to switch between **SSH (Otrion)** and **Dev Containers (Otrion)**. The container view lists containers on the current Docker host, including stopped ones. Hover over a row to open it or start it, or right-click to open it in a new window. Otrion reuses a known project folder and asks which folder to open on first attach. Use the refresh button after changing containers outside the editor.

Docker must be running on the machine that holds the project. For a Compose project, install the Docker Compose plugin on that machine as well. Windows Docker hosts must use Linux containers. The desktop includes the Dev Container CLI. On first connection, the Docker host downloads the matching Otrion server for the container architecture. Use a glibc-based Linux x64 or ARM64 image such as Debian or Ubuntu.

The editor opens the mounted project. Terminals, workspace extensions, and Otrion Chat agents run in the container. Use **Otrion Settings → Agents** there to configure an agent for that environment. Use **Reopen on Host** to return to the original folder, **Rebuild and Reopen in Container** after changing the configuration, or **Attach to Running Container** to choose an existing container and folder.

Edit the built-in integration in `extensions/otrion-dev-containers/`. Run `pnpm run gulp compile-extension:otrion-dev-containers compile-extension:otrion-remote-ssh` and reload the development window to try a change.

## Set up ACP agents

Open **Otrion → Preferences → Otrion Settings** on macOS or **File → Preferences → Otrion Settings** on Windows and Linux. **Editor Settings** opens the standard editor preferences and keeps the usual keyboard shortcut.

In **Agents**, find an agent by name or npm package. Choose **Install** to download the pinned release on the current host, then **Enable** to make it available in chat. If the CLI is already on your PATH, choose **Enable** directly. Local npm installations use Node.js and npm on your PATH. Use Node.js 24 LTS for the widest compatibility across the catalog. Some providers distribute native components for specific operating systems and CPU architectures. The **…** menu includes the provider’s setup guide and the option to disable an agent. [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)

Antigravity installs directly from Google’s platform releases for macOS, Linux and Windows on x64 and arm64. Otrion verifies the download against the release’s SHA-512 digest before enabling it. Grok Build installs the native binary shipped with `@xai-official/grok`. OpenCode V2 installs from `@opencode/cli`. [Antigravity installation](https://antigravity.google/docs/getting-started?tab=cli) · [Grok installation](https://docs.x.ai/build/overview) · [OpenCode ACP](https://opencode.ai/docs/cli/acp/)

Use **Sign in** for the provider’s CLI account or one of its advertised ACP authentication methods. Grok offers device-code login on remote hosts. **API key** is available for Antigravity, Claude Code, Cline, Codex, Cursor and Grok Build. Otrion stores the key in SecretStorage for that agent and host. Other agents use their own CLI or provider setup. OpenCode and Kilo report saved OAuth accounts separately from other configured provider credentials. Qwen Code directs you to `/doctor` when its ACP check cannot confirm account status. Antigravity starts a dedicated Gemini provider profile with `GEMINI_API_KEY`. Grok uses a dedicated profile with `XAI_API_KEY`. Select **CLI account** to use the provider’s regular host configuration again. [Antigravity authentication](https://antigravity.google/docs/install?tab=cli) · [Grok authentication](https://docs.x.ai/build/enterprise)

Cursor and Goose install from the platform archives listed in the ACP registry. Otrion verifies their SHA-256 digests before extracting them. Cursor supports browser login and Cursor user API keys. Goose opens its provider configuration wizard. Its Windows build supports x64. Pi installs both the ACP adapter and the Pi CLI in the managed directory and uses Pi’s `/login` for provider setup. The pinned Pi runtime requires Node.js 22.19 or later. [Cursor authentication](https://cursor.com/docs/cli/reference/authentication) · [Goose](https://block.github.io/goose/) · [Pi ACP](https://github.com/svkozak/pi-acp)

Otrion checks publisher release metadata for installed, Otrion-managed agents after chat activation and hourly. **Agents** shows the installed and available versions. Choose **Update** to download that release, or use **… → Check for updates** to refresh the listing. The installer checks the staged adapter’s ACP handshake before selecting it for new sessions. Previous version directories stay available to running sessions. External CLI installations use their original installer for updates. Pi checks its adapter and runtime independently.

To override an executable, set `otrion.chat.agentPaths` in User Settings, for example `{ "antigravity": "/opt/bin/agy" }`. Codex and Claude Code use their existing `otrion.chat.codexAcpPath` and `otrion.chat.claudeAcpPath` settings. A custom executable takes precedence over the managed installation. On Windows, Otrion can launch a native executable, the standard npm installation, or an absolute path to a Node.js entry point.

In a Remote SSH window, Otrion runs agents on the connected Windows, macOS, or Linux host. In the SSH window, open **Otrion Settings → Agents** and choose **Install**, then **Enable**. The connected Otrion server supplies Node.js and a private npm CLI. It downloads the selected adapter and keeps the npm cache in the remote user’s Otrion agent storage. The SSH account needs write access there and network access to its npm registry. Use the remote user settings for custom executable paths. Codex **Sign in** uses device-code authentication in SSH windows. [Codex authentication on headless hosts](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)

## Chat in the right sidebar

Open a trusted local folder and run `Otrion: Open Agent Chat` from the Command Palette. Choose **New Session** (+) in the title bar, then select an enabled agent. Opening a new chat connects to the enabled agent and loads its current mode and model into the composer. Open the model menu to choose a model, reasoning level or Fast mode from the options the agent advertises for this session. Select the mode button to change the session mode. Changing models refreshes the available options. Select the context ring to see the workspace and the most recent token usage reported by the agent. Press Enter to send or Shift+Enter for a new line. The session uses the first workspace folder. An empty window uses a folder in Otrion Chat’s local storage.

When a workspace opens, the chat sidebar starts on its home screen. Previously open tabs with unsent drafts remain available and reconnect when selected. The home screen shows up to five recent conversations and a **New chat** button. Select a conversation to resume it, or choose an agent to start a new one.

Drop local files or folders from Explorer or your desktop file manager onto an open chat to insert context at the composer caret. The file picker and `@` search also insert inline references. Edit text around each reference, or use Backspace to remove it. Otrion sends text and ACP resource links in their displayed order. Type `@` in the composer to search files and folders, or enter a directory prefix such as `@src/`. At the start of a message, type `/` to see the active agent’s commands and the composer actions for files, folders, modes, and models. Use the arrow keys and Enter or Tab to pick an item. Agent commands go into the draft so you can add arguments before sending.

In **Otrion Settings → Agents**, choose **CLI account** to use the local CLI’s existing credentials and provider configuration, or **API key** (when offered) to use a provider key. Enter the key in the masked prompt. Otrion stores it in SecretStorage. Switching back to the CLI keeps the saved key available for later. Use **Remove key** to delete it. A running reply finishes with its original credentials, and the next connection uses the new selection.

New sessions restore the last used mode, model, reasoning level, and Fast mode for that agent when the adapter still offers those values. Reopening a conversation loads its own session settings.

The chat renders streamed Markdown with syntax-highlighted code blocks, tables, task lists, and links. Use **Copy** to copy a code block or select a file link such as `src/main.ts#L12` to open that line in the editor.

The transcript shows the reasoning summaries, plans, and tool activity each adapter reports. Each activity starts as a single collapsed row. Click it or focus it and press Enter to inspect the command, inputs, results, and file changes the adapter provides. A running command updates in place as output arrives. Reopening a conversation from **Session History** renders the activity included in the adapter’s replay.

The send button becomes **Stop response** while the agent is working. Use **New Session** (+) in the sidebar title bar to open additional agent tabs. Each tab has its own ACP connection. Scroll across the tab strip with the mouse wheel or trackpad. Drag a session tab into an editor group to continue the same conversation there, including its draft and any running reply. Right-click a sidebar tab for close actions. **Close Saved** closes sidebar sessions with no unsent draft or running reply. Closing a tab ends its connection. In a trusted local workspace, **Session History** lists conversations from each allowed agent, including sessions started outside Otrion that the adapter exposes. Search by title, agent, or working directory. Opening a result loads its transcript and continues the original agent session in its recorded directory. Turning off an agent’s permission in Otrion Settings ends its active session. Otrion does not approve ACP tool permission requests on the user’s behalf.

## Where to add code

| Location | Purpose |
| --- | --- |
| `extensions/otrion-chat/` | The agent settings page, chat sidebar, and shared ACP client. The desktop build compiles its TypeScript sources. |
| `extensions/otrion-*/` | Add product features as extensions. For example, a model provider can live in its own extension, and a chat interface can use the VS Code Chat API. If an extension gains package dependencies, register it in the root `pnpm-workspace.yaml` and update the lockfile. |
| `product.json` | Configure the application name, data directories, URL scheme, and platform-specific application identifiers. |
| `src/vs/workbench/contrib/` | Add workbench UI that requires changes to the editor shell. Keep core changes in feature-specific commits so they are easier to review during upstream merges. |

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

If conflicts arise, preserve Otrion's product identifiers and incorporate new upstream settings. Stage the resolved files with `git add` and finish the merge with `git merge --continue`. Repeat the build steps with the Node.js and pnpm versions pinned by the new release. Launch Otrion and open the Otrion Chat sidebar before updating the baseline version in the README and this guide and merging the sync branch into `main`.

To review upstream development between releases, run `git fetch upstream main` followed by `git log --oneline HEAD..upstream/main`.

Otrion uses Open VSX for extension searches, downloads, and extension pages. Change both base URLs in **Otrion Settings → Extensions**, save, and reload the window. **Restore Open VSX defaults** clears the override. The agent marks bundled with the settings page come from the [ACP registry](https://github.com/agentclientprotocol/registry).
