import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRuntimeConfig, type RuntimeConfig } from "@agent-transport/protocol";
import { createHubServer, type HubApplication } from "../src/server.js";
import { HubStore } from "../src/store.js";

interface JsonRecord {
  [key: string]: any;
}

let application: HubApplication;
let baseUrl: string;
let directory: string;
let config: RuntimeConfig;

async function post(
  path: string,
  body: JsonRecord,
  options: { token?: string; internal?: boolean } = {}
): Promise<{ status: number; body: JsonRecord }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.internal === true) {
    headers["x-workspace-id"] = config.workspaceId;
    headers["x-internal-key"] = config.internalKey;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as JsonRecord };
}

async function register(): Promise<{ conversationId: string; resumeToken: string }> {
  const response = await post("/v1/agent/register", {
    workspaceId: config.workspaceId,
    internalKey: config.internalKey,
    model: "test-model",
    workspaceFingerprint: "workspace-fingerprint"
  });
  expect(response.status).toBe(201);
  return response.body.result as { conversationId: string; resumeToken: string };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "agent-transport-hub-"));
  config = {
    ...parseRuntimeConfig({
      hubUrl: "http://127.0.0.1:47420",
      workspaceId: "ws_test",
      internalKey: "internal-test-key"
    }),
    listenHost: "127.0.0.1",
    listenPort: 0
  };
  const store = new HubStore(join(directory, "hub.sqlite"), { visibilityTimeoutMs: 35, capabilityVisibilityMs: 35 });
  application = createHubServer({ config, store });
  const address = await application.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await application.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Hub registration and health", () => {
  it("checks workspace credentials and resumes only the bound workspace", async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: 1 });

    const denied = await post("/v1/agent/register", {
      workspaceId: "wrong",
      internalKey: "wrong",
      model: "test-model",
      workspaceFingerprint: "workspace-fingerprint"
    });
    expect(denied.status).toBe(401);

    const registration = await register();
    const wrongWorkspace = await post("/v1/agent/resume", {
      ...registration,
      workspaceFingerprint: "copied-workspace"
    });
    expect(wrongWorkspace.status).toBe(401);

    const resumed = await post("/v1/agent/resume", {
      ...registration,
      workspaceFingerprint: "workspace-fingerprint"
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.result.conversation.conversationId).toBe(registration.conversationId);

    const replacement = await register();
    expect(replacement.conversationId).not.toBe(registration.conversationId);
    const oldResume = await post("/v1/agent/resume", { ...registration, workspaceFingerprint: "workspace-fingerprint" });
    expect(oldResume.status).toBe(401);
    const desktop = await post("/v1/desktop/connect", {}, { internal: true });
    expect(desktop.body.result.conversationId).toBe(replacement.conversationId);
  });
});

describe("reliable chat delivery", () => {
  it("routes text and image metadata, redelivers after visibility, and atomically ACKs a reply", async () => {
    const registration = await register();
    const image = {
      id: "img_1",
      mime: "image/png",
      bytes: 12,
      sha256: "a".repeat(64),
      displayName: "screen.png"
    };
    const queued = await post(
      "/v1/desktop/messages",
      { conversationId: registration.conversationId, messageId: "msg_1", text: "hello", images: [image] },
      { internal: true }
    );
    expect(queued.status).toBe(201);
    const queuedReplay = await post(
      "/v1/desktop/messages",
      { conversationId: registration.conversationId, messageId: "msg_1", text: "hello", images: [image] },
      { internal: true }
    );
    expect(queuedReplay.body.result.sequence).toBe(queued.body.result.sequence);

    const first = await post(
      "/v1/agent/wait",
      { conversationId: registration.conversationId, cursor: "cur_-1", timeoutMs: 50 },
      { token: registration.resumeToken }
    );
    expect(first.status).toBe(200);
    expect(first.body.kind).toBe("delivery");
    expect(first.body.inbox[0].images).toEqual([image]);
    const deliveryId = first.body.inbox[0].deliveryId as string;

    const hidden = await post(
      "/v1/agent/wait",
      { conversationId: registration.conversationId, cursor: first.body.cursor, timeoutMs: 5 },
      { token: registration.resumeToken }
    );
    expect(hidden.body.kind).toBe("idle");

    await new Promise((resolve) => setTimeout(resolve, 45));
    const redelivered = await post(
      "/v1/agent/wait",
      { conversationId: registration.conversationId, cursor: first.body.cursor, timeoutMs: 50 },
      { token: registration.resumeToken }
    );
    expect(redelivered.body.inbox[0].deliveryId).toBe(deliveryId);

    const reply = await post(
      "/v1/agent/reply",
      {
        conversationId: registration.conversationId,
        deliveryId,
        responseId: "rsp_1",
        text: "received"
      },
      { token: registration.resumeToken }
    );
    expect(reply.status).toBe(200);
    expect(reply.body.result.acknowledged).toBe(true);
    expect(reply.body.result.replayed).toBe(false);

    const replay = await post(
      "/v1/agent/reply",
      {
        conversationId: registration.conversationId,
        deliveryId,
        responseId: "rsp_1",
        text: "a different retry body"
      },
      { token: registration.resumeToken }
    );
    expect(replay.body.result.replayed).toBe(true);
    expect(replay.body.result.response.text).toBe("received");

    const conflictingReplay = await post(
      "/v1/agent/reply",
      {
        conversationId: registration.conversationId,
        deliveryId: "dly_other",
        responseId: "rsp_1",
        text: "must not cross-bind"
      },
      { token: registration.resumeToken }
    );
    expect(conflictingReplay.status).toBe(409);
    expect(conflictingReplay.body.result.code).toBe("response_id_conflict");

    const responses = await post(
      "/v1/desktop/responses",
      { conversationId: registration.conversationId },
      { internal: true }
    );
    expect(responses.body.result.responses).toHaveLength(1);
  });

  it("allows only one active waiter for a conversation", async () => {
    const registration = await register();
    const first = post(
      "/v1/agent/wait",
      { conversationId: registration.conversationId, cursor: "cur_-1", timeoutMs: 150 },
      { token: registration.resumeToken }
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    const conflict = await post(
      "/v1/agent/wait",
      { conversationId: registration.conversationId, cursor: "cur_-1", timeoutMs: 10 },
      { token: registration.resumeToken }
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.kind).toBe("conflict");
    expect((await first).body.kind).toBe("idle");
  });
});

describe("desktop capability and presence routing", () => {
  it("persists a capability request/result and exposes layered presence", async () => {
    const registration = await register();
    const requested = await post(
      "/v1/agent/capability",
      {
        conversationId: registration.conversationId,
        requestId: "cap_1",
        name: "fs.read",
        args: { path: "E:\\safe\\file.txt" }
      },
      { token: registration.resumeToken }
    );
    expect(requested.status).toBe(202);

    const conflictingRequest = await post(
      "/v1/agent/capability",
      {
        conversationId: registration.conversationId,
        requestId: "cap_1",
        name: "fs.read",
        args: { path: "E:\\other\\file.txt" }
      },
      { token: registration.resumeToken }
    );
    expect(conflictingRequest.status).toBe(409);
    expect(conflictingRequest.body.result.code).toBe("capability_request_conflict");

    const next = await post(
      "/v1/desktop/capability/next",
      { conversationId: registration.conversationId },
      { internal: true }
    );
    expect(next.body.result.capability.name).toBe("fs.read");
    expect(next.body.result.capability.status).toBe("running");

    const completed = await post(
      "/v1/desktop/capability/result",
      {
        conversationId: registration.conversationId,
        result: { requestId: "cap_1", ok: true, value: { text: "contents" } }
      },
      { internal: true }
    );
    expect(completed.status).toBe(200);

    const result = await post(
      "/v1/agent/capability/result",
      { conversationId: registration.conversationId, requestId: "cap_1" },
      { token: registration.resumeToken }
    );
    expect(result.status).toBe(200);
    expect(result.body.result.result.ok).toBe(true);

    const presence = await post(
      "/v1/desktop/presence",
      {
        conversationId: registration.conversationId,
        transportConnected: true,
        desktopReady: true,
        state: "working"
      },
      { internal: true }
    );
    expect(presence.body.result.presence.desktopReady).toBe(true);
    expect(presence.body.presence).toBe("working");

    const replacement = await register();
    const crossConversation = await post(
      "/v1/agent/capability/result",
      { conversationId: replacement.conversationId, requestId: "cap_1" },
      { token: replacement.resumeToken }
    );
    expect(crossConversation.status).toBe(404);
    expect(crossConversation.body.result.code).toBe("capability_request_not_found");
  });
});

describe("capability visibility recovery", () => {
  it("requeues a running request when the desktop claimant disappears", async () => {
    const registration = await register();
    await post(
      "/v1/agent/capability",
      { conversationId: registration.conversationId, requestId: "cap_recover", name: "fs.read", args: { path: "safe.txt" } },
      { token: registration.resumeToken }
    );
    const first = await post(
      "/v1/desktop/capability/next",
      { conversationId: registration.conversationId },
      { internal: true }
    );
    expect(first.body.result.capability.requestId).toBe("cap_recover");
    const hidden = await post(
      "/v1/desktop/capability/next",
      { conversationId: registration.conversationId },
      { internal: true }
    );
    expect(hidden.body.result.capability).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 45));
    const recovered = await post(
      "/v1/desktop/capability/next",
      { conversationId: registration.conversationId },
      { internal: true }
    );
    expect(recovered.body.result.capability.requestId).toBe("cap_recover");
  });
});

describe("desktop pairing, attachments, and inbox guard", () => {
  it("discovers the active conversation and serves verified attachment bytes", async () => {
    const registration = await register();
    const connected = await post("/v1/desktop/connect", {}, { internal: true });
    expect(connected.body.result.conversationId).toBe(registration.conversationId);

    const bytes = Buffer.from("image-body");
    const uploaded = await post(
      "/v1/desktop/attachments",
      {
        conversationId: registration.conversationId,
        mime: "image/png",
        displayName: "screen.png",
        dataBase64: bytes.toString("base64")
      },
      { internal: true }
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.result.image.bytes).toBe(bytes.length);
    const imageResponse = await fetch(`${baseUrl}${uploaded.body.result.image.downloadUrl}`, {
      headers: { authorization: `Bearer ${registration.resumeToken}` }
    });
    expect(imageResponse.status).toBe(200);
    expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(bytes);
  });

  it("returns message_pending and does not enqueue a stale mutating capability", async () => {
    const registration = await register();
    await post(
      "/v1/desktop/messages",
      { conversationId: registration.conversationId, text: "stop", images: [] },
      { internal: true }
    );
    const blocked = await post(
      "/v1/agent/capability",
      {
        conversationId: registration.conversationId,
        requestId: "cap_blocked",
        name: "fs.write",
        args: { path: "safe.txt", contents: "old task" }
      },
      { token: registration.resumeToken }
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.result.code).toBe("message_pending");
    expect(blocked.body.inbox[0].text).toBe("stop");

    const next = await post(
      "/v1/desktop/capability/next",
      { conversationId: registration.conversationId },
      { internal: true }
    );
    expect(next.body.result.capability).toBeUndefined();
  });
});
