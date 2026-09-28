import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHubServer, HubStore, type HubApplication } from "../../hub/src/index.js";
import { HubClient } from "../src/client.js";
import type { RuntimeConfig, SessionState } from "../src/types.js";

let application: HubApplication;
let baseUrl: string;
let directory: string;
let config: RuntimeConfig;

async function desktop(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-workspace-id": config.workspaceId,
      "x-internal-key": config.internalKey,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cloud-hub-integration-"));
  config = {
    hubUrl: "http://127.0.0.1:0",
    listenHost: "127.0.0.1",
    listenPort: 0,
    workspaceId: "ws_test",
    internalKey: "secret",
    keyId: "primary",
    stateDir: join(directory, "state"),
    dataDir: join(directory, "data"),
    idleReturnMs: 1000,
    httpPollMs: 50,
    maxInboxPerResult: 10,
    maxImageBytes: 1024,
    maxImagesPerMessage: 2,
    commandOutputSliceBytes: 1024,
    commandPollMs: 10,
    clientMode: "transport",
    legacyFallback: false,
  };
  application = createHubServer({ config, store: new HubStore(join(directory, "hub.sqlite")) });
  const address = await application.listen();
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  config = { ...config, hubUrl: baseUrl };
});

afterEach(async () => {
  await application.close();
  rmSync(directory, { recursive: true, force: true });
});

function state(conversationId: string, resumeToken: string): SessionState {
  return {
    version: 1,
    workspaceId: config.workspaceId,
    workspacePath: directory,
    workspaceFingerprint: "fingerprint",
    model: "exact-model",
    conversationId,
    resumeToken,
    cursor: "cur_-1",
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Cloud CLI with the real Hub", () => {
  it("registers, waits, replies with ACK, and normalizes capability results", async () => {
    const client = new HubClient(config);
    const registration = await client.register("exact-model", "fingerprint");
    const session = state(registration.conversationId, registration.resumeToken);

    await desktop("/v1/desktop/messages", {
      conversationId: session.conversationId,
      text: "hello",
      images: [],
    });
    const waited = await client.wait(session, 100);
    expect(waited.kind).toBe("delivery");
    expect(waited.delivery?.text).toBe("hello");

    const replied = await client.reply(session, {
      deliveryId: waited.delivery!.deliveryId,
      responseId: "rsp_1",
      text: "done",
    });
    expect(replied.kind).toBe("reply_result");
    expect(replied.result?.acknowledged).toBe(true);

    const capabilityPromise = client.capability(session, "fs.read", { path: "safe.txt" }, "req_cap");
    let request: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 20 && request === undefined; attempt += 1) {
      const next = await desktop("/v1/desktop/capability/next", { conversationId: session.conversationId });
      request = next.body.result.capability;
      if (request === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(request?.capability).toBe("fs.read");
    await desktop("/v1/desktop/capability/result", {
      conversationId: session.conversationId,
      result: { requestId: "req_cap", ok: true, value: { text: "content" } },
    });
    const capability = await capabilityPromise;
    expect(capability.kind).toBe("capability_result");
    expect(capability.result).toMatchObject({ ok: true, value: { text: "content" } });
  });

  it("surfaces auth_expired instead of bad_response", async () => {
    const client = new HubClient(config);
    const registration = await client.register("exact-model", "fingerprint");
    const invalid = state(registration.conversationId, "invalid-token");
    await expect(client.wait(invalid, 10)).resolves.toMatchObject({
      kind: "auth_expired",
      action: "register_again",
    });
  });

  it("closes the conversation through chat.stop", async () => {
    const client = new HubClient(config);
    const registration = await client.register("exact-model", "fingerprint");
    const session = state(registration.conversationId, registration.resumeToken);
    await expect(client.capability(session, "chat.stop", {}, "req_stop")).resolves.toMatchObject({ kind: "stop" });
    await expect(client.wait(session, 10)).resolves.toMatchObject({ kind: "auth_expired" });
  });
});
