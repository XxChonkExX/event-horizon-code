// Event Horizon Code - minimal ZIP reader (stored + deflate), no dependency.
//
// Used only for an archive the user asked for by name from the pinned Sensory
// catalog, AFTER the whole archive's SHA-256 has been verified. Entries come
// back in memory with their base name; the caller keeps what it allowlists.
// Anything shaped like a path traversal is refused, not sanitised.

import zlib from "node:zlib";

export type ZipEntry = { name: string; size: number; data: Buffer };

export function readZip(buf: Buffer, opts: { maxEntries?: number; maxBytes?: number } = {}): ZipEntry[] {
  const maxEntries = opts.maxEntries ?? 500;
  const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;

  // End Of Central Directory: a 22-byte record that may be followed by a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error("zip: zip64 archives are not supported");
  if (count > maxEntries) throw new Error(`zip: too many entries (${count})`);
  if (cdOff + cdSize > eocd) throw new Error("zip: central directory out of bounds");

  const out: ZipEntry[] = [];
  let p = cdOff;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue; // directory entry
    const base = name.slice(name.lastIndexOf("/") + 1);
    // Flat extraction only: a name with any path left in it is refused.
    if (!base || name.includes("\\") || name.includes("..") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
      throw new Error(`zip: unsafe entry name "${name.slice(0, 80)}"`);
    }
    if (lho + 30 > cdOff || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error("zip: bad local header");
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (dataStart + csize > cdOff) throw new Error("zip: entry data out of bounds");
    total += usize;
    if (total > maxBytes) throw new Error("zip: archive expands beyond the size cap");
    const packed = buf.subarray(dataStart, dataStart + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(packed);
    else if (method === 8) data = zlib.inflateRawSync(packed, { maxOutputLength: maxBytes });
    else throw new Error(`zip: unsupported compression method ${method}`);
    if (data.length !== usize) throw new Error(`zip: size mismatch for "${base}"`);
    out.push({ name: base, size: usize, data });
  }
  return out;
}
