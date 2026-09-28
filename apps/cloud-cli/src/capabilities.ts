import { CAPABILITIES as PROTOCOL_CAPABILITIES, type CapabilityName } from "@agent-transport/protocol";

export interface CapabilityDefinition {
  name: CapabilityName;
  mutating: boolean;
  summary: string;
}

const READ_ONLY = new Set<CapabilityName>([
  "context.get",
  "chat.wait",
  "fs.read",
  "fs.list",
  "fs.glob",
  "fs.grep",
  "process.resume",
  "plan.get",
  "task.listAvailable",
  "task.wait",
]);

const SUMMARY: Partial<Record<CapabilityName, string>> = {
  "context.get": "Read current conversation context",
  "activity.note": "Record one activity note",
  "fs.read": "Read a bounded file range",
  "fs.list": "List one directory",
  "fs.glob": "Find paths by glob pattern",
  "fs.grep": "Search file contents",
  "fs.write": "Write one file atomically",
  "fs.edit": "Apply exact all-or-nothing replacements",
  "fs.delete": "Delete one authorized path",
  "fs.move": "Move one authorized path",
  "process.exec": "Start a policy-checked command",
  "process.resume": "Read or recover one command operation",
  "process.cancel": "Cancel a running command",
  "plan.submit": "Submit a roadmap",
  "plan.update": "Update one roadmap step",
  "plan.get": "Read the current roadmap",
  "task.listAvailable": "List available collaborators",
  "task.dispatch": "Dispatch one task",
  "task.wait": "Wait for task results",
  "task.progress": "Report task progress",
  "task.result": "Report a task result",
  "task.ask": "Ask the dispatcher",
  "task.answer": "Answer a task question",
  "task.message": "Send an instruction to a task",
  "task.cancel": "Cancel a task",
  "model.register": "Register the exact model name",
  "chat.wait": "Wait for the next message",
  "chat.reply": "Reply and acknowledge a delivery",
  "chat.ack": "Acknowledge a system delivery",
  "chat.stop": "Stop the current conversation",
};

export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = PROTOCOL_CAPABILITIES.map((name) => ({
  name,
  mutating: !READ_ONLY.has(name),
  summary: SUMMARY[name] ?? name,
}));

export const CAPABILITIES = CAPABILITY_DEFINITIONS;

const CAPABILITY_NAMES = new Set<string>(PROTOCOL_CAPABILITIES);

export function capabilityName(namespace: string, action: string): CapabilityName {
  const name = `${namespace}.${action}`;
  if (!CAPABILITY_NAMES.has(name)) throw new Error(`unknown capability: ${name}`);
  return name as CapabilityName;
}
