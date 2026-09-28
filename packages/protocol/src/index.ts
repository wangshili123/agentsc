export const PROTOCOL_VERSION = 1 as const;

export const CAPABILITIES = [
  "context.get",
  "model.register",
  "chat.wait",
  "chat.reply",
  "chat.ack",
  "chat.stop",
  "activity.note",
  "fs.read",
  "fs.list",
  "fs.glob",
  "fs.grep",
  "fs.write",
  "fs.edit",
  "fs.delete",
  "fs.move",
  "process.exec",
  "process.resume",
  "process.cancel",
  "plan.submit",
  "plan.update",
  "plan.get",
  "task.listAvailable",
  "task.dispatch",
  "task.wait",
  "task.progress",
  "task.result",
  "task.ask",
  "task.answer",
  "task.message",
  "task.cancel"
] as const;

export type CapabilityName = (typeof CAPABILITIES)[number];
export type ClientMode = "transport" | "legacy";
export type ParticipantRole = "cloud" | "desktop";
export type PresenceState = "listening" | "working" | "stalled" | "offline" | "closed";
export type TransportMode = "transport" | "legacy";

export interface RuntimeConfig {
  hubUrl: string;
  listenHost: string;
  listenPort: number;
  workspaceId: string;
  internalKey: string;
  keyId: string;
  stateDir: string;
  dataDir: string;
  idleReturnMs: number;
  httpPollMs: number;
  maxInboxPerResult: number;
  maxImageBytes: number;
  maxImagesPerMessage: number;
  commandOutputSliceBytes: number;
  commandPollMs: number;
  clientMode: ClientMode;
  legacyFallback: boolean;
}

export interface ImageMeta {
  id: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  sha256: string;
  displayName: string;
  downloadUrl?: string;
}

export interface Delivery {
  deliveryId: string;
  sequence: number;
  text: string;
  images: ImageMeta[];
  createdAt: string;
  visibleUntil?: string;
}

export interface Response {
  responseId: string;
  deliveryId: string;
  text: string;
  images: ImageMeta[];
  createdAt: string;
}

export interface CapabilityRequest<TArgs = unknown> {
  requestId: string;
  conversationId: string;
  capability: CapabilityName;
  args: TArgs;
  createdAt: string;
  expiresAt: string;
}

export type CapabilityResult<TValue = unknown> =
  | {
      requestId: string;
      conversationId: string;
      ok: true;
      value: TValue;
      completedAt: string;
    }
  | {
      requestId: string;
      conversationId: string;
      ok: false;
      code: string;
      message: string;
      completedAt: string;
    };

export interface Envelope<TResult = unknown> {
  version: typeof PROTOCOL_VERSION;
  requestId: string;
  conversationId?: string;
  kind: string;
  result?: TResult;
  inbox: Delivery[];
  cursor?: string;
  presence?: PresenceState;
}

export class ProtocolValidationError extends Error {
  readonly code = "invalid_protocol_payload";

  constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

const DEFAULTS = {
  listenHost: "0.0.0.0",
  listenPort: 47420,
  keyId: "primary",
  stateDir: "~/.agent-transport",
  dataDir: "./data",
  idleReturnMs: 570_000,
  httpPollMs: 30_000,
  maxInboxPerResult: 10,
  maxImageBytes: 8_388_608,
  maxImagesPerMessage: 8,
  commandOutputSliceBytes: 65_536,
  commandPollMs: 3_000,
  clientMode: "transport" as ClientMode,
  legacyFallback: true
};

const IMAGE_MIMES = new Set<ImageMeta["mime"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);
const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const PRESENCE_SET = new Set<PresenceState>([
  "listening",
  "working",
  "stalled",
  "offline",
  "closed"
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new ProtocolValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function integerValue(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new ProtocolValidationError(`${label} must be an integer >= ${min}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolValidationError(`${label} must be a boolean`);
  }
  return value;
}

function configuredString(
  source: Record<string, unknown>,
  key: string,
  fallback?: string
): string {
  const value = source[key] ?? fallback;
  return stringValue(value, key);
}

function configuredInteger(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min = 1
): number {
  return integerValue(source[key] ?? fallback, key, min);
}

export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  const source = record(input, "runtime config");
  const hubUrl = configuredString(source, "hubUrl");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(hubUrl);
  } catch {
    throw new ProtocolValidationError("hubUrl must be an absolute URL");
  }
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
    throw new ProtocolValidationError("hubUrl must use http or https");
  }

  const mode = source.clientMode ?? DEFAULTS.clientMode;
  if (mode !== "transport" && mode !== "legacy") {
    throw new ProtocolValidationError("clientMode must be transport or legacy");
  }

  return {
    hubUrl,
    listenHost: configuredString(source, "listenHost", DEFAULTS.listenHost),
    listenPort: configuredInteger(source, "listenPort", DEFAULTS.listenPort),
    workspaceId: configuredString(source, "workspaceId"),
    internalKey: configuredString(source, "internalKey"),
    keyId: configuredString(source, "keyId", DEFAULTS.keyId),
    stateDir: configuredString(source, "stateDir", DEFAULTS.stateDir),
    dataDir: configuredString(source, "dataDir", DEFAULTS.dataDir),
    idleReturnMs: configuredInteger(source, "idleReturnMs", DEFAULTS.idleReturnMs),
    httpPollMs: configuredInteger(source, "httpPollMs", DEFAULTS.httpPollMs),
    maxInboxPerResult: configuredInteger(
      source,
      "maxInboxPerResult",
      DEFAULTS.maxInboxPerResult
    ),
    maxImageBytes: configuredInteger(source, "maxImageBytes", DEFAULTS.maxImageBytes),
    maxImagesPerMessage: configuredInteger(
      source,
      "maxImagesPerMessage",
      DEFAULTS.maxImagesPerMessage
    ),
    commandOutputSliceBytes: configuredInteger(
      source,
      "commandOutputSliceBytes",
      DEFAULTS.commandOutputSliceBytes
    ),
    commandPollMs: configuredInteger(source, "commandPollMs", DEFAULTS.commandPollMs),
    clientMode: mode,
    legacyFallback: booleanValue(
      source.legacyFallback ?? DEFAULTS.legacyFallback,
      "legacyFallback"
    )
  };
}

export function parseImageMeta(input: unknown): ImageMeta {
  const source = record(input, "image");
  const mime = stringValue(source.mime, "image.mime");
  if (!IMAGE_MIMES.has(mime as ImageMeta["mime"])) {
    throw new ProtocolValidationError("image.mime is not supported");
  }
  const sha256 = stringValue(source.sha256, "image.sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ProtocolValidationError("image.sha256 must contain 64 hex characters");
  }
  const downloadUrl = optionalString(source.downloadUrl, "image.downloadUrl");
  return {
    id: stringValue(source.id, "image.id"),
    mime: mime as ImageMeta["mime"],
    bytes: integerValue(source.bytes, "image.bytes", 1),
    sha256,
    displayName: stringValue(source.displayName, "image.displayName"),
    ...(downloadUrl === undefined ? {} : { downloadUrl })
  };
}

export function parseDelivery(input: unknown): Delivery {
  const source = record(input, "delivery");
  const images = source.images ?? [];
  if (!Array.isArray(images)) {
    throw new ProtocolValidationError("delivery.images must be an array");
  }
  const visibleUntil = optionalString(source.visibleUntil, "delivery.visibleUntil");
  return {
    deliveryId: stringValue(source.deliveryId, "delivery.deliveryId"),
    sequence: integerValue(source.sequence, "delivery.sequence", 0),
    text: stringValue(source.text, "delivery.text", true),
    images: images.map(parseImageMeta),
    createdAt: stringValue(source.createdAt, "delivery.createdAt"),
    ...(visibleUntil === undefined ? {} : { visibleUntil })
  };
}

export function parseCapabilityRequest(input: unknown): CapabilityRequest {
  const source = record(input, "capability request");
  const capability = stringValue(source.capability, "capability");
  if (!CAPABILITY_SET.has(capability)) {
    throw new ProtocolValidationError(`unsupported capability: ${capability}`);
  }
  return {
    requestId: stringValue(source.requestId, "requestId"),
    conversationId: stringValue(source.conversationId, "conversationId"),
    capability: capability as CapabilityName,
    args: source.args ?? {},
    createdAt: stringValue(source.createdAt, "createdAt"),
    expiresAt: stringValue(source.expiresAt, "expiresAt")
  };
}

export function parseEnvelope(input: unknown): Envelope {
  const source = record(input, "envelope");
  if (source.version !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(`version must be ${PROTOCOL_VERSION}`);
  }
  const inbox = source.inbox ?? [];
  if (!Array.isArray(inbox)) {
    throw new ProtocolValidationError("inbox must be an array");
  }
  const conversationId = optionalString(source.conversationId, "conversationId");
  const cursor = optionalString(source.cursor, "cursor");
  const presence = optionalString(source.presence, "presence");
  if (presence !== undefined && !PRESENCE_SET.has(presence as PresenceState)) {
    throw new ProtocolValidationError("presence is invalid");
  }
  return {
    version: PROTOCOL_VERSION,
    requestId: stringValue(source.requestId, "requestId"),
    kind: stringValue(source.kind, "kind"),
    inbox: inbox.map(parseDelivery),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(source.result === undefined ? {} : { result: source.result }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(presence === undefined ? {} : { presence: presence as PresenceState })
  };
}

export function createEnvelope<TResult>(
  input: Omit<Envelope<TResult>, "version" | "inbox"> & { inbox?: Delivery[] }
): Envelope<TResult> {
  return {
    version: PROTOCOL_VERSION,
    requestId: input.requestId,
    kind: input.kind,
    inbox: input.inbox ?? [],
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.presence === undefined ? {} : { presence: input.presence })
  };
}
