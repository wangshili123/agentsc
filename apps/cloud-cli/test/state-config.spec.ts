import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConfigPath, loadConfig, parseRuntimeConfig } from "../src/config.js";
import { acquireWaitLock, assertStateBinding, readState, StateError, workspaceIdentity, writeState } from "../src/state.js";
import type { SessionState } from "../src/types.js";

function configValue(stateDir: string) {
  return {
    hubUrl: "http://127.0.0.1:47420/",
    listenHost: "0.0.0.0",
    listenPort: 47420,
    workspaceId: "ws_test",
    internalKey: "secret",
    keyId: "primary",
    stateDir,
    dataDir: "./data",
    idleReturnMs: 570000,
    httpPollMs: 30000,
    maxInboxPerResult: 10,
    maxImageBytes: 1024,
    maxImagesPerMessage: 2,
    commandOutputSliceBytes: 4096,
    commandPollMs: 100,
    clientMode: "transport",
    legacyFallback: true,
  };
}

describe("runtime config", () => {
  it("normalizes the Hub URL and repository-relative data directory", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-config-"));
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "runtime.json"), JSON.stringify(configValue(join(root, "state"))));
    expect(findConfigPath(join(root, "nested"), join(root, "config", "runtime.json"))).toBe(join(root, "config", "runtime.json"));
    const loaded = loadConfig(root);
    expect(loaded.config.hubUrl).toBe("http://127.0.0.1:47420");
    expect(loaded.config.dataDir).toBe(join(root, "data"));
  });

  it("rejects invalid numeric limits", () => {
    expect(() => parseRuntimeConfig({ ...configValue("x"), httpPollMs: 0 })).toThrow(/httpPollMs/);
  });
});

describe("session state", () => {
  it("persists, binds to one workspace, and rejects a second waiter", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-state-"));
    const stateDir = join(root, "state");
    const identity = workspaceIdentity(root);
    const state: SessionState = {
      version: 1,
      workspaceId: "ws_test",
      workspacePath: identity.path,
      workspaceFingerprint: identity.fingerprint,
      model: "model-exact",
      conversationId: "cv_test",
      resumeToken: "token",
      cursor: "cur_1",
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeState(stateDir, state);
    expect(readState(stateDir, "ws_test")).toMatchObject({ conversationId: "cv_test" });
    expect(() => assertStateBinding(state, "ws_test", root)).not.toThrow();
    const release = acquireWaitLock(stateDir, "ws_test");
    expect(() => acquireWaitLock(stateDir, "ws_test")).toThrowError(StateError);
    release();
    const releaseAgain = acquireWaitLock(stateDir, "ws_test");
    releaseAgain();
  });
});
