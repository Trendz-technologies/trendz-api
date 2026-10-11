import PDFDocument from "pdfkit";

/** DejaVu Sans covers the ₹ sign, which the built-in PDF Helvetica lacks. */
const FONT_REGULAR = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const FONT_BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
const FONT_CONDENSED = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSansCondensed.ttf");
const FONT_CONDENSED_BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSansCondensed-Bold.ttf");

export const MM = 72 / 25.4; // points per millimetre

export function createPdf(options: PDFKit.PDFDocumentOptions = {}): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true, ...options });
  doc.registerFont("regular", FONT_REGULAR);
  doc.registerFont("bold", FONT_BOLD);
  doc.registerFont("condensed", FONT_CONDENSED);
  doc.registerFont("condensed-bold", FONT_CONDENSED_BOLD);
  doc.font("regular");
  return doc;
}

/** Renders a document to a Buffer. `draw` must not call doc.end(). */
export function renderPdf(doc: PDFKit.PDFDocument, draw: (doc: PDFKit.PDFDocument) => void | Promise<void>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    Promise.resolve(draw(doc))
      .then(() => doc.end())
      .catch(reject);
  });
}

/** ₹1,23,456.00 (Indian digit grouping). */
export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
