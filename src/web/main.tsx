import '@fontsource-variable/jetbrains-mono';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/share-tech-mono/400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorPage } from './components/EditorPage';
import { HomePage } from './components/HomePage';
import { WatchPage } from './components/WatchPage';
import { captureWorkspaceKeyFromUrl } from './api';
import { applySkin, currentSkin } from './skins';
import './styles.css';
import { HelpDialog } from './components/Help';

applySkin(currentSkin());
captureWorkspaceKeyFromUrl();

function App() {
  const project = location.pathname.match(/^\/p\/([^/]+)/);
  if (project) return <EditorPage projectId={project[1]} />;
  const watch = location.pathname.match(/^\/w\/([^/]+)/);
  if (watch) return <WatchPage renderId={watch[1]} />;
  return <HomePage />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <HelpDialog />
  </StrictMode>,
);
