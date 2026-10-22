// Small ? buttons that explain the part of the app next to them, and the Help
// panel they link to. The words live in ../help.ts.

import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { COMMANDS, PALETTE_KEYS } from '../commands';
import { SECTIONS, SHORTCUTS, TIPS, type TipId } from '../help';

const OPEN_EVENT = 'videdit:help';

/** Open the Help panel, optionally at a section. */
export function openHelp(section?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: section }));
}

/** Text with `code` spans. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
    </>
  );
}

/** A tiny circled ? that explains `id` on hover, focus or tap. */
export function HelpTip({ id }: { id: TipId }) {
  const tip = TIPS[id];
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const closing = useRef<number | undefined>(undefined);

  const show = () => {
    window.clearTimeout(closing.current);
    setOpen(true);
  };
  const hide = () => {
    if (pinned) return;
    closing.current = window.setTimeout(() => setOpen(false), 150);
  };

  // Place the bubble under the button (above it near the bottom of the window), inside the viewport.
  useLayoutEffect(() => {
    if (!open || !button.current || !pop.current) return;
    const b = button.current.getBoundingClientRect();
    const p = pop.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, b.left + b.width / 2 - p.width / 2), innerWidth - p.width - 8);
    const below = b.bottom + 6;
    const top = below + p.height > innerHeight - 8 ? Math.max(8, b.top - p.height - 6) : below;
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const away = (e: PointerEvent) => {
      if (!button.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (setOpen(false), setPinned(false));
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // Keep clicks from reaching what the button sits in (a tab, a <summary>, a header that selects).
  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <span className="help-tip-wrap" onPointerEnter={(e) => e.pointerType === 'mouse' && show()} onPointerLeave={hide}>
      <button
        ref={button}
        type="button"
        className={`help-tip ${open ? 'on' : ''}`}
        aria-label="What is this?"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          stop(e);
          setPinned(!pinned || !open);
          setOpen(!(pinned && open));
        }}
        onFocus={show}
        onBlur={hide}
      >
        ?
      </button>
      {open && (
        <div
          ref={pop}
          className="help-pop"
          role="tooltip"
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Rich text={tip.text} />
          <button
            type="button"
            className="help-more"
            onClick={(e) => {
              stop(e);
              setOpen(false);
              setPinned(false);
              openHelp(tip.section);
            }}
          >
            More in Help →
          </button>
        </div>
      )}
    </span>
  );
}

/** The Help panel: every feature, section by section, plus the keyboard shortcuts. Mount once per page. */
export function HelpDialog() {
  const [section, setSection] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOpen = (e: Event) => setSection((e as CustomEvent<string | undefined>).detail ?? SECTIONS[0].id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSection(null);
      if (e.key === '?' && !(e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) {
        e.preventDefault();
        setSection((s) => (s ? null : SECTIONS[0].id));
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (section) body.current?.querySelector(`#help-${section}`)?.scrollIntoView({ block: 'start' });
  }, [section]);

  if (!section) return null;
  const go = (id: string) => {
    setSection(id);
    body.current?.querySelector(`#help-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div className="modal-backdrop" onClick={() => setSection(null)}>
      <div className="modal help-dialog" role="dialog" aria-label="Help" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Help</h2>
          <div className="grow" />
          <button className="ghost" onClick={() => setSection(null)} aria-label="Close help">
            ×
          </button>
        </div>
        <div className="help-layout">
          <nav className="help-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={s.id === section ? 'on' : ''} onClick={() => go(s.id)}>
                {s.title}
              </button>
            ))}
            <button className={section === 'keys' ? 'on' : ''} onClick={() => go('keys')}>
              Keyboard shortcuts
            </button>
            <button className={section === 'commands' ? 'on' : ''} onClick={() => go('commands')}>
              Commands
            </button>
          </nav>
          <div className="help-body" ref={body}>
            {SECTIONS.map((s) => (
              <section key={s.id} id={`help-${s.id}`}>
                <h3>{s.title}</h3>
                <p>
                  <Rich text={s.intro} />
                </p>
                {s.items.length > 0 && (
                  <dl>
                    {s.items.map(([term, text]) => (
                      <div key={term}>
                        <dt>{term}</dt>
                        <dd>
                          <Rich text={text} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            ))}
            <section id="help-keys">
              <h3>Keyboard shortcuts</h3>
              <p>On Windows and Linux, use Ctrl where it says ⌘.</p>
              <dl>
                {SHORTCUTS.map(([keys, what]) => (
                  <div key={keys}>
                    <dt>{keys}</dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section id="help-commands">
              <h3>Commands</h3>
              <p>Every command is in the command palette: press {PALETTE_KEYS} and type part of its name.</p>
              <dl>
                {COMMANDS.map((c) => (
                  <div key={c.id}>
                    <dt>{'keys' in c ? c.keys : '—'}</dt>
                    <dd>{c.title}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <p className="hint">
              More for agents and developers in the{' '}
              <a href="https://github.com/veiovi/video-bitedit#readme" target="_blank" rel="noreferrer">
                README
              </a>{' '}
              and{' '}
              <a href="https://github.com/veiovi/video-bitedit/blob/main/docs/agents.md" target="_blank" rel="noreferrer">
                agent guide
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A Help button for top bars. */
export function HelpButton({ className = '' }: { className?: string }) {
  return (
    <button className={`help-btn ${className}`} onClick={() => openHelp()} title="Help (?)">
      Help
    </button>
  );
}
