# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-10-06

> **Note on the missing 1.1.0.** `package.json` was bumped to `1.1.0` on 2026-09-25 but that
> version was never tagged in git, never published to npm, and never released on GitHub —
> npm's `latest` stayed on `1.0.0` until now. The `1.1.0` work (vitest and jest runners, the
> findings-contract v1 envelope, the child-process reaper, and the fixes that shipped with
> them) is folded into this release.

### Fixed

- The module-identity proof silently did nothing on Node < 20.6: `import.meta.resolve` is
  undefined there, and the per-specifier error was swallowed as "genuinely missing", so every
  verdict was "proven" without resolving a single import. The probe now reports when it
  cannot resolve, and the verdict is withheld instead of trusted.
- The findings-contract `version` field was hardcoded to `1.1.0`; it is now read from
  `package.json` so it cannot drift.

### Changed

- Minimum Node version raised to `20.6.0` (was `18`).

### Added

- `scripts/precision.mjs`: measure the precision (and recall, when the sample is labelled)
  of the `BLIND` verdict against a hand-labelled corpus.
- Unit coverage for the vitest/jest report parser (`parseReport`) against captured runner
  output.

### Removed

- Dead code: the tautological `nodeTest.matches` predicate, the unused `RUNNERS` export,
  `isFileLevelFailure`, and a leftover destructure in `commitInfo`.

## [1.0.0] - 2026-09-25

- Initial public release: `ca doctor` / `ca verify` / `ca audit` over `node:test`, published
  to npm and the GitHub Marketplace (`mekanhan/control-arm@v1`).
