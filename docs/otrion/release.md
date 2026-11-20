# Publish an Otrion release

1. In a PR, update `otrionVersion` in [product.json](../../product.json) to the next version, such as `0.1.2`. Use any branch name.
2. Merge the PR into `main`. For `0.1.2` and later, GitHub Actions builds Windows x64, macOS x64 and ARM64, and Linux x64 and ARM64 from the merged commit. It derives the Remote SSH download URL from the same version.
3. Once all five jobs succeed and all 10 files are present, the workflow tags the build commit and publishes five desktop packages and five Remote SSH server archives with generated notes. [Build progress](https://github.com/aesthetics-of-record/otrion/actions/workflows/otrion-release.yml) · [Published releases](https://github.com/aesthetics-of-record/otrion/releases)

If a build or upload fails, rerun the failed jobs on the original workflow run. That keeps the build and tag on the same commit. To test packaging, select **Run workflow** and leave **Publish the version in product.json** unchecked. To manually publish the current version, select `main` and check that option. A manually pushed matching version tag builds packages for that tag.

## macOS restart updates

Set the GitHub Actions repository secrets `MACOS_CERTIFICATE_P12` (a base64-encoded Developer ID Application certificate and private key) and `MACOS_CERTIFICATE_PASSWORD` (its export password). Both macOS jobs sign the app before archiving it. Use the same signing identity across updates. With neither secret configured, the jobs publish ad hoc ZIPs with manual updates. Users switching from an ad hoc build install the first Developer ID build manually. Developer ID signing enables native updates. Apple notarization is a separate distribution step. [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)
