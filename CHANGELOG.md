# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-06-16

### Added

- npm version badge and an install pointer at the top of the README.
- `repository`, `bugs`, and `homepage` metadata in `package.json` (adds the
  source link on the npm page).
- This changelog, plus `preversion`/`postversion` scripts for one-command releases.

## [0.1.0] - 2026-06-16

### Added

- Initial release: a local-first, space-separated memory MCP server.
- Six core tools: `list_spaces`, `current_space`, `switch_space`, `remember`,
  `recall`, `forget`. One space is active at a time; content tools touch only
  the active space, so memories never leak across spaces.
- Per-space knowledge base — `add_document`, `search_knowledge`,
  `list_documents`, `remove_document` — behind the `MEMORY_SPACES_ENABLE_KB`
  feature flag, off by default.
- JSON-file storage behind a `MemoryStore` interface, with atomic writes and a
  reserved per-chunk `vector` field for future semantic search.

[Unreleased]: https://github.com/melon-husk/memory-spaces/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/melon-husk/memory-spaces/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/melon-husk/memory-spaces/releases/tag/v0.1.0
