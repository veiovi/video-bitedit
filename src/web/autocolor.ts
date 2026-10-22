// Browser-side analysis for the Auto colour effect: grab a few frames of the
// clip's source range into a small canvas and solve the same correction the
// CLI computes with FFmpeg.

import { type ColorCorrection, solveAutoColor } from '../shared/autocolor';

export async function analyseClipColor(src: string, kind: 'video' | 'image', from: number, to: number): Promise<ColorCorrection> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const chunks: Uint8ClampedArray[] = [];
  const grab = (source: CanvasImageSource, w: number, h: number) => {
    canvas.width = 96;
    canvas.height = Math.max(1, Math.round((96 * h) / w));
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    chunks.push(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  };
  if (kind === 'image') {
    const img = new Image();
    img.src = src;
    await img.decode();
    grab(img, img.naturalWidth, img.naturalHeight);
  } else {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = src;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Could not load the clip for colour analysis'));
    });
    for (let i = 0; i < 6; i++) {
      video.currentTime = from + ((to - from) * (i + 0.5)) / 6;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        setTimeout(resolve, 2500);
      });
      grab(video, video.videoWidth, video.videoHeight);
    }
  }
  const all = new Uint8ClampedArray(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return solveAutoColor(all, 4);
}
