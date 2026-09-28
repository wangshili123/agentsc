#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { CAPABILITIES, capabilityName } from "./capabilities.js";
import { HubClient, HubError } from "./client.js";
import { loadConfig } from "./config.js";
import { downloadDeliveryImages } from "./images.js";
import { runAgent, updateStateFromEnvelope } from "./runner.js";
import { assertStateBinding, readState, StateError } from "./state.js";
import type { AgentEnvelope, ImageMeta, SessionState } from "./types.js";

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArguments(values: string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const equals = value.indexOf("=");
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { positionals, flags };
}

function flag(args: ParsedArguments, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function scalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try { return JSON.parse(value); } catch { /* keep string */ }
  }
  return value;
}

function capabilityArgs(args: ParsedArguments, baseDir: string): unknown {
  const file = flag(args, "args-file");
  if (file !== undefined) return JSON.parse(readFileSync(isAbsolute(file) ? file : resolve(baseDir, file), "utf8")) as unknown;
  const output: Record<string, unknown> = {};
  for (const [key, value] of args.flags) {
    if (key === "request-id" || key === "args-file") continue;
    output[key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value === true ? true : scalar(value);
  }
  return output;
}

function currentState(loaded: ReturnType<typeof loadConfig>): SessionState {
  const state = readState(loaded.config.stateDir, loaded.config.workspaceId);
  if (state === undefined) throw new HubError("registration_required", "run npm run agent -- --model <exact-name> first", 401);
  assertStateBinding(state, loaded.config.workspaceId, loaded.repositoryRoot);
  return state;
}

async function localizeEnvelope(
  loaded: ReturnType<typeof loadConfig>,
  state: SessionState,
  envelope: AgentEnvelope,
): Promise<AgentEnvelope> {
  const inbox = [];
  for (const delivery of envelope.inbox ?? []) {
    inbox.push(await downloadDeliveryImages(loaded.config, state, delivery));
  }
  const localized = { ...envelope, inbox };
  updateStateFromEnvelope(loaded, state, localized);
  return localized;
}

function replyInput(path: string, baseDir: string): { text: string; images?: unknown[]; responseId?: string } {
  const raw = readFileSync(isAbsolute(path) ? path : resolve(baseDir, path), "utf8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record["text"] === "string") {
        return {
          text: record["text"],
          ...(Array.isArray(record["images"]) ? { images: record["images"] } : {}),
          ...(typeof record["responseId"] === "string" ? { responseId: record["responseId"] } : {}),
        };
      }
    }
  } catch { /* plain text response */ }
  return { text: raw };
}

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function prepareReplyImages(
  client: HubClient,
  state: SessionState,
  values: unknown[] | undefined,
  baseDir: string,
): Promise<ImageMeta[]> {
  const output: ImageMeta[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HubError("bad_arguments", "reply image must be an object", 400);
    }
    const record = value as Record<string, unknown>;
    if (typeof record["path"] === "string") {
      const path = isAbsolute(record["path"]) ? record["path"] : resolve(baseDir, record["path"]);
      const mime = typeof record["mime"] === "string"
        ? record["mime"]
        : IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
      if (mime === undefined) throw new HubError("bad_arguments", `cannot infer image MIME: ${path}`, 400);
      output.push(await client.uploadImage(state, {
        mime,
        displayName: typeof record["displayName"] === "string" ? record["displayName"] : basename(path),
        body: readFileSync(path),
      }));
      continue;
    }
    output.push(record as unknown as ImageMeta);
  }
  return output;
}

async function doctor(): Promise<AgentEnvelope> {
  const loaded = loadConfig();
  const state = readState(loaded.config.stateDir, loaded.config.workspaceId);
  let hub: unknown = { ok: false };
  try {
    const response = await fetch(`${loaded.config.hubUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
    hub = { ok: response.ok, status: response.status, body: await response.json().catch(() => undefined) };
  } catch (error) {
    hub = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return {
    version: 1,
    kind: "capability_result",
    result: {
      ok: true,
      value: {
        configPath: loaded.configPath,
        repositoryRoot: loaded.repositoryRoot,
        workspaceId: loaded.config.workspaceId,
        hubUrl: loaded.config.hubUrl,
        state: state === undefined ? "missing" : "present",
        conversationId: state?.conversationId,
        hub,
      },
    },
    inbox: [],
  };
}

async function main(): Promise<AgentEnvelope> {
  const args = parseArguments(process.argv.slice(2));
  const [command = "agent", action] = args.positionals;
  if (command === "agent") return await runAgent(loadConfig(), flag(args, "model"));
  if (command === "capabilities") {
    return { version: 1, kind: "capability_result", result: { ok: true, value: CAPABILITIES }, inbox: [] };
  }
  if (command === "doctor") return await doctor();

  const loaded = loadConfig();
  const state = currentState(loaded);
  const client = new HubClient(loaded.config);
  if (command === "chat" && action === "reply") {
    const deliveryId = flag(args, "delivery");
    const file = flag(args, "file");
    if (deliveryId === undefined || file === undefined) throw new HubError("bad_arguments", "chat reply requires --delivery and --file", 400);
    const input = replyInput(file, loaded.repositoryRoot);
    const images = await prepareReplyImages(client, state, input.images, loaded.repositoryRoot);
    return await localizeEnvelope(loaded, state, await client.reply(state, {
      deliveryId,
      text: input.text,
      images,
      ...(input.responseId === undefined ? {} : { responseId: input.responseId }),
    }));
  }
  if (command === "chat" && action === "ack") {
    const deliveryId = flag(args, "delivery");
    if (deliveryId === undefined) throw new HubError("bad_arguments", "chat ack requires --delivery", 400);
    return await localizeEnvelope(loaded, state, await client.ack(state, deliveryId));
  }
  if (command === "stop") {
    return await localizeEnvelope(loaded, state, await client.capability(state, "chat.stop", {}, flag(args, "request-id") ?? randomUUID()));
  }
  if (command === "capability") {
    const name = action;
    if (name === undefined) throw new HubError("bad_arguments", "capability requires a name", 400);
    return await localizeEnvelope(loaded, state, await client.capability(state, name, capabilityArgs(args, loaded.repositoryRoot), flag(args, "request-id") ?? randomUUID()));
  }
  if (action !== undefined && ["context", "activity", "fs", "process", "plan", "task"].includes(command)) {
    const name = capabilityName(command, action);
    return await localizeEnvelope(loaded, state, await client.capability(state, name, capabilityArgs(args, loaded.repositoryRoot), flag(args, "request-id") ?? randomUUID()));
  }
  throw new HubError("bad_arguments", `unknown command: ${[command, action].filter(Boolean).join(" ")}`, 400);
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof HubError || error instanceof StateError ? error.code : "internal_error";
  const output: AgentEnvelope = {
    version: 1,
    kind: code === "waiter_conflict" ? "conflict" : code === "registration_required" ? "auth_expired" : "error",
    result: { ok: false, code, message: error instanceof Error ? error.message : String(error) },
    inbox: [],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
}
