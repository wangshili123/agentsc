import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HubClient } from "../src/client.js";
import type { LoadedConfig } from "../src/config.js";
import { runAgent } from "../src/runner.js";

function loaded(idleReturnMs = 1000): LoadedConfig {
  const root = mkdtempSync(join(tmpdir(), "agent-runner-"));
  return {
    configPath: join(root, "config", "runtime.json"),
    repositoryRoot: root,
    config: {
      hubUrl: "http://hub.test",
      listenHost: "0.0.0.0",
      listenPort: 47420,
      workspaceId: "ws_test",
      internalKey: "secret",
      keyId: "primary",
      stateDir: join(root, "state"),
      dataDir: join(root, "data"),
      idleReturnMs,
      httpPollMs: 10,
      maxInboxPerResult: 10,
      maxImageBytes: 1024,
      maxImagesPerMessage: 2,
      commandOutputSliceBytes: 1024,
      commandPollMs: 50,
      clientMode: "transport",
      legacyFallback: false,
    },
  };
}

describe("agent runner", () => {
  it("registers once with the exact model and returns a delivery", async () => {
    const register = vi.fn(async () => ({ conversationId: "cv_test", resumeToken: "token", cursor: "cur_0" }));
    const wait = vi.fn(async () => ({
      kind: "delivery" as const,
      delivery: { sequence: 1, deliveryId: "dly_1", text: "hello", images: [] },
      inbox: [],
      cursor: "cur_1",
    }));
    const client = { register, resume: vi.fn(), wait } as unknown as HubClient;
    const result = await runAgent(loaded(), "model-exact", { client });
    expect(result).toMatchObject({ kind: "delivery", conversationId: "cv_test", cursor: "cur_1" });
    expect(register).toHaveBeenCalledWith("model-exact", expect.stringMatching(/^[a-f0-9]{64}$/));
  });

  it("resumes without requiring the model a second time", async () => {
    const fixture = loaded();
    const firstClient = {
      register: vi.fn(async () => ({ conversationId: "cv_test", resumeToken: "token", cursor: "cur_0" })),
      resume: vi.fn(),
      wait: vi.fn(async () => ({ kind: "stop" as const, inbox: [], cursor: "cur_1", reason: "first" })),
    } as unknown as HubClient;
    await runAgent(fixture, "model-exact", { client: firstClient });

    const resume = vi.fn(async () => ({ ok: true, cursor: "cur_2" }));
    const secondClient = {
      register: vi.fn(),
      resume,
      wait: vi.fn(async () => ({ kind: "stop" as const, inbox: [], cursor: "cur_3", reason: "done" })),
    } as unknown as HubClient;
    const result = await runAgent(fixture, undefined, { client: secondClient });
    expect(result.kind).toBe("stop");
    expect(resume).toHaveBeenCalledOnce();
  });

  it("returns idle after the configured outer window", async () => {
    const fixture = loaded(5);
    const client = {
      register: vi.fn(async () => ({ conversationId: "cv_test", resumeToken: "token", cursor: "" })),
      resume: vi.fn(),
      wait: vi.fn(async () => ({ kind: "idle" as const, inbox: [], cursor: "" })),
    } as unknown as HubClient;
    const result = await runAgent(fixture, "model", { client });
    expect(result.kind).toBe("idle");
    expect(result.waitedMs).toBeGreaterThanOrEqual(5);
  });
});
