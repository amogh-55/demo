import "server-only";

/**
 * A booking receipt as an actual PDF file.
 *
 * Built by hand rather than with a library. A receipt is a page of left-aligned
 * text and a couple of rules; every PDF library that could draw it weighs more
 * than this file and would be the only reason to have one.
 *
 * The catch, and the reason the first version used the browser's print dialog
 * instead: the rupee sign is not in WinAnsiEncoding, so a PDF using the built-in
 * Helvetica cannot draw "₹" without embedding a font. Rather than ship a font to
 * render one glyph, amounts are written "Rs. 700", which is what a printed receipt
 * in India says anyway.
 */

export interface ReceiptLine {
  label: string;
  value: string;
  /** Drawn heavier — the total, the reference, the amount still to pay. */
  strong?: boolean;
}

export interface ReceiptInput {
  businessName: string;
  heading: string;
  reference: string;
  lines: ReceiptLine[];
  /** Small print under the rule. One sentence per entry. */
  notes: string[];
}

/** Rupees, without the glyph a built-in PDF font cannot draw. */
export function receiptAmount(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-IN")}`;
}

/**
 * Escape for a PDF literal string, and drop anything WinAnsi cannot represent.
 *
 * A customer's name is theirs to choose — an en dash pasted from a phone keyboard
 * must not produce a corrupt file — so unrepresentable characters are replaced
 * rather than written raw.
 */
function pdfText(value: string): string {
  return [...value]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      if (ch === "\\") return "\\\\";
      if (ch === "(") return "\\(";
      if (ch === ")") return "\\)";
      if (code === 0x20b9) return "Rs.";
      if (code === 0x2013 || code === 0x2014) return "-";
      if (code === 0x2018 || code === 0x2019) return "'";
      if (code === 0x201c || code === 0x201d) return '"';
      if (code < 32) return " ";
      return code < 256 ? ch : "?";
    })
    .join("");
}

const PAGE_WIDTH = 595; // A4 at 72dpi
const PAGE_HEIGHT = 842;
const MARGIN = 56;

export function buildReceiptPdf(input: ReceiptInput): Buffer {
  const ops: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  const text = (value: string, size: number, bold: boolean, x = MARGIN) => {
    ops.push(
      `BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfText(value)}) Tj ET`,
    );
  };
  /** Right-aligned, using Helvetica's average width — close enough for a column of figures. */
  const textRight = (value: string, size: number, bold: boolean) => {
    const width = pdfText(value).length * size * 0.5;
    text(value, size, bold, PAGE_WIDTH - MARGIN - width);
  };
  const rule = () => {
    ops.push(`0.8 w 0.75 0.75 0.75 RG ${MARGIN} ${y} m ${PAGE_WIDTH - MARGIN} ${y} l S 0 0 0 RG`);
  };

  text(input.businessName, 18, true);
  y -= 22;
  text(input.heading, 11, false);
  y -= 30;

  text("Booking reference", 9, false);
  y -= 20;
  text(input.reference, 20, true);
  y -= 26;
  rule();
  y -= 24;

  for (const line of input.lines) {
    text(line.label, 10, false);
    textRight(line.value, line.strong ? 12 : 10, Boolean(line.strong));
    y -= line.strong ? 24 : 20;
  }

  y -= 6;
  rule();
  y -= 20;
  for (const note of input.notes) {
    text(note, 8, false);
    y -= 13;
  }

  const stream = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];

  // The cross-reference table needs each object's byte offset, so the file is
  // assembled as it is measured rather than concatenated at the end.
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}
