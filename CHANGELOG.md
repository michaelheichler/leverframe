# Changelog

All notable changes to Leverframe are recorded here.

## Unreleased

### Added

- Context infrastructure for budgeting, compaction planning, summaries, trusted metadata, encrypted memory, local inference profiling, retention, vector memory, and worker supervision.
- Read-only patch diagnostics with installation identity, version support, manifest, drift, transaction, lock, and legacy recovery details.
- Quality, testing, and technical-debt documents for the context and compaction work.

### Changed

- Claude Code binary patching now requires version 2.1.223 or newer. Older installations receive an upgrade instruction while proxy mode remains available.
- ChatGPT/Codex OAuth context windows now use positive finite provider metadata. Missing or invalid values remain unconfirmed.
- Context budgeting uses named token costs instead of positional array indexes.

### Fixed

- Claude Code 2.1.226 Agent model validation now supports the current function-style schema while retaining the legacy enum schema.
- Patch publication records the staged binary identity before the atomic rename, closing a crash-recovery gap.
- Model alias and context lookup tables use null-prototype objects to prevent prototype-key collisions.
- Repeated patching recognizes complete injected sites even when post-publication signing changes the exact binary hash.

### Safety

- Unsupported versions are rejected before binary inspection or patch-state mutation. Restore remains available for valid existing state.
- Patch transforms remain fail-closed when a required anchor is missing or ambiguous.
- The new compaction infrastructure remains outside the production request path until its integration evidence is complete.
