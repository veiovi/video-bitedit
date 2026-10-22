import { useState } from 'react';
import { type Comment, formatTimecode } from '../../shared/project';
import { api } from '../api';
import { activeTimeline, useEditor } from '../store';
import { HelpTip } from './Help';

const AUTHOR_KEY = 'videdit.author';

function savedAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function CommentsPanel({ comments, reload }: { comments: Comment[]; reload: () => void }) {
  const projectId = useEditor((s) => s.projectId);
  const canEdit = useEditor((s) => s.canEdit);
  const fps = useEditor((s) => activeTimeline(s).fps);
  const [author, setAuthor] = useState(savedAuthor);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      try {
        localStorage.setItem(AUTHOR_KEY, author);
      } catch {
        // Not persisted; fine.
      }
      await api.addComment(projectId, useEditor.getState().playhead, author || 'Anonymous', body);
      setBody('');
      reload();
    } catch (err) {
      useEditor.getState().setToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="comments">
      <p className="hint">
        <HelpTip id="comments" /> Notes pinned to the playhead. Anyone with a view or edit link can add one.
      </p>
      <form className="comment-form" onSubmit={submit}>
        <input placeholder="Your name" value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={60} />
        <textarea
          placeholder="Comment at the playhead…"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
          }}
        />
        <button className="primary" disabled={busy || !body.trim()}>
          Comment at {formatTimecode(useEditor.getState().playhead, fps)}
        </button>
      </form>
      <ul className="comment-list">
        {comments.map((c) => (
          <li key={c.id} className={c.resolved ? 'resolved' : ''}>
            <button className="tc" onClick={() => useEditor.getState().seek(c.frame)}>
              {formatTimecode(c.frame, fps)}
            </button>
            <div className="comment-body">
              <strong>{c.author}</strong>
              <p>{c.body}</p>
            </div>
            {canEdit && (
              <div className="comment-actions">
                <button
                  className="small"
                  title={c.resolved ? 'Reopen' : 'Resolve'}
                  onClick={async () => {
                    await api.resolveComment(projectId, c.id, !c.resolved);
                    reload();
                  }}
                >
                  {c.resolved ? '↺' : '✓'}
                </button>
                <button
                  className="small"
                  title="Delete"
                  onClick={async () => {
                    await api.deleteComment(projectId, c.id);
                    reload();
                  }}
                >
                  ×
                </button>
              </div>
            )}
          </li>
        ))}
        {comments.length === 0 && <li className="empty">No comments yet. Anyone with the link can leave one.</li>}
      </ul>
    </div>
  );
}
