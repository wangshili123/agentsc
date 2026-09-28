import { describe, expect, it, vi } from "vitest";
import { DesktopTransportClient } from "../src/index.js";

function envelope(kind: string, result: unknown, conversationId = "cv_test") {
  return new Response(JSON.stringify({
    version: 1,
    requestId: "req_test",
    conversationId,
    kind,
    result,
    inbox: [],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("DesktopTransportClient", () => {
  it("authenticates workspace headers and discovers the open conversation", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-workspace-id")).toBe("ws_test");
      expect(new Headers(init?.headers).get("x-internal-key")).toBe("secret");
      return envelope("desktop_connect", { ok: true, conversationId: "cv_test" });
    }) as unknown as typeof fetch;
    const client = new DesktopTransportClient({ hubUrl: "http://hub.test/", workspaceId: "ws_test", internalKey: "secret" }, fetchImpl);
    await expect(client.connect()).resolves.toBe("cv_test");
  });

  it("sends messages and parses responses", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/messages")) return envelope("message_queued", { ok: true, sequence: 7 });
      return envelope("responses", { ok: true, responses: [{ responseId: "rsp_1", deliveryId: "dly_1", text: "done", images: [], createdAt: "2026-09-28T00:00:00.000Z" }] });
    }) as unknown as typeof fetch;
    const client = new DesktopTransportClient({ hubUrl: "http://hub.test", workspaceId: "ws_test", internalKey: "secret" }, fetchImpl);
    await expect(client.sendMessage("cv_test", "hello")).resolves.toBe(7);
    await expect(client.listResponses("cv_test")).resolves.toMatchObject([{ text: "done" }]);
  });

  it("parses and completes capability requests", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/next")) {
        return envelope("capability_request", { ok: true, capability: {
          requestId: "req_cap",
          conversationId: "cv_test",
          capability: "fs.read",
          args: { path: "x" },
          createdAt: "2026-09-28T00:00:00.000Z",
          expiresAt: "2026-09-28T00:05:00.000Z",
        } });
      }
      return envelope("capability_result", { ok: true });
    }) as unknown as typeof fetch;
    const client = new DesktopTransportClient({ hubUrl: "http://hub.test", workspaceId: "ws_test", internalKey: "secret" }, fetchImpl);
    const request = await client.nextCapability("cv_test");
    expect(request?.capability).toBe("fs.read");
    await expect(client.completeCapability("cv_test", request!, { ok: true, value: "content" })).resolves.toBeUndefined();
  });

  it("keeps polling so a cancel request can arrive while a long capability is pending", async () => {
    let nextCount = 0;
    const completed: string[] = [];
    const capabilities = [
      { requestId: "req_long", conversationId: "cv_test", capability: "process.exec", args: {}, createdAt: "2026-09-28T00:00:00.000Z", expiresAt: "2026-09-28T00:05:00.000Z" },
      { requestId: "req_cancel", conversationId: "cv_test", capability: "process.cancel", args: { opId: "req_long" }, createdAt: "2026-09-28T00:00:01.000Z", expiresAt: "2026-09-28T00:05:01.000Z" },
    ];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/connect")) return envelope("desktop_connect", { ok: true, conversationId: "cv_test" });
      if (path.endsWith("/responses")) return envelope("responses", { ok: true, responses: [] });
      if (path.endsWith("/capability/next")) {
        const capability = capabilities[nextCount];
        nextCount += 1;
        return envelope("capability_request", { ok: true, capability });
      }
      if (path.endsWith("/capability/result")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { result?: { requestId?: string } };
        if (body.result?.requestId !== undefined) completed.push(body.result.requestId);
        return envelope("capability_result", { ok: true });
      }
      return envelope("presence", { ok: true });
    }) as unknown as typeof fetch;
    const client = new DesktopTransportClient({ hubUrl: "http://hub.test", workspaceId: "ws_test", internalKey: "secret", pollMs: 1 }, fetchImpl);
    let releaseLong!: () => void;
    const long = new Promise<void>((resolve) => { releaseLong = resolve; });
    const seen: string[] = [];
    const controller = new AbortController();
    const running = client.run({
      onResponse: () => undefined,
      onCapability: async (request) => {
        seen.push(request.capability);
        if (request.capability === "process.exec") await long;
        return { ok: true, value: request.capability };
      },
    }, controller.signal);
    await vi.waitFor(() => expect(seen).toEqual(expect.arrayContaining(["process.exec", "process.cancel"])));
    releaseLong();
    await vi.waitFor(() => expect(completed).toEqual(expect.arrayContaining(["req_long", "req_cancel"])));
    controller.abort();
    await running;
  });
});
