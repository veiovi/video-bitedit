import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// With wrangler.jsonc (created by `videdit deploy`), build the Worker too.
// Without it, build only the web app for the local editor.
const cloud = existsSync('wrangler.jsonc');

export default defineConfig({
  plugins: cloud ? [react(), cloudflare()] : [react()],
  build: cloud ? { chunkSizeWarningLimit: 2500 } : { outDir: 'dist/client', chunkSizeWarningLimit: 2500 },
});
