import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, readFile, rm, realpath } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join, basename } from "path";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";

import { resolveWritePath, writeFileGuarded } from "../compose.js";
import { findAttachment } from "../attachments.js";

// A minimal but structurally valid PDF, so the saved bytes can be checked the
// way a real invoice would be.
const PDF = Buffer.from(
  "255044462d312e340a25c7ec8f0a312030206f626a0a3c3c2f54797065202f436174616c6f67" +
  "2f50616765732032203020523e3e0a656e646f626a0a747261696c65720a3c3c2f526f6f7420" +
  "31203020523e3e0a2525454f460a",
  "hex"
);

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "proton-mcp-save-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return await realpath(dir);
}

test("resolveWritePath accepts a file in an existing directory", async (t) => {
  const dir = await tempDir(t);
  assert.equal(await resolveWritePath(join(dir, "factuur.pdf")), join(dir, "factuur.pdf"));
});

test("resolveWritePath expands a leading ~", async () => {
  const resolved = await resolveWritePath("~/proton-mcp-does-not-exist.pdf");
  assert.equal(resolved, join(await realpath(homedir()), "proton-mcp-does-not-exist.pdf"));
});

test("resolveWritePath refuses a relative path", async () => {
  await assert.rejects(() => resolveWritePath("factuur.pdf"), /must be absolute/);
});

test("resolveWritePath refuses a directory that does not exist", async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(
    () => resolveWritePath(join(dir, "nope", "factuur.pdf")),
    /Destination directory does not exist/
  );
});

test("resolveWritePath refuses a path that names no file", async (t) => {
  const dir = await tempDir(t);
  // Not join(): that would normalise the ".." away before it is ever checked.
  await assert.rejects(() => resolveWritePath(`${dir}/..`), /must name a file/);
  await assert.rejects(() => resolveWritePath(`${dir}/.`), /must name a file/);
});

test("resolveWritePath accepts a destination inside the attachment root", async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, "facturen"));
  const target = join(root, "facturen", "hetzner.pdf");
  assert.equal(await resolveWritePath(target, { root }), target);
});

test("resolveWritePath refuses a destination outside the attachment root", async (t) => {
  const root = await tempDir(t);
  const elsewhere = await tempDir(t);
  await assert.rejects(
    () => resolveWritePath(join(elsewhere, "hetzner.pdf"), { root }),
    /outside PROTON_BRIDGE_ATTACHMENT_ROOT/
  );
});

test("resolveWritePath refuses a symlink inside the root aimed outside it", async (t) => {
  const root = await tempDir(t);
  const elsewhere = await tempDir(t);
  await symlink(elsewhere, join(root, "escape"));
  await assert.rejects(
    () => resolveWritePath(join(root, "escape", "hetzner.pdf"), { root }),
    /outside PROTON_BRIDGE_ATTACHMENT_ROOT/
  );
});

test("writeFileGuarded writes a new file and reports its size", async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, "factuur.pdf");
  assert.equal(await writeFileGuarded(target, PDF), PDF.length);
  assert.deepEqual(await readFile(target), PDF);
});

test("writeFileGuarded refuses an existing file by default", async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, "factuur.pdf");
  await writeFile(target, "keep me");
  await assert.rejects(() => writeFileGuarded(target, PDF), /already exists/);
  assert.equal(await readFile(target, "utf-8"), "keep me");
});

test("writeFileGuarded replaces an existing file when overwrite is set", async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, "factuur.pdf");
  await writeFile(target, "old");
  await writeFileGuarded(target, PDF, { overwrite: true });
  assert.deepEqual(await readFile(target), PDF);
});

test("writeFileGuarded refuses to write through a symlink even with overwrite", async (t) => {
  const dir = await tempDir(t);
  const outside = join(dir, "outside.pdf");
  await writeFile(outside, "do not touch");
  const link = join(dir, "link.pdf");
  await symlink(outside, link);
  await assert.rejects(
    () => writeFileGuarded(link, PDF, { overwrite: true }),
    /symlink/
  );
  assert.equal(await readFile(outside, "utf-8"), "do not touch");
});

test("writeFileGuarded refuses a destination that is a directory", async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, "subdir");
  await mkdir(target);
  await assert.rejects(() => writeFileGuarded(target, PDF, { overwrite: true }), /not a regular file/);
});

// The path the tool actually takes: parse a message, pick the attachment the
// way read_email indexes them, and write those bytes out.
test("an attachment picked from a parsed message lands on disk byte for byte", async (t) => {
  const dir = await tempDir(t);
  const raw = await new Promise((resolve, reject) => {
    new MailComposer({
      from: "billing@hetzner.com",
      to: "me@example.com",
      subject: "Invoice",
      text: "See attached.",
      attachments: [{ filename: "hetzner.pdf", content: PDF, contentType: "application/pdf" }]
    }).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
  const parsed = await simpleParser(raw, { keepCidLinks: true });

  for (const ref of [{ index: 0 }, { filename: "HETZNER.PDF" }]) {
    const attachment = findAttachment(parsed, ref);
    assert.equal(attachment.contentType, "application/pdf");
    const target = join(dir, `${basename(JSON.stringify(ref), ".json")}.pdf`);
    const size = await writeFileGuarded(target, attachment.content);
    const onDisk = await readFile(target);
    assert.deepEqual(onDisk, PDF);
    assert.equal(size, PDF.length);
    assert.equal(onDisk.subarray(0, 5).toString("latin1"), "%PDF-");
  }
});
