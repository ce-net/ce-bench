/**
 * Shared CLI helpers for the ce-bench network tools: locate the CE node's api.token across platforms
 * and build a ready CeClient. Node-only (uses fs/os/path).
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * The CE node data dir, per platform. On macOS the node uses ~/Library/Application Support/ce, on
 * Linux ~/.local/share/ce (XDG), on Windows %APPDATA%/ce. Override with CE_DATA_DIR.
 */
export function dataDir() {
  if (process.env.CE_DATA_DIR) return process.env.CE_DATA_DIR;
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "ce");
  if (platform() === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "ce");
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "ce");
}

/** Read the api.token (CE_API_TOKEN env wins). Returns undefined if absent. */
export function apiToken() {
  if (process.env.CE_API_TOKEN) return process.env.CE_API_TOKEN.trim();
  const f = join(dataDir(), "api.token");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  // Legacy/alt path some installs use.
  const alt = join(homedir(), ".local", "share", "ce", "api.token");
  if (existsSync(alt)) return readFileSync(alt, "utf8").trim();
  return undefined;
}

/** Parse `--flag value` / `--flag=value` / `--bool` from argv into a map. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}
