import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AppConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = resolve(
  process.env.SMART_ROUTER_CONFIG ?? "./config/default.yaml",
);

export function loadConfig(path = DEFAULT_CONFIG_PATH): AppConfig {
  if (!existsSync(path)) {
    throw new Error(`Config not found: ${path}`);
  }
  const raw = parseYaml(readFileSync(path, "utf8")) as AppConfig;

  raw.server.host = process.env.SMART_ROUTER_HOST ?? raw.server.host;
  raw.server.port = Number(process.env.SMART_ROUTER_PORT ?? raw.server.port);
  raw.gateway.api_key =
    process.env.SMART_ROUTER_API_KEY ?? raw.gateway.api_key;
  raw.vault.path = process.env.SMART_ROUTER_VAULT_PATH ?? raw.vault.path;

  return raw;
}

export function stubMode(): boolean {
  const v = process.env.SMART_ROUTER_STUB_MODE;
  if (v === undefined) return true;
  return v === "1" || v.toLowerCase() === "true";
}
