import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";

import {
  isBlank,
  htmlToPlainText,
  selectBody,
  stripDataUris,
  NO_BODY_NOTICE,
  UNREADABLE_HTML_NOTICE
} from "../body.js";
import * as fixtures from "./fixtures.js";

// Parse the way read_email does: keepCidLinks stops mailparser from expanding
// referenced attachments into base64 data URIs inside the HTML.
const parse = (raw) => simpleParser(raw, { keepCidLinks: true });
const bodyOf = async (raw) => selectBody(await parse(raw));

test("isBlank treats real content as present", () => {
  assert.equal(isBlank("Hallo"), false);
  assert.equal(isBlank("  tekst met spaties  "), false);
  // Invisible padding around real words must not blank out the part.
  assert.equal(isBlank("\u034F Belangrijk \u200B"), false);
});

test("isBlank treats whitespace and invisible padding as absent", () => {
  assert.equal(isBlank(""), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank(null), true);
  assert.equal(isBlank("   \r\n\t "), true);
  assert.equal(isBlank("\u034F\u034F\u00AD\u200B\uFEFF \n"), true);
  assert.equal(isBlank("\u200D\u2060\u180E\u061C"), true);
  assert.equal(isBlank(" 　"), true);
});

test("htmlToPlainText strips markup and keeps link targets", () => {
  const text = htmlToPlainText('<p>Hallo <b>wereld</b></p><a href="https://example.org">meer</a>');
  assert.match(text, /Hallo wereld/);
  assert.match(text, /example\.org/);
  assert.doesNotMatch(text, /<[a-z]/i);
});

test("htmlToPlainText keeps an image's alt text", () => {
  const text = htmlToPlainText('<p>voor<img src="x.png" alt="Welkom bij UnitedConsumers">na</p>');
  assert.match(text, /Welkom bij UnitedConsumers/);
  // The alt text must not be glued to the words on either side of it.
  assert.match(text, /voor Welkom bij UnitedConsumers na/);
});

test("htmlToPlainText drops an alt that is only the image's filename", () => {
  for (const alt of ["8a700107-b3c3.png", "Sigma-handtekening-V1.jpg", "logo.SVG"]) {
    const text = htmlToPlainText(`<p>een<img src="x" alt="${alt}">twee</p>`);
    assert.doesNotMatch(text, /\.(png|jpg|svg)/i, `alt "${alt}" lekte in de tekst`);
    assert.match(text, /een twee/);
  }
});

test("htmlToPlainText keeps neighbours apart across an image without alt", () => {
  // A footer with two addresses either side of a spacer image: skipping the
  // image outright used to merge them into one unusable word.
  const text = htmlToPlainText('<div>marketing@dynamis.nl<img src="s.gif">nieuwsbrief@bmvmakelaars.nl</div>');
  assert.match(text, /marketing@dynamis\.nl nieuwsbrief@bmvmakelaars\.nl/);
});

test("htmlToPlainText yields nothing for markup without text", () => {
  assert.equal(htmlToPlainText('<html><body><img src="x.png"></body></html>'), "");
  assert.equal(htmlToPlainText(""), "");
});

test("multipart/alternative keeps using the text/plain part", async () => {
  const body = await bodyOf(fixtures.MULTIPART_ALTERNATIVE);
  assert.equal(body.bodySource, "plain");
  assert.match(body.text, /Je bestelling is bevestigd\./);
  // The plain part wins, but the HTML is still handed to the client.
  assert.match(body.html, /<b>bevestigd<\/b>/);
});

test("plain-only mail reports no html", async () => {
  const body = await bodyOf(fixtures.PLAIN_ONLY);
  assert.equal(body.bodySource, "plain");
  assert.match(body.text, /Alleen platte tekst\./);
  assert.equal(body.html, null);
});

test("html-only mail yields readable text", async () => {
  const body = await bodyOf(fixtures.HTML_ONLY);
  assert.match(body.text, /Hallo wereld/);
  assert.match(body.html, /<b>wereld<\/b>/);
  // mailparser hands back a non-blank `text` here, derived from the HTML
  // itself, but the message has no text/plain part -- so the reported source
  // must be the HTML, not a part that was never there.
  assert.equal(body.bodySource, "html");
});

test("a text/html root is never reported as a text/plain part", async () => {
  const parsed = await parse(fixtures.HTML_ONLY);
  // Guard the premise: if mailparser ever stops deriving text here, this test
  // would pass for the wrong reason.
  assert.ok(typeof parsed.text === "string" && parsed.text.trim().length > 0);
  assert.equal(selectBody(parsed).bodySource, "html");
});

test("a text/html root is converted by this server, not by mailparser", async () => {
  // mailparser renders an <img> as its source URL and wraps long lines; this
  // server keeps the alt text and drops the URL. Routing every HTML-derived
  // body through one converter is what keeps the two cases consistent.
  const raw = [
    "Subject: Alleen HTML met afbeelding",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<html><body><p>voor<img src="https://tracker.example/pixel.png" alt="Welkom bij Example">na</p></body></html>',
    ""
  ].join("\r\n");
  const parsed = await parse(raw);
  // Premise: mailparser does produce text here, and it carries the URL.
  assert.match(parsed.text, /tracker\.example/);

  const body = selectBody(parsed);
  assert.equal(body.bodySource, "html");
  assert.doesNotMatch(body.text, /tracker\.example/);
  assert.match(body.text, /voor Welkom bij Example na/);
});

test("a real text/plain part is still reported as plain", async () => {
  for (const fixture of [fixtures.PLAIN_ONLY, fixtures.MULTIPART_ALTERNATIVE]) {
    assert.equal((await bodyOf(fixture)).bodySource, "plain");
  }
});

test("a message that is only an attachment reports an empty body", async () => {
  const body = await bodyOf(fixtures.ATTACHMENT_ONLY_EMPTY_BODY);
  assert.equal(body.bodySource, "none");
  assert.equal(body.text, NO_BODY_NOTICE);
  assert.equal(body.html, null);
});

test("html inside multipart/related falls back to the html part", async () => {
  const parsed = await parse(fixtures.HTML_WITH_INLINE_IMAGE);
  // Guard the premise: this is exactly the case mailparser leaves empty.
  assert.equal(parsed.text, undefined);

  const body = selectBody(parsed);
  assert.equal(body.bodySource, "html");
  assert.match(body.text, /Je afspraak staat gepland op dinsdag\./);
  assert.match(body.html, /<p>/);
});

test("html inside multipart/mixed with a pdf falls back to the html part", async () => {
  const parsed = await parse(fixtures.HTML_WITH_PDF_ATTACHMENT);
  assert.equal(parsed.text, undefined);

  const body = selectBody(parsed);
  assert.equal(body.bodySource, "html");
  assert.match(body.text, /Bijgaand de factuur van deze maand\./);
  // The attachment must still be visible to the caller.
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, "factuur.pdf");
});

test("a text/plain part of pure padding falls back to the html part", async () => {
  const parsed = await parse(fixtures.PADDED_PLAIN_PART);
  // The padded part is a non-empty string that survives trim(), so a plain
  // truthiness check would wrongly accept it.
  assert.equal(typeof parsed.text, "string");
  assert.notEqual(parsed.text.trim(), "");

  const body = selectBody(parsed);
  assert.equal(body.bodySource, "html");
  assert.match(body.text, /De echte inhoud staat alleen in de HTML\./);
});

test("html without extractable text reports an explicit notice", async () => {
  const body = await bodyOf(fixtures.HTML_WITHOUT_TEXT);
  assert.equal(body.bodySource, "none");
  assert.equal(body.text, UNREADABLE_HTML_NOTICE);
  // The raw HTML is still returned so a client can render it itself.
  assert.match(body.html, /<img/);
});

test("a message with no body parts reports an explicit notice", async () => {
  const body = await bodyOf(fixtures.NO_BODY_AT_ALL);
  assert.equal(body.bodySource, "none");
  assert.equal(body.text, NO_BODY_NOTICE);
  assert.equal(body.html, null);
});

test("an inline logo stays a cid reference instead of becoming base64", async () => {
  const parsed = await parse(fixtures.LARGE_INLINE_LOGO);
  const body = selectBody(parsed);

  assert.match(body.html, /src="cid:logo"/);
  assert.doesNotMatch(body.html, /base64/);
  // The 40 kB payload must not have leaked into the reported body.
  assert.ok(body.html.length < 1024, `html was ${body.html.length} chars`);
  // It is still reachable as an attachment.
  assert.equal(parsed.attachments[0].filename, "logo.png");
  assert.equal(parsed.attachments[0].cid, "logo");
  assert.match(body.text, /Nieuws van deze maand\./);
});

test("without keepCidLinks the same message would carry the payload", async () => {
  // Guards the premise of the test above: this is what we are avoiding.
  const inlined = await simpleParser(fixtures.LARGE_INLINE_LOGO);
  assert.match(inlined.html, /base64/);
  assert.ok(inlined.html.length > 40000, `html was ${inlined.html.length} chars`);
});

test("an oversized data uri embedded by the sender is replaced by a marker", async () => {
  const body = await bodyOf(fixtures.HTML_WITH_EMBEDDED_DATA_URI);

  assert.match(body.html, /\[inline data removed: image\/png, \d+ bytes\]/);
  assert.ok(body.html.length < 1024, `html was ${body.html.length} chars`);
  // Surrounding markup and the readable text are untouched.
  assert.match(body.html, /<p>Bekijk de bijgevoegde grafiek\.<\/p>/);
  assert.match(body.text, /Bekijk de bijgevoegde grafiek\./);
});

test("a small data uri is left intact", async () => {
  const body = await bodyOf(fixtures.HTML_WITH_EMBEDDED_DATA_URI);
  assert.match(body.html, /data:image\/gif;base64,R0lGODlhAQABAAAAACw=/);
});

test("stripDataUris leaves markup without data uris untouched", () => {
  const html = '<p>Hallo</p><img src="https://example.org/logo.png">';
  assert.equal(stripDataUris(html), html);
  assert.equal(stripDataUris(""), "");
  assert.equal(stripDataUris(null), null);
});

test("the body is never a silent empty string", async () => {
  for (const [name, raw] of Object.entries(fixtures)) {
    const body = await bodyOf(raw);
    assert.equal(typeof body.text, "string", `${name} must return a string`);
    assert.notEqual(body.text, "", `${name} must not return an empty body`);
  }
});
