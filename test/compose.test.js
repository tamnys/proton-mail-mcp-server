import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, truncate, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";

import {
  plainTextToHtml,
  bodyParts,
  loadAttachmentFiles,
  assertTotalSize,
  composeDraftUpdate,
  normalizeMessageId,
  resolveMessageUid,
  addressList,
  MAX_TOTAL_ATTACHMENT_BYTES
} from "../compose.js";
import { hasAttachments } from "../attachments.js";

const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "proton-mcp-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Compile and re-parse, as a draft round-trips through Bridge.
function build(mailOptions, { keepBcc = true } = {}) {
  return new Promise((resolve, reject) => {
    const node = new MailComposer(mailOptions).compile();
    node.keepBcc = keepBcc;
    node.build((err, message) => (err ? reject(err) : resolve(message)));
  });
}
const parse = (raw) => simpleParser(raw, { keepCidLinks: true });

// --- attachment files ----------------------------------------------------

test("attachment files are loaded with their name, size and content", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "factuur.pdf"), "%PDF-1.4 test");
  await writeFile(join(dir, "regels.csv"), "a,b\n1,2\n");
  const files = await loadAttachmentFiles([
    { path: join(dir, "factuur.pdf") },
    { path: join(dir, "regels.csv"), filename: "export.csv", contentType: "text/csv" }
  ]);
  assert.deepEqual(files.map((f) => [f.filename, f.size]), [["factuur.pdf", 13], ["export.csv", 8]]);
  assert.equal(files[0].contentType, undefined);
  assert.equal(files[1].contentType, "text/csv");
  assert.equal(files[1].content.toString(), "a,b\n1,2\n");
});

test("a missing attachment fails with its path", async (t) => {
  const dir = await tempDir(t);
  const missing = join(dir, "bestaat-niet.pdf");
  await assert.rejects(loadAttachmentFiles([{ path: missing }]), new RegExp(`not found: ${missing}`));
});

test("relative paths and directories are refused", async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(loadAttachmentFiles([{ path: "factuur.pdf" }]), /must be absolute/);
  await assert.rejects(loadAttachmentFiles([{ path: dir }]), /not a regular file/);
});

test("~ is expanded to the home directory", async () => {
  await assert.rejects(loadAttachmentFiles([{ path: "~/surely-missing-proton-mcp-file.pdf" }]), /not found: ~\//);
  await assert.rejects(loadAttachmentFiles([{ path: "~" }]), /not a regular file/);
});

test("the attachment root rejects files outside it, also through a symlink", async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, "root");
  await mkdir(root);
  await writeFile(join(root, "binnen.txt"), "ok");
  await writeFile(join(dir, "buiten.txt"), "nee");
  await symlink(join(dir, "buiten.txt"), join(root, "link.txt"));
  const [inside] = await loadAttachmentFiles([{ path: join(root, "binnen.txt") }], { root });
  assert.equal(inside.filename, "binnen.txt");
  await assert.rejects(loadAttachmentFiles([{ path: join(dir, "buiten.txt") }], { root }), /outside PROTON_BRIDGE_ATTACHMENT_ROOT/);
  await assert.rejects(loadAttachmentFiles([{ path: join(root, "link.txt") }], { root }), /outside PROTON_BRIDGE_ATTACHMENT_ROOT/);
});

test("one bad path fails the whole set", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "goed.pdf"), "x");
  await assert.rejects(
    loadAttachmentFiles([{ path: join(dir, "goed.pdf") }, { path: join(dir, "fout.pdf") }]),
    /not found/
  );
});

test("more than 25 MB in total is refused, naming the largest files", async (t) => {
  const dir = await tempDir(t);
  // Sparse files: the size is what counts, nothing is written to disk.
  await writeFile(join(dir, "groot.pdf"), "");
  await truncate(join(dir, "groot.pdf"), 20 * 1024 * 1024);
  await writeFile(join(dir, "middel.pdf"), "");
  await truncate(join(dir, "middel.pdf"), 6 * 1024 * 1024);
  await writeFile(join(dir, "klein.csv"), "a");
  await assert.rejects(
    loadAttachmentFiles([
      { path: join(dir, "klein.csv") },
      { path: join(dir, "middel.pdf") },
      { path: join(dir, "groot.pdf") }
    ]),
    /total 26\.0 MB, above the 25\.0 MB .* Largest: groot\.pdf \(20\.0 MB\), middel\.pdf \(6\.0 MB\), klein\.csv/
  );
});

test("attachments a message already carries count towards the cap", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "nieuw.pdf"), "x");
  await assert.rejects(
    loadAttachmentFiles([{ path: join(dir, "nieuw.pdf") }], {
      existing: [{ filename: "bestaand.pdf", size: MAX_TOTAL_ATTACHMENT_BYTES }]
    }),
    /Largest: bestaand\.pdf/
  );
  assert.doesNotThrow(() => assertTotalSize([{ filename: "a", size: MAX_TOTAL_ATTACHMENT_BYTES }]));
});

// --- draft updates -------------------------------------------------------

async function replyDraft() {
  return await parse(await build({
    from: "Ik <ik@example.net>",
    to: '"Jansen, Piet" <piet@example.org>',
    cc: "collega@example.org",
    bcc: "archief@example.net",
    subject: "Re: Offerte",
    text: "Oude tekst",
    html: '<p>Oude tekst</p><img src="cid:logo@x">',
    inReplyTo: "<orig@example.org>",
    references: "<eerder@example.org> <orig@example.org>",
    attachments: [
      { filename: "offerte.pdf", content: Buffer.from("%PDF-1.4 offerte"), contentType: "application/pdf" },
      { filename: "logo.png", content: ONE_PX_PNG, contentType: "image/png", cid: "logo@x" }
    ]
  }));
}

test("a draft keeps its bcc when stored", async () => {
  const parsed = await replyDraft();
  assert.equal(addressList(parsed.bcc), "archief@example.net");
});

test("updating only the html keeps recipients, subject, threading and attachments", async () => {
  const parsed = await replyDraft();
  const { mailOptions } = composeDraftUpdate(parsed, { html: '<p>Nieuwe <b>tekst</b></p><img src="cid:logo@x">' });
  assert.equal(mailOptions.from, '"Ik" <ik@example.net>');
  assert.equal(mailOptions.to, '"Jansen, Piet" <piet@example.org>');
  assert.equal(mailOptions.cc, "collega@example.org");
  assert.equal(mailOptions.bcc, "archief@example.net");
  assert.equal(mailOptions.subject, "Re: Offerte");
  assert.equal(mailOptions.inReplyTo, "<orig@example.org>");
  assert.equal(mailOptions.references, "<eerder@example.org> <orig@example.org>");
  // The text part follows the new html instead of keeping the old wording.
  assert.match(mailOptions.text, /Nieuwe/);
  assert.doesNotMatch(mailOptions.text, /Oude/);

  const reparsed = await parse(await build(mailOptions));
  assert.equal(reparsed.inReplyTo, "<orig@example.org>");
  assert.deepEqual(reparsed.references, ["<eerder@example.org>", "<orig@example.org>"]);
  assert.equal(reparsed.subject, "Re: Offerte");
  assert.equal(addressList(reparsed.bcc), "archief@example.net");
  const names = reparsed.attachments.map((a) => a.filename).sort();
  assert.deepEqual(names, ["logo.png", "offerte.pdf"]);
  const pdf = reparsed.attachments.find((a) => a.filename === "offerte.pdf");
  assert.equal(pdf.content.toString(), "%PDF-1.4 offerte");
  const logo = reparsed.attachments.find((a) => a.filename === "logo.png");
  assert.equal(logo.cid, "logo@x");
  assert.match(reparsed.html, /cid:logo@x/);
});

test("a new body without html still produces an html part", async () => {
  const parsed = await replyDraft();
  const { mailOptions, attachments } = composeDraftUpdate(parsed, { body: "Alleen tekst" });
  assert.equal(mailOptions.text, "Alleen tekst");
  // Replacing the body used to leave the draft as plain text, which Proton
  // renders in a different font from every other message.
  assert.equal(mailOptions.html, "<p>Alleen tekst</p>");
  // The inline logo belonged to the html that was replaced; the pdf stays.
  assert.deepEqual(attachments.map((a) => a.filename), ["offerte.pdf"]);
});

test("nothing passed keeps both body parts", async () => {
  const parsed = await replyDraft();
  const { mailOptions } = composeDraftUpdate(parsed, { subject: "Re: Offerte v2" });
  assert.equal(mailOptions.subject, "Re: Offerte v2");
  assert.equal(mailOptions.text.trim(), "Oude tekst");
  assert.match(mailOptions.html, /Oude tekst/);
});

test("keepAttachments false drops attachments but keeps referenced inline images", async () => {
  const parsed = await replyDraft();
  const { attachments } = composeDraftUpdate(
    parsed,
    { keepAttachments: false },
    [{ filename: "nieuw.csv", content: Buffer.from("a"), size: 1 }]
  );
  assert.deepEqual(attachments.map((a) => a.filename), ["logo.png", "nieuw.csv"]);
});

test("new attachments are added next to the kept ones", async () => {
  const parsed = await replyDraft();
  const { attachments, mailOptions } = composeDraftUpdate(
    parsed,
    {},
    [{ filename: "bijlage.csv", content: Buffer.from("a,b"), size: 3 }]
  );
  assert.deepEqual(attachments.slice(0, 2).map((a) => [a.filename, a.size]).sort(), [
    ["logo.png", ONE_PX_PNG.length], ["offerte.pdf", 16]
  ]);
  assert.deepEqual(attachments.at(-1).filename, "bijlage.csv");
  // Sizes are reported, not passed on to nodemailer.
  assert.ok(mailOptions.attachments.every((a) => !("size" in a)));
});

test("an empty string clears cc and bcc", async () => {
  const parsed = await replyDraft();
  const { mailOptions } = composeDraftUpdate(parsed, { cc: "", bcc: "" });
  assert.equal(mailOptions.cc, undefined);
  assert.equal(mailOptions.bcc, undefined);
});

test("the draft's own Proton ID is dropped from References", async () => {
  // As Bridge hands out a reply draft: the parent's Message-ID, then its own ID.
  const parsed = await parse(await build({
    from: "ik@example.net",
    to: "piet@example.org",
    subject: "Re: Offerte",
    text: "x",
    inReplyTo: "<orig@example.org>",
    references: "<orig@example.org> <eigenid==@protonmail.internalid>",
    headers: { "X-Pm-Internal-Id": "eigenid==" }
  }));
  const { mailOptions } = composeDraftUpdate(parsed, { body: "y" });
  assert.equal(mailOptions.inReplyTo, "<orig@example.org>");
  assert.equal(mailOptions.references, "<orig@example.org>");
});

test("a draft without from or threading headers falls back cleanly", async () => {
  const parsed = await parse(await build({ to: "a@example.org", subject: "Los", text: "x" }));
  const { mailOptions } = composeDraftUpdate(parsed, {}, [], { fallbackFrom: "ik@example.net" });
  assert.equal(mailOptions.from, "ik@example.net");
  assert.equal(mailOptions.inReplyTo, undefined);
  assert.equal(mailOptions.references, undefined);
  assert.equal(mailOptions.attachments, undefined);
});

test("addressList flattens groups and repeated headers", () => {
  const field = [
    { value: [{ name: "Team", group: [{ name: "", address: "a@example.org" }, { name: "B", address: "b@example.org" }] }] },
    { value: [{ name: "", address: "c@example.org" }] }
  ];
  assert.equal(addressList(field), 'a@example.org, "B" <b@example.org>, c@example.org');
  assert.equal(addressList(undefined), "");
});

// --- Message-ID lookup ---------------------------------------------------

test("normalizeMessageId adds or keeps the angle brackets", () => {
  assert.equal(normalizeMessageId("abc@x"), "<abc@x>");
  assert.equal(normalizeMessageId(" <abc@x> "), "<abc@x>");
  assert.equal(normalizeMessageId(""), "");
});

// Mimics imapflow: HEADER search matches substrings, fetch yields envelopes.
function fakeClient(messages) {
  const calls = [];
  return {
    calls,
    async search(query) {
      calls.push(query);
      const needle = query.header["message-id"];
      return messages.filter((m) => m.messageId.includes(needle)).map((m) => m.uid);
    },
    async *fetch(range) {
      const uids = range.split(",").map(Number);
      for (const m of messages) {
        if (uids.includes(m.uid)) yield { uid: m.uid, envelope: { messageId: m.messageId } };
      }
    }
  };
}

test("a uid alone is used as is, without a lookup", async () => {
  const client = fakeClient([]);
  assert.equal(await resolveMessageUid(client, "All Mail", { uid: 37 }), 37);
  assert.equal(client.calls.length, 0);
});

test("neither uid nor messageId is an error", async () => {
  await assert.rejects(resolveMessageUid(fakeClient([]), "INBOX", {}), /uid or messageId/);
});

test("a messageId resolves to its current uid, ignoring substring hits", async () => {
  const client = fakeClient([
    { uid: 37, messageId: "<yahoo-melding@yahoo.com>" },
    { uid: 52, messageId: "<founders@example.org>" },
    { uid: 53, messageId: "<re-founders@example.org.extra>" }
  ]);
  assert.equal(await resolveMessageUid(client, "All Mail", { messageId: "<founders@example.org>" }), 52);
  assert.equal(await resolveMessageUid(client, "All Mail", { messageId: "founders@example.org" }), 52);
  assert.deepEqual(client.calls[0], { header: { "message-id": "founders@example.org" } });
});

test("a uid that no longer matches the messageId is refused", async () => {
  const client = fakeClient([
    { uid: 37, messageId: "<yahoo-melding@yahoo.com>" },
    { uid: 52, messageId: "<founders@example.org>" }
  ]);
  await assert.rejects(
    resolveMessageUid(client, "All Mail", { uid: 37, messageId: "<founders@example.org>" }),
    /UID 37 in All Mail is not the email .* has UID 52/
  );
  assert.equal(await resolveMessageUid(client, "All Mail", { uid: 52, messageId: "<founders@example.org>" }), 52);
});

test("an unknown messageId is an error naming the folder", async () => {
  await assert.rejects(
    resolveMessageUid(fakeClient([]), "Drafts", { messageId: "<weg@example.org>" }),
    /No email with Message-ID <weg@example.org> in Drafts/
  );
});

test("a messageId held by several emails asks for the uid", async () => {
  const client = fakeClient([
    { uid: 10, messageId: "<aan-mezelf@example.net>" },
    { uid: 11, messageId: "<aan-mezelf@example.net>" }
  ]);
  await assert.rejects(resolveMessageUid(client, "All Mail", { messageId: "<aan-mezelf@example.net>" }), /UIDs 10, 11/);
  assert.equal(await resolveMessageUid(client, "All Mail", { uid: 11, messageId: "<aan-mezelf@example.net>" }), 11);
});

// --- hasAttachments ------------------------------------------------------

test("hasAttachments ignores the body and inline images of an html mail", () => {
  assert.equal(hasAttachments({ type: "text/html", parameters: { charset: "utf-8" } }), false);
  assert.equal(hasAttachments({
    type: "multipart/alternative",
    childNodes: [{ type: "text/plain" }, {
      type: "multipart/related",
      childNodes: [{ type: "text/html" }, { type: "image/png", disposition: "inline", dispositionParameters: { filename: "logo.png" } }]
    }]
  }), false);
  assert.equal(hasAttachments(undefined), false);
});

test("hasAttachments sees attached files, also when sent inline with a name", () => {
  assert.equal(hasAttachments({
    type: "multipart/mixed",
    childNodes: [{ type: "text/plain" }, { type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "f.pdf" } }]
  }), true);
  assert.equal(hasAttachments({
    type: "multipart/mixed",
    childNodes: [{ type: "text/html" }, { type: "application/pdf", disposition: "inline", dispositionParameters: { filename: "f.pdf" } }]
  }), true);
  assert.equal(hasAttachments({
    type: "multipart/mixed",
    childNodes: [{ type: "text/plain" }, { type: "text/plain", parameters: { name: "notities.txt" } }]
  }), true);
});

test("plainTextToHtml turns blank lines into paragraphs and newlines into breaks", () => {
  assert.equal(
    plainTextToHtml("Hoi Jan,\n\nRegel een\nRegel twee"),
    "<p>Hoi Jan,</p>\n<p>Regel een<br>\nRegel twee</p>"
  );
});

test("plainTextToHtml escapes what would otherwise be markup", () => {
  assert.equal(plainTextToHtml('a < b & c "d"'), "<p>a &lt; b &amp; c &quot;d&quot;</p>");
  // A body that reads like html must not become html.
  assert.match(plainTextToHtml("<script>alert(1)</script>"), /&lt;script&gt;/);
});

test("plainTextToHtml always yields an element, even for nothing", () => {
  for (const empty of ["", "   ", "\n\n", undefined, null]) {
    assert.match(plainTextToHtml(empty), /^<p>/);
  }
});

test("bodyParts keeps html the caller supplied, untouched", () => {
  const supplied = '<div class="x"><b>Hoi</b></div>';
  assert.deepEqual(bodyParts("Hoi", supplied), { text: "Hoi", html: supplied });
});

test("bodyParts builds html when the caller supplied none", () => {
  // This is the guarantee: no message composed here goes out as plain text
  // only, whatever the caller remembered to pass.
  for (const missing of [undefined, null, "", "   "]) {
    const parts = bodyParts("Hoi Jan", missing);
    assert.equal(parts.text, "Hoi Jan");
    assert.equal(parts.html, "<p>Hoi Jan</p>");
  }
});
