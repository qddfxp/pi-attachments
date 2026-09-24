/**
 * pi-attachments — dropped files become real attachments.
 *
 * Dragging a file into a terminal only inserts its path as text, so the model has
 * to notice the path and decide to read it. This extension turns that path back
 * into an attachment:
 *
 *   - images  → attached as real image blocks, so the model sees them immediately
 *   - others  → listed in an `[Attached files]` block the model reads on demand
 *
 * The message body is only rewritten when it is nothing but the paths, so pasting
 * a log full of absolute paths leaves that log intact. Only deliberate references
 * are converted (absolute paths, `@./x`, `./x`, `../x`, `~/x`), so mentioning
 * `src/index.ts` in a sentence stays text.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Marks the path listing appended to an outgoing message. Matches the pi-web UI. */
export const ATTACHMENT_BLOCK_HEADER = "[Attached files]";
export const STATUS_KEY = "pi-attachments";
/** Where collapsed pastes land, next to the other per-session attachments. */
export const ATTACHMENTS_DIRECTORY = ".pi-attachments";

/**
 * Sanity bound only — not a budget. pi core runs every prompt image through
 * `_normalizePromptImages` (normalize + downscale, honouring the `images.autoResize`
 * setting) after the input transform, so an oversized screenshot is resized by the
 * core rather than refused here. This just stops a pathological file from being read
 * into memory at all.
 */
export const MAX_IMAGE_READ_BYTES = 32 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_CANDIDATE_LENGTH = 4096;
const MAX_PICKER_ENTRIES = 200;
/** Queueing hundreds of files helps nobody; the block would dwarf the message. */
export const MAX_PENDING_ATTACHMENTS = 32;
/** Longest queue `/attachments` prints before summarising the rest. */
export const MAX_LISTED_ATTACHMENTS = 20;
/**
 * A pasted build log can contain thousands of path-like tokens, and every
 * candidate that survives the cheap checks costs a synchronous `stat`. Stop
 * resolving after this many so input never stalls (measured: 8000 candidates
 * cost ~650ms before this cap, ~20ms after).
 */
export const MAX_RESOLVE_CANDIDATES = 256;
/** Guards against a long run of trailing wrappers turning into endless attempts. */
const MAX_VARIANTS_PER_CANDIDATE = 32;

export interface Attachment {
  path: string;
  name: string;
  size: number;
  /** True when the extension suggests this is an inlineable image. */
  image: boolean;
}

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

// ─── Settings ───────────────────────────────────────────────────────────────

/**
 * Optional `attachments` key in pi's `settings.json`:
 *
 *   { "attachments": { "pasteCollapseThreshold": 12000, "maxPendingAttachments": 32 } }
 *
 * Project settings (`<cwd>/<CONFIG_DIR_NAME>/settings.json`) win over user settings
 * (`<agentDir>/settings.json`), and project settings are only honoured for a trusted
 * project — the same rule pi applies to project-local resources.
 */
export interface AttachmentSettings {
  /** Character count above which a pasted blob is written to a file. 0 disables it. */
  pasteCollapseThreshold: number;
  /** How many files `/attach` may queue before it starts refusing. */
  maxPendingAttachments: number;
}

export const DEFAULT_ATTACHMENT_SETTINGS: AttachmentSettings = {
  // Well past a long code review comment, well below a pasted build log.
  pasteCollapseThreshold: 12000,
  maxPendingAttachments: MAX_PENDING_ATTACHMENTS,
};

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/** Merges settings layers in order; later layers win. Unknown keys are ignored. */
export function mergeAttachmentSettings(...layers: unknown[]): AttachmentSettings {
  const merged = { ...DEFAULT_ATTACHMENT_SETTINGS };
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    const source = layer as Record<string, unknown>;
    if ("pasteCollapseThreshold" in source) {
      merged.pasteCollapseThreshold = nonNegativeInteger(
        source.pasteCollapseThreshold,
        merged.pasteCollapseThreshold,
      );
    }
    if ("maxPendingAttachments" in source) {
      merged.maxPendingAttachments = nonNegativeInteger(
        source.maxPendingAttachments,
        merged.maxPendingAttachments,
      );
    }
  }
  return merged;
}

function readAttachmentsKey(filePath: string): unknown {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { attachments?: unknown };
    return parsed?.attachments;
  } catch {
    return undefined;
  }
}

/** Caches parsed settings per file until its mtime changes. */
function createSettingsReader(): (filePath: string) => unknown {
  const cache = new Map<string, { mtimeMs: number; value: unknown }>();
  return (filePath: string) => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      cache.delete(filePath);
      return undefined;
    }
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.value;
    const value = readAttachmentsKey(filePath);
    cache.set(filePath, { mtimeMs, value });
    return value;
  };
}

// ─── Clipboard files ────────────────────────────────────────────────────────

/**
 * Turns a clipboard dump into candidate paths.
 *
 * Accepts the three shapes the platform helpers produce: a plain path per line
 * (PowerShell's FileDropList), `file://` URIs (Linux `text/uri-list`), and a single
 * POSIX path. Pure, so the parsing is testable without a clipboard.
 */
export function parseClipboardFileList(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let candidate = trimmed;
    if (/^file:\/\//i.test(trimmed)) {
      try {
        candidate = decodeURIComponent(new URL(trimmed).pathname);
      } catch {
        continue;
      }
      // `file:///C:/x/y` — drop the leading slash Windows does not want.
      if (/^\/[a-zA-Z]:/.test(candidate)) candidate = candidate.slice(1);
    }
    if (candidate && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

function runQuietly(command: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((done) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      done(error && !stdout ? "" : String(stdout ?? ""));
    });
  });
}

/**
 * File paths currently on the OS clipboard.
 *
 * Every platform needs an external helper and none is guaranteed to be installed,
 * so any failure degrades to "no clipboard files" instead of throwing.
 */
export async function readClipboardFiles(): Promise<string[]> {
  let raw = "";
  if (process.platform === "win32") {
    raw = await runQuietly("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }",
    ]);
  } else if (process.platform === "darwin") {
    raw = await runQuietly("osascript", ["-e", "POSIX path of (the clipboard as alias)"]);
  } else {
    raw = await runQuietly("wl-paste", ["--type", "text/uri-list"]);
    if (!raw) raw = await runQuietly("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]);
  }

  return parseClipboardFileList(raw).filter((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

// ─── Collapsing a long paste ────────────────────────────────────────────────

/** True when the message is long enough that a file reference beats sending it all. */
export function shouldCollapsePaste(text: string, threshold: number): boolean {
  return threshold > 0 && text.trim().length > threshold;
}

/**
 * Local time, so a paste file name lines up with the clock the user is reading.
 * Second precision; two pastes inside the same second are disambiguated by the
 * write loop in `writePasteFile`.
 */
export function pasteFileName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `paste-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
}

/**
 * Writes a collapsed paste into the session's attachment directory, so the model
 * reads only the part it needs and the transcript keeps a stable pointer.
 */
export function writePasteFile(cwd: string, text: string, now = new Date()): Attachment | null {
  try {
    const directory = join(cwd, ATTACHMENTS_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    const gitignorePath = join(directory, ".gitignore");
    if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, "*\n", { flag: "wx" });

    const stem = pasteFileName(now).replace(/\.txt$/, "");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = `${stem}${attempt === 0 ? "" : `-${attempt}`}.txt`;
      const destination = join(directory, name);
      try {
        writeFileSync(destination, text, { flag: "wx" });
        return { path: destination, name, size: Buffer.byteLength(text), image: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** A path written straight into the message, with its offset for removal. */
interface CandidateToken {
  /** Span in the original text: quotes and escape backslashes included. */
  start: number;
  end: number;
  /** The candidate as written (`C:\My Files\a.pdf`), quotes and escapes resolved. */
  text: string;
}

/** Punctuation glued to a dropped path by the surrounding sentence. */
const LEADING_PUNCTUATION = "([{\"'";
const TRAILING_PUNCTUATION = ")]}\"',.;:!?，。；：！？、";

/**
 * Splits input into quoted strings and whitespace-delimited runs, then rejoins
 * runs that were split by a shell-style escaped space (`C:\My\ Files\a.pdf`).
 */
export function scanCandidateTokens(text: string): CandidateToken[] {
  const tokens: CandidateToken[] = [];
  const pattern = /"([^"\n]+)"|'([^'\n]+)'|(\S+)/g;

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const quoted = match[1] ?? match[2];
    if (quoted !== undefined) {
      tokens.push({ start: match.index, end: match.index + match[0].length, text: quoted });
      continue;
    }
    const bare = match[3];
    if (bare === undefined) continue;
    tokens.push({ start: match.index, end: match.index + match[0].length, text: bare });
  }

  const merged: CandidateToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let current = tokens[index];
    if (!current) continue;
    let next = tokens[index + 1];
    // A shell-style escaped space splits `C:\My\ Files\a.pdf` into two runs that
    // belong to one path, so join them back together.
    while (
      next !== undefined
      && current.text.endsWith("\\")
      && text[current.end] === " "
      && text[current.end + 1] !== undefined
      && next.start === current.end + 1
    ) {
      index += 1;
      current = {
        start: current.start,
        end: next.end,
        text: `${current.text.slice(0, -1)} ${next.text}`,
      };
      next = tokens[index + 1];
    }
    merged.push(current);
  }

  return merged;
}

/**
 * True only for references the user clearly meant as a file: an absolute path, or
 * an explicitly marked relative one. A bare `src/index.ts` is left alone because
 * it is indistinguishable from ordinary prose.
 */
export function isDeliberatePathReference(candidate: string): boolean {
  if (!candidate || candidate.length > MAX_CANDIDATE_LENGTH) return false;
  if (/[\n\r\0]/.test(candidate)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) return false; // http(s)://, file://
  const value = candidate.startsWith("@") ? candidate.slice(1) : candidate;
  if (!value) return false;
  return isAbsolute(value)
    || value.startsWith("./")
    || value.startsWith(".\\")
    || value.startsWith("../")
    || value.startsWith("..\\")
    || value.startsWith("~/")
    || value.startsWith("~\\");
}

export function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Resolves a written reference to an existing file, or null when it is not one. */
export function resolveCandidate(candidate: string, cwd: string): Attachment | null {
  if (!isDeliberatePathReference(candidate)) return null;
  const raw = candidate.startsWith("@") ? candidate.slice(1) : candidate;

  let absolute: string;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    absolute = resolve(homedir(), raw.slice(2));
  } else if (isAbsolute(raw)) {
    absolute = raw;
  } else {
    absolute = resolve(cwd, raw);
  }

  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return null;
    return {
      path: absolute,
      name: basename(absolute),
      size: stat.size,
      image: IMAGE_EXTENSIONS.has(extname(absolute).toLowerCase()),
    };
  } catch {
    return null;
  }
}

/** A resolved candidate: the attachment plus how much of the text it consumed. */
interface ResolvedSpan {
  attachment: Attachment;
  /** Characters of the candidate consumed as the path. */
  length: number;
  /** Leading punctuation kept as prose. */
  leading: number;
}

/**
 * Yields progressively trimmed versions of a candidate, longest first.
 *
 * Sentence punctuation (`看下 <path>?`) and compiler/log locations
 * (`src/main.ts:12:5`) both wrap a path, and they can be nested
 * (`(src/main.ts:12:5)`), so the two are stripped alternately until neither
 * applies. Trimming only happens while resolution keeps failing, so a file name
 * that itself contains `.` or `:2` still wins.
 */
function* resolveVariants(body: string): Generator<{ text: string; length: number }> {
  let current = body;
  yield { text: current, length: current.length };

  while (current.length > 1) {
    const last = current[current.length - 1];
    if (last !== undefined && TRAILING_PUNCTUATION.includes(last)) {
      current = current.slice(0, -1);
      yield { text: current, length: current.length };
      continue;
    }
    const trimmed = /^(.*?):\d+(?::\d+)?$/.exec(current)?.[1];
    if (trimmed !== undefined && trimmed.length > 0) {
      current = trimmed;
      yield { text: current, length: current.length };
      continue;
    }
    break;
  }
}

/**
 * Resolves a candidate the way a sentence wraps a path: `看下 <path>?` and
 * `(<path>)` are both attempts on the path inside, and the surrounding
 * punctuation stays in the message.
 */
function resolveWithPunctuation(candidate: string, cwd: string): ResolvedSpan | null {
  for (let leading = 0; leading <= 2 && leading < candidate.length; leading += 1) {
    if (leading > 0) {
      const skipped = candidate[leading - 1];
      if (skipped === undefined || !LEADING_PUNCTUATION.includes(skipped)) break;
    }
    let attempts = 0;
    for (const variant of resolveVariants(candidate.slice(leading))) {
      attempts += 1;
      // A pathological run of wrappers must not turn into thousands of stat calls.
      if (attempts > MAX_VARIANTS_PER_CANDIDATE) break;
      const attachment = resolveCandidate(variant.text, cwd);
      if (attachment) return { attachment, length: variant.length, leading };
    }
  }
  return null;
}

/**
 * Pulls every deliberate file reference out of the text.
 *
 * The message body is only rewritten when it is *nothing but* the paths — the
 * "dropped files and pressed Enter" gesture. In that case each path becomes an
 * `[image: name]` marker (images) or disappears into the `[Attached files]` block.
 * Otherwise the user's words are left exactly as typed: pasting a log full of
 * absolute paths must not tear those paths out of it, and the attachment is
 * carried by the block instead.
 *
 * Returned `files` are de-duplicated by path, and resolution stops after
 * `MAX_RESOLVE_CANDIDATES` tokens so a huge paste stays fast.
 */
export function extractAttachments(text: string, cwd: string): { text: string; files: Attachment[] } {
  const matches: Array<{ attachment: Attachment; from: number; to: number }> = [];

  let examined = 0;
  for (const token of scanCandidateTokens(text)) {
    if (examined >= MAX_RESOLVE_CANDIDATES) break;
    examined += 1;

    const resolved = resolveWithPunctuation(token.text, cwd);
    if (!resolved) continue;

    // Quotes and escaped spaces make the written span differ from the candidate
    // text, so those tokens can only be consumed whole.
    const writtenAsIs = token.end - token.start === token.text.length;
    if (!writtenAsIs && (resolved.leading !== 0 || resolved.length !== token.text.length)) continue;

    matches.push({
      attachment: resolved.attachment,
      from: writtenAsIs ? token.start + resolved.leading : token.start,
      to: writtenAsIs ? token.start + resolved.leading + resolved.length : token.end,
    });
  }
  if (matches.length === 0) return { text, files: [] };

  const files = dedupeAttachments(matches.map((match) => match.attachment));

  let remainder = "";
  let cursor = 0;
  for (const match of matches) {
    remainder += text.slice(cursor, match.from);
    cursor = match.to;
  }
  remainder += text.slice(cursor);
  if (!isOnlyPunctuation(remainder)) return { text, files };

  let result = "";
  cursor = 0;
  for (const match of matches) {
    result += text.slice(cursor, match.from);
    result += match.attachment.image ? `[image: ${match.attachment.name}]` : "";
    cursor = match.to;
  }

  const cleaned = tidyWhitespace(`${result}${text.slice(cursor)}`);
  return {
    // `(C:\work\a.pdf)` leaves nothing but brackets behind; the block carries it.
    text: isOnlyPunctuation(cleaned) ? "" : cleaned,
    files,
  };
}

/** Whitespace and punctuation only — the wrappers a path can be written inside. */
function isOnlyPunctuation(value: string): boolean {
  return /^[\s\p{P}]*$/u.test(value);
}

function tidyWhitespace(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function dedupeAttachments(files: Attachment[]): Attachment[] {
  const seen = new Set<string>();
  const unique: Attachment[] = [];
  for (const file of files) {
    const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(file);
  }
  return unique;
}

/** Appends the path listing, leaving the user's own words untouched. */
export function buildPrompt(message: string, files: Attachment[]): string {
  const body = message.trim();
  if (files.length === 0) return body;
  const listing = files.map((file) => `- ${file.path}`).join("\n");
  const block = `${ATTACHMENT_BLOCK_HEADER}\n${listing}`;
  return body ? `${body}\n\n${block}` : block;
}

/**
 * `!cmd` runs in the shell and `/cmd` is expanded as a command; neither may carry
 * an attachment.
 *
 * A leading slash alone is not enough to call something a command: on POSIX every
 * absolute path starts with `/`. A command name has no further separator and no
 * file behind it, so `/tmp/out/notes.md` stays a path while `/copy` stays a command.
 */
const COMMAND_SHAPE = /^\/[^\s/\\]*(?:\s|$)/;

export function isShellOrCommandInput(text: string, cwd: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("!")) return true;
  if (!COMMAND_SHAPE.test(trimmed)) return false;

  // A real file at that exact path wins over the command reading.
  const [firstToken] = scanCandidateTokens(trimmed);
  if (!firstToken || firstToken.start !== 0) return true;
  return resolveCandidate(firstToken.text, cwd) === null;
}

/** True when the file should be attached as an image instead of a path reference. */
export function isInlineableImage(attachment: Attachment): boolean {
  return attachment.image && attachment.size <= MAX_IMAGE_READ_BYTES;
}

function toImageContent(attachment: Attachment): ImageContent | null {
  if (!isInlineableImage(attachment)) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(attachment.path);
  } catch {
    return null;
  }
  // Trust the magic bytes over the file name; the core handles resizing.
  const mimeType = sniffImageMimeType(bytes);
  if (!mimeType || bytes.length > MAX_IMAGE_READ_BYTES) return null;
  return { type: "image", data: bytes.toString("base64"), mimeType };
}

/**
 * Picker labels for clipboard entries. Two files with the same name in different
 * folders must stay tellable apart, so the parent folder goes in the label — and a
 * pair that is still identical gets a positional suffix.
 */
export function formatClipboardLabels(files: Attachment[]): string[] {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const label = `📋 ${file.name}  (${basename(dirname(file.path))})`;
    const count = seen.get(label) ?? 0;
    seen.set(label, count + 1);
    return count === 0 ? label : `${label} #${count + 1}`;
  });
}

/** Human-readable size, so a message can never drift from the constant it describes. */
export function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${Number(mib.toFixed(mib < 10 ? 1 : 0))} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

function listFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      // `Dirent.isFile()` is an lstat, so a symlink to a file reports false and
      // would silently never be offered. Follow the link instead.
      .filter((entry) => isFileOnDisk(join(directory, entry.name)))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function isFileOnDisk(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export default function piAttachments(pi: ExtensionAPI): void {
  let pending: Attachment[] = [];
  /**
   * `getArgumentCompletions` is called without a context, so the session cwd is
   * remembered here. Without it the picker would list one directory while the
   * handler resolves against another, and a chosen file would fail to attach.
   */
  let completionCwd = process.cwd();

  const readSettingsFile = createSettingsReader();
  const settingsFor = (ctx: ExtensionContext): AttachmentSettings => mergeAttachmentSettings(
    readSettingsFile(join(getAgentDir(), "settings.json")),
    ctx.isProjectTrusted() ? readSettingsFile(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) : undefined,
  );

  const refreshStatus = (ctx: ExtensionContext): void => {
    if (pending.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, `📎 ${pending.length}: ${pending.map((file) => file.name).join(", ")}`);
  };

  pi.on("session_start", (_event, ctx) => {
    completionCwd = ctx.cwd;
    pending = [];
    refreshStatus(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const settings = settingsFor(ctx);

    const parsed = extractAttachments(event.text, ctx.cwd);
    const detected = [...parsed.files];
    let body = parsed.text;

    // A shell command or slash command is executed literally; attachment paths must
    // never become part of that string. This is judged *before* collapsing, or a long
    // command would leave a paste file behind that nothing ever references.
    const isCommand = isShellOrCommandInput(event.text, ctx.cwd);

    // A blob too long to be worth sending inline becomes a file the model opens
    // on demand — the same trade the attachment block already makes for files.
    if (!isCommand && shouldCollapsePaste(body, settings.pasteCollapseThreshold)) {
      const collapsed = writePasteFile(ctx.cwd, body);
      if (collapsed) {
        detected.push(collapsed);
        body = `[pasted content ${body.trim().length} chars, collapsed into ${collapsed.name}]`;
        ctx.ui.notify(`Long paste saved as ${collapsed.name} (${collapsed.size} bytes)`, "info");
      }
    }

    const attachments = dedupeAttachments([...pending, ...detected]);
    if (attachments.length === 0) return { action: "continue" };

    if (isCommand) {
      ctx.ui.notify(
        "Attachments are not sent with ! or / commands. Send them in a normal message, or /attachments clear.",
        "warning",
      );
      return { action: "continue" };
    }

    pending = [];
    refreshStatus(ctx);

    const images: ImageContent[] = [];
    const files: Attachment[] = [];
    const keptAsPath: string[] = [];
    for (const attachment of attachments) {
      if (!attachment.image) {
        files.push(attachment);
        continue;
      }
      const content = toImageContent(attachment);
      if (content) images.push(content);
      else {
        keptAsPath.push(attachment.name);
        files.push(attachment);
      }
    }
    if (keptAsPath.length > 0) {
      ctx.ui.notify(
        `${keptAsPath.join(", ")}: not an image on inspection, or over ${formatBytes(MAX_IMAGE_READ_BYTES)} — passed on as a path`,
        "warning",
      );
    }

    const text = buildPrompt(body, files);
    if (!text && images.length === 0) return { action: "continue" };

    const mergedImages = [...(event.images ?? []), ...images];
    return mergedImages.length > 0
      ? { action: "transform", text, images: mergedImages }
      : { action: "transform", text };
  });

  pi.registerCommand("attach", {
    description: "Attach a file to the next message (drag-and-drop alternative)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const files = listFiles(completionCwd)
        .slice(0, MAX_PICKER_ENTRIES);
      const matches = files
        .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((name) => ({ value: name, label: name }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim();
      // Files copied in Explorer/Finder arrive as a clipboard file list; offer them
      // first, because a drop target is not always reachable. Spawning the platform
      // helper costs ~0.5s, so let it run while the directory is listed.
      const clipboardRead = requested
        ? Promise.resolve<string[]>([])
        : readClipboardFiles();
      const files = requested ? [] : listFiles(ctx.cwd);

      let chosen = requested;
      if (!chosen) {
        const fromClipboard = (await clipboardRead)
          .map((filePath) => resolveCandidate(filePath, ctx.cwd))
          .filter((file): file is Attachment => file !== null);
        const clipboardLabels = formatClipboardLabels(fromClipboard);
        const shown = files.slice(0, MAX_PICKER_ENTRIES);
        const options = [...clipboardLabels, ...shown];
        if (options.length === 0) {
          ctx.ui.notify("No files in this directory and no file paths on the clipboard", "warning");
          return;
        }
        const title = files.length > shown.length
          ? `Choose a file to attach (${files.length} here, first ${shown.length} listed)`
          : "Choose a file to attach (session directory)";
        const picked = await ctx.ui.select(title, options);
        if (!picked) return;
        // Look the pick up by position: two same-named files in different folders
        // produce different labels, and `find` on the label would always hit the first.
        const clipboardIndex = clipboardLabels.indexOf(picked);
        const clipboardPick = clipboardIndex >= 0 ? fromClipboard[clipboardIndex] : undefined;
        chosen = clipboardPick?.path ?? picked;
      }
      if (!chosen) return;

      const attachment = resolveCandidate(chosen, ctx.cwd)
        ?? resolveCandidate(`./${chosen}`, ctx.cwd);
      if (!attachment) {
        ctx.ui.notify(`No such file: ${chosen}`, "error");
        return;
      }
      const limit = settingsFor(ctx).maxPendingAttachments;
      const next = dedupeAttachments([...pending, attachment]);
      if (next.length > limit) {
        ctx.ui.notify(`Queue is full (${limit} files). Send them, or /attachments clear.`, "warning");
        return;
      }
      pending = next;
      refreshStatus(ctx);
      ctx.ui.notify(`Attached ${attachment.name}`, "info");
    },
  });

  pi.registerCommand("attachments", {
    description: "Show or clear the files queued for the next message (/attachments clear)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => (
      "clear".startsWith(prefix.toLowerCase()) ? [{ value: "clear", label: "clear" }] : null
    ),
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "clear") {
        const cleared = pending.length;
        pending = [];
        refreshStatus(ctx);
        ctx.ui.notify(cleared > 0 ? `Cleared ${cleared} pending attachment(s)` : "Nothing is queued", "info");
        return;
      }
      if (pending.length === 0) {
        ctx.ui.notify("Nothing is queued. Drop a file into the terminal, or use /attach.", "info");
        return;
      }
      const shown = pending.slice(0, MAX_LISTED_ATTACHMENTS);
      const lines = shown.map((file) => `${file.name} — ${file.path}`);
      if (pending.length > shown.length) {
        lines.push(`…and ${pending.length - shown.length} more (/attachments clear)`)
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
