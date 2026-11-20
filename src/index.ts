import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { KeyVault } from "./vault/key-vault.js";
import { RoutingPolicy } from "./router/policy.js";
import { DiscoveryRegistry } from "./registry/providers.js";
import { createGateway } from "./gateway/openai.js";

const config = loadConfig();
const vault = new KeyVault(config.vault);
const policy = new RoutingPolicy(config);
const registry = new DiscoveryRegistry(config, vault);
registry.start();

const app = createGateway({ config, policy, registry, vault });

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.server.host,
    port: config.server.port,
  },
  (info) => {
    console.log(
      `mirevox smart-router listening on http://${info.address}:${info.port}`,
    );
    console.log(`OpenAI base: http://${info.address}:${info.port}/v1`);
  },
);

function shutdown(): void {
  registry.stop();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
