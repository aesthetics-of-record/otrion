# Publish an Otrion release

1. In a PR, update `otrionVersion` in [product.json](../../product.json) to the next version, such as `0.1.1`. Use any branch name.
2. Merge the PR into `main`. GitHub Actions builds Windows, macOS, and Linux packages for x64 and ARM64 from the merged commit. It derives the Remote SSH download URL from the same version.
3. Once all six jobs succeed and all 12 files are present, the workflow tags the build commit and publishes the GitHub Release with the desktop apps, Remote SSH servers, and generated notes. [Build progress](https://github.com/aesthetics-of-record/otrion/actions/workflows/otrion-release.yml) · [Published releases](https://github.com/aesthetics-of-record/otrion/releases)

If a build or upload fails, rerun the failed jobs on the original workflow run. That keeps the build and tag on the same commit. To test packaging, select **Run workflow** and leave **Publish the version in product.json** unchecked. To manually publish the current version, select `main` and check that option. A manually pushed matching version tag builds packages for that tag.
