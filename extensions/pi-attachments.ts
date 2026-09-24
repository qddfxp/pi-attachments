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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Marks the path listing appended to an outgoing message. Matches the pi-web UI. */
export const ATTACHMENT_BLOCK_HEADER = "[Attached files]";
export const STATUS_KEY = "pi-attachments";

/** Same budget pi uses for inline images; anything larger stays a path reference. */
export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_CANDIDATE_LENGTH = 4096;
const MAX_PICKER_ENTRIES = 200;
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

export function isShellOrCommandInput(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("!") || trimmed.startsWith("/");
}

function toImageContent(attachment: Attachment): ImageContent | null {
  if (!attachment.image || attachment.size > MAX_IMAGE_BYTES) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(attachment.path);
  } catch {
    return null;
  }
  // Trust the magic bytes over the file name.
  const mimeType = sniffImageMimeType(bytes);
  if (!mimeType || bytes.length > MAX_IMAGE_BYTES) return null;
  return { type: "image", data: bytes.toString("base64"), mimeType };
}

function listFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_PICKER_ENTRIES);
  } catch {
    return [];
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

    const parsed = extractAttachments(event.text, ctx.cwd);
    const attachments = dedupeAttachments([...pending, ...parsed.files]);
    if (attachments.length === 0) return { action: "continue" };

    // A shell command or slash command is executed literally; attachment paths
    // must never become part of that string.
    if (isShellOrCommandInput(event.text)) {
      ctx.ui.notify("附件不能和 ! / / 命令一起发送，请先移除路径或 /attachments clear", "warning");
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
      ctx.ui.notify(`${keptAsPath.join(", ")}：不是可内联的图片或超过 4.5MB，按路径交给模型`, "warning");
    }

    const text = buildPrompt(parsed.text, files);
    if (!text && images.length === 0) return { action: "continue" };

    const mergedImages = [...(event.images ?? []), ...images];
    return mergedImages.length > 0
      ? { action: "transform", text, images: mergedImages }
      : { action: "transform", text };
  });

  pi.registerCommand("attach", {
    description: "把文件附加到下一条消息（不拖拽的替代方式）",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const files = listFiles(completionCwd);
      const matches = files
        .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((name) => ({ value: name, label: name }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim();
      const chosen = requested || await ctx.ui.select(
        "选择要附加的文件（当前目录）",
        listFiles(ctx.cwd),
      );
      if (!chosen) return;

      const attachment = resolveCandidate(chosen, ctx.cwd)
        ?? resolveCandidate(`./${chosen}`, ctx.cwd);
      if (!attachment) {
        ctx.ui.notify(`找不到文件：${chosen}`, "error");
        return;
      }
      pending = dedupeAttachments([...pending, attachment]);
      refreshStatus(ctx);
      ctx.ui.notify(`已附加 ${attachment.name}`, "info");
    },
  });

  pi.registerCommand("attachments", {
    description: "查看或清空待发附件（/attachments clear）",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => (
      "clear".startsWith(prefix.toLowerCase()) ? [{ value: "clear", label: "clear" }] : null
    ),
    handler: async (args, ctx) => {
      if (args.trim() === "clear") {
        const cleared = pending.length;
        pending = [];
        refreshStatus(ctx);
        ctx.ui.notify(cleared > 0 ? `已清空 ${cleared} 个附件` : "当前没有待发附件", "info");
        return;
      }
      if (pending.length === 0) {
        ctx.ui.notify("当前没有待发附件。把文件拖进终端，或用 /attach 添加。", "info");
        return;
      }
      ctx.ui.notify(pending.map((file) => `${file.name} — ${file.path}`).join("\n"), "info");
    },
  });
}
