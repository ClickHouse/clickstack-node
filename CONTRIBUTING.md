# Contributing

Read the [code of conduct](CODE_OF_CONDUCT.md) and the [ClickHouse AI policy](AI_POLICY.md) first.

## Setup

1. Install the Node version in `.nvmrc` (`nvm use`).
2. `npm ci`
3. Start Docker for the end-to-end tests.

## Checks

`npm run check` runs what CI runs on Node 24: spelling, formatting, lint, type checks, unit tests
with coverage, the build, package checks, and end-to-end tests that run the built package in child
processes against a collector in Docker. `npm run format` fixes formatting. Add new words for the
spell check to `cspell.config.yaml`.

CI also runs the unit tests on Node 22 and 26, and the end-to-end fixtures on Node 22 and 26 by
setting `CLICKSTACK_TEST_NODE` to another `node` binary. `devEngines` in `package.json` makes npm
refuse to run on Node 22, so install on the `.nvmrc` version and call `./node_modules/.bin/vitest`
directly.

## Releasing

1. In a pull request, set the version (`npm version 1.0.0-rc.1 --no-git-tag-version`) and add a
   `CHANGELOG.md` entry.
2. After it merges, run the Release workflow from the Actions tab and approve the deployment.

The workflow runs every check, publishes to npm with provenance (a version with a `-` suffix goes
to the `next` tag), and creates the GitHub release. It needs the `npm-publish` environment, limited
to `main` with required reviewers, and an npm trusted publisher for `release.yml` in that
environment.
