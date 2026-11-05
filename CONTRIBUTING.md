# Contributing

Thank you for looking into the open-source part of the Univer Collaboration SDK.

## Where the code is developed

The packages in this repository are developed in the Univer Collaboration SDK repository, together
with the closed-source Service and Endpoint packages they implement adapters for. This repository
receives their source at every SDK release and is otherwise read-only: nothing under `packages/*` or
`testkits/*` is edited here, because the next release overwrites it.

## Reporting a problem

Open an issue with the package name, its version, the SDK version you use, and a way to reproduce
the behaviour. A failing test written against the package's contract testkit is the most useful
report.

## Proposing a change

Pull requests are welcome and are read by the maintainers, but they are not merged here. A
maintainer applies the change in the SDK repository, names this pull request in the commit message,
and the change appears here with the next release. The pull request is then closed with a comment
that says which version carries it.

A change has the best chance when it:

- keeps the contract tests of the package passing (`pnpm test` in the package directory);
- comes with a test when it fixes a behaviour;
- uses English for code, identifiers and comments;
- stays within the package's public contract, which the matching SDK Service package defines.

## License

By contributing you agree that your contribution is licensed under the Apache License 2.0 that
covers this repository.
