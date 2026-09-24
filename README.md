# pi-attachments

[![npm version](https://img.shields.io/npm/v/pi-attachments.svg)](https://www.npmjs.com/package/pi-attachments)
[![CI](https://github.com/qddfxp/pi-attachments/actions/workflows/ci.yml/badge.svg)](https://github.com/qddfxp/pi-attachments/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-attachments.svg)](LICENSE)

把文件拖进 [pi](https://github.com/earendil-works/pi) 的输入框，它会变成**真正的附件**——而不是一串等着模型自己去注意、去猜、去决定读不读的路径。

- **图片**直接作为图片内容附上，模型第一轮就看得见，不用工具往返。
- **其他文件**列在末尾的 `[Attached files]` 块里，作为路径交模型按需打开。
- **超长粘贴**自动折叠成文件，五千行日志只花一次读取，而不是几万 token。

```
你输入的内容                                     →  模型收到的内容
──────────────────────────────────────────────────────────────────────────
看看这个 C:\work\screenshot.png 对不对?           →  正文不动（＋图片内容）
Look at C:\work\screenshot.png, is it right?     →  正文不动（＋图片内容）
C:\work\screenshot.png                           →  [attachment: screenshot.png]
总结一下 C:\work\report.pdf                      →  正文不动（＋末尾一个块）
C:\work\report.pdf                               →  只有块

                                                    [Attached files]
                                                    - C:\work\report.pdf
```

## 目录

- [快速开始](#快速开始)
- [用法](#用法)
- [什么算文件引用](#什么算文件引用)
- [正文什么时候会被改写](#正文什么时候会被改写)
- [长粘贴折叠](#长粘贴折叠)
- [设置](#设置)
- [限制](#限制)
- [常见问题](#常见问题)
- [工作原理](#工作原理)
- [开发](#开发)
- [发版](#发版)
- [许可证](#许可证)
- [English version](#english-version)

## 快速开始

**1. 安装**

```bash
pi install npm:pi-attachments
# 或：pi install git:github.com/qddfxp/pi-attachments
# 或：pi install /绝对路径/pi-attachments
```

**2. 确认装上了**

```bash
pi list        # 列表里应该有 pi-attachments
pi             # 进入会话
> /attach      # 弹出文件选择器 = 扩展已加载；没加载 pi 会提示未知命令
```

**3. 附上第一个文件**

| 方式 | 怎么用 |
|---|---|
| 把文件拖到终端里，回车 | 最直接，路径直接变成附件 |
| 输入 `/attach` 选文件 | 剪贴板里的文件排最前，然后是会话目录 |
| 在资源管理器里复制文件，再 `/attach` | 剪贴板文件带 `📋` 前缀排在最前 |

有等待发送的文件时，页脚显示 `📎 1: screenshot.png`；`/attachments` 查看队列，`/attachments clear` 清空。

想先试不装：`pi -e /绝对路径/pi-attachments`。

升级与卸载：

```bash
pi update --extensions
pi remove npm:pi-attachments
```

## 用法

| 你做什么 | 结果 |
|---|---|
| 把文件拖到终端 | 发送时路径变成附件 |
| 粘贴一段路径 | 一样；带引号的路径、`C:\My\ Files\a.pdf` 这种转义空格都认 |
| `/attach` | 选文件：剪贴板文件在前，然后是会话目录 |
| `/attach ./notes.md` | 附加指定路径 |
| `/attachments` | 查看下一条消息会带什么 |
| `/attachments clear` | 清空队列 |

## 什么算文件引用

只转换**你明显是想当文件写**的那些：

| 会识别 | 不识别 |
|---|---|
| `C:\work\a.pdf`、`/home/me/a.pdf` | `src/index.ts`（和散文无法区分） |
| `@./notes.md` | `@notes.md` |
| `./notes.md`、`../notes.md` | `https://example.com/a.png` |
| `.\notes.md`、`..\notes.md`（Windows） | 不存在的路径 |
| `~/notes.md` | |
| `"C:\My Files\a.pdf"` 和 `C:\My\ Files\a.pdf` | |
| `./src/main.ts:12:5`（解析成 `./src/main.ts`） | `src/main.ts:12:5` |

句尾标点会留在你的句子里，路径外面的引号和括号也能正确理解。`:行:列` 后缀只在**绝对路径或显式标记的相对路径**上生效——裸写的 `src/main.ts:12:5` 和 `src/index.ts` 一样算散文。

## 正文什么时候会被改写

只有在**整条消息全是路径**时才会动你的正文（就是"拖完文件直接回车"那种手势）：

- 图片变成 `[attachment: name]`（措辞保持中立，因为嗅探仍可能判定它不是图片），其余进入 `[Attached files]` 块
- 带字的消息原样保留，块追加在下面
- 所以粘贴一堆绝对路径的堆栈/构建日志**不会**被抠走路径——它们留在原地，同时也被当作附件提供

**附件永远不会跟着 `!` shell 命令或 `/` 命令发送**——shell 命令里的路径会被执行，所以扩展会拒绝并告警。

## 长粘贴折叠

超过 `pasteCollapseThreshold`（默认 12000 字符）的消息会写入 `<cwd>/.pi-attachments/paste-<时间戳>.txt`，正文里只剩一行指针——粘一段五千行构建日志只花一次文件读取，而不是几万 token。该目录会自我忽略（git 看不到），文件本身也会进附件块，让模型知道该去打开它。把阈值设成 `0` 就是全部内联发送。

## 设置

pi 的 settings 里可选的 `attachments` 键：

| 级别 | 文件 | 说明 |
|---|---|---|
| 用户级 | `<agentDir>/settings.json` | 例如 `~/.pi/agent/settings.json` |
| 项目级 | `<cwd>/.pi/settings.json` | 覆盖用户级，且**仅在项目受信任时**生效 |

```json
{
  "attachments": {
    "pasteCollapseThreshold": 12000,
    "maxPendingAttachments": 32
  }
}
```

非法值会被忽略而不是报错；文件改动后设置会重新读取，不需要重启。

## 限制

- 图片一律内联，**缩放交给 pi 内核**（`images.autoResize` 设置），超大截图由 pi 降采样，而不是在这里被拒。内容确实不是图片、或超过 32 MiB 的文件退回按路径交给模型，并会告诉你。
- 单条消息最多内联 **128 MiB** 图片数据，超出部分走路径。队列能放 32 个文件，只按单个文件设限的话，最坏仍会把近 1 GiB 读进内存。
- 除了折叠的粘贴，不会复制任何东西。模型读的是文件的真实位置，所以文件必须在会话工作目录内，agent 才打得开。
- 文件内容**从不内联进提示词**——给的是路径，模型按需打开。这样 200 KB 的日志不会变成几万 token，模型也能直接跳到相关部分，而不是读一份被截断的副本。
- 单条消息最多解析 **256 个候选路径**。粘贴构建日志就是最坏情况：8000 个候选在加上限前要 650 ms，加后 11 ms，而且正文本身不会被改动。
- `/attach` 队列上限 **32 个**（可配置），`/attachments` 先列前 20 个再汇总其余。几百条路径的块会把消息本身淹没。

## 常见问题

**拖了文件没反应。** 看页脚——没有 `📎` 就说明路径没被识别。文件必须按你写的方式真实存在，而且像 `src/index.ts` 这种裸相对路径是**故意当作散文**的。改用 `./src/index.ts` 或 `/attach`。

**我粘的日志把路径丢了。** 不会——只有整条消息全是路径时才改写，带字的消息里每个路径都留在原处。

**模型拿到的是路径不是图片。** 可能是内容其实不是图片（文件名会骗人）、超过 32 MiB，或单条消息的 128 MiB 预算已经用完了。每次都会点名告警。

**附件在我用 `!` 或 `/` 时不见了。** 这是设计如此——shell 命令里的路径会被执行。请在普通消息里发送附件。

**它会上传我的文件吗？** 不会。没有任何网络代码，也不注册工具；唯一会写的文件是折叠出来的粘贴，就放在你的项目旁边。

## 工作原理

只有一个 `input` 事件处理函数。它扫描编辑器文本里的候选路径，逐个相对会话 cwd 解析，然后返回一个 transform：

```ts
{ action: "transform", text: "<你的话>", images: [{ type: "image", data, mimeType }] }
```

所有判断都走可测的纯函数（`extractAttachments`、`isShellOrCommandInput`、`sniffImageMimeType` 等），所以行为是被测试钉住的，而不是靠跑一遍 pi 才发现。

## 开发

```bash
npm install          # 只装类型；SDK 是 peer 依赖
npm run verify       # 类型检查 + 测试 + 用 pi 自己的加载器加载一次
```

`npm run check:load` 值得知道：它调用 SDK 的 `discoverAndLoadExtensions`——正是 `pi -e` 走的那条代码路径——所以跑通意味着 pi 真能发现这个扩展，而不只是能编译。

已在 SDK 0.85.1 和 0.87.1 上验证过。`peerDependencies` 写 `>=0.85.0`，因为那是实测能加载的最老版本；用到的接口（`input` 事件、`registerCommand`、`ui.setStatus`/`notify`/`select`）在这些版本里都有。

CI 在 Ubuntu **和** Windows 上跑 `npm run verify`。Windows 是刻意加的：反斜杠路径、盘符、大小写折叠去重这些在 Linux 上看不到——第一次 Linux 运行就抓到了"POSIX 绝对路径被当成斜杠命令"这个 bug。

## 发版

```bash
npm version patch          # 或 minor/major；会提交并打 vX.Y.Z 标签
git push --follow-tags
npm publish --access public
```

`.github/workflows/publish.yml` 可以在 `v*` 标签时从 CI 发布，并带 npm provenance。它需要仓库里有一个 `NPM_TOKEN` secret（granular access token，对所有包有 Read and write）；没有 secret 时该任务会**跳过自己**而不是失败。变更记录在 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE) © 2026 qddfxp

---

# English version

Drop a file into your [pi](https://github.com/earendil-works/pi) prompt and it arrives as a real
attachment, not as a path the model has to notice and decide to read.

- **Images** are attached as image content, so the model sees them on the first turn — no tool round-trip.
- **Any other file** is listed once under `[Attached files]`, as a path the model opens on demand.
- **Huge pastes** collapse into a file, so a 5,000-line build log costs one read instead of tens of thousands of tokens.

## Contents

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

## Quick start

**1. Install**

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
