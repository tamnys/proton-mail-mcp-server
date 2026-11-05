// Rendering PDF pages to images, for scanned documents that carry no text
// layer. pdf-text.js handles the other case and returns nothing for these.
//
// Reading a scan as an image rather than through OCR is a deliberate choice.
// OCR on a real letter does recover the characters, but it loses the
// arrangement: in one test the footer came back as the right digits attached
// to the wrong labels, with "KvK nummer" and "btw-nummer" separated from their
// values. That kind of error is invisible in the output -- it reads as
// plausible text -- and on an invoice it is the dangerous kind. A rendered
// page keeps the layout, so tables, stamps, signatures and handwriting stay
// readable as what they are.
import { createCanvas } from "@napi-rs/canvas";
import { loadPdfjs } from "./pdf-text.js";

// Wide enough that body text in a scanned A4 stays legible, small enough that
// a page costs roughly what a page of OCR text would.
export const DEFAULT_RENDER_WIDTH = 1200;
export const DEFAULT_RENDER_QUALITY = 80;
// How many pages are rendered when the caller does not say. Most scanned mail
// is one or two pages; beyond that the caller asks for what it wants.
export const DEFAULT_RENDER_PAGES = 2;
// A ceiling on one call regardless of what was asked, so a 200-page scan
// cannot be turned into 200 images by a single request.
export const MAX_RENDER_PAGES = 20;

// Work out which pages to render. `spec` is "all", a single number, a range
// like "2-5", or a comma-separated mix; undefined means the default run from
// page 1. Out-of-range and duplicate entries are dropped rather than refused,
// so a caller guessing at the page count still gets what exists.
export function parsePageSpec(spec, pageCount, {
  defaultPages = DEFAULT_RENDER_PAGES,
  maxPages = MAX_RENDER_PAGES
} = {}) {
  const total = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 0;
  if (total === 0) return [];
  const take = (list) => [...new Set(list)].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b).slice(0, maxPages);

  if (spec === undefined || spec === null || spec === "") {
    return take(Array.from({ length: Math.min(defaultPages, total) }, (_, i) => i + 1));
  }
  const text = String(spec).trim().toLowerCase();
  if (text === "all") {
    return take(Array.from({ length: total }, (_, i) => i + 1));
  }
  const wanted = [];
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      for (let n = Math.min(from, to); n <= Math.max(from, to); n++) wanted.push(n);
      continue;
    }
    if (/^\d+$/.test(piece)) {
      wanted.push(Number(piece));
      continue;
    }
    throw new Error(`Cannot read "${part.trim()}" as a page number, a range like 2-5, or "all"`);
  }
  return take(wanted);
}

// Render the given pages of `buffer` as JPEGs. Returns the images plus the
// document's page count, so a caller can report what it did not render.
export async function renderPdfPages(buffer, {
  pages,
  width = DEFAULT_RENDER_WIDTH,
  quality = DEFAULT_RENDER_QUALITY,
  defaultPages = DEFAULT_RENDER_PAGES,
  maxPages = MAX_RENDER_PAGES
} = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false
  });
  const doc = await task.promise;
  try {
    const wanted = parsePageSpec(pages, doc.numPages, { defaultPages, maxPages });
    const images = [];
    for (const number of wanted) {
      const page = await doc.getPage(number);
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / unscaled.width });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      // Pages are transparent where nothing is drawn; without this a scan of
      // black text on white paper renders as black text on black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      images.push({
        page: number,
        mimeType: "image/jpeg",
        base64: canvas.toBuffer("image/jpeg", quality).toString("base64"),
        width: canvas.width,
        height: canvas.height
      });
    }
    return { images, pageCount: doc.numPages };
  } finally {
    await task.destroy();
  }
}
