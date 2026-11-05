import { lstat, readFile, realpath, stat, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { homedir } from "os";
import { htmlToPlainText, selectBody } from "./body.js";

// Proton refuses messages whose attachments add up to more than about 25 MB.
// Checking up front gives a usable error instead of a draft that will not
// send, or an opaque failure from Bridge.
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// Proton shows a message with no HTML part as preformatted plain text, in a
// different font from every other message in the mailbox. So every message
// this server composes carries an HTML part: the caller's own where it
// supplied one, otherwise one built from the plain text. The plain text is
// kept alongside it, giving a normal multipart/alternative that still reads
// correctly in a client that wants text.
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

// Blank lines become paragraphs, single newlines become line breaks. Nothing
// else is interpreted, so whatever the caller wrote arrives as written.
export function plainTextToHtml(text) {
  const escaped = String(text ?? "").replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);
  const paragraphs = escaped
    .split(/\r?\n[ \t]*\r?\n/)
    .map((paragraph) => paragraph.replace(/\r?\n/g, "<br>\n").trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.length > 0 ? paragraphs.map((p) => `<p>${p}</p>`).join("\n") : "<p></p>";
}

// The text and html parts of a message body. `html` is always set.
export function bodyParts(body, html) {
  const text = typeof body === "string" ? body : "";
  const supplied = typeof html === "string" && html.trim().length > 0;
  return { text, html: supplied ? html : plainTextToHtml(text) };
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}

export function assertTotalSize(items, maxBytes = MAX_TOTAL_ATTACHMENT_BYTES) {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (total <= maxBytes) return;
  const largest = [...items]
    .sort((a, b) => b.size - a.size)
    .slice(0, 3)
    .map((item) => `${item.filename} (${formatBytes(item.size)})`)
    .join(", ");
  throw new Error(
    `Attachments total ${formatBytes(total)}, above the ${formatBytes(maxBytes)} Proton accepts per message. Largest: ${largest}.`
  );
}

// Validate and load the files a client asked to attach. Every path is checked
// before anything is read, so a bad path or an oversized set fails the whole
// call and no draft is created. `existing` lists attachments the message
// already carries ({ filename, size }), which count towards the size cap.
// --- Quoting the message being replied to ---------------------------------
//
// IMAP has no notion of a reply: a client appends a finished message, so the
// quoted original has to be built here, exactly as Thunderbird or the Proton
// web app build theirs. The markup below copies what the web app currently
// produces, down to the protonmail_quote classes, so a reply composed through
// this server folds away behind "show quoted text" in Proton the same way one
// typed in the web app does.

const QUOTE_SEPARATOR = "-------- Original Message --------";

// "On Friday, 10/16/26 at 19:18" -- the web app's own wording and ordering.
function quoteDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "numeric", day: "numeric", year: "2-digit"
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
  return `${weekday}, ${parts} at ${time}`;
}

// "On <date> Name <address> wrote:", or the shorter form when either is
// missing, so a message without a date or a sender still gets an attribution.
export function quoteAttribution(original) {
  const sender = original?.from?.value?.[0];
  const name = sender?.name?.trim();
  const address = sender?.address?.trim();
  const who = name && address ? `${name} <${address}>` : address || name || "the sender";
  const when = quoteDate(original?.date);
  return when ? `On ${when} ${who} wrote:` : `${who} wrote:`;
}

// Keep the original's markup but not its document wrapper: a nested <html> or
// <body> inside a blockquote is invalid and clients render it unpredictably.
// Head content goes with it -- a stray <title> or <meta> renders as nothing or
// as text depending on the client, and Proton's own quotes start at the first
// real element. Scripts go too: they do nothing in mail and should not be
// passed along. Styles stay, since the quoted mail needs them to look like
// itself.
function quotableHtml(html) {
  return String(html)
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<(?:meta|link|base)\b[^>]*\/?>/gi, "")
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
    .trim();
}

// The quoted original as both parts: ">" prefixes for text, a blockquote for
// html. Returns null when there is nothing worth quoting.
export function buildQuote(original) {
  if (!original) return null;
  const body = selectBody(original);
  // A message with no readable body reports a notice rather than text; that
  // notice is ours, not the sender's, so it is not something to quote back.
  const originalText = body.bodySource === "none" ? "" : body.text;
  const suppliedHtml = typeof original.html === "string" && original.html.trim().length > 0
    ? quotableHtml(original.html)
    : "";
  // Decide on the content, not on the generated markup: an empty body still
  // produces a <p></p>, which would make an empty quote look like a real one.
  if (suppliedHtml === "" && originalText.trim() === "") return null;

  const attribution = quoteAttribution(original);
  const originalHtml = suppliedHtml || plainTextToHtml(originalText);

  const quotedText = originalText
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  const escapedAttribution = attribution.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);

  return {
    text: `${QUOTE_SEPARATOR}\n${attribution}\n${quotedText}`,
    html: `<div class="protonmail_quote"><br><br>${QUOTE_SEPARATOR}<br>${escapedAttribution}<br>` +
          `<blockquote class="protonmail_quote" type="cite">${originalHtml}</blockquote></div>`
  };
}

// Append the quoted original to a reply's body parts.
export function withQuote(parts, original) {
  const quote = buildQuote(original);
  if (!quote) return parts;
  return {
    text: `${parts.text}\n\n${quote.text}`,
    html: `${parts.html}${quote.html}`
  };
}

// Returns nodemailer attachment objects plus their size.
export async function loadAttachmentFiles(specs = [], { root, existing = [] } = {}) {
  if (!specs.length) return [];
  const realRoot = root ? await realpath(expandHome(root)) : null;
  const files = [];
  for (const spec of specs) {
    const requested = spec.path;
    const expanded = expandHome(requested || "");
    if (!isAbsolute(expanded)) {
      throw new Error(`Attachment path must be absolute: ${requested}`);
    }
    let resolved;
    try {
      resolved = await realpath(expanded);
    } catch {
      throw new Error(`Attachment not found: ${requested}`);
    }
    // Compared after resolving symlinks, so a link inside the root cannot
    // point a client at a file outside it.
    if (realRoot) {
      const rel = relative(realRoot, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Attachment is outside PROTON_BRIDGE_ATTACHMENT_ROOT (${realRoot}): ${requested}`);
      }
    }
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new Error(`Attachment is not a regular file: ${requested}`);
    }
    files.push({
      path: resolved,
      filename: spec.filename || basename(expanded),
      contentType: spec.contentType,
      size: info.size
    });
  }
  assertTotalSize([...existing, ...files]);
  // Read now rather than handing nodemailer a path, so what was validated is
  // what gets attached.
  return await Promise.all(files.map(async (file) => {
    const attachment = { filename: file.filename, content: await readFile(file.path), size: file.size };
    if (file.contentType) attachment.contentType = file.contentType;
    return attachment;
  }));
}

export function toMailAttachments(files) {
  return files.map(({ size, ...attachment }) => attachment);
}

export function attachmentSummary(files) {
  return files.map((file) => ({ filename: file.filename, size: file.size }));
}

export function formatRecipient(addr) {
  if (!addr.name) return addr.address;
  const quotedName = `"${addr.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `${quotedName} <${addr.address}>`;
}

// A mailparser address field as a header value nodemailer accepts. The field
// is an array when the header occurs more than once, and group syntax nests
// its members under `group`.
export function addressList(field) {
  const flat = [];
  const walk = (entries) => {
    for (const entry of entries) {
      if (entry.group) walk(entry.group);
      else if (entry.address) flat.push(entry);
    }
  };
  for (const header of [].concat(field || [])) walk(header.value || []);
  return flat.map(formatRecipient).join(", ");
}

// Build the replacement for an existing draft. Fields not passed in `changes`
// keep their current value; an empty string clears to/cc/bcc. The threading
// headers are always carried over so a reply draft stays in its thread.
//
// The two body parts must not drift apart, since clients pick either one:
// a new html without a new body derives the text from the html, and a new
// body without a new html drops the old html rather than leave it stale.
//
// Inline images are kept as long as the resulting html still references
// them; other attachments are kept when `keepAttachments` is set.
export function composeDraftUpdate(parsed, changes = {}, newAttachments = [], { fallbackFrom } = {}) {
  const field = (key, current) => (changes[key] !== undefined ? changes[key] : current);
  let text = parsed.text || "";
  let html = parsed.html || null;
  if (changes.html !== undefined) {
    html = changes.html || null;
    text = changes.body !== undefined ? changes.body : (html ? htmlToPlainText(html) : "");
  } else if (changes.body !== undefined) {
    // A new body used to turn the draft into plain text; it now carries an
    // HTML part built from that body, like every other message composed here.
    text = changes.body;
    html = plainTextToHtml(text);
  }
  const keepAttachments = changes.keepAttachments !== false;
  const kept = (parsed.attachments || []).filter((attachment) => {
    const inline = attachment.related || (attachment.contentDisposition === "inline" && attachment.cid);
    if (inline && attachment.cid) return Boolean(html && html.includes(`cid:${attachment.cid}`));
    return keepAttachments;
  }).map((attachment) => {
    const copy = {
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
      size: attachment.size ?? attachment.content?.length ?? 0
    };
    if (attachment.cid) copy.cid = attachment.cid;
    if (attachment.contentDisposition) copy.contentDisposition = attachment.contentDisposition;
    return copy;
  });
  // Bridge appends the draft's own Proton ID to References when it hands a
  // draft out; carried over, the replacement would refer to the very draft
  // it replaces.
  const ownId = `${parsed.headers?.get?.("x-pm-internal-id") || ""}`.trim();
  const ownRef = ownId ? normalizeMessageId(`${ownId}@protonmail.internalid`) : null;
  const references = [].concat(parsed.references || [])
    .filter((ref) => ref && normalizeMessageId(ref) !== ownRef)
    .join(" ");
  const mailOptions = {
    from: addressList(parsed.from) || fallbackFrom,
    to: field("to", addressList(parsed.to)),
    subject: field("subject", parsed.subject || ""),
    text
  };
  const cc = field("cc", addressList(parsed.cc));
  const bcc = field("bcc", addressList(parsed.bcc));
  if (cc) mailOptions.cc = cc;
  if (bcc) mailOptions.bcc = bcc;
  if (html) mailOptions.html = html;
  if (parsed.inReplyTo) mailOptions.inReplyTo = parsed.inReplyTo;
  if (references) mailOptions.references = references;
  const attachments = [...kept, ...newAttachments];
  if (attachments.length) mailOptions.attachments = toMailAttachments(attachments);
  return { mailOptions, kept, attachments };
}

// --- Message-ID lookup ---------------------------------------------------

export function normalizeMessageId(value) {
  const bare = `${value || ""}`.trim().replace(/^<+|>+$/g, "").trim();
  return bare ? `<${bare}>` : "";
}

// Bridge's "All Mail" is a virtual folder whose UIDs are not stable across
// sessions, so a UID that a client remembered can come to point at a
// different message. A Message-ID does not move. Resolve one to the UID it
// currently has in `folder`, which must be the selected mailbox.
//
// IMAP HEADER search matches substrings, so every hit is confirmed against
// its exact Message-ID before it counts.
export async function resolveMessageUid(client, folder, { uid, messageId } = {}) {
  if (!messageId) {
    if (uid == null) throw new Error("Pass uid or messageId to identify the email.");
    return uid;
  }
  const wanted = normalizeMessageId(messageId);
  if (!wanted) throw new Error("messageId is empty.");
  const candidates = await client.search(
    { header: { "message-id": wanted.slice(1, -1) } },
    { uid: true }
  ) || [];
  const matches = [];
  if (candidates.length > 0) {
    for await (const msg of client.fetch(candidates.join(","), { envelope: true, uid: true }, { uid: true })) {
      if (normalizeMessageId(msg.envelope?.messageId) === wanted) matches.push(msg.uid);
    }
  }
  if (matches.length === 0) {
    throw new Error(`No email with Message-ID ${wanted} in ${folder}.`);
  }
  if (uid != null) {
    if (!matches.includes(uid)) {
      throw new Error(
        `UID ${uid} in ${folder} is not the email with Message-ID ${wanted} (that one has UID ${matches.join(", ")}). UIDs in All Mail can shift; drop the uid and pass only messageId.`
      );
    }
    return uid;
  }
  if (matches.length > 1) {
    throw new Error(
      `Several emails in ${folder} carry Message-ID ${wanted} (UIDs ${matches.join(", ")}); pass the uid as well to pick one.`
    );
  }
  return matches[0];
}

// Resolve an absolute destination path for writing a file to the host.
//
// The target itself need not exist yet, so the parent directory is resolved
// with realpath and the basename appended, rather than resolving the target.
// That keeps the root check symlink-proof -- a link inside the root cannot aim
// a write outside it -- while still allowing a file that is not there yet.
export async function resolveWritePath(requested, { root } = {}) {
  const expanded = expandHome(requested || "");
  if (!isAbsolute(expanded)) {
    throw new Error(`Destination path must be absolute: ${requested}`);
  }
  const name = basename(expanded);
  if (!name || name === "." || name === "..") {
    throw new Error(`Destination path must name a file, not a directory: ${requested}`);
  }
  const parent = dirname(expanded);
  let realParent;
  try {
    realParent = await realpath(parent);
  } catch {
    throw new Error(`Destination directory does not exist: ${parent}`);
  }
  if (!(await stat(realParent)).isDirectory()) {
    throw new Error(`Destination parent is not a directory: ${parent}`);
  }
  const resolved = join(realParent, name);
  if (root) {
    let realRoot;
    try {
      realRoot = await realpath(expandHome(root));
    } catch {
      throw new Error(`PROTON_BRIDGE_ATTACHMENT_ROOT does not exist: ${root}`);
    }
    const rel = relative(realRoot, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Destination is outside PROTON_BRIDGE_ATTACHMENT_ROOT (${realRoot}): ${requested}`);
    }
  }
  return resolved;
}

// Write `content` to an already-resolved path, refusing to clobber by default.
// The exclusive flag does the existence check in the same syscall as the write,
// so a file appearing in between cannot be overwritten by accident.
export async function writeFileGuarded(resolvedPath, content, { overwrite = false } = {}) {
  let info = null;
  try {
    info = await lstat(resolvedPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (info) {
    if (!overwrite) {
      throw new Error(`Destination already exists: ${resolvedPath}. Pass overwrite: true to replace it`);
    }
    // Writing through a symlink would land outside the directory just checked.
    if (info.isSymbolicLink()) {
      throw new Error(`Destination is a symlink, refusing to write through it: ${resolvedPath}`);
    }
    if (!info.isFile()) {
      throw new Error(`Destination exists and is not a regular file: ${resolvedPath}`);
    }
  }
  try {
    await writeFile(resolvedPath, content, { flag: overwrite ? "w" : "wx" });
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`Destination already exists: ${resolvedPath}. Pass overwrite: true to replace it`);
    }
    throw err;
  }
  return content.length;
}
