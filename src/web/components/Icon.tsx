// Small stroke icon set (24×24, currentColor) so every skin can tint them.

const PATHS: Record<string, string> = {
  pointer: 'M5 3l13 7-5.5 1.5L10 17z',
  razor: 'M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M6 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8 8l12 10M8 16L20 6',
  magnet: 'M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4',
  forward: 'M4 4v16M9 12h11M16 8l4 4-4 4',
  backward: 'M20 4v16M15 12H4M8 8l-4 4 4 4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  snap: 'M4 4v16M20 4v16M8 12h8M8 12l3-3M8 12l3 3M16 12l-3-3M16 12l-3 3',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  'eye-off': 'M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  speaker: 'M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  mute: 'M11 5L6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2',
  close: 'M6 6l12 12M18 6L6 18',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  music: 'M9 18V5l11-2v13M9 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M20 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  'skip-back': 'M19 20L9 12l10-8zM5 4v16',
  'skip-fwd': 'M5 4l10 8-10 8zM19 4v16',
  'step-back': 'M15 6l-6 6 6 6',
  'step-fwd': 'M9 6l6 6-6 6',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  share: 'M4 12v8h16v-8M12 3v12M7 8l5-5 5 5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  height: 'M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const filled = name === 'play' || name === 'pause' || name === 'skip-back' || name === 'skip-fwd' || name === 'pointer';
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
