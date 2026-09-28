import type { LoadedConfig } from "./config.js";
import { HubClient, HubError } from "./client.js";
import { downloadDeliveryImages } from "./images.js";
import {
  acquireWaitLock,
  assertStateBinding,
  readState,
  workspaceIdentity,
  writeState,
} from "./state.js";
import type { AgentEnvelope, Delivery, SessionState } from "./types.js";

function now(): string { return new Date().toISOString(); }

function withCursor(state: SessionState, cursor: string | undefined): SessionState {
  return { ...state, ...(cursor === undefined ? {} : { cursor }), updatedAt: now() };
}

export async function ensureSession(
  loaded: LoadedConfig,
  model: string | undefined,
  client = new HubClient(loaded.config),
): Promise<{ state: SessionState; registered: boolean }> {
  const identity = workspaceIdentity(loaded.repositoryRoot);
  const existing = readState(loaded.config.stateDir, loaded.config.workspaceId);
  if (existing !== undefined) {
    assertStateBinding(existing, loaded.config.workspaceId, loaded.repositoryRoot);
    if (model !== undefined && model !== existing.model) {
      throw new HubError("model_conflict", `state is registered as ${existing.model}`, 409);
    }
    const resumed = await client.resume(existing);
    if (!resumed.ok) throw new HubError("registration_required", resumed.reason ?? "session cannot be resumed", 401);
    const state = withCursor(existing, resumed.cursor);
    writeState(loaded.config.stateDir, state);
    return { state, registered: false };
  }
  if (model === undefined || model === "") {
    throw new HubError("model_required", "first run requires --model <exact-original-model-name>", 400);
  }
  const registered = await client.register(model, identity.fingerprint);
  const timestamp = now();
  const state: SessionState = {
    version: 1,
    workspaceId: loaded.config.workspaceId,
    workspacePath: identity.path,
    workspaceFingerprint: identity.fingerprint,
    model,
    conversationId: registered.conversationId,
    resumeToken: registered.resumeToken,
    cursor: registered.cursor ?? "",
    registeredAt: timestamp,
    updatedAt: timestamp,
  };
  writeState(loaded.config.stateDir, state);
  return { state, registered: true };
}

async function localize(
  loaded: LoadedConfig,
  state: SessionState,
  deliveries: Delivery[],
  fetchImpl: typeof fetch,
): Promise<Delivery[]> {
  const output: Delivery[] = [];
  for (const delivery of deliveries) {
    output.push(await downloadDeliveryImages(loaded.config, state, delivery, fetchImpl));
  }
  return output;
}

function retryDelay(attempt: number): number {
  const base = Math.min(5_000, 250 * 2 ** Math.min(attempt, 5));
  return base + Math.floor(Math.random() * 200);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export async function runAgent(
  loaded: LoadedConfig,
  model?: string,
  dependencies: { client?: HubClient; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<AgentEnvelope> {
  const client = dependencies.client ?? new HubClient(loaded.config, dependencies.fetchImpl ?? fetch);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const session = await ensureSession(loaded, model, client);
  let state = session.state;
  const release = acquireWaitLock(loaded.config.stateDir, loaded.config.workspaceId);
  const startedAt = Date.now();
  let failures = 0;
  try {
    for (;;) {
      const elapsed = Date.now() - startedAt;
      const remaining = loaded.config.idleReturnMs - elapsed;
      if (remaining <= 0) {
        return { version: 1, kind: "idle", conversationId: state.conversationId, cursor: state.cursor, waitedMs: elapsed };
      }
      const timeoutMs = Math.min(loaded.config.httpPollMs, remaining);
      try {
        const response = await client.wait(state, timeoutMs, dependencies.signal);
        failures = 0;
        state = withCursor(state, response.cursor);
        writeState(loaded.config.stateDir, state);
        if (response.kind === "idle") continue;
        if (response.kind === "delivery") {
          const primary = response.delivery === undefined
            ? undefined
            : await downloadDeliveryImages(loaded.config, state, response.delivery, fetchImpl);
          const inbox = await localize(
            loaded,
            state,
            (response.inbox ?? []).filter((item) => item.deliveryId !== primary?.deliveryId),
            fetchImpl,
          );
          return {
            version: 1,
            kind: "delivery",
            conversationId: state.conversationId,
            ...(primary === undefined ? {} : { delivery: primary }),
            inbox,
            cursor: state.cursor,
          };
        }
        return {
          version: 1,
          kind: response.kind,
          conversationId: state.conversationId,
          cursor: state.cursor,
          ...(response.reason === undefined ? {} : { reason: response.reason }),
          ...(response.action === undefined ? {} : { action: response.action }),
        };
      } catch (error) {
        if (dependencies.signal?.aborted === true) throw error;
        if (!(error instanceof HubError) || (error.code !== "hub_unreachable" && error.code !== "hub_timeout")) throw error;
        failures += 1;
        const waited = Date.now() - startedAt;
        if (waited >= loaded.config.idleReturnMs) {
          throw new HubError("hub_unreachable", "Hub stayed unreachable for the full wait window", 0);
        }
        await delay(Math.min(retryDelay(failures), loaded.config.idleReturnMs - waited), dependencies.signal);
      }
    }
  } finally {
    release();
  }
}

export function updateStateFromEnvelope(loaded: LoadedConfig, state: SessionState, envelope: AgentEnvelope): SessionState {
  const next = withCursor(state, envelope.cursor);
  writeState(loaded.config.stateDir, next);
  return next;
}
