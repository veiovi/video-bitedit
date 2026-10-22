# Project instructions

Video bitEdit: local-first video editor (React + Remotion) with a Cloudflare Worker
(D1 + R2) for sharing, a render worker, and a CLI for agents.

## Commands

- `npm install`, then `npm run build`. The build outputs `dist/client`, plus
  the Worker build when `wrangler.jsonc` exists.
- `npm test` runs the vitest unit tests in `tests/`. `npm run typecheck` runs
  `tsc -b` across the app, Worker and Node configs.
- `node bin/videdit.mjs <command>` runs the CLI. `open <folder>` starts the
  local editor on port 4848.
- `node bin/videdit.mjs deploy` needs `CLOUDFLARE_API_TOKEN`. It creates or
  reuses the D1 database `videdit` and the R2 bucket `videdit-media`, writes
  `wrangler.jsonc`, applies migrations, builds and deploys. The command is
  safe to re-run, and it keeps the workspace key in
  `~/.config/videdit/config.json`.
- `npm run dev` runs the web app and Worker against local D1/R2. It needs
  `wrangler.jsonc` and `.dev.vars` (copy the `*.example` files) and
  `npm run db:migrate:local`.

## Conventions

- Timeline times are integer frames. Edit operations in
  `src/shared/edits.ts` are pure and must stay covered by
  `tests/edits.test.ts`.
- The Cloudflare Worker (`src/worker`) and the local server
  (`src/node/local-server.ts`) implement the same REST shape for the web app.
  Change both together.
- UI skins are CSS variables in `src/web/styles.css`, keyed by
  `data-skin`, and are listed in `src/web/skins.ts`. Title styles for video
  text are in `src/shared/themes.ts` and are a separate thing.
- `wrangler.jsonc`, `.dev.vars` and `~/.config/videdit` hold account IDs or
  secrets. Never commit them.

Architecture, the plan and the agent workflow are in `docs/`.
