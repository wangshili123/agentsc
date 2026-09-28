import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { SessionState } from "./types.js";
import { isRecord, stringOf } from "./types.js";

export class StateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StateError";
  }
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new StateError("bad_workspace_id", "workspaceId is not file-safe");
  return value;
}

export function workspaceIdentity(path: string): { path: string; fingerprint: string } {
  const canonical = realpathSync(resolve(path));
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return {
    path: canonical,
    fingerprint: createHash("sha256").update(normalized, "utf8").digest("hex"),
  };
}

export function sessionDirectory(stateDir: string, workspaceId: string): string {
  return join(stateDir, "sessions", safeName(workspaceId));
}

export function stateFile(stateDir: string, workspaceId: string): string {
  return join(sessionDirectory(stateDir, workspaceId), "session.json");
}

export function lockFile(stateDir: string, workspaceId: string): string {
  return join(sessionDirectory(stateDir, workspaceId), "wait.lock");
}

export function parseSessionState(value: unknown): SessionState {
  if (!isRecord(value) || value["version"] !== 1) throw new StateError("bad_state", "session state version is invalid");
  const workspaceId = stringOf(value, "workspaceId");
  const workspacePath = stringOf(value, "workspacePath");
  const workspaceFingerprint = stringOf(value, "workspaceFingerprint");
  const model = stringOf(value, "model");
  const conversationId = stringOf(value, "conversationId");
  const resumeToken = stringOf(value, "resumeToken");
  const cursor = typeof value["cursor"] === "string" ? value["cursor"] : "";
  const registeredAt = stringOf(value, "registeredAt");
  const updatedAt = stringOf(value, "updatedAt");
  if (
    workspaceId === undefined || workspacePath === undefined || workspaceFingerprint === undefined ||
    model === undefined || conversationId === undefined || resumeToken === undefined ||
    registeredAt === undefined || updatedAt === undefined
  ) {
    throw new StateError("bad_state", "session state is incomplete");
  }
  return {
    version: 1,
    workspaceId,
    workspacePath,
    workspaceFingerprint,
    model,
    conversationId,
    resumeToken,
    cursor,
    registeredAt,
    updatedAt,
  };
}

export function readState(stateDir: string, workspaceId: string): SessionState | undefined {
  const file = stateFile(stateDir, workspaceId);
  if (!existsSync(file)) return undefined;
  return parseSessionState(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

export function assertStateBinding(state: SessionState, workspaceId: string, workspaceRoot: string): void {
  const identity = workspaceIdentity(workspaceRoot);
  if (state.workspaceId !== workspaceId) throw new StateError("workspace_conflict", "state belongs to another workspaceId");
  if (state.workspaceFingerprint !== identity.fingerprint) {
    throw new StateError("workspace_conflict", "state belongs to another workspace path");
  }
}

export function writeState(stateDir: string, state: SessionState): void {
  const directory = sessionDirectory(stateDir, state.workspaceId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = stateFile(stateDir, state.workspaceId);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireWaitLock(stateDir: string, workspaceId: string): () => void {
  const directory = sessionDirectory(stateDir, workspaceId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = lockFile(stateDir, workspaceId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      writeFileSync(descriptor, `${String(process.pid)}\n`, "utf8");
      closeSync(descriptor);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { unlinkSync(file); } catch { /* already removed */ }
      };
    } catch (error) {
      const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : "";
      if (code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (pidAlive(owner)) throw new StateError("waiter_conflict", `waiter process ${String(owner)} is already running`);
      try { unlinkSync(file); } catch { /* another process won cleanup */ }
    }
  }
  throw new StateError("waiter_conflict", "could not acquire waiter lock");
}
