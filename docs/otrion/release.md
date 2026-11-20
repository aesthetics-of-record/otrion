# Publish an Otrion release

Merge the PRs you want to ship into `main`. Pushing a version tag starts the release build for the tagged commit. The steps below use `0.1.1` as an example.

1. **Prepare the version.** In your release PR, update both fields in [product.json](../../product.json). Set `otrionVersion` to `0.1.1` and change the tag in `serverDownloadUrlTemplate` to `/releases/download/v0.1.1/`. Preserve the filename `otrion-reh-${os}-${arch}.tar.gz`. The packaging script checks that the URL matches the version.

2. **Tag the latest commit on `main`.** Once the release PR is merged, run these commands from any local branch. Fetching refreshes `origin/main`, and pushing the tag starts the build for that commit.

   ```sh
   git fetch origin
   git tag -a v0.1.1 origin/main -m "Otrion 0.1.1"
   git push origin v0.1.1
   ```

3. **Download the build.** Open the run for your tag and wait for all six jobs to succeed. Download its six artifacts and extract each outer Actions ZIP once. Each contains a desktop package and its matching Remote SSH server for Windows, macOS, or Linux on x64 or ARM64. [Otrion release packages](https://github.com/aesthetics-of-record/otrion/actions/workflows/otrion-release.yml)

4. **Publish on GitHub.** Choose **Draft a new release**, select the existing tag, and enter a title such as `Otrion 0.1.1`. Attach all 12 files from that run with their original names and select **Publish release**. Remote SSH downloads the server by filename and checks that its commit matches the desktop build. [Otrion releases](https://github.com/aesthetics-of-record/otrion/releases)

For a test build, use **Actions → Otrion release packages → Run workflow**. Pushes to `feat/release-0.1.0` also trigger the workflow.
