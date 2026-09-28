import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  ProtocolValidationError,
  createEnvelope,
  parseCapabilityRequest,
  parseDelivery,
  parseEnvelope,
  parseRuntimeConfig
} from "../src/index.js";

const image = {
  id: "img_1",
  mime: "image/png",
  bytes: 12,
  sha256: "a".repeat(64),
  displayName: "screen.png"
};

const delivery = {
  deliveryId: "dly_1",
  sequence: 1,
  text: "hello",
  images: [image],
  createdAt: "2026-09-28T00:00:00.000Z"
};

describe("runtime configuration", () => {
  it("parses required values and applies operational defaults", () => {
    const config = parseRuntimeConfig({
      hubUrl: "http://localhost:47420",
      workspaceId: "ws_test",
      internalKey: "secret"
    });
    expect(config.listenHost).toBe("0.0.0.0");
    expect(config.httpPollMs).toBe(30_000);
    expect(config.clientMode).toBe("transport");
  });

  it("rejects unsafe or malformed values", () => {
    expect(() =>
      parseRuntimeConfig({ hubUrl: "file:///tmp/x", workspaceId: "ws", internalKey: "key" })
    ).toThrow(ProtocolValidationError);
  });
});

describe("wire validation", () => {
  it("round-trips an envelope without mixing inbox into the result", () => {
    const envelope = createEnvelope({
      requestId: "req_1",
      conversationId: "cv_1",
      kind: "capability_result",
      result: { ok: true, value: { count: 1 } },
      inbox: [parseDelivery(delivery)],
      cursor: "cur_1",
      presence: "working"
    });
    expect(parseEnvelope(envelope)).toEqual(envelope);
  });

  it("rejects bad image hashes and unknown capabilities", () => {
    expect(() => parseDelivery({ ...delivery, images: [{ ...image, sha256: "bad" }] })).toThrow();
    expect(() =>
      parseCapabilityRequest({
        requestId: "req_2",
        conversationId: "cv_1",
        capability: "unknown.action",
        args: {},
        createdAt: "now",
        expiresAt: "later"
      })
    ).toThrow();
  });

  it("keeps the registry unique and includes desktop primitives", () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    expect(CAPABILITIES).toContain("fs.read");
    expect(CAPABILITIES).toContain("process.exec");
  });
});
