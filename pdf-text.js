// Text extraction from PDF attachments via pdf.js. Only the text layer is
// read: strings a PDF draws with their positions, rebuilt into lines. A
// scanned PDF has no text layer and yields nothing here; pdf-render.js turns
// its pages into images instead.

// pdf.js is 16 MB of module; load it on first use, not at server start. It
// can warn on import, via console.warn, about its optional canvas package;
// those warnings are muted for the duration of the import. This server writes
// nothing else to console.warn, so nothing real is lost in that window.
// Shared with pdf-render.js so both read and render the same pdf.js instance.
let pdfjsPromise = null;
export function loadPdfjs() {
  pdfjsPromise ||= (async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      return await import("pdfjs-dist/legacy/build/pdf.mjs");
    } finally {
      console.warn = originalWarn;
    }
  })();
  return pdfjsPromise;
}

export const DEFAULT_MAX_PDF_PAGES = 50;

// Rebuild lines from positioned text items. pdf.js marks line ends on the
// items it can, and a change in the baseline catches the rest. Words that
// sit on one baseline with a gap between them, as table cells do, are joined
// with a space so a row of an invoice stays a single line.
export function itemsToText(items) {
  let out = "";
  let prev = null;
  for (const item of items) {
    const str = item.str || "";
    const [, , , , x, y] = item.transform || [0, 0, 0, 0, 0, 0];
    if (prev) {
      const lineHeight = Math.max(prev.height || 0, item.height || 0, 1);
      const newLine = prev.hasEOL || Math.abs(y - prev.y) > lineHeight / 2;
      if (newLine) {
        // Some producers emit an empty end-of-line item at the start of each
        // line, which would otherwise double every line break.
        out = out.replace(/[ \t]+$/, "");
        if (out !== "" && !out.endsWith("\n")) out += "\n";
      } else if (str.trim() !== "" && x - prev.end > 0.5 && !out.endsWith(" ")) {
        out += " ";
      }
    }
    out += str;
    if (str.trim() !== "" || item.hasEOL) {
      prev = { y, end: x + (item.width || 0), height: item.height, hasEOL: item.hasEOL };
    } else if (prev) {
      // A spacer item: keep the previous baseline but extend the reach.
      prev = { ...prev, end: Math.max(prev.end, x + (item.width || 0)), hasEOL: item.hasEOL };
    }
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanInfo(info) {
  if (!info) return {};
  const pick = {};
  for (const key of ["Title", "Author", "Subject", "Producer", "Creator", "CreationDate", "ModDate"]) {
    if (typeof info[key] === "string" && info[key].trim() !== "") {
      pick[key.charAt(0).toLowerCase() + key.slice(1)] = info[key].trim();
    }
  }
  return pick;
}

// Extract the text of a PDF held in a Buffer.
// Returns { pages, pagesRead, text, hasTextLayer, info }. Throws on a file
// that is not a PDF, or is encrypted with a password.
export async function extractPdfText(buffer, { maxPages = DEFAULT_MAX_PDF_PAGES } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false
  });
  try {
    const doc = await task.promise;
    const pages = doc.numPages;
    const pagesRead = Math.min(pages, maxPages);
    const chunks = [];
    for (let i = 1; i <= pagesRead; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = itemsToText(content.items);
      page.cleanup();
      if (text !== "") chunks.push(pages > 1 ? `--- page ${i} ---\n${text}` : text);
    }
    let info = {};
    try {
      info = cleanInfo((await doc.getMetadata()).info);
    } catch {
    }
    const text = chunks.join("\n\n");
    return { pages, pagesRead, text, hasTextLayer: text !== "", info };
  } catch (error) {
    const name = error?.name || "";
    if (name === "PasswordException") {
      throw new Error("PDF is password protected");
    }
    if (name === "InvalidPDFException") {
      throw new Error("not a valid PDF file");
    }
    throw new Error(`PDF could not be read: ${error?.message || error}`);
  } finally {
    await task.destroy().catch(() => {});
  }
}
