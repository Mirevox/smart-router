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
  enforce_placement?: boolean;
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
  live?: boolean;
  api_path?: string;
}

export interface RegistryConfig {
  poll_interval_ms: number;
  providers: ProviderConfig[];
}

export interface FanoutConfig {
  max_parallel: number;
  default_timeout_ms: number;
}

export interface GuardrailsConfig {
  max_identical_tool_calls?: number;
  max_task_tokens?: number;
  max_task_cost_usd?: number;
  cost_per_1k_tokens_usd?: number;
  context_window_tokens?: number;
  context_warn_ratio?: number;
}

export interface AppConfig {
  server: ServerConfig;
  gateway: GatewayConfig;
  routing: RoutingConfig;
  vault: VaultConfig;
  registry: RegistryConfig;
  fanout: FanoutConfig;
  guardrails?: GuardrailsConfig;
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
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name: string; arguments: string };
  }>;
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
  /** Distributed trace identifier propagated to Evals and Data Lineage */
  trace_id?: string;
  /** Agent session identifier for loop & context tracking */
  session_id?: string;
  /** Explicit tool invocations for loop-breaker inspection */
  tool_calls?: Array<{ name: string; arguments: unknown }>;
  /** Per-task token / USD budget ceiling */
  budget?: { max_tokens?: number; max_cost_usd?: number };
  /** Override context window token capacity for exhaustion alerting */
  context_window_tokens?: number;
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

export interface SplitPromptRequest {
  prompt: string;
  model?: string;
  activity?: string;
  placement?: Placement;
  backend?: string;
  max_tasks?: number;
  timeout_ms?: number;
}

export interface RouteDecision {
  model: string;
  backend: string;
  placement: Placement;
  activity: string;
  stub: boolean;
}
