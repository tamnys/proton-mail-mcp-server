// Builds small, uncompressed, single-font PDFs by hand so the tests need no
// external converter. Each page is a list of lines; a line may be a string
// or an array of [x, text] cells to place words on one baseline, the way a
// table row in a real invoice is laid out.
export function makePdf(pages, { title } = {}) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const escape = (s) => s.replace(/[()\\]/g, "\\$&");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = add("PAGES");
  const pageIds = [];
  for (const lines of pages) {
    const ops = [];
    let y = 780;
    for (const line of lines) {
      const cells = Array.isArray(line) ? line : [[50, line]];
      for (const [x, text] of cells) {
        ops.push(`BT /F1 12 Tf ${x} ${y} Td (${escape(text)}) Tj ET`);
      }
      y -= 16;
    }
    const content = ops.join("\n");
    const c = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${c} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> >>`
    ));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const info = title ? add(`<< /Title (${escape(title)}) /Producer (fixture) >>`) : null;

  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ""} >>\n`;
  out += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
