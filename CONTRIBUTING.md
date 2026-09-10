# Contributing to Coarse Grid

Thanks for your interest in contributing! This guide covers how to set up a
local dev environment, run the checks, and what we expect from pull requests.

## Development setup

Prerequisites:

- **Node.js >= 22.18** (the `engines` requirement; the project uses modern
  `node --test` and ESM throughout, and Node of this vintage runs the core
  package's TypeScript sources natively)
- **pnpm** (workspaces-based monorepo). Node 22+ ships corepack — enable it once with:

```sh
corepack enable
```

or install pnpm globally with `npm i -g pnpm`.

Install dependencies:

```sh
pnpm install
```

The repo is a pnpm workspaces monorepo:

- **Root app** (`index.html`, `src/`, Vite build) — the React UI: file
  upload, expert controls, presets, edit history, preview workspace, and
  PNG download.
- **`packages/core`** (`@voyager-fm/coarse-grid-core`) — the reusable GPU renderer,
  filter params, edit history, and preset store published as a package.

## Commands

Run the full set of checks and tests:

```sh
pnpm run check
pnpm run test:unit
pnpm run test:browser:chromium
pnpm test
```

- `pnpm run check` — runs `node --check` over the remaining plain-JavaScript
  files (browser tests, Playwright config) and then strict `tsc --noEmit`
  over the app and `packages/core`. See the TypeScript section below.
- `pnpm run test:unit` — runs the Node unit tests (parameter normalization,
  block sizing, shader contracts, presets, edit history).
- `pnpm run test:browser:chromium` — runs the Playwright browser tests against
  the Chromium project only (fastest browser feedback loop).
- `pnpm test` — runs everything in sequence: `check`, `test:unit`, a production
  build, and the full browser test suite.

Individual browser engines are also available via `pnpm run test:browser:firefox`
and `pnpm run test:browser:webkit`.

## TypeScript

The engine package `packages/core` (`@voyager-fm/coarse-grid-core`) is written in
TypeScript and ships its `.ts` sources directly. There is no build step:
Node.js >= 22.18 (the `engines` requirement in both the root and core
`package.json`) executes TypeScript natively by stripping type annotations at
load time, so the package's `main` and `exports` point straight at
`./src/index.ts`. Publishing is the one place a build happens:
`pnpm --filter @voyager-fm/coarse-grid-core build` compiles the `dist/`
output, and the package's `publishConfig` swaps the packed manifest's entry
points over to it when the package is published to GitHub Packages.

Two rules keep that working:

- **Strict mode everywhere.** `npx tsc --noEmit` covers both the app and
  `packages/core` under `"strict": true`. Do not silence errors with `any`
  escapes or disabled compiler flags.
- **Erasable syntax only in `packages/core`.** No `enum`, `namespace`,
  parameter properties, decorators, or `const enum`. Type stripping can only
  remove annotations, so any non-erasable construct would force core to grow
  a build step, which it deliberately does not have.

Run the checks with:

```sh
pnpm run check
```

This runs `node --check` over the remaining plain-JavaScript files and then
strict `tsc --noEmit` over the app and core. Converted `.ts` files are
covered by tsc alone because `node --check` cannot parse type annotations.

## Pull request expectations

Before opening a pull request, please make sure:

- All tests are green: `pnpm run check` and `pnpm run test:unit` pass, and the
  browser suite (`pnpm run test:browser:chromium` at minimum) is green.
- Changes are focused and additive where possible.
- **No behavior changes to `packages/core` without prior discussion.** The core
  package is a published artifact with a stable, deliberate export surface and
  shader contracts. If your change alters core behavior, rendering output, or
  the public export surface, open a discussion issue first so the impact on the
  published package is understood before code lands.

## License

This project is licensed under the [GNU GPL v3](LICENSE).
