import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";

import {
  parseCalendar,
  parseCalendarDate,
  describeAttachments,
  findAttachment,
  attachmentContent,
  isPdfAttachment,
  MAX_INLINE_TEXT_BYTES
} from "../attachments.js";
import { selectBody } from "../body.js";
import * as fixtures from "./fixtures.js";

const parse = (raw) => simpleParser(raw, { keepCidLinks: true });

test("parseCalendarDate handles local, utc and all-day values", () => {
  assert.deepEqual(parseCalendarDate("20260915T100000", { TZID: "Europe/Amsterdam" }), {
    value: "2026-09-15T10:00:00", timezone: "Europe/Amsterdam", allDay: false
  });
  assert.deepEqual(parseCalendarDate("20261001T080000Z"), {
    value: "2026-10-01T08:00:00Z", timezone: "UTC", allDay: false
  });
  assert.deepEqual(parseCalendarDate("20261002", { VALUE: "DATE" }), {
    value: "2026-10-02", timezone: null, allDay: true
  });
  // A floating time keeps no zone rather than inventing one.
  assert.equal(parseCalendarDate("20260915T100000").timezone, null);
});

test("parseCalendar returns null for text that is not a calendar", () => {
  assert.equal(parseCalendar("datum;bedrag\n2026-09-01;12,50"), null);
  assert.equal(parseCalendar(""), null);
  assert.equal(parseCalendar(undefined), null);
});

test("a google/outlook style invite exposes its date next to the body", async () => {
  const parsed = await parse(fixtures.CALENDAR_INVITE);
  // Guard the premise: mailparser files the calendar part as an attachment
  // without a filename, so a reader cannot recognise it by name.
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, undefined);
  // And the body itself says nothing useful.
  assert.doesNotMatch(selectBody(parsed).text, /15/);

  const [entry] = await describeAttachments(parsed);
  assert.equal(entry.index, 0);
  assert.equal(entry.contentType, "text/calendar");
  assert.match(entry.content, /BEGIN:VCALENDAR/);

  const { calendar } = entry;
  assert.equal(calendar.method, "REQUEST");
  assert.equal(calendar.events.length, 1);
  const [event] = calendar.events;
  assert.equal(event.summary, "Kwartaaloverleg Q3");
  assert.equal(event.start, "2026-09-15T10:00:00");
  assert.equal(event.end, "2026-09-15T11:30:00");
  assert.equal(event.timezone, "Europe/Amsterdam");
  assert.equal(event.allDay, false);
  assert.equal(event.status, "CONFIRMED");
  assert.equal(event.uid, "afspraak-42@example.org");
});

test("calendar text values are unescaped and folded lines rejoined", async () => {
  const parsed = await parse(fixtures.CALENDAR_INVITE);
  const [{ calendar }] = await describeAttachments(parsed);
  const [event] = calendar.events;
  assert.equal(event.location, "Vergaderzaal 2, Hoofdkantoor");
  assert.equal(
    event.description,
    "Agenda:\n1. Cijfers\n2. Planning; een lange regel die door de afzender is gevouwen omdat hij te lang was"
  );
  // A quoted CN containing ':' must not be mistaken for the value separator.
  assert.equal(event.organizer, "Planning: Team <planning@example.org>");
  assert.deepEqual(event.attendees, [
    "Ontvanger <ontvanger@example.net>",
    "Collega <collega@example.org>"
  ]);
});

test("nested VALARM and VTIMEZONE do not leak into the event", async () => {
  const parsed = await parse(fixtures.CALENDAR_INVITE);
  const [{ calendar }] = await describeAttachments(parsed);
  const [event] = calendar.events;
  // The alarm's DESCRIPTION would otherwise overwrite the event's.
  assert.doesNotMatch(event.description, /Herinnering/);
  // The timezone's DTSTART (1970) must not become the event start.
  assert.doesNotMatch(event.start, /1970/);
});

test("a named .ics attachment is parsed the same way", async () => {
  const parsed = await parse(fixtures.CALENDAR_ICS_ATTACHMENT);
  const [entry] = await describeAttachments(parsed);
  assert.equal(entry.filename, "afspraak.ics");
  assert.equal(entry.contentType, "application/ics");
  assert.equal(entry.disposition, "attachment");

  const { calendar } = entry;
  // No METHOD in the file and none on the content type: reported as null.
  assert.equal(calendar.method, null);
  assert.equal(calendar.events.length, 2);
  assert.equal(calendar.events[0].summary, "Bezoek monteur");
  assert.equal(calendar.events[0].start, "2026-10-01T08:00:00Z");
  assert.equal(calendar.events[0].timezone, "UTC");
  assert.equal(calendar.events[1].summary, "Hele dag vrij");
  assert.equal(calendar.events[1].start, "2026-10-02");
  assert.equal(calendar.events[1].allDay, true);
});

test("the content-type method parameter fills in a missing METHOD line", async () => {
  const parsed = await parse(fixtures.CALENDAR_INVITE);
  parsed.attachments[0].content = Buffer.from(
    "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:X\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
  );
  const [{ calendar }] = await describeAttachments(parsed);
  assert.equal(calendar.method, "REQUEST");
});

test("a text attachment is inlined and decoded with its own charset", async () => {
  const parsed = await parse(fixtures.CSV_ATTACHMENT);
  const [entry] = await describeAttachments(parsed);
  assert.equal(entry.filename, "afschrift.csv");
  assert.match(entry.content, /^datum;omschrijving;bedrag/);
  // Latin-1 é must come through as é, not as a replacement character.
  assert.match(entry.content, /Café;12,50/);
  assert.equal(entry.calendar, undefined);
});

test("an oversized text attachment is listed but not inlined", async () => {
  const parsed = await parse(fixtures.CSV_ATTACHMENT);
  const [entry] = await describeAttachments(parsed, { maxInlineBytes: 8 });
  assert.equal(entry.content, null);
  assert.match(entry.note, /exceeds the 8 byte inline limit; use read_attachment/);
  assert.ok(MAX_INLINE_TEXT_BYTES > 8);
});

test("a pdf that cannot be parsed is listed with a note, not an error", async () => {
  const parsed = await parse(fixtures.HTML_WITH_PDF_ATTACHMENT);
  const [entry] = await describeAttachments(parsed);
  assert.equal(entry.filename, "factuur.pdf");
  assert.equal(entry.content, null);
  assert.match(entry.note, /text not extracted: not a valid PDF file/);
});

test("binary attachments are listed with metadata only", async () => {
  const parsed = await parse(fixtures.HTML_WITH_PDF_ATTACHMENT);
  parsed.attachments[0].contentType = "application/zip";
  parsed.attachments[0].filename = "archief.zip";
  const [entry] = await describeAttachments(parsed);
  assert.deepEqual(entry, {
    index: 0,
    filename: "archief.zip",
    contentType: "application/zip",
    size: 9,
    disposition: "attachment",
    cid: null
  });
});

test("an inline image keeps its cid so the html reference can be followed", async () => {
  const parsed = await parse(fixtures.INLINE_IMAGE_INVOICE);
  const [entry] = await describeAttachments(parsed);
  assert.equal(entry.cid, "scan");
  assert.equal(entry.disposition, "inline");
  assert.equal(entry.contentType, "image/jpeg");
  assert.equal("content" in entry, false);
});

test("findAttachment resolves by index or by case-insensitive filename", async () => {
  const parsed = await parse(fixtures.CSV_ATTACHMENT);
  assert.equal(findAttachment(parsed, { index: 0 }).filename, "afschrift.csv");
  assert.equal(findAttachment(parsed, { filename: "AFSCHRIFT.CSV" }).filename, "afschrift.csv");
  // Index wins when both are given.
  assert.equal(findAttachment(parsed, { index: 0, filename: "nope" }).filename, "afschrift.csv");
});

test("findAttachment explains what is available when nothing matches", async () => {
  const parsed = await parse(fixtures.CSV_ATTACHMENT);
  assert.throws(() => findAttachment(parsed, { index: 3 }), /index 3; available: 0: afschrift\.csv \(text\/csv\)/);
  assert.throws(() => findAttachment(parsed, { filename: "x.pdf" }), /filename "x\.pdf"/);
  assert.throws(() => findAttachment(parsed, {}), /Specify either index or filename/);
  const empty = await parse(fixtures.PLAIN_ONLY);
  assert.throws(() => findAttachment(empty, { index: 0 }), /has no attachments/);
});

test("read_attachment returns an image as an MCP image block", async () => {
  const parsed = await parse(fixtures.INLINE_IMAGE_INVOICE);
  const blocks = await attachmentContent(findAttachment(parsed, { index: 0 }), 0);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /"filename": "factuur-scan\.jpg"/);
  assert.equal(blocks[1].type, "image");
  assert.equal(blocks[1].mimeType, "image/jpeg");
  assert.equal(Buffer.from(blocks[1].data, "base64").subarray(0, 3).toString("hex"), "ffd8ff");
});

test("read_attachment refuses an image above the size limit", async () => {
  const parsed = await parse(fixtures.INLINE_IMAGE_INVOICE);
  const blocks = await attachmentContent(parsed.attachments[0], 0, { maxImageBytes: 4 });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /image not returned/);
});

test("read_attachment returns calendar text with its parsed events", async () => {
  const parsed = await parse(fixtures.CALENDAR_ICS_ATTACHMENT);
  const blocks = await attachmentContent(parsed.attachments[0], 0);
  assert.equal(blocks.length, 1);
  const result = JSON.parse(blocks[0].text);
  assert.match(result.content, /BEGIN:VCALENDAR/);
  assert.equal(result.calendar.events[0].summary, "Bezoek monteur");
  assert.equal(result.truncated, undefined);
});

test("read_attachment truncates oversized text and says so", async () => {
  const parsed = await parse(fixtures.CSV_ATTACHMENT);
  const blocks = await attachmentContent(parsed.attachments[0], 0, { maxTextBytes: 5 });
  const result = JSON.parse(blocks[0].text);
  assert.equal(result.content, "datum");
  assert.equal(result.truncated, true);
});

test("read_attachment returns other binaries as base64 under the limit", async () => {
  const parsed = await parse(fixtures.HTML_WITH_PDF_ATTACHMENT);
  parsed.attachments[0].contentType = "application/zip";
  const [ok] = await attachmentContent(parsed.attachments[0], 0);
  const result = JSON.parse(ok.text);
  assert.equal(Buffer.from(result.contentBase64, "base64").toString(), "%PDF-1.4\n");

  const [refused] = await attachmentContent(parsed.attachments[0], 0, { maxBinaryBytes: 4 });
  assert.match(refused.text, /content not returned/);
  assert.doesNotMatch(refused.text, /contentBase64/);
});

test("messages without attachments describe an empty list", async () => {
  const parsed = await parse(fixtures.PLAIN_ONLY);
  assert.deepEqual(await describeAttachments(parsed), []);
});

test("a pdf invoice's text is inlined next to the body", async () => {
  const parsed = await parse(fixtures.PDF_INVOICE);
  const [entry] = await describeAttachments(parsed);
  assert.equal(entry.filename, "factuur-2026-0917.pdf");
  assert.equal(entry.pages, 2);
  assert.equal(entry.pdfInfo.title, "Factuur 2026-0917");
  assert.equal(entry.note, undefined);
  // The figures a reader needs are present, and a table row stays one line.
  assert.match(entry.content, /Vervaldatum: 30 september 2026/);
  assert.match(entry.content, /^Arbeid 4 EUR 55,00 EUR 220,00$/m);
  assert.match(entry.content, /^Totaal incl\. btw EUR 363,00$/m);
  assert.match(entry.content, /NL00BANK0123456789/);
  assert.match(entry.content, /--- page 2 ---\nAlgemene voorwaarden/);
});

test("a scanned pdf sent as octet-stream is recognised and reported as unreadable", async () => {
  const parsed = await parse(fixtures.SCANNED_PDF);
  // mailparser already resolves the type from the .pdf name; the fallback in
  // isPdfAttachment covers parsers and senders that do not.
  assert.equal(parsed.attachments[0].contentType, "application/pdf");
  assert.equal(isPdfAttachment({ contentType: "application/octet-stream", filename: "scan.PDF" }), true);
  assert.equal(isPdfAttachment({ contentType: "application/octet-stream", filename: "scan.zip" }), false);
  const [entry] = await describeAttachments(parsed);
  assert.equal(entry.pages, 1);
  assert.equal(entry.content, null);
  assert.match(entry.note, /no text layer/);
});

test("an oversized pdf is not parsed inline", async () => {
  const parsed = await parse(fixtures.PDF_INVOICE);
  const [entry] = await describeAttachments(parsed, { maxPdfBytes: 16 });
  assert.equal(entry.content, null);
  assert.match(entry.note, /exceeds the 16 byte limit/);
  assert.equal(entry.pages, undefined);
});

test("inlined pdf text honours the inline text cap", async () => {
  const parsed = await parse(fixtures.PDF_INVOICE);
  const [entry] = await describeAttachments(parsed, { maxInlineBytes: 20 });
  assert.equal(entry.truncated, true);
  assert.equal(Buffer.byteLength(entry.content), 20);
});

test("read_attachment returns pdf text, never the pdf's bytes", async () => {
  const parsed = await parse(fixtures.PDF_INVOICE);
  const blocks = await attachmentContent(parsed.attachments[0], 0);
  assert.equal(blocks.length, 1);
  const result = JSON.parse(blocks[0].text);
  assert.match(result.content, /EUR 363,00/);
  assert.equal(result.pages, 2);
  assert.equal(result.contentBase64, undefined);
  assert.doesNotMatch(blocks[0].text, /JVBERi/);
});
