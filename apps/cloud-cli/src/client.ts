import { randomUUID } from "node:crypto";
import { parseEnvelope as parseProtocolEnvelope, parseImageMeta } from "@agent-transport/protocol";
import type {
  AgentEnvelope,
  Delivery,
  RegisterResponse,
  ResumeResponse,
  RuntimeConfig,
  SessionState,
  WaitResponse,
} from "./types.js";
import { isRecord, numberOf, stringOf } from "./types.js";

export class HubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "HubError";
  }
}

function parseImage(value: unknown) {
  try {
    return parseImageMeta(value);
  } catch (error) {
    throw new HubError("bad_response", error instanceof Error ? error.message : "image metadata is invalid", 502, value);
  }
}

export function parseDelivery(value: unknown): Delivery {
  if (!isRecord(value)) throw new HubError("bad_response", "delivery must be an object", 502);
  const sequence = numberOf(value, "sequence");
  const deliveryId = stringOf(value, "deliveryId");
  const text = typeof value["text"] === "string" ? value["text"] : "";
  const rawImages = value["images"];
  if (sequence === undefined || deliveryId === undefined || !Number.isInteger(sequence) || sequence < 0) {
    throw new HubError("bad_response", "delivery identity is invalid", 502);
  }
  if (!Array.isArray(rawImages)) throw new HubError("bad_response", "delivery images must be an array", 502);
  const createdAt = stringOf(value, "createdAt");
  if (createdAt === undefined) throw new HubError("bad_response", "delivery createdAt is missing", 502);
  return {
    sequence,
    deliveryId,
    text,
    images: rawImages.map(parseImage),
    createdAt,
  };
}

function parseDeliveries(value: unknown): Delivery[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HubError("bad_response", "inbox must be an array", 502);
  return value.map(parseDelivery).sort((a, b) => a.sequence - b.sequence);
}

export interface RequestOptions {
  timeoutMs?: number;
  token?: string;
  signal?: AbortSignal;
}

export class HubClient {
  constructor(
    readonly config: RuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.hubUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const code = error instanceof Error && error.name === "TimeoutError" ? "hub_timeout" : "hub_unreachable";
      throw new HubError(code, error instanceof Error ? error.message : String(error), 0);
    }
    const text = await response.text();
    let payload: unknown;
    try { payload = text === "" ? {} : JSON.parse(text); }
    catch { throw new HubError("bad_response", "Hub returned non-JSON content", response.status, text); }
    if (!response.ok) {
      const record = isRecord(payload) ? payload : {};
      const detail = isRecord(record["result"]) ? record["result"] : record;
      throw new HubError(
        stringOf(detail, "code") ?? "hub_error",
        stringOf(detail, "message") ?? stringOf(detail, "reason") ?? `Hub returned ${String(response.status)}`,
        response.status,
        payload,
      );
    }
    return payload;
  }

  async register(model: string, workspaceFingerprint: string): Promise<RegisterResponse> {
    const value = await this.request("/v1/agent/register", {
      workspaceId: this.config.workspaceId,
      internalKey: this.config.internalKey,
      model,
      workspaceFingerprint,
    });
    if (!isRecord(value)) throw new HubError("bad_response", "register response must be an object", 502);
    const result = isRecord(value["result"]) ? value["result"] : value;
    const conversationId = stringOf(result, "conversationId");
    const resumeToken = stringOf(result, "resumeToken");
    if (conversationId === undefined || resumeToken === undefined) {
      throw new HubError("bad_response", "register response is incomplete", 502);
    }
    return { conversationId, resumeToken, ...(stringOf(value, "cursor") === undefined ? {} : { cursor: stringOf(value, "cursor") }) } as RegisterResponse;
  }

  async resume(state: SessionState): Promise<ResumeResponse> {
    const value = await this.request("/v1/agent/resume", {
      conversationId: state.conversationId,
      workspaceId: state.workspaceId,
      workspaceFingerprint: state.workspaceFingerprint,
      resumeToken: state.resumeToken,
    }, { token: state.resumeToken });
    if (!isRecord(value)) throw new HubError("bad_response", "resume response must be an object", 502);
    const result = isRecord(value["result"]) ? value["result"] : value;
    return {
      ok: result["ok"] === true,
      ...(stringOf(value, "cursor") === undefined ? {} : { cursor: stringOf(value, "cursor") }),
      ...(stringOf(result, "reason") === undefined ? {} : { reason: stringOf(result, "reason") }),
    } as ResumeResponse;
  }

  async wait(state: SessionState, timeoutMs: number, signal?: AbortSignal): Promise<WaitResponse> {
    let value: unknown;
    try {
      value = await this.request("/v1/agent/wait", {
        conversationId: state.conversationId,
        cursor: state.cursor,
        timeoutMs,
      }, { token: state.resumeToken, timeoutMs: timeoutMs + 5_000, ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (!(error instanceof HubError) || !isRecord(error.body) || stringOf(error.body, "kind") === undefined) throw error;
      value = error.body;
    }
    if (!isRecord(value)) throw new HubError("bad_response", "wait response must be an object", 502);
    const kind = stringOf(value, "kind");
    if (kind !== "delivery" && kind !== "idle" && kind !== "conflict" && kind !== "auth_expired" && kind !== "stop") {
      throw new HubError("bad_response", "wait response kind is invalid", 502);
    }
    const result = isRecord(value["result"]) ? value["result"] : value;
    const deliveryValue = value["delivery"] ?? (kind === "delivery" ? result : undefined);
    const delivery = deliveryValue === undefined ? undefined : parseDelivery(deliveryValue);
    return {
      kind,
      ...(delivery === undefined ? {} : { delivery }),
      inbox: parseDeliveries(value["inbox"]),
      ...(stringOf(value, "cursor") === undefined ? {} : { cursor: stringOf(value, "cursor") }),
      ...(stringOf(result, "action") === undefined ? {} : { action: stringOf(result, "action") }),
      ...(stringOf(result, "reason") === undefined ? {} : { reason: stringOf(result, "reason") }),
    } as WaitResponse;
  }

  async uploadImage(
    state: SessionState,
    input: { mime: string; displayName: string; body: Uint8Array },
  ) {
    const value = await this.request("/v1/agent/attachments", {
      conversationId: state.conversationId,
      mime: input.mime,
      displayName: input.displayName,
      dataBase64: Buffer.from(input.body).toString("base64"),
    }, { token: state.resumeToken, timeoutMs: 30_000 });
    if (!isRecord(value)) throw new HubError("bad_response", "attachment response must be an object", 502);
    const result = isRecord(value["result"]) ? value["result"] : value;
    return parseImage(result["image"]);
  }

  async reply(state: SessionState, input: { deliveryId: string; text: string; images?: unknown[]; responseId?: string }): Promise<AgentEnvelope> {
    const value = await this.request("/v1/agent/reply", {
      conversationId: state.conversationId,
      deliveryId: input.deliveryId,
      responseId: input.responseId ?? randomUUID(),
      text: input.text,
      images: input.images ?? [],
      cursor: state.cursor,
    }, { token: state.resumeToken, timeoutMs: 30_000 });
    return this.parseEnvelope(value, "reply_result");
  }

  async ack(state: SessionState, deliveryId: string): Promise<AgentEnvelope> {
    const value = await this.request("/v1/agent/ack", {
      conversationId: state.conversationId,
      deliveryId,
      cursor: state.cursor,
    }, { token: state.resumeToken });
    return this.parseEnvelope(value, "ack_result");
  }

  async capability(state: SessionState, name: string, args: unknown, requestId: string = randomUUID()): Promise<AgentEnvelope> {
    let value: unknown;
    try {
      value = await this.request("/v1/agent/capability", {
        conversationId: state.conversationId,
        requestId,
        name,
        args,
        cursor: state.cursor,
      }, { token: state.resumeToken, timeoutMs: 15_000 });
    } catch (error) {
      if (!(error instanceof HubError) || !isRecord(error.body) || stringOf(error.body, "kind") === undefined) throw error;
      return this.parseEnvelope(error.body, "capability_result");
    }
    let envelope = this.parseEnvelope(value, "capability_result");
    if (envelope.kind === "stop") return envelope;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const routed: Record<string, unknown> = isRecord(envelope.result) ? envelope.result : {};
      if (routed["ok"] === false) return envelope;
      if ((envelope.inbox?.length ?? 0) > 0 && routed["result"] === undefined) {
        return {
          ...envelope,
          kind: "capability_result",
          result: {
            ok: false,
            code: name.startsWith("process.") ? "process_yielded" : "capability_pending",
            message: "a user message arrived while the capability is still running",
            requestId,
            pending: true,
          },
        };
      }
      if (routed["result"] !== undefined) {
        const completed = isRecord(routed["result"])
          ? routed["result"] as NonNullable<AgentEnvelope["result"]>
          : { ok: true, value: routed["result"] };
        return { ...envelope, kind: "capability_result", result: completed };
      }
      if (Date.now() >= deadline) {
        return {
          ...envelope,
          kind: "capability_result",
          result: { ok: false, code: "capability_timeout", message: "desktop capability did not finish within 60 seconds", requestId },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      value = await this.request("/v1/agent/capability/result", {
        conversationId: state.conversationId,
        requestId,
        cursor: state.cursor,
      }, { token: state.resumeToken, timeoutMs: 15_000 });
      envelope = this.parseEnvelope(value, "capability_result");
    }
  }

  parseEnvelope(value: unknown, fallbackKind: AgentEnvelope["kind"]): AgentEnvelope {
    let parsed;
    try {
      parsed = parseProtocolEnvelope(value);
    } catch (error) {
      throw new HubError("bad_response", error instanceof Error ? error.message : "envelope is invalid", 502, value);
    }
    const normalizedKind = parsed.kind === "reply"
      ? "reply_result"
      : parsed.kind === "ack"
        ? "ack_result"
        : parsed.kind === "capability"
          ? "capability_result"
          : parsed.kind;
    const result = isRecord(parsed.result) ? parsed.result as NonNullable<AgentEnvelope["result"]> : undefined;
    return {
      version: 1,
      kind: (normalizedKind || fallbackKind) as AgentEnvelope["kind"],
      ...(parsed.conversationId === undefined ? {} : { conversationId: parsed.conversationId }),
      ...(result === undefined ? {} : { result }),
      inbox: parsed.inbox,
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.presence === undefined ? {} : { presence: parsed.presence }),
      ...(result === undefined || typeof result["reason"] !== "string" ? {} : { reason: result["reason"] }),
      ...(result === undefined || typeof result["action"] !== "string" ? {} : { action: result["action"] }),
    };
  }
}
