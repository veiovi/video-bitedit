#!/usr/bin/env node
// Runs the TypeScript CLI directly; the Remotion bundler needs the sources anyway.
import { register } from 'tsx/esm/api';

register();
await import('../src/node/cli.ts');
