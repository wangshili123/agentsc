import type {
  Delivery as ProtocolDelivery,
  ImageMeta as ProtocolImageMeta,
  RuntimeConfig as ProtocolRuntimeConfig,
} from "@agent-transport/protocol";

export type RuntimeConfig = ProtocolRuntimeConfig;

export interface SessionState {
  version: 1;
  workspaceId: string;
  workspacePath: string;
  workspaceFingerprint: string;
  model: string;
  conversationId: string;
  resumeToken: string;
  cursor: string;
  registeredAt: string;
  updatedAt: string;
}

export interface ImageMeta extends ProtocolImageMeta {
  localPath?: string;
}

export interface Delivery extends Omit<ProtocolDelivery, "images"> {
  images: ImageMeta[];
}

export type AgentResultKind =
  | "ready"
  | "delivery"
  | "idle"
  | "conflict"
  | "auth_expired"
  | "stop"
  | "capability_result"
  | "reply_result"
  | "ack_result"
  | "error";

export interface AgentEnvelope {
  version: 1;
  kind: AgentResultKind;
  requestId?: string;
  conversationId?: string;
  result?: { ok: boolean; value?: unknown; code?: string; message?: string; [key: string]: unknown };
  delivery?: Delivery;
  inbox?: Delivery[];
  cursor?: string;
  presence?: string;
  action?: string;
  reason?: string;
  waitedMs?: number;
}

export interface RegisterResponse {
  conversationId: string;
  resumeToken: string;
  cursor?: string;
}

export interface ResumeResponse {
  ok: boolean;
  cursor?: string;
  reason?: string;
}

export interface WaitResponse {
  kind: "delivery" | "idle" | "conflict" | "auth_expired" | "stop";
  delivery?: Delivery;
  inbox?: Delivery[];
  cursor?: string;
  action?: string;
  reason?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function numberOf(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
