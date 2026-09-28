import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  type CapabilityName,
  type CapabilityResult,
  type Delivery,
  type ImageMeta,
  type PresenceState,
  type Response,
  parseImageMeta
} from "@agent-transport/protocol";

interface Row {
  [key: string]: unknown;
}

export interface ConversationRecord {
  conversationId: string;
  workspaceId: string;
  model: string;
  workspaceFingerprint: string;
  transportMode: "transport" | "legacy";
  closed: boolean;
  createdAt: string;
}

export interface Registration extends ConversationRecord {
  resumeToken: string;
}

export interface PresenceSnapshot {
  transportConnected: boolean;
  desktopReady: boolean;
  agentListening: boolean;
  agentWorking: boolean;
  agentStalled: boolean;
  conversationClosed: boolean;
  state: PresenceState;
  createdAt: string;
}

export interface CapabilityRequestRecord {
  requestId: string;
  conversationId: string;
  name: CapabilityName;
  args: unknown;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  expiresAt: string;
}

export interface CapabilityRouteResult {
  request: CapabilityRequestRecord;
  result?: CapabilityResult;
}

export interface AttachmentRecord {
  meta: ImageMeta;
  body: Buffer;
  expiresAt: string;
}

export interface StoreOptions {
  visibilityTimeoutMs?: number;
  capabilityTtlMs?: number;
  capabilityVisibilityMs?: number;
  now?: () => Date;
}

function iso(date: Date): string {
  return date.toISOString();
}

function bool(value: unknown): boolean {
  return value === 1;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  return JSON.parse(value) as unknown;
}

function parseImages(value: unknown): ImageMeta[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parseImageMeta);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function conversationFromRow(row: Row): ConversationRecord {
  return {
    conversationId: String(row.id),
    workspaceId: String(row.workspace_id),
    model: String(row.model),
    workspaceFingerprint: String(row.workspace_fingerprint),
    transportMode: row.transport_mode === "legacy" ? "legacy" : "transport",
    closed: row.closed_at !== null,
    createdAt: String(row.created_at)
  };
}

function capabilityFromRow(row: Row): CapabilityRequestRecord {
  const status = String(row.status) as CapabilityRequestRecord["status"];
  return {
    requestId: String(row.request_id),
    conversationId: String(row.conversation_id),
    name: String(row.name) as CapabilityName,
    args: parseJson(row.args_json),
    status,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at)
  };
}

export class HubStore {
  readonly database: DatabaseSync;
  readonly visibilityTimeoutMs: number;
  readonly capabilityTtlMs: number;
  readonly capabilityVisibilityMs: number;
  readonly now: () => Date;

  constructor(path: string, options: StoreOptions = {}) {
    this.database = new DatabaseSync(path);
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000;
    this.capabilityTtlMs = options.capabilityTtlMs ?? 5 * 60_000;
    this.capabilityVisibilityMs = options.capabilityVisibilityMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        model TEXT NOT NULL,
        workspace_fingerprint TEXT NOT NULL,
        resume_token_hash TEXT NOT NULL UNIQUE,
        transport_mode TEXT NOT NULL CHECK (transport_mode IN ('transport', 'legacy')),
        closed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        sequence INTEGER NOT NULL,
        text TEXT NOT NULL,
        images_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        sequence INTEGER NOT NULL,
        claimed_at TEXT NOT NULL,
        visible_until TEXT NOT NULL,
        acknowledged_at TEXT,
        UNIQUE(conversation_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS responses (
        response_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
        text TEXT NOT NULL,
        images_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capability_requests (
        request_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capability_results (
        request_id TEXT PRIMARY KEY REFERENCES capability_requests(request_id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        result_json TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        display_name TEXT NOT NULL,
        body BLOB NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS presence_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        transport_connected INTEGER NOT NULL,
        desktop_ready INTEGER NOT NULL,
        agent_listening INTEGER NOT NULL,
        agent_working INTEGER NOT NULL,
        agent_stalled INTEGER NOT NULL,
        conversation_closed INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence
        ON messages(conversation_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_deliveries_visibility
        ON deliveries(conversation_id, acknowledged_at, visible_until);
      CREATE INDEX IF NOT EXISTS idx_capability_queue
        ON capability_requests(conversation_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_conversation_expiry
        ON attachments(conversation_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_presence_conversation
        ON presence_events(conversation_id, id DESC);
    `);
    const capabilityColumns = this.database.prepare("PRAGMA table_info(capability_requests)").all() as Row[];
    if (!capabilityColumns.some((column) => column.name === "claimed_at")) {
      this.database.exec("ALTER TABLE capability_requests ADD COLUMN claimed_at TEXT");
    }
  }

  register(input: {
    workspaceId: string;
    model: string;
    workspaceFingerprint: string;
    transportMode?: "transport" | "legacy";
  }): Registration {
    const conversationId = `cv_${randomUUID().replaceAll("-", "")}`;
    const resumeToken = randomBytes(32).toString("base64url");
    const createdAt = iso(this.now());
    const transportMode = input.transportMode ?? "transport";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // 一个 workspace 只允许一条开放的新通道；重新登记会使旧 token 当场失效，避免桌面端随机配到旧会话。
      this.database
        .prepare(`
          UPDATE conversations SET closed_at = ?, updated_at = ?
          WHERE workspace_id = ? AND transport_mode = ? AND closed_at IS NULL
        `)
        .run(createdAt, createdAt, input.workspaceId, transportMode);
      this.database
        .prepare(`
          INSERT INTO conversations (
            id, workspace_id, model, workspace_fingerprint, resume_token_hash,
            transport_mode, closed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `)
        .run(
          conversationId,
          input.workspaceId,
          input.model,
          input.workspaceFingerprint,
          tokenHash(resumeToken),
          transportMode,
          createdAt,
          createdAt
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      conversationId,
      workspaceId: input.workspaceId,
      model: input.model,
      workspaceFingerprint: input.workspaceFingerprint,
      transportMode,
      closed: false,
      createdAt,
      resumeToken
    };
  }

  latestOpenConversation(workspaceId: string): ConversationRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT * FROM conversations
        WHERE workspace_id = ? AND transport_mode = 'transport' AND closed_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(workspaceId) as Row | undefined;
    return row === undefined ? undefined : conversationFromRow(row);
  }

  resume(input: {
    conversationId: string;
    resumeToken: string;
    workspaceFingerprint: string;
  }): ConversationRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT * FROM conversations
        WHERE id = ? AND resume_token_hash = ? AND closed_at IS NULL
      `)
      .get(input.conversationId, tokenHash(input.resumeToken)) as Row | undefined;
    if (row === undefined || row.workspace_fingerprint !== input.workspaceFingerprint) {
      return undefined;
    }
    this.database
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(iso(this.now()), input.conversationId);
    return conversationFromRow(row);
  }

  authenticate(conversationId: string, resumeToken: string): ConversationRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT * FROM conversations
        WHERE id = ? AND resume_token_hash = ? AND closed_at IS NULL
      `)
      .get(conversationId, tokenHash(resumeToken)) as Row | undefined;
    return row === undefined ? undefined : conversationFromRow(row);
  }

  getConversation(conversationId: string): ConversationRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(conversationId) as Row | undefined;
    return row === undefined ? undefined : conversationFromRow(row);
  }

  assertTransport(conversationId: string, mode: "transport" | "legacy"): boolean {
    const conversation = this.getConversation(conversationId);
    return conversation !== undefined && !conversation.closed && conversation.transportMode === mode;
  }

  closeConversation(conversationId: string): boolean {
    const closedAt = iso(this.now());
    const result = this.database
      .prepare("UPDATE conversations SET closed_at = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL")
      .run(closedAt, closedAt, conversationId);
    return result.changes > 0;
  }

  enqueueMessage(input: {
    conversationId: string;
    messageId?: string;
    text: string;
    images?: ImageMeta[];
  }): Delivery {
    const createdAt = iso(this.now());
    const images = input.images ?? [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const conversation = this.getConversation(input.conversationId);
      if (conversation === undefined || conversation.closed) {
        throw new Error("conversation_not_found");
      }
      const messageId = input.messageId ?? `msg_${randomUUID().replaceAll("-", "")}`;
      const existing = this.database
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(messageId) as Row | undefined;
      if (existing !== undefined) {
        const same = String(existing.conversation_id) === input.conversationId &&
          String(existing.text) === input.text &&
          String(existing.images_json) === JSON.stringify(images);
        if (!same) throw new Error("message_id_conflict");
        this.database.exec("COMMIT");
        return {
          deliveryId: "",
          sequence: Number(existing.sequence),
          text: String(existing.text),
          images: parseImages(existing.images_json),
          createdAt: String(existing.created_at),
        };
      }
      const maxRow = this.database
        .prepare("SELECT COALESCE(MAX(sequence), -1) AS value FROM messages WHERE conversation_id = ?")
        .get(input.conversationId) as Row;
      const sequence = Number(maxRow.value) + 1;
      this.database
        .prepare(`
          INSERT INTO messages (id, conversation_id, sequence, text, images_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(messageId, input.conversationId, sequence, input.text, JSON.stringify(images), createdAt);
      this.database.exec("COMMIT");
      return {
        deliveryId: "",
        sequence,
        text: input.text,
        images,
        createdAt
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimDelivery(conversationId: string): Delivery | undefined {
    const now = this.now();
    const nowIso = iso(now);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(`
          SELECT m.id AS message_id, m.sequence, m.text, m.images_json, m.created_at,
                 d.delivery_id, d.visible_until
          FROM messages m
          LEFT JOIN deliveries d ON d.message_id = m.id
          WHERE m.conversation_id = ?
            AND (d.delivery_id IS NULL OR (d.acknowledged_at IS NULL AND d.visible_until <= ?))
          ORDER BY m.sequence ASC
          LIMIT 1
        `)
        .get(conversationId, nowIso) as Row | undefined;
      if (row === undefined) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const deliveryId = row.delivery_id === null
        ? `dly_${randomUUID().replaceAll("-", "")}`
        : String(row.delivery_id);
      const visibleUntil = iso(new Date(now.getTime() + this.visibilityTimeoutMs));
      if (row.delivery_id === null) {
        this.database
          .prepare(`
            INSERT INTO deliveries (
              delivery_id, conversation_id, message_id, sequence, claimed_at, visible_until, acknowledged_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL)
          `)
          .run(
            deliveryId,
            conversationId,
            String(row.message_id),
            Number(row.sequence),
            nowIso,
            visibleUntil
          );
      } else {
        this.database
          .prepare("UPDATE deliveries SET claimed_at = ?, visible_until = ? WHERE delivery_id = ?")
          .run(nowIso, visibleUntil, deliveryId);
      }
      this.database.exec("COMMIT");
      return {
        deliveryId,
        sequence: Number(row.sequence),
        text: String(row.text),
        images: parseImages(row.images_json),
        createdAt: String(row.created_at),
        visibleUntil
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  acknowledge(conversationId: string, deliveryId: string): boolean {
    const result = this.database
      .prepare(`
        UPDATE deliveries SET acknowledged_at = ?
        WHERE delivery_id = ? AND conversation_id = ? AND acknowledged_at IS NULL
      `)
      .run(iso(this.now()), deliveryId, conversationId);
    if (result.changes > 0) return true;
    const existing = this.database
      .prepare("SELECT delivery_id FROM deliveries WHERE delivery_id = ? AND conversation_id = ?")
      .get(deliveryId, conversationId);
    return existing !== undefined;
  }

  reply(input: {
    conversationId: string;
    deliveryId: string;
    responseId: string;
    text: string;
    images?: ImageMeta[];
  }): { response: Response; replayed: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT * FROM responses WHERE response_id = ?")
        .get(input.responseId) as Row | undefined;
      if (existing !== undefined) {
        if (
          existing.conversation_id !== input.conversationId ||
          existing.delivery_id !== input.deliveryId
        ) {
          throw new Error("response_id_conflict");
        }
        this.database.exec("COMMIT");
        return {
          response: {
            responseId: String(existing.response_id),
            deliveryId: String(existing.delivery_id),
            text: String(existing.text),
            images: parseImages(existing.images_json),
            createdAt: String(existing.created_at)
          },
          replayed: true
        };
      }
      const delivery = this.database
        .prepare("SELECT * FROM deliveries WHERE delivery_id = ? AND conversation_id = ?")
        .get(input.deliveryId, input.conversationId) as Row | undefined;
      if (delivery === undefined) throw new Error("delivery_not_found");
      const createdAt = iso(this.now());
      const images = input.images ?? [];
      this.database
        .prepare(`
          INSERT INTO responses (response_id, conversation_id, delivery_id, text, images_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.responseId,
          input.conversationId,
          input.deliveryId,
          input.text,
          JSON.stringify(images),
          createdAt
        );
      this.database
        .prepare("UPDATE deliveries SET acknowledged_at = ? WHERE delivery_id = ?")
        .run(createdAt, input.deliveryId);
      this.database.exec("COMMIT");
      return {
        response: {
          responseId: input.responseId,
          deliveryId: input.deliveryId,
          text: input.text,
          images,
          createdAt
        },
        replayed: false
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listResponses(conversationId: string, afterResponseId = ""): Response[] {
    let rows: Row[];
    if (afterResponseId === "") {
      rows = this.database
        .prepare("SELECT * FROM responses WHERE conversation_id = ? ORDER BY created_at ASC, response_id ASC")
        .all(conversationId) as Row[];
    } else {
      const anchor = this.database
        .prepare("SELECT created_at FROM responses WHERE conversation_id = ? AND response_id = ?")
        .get(conversationId, afterResponseId) as Row | undefined;
      if (anchor === undefined) throw new Error("response_cursor_not_found");
      rows = this.database
        .prepare(`
          SELECT * FROM responses
          WHERE conversation_id = ?
            AND (created_at > ? OR (created_at = ? AND response_id > ?))
          ORDER BY created_at ASC, response_id ASC
        `)
        .all(conversationId, String(anchor.created_at), String(anchor.created_at), afterResponseId) as Row[];
    }
    return rows.map((row) => ({
      responseId: String(row.response_id),
      deliveryId: String(row.delivery_id),
      text: String(row.text),
      images: parseImages(row.images_json),
      createdAt: String(row.created_at)
    }));
  }

  routeCapability(input: {
    conversationId: string;
    requestId: string;
    name: CapabilityName;
    args: unknown;
  }): CapabilityRouteResult {
    const existing = this.getCapability(input.requestId);
    if (existing !== undefined) {
      if (
        existing.request.conversationId !== input.conversationId ||
        existing.request.name !== input.name ||
        JSON.stringify(existing.request.args) !== JSON.stringify(input.args)
      ) {
        throw new Error("capability_request_conflict");
      }
      return existing;
    }
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.capabilityTtlMs);
    this.database
      .prepare(`
        INSERT INTO capability_requests (
          request_id, conversation_id, name, args_json, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
      `)
      .run(
        input.requestId,
        input.conversationId,
        input.name,
        JSON.stringify(input.args),
        iso(createdAt),
        iso(expiresAt)
      );
    return { request: this.getCapabilityRequest(input.requestId)! };
  }

  claimCapability(conversationId: string): CapabilityRequestRecord | undefined {
    const nowDate = this.now();
    const now = iso(nowDate);
    const staleBefore = iso(new Date(nowDate.getTime() - this.capabilityVisibilityMs));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(`
          SELECT * FROM capability_requests
          WHERE conversation_id = ?
            AND expires_at > ?
            AND (status = 'queued' OR (status = 'running' AND claimed_at <= ?))
          ORDER BY created_at ASC LIMIT 1
        `)
        .get(conversationId, now, staleBefore) as Row | undefined;
      if (row === undefined) {
        this.database.exec("COMMIT");
        return undefined;
      }
      this.database
        .prepare("UPDATE capability_requests SET status = 'running', claimed_at = ? WHERE request_id = ?")
        .run(now, String(row.request_id));
      this.database.exec("COMMIT");
      return { ...capabilityFromRow(row), status: "running" };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeCapability(result: CapabilityResult): CapabilityRouteResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const request = this.getCapabilityRequest(result.requestId);
      if (request === undefined || request.conversationId !== result.conversationId) {
        throw new Error("capability_request_not_found");
      }
      const existing = this.getCapabilityResult(result.requestId);
      if (existing === undefined) {
        this.database
          .prepare(`
            INSERT INTO capability_results (request_id, conversation_id, result_json, completed_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(result.requestId, result.conversationId, JSON.stringify(result), result.completedAt);
        this.database
          .prepare("UPDATE capability_requests SET status = ? WHERE request_id = ?")
          .run(result.ok ? "completed" : "failed", result.requestId);
      }
      this.database.exec("COMMIT");
      return {
        request: this.getCapabilityRequest(result.requestId)!,
        result: this.getCapabilityResult(result.requestId)!
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getCapability(requestId: string): CapabilityRouteResult | undefined {
    const request = this.getCapabilityRequest(requestId);
    if (request === undefined) return undefined;
    const result = this.getCapabilityResult(requestId);
    return result === undefined ? { request } : { request, result };
  }

  private getCapabilityRequest(requestId: string): CapabilityRequestRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM capability_requests WHERE request_id = ?")
      .get(requestId) as Row | undefined;
    return row === undefined ? undefined : capabilityFromRow(row);
  }

  private getCapabilityResult(requestId: string): CapabilityResult | undefined {
    const row = this.database
      .prepare("SELECT result_json FROM capability_results WHERE request_id = ?")
      .get(requestId) as Row | undefined;
    return row === undefined ? undefined : (parseJson(row.result_json) as CapabilityResult);
  }

  putAttachment(input: {
    conversationId: string;
    mime: ImageMeta["mime"];
    displayName: string;
    body: Buffer;
    ttlMs?: number;
  }): AttachmentRecord {
    const conversation = this.getConversation(input.conversationId);
    if (conversation === undefined || conversation.closed) throw new Error("conversation_not_found");
    const id = `img_${randomUUID().replaceAll("-", "")}`;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + (input.ttlMs ?? 24 * 60 * 60 * 1000));
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    const meta: ImageMeta = {
      id,
      mime: input.mime,
      bytes: input.body.length,
      sha256,
      displayName: input.displayName,
      downloadUrl: `/v1/agent/images/${id}?conversationId=${encodeURIComponent(input.conversationId)}`,
    };
    this.database
      .prepare(`
        INSERT INTO attachments (id, conversation_id, mime, bytes, sha256, display_name, body, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, input.conversationId, input.mime, input.body.length, sha256, input.displayName, input.body, iso(createdAt), iso(expiresAt));
    return { meta, body: Buffer.from(input.body), expiresAt: iso(expiresAt) };
  }

  getAttachment(conversationId: string, id: string): AttachmentRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT * FROM attachments
        WHERE id = ? AND conversation_id = ? AND expires_at > ?
      `)
      .get(id, conversationId, iso(this.now())) as Row | undefined;
    if (row === undefined) return undefined;
    const meta: ImageMeta = {
      id: String(row.id),
      mime: String(row.mime) as ImageMeta["mime"],
      bytes: Number(row.bytes),
      sha256: String(row.sha256),
      displayName: String(row.display_name),
      downloadUrl: `/v1/agent/images/${String(row.id)}?conversationId=${encodeURIComponent(conversationId)}`,
    };
    return { meta, body: Buffer.from(row.body as Uint8Array), expiresAt: String(row.expires_at) };
  }

  deleteExpiredAttachments(): number {
    const result = this.database.prepare("DELETE FROM attachments WHERE expires_at <= ?").run(iso(this.now()));
    return Number(result.changes);
  }

  recordPresence(
    conversationId: string,
    input: Omit<PresenceSnapshot, "createdAt">
  ): PresenceSnapshot {
    const createdAt = iso(this.now());
    this.database
      .prepare(`
        INSERT INTO presence_events (
          conversation_id, transport_connected, desktop_ready, agent_listening,
          agent_working, agent_stalled, conversation_closed, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        conversationId,
        Number(input.transportConnected),
        Number(input.desktopReady),
        Number(input.agentListening),
        Number(input.agentWorking),
        Number(input.agentStalled),
        Number(input.conversationClosed),
        input.state,
        createdAt
      );
    return { ...input, createdAt };
  }

  getPresence(conversationId: string): PresenceSnapshot | undefined {
    const row = this.database
      .prepare("SELECT * FROM presence_events WHERE conversation_id = ? ORDER BY id DESC LIMIT 1")
      .get(conversationId) as Row | undefined;
    if (row === undefined) return undefined;
    return {
      transportConnected: bool(row.transport_connected),
      desktopReady: bool(row.desktop_ready),
      agentListening: bool(row.agent_listening),
      agentWorking: bool(row.agent_working),
      agentStalled: bool(row.agent_stalled),
      conversationClosed: bool(row.conversation_closed),
      state: String(row.state) as PresenceState,
      createdAt: String(row.created_at)
    };
  }
}
