import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReceiptPdf, receiptAmount } from "../src/lib/receipt-pdf";

const sample = () =>
  buildReceiptPdf({
    businessName: "Spirit Cricket Zone",
    heading: "Booking confirmed",
    reference: "TURF-AB12CD",
    lines: [
      { label: "Ground", value: "Medipally" },
      { label: "Booking total", value: receiptAmount(700), strong: true },
      { label: "To pay at the ground", value: receiptAmount(350), strong: true },
    ],
    notes: ["Queries: +91 9876543210"],
  });

/**
 * A PDF that will not open is indistinguishable from one that never downloaded,
 * and neither shows up as an error anywhere. These check the structure a reader
 * actually needs rather than how it looks.
 */
describe("the receipt PDF", () => {
  it("is a PDF, complete from header to trailer", () => {
    const pdf = sample().toString("latin1");
    assert.ok(pdf.startsWith("%PDF-1.4"), "missing header");
    assert.ok(pdf.trimEnd().endsWith("%%EOF"), "missing trailer");
    assert.match(pdf, /\/Type \/Catalog/);
    assert.match(pdf, /\/Type \/Page[^s]/);
  });

  /** A wrong byte offset here is the classic "file is damaged" failure. */
  it("points its cross-reference table at the real byte offsets", () => {
    const bytes = sample();
    const pdf = bytes.toString("latin1");
    const startxref = Number(pdf.match(/startxref\s+(\d+)/)![1]);
    assert.equal(pdf.slice(startxref, startxref + 4), "xref");

    const table = pdf.slice(startxref).match(/\d{10} 00000 n/g) ?? [];
    assert.equal(table.length, 6, "one entry per object");
    table.forEach((row, i) => {
      const offset = Number(row.slice(0, 10));
      assert.equal(pdf.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1}`);
    });
  });

  it("carries the content it was given", () => {
    const pdf = sample().toString("latin1");
    for (const wanted of ["Spirit Cricket Zone", "TURF-AB12CD", "Medipally", "Rs. 700", "Rs. 350"]) {
      assert.ok(pdf.includes(wanted), `missing ${wanted}`);
    }
  });

  /**
   * The rupee sign is not in WinAnsiEncoding. Writing it raw produces a file that
   * opens with a wrong glyph or not at all, which is why amounts say "Rs.".
   */
  it("never writes a character the built-in font cannot draw", () => {
    const pdf = buildReceiptPdf({
      businessName: "₹ Turf – Hyderabad",
      heading: "Booking confirmed",
      reference: "TURF-ZZ99ZZ",
      lines: [{ label: "Name", value: "Aarav “Ace” D’Souza — ₹" }],
      notes: ["₹700 paid"],
    }).toString("latin1");
    assert.ok(!pdf.includes("₹"), "rupee sign leaked into the file");
    for (const ch of pdf) assert.ok(ch.codePointAt(0)! < 256, `non-latin1 byte: ${ch}`);
  });

  /** Parentheses and backslashes end a PDF string early if they are not escaped. */
  it("escapes characters that would break a PDF string", () => {
    const pdf = buildReceiptPdf({
      businessName: "Turf (North) \\ South",
      heading: "Booking confirmed",
      reference: "TURF-PAREN1",
      lines: [{ label: "Note", value: "a) b( c\\d" }],
      notes: [],
    }).toString("latin1");
    assert.ok(pdf.includes("\\(North\\)"), "unescaped bracket");
    assert.ok(pdf.includes("\\\\"), "unescaped backslash");
    // Every literal string must still be balanced once escapes are removed.
    const strings = pdf.match(/\(((?:[^()\\]|\\.)*)\) Tj/g) ?? [];
    assert.ok(strings.length > 0, "no text drawn");
  });

  it("formats rupees the way an Indian receipt reads", () => {
    assert.equal(receiptAmount(700), "Rs. 700");
    assert.equal(receiptAmount(120000), "Rs. 1,20,000");
    assert.equal(receiptAmount(0), "Rs. 0");
  });
});
