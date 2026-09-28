import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { downloadDeliveryImages, ImageError } from "../src/images.js";
import type { RuntimeConfig, SessionState } from "../src/types.js";

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), "agent-images-"));
  const config: RuntimeConfig = {
    hubUrl: "http://hub.test",
    listenHost: "0.0.0.0",
    listenPort: 47420,
    workspaceId: "ws_test",
    internalKey: "secret",
    keyId: "primary",
    stateDir: root,
    dataDir: join(root, "data"),
    idleReturnMs: 1000,
    httpPollMs: 100,
    maxInboxPerResult: 10,
    maxImageBytes: 1024,
    maxImagesPerMessage: 2,
    commandOutputSliceBytes: 1024,
    commandPollMs: 50,
    clientMode: "transport",
    legacyFallback: false,
  };
  const state: SessionState = {
    version: 1,
    workspaceId: "ws_test",
    workspacePath: root,
    workspaceFingerprint: "fingerprint",
    model: "model",
    conversationId: "cv_test",
    resumeToken: "token",
    cursor: "",
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { config, state };
}

describe("delivery images", () => {
  it("writes a verified image into the current session directory", async () => {
    const { config, state } = fixtures();
    const body = Buffer.from("small-png-body");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const result = await downloadDeliveryImages(config, state, {
      sequence: 1,
      deliveryId: "dly_1",
      text: "look",
      images: [{ id: "img_1", mime: "image/png", bytes: body.length, sha256, displayName: "image.png", downloadUrl: "/v1/images/img_1" }],
    }, async () => new Response(body, { status: 200, headers: { "content-length": String(body.length) } }));
    expect(result.images[0]?.localPath).toMatch(/\.png$/);
    expect(existsSync(result.images[0]?.localPath ?? "")).toBe(true);
  });

  it("rejects a hash mismatch without returning a local path", async () => {
    const { config, state } = fixtures();
    const body = Buffer.from("bad");
    await expect(downloadDeliveryImages(config, state, {
      sequence: 1,
      deliveryId: "dly_1",
      text: "",
      images: [{ id: "img_1", mime: "image/png", bytes: body.length, sha256: "0".repeat(64), displayName: "image.png", downloadUrl: "/image" }],
    }, async () => new Response(body, { status: 200 }))).rejects.toBeInstanceOf(ImageError);
  });

  it("rejects unsupported MIME before fetching", async () => {
    const { config, state } = fixtures();
    let called = false;
    await expect(downloadDeliveryImages(config, state, {
      sequence: 1,
      deliveryId: "dly_1",
      text: "",
      images: [{ id: "img_1", mime: "image/svg+xml", bytes: 10, sha256: "0".repeat(64), displayName: "image.png", downloadUrl: "/image" }],
    }, async () => { called = true; return new Response(); })).rejects.toMatchObject({ code: "image_mime_denied" });
    expect(called).toBe(false);
  });
});
