# Univer Collaboration SDK Community Guide

This file applies to the whole repository.

## What this repository is

This repository is the published, read-only copy of the open-source part of the Univer Collaboration
SDK. The packages under `packages/*` and `testkits/*` are developed in the Univer Collaboration SDK
repository, in its `packages-community/*` and `testkits-community/*` directories, next to the
closed-source Service and Endpoint packages. At every SDK release the SDK's sync script replaces
`packages/*` and `testkits/*` here with that release's source and commits the result to `main`.

Consequences:

- Do not edit anything under `packages/*` or `testkits/*` here; the next sync overwrites it. Propose
  the change through an issue or pull request instead, see `CONTRIBUTING.md`.
- The root files are maintained here: `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CONTRIBUTING.md`,
  `LICENSE`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` and `.github/`. When a new
  package arrives, its row in the `README.md` package table is added here before the sync, which
  fails when a package is missing from the table.
- Package names and versions match the SDK: every SDK release has a matching state of `main` with the
  same version in every manifest. Closed-source SDK packages and `@univerjs/protocol` are exact
  version dependencies installed from the public npm registry; this repository never carries an
  `.npmrc`, so `pnpm install` here is the same install a user does.

## Repository layout

- `packages/*` holds every published package in a flat list, named after the SDK convention
  `collaboration-<domain>-<kind>-<backend>`, for example `collaboration-database-sqlite` and
  `collaboration-file-blob-s3`.
- `testkits/*` holds the contract tests of each SPI, named `collaboration-<domain>-<kind>-testkit`,
  and is published together with the adapters.
- Domains are grouped only in the package table of `README.md`.

## Verification

`pnpm install`, `pnpm check` and `pnpm test` must pass on `main` after every sync; CI runs them on
Node.js 22 and 24 with a PostgreSQL service. The testkit of an SPI is its single acceptance
criterion: `test/contract.test.mts` of every implementing package runs it.
