import { useEffect, useState } from 'react';
import type { PublishedVideo } from '../../shared/project';
import { api, keys } from '../api';
import { WorkspaceCard } from './KeyBox';
import { HelpButton, HelpTip } from './Help';

interface ProjectRow {
  id: string;
  title: string;
  updatedAt: number;
  deletedAt?: number | null;
}

export function HomePage() {
  const [mode, setMode] = useState<'local' | 'cloud' | null>(null);
  const [authed, setAuthed] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [published, setPublished] = useState<PublishedVideo[]>([]);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');

  async function refresh() {
    const info = await api.health();
    setMode(info.mode);
    if (info.mode === 'local') {
      const [first] = await api.listProjects();
      if (first) location.replace(`/p/${first.id}`);
      return;
    }
    const ok = (await api.checkWorkspace()).ok;
    setAuthed(ok);
    if (ok) setProjects(await api.listProjects());
    setPublished(await api.listPublished());
  }

  useEffect(() => {
    document.title = 'Video bitEdit';
    refresh().catch((err) => setError((err as Error).message));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { id, editKey } = await api.createProject(title || 'Untitled project');
      keys.setEdit(id, editKey);
      location.href = `/p/${id}`;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (mode === 'local' || mode === null) return <div className="center-page">Loading…</div>;

  return (
    <div className="home">
      <header className="home-head">
        <div className="logo">
          Video bit<span>Edit</span>
        </div>
        <HelpButton className="home-help" />
        <p>Edit locally or in the browser. Share the timeline and every clip with a link. Publish when it's ready.</p>
      </header>

      {authed ? (
        <section className="home-section">
          <h2>
            Projects <HelpTip id="projects" />
          </h2>
          <form className="new-project" onSubmit={create}>
            <input placeholder="New project title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="primary">Create project</button>
          </form>
          <ul className="project-list">
            {projects
              .filter((p) => !p.deletedAt)
              .map((p) => (
                <li key={p.id}>
                  <a href={`/p/${p.id}`}>{p.title}</a>
                  <span className="muted">{new Date(p.updatedAt).toLocaleString()}</span>
                  <button
                    className="small ghost"
                    title="Move to trash (restorable)"
                    onClick={async () => {
                      await api.deleteProject(p.id);
                      await refresh();
                    }}
                  >
                    Trash
                  </button>
                </li>
              ))}
            {projects.filter((p) => !p.deletedAt).length === 0 && (
              <li className="empty">No projects yet. Create one, or push a folder with `videdit push`.</li>
            )}
          </ul>
          {projects.some((p) => p.deletedAt) && (
            <details className="trash">
              <summary>Trash ({projects.filter((p) => p.deletedAt).length})</summary>
              <ul className="project-list">
                {projects
                  .filter((p) => p.deletedAt)
                  .map((p) => (
                    <li key={p.id}>
                      <span>{p.title}</span>
                      <span className="muted">trashed {new Date(p.deletedAt!).toLocaleString()}</span>
                      <button
                        className="small"
                        onClick={async () => {
                          await api.untrashProject(p.id);
                          await refresh();
                        }}
                      >
                        Restore
                      </button>
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {keys.workspace() && <WorkspaceCard serverUrl={location.origin} workspaceKey={keys.workspace()!} />}
          <div className="button-row">
            <button
              className="small"
              onClick={async () => {
                const next = prompt('Paste a workspace key (or an unlock link)');
                const key = next?.match(/ws=([\w-]+)/)?.[1] ?? next?.trim();
                if (!key) return;
                keys.setWorkspace(key);
                await refresh();
              }}
            >
              Change key
            </button>
            <button
              className="small ghost"
              onClick={() => {
                keys.setWorkspace(null);
                location.reload();
              }}
            >
              Forget key on this device
            </button>
          </div>
          <p className="hint">
            To replace the key everywhere (for example after sharing it by mistake), run <code>videdit key rotate</code>.
          </p>
        </section>
      ) : (
        <section className="home-section">
          <h2>
            Workspace <HelpTip id="workspace" />
          </h2>
          <p className="muted">
            Paste the workspace key or unlock link from <code>videdit key</code> (it was printed by <code>videdit deploy</code>). Edit and
            view links work without it.
          </p>
          <form
            className="new-project"
            onSubmit={async (e) => {
              e.preventDefault();
              keys.setWorkspace(key.trim());
              const ok = (await api.checkWorkspace()).ok;
              if (!ok) {
                keys.setWorkspace(null);
                setError('That workspace key was not accepted.');
              } else {
                setError('');
                await refresh();
              }
            }}
          >
            <input
              type="password"
              autoComplete="off"
              placeholder="Workspace key or unlock link"
              value={key}
              onChange={(e) => setKey(e.target.value.match(/ws=([\w-]+)/)?.[1] ?? e.target.value)}
            />
            <button className="primary">Unlock</button>
          </form>
        </section>
      )}
      {error && <p className="error">{error}</p>}

      {published.length > 0 && (
        <section className="home-section">
          <h2>
            Published <HelpTip id="published" />
          </h2>
          <div className="gallery">
            {published.map((v) => (
              <a key={v.renderId} className="gallery-item" href={`/w/${v.renderId}`}>
                <video src={`/m/${v.projectId}/r/${v.renderId}#t=0.5`} muted preload="metadata" playsInline />
                <strong>{v.title}</strong>
                <span className="muted">
                  {v.timelineName} · {Math.round(v.durationFrames / v.fps)}s
                </span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
