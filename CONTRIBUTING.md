# Contributing to Otrion

## Bugs and feature requests

Search [Otrion issues](https://github.com/aesthetics-of-record/otrion/issues) for an existing report. For a bug, include your Otrion version, operating system, steps to reproduce, and what you expected to happen. If it only happens over Remote SSH, include the remote OS too. For a feature request, describe the task you want to accomplish.

For vulnerabilities, follow the [security reporting guide](SECURITY.md).

## Pull requests

1. Follow the [development guide](docs/otrion/development.md) to install the pinned Node.js and pnpm versions, build Otrion, and run it locally.
2. Create a branch from `main`. For agent chat or Otrion Settings changes, start in [otrion-chat](extensions/otrion-chat). The built-in SSH extension lives in [otrion-remote-ssh](extensions/otrion-remote-ssh).
3. Test the affected workflow and open a pull request against `main`. Describe what changed and how you tested it. For interface changes, a screenshot helps reviewers see the result.
