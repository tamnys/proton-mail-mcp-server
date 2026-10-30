#!/usr/bin/env node
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import { selectBody } from "./body.js";
import { isEnabled, isLoopbackHost, imapConnectionOptions } from "./connection.js";
import { describeAttachments, findAttachment, attachmentContent, hasAttachments } from "./attachments.js";
import {
  loadAttachmentFiles,
  toMailAttachments,
  attachmentSummary,
  formatRecipient,
  composeDraftUpdate,
  assertTotalSize,
  resolveMessageUid,
  resolveWritePath,
  writeFileGuarded,
  bodyParts,
  withQuote
} from "./compose.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var FILE_SETTINGS = [
  "PROTON_BRIDGE_HOST",
  "PROTON_BRIDGE_IMAP_PORT",
  "PROTON_BRIDGE_IMAP_SECURE",
  "PROTON_BRIDGE_SMTP_HOST",
  "PROTON_BRIDGE_SMTP_PORT",
  "PROTON_BRIDGE_SMTP_SECURE",
  "PROTON_BRIDGE_ALLOW_SEND",
  "PROTON_BRIDGE_READ_ONLY",
  "PROTON_BRIDGE_ATTACHMENT_ROOT"
];
function loadConfig() {
  let username = process.env.PROTON_BRIDGE_USERNAME;
  let password = process.env.PROTON_BRIDGE_PASSWORD;
  if (!username || !password) {
    const configPath = join(homedir(), ".proton-bridge-credentials");
    try {
      const raw = readFileSync(configPath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
          val = val.slice(1, -1);
        }
        if (key === "PROTON_BRIDGE_USERNAME" && !username) username = val;
        if (key === "PROTON_BRIDGE_PASSWORD" && !password) password = val;
        // The environment wins: a stale line in the file must not switch off
        // PROTON_BRIDGE_READ_ONLY or TLS that the client configuration set.
        if (FILE_SETTINGS.includes(key) && process.env[key] === undefined) process.env[key] = val;
      }
    } catch {
    }
  }
  return { username, password };
}
var creds = loadConfig();
var CONFIG = {
  host: process.env.PROTON_BRIDGE_HOST || "127.0.0.1",
  imapPort: parseInt(process.env.PROTON_BRIDGE_IMAP_PORT || "1143", 10),
  // Off for Bridge and gmx (STARTTLS); on for Gmail, which only takes 993.
  imapSecure: isEnabled(process.env.PROTON_BRIDGE_IMAP_SECURE),
  // Bridge serves IMAP and SMTP from the same host; a hosted provider
  // usually does not (imap.gmx.net vs mail.gmx.net). Falls back to the
  // IMAP host, which keeps the single-host Bridge setup working unchanged.
  smtpHost: process.env.PROTON_BRIDGE_SMTP_HOST || process.env.PROTON_BRIDGE_HOST || "127.0.0.1",
  smtpPort: parseInt(process.env.PROTON_BRIDGE_SMTP_PORT || "1025", 10),
  smtpSecure: isEnabled(process.env.PROTON_BRIDGE_SMTP_SECURE),
  username: creds.username,
  password: creds.password
};
if (!CONFIG.username || !CONFIG.password) {
  console.error(
    "Error: Proton Bridge credentials not found.\nEither set PROTON_BRIDGE_USERNAME and PROTON_BRIDGE_PASSWORD environment variables,\nor create ~/.proton-bridge-credentials with:\n\n  PROTON_BRIDGE_USERNAME=your-email@proton.me\n  PROTON_BRIDGE_PASSWORD=your-bridge-password\n"
  );
  process.exit(1);
}
var ALLOW_SEND = isEnabled(process.env.PROTON_BRIDGE_ALLOW_SEND);
// Read-only leaves out every tool that changes the mailbox or sends mail, so
// mail that tells Claude to move, delete or answer something has nothing to
// call. It wins over PROTON_BRIDGE_ALLOW_SEND.
var READ_ONLY = isEnabled(process.env.PROTON_BRIDGE_READ_ONLY);
// Optional: when set, attachments may only be taken from below this directory.
var ATTACHMENT_ROOT = process.env.PROTON_BRIDGE_ATTACHMENT_ROOT || null;
var IMAP_IDLE_TIMEOUT_MS = parseInt(process.env.PROTON_BRIDGE_IDLE_TIMEOUT_MS || "300000", 10);
var SMTP_IDLE_TIMEOUT_MS = parseInt(process.env.PROTON_BRIDGE_SMTP_IDLE_TIMEOUT_MS || "120000", 10);
var imapClient = null;
var imapClientPromise = null;
var imapIdleTimer = null;
var smtpTransport = null;
var smtpIdleTimer = null;
function clearIdleTimer(timer) {
  if (timer) {
    clearTimeout(timer);
  }
}
function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
function createImapClient() {
  const client = new ImapFlow({
    ...imapConnectionOptions(CONFIG),
    auth: {
      user: CONFIG.username,
      pass: CONFIG.password
    },
    logger: false
  });
  client.on("close", () => {
    if (imapClient === client) {
      imapClient = null;
      imapClientPromise = null;
    }
  });
  return client;
}
function isRetryableImapError(error) {
  const message = `${error?.message || error || ""}`;
  return /not connected|connection.*closed|socket.*closed|socket.*destroyed|timed out|ECONNRESET|EPIPE|User is authenticated but not connected/i.test(message);
}
function scheduleImapDisconnect() {
  clearIdleTimer(imapIdleTimer);
  imapIdleTimer = null;
  if (!imapClient || !(IMAP_IDLE_TIMEOUT_MS > 0)) {
    return;
  }
  const client = imapClient;
  imapIdleTimer = setTimeout(async () => {
    if (imapClient !== client) {
      return;
    }
    imapClient = null;
    imapClientPromise = null;
    try {
      if (client.usable) {
        await client.logout();
      } else {
        client.close();
      }
    } catch {
      try {
        client.close();
      } catch {
      }
    }
  }, IMAP_IDLE_TIMEOUT_MS);
  unrefTimer(imapIdleTimer);
}
function resetImapClient(client = imapClient) {
  clearIdleTimer(imapIdleTimer);
  imapIdleTimer = null;
  if (client && imapClient === client) {
    imapClient = null;
  }
  imapClientPromise = null;
  if (!client) {
    return;
  }
  try {
    if (client.usable) {
      client.logout().catch(() => client.close());
    } else {
      client.close();
    }
  } catch {
  }
}
async function getImapClient() {
  clearIdleTimer(imapIdleTimer);
  imapIdleTimer = null;
  if (imapClient?.usable) {
    return imapClient;
  }
  if (!imapClientPromise) {
    imapClientPromise = (async () => {
      const client = createImapClient();
      try {
        await client.connect();
        imapClient = client;
        return client;
      } catch (error) {
        if (imapClient === client) {
          imapClient = null;
        }
        throw error;
      } finally {
        imapClientPromise = null;
      }
    })();
  }
  return await imapClientPromise;
}
async function withImapClient(operation) {
  const client = await getImapClient();
  try {
    const result = await operation(client);
    scheduleImapDisconnect();
    return result;
  } catch (error) {
    if (client.usable && !isRetryableImapError(error)) {
      scheduleImapDisconnect();
      throw error;
    }
    resetImapClient(client);
    const retryClient = await getImapClient();
    try {
      const result = await operation(retryClient);
      scheduleImapDisconnect();
      return result;
    } catch (retryError) {
      if (!retryClient.usable || isRetryableImapError(retryError)) {
        resetImapClient(retryClient);
      } else {
        scheduleImapDisconnect();
      }
      throw retryError;
    }
  }
}
function formatAddress(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  if (addr.text) return addr.text;
  if (Array.isArray(addr.value)) {
    return addr.value.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ");
  }
  return addr.address || "";
}
// keepBcc is for drafts: MailComposer drops the Bcc header by default, as a
// sent message must not reveal it, but a stored draft has to keep it or the
// Bcc recipients are gone by the time the user opens it.
function buildRawMessage(mailOptions, { keepBcc = false } = {}) {
  return new Promise((resolve, reject) => {
    const node = new MailComposer(mailOptions).compile();
    node.keepBcc = keepBcc;
    node.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}
// Fetch one message from the selected mailbox, identified by uid and/or
// messageId (see resolveMessageUid).
async function fetchMessage(client, folder, ref, query = {}) {
  const uid = await resolveMessageUid(client, folder, ref);
  const message = await client.fetchOne(`${uid}`, {
    source: true,
    uid: true,
    ...query
  }, { uid: true });
  if (!message?.source) {
    throw new Error(`No email with UID ${uid} in ${folder}.`);
  }
  return message;
}
async function fetchParsedMessage(ref, folder) {
  return await withImapClient(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const message = await fetchMessage(client, folder, ref);
      return await simpleParser(message.source);
    } finally {
      lock.release();
    }
  });
}
function buildReplyMailOptions(original, body, html, replyAll, quote = true) {
  // The quoted original is part of what a reply is; leaving it to the caller
  // to remember is how it goes missing. Pass quote: false for the short
  // answers that do not want it.
  const parts = quote === false
    ? bodyParts(body, html)
    : withQuote(bodyParts(body, html), original);
  const fromAddresses = original.from?.value || [];
  const replyTo = fromAddresses.length > 0 ? fromAddresses.map(formatRecipient).join(", ") : formatAddress(original.from);
  let recipients = replyTo;
  if (replyAll) {
    const seen = new Set(fromAddresses.map((a) => (a.address || "").toLowerCase()));
    seen.add((CONFIG.username || "").toLowerCase());
    const allAddresses = [
      ...original.to?.value || [],
      ...original.cc?.value || []
    ].filter((a) => {
      const bare = (a.address || "").toLowerCase();
      if (!bare || seen.has(bare)) return false;
      seen.add(bare);
      return true;
    });
    if (allAddresses.length > 0) {
      recipients = [replyTo, ...allAddresses.map(formatRecipient)].join(", ");
    }
  }
  const subjectLine = original.subject?.startsWith("Re:") ? original.subject : `Re: ${original.subject || ""}`;
  const references = [
    original.references,
    original.messageId
  ].flat().filter(Boolean).join(" ");
  const mailOptions = {
    from: CONFIG.username,
    to: recipients,
    subject: subjectLine,
    text: parts.text,
    html: parts.html,
    inReplyTo: original.messageId,
    references: references || void 0
  };
  return mailOptions;
}
async function saveDraft(mailOptions) {
  const raw = await buildRawMessage(mailOptions, { keepBcc: true });
  return await withImapClient(async (client) => {
    const draftsPath = await findSpecialUsePath(client, "\\Drafts", "Drafts");
    const appended = await client.append(draftsPath, raw, ["\\Draft", "\\Seen"]);
    return { folder: draftsPath, uid: appended?.uid ?? null };
  });
}
function createSmtpTransport() {
  return nodemailer.createTransport({
    host: CONFIG.smtpHost,
    port: CONFIG.smtpPort,
    // Proton Bridge defaults to STARTTLS on 1025; set PROTON_BRIDGE_SMTP_SECURE=true for implicit TLS
    secure: CONFIG.smtpSecure,
    requireTLS: !CONFIG.smtpSecure,
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    auth: {
      user: CONFIG.username,
      pass: CONFIG.password
    },
    tls: {
      // Bridge uses a self-signed cert; only skip validation for local Bridge
      rejectUnauthorized: !isLoopbackHost(CONFIG.smtpHost)
    }
  });
}
function isRetryableSmtpError(error) {
  const message = `${error?.message || error || ""}`;
  return /connection.*closed|socket.*closed|timed out|ECONNRESET|EPIPE|greeting never received/i.test(message);
}
function scheduleSmtpClose() {
  clearIdleTimer(smtpIdleTimer);
  smtpIdleTimer = null;
  if (!smtpTransport || !(SMTP_IDLE_TIMEOUT_MS > 0)) {
    return;
  }
  const transport2 = smtpTransport;
  smtpIdleTimer = setTimeout(() => {
    if (smtpTransport !== transport2) {
      return;
    }
    smtpTransport = null;
    try {
      transport2.close();
    } catch {
    }
  }, SMTP_IDLE_TIMEOUT_MS);
  unrefTimer(smtpIdleTimer);
}
function resetSmtpTransport() {
  clearIdleTimer(smtpIdleTimer);
  smtpIdleTimer = null;
  if (!smtpTransport) {
    return;
  }
  const transport2 = smtpTransport;
  smtpTransport = null;
  try {
    transport2.close();
  } catch {
  }
}
function getSmtpTransport() {
  clearIdleTimer(smtpIdleTimer);
  smtpIdleTimer = null;
  if (!smtpTransport) {
    smtpTransport = createSmtpTransport();
  }
  return smtpTransport;
}
async function sendMail(mailOptions) {
  const transport2 = getSmtpTransport();
  try {
    const info = await transport2.sendMail(mailOptions);
    scheduleSmtpClose();
    return info;
  } catch (error) {
    if (!isRetryableSmtpError(error)) {
      scheduleSmtpClose();
      throw error;
    }
    resetSmtpTransport();
    const retryTransport = getSmtpTransport();
    try {
      const info = await retryTransport.sendMail(mailOptions);
      scheduleSmtpClose();
      return info;
    } catch (retryError) {
      if (isRetryableSmtpError(retryError)) {
        resetSmtpTransport();
      } else {
        scheduleSmtpClose();
      }
      throw retryError;
    }
  }
}
async function shutdownResources() {
  clearIdleTimer(imapIdleTimer);
  clearIdleTimer(smtpIdleTimer);
  imapIdleTimer = null;
  smtpIdleTimer = null;
  const pendingClientPromise = imapClientPromise;
  let client = imapClient;
  imapClient = null;
  imapClientPromise = null;
  if (!client && pendingClientPromise) {
    try {
      client = await pendingClientPromise;
    } catch {
    }
  }
  if (client) {
    try {
      if (client.usable) {
        await client.logout();
      } else {
        client.close();
      }
    } catch {
      try {
        client.close();
      } catch {
      }
    }
  }
  resetSmtpTransport();
}
var shutdownStarted = false;
async function shutdown(exitCode) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  // Ensure we exit even if a close call hangs on a dead connection
  const forceExitTimer = setTimeout(() => process.exit(exitCode), 1500);
  unrefTimer(forceExitTimer);
  try {
    await shutdownResources();
    try {
      if (typeof server?.close === "function") {
        await server.close();
      }
    } catch {
    }
  } finally {
    clearIdleTimer(forceExitTimer);
  }
  process.exit(exitCode);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(0);
  });
}
process.stdin.once("end", () => {
  void shutdown(0);
});
process.stdin.once("close", () => {
  void shutdown(0);
});
process.once("uncaughtException", (error) => {
  console.error(error);
  void shutdown(1);
});
process.once("unhandledRejection", (error) => {
  console.error(error);
  void shutdown(1);
});
process.once("exit", () => {
  clearIdleTimer(imapIdleTimer);
  clearIdleTimer(smtpIdleTimer);
  try {
    imapClient?.close();
  } catch {
  }
  try {
    smtpTransport?.close();
  } catch {
  }
});
var MESSAGE_ID_HINT = "UIDs in All Mail can shift between sessions; use messageId for a reliable reference.";
// A stock Proton Bridge creates a draft in Proton from its subject, body,
// recipients and Message-ID only, dropping In-Reply-To and References.
// proton-bridge PR #526 makes it link the draft to its parent instead.
var DRAFT_THREADING_NOTE = "Whether Proton then shows the draft in the original conversation depends on Proton Bridge: a stock Bridge drops these headers from drafts, a Bridge with the fix from proton-bridge PR #526 keeps them. The recipients and the Re: subject come from the original either way.";
function messageRefShape(purpose) {
  return {
    uid: z.number().optional().describe(`UID of the email ${purpose}. Optional when messageId is given`),
    messageId: z.string().optional().describe("Message-ID header of the email, including the angle brackets, as returned by list_emails and search_emails. Looked up in the folder, so it stays correct where UIDs shift (All Mail). When uid is given as well, both must refer to the same email")
  };
}
var attachmentsParam = z.array(z.object({
  path: z.string().describe("Absolute path of the file on the machine running this server; ~ is expanded"),
  filename: z.string().optional().describe("Filename shown to the recipient (default: the file's own name)"),
  contentType: z.string().optional().describe("MIME type (default: derived from the file extension)")
})).optional().describe("Files to attach. Every path must be an existing regular file; the total may not exceed 25 MB. If any file is rejected, nothing is created");
async function loadAttachments(specs) {
  return await loadAttachmentFiles(specs || [], { root: ATTACHMENT_ROOT });
}
function withAttachmentSummary(result, files) {
  if (files.length) result.attachments = attachmentSummary(files);
  return result;
}
var server = new McpServer({
  name: "proton-mail",
  version: "0.1.0"
});
// Registers a tool that changes the mailbox or sends mail; in read-only mode
// it is not registered at all, so the client never sees it.
function mutatingTool(...args) {
  if (!READ_ONLY) server.tool(...args);
}
// save_attachment leaves the mailbox alone but writes to this machine, which a
// prompt-injected mail could aim at any file. Read-only keeps it only when
// PROTON_BRIDGE_ATTACHMENT_ROOT fences in where it may write.
function fileWritingTool(...args) {
  if (!READ_ONLY || ATTACHMENT_ROOT) server.tool(...args);
}
// The reading tools open their folder with EXAMINE in read-only mode, so the
// IMAP server itself refuses any change to it. The other instances keep the
// plain SELECT they always used.
function readLock(client, folder) {
  return client.getMailboxLock(folder, { readOnly: READ_ONLY });
}
server.tool(
  "list_folders",
  "List all mailbox folders (INBOX, Sent, Drafts, Trash, etc.)",
  {},
  async () => withImapClient(async (client) => {
      let walk = function(items, prefix = "") {
        for (const item of items) {
          folders.push({
            name: item.name,
            path: item.path,
            specialUse: item.specialUse || null
          });
          if (item.folders && item.folders.length > 0) {
            walk(item.folders, item.path + "/");
          }
        }
      };
      const folders = [];
      const tree = await client.listTree();
      walk(tree.folders || []);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(folders, null, 2)
          }
        ]
      };
    })
);
server.tool(
  "list_emails",
  "List recent emails from a folder. Returns subject, from, date, UID, messageId and hasAttachments for each message. " + MESSAGE_ID_HINT,
  {
    folder: z.string().default("INBOX").describe("Folder path (e.g. INBOX, Sent, Drafts)"),
    limit: z.number().default(20).describe("Maximum number of emails to return (default 20, max 50)")
  },
  async ({ folder, limit }) => withImapClient(async (client) => {
      const effectiveLimit = Math.min(limit || 20, 50);
      const lock = await readLock(client, folder);
      try {
        const messages = [];
        const status = client.mailbox;
        const total = status.exists || 0;
        if (total === 0) {
          return {
            content: [{ type: "text", text: `No emails in ${folder}.` }]
          };
        }
        const startSeq = Math.max(1, total - effectiveLimit + 1);
        const range = `${startSeq}:*`;
        for await (const msg of client.fetch(range, {
          envelope: true,
          uid: true,
          flags: true,
          bodyStructure: true
        })) {
          messages.push({
            uid: msg.uid,
            messageId: msg.envelope.messageId || null,
            subject: msg.envelope.subject || "(no subject)",
            from: formatAddress(msg.envelope.from?.[0]),
            date: msg.envelope.date?.toISOString() || null,
            flags: [...msg.flags || []],
            hasAttachments: hasAttachments(msg.bodyStructure)
          });
        }
        messages.reverse();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { folder, total, showing: messages.length, messages },
                null,
                2
              )
            }
          ]
        };
      } finally {
        lock.release();
      }
    })
);
server.tool(
  "read_email",
  "Read the full content of a specific email by its UID. Returns headers, the body as plain text, the raw HTML body when the message has one, and the attachments. The plain text comes from the message's text/plain part; when that part is missing or holds only invisible padding, it is derived from the text/html part instead. The bodySource field names the part the text came from ('plain', 'html', or 'none'), not the converter that produced it: a message whose root is text/html has no text/plain part and reports 'html', and 'none' means nothing readable was found, which is how an empty message is distinguishable from a parsing failure. The html field carries the raw HTML for clients that prefer to render it themselves, or null when the message has no HTML part. Inline images stay as cid: references that match the listed attachments rather than being expanded into the HTML, and any oversized base64 payload embedded by the sender is replaced by a marker naming what was dropped. Each attachment is listed with its index, filename, contentType, size, disposition and cid. Text attachments (text/*, .ics) up to 64 kB carry their decoded content inline; calendar parts additionally carry a parsed 'calendar' object with the method and each event's summary, start, end, timezone, location, organizer and attendees. PDF attachments carry the text of their text layer in 'content' (up to 64 kB, page by page) plus 'pages' and 'pdfInfo'; a scanned PDF has no text layer and says so in 'note', and read_attachment will render its pages as images. For meeting invites, appointment confirmations and invoices the real detail usually lives in these attachments rather than in the body, so consult them before answering. Use read_attachment to fetch an image or an oversized attachment in full. " + MESSAGE_ID_HINT,
  {
    ...messageRefShape("to read"),
    folder: z.string().default("INBOX").describe("Folder the email is in (default: INBOX)")
  },
  async ({ uid, messageId, folder }) => withImapClient(async (client) => {
      const lock = await readLock(client, folder);
      try {
        const rawMessage = await fetchMessage(client, folder, { uid, messageId });
        // keepCidLinks stops mailparser from inlining every referenced
        // attachment into the HTML as a base64 data URI, which would bloat the
        // response. The cid: values line up with the attachments listed below.
        const parsed = await simpleParser(rawMessage.source, { keepCidLinks: true });
        const body = selectBody(parsed);
        const result = {
          uid: rawMessage.uid,
          subject: parsed.subject || "(no subject)",
          from: formatAddress(parsed.from),
          to: formatAddress(parsed.to),
          cc: formatAddress(parsed.cc),
          date: parsed.date?.toISOString() || null,
          messageId: parsed.messageId || null,
          inReplyTo: parsed.inReplyTo || null,
          text: body.text,
          html: body.html,
          bodySource: body.bodySource,
          attachments: await describeAttachments(parsed)
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } finally {
        lock.release();
      }
    })
);
server.tool(
  "read_attachment",
  "Fetch one attachment of an email, selected by the index or filename reported by read_email. Text attachments (text/*, .ics) are returned decoded, with parsed calendar events for .ics; PDFs are returned as the text of their text layer, page by page, with the page count and document info, which is how to read an invoice or contract; a scanned PDF has no text layer, so its pages are rendered and returned as images instead, which keeps the layout intact where OCR would scramble it -- by default the first 2 pages, with the pages argument for the rest; images are returned as an image content block so they can be looked at directly, which is how to read an invoice or appointment that was sent as a picture; other binaries are returned as base64 in contentBase64. Size limits: 1 MB for text (truncated beyond that), 8 MB for PDFs, 4 MB for images and 1 MB for other binaries; larger attachments come back with metadata and a note instead. " + MESSAGE_ID_HINT,
  {
    ...messageRefShape("holding the attachment"),
    folder: z.string().default("INBOX").describe("Folder the email is in (default: INBOX)"),
    index: z.number().int().optional().describe("Zero-based index of the attachment as listed by read_email; takes precedence over filename"),
    filename: z.string().optional().describe("Filename of the attachment as listed by read_email (case-insensitive)"),
    pages: z.string().optional().describe('Which pages of a scanned PDF to render as images: a number, a range like "2-5", a comma-separated mix, or "all". Defaults to the first 2; at most 20 per call. Ignored for anything else')
  },
  async ({ uid, messageId, folder, index, filename, pages }) => withImapClient(async (client) => {
      const lock = await readLock(client, folder);
      try {
        const rawMessage = await fetchMessage(client, folder, { uid, messageId });
        // Parsed the same way as read_email so the attachment indexes line up.
        const parsed = await simpleParser(rawMessage.source, { keepCidLinks: true });
        const attachment = findAttachment(parsed, { index, filename });
        const resolvedIndex = parsed.attachments.indexOf(attachment);
        return { content: await attachmentContent(attachment, resolvedIndex, { renderPages: pages }) };
      } finally {
        lock.release();
      }
    })
);
fileWritingTool(
  "save_attachment",
  "Write one attachment of an email to a file on the machine running this server, selected by the index or filename reported by read_email. Use this rather than read_attachment when the bytes have to end up on disk -- collecting invoice PDFs, for instance -- since read_attachment returns only a PDF's text layer and hands other binaries back as base64. The destination must be an absolute path (~ is expanded) whose directory already exists; an existing file is refused unless overwrite is true, and the server never writes through a symlink. When PROTON_BRIDGE_ATTACHMENT_ROOT is set, the destination must lie below that directory, the same limit that applies to attaching files. Returns the path written plus the attachment's filename, size and contentType. " + MESSAGE_ID_HINT,
  {
    ...messageRefShape("holding the attachment"),
    folder: z.string().default("INBOX").describe("Folder the email is in (default: INBOX)"),
    index: z.number().int().optional().describe("Zero-based index of the attachment as listed by read_email; takes precedence over filename"),
    filename: z.string().optional().describe("Filename of the attachment as listed by read_email (case-insensitive)"),
    path: z.string().describe("Absolute path of the file to write on the machine running this server; ~ is expanded. The directory must already exist"),
    overwrite: z.boolean().default(false).describe("Replace the destination if it already exists (default: false)")
  },
  async ({ uid, messageId, folder, index, filename, path, overwrite }) => withImapClient(async (client) => {
      // Resolved before the fetch, so a bad path fails without first pulling
      // the whole message off the server.
      const target = await resolveWritePath(path, { root: ATTACHMENT_ROOT });
      const lock = await readLock(client, folder);
      try {
        const rawMessage = await fetchMessage(client, folder, { uid, messageId });
        // Parsed the same way as read_email so the attachment indexes line up.
        const parsed = await simpleParser(rawMessage.source, { keepCidLinks: true });
        const attachment = findAttachment(parsed, { index, filename });
        const size = await writeFileGuarded(target, attachment.content, { overwrite });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                path: target,
                filename: attachment.filename || null,
                size,
                contentType: attachment.contentType || null
              }, null, 2)
            }
          ]
        };
      } finally {
        lock.release();
      }
    })
);
server.tool(
  "search_emails",
  "Search emails by subject, sender, body text, date range, or flags. Returns matching message summaries, each with its UID, messageId and hasAttachments. " + MESSAGE_ID_HINT,
  {
    folder: z.string().default("INBOX").describe("Folder to search in"),
    from: z.string().optional().describe("Filter by sender address or name"),
    subject: z.string().optional().describe("Filter by subject text"),
    body: z.string().optional().describe("Filter by body text content"),
    since: z.string().optional().describe("Emails since this date (YYYY-MM-DD)"),
    before: z.string().optional().describe("Emails before this date (YYYY-MM-DD)"),
    unseen: z.boolean().optional().describe("Only return unread emails (default: false)"),
    limit: z.number().default(20).describe("Max results (default 20, max 50)")
  },
  async ({ folder, from, subject, body, since, before, unseen, limit }) => withImapClient(async (client) => {
      const lock = await readLock(client, folder);
      try {
        const searchCriteria = {};
        if (from) searchCriteria.from = from;
        if (subject) searchCriteria.subject = subject;
        if (body) searchCriteria.body = body;
        if (since) searchCriteria.since = new Date(since);
        if (before) searchCriteria.before = new Date(before);
        if (unseen) searchCriteria.seen = false;
        const uids = await client.search(searchCriteria, { uid: true });
        if (!uids || uids.length === 0) {
          return {
            content: [
              { type: "text", text: "No emails matched the search criteria." }
            ]
          };
        }
        const effectiveLimit = Math.min(limit || 20, 50);
        const targetUids = uids.slice(-effectiveLimit);
        const uidRange = targetUids.join(",");
        const messages = [];
        for await (const msg of client.fetch(uidRange, {
          envelope: true,
          uid: true,
          flags: true,
          bodyStructure: true
        }, { uid: true })) {
          messages.push({
            uid: msg.uid,
            messageId: msg.envelope.messageId || null,
            subject: msg.envelope.subject || "(no subject)",
            from: formatAddress(msg.envelope.from?.[0]),
            date: msg.envelope.date?.toISOString() || null,
            flags: [...msg.flags || []],
            hasAttachments: hasAttachments(msg.bodyStructure)
          });
        }
        messages.reverse();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { folder, totalMatches: uids.length, showing: messages.length, messages },
                null,
                2
              )
            }
          ]
        };
      } finally {
        lock.release();
      }
    })
);
mutatingTool(
  "create_draft",
  "Create a draft email in the Drafts folder, optionally with file attachments. Nothing is sent; the user reviews and sends it from their own mail client. To change a draft afterwards, use update_draft rather than creating another one.",
  {
    to: z.string().describe("Recipient email address(es), comma-separated"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body (plain text)"),
    html: z.string().optional().describe("HTML version of the body. Optional: when omitted, one is generated from the plain text, so the message always has an HTML part. Pass it to control the formatting yourself"),
    cc: z.string().optional().describe("CC recipients, comma-separated"),
    bcc: z.string().optional().describe("BCC recipients, comma-separated"),
    attachments: attachmentsParam
  },
  async ({ to, subject, body, html, cc, bcc, attachments }) => {
    const files = await loadAttachments(attachments);
    const parts = bodyParts(body, html);
    const mailOptions = {
      from: CONFIG.username,
      to,
      subject,
      text: parts.text,
      html: parts.html
    };
    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;
    if (files.length) mailOptions.attachments = toMailAttachments(files);
    const draft = await saveDraft(mailOptions);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            withAttachmentSummary({
              success: true,
              draft: true,
              savedTo: draft.folder,
              uid: draft.uid,
              to,
              subject
            }, files),
            null,
            2
          )
        }
      ]
    };
  }
);
mutatingTool(
  "create_reply_draft",
  "Create a reply to an existing email as a draft in the Drafts folder, written with threading headers (In-Reply-To, References), optionally with file attachments. Nothing is sent; the user reviews and sends it from their own mail client. " + DRAFT_THREADING_NOTE + " " + MESSAGE_ID_HINT,
  {
    ...messageRefShape("to reply to"),
    folder: z.string().default("INBOX").describe("Folder the original email is in"),
    body: z.string().describe("Reply body (plain text)"),
    html: z.string().optional().describe("HTML version of the reply. Optional: when omitted, one is generated from the plain text, so the reply always has an HTML part. Pass it to control the formatting yourself"),
    quote: z.boolean().default(true).describe("Include the message being replied to as a quoted block below the reply, the way a mail client does, in Proton's own format. Default true; pass false for a short answer that does not need the original"),
    replyAll: z.boolean().default(false).describe("Reply to all recipients (default: false)"),
    attachments: attachmentsParam
  },
  async ({ uid, messageId, folder, body, html, replyAll, attachments, quote }) => {
    const files = await loadAttachments(attachments);
    const original = await fetchParsedMessage({ uid, messageId }, folder);
    const mailOptions = buildReplyMailOptions(original, body, html, replyAll, quote);
    if (files.length) mailOptions.attachments = toMailAttachments(files);
    const draft = await saveDraft(mailOptions);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            withAttachmentSummary({
              success: true,
              draft: true,
              savedTo: draft.folder,
              uid: draft.uid,
              to: mailOptions.to,
              subject: mailOptions.subject,
              inReplyTo: original.messageId
            }, files),
            null,
            2
          )
        }
      ]
    };
  }
);
mutatingTool(
  "update_draft",
  "Change an existing draft. Only the fields passed change; everything else stays as it was. Pass an empty string to clear to, cc or bcc. A new html without a new body also updates the plain-text part from it; a new body without a new html turns the draft into plain text. Existing attachments are kept unless keepAttachments is false; new ones are added. IMAP cannot edit a message in place, so the draft is stored anew and the old copy is then removed: the result reports oldUid and newUid, and newUid is the one to use from then on. Only messages flagged as drafts can be replaced; received mail is refused. Work in the Drafts folder (the default) rather than All Mail, where a freshly stored draft may not show up right away. " + MESSAGE_ID_HINT,
  {
    ...messageRefShape("of the draft"),
    folder: z.string().optional().describe("Folder the draft is in (default: Drafts)"),
    to: z.string().optional().describe("New recipient address(es), comma-separated"),
    cc: z.string().optional().describe("New CC recipients, comma-separated"),
    bcc: z.string().optional().describe("New BCC recipients, comma-separated"),
    subject: z.string().optional().describe("New subject line"),
    body: z.string().optional().describe("New body (plain text)"),
    html: z.string().optional().describe("New HTML version of the body"),
    attachments: attachmentsParam,
    keepAttachments: z.boolean().default(true).describe("Keep the draft's existing attachments (default: true)")
  },
  async ({ uid, messageId, folder, to, cc, bcc, subject, body, html, attachments, keepAttachments }) => {
    // New files are validated before the mailbox is touched; the size cap is
    // checked again below, once the attachments being kept are known.
    const files = await loadAttachments(attachments);
    return await withImapClient(async (client) => {
      const draftsFolder = folder || await findSpecialUsePath(client, "\\Drafts", "Drafts");
      const lock = await client.getMailboxLock(draftsFolder);
      try {
        const existing = await fetchMessage(client, draftsFolder, { uid, messageId }, { flags: true });
        if (!existing.flags?.has("\\Draft")) {
          throw new Error(`UID ${existing.uid} in ${draftsFolder} is not a draft (no \\Draft flag); update_draft only replaces drafts.`);
        }
        // keepCidLinks keeps the html pointing at its inline images by cid,
        // which is how they are re-attached to the new message.
        const parsed = await simpleParser(existing.source, { keepCidLinks: true });
        const { mailOptions, attachments: allAttachments } = composeDraftUpdate(
          parsed,
          { to, cc, bcc, subject, body, html, keepAttachments },
          files,
          { fallbackFrom: CONFIG.username }
        );
        assertTotalSize(allAttachments);
        const raw = await buildRawMessage(mailOptions, { keepBcc: true });
        const appended = await client.append(draftsFolder, raw, ["\\Draft", "\\Seen"]);
        // The old draft goes only once its replacement is stored. A failure
        // from here on is reported rather than thrown: the new draft exists,
        // and a retry would only store yet another copy.
        let warning;
        try {
          await client.messageDelete(`${existing.uid}`, { uid: true });
        } catch (error) {
          warning = `The new draft was saved, but the old one (UID ${existing.uid}) could not be removed: ${error.message}`;
        }
        const result = {
          success: true,
          draft: true,
          folder: draftsFolder,
          oldUid: existing.uid,
          newUid: appended?.uid ?? null,
          subject: mailOptions.subject,
          to: mailOptions.to,
          attachments: attachmentSummary(allAttachments)
        };
        if (mailOptions.inReplyTo) result.inReplyTo = mailOptions.inReplyTo;
        if (warning) result.warning = warning;
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } finally {
        lock.release();
      }
    });
  }
);
if (ALLOW_SEND) {
  mutatingTool(
    "send_email",
    "Compose and send a new email. Supports plain text and HTML body, CC, BCC and file attachments.",
    {
      to: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body (plain text)"),
      html: z.string().optional().describe("HTML version of the body. Optional: when omitted, one is generated from the plain text, so the message always has an HTML part. Pass it to control the formatting yourself"),
      cc: z.string().optional().describe("CC recipients, comma-separated"),
      bcc: z.string().optional().describe("BCC recipients, comma-separated"),
      attachments: attachmentsParam
    },
    async ({ to, subject, body, html, cc, bcc, attachments }) => {
      const files = await loadAttachments(attachments);
      const parts = bodyParts(body, html);
      const mailOptions = {
        from: CONFIG.username,
        to,
        subject,
        text: parts.text,
        html: parts.html
      };
      if (cc) mailOptions.cc = cc;
      if (bcc) mailOptions.bcc = bcc;
      if (files.length) mailOptions.attachments = toMailAttachments(files);
      const info = await sendMail(mailOptions);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              withAttachmentSummary({
                success: true,
                messageId: info.messageId,
                to,
                subject
              }, files),
              null,
              2
            )
          }
        ]
      };
    }
  );
  mutatingTool(
    "reply_to_email",
    "Reply to an existing email, optionally with file attachments. Reads the original to set proper headers (In-Reply-To, References). " + MESSAGE_ID_HINT,
    {
      ...messageRefShape("to reply to"),
      folder: z.string().default("INBOX").describe("Folder the original email is in"),
      body: z.string().describe("Reply body (plain text)"),
      html: z.string().optional().describe("HTML version of the reply. Optional: when omitted, one is generated from the plain text, so the reply always has an HTML part. Pass it to control the formatting yourself"),
    quote: z.boolean().default(true).describe("Include the message being replied to as a quoted block below the reply, the way a mail client does, in Proton's own format. Default true; pass false for a short answer that does not need the original"),
      replyAll: z.boolean().default(false).describe("Reply to all recipients (default: false)"),
      attachments: attachmentsParam
    },
    async ({ uid, messageId, folder, body, html, replyAll, attachments, quote }) => {
      const files = await loadAttachments(attachments);
      const original = await fetchParsedMessage({ uid, messageId }, folder);
      const mailOptions = buildReplyMailOptions(original, body, html, replyAll, quote);
      if (files.length) mailOptions.attachments = toMailAttachments(files);
      const info = await sendMail(mailOptions);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              withAttachmentSummary({
                success: true,
                messageId: info.messageId,
                to: mailOptions.to,
                subject: mailOptions.subject,
                inReplyTo: original.messageId
              }, files),
              null,
              2
            )
          }
        ]
      };
    }
  );
}
mutatingTool(
  "move_email",
  "Move an email to a different folder (e.g., move to Trash, Archive). " + MESSAGE_ID_HINT,
  {
    ...messageRefShape("to move"),
    sourceFolder: z.string().default("INBOX").describe("Current folder of the email"),
    destinationFolder: z.string().describe("Target folder (e.g. Trash, Archive, Folders/MyLabel)")
  },
  async ({ uid: givenUid, messageId, sourceFolder, destinationFolder }) => withImapClient(async (client) => {
      const lock = await client.getMailboxLock(sourceFolder);
      try {
        const uid = await resolveMessageUid(client, sourceFolder, { uid: givenUid, messageId });
        await client.messageMove(`${uid}`, destinationFolder, { uid: true });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  uid,
                  from: sourceFolder,
                  to: destinationFolder
                },
                null,
                2
              )
            }
          ]
        };
      } finally {
        lock.release();
      }
    })
);
mutatingTool(
  "mark_email",
  "Mark an email as read/unread or flagged/unflagged. " + MESSAGE_ID_HINT,
  {
    ...messageRefShape("to mark"),
    folder: z.string().default("INBOX").describe("Folder the email is in"),
    action: z.enum(["read", "unread", "flag", "unflag"]).describe("Action to perform")
  },
  async ({ uid: givenUid, messageId, folder, action }) => withImapClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uid = await resolveMessageUid(client, folder, { uid: givenUid, messageId });
        const flagMap = {
          read: { add: ["\\Seen"] },
          unread: { remove: ["\\Seen"] },
          flag: { add: ["\\Flagged"] },
          unflag: { remove: ["\\Flagged"] }
        };
        const { add, remove } = flagMap[action];
        if (add) {
          await client.messageFlagsAdd(`${uid}`, add, { uid: true });
        }
        if (remove) {
          await client.messageFlagsRemove(`${uid}`, remove, { uid: true });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, uid, action }, null, 2)
            }
          ]
        };
      } finally {
        lock.release();
      }
    })
);
async function findSpecialUsePath(client, specialUse, fallback) {
  const tree = await client.listTree();
  const stack = [...tree.folders || []];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item.specialUse === specialUse) {
      return item.path;
    }
    if (item.folders) {
      stack.push(...item.folders);
    }
  }
  return fallback;
}
mutatingTool(
  "delete_email",
  "Delete an email by moving it to the Trash folder. " + MESSAGE_ID_HINT,
  {
    ...messageRefShape("to delete"),
    folder: z.string().default("INBOX").describe("Folder the email is in")
  },
  async ({ uid: givenUid, messageId, folder }) => withImapClient(async (client) => {
      const trashPath = await findSpecialUsePath(client, "\\Trash", "Trash");
      const lock = await client.getMailboxLock(folder);
      try {
        const uid = await resolveMessageUid(client, folder, { uid: givenUid, messageId });
        await client.messageMove(`${uid}`, trashPath, { uid: true });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { success: true, uid, movedTo: trashPath },
                null,
                2
              )
            }
          ]
        };
      } finally {
        lock.release();
      }
    })
);
var transport = new StdioServerTransport();
await server.connect(transport);
server.server.onclose = () => {
  void shutdown(0);
};
