// Editor UI skins. Each is a set of CSS variables plus a few decorative rules
// in styles.css, selected with <html data-skin="…">.

export interface Skin {
  id: string;
  num: string;
  name: string;
  dark: boolean;
}

export const SKINS: Skin[] = [
  { id: 'bit', num: '10', name: 'Bit Edit', dark: false },
  { id: 'mono', num: '06', name: 'Mono Unix', dark: true },
  { id: 'night', num: '08', name: 'Nightshift', dark: true },
  { id: 'amp', num: '02', name: 'Amp Cut', dark: true },
  { id: 'sand', num: '04', name: 'Sand Edit', dark: false },
];

const KEY = 'videdit.skin';

export function currentSkin(): Skin {
  // ?skin=amp in the URL wins (handy for screenshots and sharing a look).
  const fromUrl = new URLSearchParams(location.search).get('skin');
  if (fromUrl && SKINS.some((s) => s.id === fromUrl)) return SKINS.find((s) => s.id === fromUrl)!;
  let id: string | null = null;
  try {
    id = localStorage.getItem(KEY);
  } catch {
    // Storage unavailable.
  }
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

export function applySkin(skin: Skin) {
  document.documentElement.dataset.skin = skin.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  try {
    localStorage.setItem(KEY, skin.id);
  } catch {
    // Not persisted; fine.
  }
}
