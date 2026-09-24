# pi-attachments

[![npm version](https://img.shields.io/npm/v/pi-attachments.svg)](https://www.npmjs.com/package/pi-attachments)
[![CI](https://github.com/qddfxp/pi-attachments/actions/workflows/ci.yml/badge.svg)](https://github.com/qddfxp/pi-attachments/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-attachments.svg)](LICENSE)

Drop a file into your terminal and it becomes a real attachment in the pi prompt.

Dragging a file into a terminal only inserts its **path as text**. The model then has to notice the path, guess that it matters, and decide to read it. This extension does that part for you:

- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) are attached as image blocks, so the model sees them on the first turn — no tool round-trip.
- **Any other file** is listed once at the end as a path the model reads on demand, so your wording stays clean.
- Files copied in Explorer/Finder can be attached from the clipboard, and a 5,000-line paste is collapsed into a file instead of costing tens of thousands of tokens.

```
看下这个 C:\work\proj\screenshot.png 对不对?     →  images: [screenshot.png]        正文不动
C:\work\proj\screenshot.png                     →  正文变成  [image: screenshot.png]
总结一下 C:\work\proj\report.pdf                →  正文不动 + 末尾多一个附件块
C:\work\proj\report.pdf                         →  正文就是附件块

                                                   [Attached files]
                                                   - C:\work\proj\report.pdf
```

## Install

```bash
pi install npm:pi-attachments
pi install git:github.com/qddfxp/pi-attachments
pi install /absolute/path/to/pi-attachments

pi -e /absolute/path/to/pi-attachments   # try it without installing
```

Or add it to `~/.pi/agent/settings.json` yourself:

```json
{ "extensions": ["/absolute/path/to/pi-attachments/extensions/pi-attachments.ts"] }
```

## Usage

| You do | What happens |
|---|---|
| Drag a file onto the terminal | Its path is detected and turned into an attachment on send |
| Paste a path | Same — quoted paths and `\ `-escaped spaces are understood too |
| Copy a file in Explorer/Finder, then `/attach` | Clipboard files are offered first, labelled `📋 name` |
| `/attach` | Pick a file: clipboard files first, then the session directory |
| `/attach ./notes.md` | Attach a specific path |
| `/attachments` | List what is queued for the next message |
| `/attachments clear` | Drop the queue |

The footer shows `📎 1: screenshot.png` while something is queued.

### What counts as a file reference

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

### When the text gets rewritten

Your wording is only touched when the message is **nothing but the path** — the
"dropped files and pressed Enter" gesture:

- images become `[image: name]`, everything else moves into the `[Attached files]` block
- a message with words in it is left exactly as typed; the block is appended on top
- so pasting a stack trace or build log full of absolute paths does **not** tear those paths out of it — they are simply also offered as attachments

**Files are never attached to `!` shell commands or `/` commands** — a path inside a
shell command would be executed, so the extension refuses and warns instead.

### Long pastes

A message longer than `pasteCollapseThreshold` (12,000 characters by default) is written
to `<cwd>/.pi-attachments/paste-<timestamp>.txt` and replaced by a one-line pointer, so
pasting a 5,000-line build log costs one file read instead of tens of thousands of
tokens. The directory ignores itself in git, and the file also lands in the attachment
block so the model knows to open it. Set the threshold to `0` to send everything inline.

### Settings

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

Invalid values are ignored rather than rejected, and settings are re-read when the file
changes — no restart needed.

### Limits

- Images are attached inline and **pi core resizes them** (via the `images.autoResize` setting), so an oversized screenshot is downscaled by pi rather than refused here. A file whose bytes are not really an image, or one over 32 MB, falls back to a path reference and tells you so.
- Nothing is copied anywhere except collapsed pastes. The model reads the file at its real location, so it must be inside the session's working directory for the agent to open it.
- File **contents** are never inlined into the prompt — you get a path, and the model opens what it needs. That keeps a 200 KB log from costing tens of thousands of tokens, and lets the model seek to the relevant part instead of reading a truncated copy.
- Resolution stops after **256 path-like candidates** in one message. A pasted build log is already the worst case: 8000 candidates cost ~650 ms before this cap and ~11 ms after, and the message itself is never modified.
- `/attach` queues at most **32 files** (configurable), and `/attachments` lists the first 20 before summarising the rest. A block with hundreds of paths would dwarf the message it belongs to.

## How it works

One `input` event handler. It scans the editor text for candidate paths, resolves each against the session cwd, and returns a transform:

```ts
{ action: "transform", text: "<your words>", images: [{ type: "image", data, mimeType }] }
```

No tools are registered and nothing is uploaded. The only file it ever writes is the
collapsed paste described above; everything else it reads is a file you attached.

## Development

```bash
npm install          # types only; the SDK is a peer dependency
npm run verify       # typecheck + tests + a load through pi's own loader
```

`npm run check:load` is worth knowing about: it runs `discoverAndLoadExtensions`
from the SDK — the exact code path `pi -e` uses — so a green run means pi really
can discover the extension, not just that it compiles.

Verified against SDK 0.85.1 and 0.87.1. `peerDependencies` is `>=0.85.0` because
that is the oldest version the extension was actually loaded with; the API surface
it uses (`input` events, `registerCommand`, `ui.setStatus`/`notify`/`select`) exists
in all of them.

## Publishing

Published: [`pi-attachments` on npm](https://www.npmjs.com/package/pi-attachments), repository at
[qddfxp/pi-attachments](https://github.com/qddfxp/pi-attachments). The `pi` manifest points at
`extensions/`, and the `pi-package` keyword is what makes it show up on
[pi.dev/packages](https://pi.dev/packages).

To cut a release:

```bash
npm version patch          # or minor/major; commits and tags vX.Y.Z
git push --follow-tags
npm publish --access public
```

`.github/workflows/ci.yml` runs `npm run verify` on Ubuntu and Windows for every push.
Windows is in the matrix on purpose: backslash paths, drive letters, and case-folded
dedupe are the parts Linux CI cannot see — the first Linux run caught a bug where every
POSIX absolute path was mistaken for a slash command.

`.github/workflows/publish.yml` can publish from CI on a `v*` tag with npm provenance.
It needs an `NPM_TOKEN` repository secret (a granular access token with *Read and write*
for all packages); without the secret the job skips itself instead of failing.

Add `"image"` or `"video"` to the `pi` block in `package.json` if you want a preview
on the gallery card.

## 中文说明

把文件拖进终端只会得到一串路径文本，模型得自己想到去读它。这个扩展把路径还原成真正的附件：**图片直接作为图片内容附上**（模型第一轮就看得见），**其他文件列进消息末尾的附件块**按需读取。

用法：拖文件 / 粘贴路径 / `/attach` 选文件（**在资源管理器里复制了文件的话，剪贴板里的文件会排在选择列表最前面，带 `📋` 前缀**），页脚会显示 `📎` 待发附件。只识别你明确写成文件的引用（绝对路径、`@./x`、`./x`、`.\x`、`../x`、`~/x`、带引号或转义空格的路径），句子里的 `src/index.ts` 不会被动；`:行:列` 只在绝对路径或显式标记的相对路径上生效。

**只有整条消息就是路径时才会改写你的正文**（拖完直接回车那种），其余情况正文原样不动、只在末尾加一个附件块——所以粘贴一堆绝对路径的报错日志不会被抠走路径。`!` shell 命令和 `/` 命令**不会**带附件（Linux 上以 `/` 开头的绝对路径不会被误判成命令）。图片直接内联、缩放交给 pi 内核（`images.autoResize`），内容不是图片格式或超过 32MB 时才退回按路径交给模型；单条消息最多解析 256 个候选路径（防大粘贴卡输入），`/attach` 队列上限 32 个。

**长粘贴会自动折叠**：超过 `pasteCollapseThreshold`（默认 12000 字符）的消息会写入 `<cwd>/.pi-attachments/paste-<时间戳>.txt`，正文里只剩一行指针——粘一段五千行日志就只花一次文件读取，而不是几万 token。

**可配置**：在 pi 的 settings.json 里加 `attachments` 键（用户级 `<agentDir>/settings.json`，项目级 `<cwd>/.pi/settings.json` 覆盖它、且只在项目受信任时生效）：

```json
{ "attachments": { "pasteCollapseThreshold": 12000, "maxPendingAttachments": 32 } }
```

**运行时文案统一用英文**——其中折叠标记会直接进入你的提示词（和 `[Attached files]` 一样），所以必须语言中立；命令说明和通知也跟着统一，避免同一个包中英混排。

发布：已发布在 npm（`pi install npm:pi-attachments`）与 [GitHub](https://github.com/qddfxp/pi-attachments)。发新版：`npm version patch && git push --follow-tags && npm publish`；改动历史见 `CHANGELOG.md`。
