# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-09-24

### Fixed

- A long `!shell` or `/slash` command no longer leaves an orphan paste file behind. The
  collapse ran before the "commands never carry attachments" check, so the file was
  written and then the whole transform was thrown away — every long command left one
  dead file, plus two notifications that contradicted each other.
- Two same-named files from different folders on the clipboard are now selectable
  independently; previously both options had the same label and the first one always won.

### Changed

- Runtime messages are English. The collapse marker in particular ends up **inside your
  prompt**, so it had to match `[Attached files]` rather than being localised.
- `listFiles` follows symlinks. `Dirent.isFile()` is an lstat, so a symlink to a file used
  to be invisible to the picker and to completion, even though dropping its path worked.
- Paste file names use local time (`paste-20260924-114500.txt`) instead of UTC, so a name
  lines up with the clock you are reading.
- `/attachments CLEAR` works; the subcommand was case-sensitive.
- The image size message is derived from the constant, so it says `32 MiB` and cannot
  drift from `MAX_IMAGE_READ_BYTES` again.

### Added

- `CHANGELOG.md`, README badges, and a `publish.yml` workflow that publishes on a `v*` tag
  with npm provenance when an `NPM_TOKEN` secret is present.

## [0.3.0] - 2026-09-24

### Added

- Clipboard file lists: copy a file in Explorer/Finder and `/attach` offers it first.
  Windows, macOS, and Linux helpers, all optional — a missing helper degrades to "no
  clipboard files".
- Long-paste collapsing: a message over `pasteCollapseThreshold` (12,000 characters by
  default) is written to `<cwd>/.pi-attachments/paste-<timestamp>.txt` and replaced by a
  pointer, so a pasted build log costs one file read instead of tens of thousands of tokens.
- Settings from the `attachments` key of pi's `settings.json` (`pasteCollapseThreshold`,
  `maxPendingAttachments`). Project level wins over user level and is honoured only for a
  trusted project.

### Fixed

- Every POSIX absolute path was mistaken for a slash command, which made the extension a
  no-op on Linux and macOS. Caught by the `ubuntu-latest` CI job.

## [0.2.0] - 2026-09-24

### Fixed

- Images above 4.5 MB were refused and downgraded to a bare path reference. pi core already
  normalises and resizes prompt images through `_normalizePromptImages`, so the budget was
  pointless; the cap is now a 32 MiB sanity bound that only stops a pathological file from
  being read into memory.

## [0.1.0] - 2026-09-24

### Added

- Initial release. Dropped or pasted paths become attachments: images as image blocks,
  other files as a path listing under `[Attached files]`.
- The message body is rewritten only when it is nothing but paths, so pasting a log full of
  absolute paths leaves that log intact.
- `!` and `/` commands never carry attachments; `src/index.ts` in prose is left alone.
- `/attach` picker and the `/attachments` queue.
