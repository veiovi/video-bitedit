import { useEffect, useState } from 'react';
import { api, keys } from '../api';
import { useEditor } from '../store';
import { HelpTip } from './Help';

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => useEditor.getState().setToast(`${what} copied`),
    () => useEditor.getState().setToast('Copy failed — select the text and copy it'),
  );
}

/** A secret shown masked, with Show and Copy. */
export function KeyBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="key-box">
      <span className="key-label">{label}</span>
      <div className="copy-row">
        <input readOnly value={shown ? value : `${'•'.repeat(12)}${value.slice(-4)}`} onFocus={(e) => (setShown(true), e.target.select())} />
        <button className="small" onClick={() => setShown(!shown)}>
          {shown ? 'Hide' : 'Show'}
        </button>
        <button className="small primary" onClick={() => copy(value, label)}>
          Copy
        </button>
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** A command or link with a Copy button. */
export function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="key-box">
      <span className="key-label">{label}</span>
      <div className="copy-row">
        <input readOnly value={value} onFocus={(e) => e.target.select()} />
        <button className="small" onClick={() => copy(value, label)}>
          Copy
        </button>
      </div>
    </div>
  );
}

/**
 * Everything someone needs to use this workspace elsewhere: the key, a link
 * that unlocks another browser, and the commands for a render machine.
 */
export function WorkspaceCard({ serverUrl, workspaceKey, compact }: { serverUrl: string; workspaceKey: string; compact?: boolean }) {
  const unlock = `${serverUrl.replace(/\/+$/, '')}/#ws=${workspaceKey}`;
  return (
    <div className="workspace-card">
      <h3>
        Workspace key <HelpTip id="workspace" />
      </h3>
      <KeyBox label="Key" value={workspaceKey} hint="Creates projects and publishes. Share it only with people who run renders." />
      <CopyLine label="Unlock link (opens another browser already unlocked)" value={unlock} />
      {!compact && <CopyLine label="Render machine (run in a terminal)" value={`npx videdit login '${unlock}' && npx videdit worker`} />}
    </div>
  );
}

/** The cloud workspace this editor can act for: the local CLI's, or the key stored in this browser. */
export function useWorkspace(): { serverUrl: string; workspaceKey: string } | null {
  const server = useEditor((s) => s.server);
  const [ws, setWs] = useState<{ serverUrl: string; workspaceKey: string } | null>(null);
  useEffect(() => {
    if (server?.mode === 'local') {
      api.localWorkspace().then(setWs).catch(() => setWs(null));
    } else {
      const k = keys.workspace();
      setWs(k ? { serverUrl: location.origin, workspaceKey: k } : null);
    }
  }, [server?.mode]);
  return ws;
}

