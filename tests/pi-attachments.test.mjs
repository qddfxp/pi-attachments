import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import piAttachments, {
  ATTACHMENT_BLOCK_HEADER,
  MAX_RESOLVE_CANDIDATES,
  STATUS_KEY,
  buildPrompt,
  dedupeAttachments,
  extractAttachments,
  isDeliberatePathReference,
  isShellOrCommandInput,
  resolveCandidate,
  scanCandidateTokens,
  sniffImageMimeType,
} from "../extensions/pi-attachments.ts";

// A real 1x1 PNG: the magic bytes are what the extension sniffs.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** Space-free root: a dropped absolute path arrives unquoted when it has no spaces. */
const sandbox = mkdtempSync(join(tmpdir(), "pi-attachments-"));
const notesPath = join(sandbox, "notes.md");
const shotPath = join(sandbox, "shot.png");
const liarPath = join(sandbox, "liar.png");
/** A nested directory whose name and file name both contain spaces. */
const spacedDir = join(sandbox, "my files");
const spacedPath = join(spacedDir, "report final.txt");

writeFileSync(notesPath, "# notes\n");
writeFileSync(shotPath, Buffer.from(PNG_BASE64, "base64"));
// A `.png` name over text content: the magic-byte sniff must win.
writeFileSync(liarPath, "definitely not an image\n");
mkdirSync(spacedDir);
writeFileSync(spacedPath, "spaced\n");

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

function createStubPi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
}

function createStubCtx(cwd) {
  const notifications = [];
  const statuses = new Map();
  return {
    cwd,
    notifications,
    statuses,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus(key, text) {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      async select() {
        return undefined;
      },
    },
  };
}

function loadExtension() {
  const pi = createStubPi();
  piAttachments(pi);
  return {
    pi,
    input: pi.handlers.get("input"),
    sessionStart: pi.handlers.get("session_start"),
  };
}

test("only converts references the user clearly meant as files", () => {
  assert.equal(isDeliberatePathReference(notesPath), true);
  assert.equal(isDeliberatePathReference("/etc/hosts"), true);
  assert.equal(isDeliberatePathReference("@./notes.md"), true);
  assert.equal(isDeliberatePathReference("./notes.md"), true);
  assert.equal(isDeliberatePathReference("../notes.md"), true);
  assert.equal(isDeliberatePathReference("~/notes.md"), true);
  // Windows users write the same prefixes with backslashes.
  assert.equal(isDeliberatePathReference(".\\notes.md"), true);
  assert.equal(isDeliberatePathReference("..\\notes.md"), true);
  assert.equal(isDeliberatePathReference("@.\\notes.md"), true);

  // Prose that merely looks like a path stays prose.
  assert.equal(isDeliberatePathReference("src/index.ts"), false);
  assert.equal(isDeliberatePathReference("https://example.com/a.png"), false);
  assert.equal(isDeliberatePathReference(""), false);
});

test("a location suffix resolves only on an explicitly marked path", () => {
  // `src/main.ts:12:5` on its own is indistinguishable from prose, so the README
  // must not advertise it as accepted.
  assert.equal(isDeliberatePathReference("./src/main.ts:12:5"), true);
  assert.equal(isDeliberatePathReference("src/main.ts:12:5"), false);
});

test("scans quoted, bare, and escaped-space tokens", () => {
  // The scanner returns every token; resolution is what filters prose out.
  assert.deepEqual(
    scanCandidateTokens(`${notesPath} 和 ./x.md`).map((token) => token.text),
    [notesPath, "和", "./x.md"],
  );
  // Terminals quote a dropped path that contains spaces.
  assert.deepEqual(
    scanCandidateTokens(`"${spacedPath}"`).map((token) => token.text),
    [spacedPath],
  );
  assert.deepEqual(
    scanCandidateTokens(`'${spacedPath}'`).map((token) => token.text),
    [spacedPath],
  );
  // Shell-style escaping removes the quotes but must rejoin every split run.
  assert.deepEqual(
    scanCandidateTokens(spacedPath.replace(/ /g, "\\ ")).map((token) => token.text),
    [spacedPath],
  );
});

test("sniffs the image formats pi can inline", () => {
  assert.equal(sniffImageMimeType(Buffer.from(PNG_BASE64, "base64")), "image/png");
  assert.equal(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
  assert.equal(sniffImageMimeType(Buffer.from("GIF89a-----------")), "image/gif");
  assert.equal(sniffImageMimeType(Buffer.from("RIFF....WEBP")), "image/webp");
  assert.equal(sniffImageMimeType(Buffer.from("plain text content")), null);
  assert.equal(sniffImageMimeType(Buffer.from("short")), null);
});

test("extracts a path from a sentence without rewriting the sentence", () => {
  const parsed = extractAttachments(`看下这个 ${notesPath} 顺便总结`, sandbox);

  // Non-image paths stay where the user put them; the block only adds a signal.
  assert.equal(parsed.text, `看下这个 ${notesPath} 顺便总结`);
  assert.deepEqual(parsed.files.map((file) => file.path), [notesPath]);
  assert.equal(parsed.files[0].image, false);

  // Images behave the same: attached as pixels, wording untouched.
  const image = extractAttachments(`看下这个 ${shotPath} 顺便总结`, sandbox);
  assert.equal(image.text, `看下这个 ${shotPath} 顺便总结`);
  assert.equal(image.files[0].image, true);
});

test("a message that is nothing but paths becomes the attachment block", () => {
  const single = extractAttachments(`${notesPath}`, sandbox);
  assert.equal(single.text, "");
  assert.deepEqual(single.files.map((file) => file.name), ["notes.md"]);

  // A path with spaces only arrives quoted or escaped; both count as path-only.
  const several = extractAttachments(`${notesPath}\n"${spacedPath}"`, sandbox);
  assert.equal(several.text, "");
  assert.deepEqual(several.files.map((file) => file.name), ["notes.md", "report final.txt"]);

  const escaped = extractAttachments(spacedPath.replace(/ /g, "\\ "), sandbox);
  assert.equal(escaped.text, "");
  assert.deepEqual(escaped.files.map((file) => file.name), ["report final.txt"]);

  // An image dropped on its own leaves a short marker instead of a bare path.
  const imageOnly = extractAttachments(`${shotPath}`, sandbox);
  assert.equal(imageOnly.text, "[image: shot.png]");
});

test("leaves a log full of absolute paths alone", () => {
  const log = [
    `[12:00:01] ERROR in ${notesPath}:1 — build failed`,
    `  at Object.<anonymous> (${join(sandbox, "shot.png")}:3:1)`,
  ].join("\n");

  const parsed = extractAttachments(log, sandbox);

  assert.equal(parsed.text, log, "pasted logs must survive untouched");
  assert.deepEqual(
    parsed.files.map((file) => file.name),
    ["notes.md", "shot.png"],
    "compiler-style path:line:col locations resolve to the file",
  );
});

test("keeps the line number when the message carries a location", () => {
  const parsed = extractAttachments(`${notesPath}:12:5`, sandbox);

  assert.equal(parsed.text, `${notesPath}:12:5`, "the location is prose, not part of the path");
  assert.deepEqual(parsed.files.map((file) => file.name), ["notes.md"]);
});

test("keeps a short marker when only an image is dropped", () => {
  const parsed = extractAttachments(`${shotPath}?`, sandbox);

  assert.equal(parsed.text, "[image: shot.png]?");
  assert.deepEqual(parsed.files.map((file) => file.name), ["shot.png"]);
  assert.equal(parsed.files[0].image, true);
});

test("handles quotes and brackets around a dropped path", () => {
  const quoted = extractAttachments(`看下这个 "${spacedPath}" 谢谢`, sandbox);
  assert.equal(quoted.text, `看下这个 "${spacedPath}" 谢谢`, "the sentence is left as typed");
  assert.deepEqual(quoted.files.map((file) => file.name), ["report final.txt"]);

  // The whole message is the quoted path, so the quotes go with it.
  const quotedOnly = extractAttachments(`"${spacedPath}"`, sandbox);
  assert.equal(quotedOnly.text, "");
  assert.deepEqual(quotedOnly.files.map((file) => file.name), ["report final.txt"]);

  // Brackets wrapping nothing but the path leave no prose behind either.
  const bracketed = extractAttachments(`(${notesPath})`, sandbox);
  assert.equal(bracketed.text, "");
  assert.deepEqual(bracketed.files.map((file) => file.name), ["notes.md"]);

  // A path inside a sentence keeps its brackets, and so does the sentence.
  const bracketedInSentence = extractAttachments(`看下 (${notesPath}) 谢谢`, sandbox);
  assert.equal(bracketedInSentence.text, `看下 (${notesPath}) 谢谢`);
  assert.deepEqual(bracketedInSentence.files.map((file) => file.name), ["notes.md"]);
});

test("ignores bare relative names and missing files", () => {
  assert.deepEqual(extractAttachments("update notes.md please", sandbox), {
    text: "update notes.md please",
    files: [],
  });
  assert.deepEqual(extractAttachments(`missing ${join(sandbox, "nope.txt")}`, sandbox), {
    text: `missing ${join(sandbox, "nope.txt")}`,
    files: [],
  });
});

test("resolves relative, escaped, and home-relative references", () => {
  assert.equal(resolveCandidate(`./notes.md`, sandbox)?.path, notesPath);
  // `.\` and `..\` are separators only on Windows; the shape check is portable, the
  // resolution is not (on POSIX a backslash is an ordinary file-name character).
  assert.equal(isDeliberatePathReference(".\\notes.md"), true);
  assert.equal(isDeliberatePathReference("..\\notes.md"), true);
  if (sep === "\\") {
    assert.equal(resolveCandidate(`.\\notes.md`, sandbox)?.path, notesPath);
  }
  // `@name` alone is not a path reference, but `@./name` is.
  assert.equal(resolveCandidate("@notes.md", sandbox), null);
  assert.equal(resolveCandidate("@./notes.md", sandbox)?.path, notesPath);
});

test("reports each path once even when the message repeats it", () => {
  const parsed = extractAttachments(`${notesPath}\n${notesPath}`, sandbox);

  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.text, "", "both written copies are still consumed");
});

test("stops resolving after the candidate cap instead of stalling", () => {
  const many = join(sandbox, "many");
  mkdirSync(many);
  const paths = [];
  for (let index = 0; index < MAX_RESOLVE_CANDIDATES + 40; index += 1) {
    const file = join(many, `f${index}.txt`);
    writeFileSync(file, "x");
    paths.push(file);
  }
  const text = paths.join("\n");

  const started = process.hrtime.bigint();
  const parsed = extractAttachments(text, sandbox);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(parsed.files.length, MAX_RESOLVE_CANDIDATES);
  // The untouched tail keeps the message from being path-only, so it is left alone.
  assert.equal(parsed.text, text);
  assert.ok(elapsedMs < 250, `expected the cap to keep this fast, took ${elapsedMs.toFixed(0)}ms`);
});

test("a 8000-candidate paste does not block the input", () => {
  const lines = [];
  for (let index = 0; index < 8000; index += 1) {
    lines.push(`  at frame${index} (${join(sandbox, `missing${index}.ts`)}:1:1)`);
  }
  const log = lines.join("\n");

  const started = process.hrtime.bigint();
  const parsed = extractAttachments(log, sandbox);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(parsed.text, log);
  // Regression guard: this measured ~650ms before the candidate cap.
  assert.ok(elapsedMs < 250, `expected the cap to keep this fast, took ${elapsedMs.toFixed(0)}ms`);
});

test("builds the prompt with the user's words first", () => {
  const files = [{ path: notesPath, name: "notes.md", size: 8, image: false }];

  assert.equal(
    buildPrompt("summarize", files),
    `summarize\n\n${ATTACHMENT_BLOCK_HEADER}\n- ${notesPath}`,
  );
  assert.equal(buildPrompt("  ", files), `${ATTACHMENT_BLOCK_HEADER}\n- ${notesPath}`);
  assert.equal(buildPrompt("summarize", []), "summarize");
});

test("deduplicates attachments by path", () => {
  const file = { path: notesPath, name: "notes.md", size: 8, image: false };
  assert.equal(dedupeAttachments([file, { ...file }]).length, 1);
});

test("recognises shell and slash command input", () => {
  assert.equal(isShellOrCommandInput("!ls", sandbox), true);
  assert.equal(isShellOrCommandInput("  !ls -la", sandbox), true);
  assert.equal(isShellOrCommandInput("!!ls", sandbox), true);
  assert.equal(isShellOrCommandInput("/model", sandbox), true);
  assert.equal(isShellOrCommandInput("/skill:review", sandbox), true);
  assert.equal(isShellOrCommandInput("hello", sandbox), false);
  assert.equal(isShellOrCommandInput("", sandbox), false);
});

test("an absolute path is never mistaken for a slash command", () => {
  // On POSIX every absolute path starts with `/`, which is also the command
  // prefix. On this machine `notesPath` is `C:\...`; on the CI's Linux runner it
  // is `/tmp/...`, and that is the case that made the whole extension a no-op.
  assert.equal(isShellOrCommandInput(`${notesPath}`, sandbox), false);
  assert.equal(isShellOrCommandInput(`${notesPath} 看下这个`, sandbox), false);
  // A command name that happens to have no file behind it stays a command.
  assert.equal(isShellOrCommandInput("/copy", sandbox), true);
});

test("attaches a dropped image as an image block", async () => {
  const { input } = loadExtension();
  const ctx = createStubCtx(sandbox);

  const result = await input({ type: "input", text: `看下 ${shotPath}`, source: "interactive" }, ctx);

  assert.equal(result.action, "transform");
  assert.equal(result.text, `看下 ${shotPath}`);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].type, "image");
  assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(result.images[0].data, PNG_BASE64);
});

test("attaches a non-image as a path reference", async () => {
  const { input } = loadExtension();
  const ctx = createStubCtx(sandbox);

  const result = await input({ type: "input", text: `总结 ${notesPath}`, source: "interactive" }, ctx);

  assert.equal(result.action, "transform");
  // The sentence keeps its path; the block tells the model it is an attachment.
  assert.equal(result.text, `总结 ${notesPath}\n\n${ATTACHMENT_BLOCK_HEADER}\n- ${notesPath}`);
  assert.equal(result.images, undefined);
});

test("keeps images that were pasted separately", async () => {
  const { input } = loadExtension();
  const ctx = createStubCtx(sandbox);
  const pasted = { type: "image", data: "AAAA", mimeType: "image/png" };

  const result = await input(
    { type: "input", text: `${notesPath}`, source: "interactive", images: [pasted] },
    ctx,
  );

  assert.deepEqual(result.images, [pasted]);
});

test("falls back to a path when a .png does not sniff as an image", async () => {
  const { input } = loadExtension();
  const ctx = createStubCtx(sandbox);

  const result = await input({ type: "input", text: `${liarPath}`, source: "interactive" }, ctx);

  assert.equal(result.images, undefined);
  assert.match(result.text, new RegExp(ATTACHMENT_BLOCK_HEADER));
  assert.match(result.text, /liar\.png/);
  assert.ok(ctx.notifications.some((entry) => entry.type === "warning"));
});

test("never injects attachment paths into a shell command", async () => {
  const { input } = loadExtension();
  const ctx = createStubCtx(sandbox);

  const result = await input({ type: "input", text: `!cat ${notesPath}`, source: "interactive" }, ctx);

  assert.equal(result.action, "continue");
  assert.ok(ctx.notifications.some((entry) => entry.type === "warning"));
});

test("passes ordinary text straight through", async () => {
  const { input } = loadExtension();
  const ctx = createStubCtx(sandbox);

  const result = await input({ type: "input", text: "hello there", source: "interactive" }, ctx);
  assert.equal(result.action, "continue");
  assert.equal(ctx.notifications.length, 0);
});

test("does not touch messages injected by another extension", async () => {
  const { input } = loadExtension();
  const ctx = createStubCtx(sandbox);

  const result = await input({ type: "input", text: `${notesPath}`, source: "extension" }, ctx);
  assert.equal(result.action, "continue");
});

test("/attach queues a file for the next message and clears it afterwards", async () => {
  const { pi, input } = loadExtension();
  const ctx = createStubCtx(sandbox);

  await pi.commands.get("attach").handler("./notes.md", ctx);
  assert.match(ctx.statuses.get(STATUS_KEY), /notes\.md/);
  assert.ok(ctx.notifications.some((entry) => entry.message.includes("已附加")));

  const result = await input({ type: "input", text: "总结一下", source: "interactive" }, ctx);
  assert.match(result.text, /总结一下/);
  assert.match(result.text, new RegExp(`- ${notesPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  assert.equal(ctx.statuses.has(STATUS_KEY), false, "status clears once the attachment is sent");
});

test("/attach reports files it cannot find", async () => {
  const { pi } = loadExtension();
  const ctx = createStubCtx(sandbox);

  await pi.commands.get("attach").handler("./nope.md", ctx);
  assert.ok(ctx.notifications.some((entry) => entry.type === "error"));
});

test("/attachments lists and clears the queue", async () => {
  const { pi } = loadExtension();
  const ctx = createStubCtx(sandbox);
  const attachments = pi.commands.get("attachments");

  await attachments.handler("", ctx);
  assert.ok(ctx.notifications.some((entry) => entry.message.includes("没有待发附件")));

  await pi.commands.get("attach").handler("./notes.md", ctx);
  await attachments.handler("", ctx);
  assert.ok(ctx.notifications.some((entry) => entry.message.includes("notes.md")));

  await attachments.handler("clear", ctx);
  assert.ok(ctx.notifications.some((entry) => entry.message.includes("已清空 1")));
  assert.equal(ctx.statuses.has(STATUS_KEY), false);
});

test("a new session starts with an empty queue", async () => {
  const { pi, sessionStart } = loadExtension();
  const ctx = createStubCtx(sandbox);

  await pi.commands.get("attach").handler("./notes.md", ctx);
  assert.equal(ctx.statuses.has(STATUS_KEY), true);

  await sessionStart({ type: "session_start" }, ctx);
  assert.equal(ctx.statuses.has(STATUS_KEY), false);
});

test("argument completions follow the session directory", async () => {
  const { pi, sessionStart } = loadExtension();
  // The loader calls the composer before the process cwd is a useful answer, so the
  // session cwd from session_start is what the picker must list.
  await sessionStart({ type: "session_start" }, createStubCtx(sandbox));

  const completions = pi.commands.get("attach").getArgumentCompletions("note");

  assert.ok(Array.isArray(completions));
  assert.ok(completions.some((item) => item.value === "notes.md"));
  assert.deepEqual(pi.commands.get("attachments").getArgumentCompletions("cl"), [
    { value: "clear", label: "clear" },
  ]);
  assert.equal(pi.commands.get("attachments").getArgumentCompletions("zzz"), null);
});

test("a picked completion resolves against the same directory the picker listed", async () => {
  const { pi, sessionStart } = loadExtension();
  const previous = process.cwd();
  const elsewhere = mkdtempSync(join(tmpdir(), "pi-attachments-elsewhere-"));
  process.chdir(elsewhere);
  try {
    const ctx = createStubCtx(sandbox);
    await sessionStart({ type: "session_start" }, ctx);

    const [first] = pi.commands.get("attach").getArgumentCompletions("note");
    await pi.commands.get("attach").handler(first.value, ctx);

    assert.equal(ctx.statuses.has(STATUS_KEY), true, `${first.value} should have attached`);
  } finally {
    process.chdir(previous);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
