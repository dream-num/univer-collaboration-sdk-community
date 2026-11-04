# Univer Collaboration SDK Community Guide

This file applies to the whole repository.

## Goal

This repository maintains the open-source part of the Univer Collaboration SDK. The package list,
usage and development commands are in `README.md`.

Package names and versions match the SDK: every SDK release has a release of this repository with
the same version. On `main` every package carries the placeholder version `0.0.0`; the release
process sets the real version. The collaboration Service, Endpoint and Worktree packages stay closed
source; this repository works with them only through their published public contracts.

## Repository layout

- `packages/*` holds every published package in a flat list, named after the SDK convention
  `collaboration-<domain>-<kind>-<backend>`, for example `collaboration-database-sqlite`,
  `collaboration-worktree-database-sqlite` and `collaboration-file-blob-s3`.
- `testkits/*` holds the contract tests of each SPI, named `collaboration-<domain>-<kind>-testkit`,
  and is published together with the adapters.
- Domains are grouped only in the package table of `README.md`.

## Dependency boundaries

- A package depends only on contracts that the closed-source SDK packages mark `@public`. Types are
  imported with `import type`; the runtime values a package uses, such as `CollabError`, are listed
  in its README.
- A Service package that lives in this repository, such as `collaboration-file-service`, defines its
  own SPI here. Its adapters and testkits depend on it with `workspace:*`, which the release turns
  into the exact version.
- Closed-source SDK packages and `@univerjs/protocol` are peerDependencies pinned to the latest
  published SDK version; devDependencies use the same version for tests. The release process moves
  both to the SDK version being released.
- Adapters persist or transport: protocol objects are stored as they are, while OT, authorization and
  broadcasting belong to the Service and the Endpoint.

## Contracts

The testkit of an SPI is its single acceptance criterion: `test/contract.test.mts` of every
implementing package runs it and passes completely. Contract details and common mistakes live in the
testkit's README so third-party implementers read them on npm.

## Schema and migrations

- Every persistent adapter keeps its own schema version table with the component name `core`.
  Opening a database with a different version fails with a message that points at the explicit
  migration; migration functions are exported and live under `src/migrations/`, one per version.
- SQLite adapters use the `collaboration_` table prefix and the shared `collaboration_schema_versions`
  table, so the adapters of all domains coexist in one file and track their versions by component.
- A schema change bumps the version, ships a migration function and updates the schema section of
  the package README.

## Public API boundary

The package entry `src/index.ts` exports only what users need: the adapter class, its options type
and migration functions. All code, identifiers and comments are English, including internal
implementation comments. JSDoc that reaches the `.d.ts` says only what users need; implementation
notes on private members and unexported types use `//` comments.

## Development and verification

Run `pnpm check` and `pnpm test` before committing.

Git commits happen when the user asks for them; change only the files the current task touches.
