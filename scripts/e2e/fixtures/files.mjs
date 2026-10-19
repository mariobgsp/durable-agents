import { deflateSync } from "node:zlib";

/**
 * Deterministic binary fixtures, built in process so nothing large is committed.
 *
 * The PNG encoder exists so the normalization assertion can be real: the test needs an image *bigger* than
 * the model's limits, and it needs to know the exact size it asked for.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A truecolour PNG of the requested size, with a gradient so it does not compress into nothing. */
export function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = (x + y) % 256;
      offset += 3;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Pixel size of a PNG, read from its IHDR: the assertion for "it was resized to the model's limits". */
export function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * A one-page PDF with one line of text.
 *
 * Hand-built so the fixture is a few hundred bytes and has no dependency. `pdftotext - -` reads it, which
 * is what the server's document path runs.
 */
export function pdf(text = "Hello PDF") {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/**
 * A text file of exactly `chars` characters, ending in a marker so truncation is visible in what remains.
 *
 * The total matters: the truncation marker quotes the character count, so a fixture that overshoots its own
 * budget makes the assertion wrong rather than the code.
 */
export function longText(chars, marker = "END-MARKER") {
  const line = "0123456789 abcdefghijklmnopqrstuvwxyz\n";
  const bodyLength = chars - marker.length - 1;
  let body = "";
  while (body.length < bodyLength) body += line;
  return Buffer.from(body.slice(0, bodyLength) + "\n" + marker, "utf8");
}

/** Base64, as the endpoint takes it. */
export function asAttachment(name, mimeType, bytes) {
  return { name, mimeType, data: bytes.toString("base64") };
}
