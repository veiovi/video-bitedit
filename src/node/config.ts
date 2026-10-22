// Where this machine's cloud deployment lives. Written by `videdit deploy`
// (or `videdit login`) to ~/.config/videdit/config.json with mode 600.
// VIDEDIT_SERVER_URL and VIDEDIT_WORKSPACE_KEY override the file.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CloudConfig {
  serverUrl: string;
  workspaceKey: string;
}

export const CONFIG_DIR = process.env.VIDEDIT_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'videdit');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** Everything stored in the config file, including optional keys such as `openrouterKey`. */
export interface ConfigFile extends Partial<CloudConfig> {
  openrouterKey?: string;
}

export function readConfigFile(): ConfigFile {
  return existsSync(CONFIG_FILE) ? (JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as ConfigFile) : {};
}

/** Merge fields into the config file, keeping the rest. */
export function updateConfigFile(patch: ConfigFile) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfigFile(), ...patch }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

export function loadConfig(): CloudConfig | null {
  const fromFile = readConfigFile();
  const serverUrl = process.env.VIDEDIT_SERVER_URL ?? fromFile.serverUrl;
  const workspaceKey = process.env.VIDEDIT_WORKSPACE_KEY ?? fromFile.workspaceKey;
  if (!serverUrl || !workspaceKey) return null;
  return { serverUrl: serverUrl.replace(/\/+$/, ''), workspaceKey };
}

export function saveConfig(config: CloudConfig) {
  updateConfigFile(config);
}

export const configPath = () => CONFIG_FILE;
