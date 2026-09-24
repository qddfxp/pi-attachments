# pi-attachments

[![npm version](https://img.shields.io/npm/v/pi-attachments.svg)](https://www.npmjs.com/package/pi-attachments)
[![CI](https://github.com/qddfxp/pi-attachments/actions/workflows/ci.yml/badge.svg)](https://github.com/qddfxp/pi-attachments/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-attachments.svg)](LICENSE)

Drop a file into your [pi](https://github.com/earendil-works/pi) prompt and it arrives as a real
attachment, not as a path the model has to notice and decide to read.

- **Images** are attached as image content, so the model sees them on the first turn — no tool round-trip.
- **Any other file** is listed once under `[Attached files]`, as a path the model opens on demand.
- **Huge pastes** collapse into a file, so a 5,000-line build log costs one read instead of tens of thousands of tokens.

```
what you type                                    →  what the model receives
──────────────────────────────────────────────────────────────────────────
Look at C:\work\screenshot.png, is it right?     →  unchanged  (+ image content)
看看这个 C:\work\screenshot.png 对不对?           →  unchanged  (+ image content)
C:\work\screenshot.png                           →  [attachment: screenshot.png]
Summarise C:\work\report.pdf                     →  unchanged  (+ block below)
C:\work\report.pdf                               →  block only

                                                    [Attached files]
                                                    - C:\work\report.pdf
```

## Table of contents

- [Quick start](#quick-start)
- [Usage](#usage)
- [What counts as a file reference](#what-counts-as-a-file-reference)
- [When your text is rewritten](#when-your-text-is-rewritten)
- [Long pastes](#long-pastes)
- [Settings](#settings)
- [Limits](#limits)
- [FAQ](#faq)
- [How it works](#how-it-works)
- [Development](#development)
- [Releasing](#releasing)
- [License](#license)
- [中文说明](#中文说明)

## Quick start

**1. Install it**

```bash
pi install npm:pi-attachments
# or: pi install git:github.com/qddfxp/pi-attachments
# or: pi install /absolute/path/to/pi-attachments
```

**2. Confirm pi picked it up**

```bash
pi list        # pi-attachments should be listed
pi             # start a session
> /attach      # if the extension is loaded, pi opens a file picker;
               # if it is not, pi reports an unknown command
```

**3. Attach something**

Three ways, all equivalent:

| Gesture | How |
|---|---|
| Drag a file onto the terminal, press Enter | Most direct — the path becomes an attachment |
| Type `/attach` and pick a file | Clipboard files first, then the session directory |
| Copy a file in Explorer/Finder, then `/attach` | Showed at the top of the picker with a `📋` prefix |

While anything is queued, the footer shows `📎 1: screenshot.png`, and `/attachments` lists the
queue (`/attachments clear` empties it).

To try it without installing: `pi -e /absolute/path/to/pi-attachments`.

To update or remove:

```bash
pi update --extensions
pi remove npm:pi-attachments
```

## Usage

| You do | What happens |
|---|---|
| Drag a file onto the terminal | Its path is turned into an attachment when you send |
| Paste a path | Same — quoted paths and escaped spaces (`C:\My\ Files\a.pdf`) are understood |
| `/attach` | Pick a file: clipboard files first, then the session directory |
| `/attach ./notes.md` | Attach a specific path |
| `/attachments` | Show what is queued for the next message |
| `/attachments clear` | Drop the queue |

## What counts as a file reference

Only references you clearly meant as a file are converted:

| Accepted | Not converted |
|---|---|
| `C:\work\a.pdf`, `/home/me/a.pdf` | `src/index.ts` (indistinguishable from prose) |
| `@./notes.md` | `@notes.md` |
| `./notes.md`, `../notes.md` | `https://example.com/a.png` |
| `.\notes.md`, `..\notes.md` (Windows) | a path that does not exist |
| `~/notes.md` | |
| `"C:\My Files\a.pdf"` and `C:\My\ Files\a.pdf` | |
| `./src/main.ts:12:5` (resolves to `./src/main.ts`) | `src/main.ts:12:5` |

Trailing punctuation stays in your sentence, and quotes or brackets around a path are understood.
A `:line:col` suffix is stripped only on a path that is absolute or explicitly marked — a bare
`src/main.ts:12:5` is prose, exactly like `src/index.ts`.

## When your text is rewritten

Your wording is touched only when the message is **nothing but paths** — the "dropped a file and
pressed Enter" gesture:

- an image becomes `[attachment: name]` (kept neutral: the sniffer can still reject it), everything else moves into the `[Attached files]` block
- a message with words in it is left exactly as typed; the block is appended underneath
- so pasting a stack trace or build log full of absolute paths does **not** tear those paths out of it — they stay, and are also offered as attachments

**Files are never attached to `!` shell commands or `/` commands** — a path inside a shell command
would be executed, so the extension refuses and warns instead.

## Long pastes

A message longer than `pasteCollapseThreshold` (12,000 characters by default) is written to
`<cwd>/.pi-attachments/paste-<timestamp>.txt` and replaced by a one-line pointer, so pasting a
5,000-line build log costs one file read instead of tens of thousands of tokens. The directory
ignores itself in git, and the file also lands in the attachment block so the model knows to open
it. Set the threshold to `0` to send everything inline.

## Settings

Optional `attachments` key in pi's settings:

| Level | File | Notes |
|---|---|---|
| User | `<agentDir>/settings.json` | e.g. `~/.pi/agent/settings.json` |
| Project | `<cwd>/.pi/settings.json` | wins over user level, honoured only for a **trusted** project |

```json
{
  "attachments": {
    "pasteCollapseThreshold": 12000,
    "maxPendingAttachments": 32
  }
}
```

Invalid values are ignored rather than rejected, and settings are re-read when the file changes —
no restart needed.

## Limits

- Images are attached inline and **pi core resizes them** (via the `images.autoResize` setting), so an oversized screenshot is downscaled by pi rather than refused here. A file whose bytes are not really an image, or one over 32 MiB, falls back to a path reference and tells you so.
- One message inlines at most **128 MiB** of image data; anything beyond that travels as a path. With a 32-file queue, per-file bounds alone would still let a gigabyte be read into memory.
- Nothing is copied anywhere except collapsed pastes. The model reads the file at its real location, so it must be inside the session's working directory for the agent to open it.
- File **contents** are never inlined into the prompt — you get a path, and the model opens what it needs. That keeps a 200 KB log from costing tens of thousands of tokens, and lets the model seek to the relevant part instead of reading a truncated copy.
- Resolution stops after **256 path-like candidates** in one message. A pasted build log is the worst case: 8000 candidates cost ~650 ms before this cap and ~11 ms after, and the message itself is never modified.
- `/attach` queues at most **32 files** (configurable), and `/attachments` lists the first 20 before summarising the rest. A block with hundreds of paths would dwarf the message it belongs to.

## FAQ

**Nothing happened when I dropped a file.** Check the footer — if it does not show `📎`, the path
was not recognised. The file has to exist as typed, and a bare relative path like `src/index.ts` is
deliberately treated as prose. Use `./src/index.ts` or `/attach` instead.

**My pasted log lost its paths.** It did not: the text is only rewritten when the message is
nothing but paths. With words in it, every path stays where you typed it.

**The model got a path instead of my image.** The bytes were not an image (the name can lie), it was
over 32 MiB, or the 128 MiB per-message budget was already spent. A warning names the file each time.

**Attachments disappeared when I used `!` or `/`.** By design — a path inside a shell command would
be executed. Send attachments in a normal message.

**Does it upload anything?** No. There is no network code and no tools are registered; the only file
ever written is the collapsed paste, next to your project.

## How it works

One `input` event handler. It scans the editor text for candidate paths, resolves each against the
session cwd, and returns a transform:

```ts
{ action: "transform", text: "<your words>", images: [{ type: "image", data, mimeType }] }
```

Everything runs through pure, tested functions (`extractAttachments`, `isShellOrCommandInput`,
`sniffImageMimeType`, …), so behaviour is pinned by tests rather than by running pi.

## Development

```bash
npm install          # types only; the SDK is a peer dependency
npm run verify       # typecheck + tests + a load through pi's own loader
```

`npm run check:load` is worth knowing: it calls `discoverAndLoadExtensions` from the SDK — the exact
code path `pi -e` uses — so a green run means pi can really load the extension, not just that it
compiles.

Verified against SDK 0.85.1 and 0.87.1. `peerDependencies` is `>=0.85.0` because that is the oldest
version the extension was actually loaded with; the API surface it uses (`input` events,
`registerCommand`, `ui.setStatus`/`notify`/`select`) exists in all of them.

CI runs `npm run verify` on Ubuntu **and** Windows. Windows is in the matrix on purpose: backslash
paths, drive letters, and case-folded dedupe are invisible on Linux — the first Linux run caught a
bug where every POSIX absolute path was mistaken for a slash command.

## Releasing

```bash
npm version patch          # or minor/major; commits and tags vX.Y.Z
git push --follow-tags
npm publish --access public
```

`.github/workflows/publish.yml` can publish from CI on a `v*` tag with npm provenance. It needs an
`NPM_TOKEN` repository secret (a granular access token with *Read and write* access to all packages);
without the secret the job skips itself instead of failing. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 qddfxp

## 中文说明

把文件拖进终端只会得到一串路径文本。这个扩展把路径还原成真正的附件：**图片直接作为图片内容附上**，**其他文件列进末尾的 `[Attached files]` 块**交模型按需读取。

**三步开始**：`pi install npm:pi-attachments` → `pi list` 确认 → 进 pi 后拖文件回车，或用 `/attach` 选择（资源管理器里复制过文件的话，剪贴板文件带 `📋` 排在最前）。待发时页脚显示 `📎`，`/attachments` 查看、`/attachments clear` 清空。

**识别范围**：绝对路径、`@./x`、`./x`、`.\x`、`../x`、`~/x`、带引号或转义空格的路径；句子里的 `src/index.ts` 不识别（避免误伤散文），`:行:列` 只在绝对路径或显式标记的相对路径上生效。

**正文只在这条消息全是路径时才改写**（拖完直接回车那种）；其余情况原样不动、只在末尾加块——所以粘贴日志不会被抠走路径。`!` 和 `/` 命令不带附件。超过 `pasteCollapseThreshold`（默认 12000 字符）的长粘贴会写入 `<cwd>/.pi-attachments/paste-<时间戳>.txt`，正文只留一行指针。

**可配置**：settings.json 里加 `attachments` 键（`pasteCollapseThreshold`、`maxPendingAttachments`），项目级覆盖用户级、且仅在项目受信任时生效。运行时文案统一为英文（折叠标记会进入你的提示词，必须语言中立）。

完整细节（限制、FAQ、工作原理、开发）见上方英文各节。
