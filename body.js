import { convert } from "html-to-text";

// Characters that occupy no visual space but survive String.prototype.trim().
// Marketing mail routinely pads the text/plain part with these (combining
// grapheme joiners, soft hyphens, zero-width spaces) so that preview panes
// show a blank preheader. Such a part carries no content and must be treated
// as absent, otherwise the HTML fallback below never triggers.
const INVISIBLE_CHARS = new RegExp(
  "[" +
  "\\u00AD" +         // soft hyphen
  "\\u034F" +         // combining grapheme joiner
  "\\u061C" +         // arabic letter mark
  "\\u115F\\u1160" +  // hangul choseong/jungseong filler
  "\\u17B4\\u17B5" +  // khmer inherent vowels
  "\\u180B-\\u180E" + // mongolian variation selectors and vowel separator
  "\\u200B-\\u200F" + // zero width space .. right-to-left mark
  "\\u202A-\\u202E" + // bidi embedding and override controls
  "\\u2060-\\u2064" + // word joiner .. invisible plus
  "\\u206A-\\u206F" + // deprecated formatting controls
  "\\u3164" +         // hangul filler
  "\\uFEFF" +         // zero width no-break space / BOM
  "\\uFFA0" +         // halfwidth hangul filler
  "]",
  "gu"
);

// Some senders embed images directly in the HTML source as base64 payloads,
// which bloats the reported body without adding anything readable. (Inline
// images referenced with cid: are a separate matter: those are kept as cid:
// links by passing keepCidLinks to simpleParser, so they never become base64
// in the first place.) Payloads below this size are left alone -- they are
// typically small icons, and rewriting them costs more than it saves.
export const MIN_STRIPPED_DATA_URI_CHARS = 1024;

const BASE64_DATA_URI = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[a-z0-9-]+=[^;,]*)*);base64,([A-Za-z0-9+/=\s]+)/gi;

export const NO_BODY_NOTICE = "[no readable body: this message has neither a text/plain nor a text/html part]";
export const UNREADABLE_HTML_NOTICE = "[no readable body: the HTML part contained no extractable text (likely images only)]";

// True when `value` holds nothing a human could read.
export function isBlank(value) {
  if (typeof value !== "string" || value.length === 0) return true;
  return value.replace(INVISIBLE_CHARS, "").trim() === "";
}

// Replace oversized base64 payloads with a marker naming what was dropped.
// The surrounding markup is left untouched, so the HTML stays readable.
export function stripDataUris(html, { minChars = MIN_STRIPPED_DATA_URI_CHARS } = {}) {
  if (typeof html !== "string" || html.length === 0) return html;
  return html.replace(BASE64_DATA_URI, (match, mediaType, _params, payload) => {
    if (payload.length < minChars) return match;
    const bytes = Math.floor(payload.replace(/\s/g, "").length * 3 / 4);
    return `[inline data removed: ${mediaType || "unknown type"}, ${bytes} bytes]`;
  });
}

// Senders routinely set alt to the image's own filename, which is the thing
// this formatter exists to keep out of the text.
const FILENAME_ALT = /^[\w .@%+-]*\.(?:png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;

// How to render an <img> as text.
//
// html-to-text's own image formatter prints the source URL whenever an image
// has no usable alt text, which fills marketing mail with filenames and
// tracking pixels. Skipping images outright loses the alt text that does carry
// content -- measured over one mailbox, 20 of 21 messages with a substantive
// alt text lost it that way -- and removes whatever separated the text on
// either side, gluing neighbouring words into one: two addresses in a footer
// came out as "marketing@example.nlnieuwsbrief@example.com".
//
// So: emit the alt text when it says something, and nothing when it does not.
// Either way the text is padded with spaces, because html-to-text drops an
// inline run that is only whitespace -- without the padding the words on
// either side of the image still run together. The spaces collapse when
// adjacent and disappear in the final trim.
function imageAltOnly(elem, _walk, builder) {
  const raw = typeof elem?.attribs?.alt === "string" ? elem.attribs.alt.trim() : "";
  const alt = raw.length > 0 && !FILENAME_ALT.test(raw) ? raw : "";
  builder.addInline(` ${alt} `, { noWordTransform: true });
}

export function htmlToPlainText(html) {
  if (typeof html !== "string" || html.length === 0) return "";
  return convert(html, {
    wordwrap: false,
    formatters: { imageAltOnly },
    selectors: [
      { selector: "img", format: "imageAltOnly" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } }
    ]
  }).trim();
}

// True when the message actually carries a text/plain body part.
//
// `parsed.text` alone cannot answer this: mailparser fills it from the HTML
// itself when the HTML part is the whole message, so a non-blank `text` does
// not prove a text/plain part was ever there. The root Content-Type does. A
// text/html root is the entire message and has no siblings, so any text that
// came out of it was derived from that HTML. Every other root -- text/plain,
// any multipart, or no Content-Type at all (which defaults to text/plain) --
// only yields `text` when a real text/plain part supplied it.
function hasPlainTextPart(parsed) {
  const header = parsed?.headers?.get?.("content-type");
  const rootType = typeof header?.value === "string" ? header.value.toLowerCase().trim() : "";
  return rootType !== "text/html";
}

// Pick the body to report for a message parsed by mailparser's simpleParser.
//
// mailparser derives `text` from the HTML itself, but only when the HTML part
// is the message root or has a text/plain sibling. Inside a multipart/related
// or multipart/mixed wrapper -- i.e. as soon as the message carries inline
// images or attachments -- it leaves `text` undefined and fills only `html`.
//
// Returns { text, html, bodySource } where bodySource is "plain", "html" or
// "none", naming the part the text came from, so a caller can tell a genuinely
// empty message from a parse failure. The reported HTML is always the full
// document, with only oversized base64 payloads replaced by a marker.
//
// Every text derived from HTML goes through htmlToPlainText, including the one
// mailparser already produced for a text/html root. mailparser's own
// conversion keeps the source URL of every image and hard-wraps at about 80
// columns; this one keeps alt text, drops tracking pixels and filenames, and
// leaves the lines intact. Using it everywhere also means one message's body
// reads the same whether or not the sender happened to attach a logo.
export function selectBody(parsed, options = {}) {
  const plain = typeof parsed?.text === "string" ? parsed.text : "";
  const rawHtml = typeof parsed?.html === "string" && parsed.html.length > 0 ? parsed.html : null;
  const html = rawHtml === null ? null : stripDataUris(rawHtml, options);

  // A genuine text/plain part is what the sender wrote, so it wins outright.
  if (hasPlainTextPart(parsed) && !isBlank(plain)) {
    return { text: plain, html, bodySource: "plain" };
  }
  if (rawHtml !== null) {
    const converted = htmlToPlainText(rawHtml);
    if (!isBlank(converted)) {
      return { text: converted, html, bodySource: "html" };
    }
    // Our conversion found nothing readable. If mailparser still got something
    // out of the same HTML, report that rather than claiming an empty body.
    if (!isBlank(plain)) {
      return { text: plain, html, bodySource: "html" };
    }
    return { text: UNREADABLE_HTML_NOTICE, html, bodySource: "none" };
  }
  // No HTML to fall back on; anything left is whatever the plain part held.
  if (!isBlank(plain)) {
    return { text: plain, html: null, bodySource: "plain" };
  }
  return { text: NO_BODY_NOTICE, html: null, bodySource: "none" };
}
