import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePageSpec,
  renderPdfPages,
  DEFAULT_RENDER_PAGES,
  MAX_RENDER_PAGES
} from "../pdf-render.js";
import { extractPdfText } from "../pdf-text.js";
import { attachmentContent, describeAttachments } from "../attachments.js";
import { SCANNED_PDF } from "./scan-fixture.js";

test("the fixture really has no text layer", async () => {
  // The premise of the whole feature: if this ever starts extracting text,
  // the rendering path below would never be reached in practice.
  const extracted = await extractPdfText(SCANNED_PDF);
  assert.equal(extracted.hasTextLayer, false);
  assert.equal(extracted.pages, 1);
});

test("parsePageSpec defaults to the first pages", () => {
  assert.deepEqual(parsePageSpec(undefined, 9), [1, 2]);
  assert.deepEqual(parsePageSpec("", 9), [1, 2]);
  // A document shorter than the default yields only what exists.
  assert.deepEqual(parsePageSpec(undefined, 1), [1]);
});

test("parsePageSpec reads numbers, ranges, lists and all", () => {
  assert.deepEqual(parsePageSpec("3", 9), [3]);
  assert.deepEqual(parsePageSpec("2-5", 9), [2, 3, 4, 5]);
  assert.deepEqual(parsePageSpec("5-2", 9), [2, 3, 4, 5], "a reversed range still reads as a range");
  assert.deepEqual(parsePageSpec("1,4,2", 9), [1, 2, 4], "sorted and de-duplicated");
  assert.deepEqual(parsePageSpec("1,1,1", 9), [1]);
  assert.deepEqual(parsePageSpec("ALL", 3), [1, 2, 3], "case does not matter");
});

test("parsePageSpec drops pages the document does not have", () => {
  assert.deepEqual(parsePageSpec("2-10", 3), [2, 3]);
  assert.deepEqual(parsePageSpec("7", 3), []);
  assert.deepEqual(parsePageSpec("all", 0), []);
});

test("parsePageSpec never returns more than the per-call ceiling", () => {
  assert.equal(parsePageSpec("all", 500).length, MAX_RENDER_PAGES);
  assert.equal(parsePageSpec("1-400", 500).length, MAX_RENDER_PAGES);
});

test("parsePageSpec refuses something that is not a page", () => {
  assert.throws(() => parsePageSpec("kaas", 5), /Cannot read "kaas"/);
  assert.throws(() => parsePageSpec("1-", 5), /Cannot read/);
});

test("renderPdfPages renders a scanned page to a JPEG", async () => {
  const { images, pageCount } = await renderPdfPages(SCANNED_PDF, { width: 400 });
  assert.equal(pageCount, 1);
  assert.equal(images.length, 1);
  const [image] = images;
  assert.equal(image.page, 1);
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.width, 400);
  assert.ok(image.height > 0);
  const bytes = Buffer.from(image.base64, "base64");
  // JPEG files start with FF D8 FF; anything else means we produced junk.
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

test("read_attachment returns a scanned PDF as image blocks", async () => {
  const attachment = {
    filename: "scan.pdf",
    contentType: "application/pdf",
    size: SCANNED_PDF.length,
    content: SCANNED_PDF
  };
  const content = await attachmentContent(attachment, 0);

  const [meta, ...images] = content;
  assert.equal(meta.type, "text");
  const entry = JSON.parse(meta.text);
  assert.equal(entry.content, null, "a scan has no text to report");
  assert.deepEqual(entry.renderedPages, [1]);
  assert.match(entry.note, /scanned PDF/);
  // Nothing is withheld here, so the caller is not told to ask for more.
  assert.doesNotMatch(entry.note, /pass pages/i);

  assert.equal(images.length, 1);
  assert.equal(images[0].type, "image");
  assert.equal(images[0].mimeType, "image/jpeg");
  assert.ok(images[0].data.length > 0);
});

test("a page range the document cannot satisfy is reported, not thrown", async () => {
  const attachment = {
    filename: "scan.pdf",
    contentType: "application/pdf",
    size: SCANNED_PDF.length,
    content: SCANNED_PDF
  };
  const content = await attachmentContent(attachment, 0, { renderPages: "5-9" });
  assert.equal(content.length, 1, "no image blocks when nothing matched");
  assert.match(JSON.parse(content[0].text).note, /no pages matched/);
});

test("an unreadable page spec becomes a note rather than an error", async () => {
  const attachment = {
    filename: "scan.pdf",
    contentType: "application/pdf",
    size: SCANNED_PDF.length,
    content: SCANNED_PDF
  };
  const content = await attachmentContent(attachment, 0, { renderPages: "kaas" });
  assert.match(JSON.parse(content[0].text).note, /pages not rendered: Cannot read "kaas"/);
});

test("the default page count is what the note promises", () => {
  // The note tells callers "the default is the first N"; keep them in step.
  assert.equal(DEFAULT_RENDER_PAGES, 2);
});

test("the read_email listing does not leak the internal scanned marker", async () => {
  const [entry] = await describeAttachments({
    attachments: [{
      filename: "scan.pdf",
      contentType: "application/pdf",
      size: SCANNED_PDF.length,
      content: SCANNED_PDF
    }]
  });
  assert.equal(entry.content, null);
  assert.match(entry.note, /no text layer/);
  assert.ok(!("scanned" in entry), "`scanned` steers attachmentContent and is not part of the output");
});
