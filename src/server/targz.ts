// Event Horizon Code - minimal tar.gz reader (ustar/gnu), no dependencies.
//
// Used only for an archive the user asked for by name from the pinned Sensory
// catalog, AFTER the whole archive's SHA-256 has been verified. Entries come
// back with their base name, unix mode and link target; the caller keeps what
// it allowlists (and re-creates symlinks, which the whisper.cpp Linux build
// needs: libwhisper.so -> libwhisper.so.1 -> libwhisper.so.1.9.6). Anything
// shaped like a path traversal is refused, not sanitised.

import zlib from "node:zlib";

export type TarEntry = { name: string; size: number; mode: number; type: "file" | "symlink" | "dir"; link?: string; data?: Buffer };

export function readTarGz(buf: Buffer, opts: { maxEntries?: number; maxBytes?: number } = {}): TarEntry[] {
  const maxEntries = opts.maxEntries ?? 500;
  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024;
  const tar = zlib.gunzipSync(buf, { maxOutputLength: maxBytes + 64 * 1024 * 1024 });

  const octal = (s: Buffer): number => {
    const t = s.toString("utf8").replace(/\0.*$/, "").trim();
    return t ? parseInt(t, 8) : 0;
  };
  const nul = (s: Buffer): string => s.toString("utf8").replace(/\0.*$/, "");

  const out: TarEntry[] = [];
  let off = 0;
  let total = 0;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end of archive
    const stored = octal(header.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== stored) throw new Error("tar: bad header checksum");
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    let name = nul(header.subarray(0, 100));
    const prefix = nul(header.subarray(345, 500));
    if (prefix) name = `${prefix}/${name}`;
    off += 512;
    const dataBlocks = Math.ceil(size / 512);
    if (off + size > tar.length) throw new Error("tar: entry data out of bounds");
    const data = tar.subarray(off, off + size);
    off += dataBlocks * 512;

    if (type === "L") { longName = nul(data); continue; }          // GNU long name for the next entry
    if (type === "x" || type === "g") continue;                    // pax headers: no fields we need
    if (longName !== null) { name = longName; longName = null; }

    if (type === "5") continue;                                    // directory entry
    const mode = octal(header.subarray(100, 108)) & 0o7777;
    if (type === "2") {                                            // symlink: keep the target, no data
      const link = nul(header.subarray(157, 257));
      const base = name.slice(name.lastIndexOf("/") + 1);
      if (!base || name.includes("\\") || name.includes("..") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
        throw new Error(`tar: unsafe entry name "${name.slice(0, 80)}"`);
      }
      out.push({ name: base, size: 0, mode, type: "symlink", link });
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") continue;   // regular file (7 = contiguous)
    const base = name.slice(name.lastIndexOf("/") + 1);
    if (!base || name.includes("\\") || name.includes("..") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
      throw new Error(`tar: unsafe entry name "${name.slice(0, 80)}"`);
    }
    total += size;
    if (total > maxBytes) throw new Error("tar: archive expands beyond the size cap");
    out.push({ name: base, size, mode, type: "file", data: Buffer.from(data) });
  }
  if (out.length > maxEntries) throw new Error(`tar: too many entries (${out.length})`);
  return out;
}
