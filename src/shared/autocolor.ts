// Automatic colour correction: per-channel levels (black/white points) plus a
// gentle grey-world white balance, solved from sampled frames. The result is a
// per-channel gain and offset stored on the clip's `autoColor` effect, so the
// look is fixed once analysed and renders identically everywhere.

export interface ColorCorrection {
  gains: [number, number, number];
  offsets: [number, number, number];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * @param pixels RGB or RGBA bytes from one or more frames.
 * @param channels 3 for RGB, 4 for RGBA.
 * @param strength 0..1, how far to move from the original (default 0.75).
 */
export function solveAutoColor(pixels: ArrayLike<number>, channels: 3 | 4, strength = 0.75): ColorCorrection {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const sums = [0, 0, 0];
  let n = 0;
  for (let i = 0; i + 2 < pixels.length; i += channels) {
    for (let c = 0; c < 3; c++) {
      const v = pixels[i + c];
      hist[c][v]++;
      sums[c] += v;
    }
    n++;
  }
  if (n === 0) return { gains: [1, 1, 1], offsets: [0, 0, 0] };
  const pct = (h: Uint32Array, p: number) => {
    const target = n * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  const means = sums.map((s) => s / n);
  const grey = (means[0] + means[1] + means[2]) / 3;
  const gains = [0, 0, 0] as [number, number, number];
  const offsets = [0, 0, 0] as [number, number, number];
  for (let c = 0; c < 3; c++) {
    const lo = pct(hist[c], 0.005) / 255;
    const hi = pct(hist[c], 0.995) / 255;
    // Levels: map [lo, hi] toward [0, 1], but never stretch more than 1.6×.
    const stretch = clamp(1 / Math.max(0.05, hi - lo), 0.85, 1.6);
    // Grey-world white balance, softened (square root) and limited to ±12%.
    const wb = clamp(Math.sqrt(grey / Math.max(1, means[c])), 0.88, 1.12);
    const gain = stretch * wb;
    const offset = -lo * stretch * wb;
    gains[c] = +(1 + (gain - 1) * strength).toFixed(4);
    offsets[c] = +(offset * strength).toFixed(4);
  }
  return { gains, offsets };
}

/** SVG feColorMatrix values for a correction. */
export function correctionMatrix({ gains, offsets }: ColorCorrection): string {
  return [gains[0], 0, 0, 0, offsets[0], 0, gains[1], 0, 0, offsets[1], 0, 0, gains[2], 0, offsets[2], 0, 0, 0, 1, 0].join(' ');
}
