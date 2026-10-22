// Finds where a media file records where it was shot, so uploads can blank it
// out. Phones write GPS into QuickTime/MP4 metadata (the `©xyz` atom and the
// `com.apple.quicktime.location.*` keys) and into JPEG EXIF. Every patch has
// the same length as the bytes it replaces, so nothing else in the file moves.

export interface Patch {
  offset: number;
  bytes: Uint8Array;
}

/** Reads `length` bytes at `offset` (fewer at the end of the file). */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** Location text with every digit turned to 0, so it still parses but says nothing. */
function zeroDigits(b: Uint8Array): Uint8Array {
  return b.map((c) => (c >= 0x30 && c <= 0x39 ? 0x30 : c));
}

interface Box {
  type: string;
  start: number; // offset of the header, within the buffer
  body: number; // offset of the payload
  end: number;
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) break;
    out.push({ type: ascii(b, at + 4, 4), start: at, body, end: at + size });
    at += size;
  }
  return out;
}

/** Location patches inside a `moov` box held in `b` (which starts at file offset `base`). */
export function movieLocationPatches(b: Uint8Array, base: number): Patch[] {
  const patches: Patch[] = [];
  const add = (from: number, to: number, value: (s: Uint8Array) => Uint8Array) => {
    if (to > from) patches.push({ offset: base + from, bytes: value(b.subarray(from, to)) });
  };

  const walk = (from: number, to: number) => {
    for (const box of boxes(b, from, to)) {
      if (box.type === 'moov' || box.type === 'trak' || box.type === 'udta') walk(box.body, box.end);
      else if (box.type === '©xyz') add(box.body + 4, box.end, zeroDigits); // 16-bit length, 16-bit language, then text
      else if (box.type === 'meta') meta(box);
    }
  };

  // QuickTime metadata: `keys` names each item, `ilst` holds them by 1-based index.
  const meta = (box: Box) => {
    // An ISO `meta` box has 4 bytes of version and flags before its children; a QuickTime one does not.
    const start = ascii(b, box.body + 4, 4) === 'hdlr' ? box.body : box.body + 4;
    const children = boxes(b, start, box.end);
    const keys = children.find((c) => c.type === 'keys');
    const names: string[] = [];
    if (keys) {
      const count = u32(b, keys.body + 4);
      let at = keys.body + 8;
      for (let i = 0; i < count && at + 8 <= keys.end; i++) {
        const size = u32(b, at);
        if (size < 8) break;
        names.push(ascii(b, at + 8, size - 8));
        at += size;
      }
    }
    for (const ilst of children.filter((c) => c.type === 'ilst')) {
      for (const item of boxes(b, ilst.body, ilst.end)) {
        const name = item.type === '©xyz' ? 'location' : (names[u32(b, item.start + 4) - 1] ?? '');
        if (!/location/i.test(name)) continue;
        for (const data of boxes(b, item.body, item.end).filter((d) => d.type === 'data')) {
          // data: 4 bytes type, 4 bytes locale, then the value. Text keeps its shape; numbers become 0.
          const text = u32(b, data.body) === 1;
          add(data.body + 8, data.end, (s) => (text ? zeroDigits(s) : new Uint8Array(s.length)));
        }
      }
    }
  };

  walk(0, b.length);
  return patches;
}

type Chunk = { offset: number; sizes: number[] };

/** Every track in a `moov` box: its sample entry, and where its samples sit in the file, chunk by chunk. */
function tracks(b: Uint8Array): { entry: Box | undefined; chunks: Chunk[] }[] {
  const child = (box: Box | undefined, type: string) => (box ? boxes(b, box.body, box.end).find((c) => c.type === type) : undefined);
  const moov = boxes(b, 0, b.length).find((x) => x.type === 'moov');
  if (!moov) return [];
  return boxes(b, moov.body, moov.end)
    .filter((x) => x.type === 'trak')
    .map((trak) => {
      const stbl = child(child(child(trak, 'mdia'), 'minf'), 'stbl');
      const stsd = child(stbl, 'stsd');
      // stsd: version/flags and an entry count, then the sample entries.
      const entry = stsd ? boxes(b, stsd.body + 8, stsd.end)[0] : undefined;
      const stsz = child(stbl, 'stsz');
      const stsc = child(stbl, 'stsc');
      const stco = child(stbl, 'stco');
      const co64 = child(stbl, 'co64');
      if (!stsz || !stsc || !(stco || co64)) return { entry, chunks: [] };
      const uniform = u32(b, stsz.body + 4);
      const sampleCount = u32(b, stsz.body + 8);
      const sizeOf = (i: number) => uniform || u32(b, stsz.body + 12 + i * 4);
      const offsets: number[] = [];
      if (co64) for (let i = 0, n = u32(b, co64.body + 4); i < n; i++) offsets.push(u32(b, co64.body + 8 + i * 8) * 2 ** 32 + u32(b, co64.body + 12 + i * 8));
      else for (let i = 0, n = u32(b, stco!.body + 4); i < n; i++) offsets.push(u32(b, stco!.body + 8 + i * 4));
      const runs = Array.from({ length: u32(b, stsc.body + 4) }, (_, i) => ({ first: u32(b, stsc.body + 8 + i * 12), perChunk: u32(b, stsc.body + 12 + i * 12) }));
      let sample = 0;
      const chunks = offsets.map((offset, c) => {
        const run = runs.filter((r) => r.first <= c + 1).at(-1);
        const sizes: number[] = [];
        for (let i = 0; i < (run?.perChunk ?? 0) && sample < sampleCount; i++) sizes.push(sizeOf(sample++));
        return { offset, sizes };
      });
      return { entry, chunks };
    });
}

/**
 * iPhones also write the location as a timed metadata track (`mebx`), whose
 * samples live in `mdat`. Returns those tracks' samples and which local key
 * ids in them hold a location.
 */
export function locationTracks(b: Uint8Array): { keys: Set<number>; chunks: Chunk[] }[] {
  const out: { keys: Set<number>; chunks: Chunk[] }[] = [];
  for (const { entry, chunks } of tracks(b)) {
    if (!entry || entry.type !== 'mebx') continue;
    // A mebx entry has 8 bytes of fields, then a `keys` box of local ids, each with a `keyd` naming it.
    const keys = new Set<number>();
    const table = boxes(b, entry.body + 8, entry.end).find((x) => x.type === 'keys');
    for (const key of table ? boxes(b, table.body, table.end) : []) {
      const keyd = boxes(b, key.body, key.end).find((x) => x.type === 'keyd');
      if (keyd && /location/i.test(ascii(b, keyd.body + 4, keyd.end - keyd.body - 4))) keys.add(u32(b, key.start + 4));
    }
    if (keys.size) out.push({ keys, chunks });
  }
  return out;
}

/**
 * The stretches of `mdat` that no track uses. Cameras leave spare metadata
 * there (an iPhone writes a copy of its `meta` box, location included), which
 * players never read but anyone downloading the file can.
 */
export function unusedRanges(b: Uint8Array, mdat: { start: number; end: number }): { start: number; end: number }[] {
  const used = tracks(b)
    .flatMap((t) => t.chunks.map((c) => ({ start: c.offset, end: c.offset + c.sizes.reduce((n, s) => n + s, 0) })))
    .filter((r) => r.end > r.start)
    .sort((x, y) => x.start - y.start);
  const gaps: { start: number; end: number }[] = [];
  let at = mdat.start;
  for (const r of used) {
    if (r.start > at) gaps.push({ start: at, end: Math.min(r.start, mdat.end) });
    at = Math.max(at, r.end);
  }
  if (at < mdat.end) gaps.push({ start: at, end: mdat.end });
  return gaps.filter((g) => g.end > g.start);
}

/** Location patches for any `meta` boxes found in `b` (bytes read from file offset `base`). */
export function strayMetaPatches(b: Uint8Array, base: number): Patch[] {
  const patches: Patch[] = [];
  for (let at = 4; at + 4 <= b.length; at++) {
    if (b[at] !== 0x6d || ascii(b, at, 4) !== 'meta') continue; // "meta"
    const start = at - 4;
    const size = u32(b, start);
    if (size < 16 || start + size > b.length) continue;
    patches.push(...movieLocationPatches(b.subarray(start, start + size), base + start));
  }
  return patches;
}

/** Location patches inside one chunk of timed metadata samples, read into `b` from file offset `base`. */
export function sampleLocationPatches(b: Uint8Array, base: number, sizes: number[], keys: Set<number>): Patch[] {
  const patches: Patch[] = [];
  let at = 0;
  for (const size of sizes) {
    // A sample is a run of items, each a box whose type is a local key id, holding a `data` box.
    for (const item of boxes(b, at, Math.min(at + size, b.length))) {
      if (!keys.has(u32(b, item.start + 4))) continue;
      for (const data of boxes(b, item.body, item.end).filter((d) => d.type === 'data')) {
        const text = u32(b, data.body) === 1;
        const value = b.subarray(data.body + 8, data.end);
        patches.push({ offset: base + data.body + 8, bytes: text ? zeroDigits(value) : new Uint8Array(value.length) });
      }
    }
    at += size;
  }
  return patches;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Patches that zero the GPS block of a JPEG's EXIF data, given the start of the file. */
export function jpegLocationPatches(b: Uint8Array): Patch[] {
  if (b[0] !== 0xff || b[1] !== 0xd8) return [];
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1];
    const length = (b[at + 2] << 8) | b[at + 3];
    if (marker === 0xda) break; // image data starts; no more metadata
    if (marker === 0xe1 && ascii(b, at + 4, 6) === 'Exif\0\0') return exifGps(b, at + 10, Math.min(b.length, at + 2 + length));
    at += 2 + length;
  }
  return [];
}

function exifGps(b: Uint8Array, tiff: number, end: number): Patch[] {
  const le = ascii(b, tiff, 2) === 'II';
  const u16 = (at: number) => (le ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]);
  const u32e = (at: number) => (le ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0 : u32(b, at));
  const inside = (at: number, n: number) => at >= tiff && at + n <= end;

  const ifd0 = tiff + u32e(tiff + 4);
  if (!inside(ifd0, 2)) return [];
  let gps = 0;
  for (let i = 0, n = u16(ifd0); i < n; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (!inside(entry, 12)) return [];
    if (u16(entry) === 0x8825) gps = tiff + u32e(entry + 8);
  }
  if (!gps || !inside(gps, 2)) return [];
  const patches: Patch[] = [];
  for (let i = 0, n = u16(gps); i < n; i++) {
    const entry = gps + 2 + i * 12;
    if (!inside(entry, 12)) break;
    const bytes = (TYPE_SIZE[u16(entry + 2)] ?? 1) * u32e(entry + 4);
    const value = bytes <= 4 ? entry + 8 : tiff + u32e(entry + 8);
    if (inside(value, bytes)) patches.push({ offset: value, bytes: new Uint8Array(bytes) });
  }
  return patches;
}

/** How much of a JPEG's start to read to reach its EXIF data. */
export const JPEG_HEAD = 256 * 1024;

/** Every location patch for a file of `size` bytes, read through `read`. */
export async function locationPatches(name: string, size: number, read: ReadAt): Promise<Patch[]> {
  if (/\.jpe?g$/i.test(name)) return jpegLocationPatches(await read(0, Math.min(size, JPEG_HEAD)));
  if (!/\.(mov|mp4|m4v|m4a|3gp)$/i.test(name)) return [];
  // Walk the top-level boxes by their headers to find `mdat` and `moov`, then read only `moov`.
  let at = 0;
  let mdat: { start: number; end: number } | undefined;
  let moovAt: { start: number; length: number } | undefined;
  while (at + 8 <= size) {
    const head = await read(at, 16);
    if (head.length < 8) break;
    let length = u32(head, 0);
    if (length === 1) length = u32(head, 8) * 2 ** 32 + u32(head, 12);
    else if (length === 0) length = size - at;
    if (length < 8) break;
    const type = ascii(head, 4, 4);
    if (type === 'mdat') mdat = { start: at + (u32(head, 0) === 1 ? 16 : 8), end: at + length };
    if (type === 'moov') moovAt = { start: at, length };
    at += length;
  }
  if (!moovAt || moovAt.length > 256 * 1024 * 1024) return [];
  const moov = await read(moovAt.start, moovAt.length);
  const patches = movieLocationPatches(moov, moovAt.start);
  for (const track of locationTracks(moov)) {
    for (const chunk of track.chunks) {
      const total = chunk.sizes.reduce((n, s) => n + s, 0);
      if (total) patches.push(...sampleLocationPatches(await read(chunk.offset, total), chunk.offset, chunk.sizes, track.keys));
    }
  }
  for (const gap of mdat ? unusedRanges(moov, mdat) : []) {
    if (gap.end - gap.start <= 64 * 1024 * 1024) patches.push(...strayMetaPatches(await read(gap.start, gap.end - gap.start), gap.start));
  }
  return patches;
}

/** Applies the patches that overlap `chunk`, which starts at file offset `start`. */
export function applyPatches(chunk: Uint8Array, start: number, patches: Patch[]): Uint8Array {
  for (const p of patches) {
    const from = Math.max(p.offset, start);
    const to = Math.min(p.offset + p.bytes.length, start + chunk.length);
    if (from < to) chunk.set(p.bytes.subarray(from - p.offset, to - p.offset), from - start);
  }
  return chunk;
}
