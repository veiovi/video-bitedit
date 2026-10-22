import { describe, expect, it } from 'vitest';
import { applyPatches, jpegLocationPatches, locationPatches } from '../src/shared/location';

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};
const box = (type: string, ...body: Uint8Array[]) => {
  const inner = cat(...body);
  return cat(u32(8 + inner.length), enc(type), inner);
};
const latin = (b: Uint8Array) => String.fromCharCode(...b);
const reader = (file: Uint8Array) => async (at: number, n: number) => file.slice(at, at + n);

/** A QuickTime file the way an iPhone writes it: mdat first, then moov with keys/ilst metadata and a ©xyz atom. */
function iphoneMovie() {
  const keys = box('keys', u32(0), u32(2), box('mdta', enc('com.apple.quicktime.model')), box('mdta', enc('com.apple.quicktime.location.ISO6709')));
  const data = (text: string) => box('data', u32(1), u32(0), enc(text));
  const ilst = box('ilst', box('\u0000\u0000\u0000\u0001', data('iPhone 15 Pro')), box('\u0000\u0000\u0000\u0002', data('+22.5970+113.8778+009.539/')));
  const meta = box('meta', box('hdlr', new Uint8Array(25)), keys, ilst);
  const xyz = box('©xyz', Uint8Array.of(0, 18, 0x15, 0xc7), enc('+22.5970+113.8778/'));
  const moov = box('moov', box('mvhd', new Uint8Array(100)), box('udta', xyz), meta);
  return cat(box('ftyp', enc('qt  '), u32(0)), box('mdat', new Uint8Array(64).fill(7)), moov);
}

describe('location', () => {
  it('blanks QuickTime location metadata and leaves everything else alone', async () => {
    const file = iphoneMovie();
    const patches = await locationPatches('clip.MOV', file.length, reader(file));
    expect(patches).toHaveLength(2);
    const out = applyPatches(file.slice(), 0, patches);
    expect(out.length).toBe(file.length);
    const text = latin(out);
    expect(text).not.toContain('22.5970');
    expect(text).toContain('+00.0000+000.0000+000.000/');
    expect(text).toContain('iPhone 15 Pro');
    const changed = [...file].filter((b, i) => b !== out[i]).length;
    expect(changed).toBeLessThan(30);
  });

  it('blanks a spare copy of the metadata left in unused media data', async () => {
    const keys = box('keys', u32(0), u32(1), box('mdta', enc('com.apple.quicktime.location.ISO6709')));
    const item = box('\u0000\u0000\u0000\u0001', box('data', u32(1), u32(0), enc('+22.5970+113.8778/')));
    const stray = box('meta', box('hdlr', new Uint8Array(25)), keys, box('ilst', item));
    const file = cat(box('ftyp', enc('qt  '), u32(0)), box('mdat', new Uint8Array(40), stray, new Uint8Array(40)), box('moov', box('mvhd', new Uint8Array(100))));
    const out = applyPatches(file.slice(), 0, await locationPatches('clip.MOV', file.length, reader(file)));
    expect(latin(out)).not.toContain('22.5970');
    expect(latin(out)).toContain('+00.0000+000.0000/');
  });

  it('applies patches chunk by chunk, across chunk edges', async () => {
    const file = iphoneMovie();
    const patches = await locationPatches('clip.mov', file.length, reader(file));
    const whole = applyPatches(file.slice(), 0, patches);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < file.length; at += 37) pieces.push(applyPatches(file.slice(at, at + 37), at, patches));
    expect(cat(...pieces)).toEqual(whole);
  });

  it('zeroes the GPS block of JPEG EXIF', () => {
    // Little-endian TIFF: IFD0 with one entry pointing at a GPS IFD holding a latitude (3 rationals).
    const tiff = new Uint8Array(80);
    const v = new DataView(tiff.buffer);
    tiff.set(enc('II'), 0);
    v.setUint16(2, 42, true);
    v.setUint32(4, 8, true);
    v.setUint16(8, 1, true);
    v.setUint16(10, 0x8825, true);
    v.setUint16(12, 4, true);
    v.setUint32(14, 1, true);
    v.setUint32(18, 26, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 2, true); // GPSLatitude
    v.setUint16(30, 5, true); // RATIONAL
    v.setUint32(32, 3, true);
    v.setUint32(36, 44, true);
    for (let i = 44; i < 68; i++) tiff[i] = 9;
    const app1 = cat(Uint8Array.of(0xff, 0xe1, 0, 8 + tiff.length), enc('Exif\0\0'), tiff);
    const jpeg = cat(Uint8Array.of(0xff, 0xd8), app1, Uint8Array.of(0xff, 0xda, 0, 2));
    const out = applyPatches(jpeg.slice(), 0, jpegLocationPatches(jpeg));
    const at = 2 + 10 + 44;
    expect([...out.subarray(at, at + 24)].every((b) => b === 0)).toBe(true);
    expect(out[2 + 10 + 10]).toBe(0x25); // the GPS pointer itself is untouched
  });

  it('ignores other files', async () => {
    const file = enc('not a movie at all');
    expect(await locationPatches('a.png', file.length, reader(file))).toEqual([]);
    expect(await locationPatches('a.mp4', file.length, reader(file))).toEqual([]);
  });
});
