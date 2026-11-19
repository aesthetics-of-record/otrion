# Open Remote - SSH in Otrion

Otrion Desktop includes this extension from source. Run **Remote-SSH: Connect to Host...** in the Command Palette to open an SSH workspace. The extension keeps the upstream ID `jeanp413.open-remote-ssh`, command IDs, and `remote.SSH.*` settings.

## Edit and run

After installing the repository dependencies with pnpm, run `pnpm run gulp compile-extension:open-remote-ssh` from the repository root. Run **Developer: Reload Window** in Otrion to load the compiled extension. For continuous development use `pnpm run gulp watch-extension:open-remote-ssh`. The normal `pnpm run build-fast` builds it with the other desktop extensions.

| Path | What to edit |
| --- | --- |
| `src/commands.ts` | Host picker and SSH configuration commands |
| `src/authResolver.ts` | SSH connection and tunnel setup |
| `src/serverSetup.ts`, `src/scripts/` | Remote server installation and startup |
| `src/native/` | Native OpenSSH backend, helper process and credential prompts |
| `package.json` | Commands, configuration and Remote Explorer contributions |

Desktop packaging runs `esbuild.mts` to bundle the extension and its helper processes. Both development and packaged builds read the same shell and PowerShell templates. [Otrion remote server deployment](../../docs/otrion/development.md#remote-server-for-a-desktop-release)

## Upstream

The runtime sources, icon, and MIT license come from `jeanp413/open-remote-ssh` v0.6.2, commit `e925fc0f0fbe8cb13220365d1300d6c3356383e8`. The SSH library fork is pinned to the commit in that release's lockfile. When updating, compare the upstream sources against this revision and preserve Otrion’s helper paths and build configuration. [Upstream source](https://github.com/jeanp413/open-remote-ssh/tree/e925fc0f0fbe8cb13220365d1300d6c3356383e8)
