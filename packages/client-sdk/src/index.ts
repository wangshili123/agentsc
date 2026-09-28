import { createHash, randomUUID } from "node:crypto";
export type { CapabilityRequest, CapabilityResult, ImageMeta, Response } from "@agent-transport/protocol";
import {
  parseCapabilityRequest,
  parseEnvelope,
  parseImageMeta,
  type CapabilityRequest,
  type CapabilityResult,
  type ImageMeta,
  type PresenceState,
  type Response as ChatResponse,
} from "@agent-transport/protocol";

export interface DesktopTransportConfig {
  hubUrl: string;
  workspaceId: string;
  internalKey: string;
  pollMs?: number;
  requestTimeoutMs?: number;
}

export interface DesktopPresence {
  transportConnected: boolean;
  desktopReady: boolean;
  agentListening: boolean;
  agentWorking: boolean;
  agentStalled: boolean;
  conversationClosed: boolean;
  state: PresenceState;
}

export interface DesktopTransportHandlers {
  onConversation?: (conversationId: string) => void;
  onTransportState?: (connected: boolean, conversationId?: string) => void;
  onResponse: (response: ChatResponse) => void | Promise<void>;
  onCapability: (request: CapabilityRequest) => Promise<
    | { ok: true; value: unknown }
    | { ok: false; code: string; message: string }
  >;
  onError?: (error: Error) => void;
}

export class DesktopTransportError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "DesktopTransportError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DesktopTransportError("bad_response", "Hub result must be an object", 502);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new DesktopTransportError("bad_response", `${label} is missing`, 502);
  return value;
}

function chatResponse(value: unknown): ChatResponse {
  const source = record(value);
  const images = Array.isArray(source["images"]) ? source["images"] as ImageMeta[] : [];
  return {
    responseId: stringValue(source["responseId"], "responseId"),
    deliveryId: stringValue(source["deliveryId"], "deliveryId"),
    text: typeof source["text"] === "string" ? source["text"] : "",
    images,
    createdAt: stringValue(source["createdAt"], "createdAt"),
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export class DesktopTransportClient {
  readonly hubUrl: string;
  readonly pollMs: number;
  readonly requestTimeoutMs: number;

  constructor(readonly config: DesktopTransportConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.hubUrl = config.hubUrl.replace(/\/+$/, "");
    this.pollMs = config.pollMs ?? 500;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
  }

  private async request(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    let response: globalThis.Response;
    try {
      response = await this.fetchImpl(`${this.hubUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": this.config.workspaceId,
          "x-internal-key": this.config.internalKey,
        },
        body: JSON.stringify({ requestId: `req_${randomUUID().replaceAll("-", "")}`, ...body }),
        signal: combined,
      });
    } catch (error) {
      throw new DesktopTransportError("hub_unreachable", error instanceof Error ? error.message : String(error), 0);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = payload === undefined ? undefined : parseEnvelope(payload);
      const result = envelope === undefined ? {} : record(envelope.result ?? {});
      throw new DesktopTransportError(
        typeof result["code"] === "string" ? result["code"] : "hub_error",
        typeof result["message"] === "string" ? result["message"] : `Hub returned ${String(response.status)}`,
        response.status,
      );
    }
    const envelope = parseEnvelope(payload);
    return record(envelope.result ?? {});
  }

  async connect(signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.request("/v1/desktop/connect", {}, signal);
    return typeof result["conversationId"] === "string" ? result["conversationId"] : undefined;
  }

  async uploadImage(
    conversationId: string,
    input: { mime: ImageMeta["mime"]; displayName: string; body: Uint8Array },
  ): Promise<ImageMeta> {
    const result = await this.request("/v1/desktop/attachments", {
      conversationId,
      mime: input.mime,
      displayName: input.displayName,
      dataBase64: Buffer.from(input.body).toString("base64"),
    });
    return parseImageMeta(result["image"]);
  }

  async downloadImage(conversationId: string, image: ImageMeta): Promise<Uint8Array> {
    if (image.downloadUrl === undefined) throw new DesktopTransportError("image_url_missing", "image download URL is missing", 502);
    const response = await this.fetchImpl(new URL(image.downloadUrl.replace(/^\/+/, ""), `${this.hubUrl}/`), {
      headers: {
        "x-workspace-id": this.config.workspaceId,
        "x-internal-key": this.config.internalKey,
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw new DesktopTransportError("image_download_failed", `Hub returned ${String(response.status)}`, response.status);
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength !== image.bytes) throw new DesktopTransportError("image_size_mismatch", "image size does not match metadata", 502);
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== image.sha256.toLowerCase()) throw new DesktopTransportError("image_hash_mismatch", "image sha256 does not match metadata", 502);
    return body;
  }

  async sendMessage(
    conversationId: string,
    text: string,
    images: ImageMeta[] = [],
    messageId: string = `msg_${randomUUID().replaceAll("-", "")}`,
  ): Promise<number> {
    const result = await this.request("/v1/desktop/messages", { conversationId, messageId, text, images });
    const sequence = result["sequence"];
    if (typeof sequence !== "number") throw new DesktopTransportError("bad_response", "message sequence is missing", 502);
    return sequence;
  }

  async listResponses(conversationId: string, after = ""): Promise<ChatResponse[]> {
    const result = await this.request("/v1/desktop/responses", { conversationId, after });
    const responses = result["responses"];
    if (!Array.isArray(responses)) throw new DesktopTransportError("bad_response", "responses must be an array", 502);
    return responses.map(chatResponse);
  }

  async nextCapability(conversationId: string): Promise<CapabilityRequest | undefined> {
    const result = await this.request("/v1/desktop/capability/next", { conversationId });
    return result["capability"] === undefined ? undefined : parseCapabilityRequest(result["capability"]);
  }

  async completeCapability(
    conversationId: string,
    request: CapabilityRequest,
    outcome: { ok: true; value: unknown } | { ok: false; code: string; message: string },
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const result: CapabilityResult = outcome.ok
      ? { requestId: request.requestId, conversationId, ok: true, value: outcome.value, completedAt }
      : { requestId: request.requestId, conversationId, ok: false, code: outcome.code, message: outcome.message, completedAt };
    await this.request("/v1/desktop/capability/result", { conversationId, result });
  }

  async presence(conversationId: string, presence: DesktopPresence): Promise<void> {
    await this.request("/v1/desktop/presence", { conversationId, ...presence });
  }

  async run(handlers: DesktopTransportHandlers, signal: AbortSignal): Promise<void> {
    let conversationId: string | undefined;
    let responseAfter = "";
    let lastPresenceAt = 0;
    let connected = false;
    const inflight = new Map<string, Promise<void>>();
    while (!signal.aborted) {
      try {
        if (conversationId === undefined) {
          conversationId = await this.connect(signal);
          if (conversationId === undefined) { await wait(this.pollMs, signal); continue; }
          handlers.onConversation?.(conversationId);
          responseAfter = "";
        }

        const responses = await this.listResponses(conversationId, responseAfter);
        if (!connected) {
          connected = true;
          handlers.onTransportState?.(true, conversationId);
        }
        for (const response of responses) {
          await handlers.onResponse(response);
          responseAfter = response.responseId;
        }

        const capability = await this.nextCapability(conversationId);
        if (capability !== undefined && !inflight.has(capability.requestId)) {
          const task = (async () => {
            let outcome: { ok: true; value: unknown } | { ok: false; code: string; message: string };
            try {
              outcome = await handlers.onCapability(capability);
            } catch (error) {
              outcome = { ok: false, code: "desktop_capability_error", message: error instanceof Error ? error.message : String(error) };
            }
            await this.completeCapability(conversationId!, capability, outcome);
          })().finally(() => inflight.delete(capability.requestId));
          inflight.set(capability.requestId, task);
        }

        if (Date.now() - lastPresenceAt >= 15_000) {
          await this.presence(conversationId, {
            transportConnected: true,
            desktopReady: true,
            agentListening: false,
            agentWorking: false,
            agentStalled: false,
            conversationClosed: false,
            state: "listening",
          });
          lastPresenceAt = Date.now();
        }
        if (responses.length === 0 && capability === undefined) await wait(this.pollMs, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (connected) {
          connected = false;
          handlers.onTransportState?.(false, conversationId);
        }
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
        if (error instanceof DesktopTransportError && error.code === "conversation_not_found") {
          conversationId = undefined;
        }
        await wait(Math.min(5_000, this.pollMs * 4), signal);
      }
    }
    await Promise.allSettled(inflight.values());
  }
}
