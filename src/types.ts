export type Placement = "cloud" | "onprem";

export type ProviderKind =
  | "foundry"
  | "bedrock"
  | "vertex"
  | "local"
  | "mcp"
  | "mock";

export interface ServerConfig {
  host: string;
  port: number;
}

export interface GatewayConfig {
  api_key: string;
}

export interface RoutingConfig {
  default_placement: Placement;
  activities: Record<string, Placement>;
  model_routes: Record<string, string>;
  fallback_backend: string;
}

export interface VaultConfig {
  path: string;
  entries: Array<{ id: string; backend: string; env?: string }>;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  enabled: boolean;
  endpoint?: string;
  region?: string;
  project?: string;
  location?: string;
  poll?: boolean;
}

export interface RegistryConfig {
  poll_interval_ms: number;
  providers: ProviderConfig[];
}

export interface FanoutConfig {
  max_parallel: number;
  default_timeout_ms: number;
}

export interface AppConfig {
  server: ServerConfig;
  gateway: GatewayConfig;
  routing: RoutingConfig;
  vault: VaultConfig;
  registry: RegistryConfig;
  fanout: FanoutConfig;
}

export interface DiscoveredModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  backend: string;
  placement: Placement;
  stub: boolean;
}

export interface ProviderStatus {
  id: string;
  kind: ProviderKind;
  enabled: boolean;
  healthy: boolean;
  last_poll_at: string | null;
  models: string[];
  error?: string;
  stub: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  max_tokens?: number;
  /** Optional activity tag for placement policy */
  activity?: string;
  /** Force placement override */
  placement?: Placement;
  /** Force backend override */
  backend?: string;
}

export interface FanoutTask {
  id: string;
  model?: string;
  activity?: string;
  placement?: Placement;
  backend?: string;
  messages: ChatMessage[];
}

export interface FanoutRequest {
  tasks: FanoutTask[];
  timeout_ms?: number;
}

export interface RouteDecision {
  model: string;
  backend: string;
  placement: Placement;
  activity: string;
  stub: boolean;
}
