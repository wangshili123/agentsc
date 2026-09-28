import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  createEnvelope,
  parseImageMeta,
  type CapabilityName,
  type CapabilityResult,
  type Delivery,
  type ImageMeta,
  type PresenceState,
  type RuntimeConfig
} from "@agent-transport/protocol";
import { HubStore, type PresenceSnapshot } from "./store.js";

interface JsonObject {
  [key: string]: unknown;
}

export interface HubServerOptions {
  config: RuntimeConfig;
  databasePath?: string;
  store?: HubStore;
}

export interface HubApplication {
  server: Server;
  store: HubStore;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

interface ActiveWaiter {
  waiterId: string;
  startedAt: number;
}

const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const READ_ONLY_CAPABILITIES = new Set<string>([
  "context.get", "chat.wait", "fs.read", "fs.list", "fs.glob", "fs.grep", "process.resume", "plan.get", "task.listAvailable", "task.wait",
]);
const IMAGE_MIME_SET = new Set<ImageMeta["mime"]>(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PRESENCE_STATES = new Set<PresenceState>([
  "listening",
  "working",
  "stalled",
  "offline",
  "closed"
]);

function objectValue(value: unknown, label = "body"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", `${label} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new HttpError(400, "invalid_request", `${label} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function numberValue(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_request", `${label} must be a number`);
  }
  return value;
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `${label} must be a boolean`);
  }
  return value;
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestId(body: JsonObject): string {
  return optionalString(body.requestId, "requestId") ?? `req_${randomUUID().replaceAll("-", "")}`;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  return authorization.slice("Bearer ".length);
}

function attachmentInput(body: JsonObject, config: RuntimeConfig): {
  mime: ImageMeta["mime"];
  displayName: string;
  data: Buffer;
} {
  const mime = stringValue(body.mime, "mime") as ImageMeta["mime"];
  if (!IMAGE_MIME_SET.has(mime)) throw new HttpError(415, "image_mime_denied", "image MIME is not supported");
  const displayName = stringValue(body.displayName, "displayName");
  if (displayName.length > 256) throw new HttpError(400, "invalid_request", "displayName is too long");
  const encoded = stringValue(body.dataBase64, "dataBase64");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new HttpError(400, "invalid_base64", "image data is not valid base64");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.length === 0 || data.length > config.maxImageBytes) {
    throw new HttpError(413, "image_too_large", "image exceeds configured byte limit");
  }
  return { mime, displayName, data };
}

function readImages(value: unknown, config: RuntimeConfig): ReturnType<typeof parseImageMeta>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "images must be an array");
  }
  if (value.length > config.maxImagesPerMessage) {
    throw new HttpError(413, "images_limit_exceeded", "too many images");
  }
  let images: ReturnType<typeof parseImageMeta>[];
  try {
    images = value.map(parseImageMeta);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new HttpError(400, error.code, error.message);
    }
    throw error;
  }
  if (images.some((image) => image.bytes > config.maxImageBytes)) {
    throw new HttpError(413, "image_too_large", "image metadata exceeds configured byte limit");
  }
  return images;
}

async function readJson(request: IncomingMessage, maxBytes = 1_048_576): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new HttpError(413, "body_too_large", "request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return objectValue(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const json = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store"
  });
  response.end(json);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ProtocolValidationError) {
    return new HttpError(400, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : "internal error";
  const known: Record<string, [number, string]> = {
    conversation_not_found: [404, "conversation_not_found"],
    delivery_not_found: [404, "delivery_not_found"],
    capability_request_not_found: [404, "capability_request_not_found"],
    response_id_conflict: [409, "response_id_conflict"],
    capability_request_conflict: [409, "capability_request_conflict"],
    response_cursor_not_found: [409, "response_cursor_not_found"],
    message_id_conflict: [409, "message_id_conflict"]
  };
  const mapped = known[message];
  return mapped === undefined
    ? new HttpError(500, "internal_error", message)
    : new HttpError(mapped[0], mapped[1], message);
}

function envelope(
  kind: string,
  id: string,
  result: unknown,
  conversationId?: string,
  inbox: Delivery[] = [],
  cursor?: string,
  presence?: PresenceState
): unknown {
  return createEnvelope({
    requestId: id,
    kind,
    result,
    inbox,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(presence === undefined ? {} : { presence })
  });
}

export function createHubServer(options: HubServerOptions): HubApplication {
  const { config } = options;
  const store = options.store ?? new HubStore(options.databasePath ?? ":memory:");
  const waiters = new Map<string, ActiveWaiter>();

  function requireInternalAuth(body: JsonObject, request: IncomingMessage): void {
    const workspaceId = typeof request.headers["x-workspace-id"] === "string"
      ? request.headers["x-workspace-id"]
      : optionalString(body.workspaceId, "workspaceId");
    const internalKey = typeof request.headers["x-internal-key"] === "string"
      ? request.headers["x-internal-key"]
      : optionalString(body.internalKey, "internalKey");
    if (
      workspaceId === undefined ||
      internalKey === undefined ||
      !safeEqual(workspaceId, config.workspaceId) ||
      !safeEqual(internalKey, config.internalKey)
    ) {
      throw new HttpError(401, "unauthorized", "workspace credentials are invalid");
    }
  }

  function requireAgent(
    body: JsonObject,
    request: IncomingMessage
  ): { conversationId: string; requestId: string } {
    const conversationId = stringValue(body.conversationId, "conversationId");
    const token = bearerToken(request);
    if (token === undefined || store.authenticate(conversationId, token) === undefined) {
      throw new HttpError(401, "auth_expired", "resume token is invalid or expired");
    }
    if (!store.assertTransport(conversationId, "transport")) {
      throw new HttpError(409, "transport_conflict", "conversation belongs to another transport");
    }
    return { conversationId, requestId: requestId(body) };
  }

  function assertWorkspaceConversation(conversationId: string): void {
    const conversation = store.getConversation(conversationId);
    if (conversation === undefined || conversation.workspaceId !== config.workspaceId || conversation.closed) {
      throw new HttpError(404, "conversation_not_found", "conversation was not found");
    }
  }

  async function waitForDelivery(
    conversationId: string,
    timeoutMs: number,
    request: IncomingMessage
  ): Promise<Delivery | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const delivery = store.claimDelivery(conversationId);
      if (delivery !== undefined) return delivery;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
    return undefined;
  }

  function claimInbox(conversationId: string): Delivery[] {
    const deliveries: Delivery[] = [];
    while (deliveries.length < config.maxInboxPerResult) {
      const delivery = store.claimDelivery(conversationId);
      if (delivery === undefined) break;
      deliveries.push(delivery);
    }
    return deliveries;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://hub.local");
    if (request.method === "GET" && url.pathname === "/healthz") {
      send(response, 200, { ok: true, version: PROTOCOL_VERSION });
      return;
    }
    const imageMatch = /^\/v1\/agent\/images\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (request.method === "GET" && imageMatch !== null) {
      const conversationId = url.searchParams.get("conversationId") ?? "";
      const token = bearerToken(request);
      const workspaceHeader = typeof request.headers["x-workspace-id"] === "string" ? request.headers["x-workspace-id"] : "";
      const keyHeader = typeof request.headers["x-internal-key"] === "string" ? request.headers["x-internal-key"] : "";
      const agentAuthorized = token !== undefined && store.authenticate(conversationId, token) !== undefined;
      const desktopAuthorized = safeEqual(workspaceHeader, config.workspaceId) && safeEqual(keyHeader, config.internalKey);
      if (conversationId === "" || (!agentAuthorized && !desktopAuthorized)) {
        throw new HttpError(401, "auth_expired", "image authorization is invalid");
      }
      const attachment = store.getAttachment(conversationId, imageMatch[1] ?? "");
      if (attachment === undefined) throw new HttpError(404, "image_not_found", "image was not found or expired");
      response.writeHead(200, {
        "content-type": attachment.meta.mime,
        "content-length": attachment.body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(attachment.body);
      return;
    }
    if (request.method !== "POST") {
      throw new HttpError(404, "route_not_found", "route was not found");
    }

    const uploadLimit = Math.ceil(config.maxImageBytes * 4 / 3) + 65_536;
    const body = await readJson(request, url.pathname.endsWith("/attachments") ? Math.max(1_048_576, uploadLimit) : 1_048_576);

    if (url.pathname === "/v1/agent/register") {
      requireInternalAuth(body, request);
      const registration = store.register({
        workspaceId: stringValue(body.workspaceId, "workspaceId"),
        model: stringValue(body.model, "model"),
        workspaceFingerprint: stringValue(body.workspaceFingerprint, "workspaceFingerprint")
      });
      send(
        response,
        201,
        envelope(
          "ready",
          requestId(body),
          {
            ok: true,
            conversationId: registration.conversationId,
            resumeToken: registration.resumeToken,
            model: registration.model,
            next: "/v1/agent/wait"
          },
          registration.conversationId,
          [],
          "cur_-1",
          "listening"
        )
      );
      return;
    }

    if (url.pathname === "/v1/agent/resume") {
      const id = requestId(body);
      const conversationId = stringValue(body.conversationId, "conversationId");
      const resumed = store.resume({
        conversationId,
        resumeToken: stringValue(body.resumeToken, "resumeToken"),
        workspaceFingerprint: stringValue(body.workspaceFingerprint, "workspaceFingerprint")
      });
      if (resumed === undefined) throw new HttpError(401, "registration_required", "resume failed");
      send(response, 200, envelope("ready", id, { ok: true, conversation: resumed }, conversationId));
      return;
    }

    if (url.pathname.startsWith("/v1/agent/")) {
      const auth = requireAgent(body, request);
      const { conversationId, requestId: id } = auth;

      if (url.pathname === "/v1/agent/attachments") {
        const attachment = attachmentInput(body, config);
        const stored = store.putAttachment({ conversationId, mime: attachment.mime, displayName: attachment.displayName, body: attachment.data });
        send(response, 201, envelope("attachment", id, { ok: true, image: stored.meta }, conversationId));
        return;
      }

      if (url.pathname === "/v1/agent/wait") {
        if (waiters.has(conversationId)) {
          send(
            response,
            409,
            envelope(
              "conflict",
              id,
              { ok: false, code: "another_waiter", reason: "another_waiter" },
              conversationId
            )
          );
          return;
        }
        const waiterId = randomUUID();
        waiters.set(conversationId, { waiterId, startedAt: Date.now() });
        store.recordPresence(conversationId, {
          transportConnected: true,
          desktopReady: store.getPresence(conversationId)?.desktopReady ?? false,
          agentListening: true,
          agentWorking: false,
          agentStalled: false,
          conversationClosed: false,
          state: "listening"
        });
        try {
          const timeoutMs = Math.max(0, Math.min(30_000, numberValue(body.timeoutMs, "timeoutMs", 30_000)));
          const delivery = await waitForDelivery(conversationId, timeoutMs, request);
          if (delivery === undefined) {
            send(
              response,
              200,
              envelope("idle", id, { ok: true, waitedMs: timeoutMs }, conversationId, [], optionalString(body.cursor, "cursor") ?? "cur_-1", "listening")
            );
          } else {
            send(
              response,
              200,
              envelope("delivery", id, delivery, conversationId, [delivery], `cur_${delivery.sequence}`, "working")
            );
          }
        } finally {
          if (waiters.get(conversationId)?.waiterId === waiterId) waiters.delete(conversationId);
        }
        return;
      }

      if (url.pathname === "/v1/agent/reply") {
        const routed = store.reply({
          conversationId,
          deliveryId: stringValue(body.deliveryId, "deliveryId"),
          responseId: stringValue(body.responseId, "responseId"),
          text: stringValue(body.text, "text", true),
          images: readImages(body.images, config)
        });
        send(response, 200, envelope("reply", id, { ok: true, acknowledged: true, ...routed }, conversationId, claimInbox(conversationId)));
        return;
      }

      if (url.pathname === "/v1/agent/ack") {
        const acknowledged = store.acknowledge(conversationId, stringValue(body.deliveryId, "deliveryId"));
        if (!acknowledged) throw new HttpError(404, "delivery_not_found", "delivery was not found");
        send(response, 200, envelope("ack", id, { ok: true, acknowledged: true }, conversationId, claimInbox(conversationId)));
        return;
      }

      if (url.pathname === "/v1/agent/capability") {
        const name = stringValue(body.name, "name");
        if (!CAPABILITY_SET.has(name)) {
          throw new HttpError(400, "unsupported_capability", `unsupported capability: ${name}`);
        }
        if (name === "chat.stop") {
          store.closeConversation(conversationId);
          send(response, 200, envelope("stop", id, { ok: true, reason: "conversation_closed" }, conversationId));
          return;
        }
        const pendingInbox = claimInbox(conversationId);
        if (!READ_ONLY_CAPABILITIES.has(name) && pendingInbox.length > 0) {
          send(response, 409, envelope(
            "capability_result",
            id,
            { ok: false, code: "message_pending", message: "a user message arrived before the change was executed" },
            conversationId,
            pendingInbox,
          ));
          return;
        }
        const routed = store.routeCapability({
          conversationId,
          requestId: stringValue(body.requestId, "requestId"),
          name: name as CapabilityName,
          args: body.args ?? {}
        });
        send(response, routed.result === undefined ? 202 : 200, envelope(
          "capability",
          id,
          { ok: true, ...routed },
          conversationId,
          [...pendingInbox, ...claimInbox(conversationId)].slice(0, config.maxInboxPerResult),
        ));
        return;
      }

      if (url.pathname === "/v1/agent/capability/result") {
        const capabilityId = stringValue(body.capabilityRequestId ?? body.requestId, "requestId");
        const routed = store.getCapability(capabilityId);
        if (routed === undefined || routed.request.conversationId !== conversationId) {
          throw new HttpError(404, "capability_request_not_found", "capability request was not found");
        }
        send(response, routed.result === undefined ? 202 : 200, envelope(
          "capability_result",
          id,
          { ok: true, ...routed },
          conversationId,
          claimInbox(conversationId),
        ));
        return;
      }

      if (url.pathname === "/v1/agent/presence") {
        const snapshot = parsePresence(body, store.getPresence(conversationId));
        const recorded = store.recordPresence(conversationId, snapshot);
        send(response, 200, envelope("presence", id, { ok: true, presence: recorded }, conversationId, [], undefined, recorded.state));
        return;
      }
    }

    if (url.pathname.startsWith("/v1/desktop/")) {
      requireInternalAuth(body, request);
      const id = requestId(body);

      if (url.pathname === "/v1/desktop/attachments") {
        const conversationId = stringValue(body.conversationId, "conversationId");
        assertWorkspaceConversation(conversationId);
        const attachment = attachmentInput(body, config);
        const stored = store.putAttachment({ conversationId, mime: attachment.mime, displayName: attachment.displayName, body: attachment.data });
        send(response, 201, envelope("attachment", id, { ok: true, image: stored.meta }, conversationId));
        return;
      }

      if (url.pathname === "/v1/desktop/connect") {
        const conversation = store.latestOpenConversation(config.workspaceId);
        send(response, 200, envelope(
          "desktop_connect",
          id,
          { ok: true, conversationId: conversation?.conversationId },
          conversation?.conversationId,
        ));
        return;
      }

      const conversationId = stringValue(body.conversationId, "conversationId");
      assertWorkspaceConversation(conversationId);

      if (url.pathname === "/v1/desktop/messages") {
        const queued = store.enqueueMessage({
          conversationId,
          ...(body.messageId === undefined ? {} : { messageId: stringValue(body.messageId, "messageId") }),
          text: stringValue(body.text, "text", true),
          images: readImages(body.images, config)
        });
        send(response, 201, envelope("message_queued", id, { ok: true, sequence: queued.sequence }, conversationId, [], `cur_${queued.sequence}`));
        return;
      }

      if (url.pathname === "/v1/desktop/responses") {
        const responses = store.listResponses(
          conversationId,
          body.after === undefined ? "" : stringValue(body.after, "after", true),
        );
        send(response, 200, envelope("responses", id, { ok: true, responses }, conversationId));
        return;
      }

      if (url.pathname === "/v1/desktop/capability/next") {
        const claimed = store.claimCapability(conversationId);
        const capability = claimed === undefined ? undefined : { ...claimed, capability: claimed.name };
        send(response, 200, envelope("capability_request", id, { ok: true, capability }, conversationId));
        return;
      }

      if (url.pathname === "/v1/desktop/capability/result") {
        const raw = objectValue(body.result, "result");
        const result: CapabilityResult = raw.ok === true
          ? {
              requestId: stringValue(raw.requestId, "result.requestId"),
              conversationId,
              ok: true,
              value: raw.value,
              completedAt: optionalString(raw.completedAt, "result.completedAt") ?? new Date().toISOString()
            }
          : {
              requestId: stringValue(raw.requestId, "result.requestId"),
              conversationId,
              ok: false,
              code: stringValue(raw.code, "result.code"),
              message: stringValue(raw.message, "result.message"),
              completedAt: optionalString(raw.completedAt, "result.completedAt") ?? new Date().toISOString()
            };
        const routed = store.completeCapability(result);
        send(response, 200, envelope("capability_result", id, { ok: true, ...routed }, conversationId));
        return;
      }

      if (url.pathname === "/v1/desktop/presence") {
        const snapshot = parsePresence(body, store.getPresence(conversationId));
        const recorded = store.recordPresence(conversationId, snapshot);
        send(response, 200, envelope("presence", id, { ok: true, presence: recorded }, conversationId, [], undefined, recorded.state));
        return;
      }
    }

    throw new HttpError(404, "route_not_found", "route was not found");
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const httpError = normalizeError(error);
      const expired = httpError.code === "auth_expired" || httpError.code === "registration_required";
      send(
        response,
        httpError.status,
        envelope(
          expired ? "auth_expired" : "error",
          `req_${randomUUID().replaceAll("-", "")}`,
          {
            ok: false,
            code: httpError.code,
            message: httpError.message,
            ...(expired ? { action: "register_again" } : {}),
          }
        )
      );
    });
  });

  return {
    server,
    store,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.listenPort, config.listenHost, () => {
          server.off("error", reject);
          const address = server.address();
          resolve({
            host: typeof address === "object" && address !== null ? address.address : config.listenHost,
            port: typeof address === "object" && address !== null ? address.port : config.listenPort
          });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else {
            store.close();
            resolve();
          }
        });
      })
  };
}

function parsePresence(
  body: JsonObject,
  previous: PresenceSnapshot | undefined
): Omit<PresenceSnapshot, "createdAt"> {
  const stateValue = optionalString(body.state, "state") ?? previous?.state ?? "offline";
  if (!PRESENCE_STATES.has(stateValue as PresenceState)) {
    throw new HttpError(400, "invalid_request", "state is invalid");
  }
  return {
    transportConnected: booleanValue(body.transportConnected, "transportConnected", previous?.transportConnected ?? false),
    desktopReady: booleanValue(body.desktopReady, "desktopReady", previous?.desktopReady ?? false),
    agentListening: booleanValue(body.agentListening, "agentListening", previous?.agentListening ?? false),
    agentWorking: booleanValue(body.agentWorking, "agentWorking", previous?.agentWorking ?? false),
    agentStalled: booleanValue(body.agentStalled, "agentStalled", previous?.agentStalled ?? false),
    conversationClosed: booleanValue(body.conversationClosed, "conversationClosed", previous?.conversationClosed ?? false),
    state: stateValue as PresenceState
  };
}
