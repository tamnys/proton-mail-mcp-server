import { htmlToPlainText } from "./body.js";
import { extractPdfText } from "./pdf-text.js";
import { renderPdfPages, DEFAULT_RENDER_PAGES, MAX_RENDER_PAGES } from "./pdf-render.js";

// Attachments whose contents are text a reader can use directly. These are
// inlined into the read_email response, so an invite's date or a CSV's rows
// arrive in the same call as the body instead of hiding behind a filename.
// text/html attachments are converted to plain text like the body is.
const INLINE_TEXT_TYPES = /^(text\/|application\/ics$)/i;
const CALENDAR_TYPES = /^(text\/calendar|application\/ics)$/i;
const PDF_TYPES = /^(application\/pdf|application\/x-pdf)$/i;

// Above this an inlined text attachment would dominate the response, so it is
// left to read_attachment instead. The same cap applies to the text extracted
// from a PDF; the PDF file itself may be larger, up to MAX_INLINE_PDF_BYTES.
export const MAX_INLINE_TEXT_BYTES = 64 * 1024;
export const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024;

// read_attachment limits. Images go back as an MCP image block, which the
// client hands to the model as a picture; binaries go back as base64 inside
// the JSON, where every byte costs context, hence the tighter cap.
export const MAX_ATTACHMENT_TEXT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_BINARY_BYTES = 1024 * 1024;

function charsetOf(attachment) {
  return attachment?.headers?.get?.("content-type")?.params?.charset || "utf-8";
}

// Decode an attachment's bytes as text, honouring its declared charset when
// the runtime knows it and falling back to UTF-8 otherwise.
export function decodeText(attachment) {
  const content = attachment?.content;
  if (!Buffer.isBuffer(content)) return "";
  let decoder;
  try {
    decoder = new TextDecoder(charsetOf(attachment));
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(content);
}

export function isInlineTextType(contentType) {
  return INLINE_TEXT_TYPES.test(contentType || "");
}

export function isCalendarType(contentType) {
  return CALENDAR_TYPES.test(contentType || "");
}

// PDFs are sometimes sent as application/octet-stream; go by the name then.
export function isPdfAttachment(attachment) {
  if (PDF_TYPES.test(attachment?.contentType || "")) return true;
  return /^application\/octet-stream$/i.test(attachment?.contentType || "") &&
    /\.pdf$/i.test(attachment?.filename || "");
}

// --- iCalendar -----------------------------------------------------------

// RFC 5545 text values escape newlines, commas, semicolons and backslashes.
function unescapeText(value) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// Split one content line into name, params and value. Parameter values may
// be quoted and may contain ':' or ';', so a plain split would cut the line
// in the wrong place for lines such as ATTENDEE;CN="Team: Sales":mailto:...
function parseLine(line) {
  let i = 0;
  let quoted = false;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) break;
    i++;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const segments = [];
  let start = 0;
  quoted = false;
  for (let j = 0; j <= head.length; j++) {
    const ch = head[j];
    if (ch === '"') quoted = !quoted;
    if ((ch === ";" && !quoted) || j === head.length) {
      segments.push(head.slice(start, j));
      start = j + 1;
    }
  }
  const name = segments.shift().toUpperCase();
  const params = {};
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).toUpperCase();
    params[key] = segment.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

// Turn an iCalendar date or date-time into something a reader can act on.
// Returns { value, timezone, allDay }. Local times keep their TZID rather
// than being converted, since the invite's own zone is what the reader wants
// to see; UTC times are marked with a trailing Z and timezone "UTC".
export function parseCalendarDate(value, params = {}) {
  const raw = (value || "").trim();
  let m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === "DATE") {
    m = m || raw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return { value: raw, timezone: null, allDay: true };
    return { value: `${m[1]}-${m[2]}-${m[3]}`, timezone: null, allDay: true };
  }
  m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return { value: raw, timezone: params.TZID || null, allDay: false };
  const utc = m[7] === "Z";
  return {
    value: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${utc ? "Z" : ""}`,
    timezone: utc ? "UTC" : params.TZID || null,
    allDay: false
  };
}

function formatCalUser(value, params) {
  const address = value.replace(/^mailto:/i, "");
  return params.CN ? `${params.CN} <${address}>` : address;
}

function finishEvent(props) {
  const start = props.DTSTART ? parseCalendarDate(props.DTSTART.value, props.DTSTART.params) : null;
  const end = props.DTEND ? parseCalendarDate(props.DTEND.value, props.DTEND.params) : null;
  const event = {
    summary: props.SUMMARY ? unescapeText(props.SUMMARY.value) : null,
    start: start?.value || null,
    end: end?.value || null,
    duration: props.DURATION?.value || null,
    timezone: start?.timezone || end?.timezone || null,
    allDay: start?.allDay || false,
    location: props.LOCATION ? unescapeText(props.LOCATION.value) : null,
    organizer: props.ORGANIZER ? formatCalUser(props.ORGANIZER.value, props.ORGANIZER.params) : null,
    attendees: (props.ATTENDEE || []).map((p) => formatCalUser(p.value, p.params)),
    status: props.STATUS?.value || null,
    recurrence: props.RRULE?.value || null,
    description: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : null,
    uid: props.UID?.value || null
  };
  return event;
}

// Parse the VEVENTs out of an iCalendar document. Returns null when the text
// is not a calendar at all. Only the properties a reader needs to answer
// "when, where, with whom" are extracted; VTIMEZONE and VALARM are skipped.
export function parseCalendar(text) {
  if (typeof text !== "string" || !/BEGIN:VCALENDAR/i.test(text)) return null;
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  let method = null;
  const events = [];
  let current = null;
  let skipDepth = 0;
  for (const line of lines) {
    if (line === "") continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;
    if (name === "BEGIN") {
      const component = value.toUpperCase();
      if (current) {
        skipDepth++;
      } else if (component === "VEVENT") {
        current = {};
      }
      continue;
    }
    if (name === "END") {
      if (skipDepth > 0) {
        skipDepth--;
      } else if (current && value.toUpperCase() === "VEVENT") {
        events.push(finishEvent(current));
        current = null;
      }
      continue;
    }
    if (skipDepth > 0) continue;
    if (current) {
      if (name === "ATTENDEE") {
        (current.ATTENDEE ||= []).push({ value, params });
      } else {
        current[name] = { value, params };
      }
    } else if (name === "METHOD") {
      method = value.toUpperCase();
    }
  }
  return { method, events };
}

// --- Attachment listing --------------------------------------------------

function truncateText(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text).subarray(0, maxBytes).toString(), truncated: true };
}

// Read a PDF's text layer into a listing entry. Failures become a note rather
// than an error, so one broken attachment never takes down read_email.
async function withPdfText(entry, attachment, { maxTextBytes, maxPdfBytes }) {
  if (entry.size > maxPdfBytes) {
    return { ...entry, content: null, note: `text not extracted: ${entry.size} bytes exceeds the ${maxPdfBytes} byte limit` };
  }
  let extracted;
  try {
    extracted = await extractPdfText(attachment.content);
  } catch (error) {
    return { ...entry, content: null, note: `text not extracted: ${error.message}` };
  }
  const result = { ...entry, pages: extracted.pages, pdfInfo: extracted.info };
  if (!extracted.hasTextLayer) {
    return {
      ...result,
      content: null,
      scanned: true,
      note: "PDF has no text layer (likely a scanned image); read_attachment returns its pages as images instead"
    };
  }
  const { text, truncated } = truncateText(extracted.text, maxTextBytes);
  result.content = text;
  if (truncated) result.truncated = true;
  if (extracted.pagesRead < extracted.pages) {
    result.note = `only the first ${extracted.pagesRead} of ${extracted.pages} pages were read`;
  }
  return result;
}

function baseEntry(attachment, index) {
  return {
    index,
    filename: attachment.filename || null,
    contentType: attachment.contentType || "application/octet-stream",
    size: attachment.size ?? attachment.content?.length ?? 0,
    disposition: attachment.contentDisposition || null,
    cid: attachment.cid || null
  };
}

function textOf(attachment) {
  const decoded = decodeText(attachment);
  return /^text\/html$/i.test(attachment.contentType || "") ? htmlToPlainText(decoded) : decoded;
}

function withCalendar(entry, attachment, text) {
  if (!isCalendarType(entry.contentType)) return entry;
  const calendar = parseCalendar(text);
  if (!calendar) return entry;
  if (!calendar.method) {
    const method = attachment.headers?.get?.("content-type")?.params?.method;
    if (method) calendar.method = method.toUpperCase();
  }
  return { ...entry, calendar };
}

// Describe every attachment of a parsed message for read_email. Text-like
// attachments under the size limit carry their content; calendar parts also
// carry the parsed events, so the date of an invite shows up next to the body.
export async function describeAttachments(parsed, {
  maxInlineBytes = MAX_INLINE_TEXT_BYTES,
  maxPdfBytes = MAX_INLINE_PDF_BYTES
} = {}) {
  return Promise.all((parsed?.attachments || []).map(async (attachment, index) => {
    const entry = baseEntry(attachment, index);
    if (isPdfAttachment(attachment)) {
      // `scanned` steers attachmentContent; the listing says the same thing in
      // its note, so the internal marker does not belong in the output.
      const { scanned, ...described } = await withPdfText(entry, attachment, { maxTextBytes: maxInlineBytes, maxPdfBytes });
      return described;
    }
    if (!isInlineTextType(entry.contentType)) return entry;
    if (entry.size > maxInlineBytes) {
      return {
        ...entry,
        content: null,
        note: `content omitted: ${entry.size} bytes exceeds the ${maxInlineBytes} byte inline limit; use read_attachment`
      };
    }
    const text = textOf(attachment);
    return withCalendar({ ...entry, content: text }, attachment, text);
  }));
}

// Whether a message carries attachments, judged from its IMAP BODYSTRUCTURE
// so list_emails and search_emails need not download every message. Parts
// of a multipart/related (an HTML body's logos and embedded images) do not
// count, nor do unnamed text/plain and text/html parts, which are the body.
// Anything else does, including a part sent as inline with a filename, which
// is how Apple Mail attaches a PDF.
export function hasAttachments(node, parentType = null) {
  if (!node) return false;
  if (node.childNodes?.length) {
    return node.childNodes.some((child) => hasAttachments(child, node.type));
  }
  if (node.disposition === "attachment") return true;
  if (parentType === "multipart/related") return false;
  const named = node.dispositionParameters?.filename || node.parameters?.name;
  if (!named && /^text\/(plain|html)$/i.test(node.type || "")) return false;
  return !/^multipart\//i.test(node.type || "");
}

// Locate one attachment by index or filename. Index wins when both are
// given. Throws with the available choices so the caller can correct itself.
export function findAttachment(parsed, { index, filename } = {}) {
  const attachments = parsed?.attachments || [];
  if (typeof index === "number") {
    if (Number.isInteger(index) && index >= 0 && index < attachments.length) {
      return attachments[index];
    }
  } else if (typeof filename === "string" && filename.length > 0) {
    const wanted = filename.toLowerCase();
    const match = attachments.find((a) => (a.filename || "").toLowerCase() === wanted);
    if (match) return match;
  } else {
    throw new Error("Specify either index or filename of the attachment to read");
  }
  const available = attachments.length === 0
    ? "the message has no attachments"
    : "available: " + attachments.map((a, i) => `${i}: ${a.filename || "(unnamed)"} (${a.contentType})`).join(", ");
  throw new Error(`No attachment matches ${typeof index === "number" ? `index ${index}` : `filename "${filename}"`}; ${available}`);
}

// Build the MCP content blocks for read_attachment.
// Turn a scanned PDF into page images. Rendering failures become a note, the
// way text-extraction failures do, so one unreadable attachment never takes
// down the call that asked for it.
async function renderedPdf(entry, attachment, { renderPages, renderWidth }) {
  const json = (obj) => ({ type: "text", text: JSON.stringify(obj, null, 2) });
  let rendered;
  try {
    rendered = await renderPdfPages(attachment.content, { pages: renderPages, width: renderWidth });
  } catch (error) {
    return [json({ ...entry, note: `pages not rendered: ${error.message}` })];
  }
  if (rendered.images.length === 0) {
    return [json({ ...entry, note: "no pages matched the requested range" })];
  }
  const shown = rendered.images.map((image) => image.page);
  const missing = rendered.pageCount - shown.length;
  const asked = renderPages !== undefined && renderPages !== null && renderPages !== "";
  const result = {
    ...entry,
    renderedPages: shown,
    note: `scanned PDF: page(s) ${shown.join(", ")} of ${rendered.pageCount} rendered as images`
  };
  if (missing > 0) {
    // Say how to get the rest rather than deciding for the caller: one more
    // page of a document that matters is worth the tokens, a dozen pages of
    // one that does not is not. Only explain the default to a caller that did
    // not already choose.
    result.note += asked
      ? `. The other ${missing} were not rendered; pass pages to include them, up to ${MAX_RENDER_PAGES} per call`
      : `. The default is the first ${DEFAULT_RENDER_PAGES}; pass pages (for example "3-5", or "all" for every page, up to ${MAX_RENDER_PAGES}) for the rest`;
  }
  return [
    json(result),
    ...rendered.images.map((image) => ({ type: "image", data: image.base64, mimeType: image.mimeType }))
  ];
}

export async function attachmentContent(attachment, index, {
  maxTextBytes = MAX_ATTACHMENT_TEXT_BYTES,
  maxImageBytes = MAX_ATTACHMENT_IMAGE_BYTES,
  maxBinaryBytes = MAX_ATTACHMENT_BINARY_BYTES,
  maxPdfBytes = MAX_INLINE_PDF_BYTES,
  renderPages,
  renderWidth
} = {}) {
  const entry = baseEntry(attachment, index);
  const json = (obj) => ({ type: "text", text: JSON.stringify(obj, null, 2) });

  if (isPdfAttachment(attachment)) {
    // The PDF's own bytes are never returned: base64 of a PDF is unreadable
    // for a model and the text layer is what it needs.
    const described = await withPdfText(entry, attachment, { maxTextBytes, maxPdfBytes });
    const { scanned, ...pdfEntry } = described;
    if (!scanned) return [json(pdfEntry)];
    // No text layer, so the page images are the only way to read it.
    return await renderedPdf(pdfEntry, attachment, { renderPages, renderWidth });
  }

  if (isInlineTextType(entry.contentType)) {
    const { text, truncated } = truncateText(textOf(attachment), maxTextBytes);
    const result = withCalendar({ ...entry, content: text }, attachment, text);
    if (truncated) result.truncated = true;
    return [json(result)];
  }

  if (/^image\//i.test(entry.contentType)) {
    if (entry.size > maxImageBytes) {
      return [json({ ...entry, note: `image not returned: ${entry.size} bytes exceeds the ${maxImageBytes} byte limit` })];
    }
    return [
      json(entry),
      { type: "image", data: attachment.content.toString("base64"), mimeType: entry.contentType }
    ];
  }

  if (entry.size > maxBinaryBytes) {
    return [json({ ...entry, note: `content not returned: ${entry.size} bytes exceeds the ${maxBinaryBytes} byte limit` })];
  }
  return [json({ ...entry, contentBase64: attachment.content.toString("base64") })];
}
