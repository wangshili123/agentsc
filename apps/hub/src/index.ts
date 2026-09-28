import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimeConfig } from "@agent-transport/protocol";
import { createHubServer } from "./server.js";

export { createHubServer } from "./server.js";
export { HubStore } from "./store.js";

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
const thisPath = fileURLToPath(import.meta.url);

if (invokedPath === thisPath) {
  const repositoryRoot = resolve(dirname(thisPath), "../../..");
  const configuredPath = process.env.AGENT_TRANSPORT_CONFIG;
  const configPath = configuredPath === undefined
    ? resolve(repositoryRoot, "config/runtime.json")
    : resolve(configuredPath);
  if (!existsSync(configPath)) {
    throw new Error(`runtime config not found: ${configPath}`);
  }
  const config = parseRuntimeConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  const dataDir = resolve(repositoryRoot, config.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const application = createHubServer({
    config,
    databasePath: resolve(dataDir, "hub.sqlite")
  });
  const address = await application.listen();
  process.stderr.write(`agent-transport hub listening on ${address.host}:${address.port}\n`);

  const stop = async (): Promise<void> => {
    await application.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
