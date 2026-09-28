import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseRuntimeConfig as parseProtocolRuntimeConfig } from "@agent-transport/protocol";
import type { RuntimeConfig } from "./types.js";

export interface LoadedConfig {
  config: RuntimeConfig;
  configPath: string;
  repositoryRoot: string;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export function findConfigPath(start = process.cwd(), explicit = process.env["AGENT_TRANSPORT_CONFIG"]): string {
  if (explicit !== undefined && explicit.trim() !== "") {
    return resolve(expandHome(explicit));
  }
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, "config", "runtime.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("config/runtime.json not found; set AGENT_TRANSPORT_CONFIG");
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const parsed = parseProtocolRuntimeConfig(value);
  return {
    ...parsed,
    hubUrl: parsed.hubUrl.replace(/\/+$/, ""),
    stateDir: resolve(expandHome(parsed.stateDir)),
    dataDir: expandHome(parsed.dataDir),
  };
}

export function loadConfig(start = process.cwd()): LoadedConfig {
  const configPath = findConfigPath(start);
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const repositoryRoot = resolve(dirname(configPath), "..");
  const parsed = parseRuntimeConfig(raw);
  return {
    config: {
      ...parsed,
      dataDir: isAbsolute(parsed.dataDir) ? resolve(parsed.dataDir) : resolve(repositoryRoot, parsed.dataDir),
    },
    configPath,
    repositoryRoot,
  };
}
