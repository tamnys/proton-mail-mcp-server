import test from "node:test";
import assert from "node:assert/strict";

import { itemsToText, extractPdfText } from "../pdf-text.js";
import { makePdf } from "./pdf-fixture.js";

const item = (str, x, y, { width = str.length * 6, height = 12, hasEOL = false } = {}) =>
  ({ str, transform: [12, 0, 0, 12, x, y], width, height, hasEOL });

test("itemsToText breaks lines on eol flags and baseline changes", () => {
  const text = itemsToText([
    item("Regel een", 50, 700, { hasEOL: true }),
    item("Regel twee", 50, 684),
    item("Regel drie", 50, 668)
  ]);
  assert.equal(text, "Regel een\nRegel twee\nRegel drie");
});

test("itemsToText keeps words on one baseline together as a row", () => {
  const text = itemsToText([
    item("Arbeid", 50, 600),
    item(" ", 86, 600, { width: 40, height: 0 }),
    item("4", 130, 600),
    item("EUR 55,00", 200, 600)
  ]);
  assert.equal(text, "Arbeid 4 EUR 55,00");
});

test("itemsToText does not split a word that pdf.js delivers in pieces", () => {
  const text = itemsToText([item("Fac", 50, 600), item("tuur", 68, 600)]);
  assert.equal(text, "Factuur");
});

test("itemsToText handles empty input and stray whitespace", () => {
  assert.equal(itemsToText([]), "");
  assert.equal(itemsToText([item(" ", 50, 600, { height: 0 })]), "");
});

test("extractPdfText reads every page and the document info", async () => {
  const pdf = makePdf([["Eerste pagina"], ["Tweede pagina"]], { title: "Test" });
  const result = await extractPdfText(pdf);
  assert.equal(result.pages, 2);
  assert.equal(result.pagesRead, 2);
  assert.equal(result.hasTextLayer, true);
  assert.equal(result.info.title, "Test");
  assert.equal(result.text, "--- page 1 ---\nEerste pagina\n\n--- page 2 ---\nTweede pagina");
});

test("extractPdfText omits page markers for a single page", async () => {
  const result = await extractPdfText(makePdf([["Alleen dit"]]));
  assert.equal(result.text, "Alleen dit");
});

test("extractPdfText stops at maxPages", async () => {
  const pdf = makePdf([["A"], ["B"], ["C"]]);
  const result = await extractPdfText(pdf, { maxPages: 2 });
  assert.equal(result.pages, 3);
  assert.equal(result.pagesRead, 2);
  assert.doesNotMatch(result.text, /C/);
});

test("extractPdfText reports a missing text layer", async () => {
  const result = await extractPdfText(makePdf([[]]));
  assert.equal(result.hasTextLayer, false);
  assert.equal(result.text, "");
  assert.equal(result.pages, 1);
});

test("extractPdfText rejects input that is not a pdf", async () => {
  await assert.rejects(extractPdfText(Buffer.from("hallo")), /not a valid PDF file/);
  await assert.rejects(extractPdfText(Buffer.from("%PDF-1.4\n")), /not a valid PDF file/);
});

test("extractPdfText writes nothing to stdout", async () => {
  // The MCP transport runs over stdout; a stray console.log would corrupt it.
  const original = process.stdout.write;
  let leaked = "";
  process.stdout.write = (chunk) => { leaked += chunk; return true; };
  try {
    await extractPdfText(makePdf([["x"]]));
    await extractPdfText(Buffer.from("junk")).catch(() => {});
  } finally {
    process.stdout.write = original;
  }
  assert.equal(leaked, "");
});
