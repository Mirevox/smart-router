import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { RoutingPolicy } from "../src/router/policy.js";

describe("RoutingPolicy", () => {
  const config = loadConfig("./config/default.yaml");
  const policy = new RoutingPolicy(config);

  it("routes gpt models to mock-openai", () => {
    const d = policy.decide({ model: "gpt-4o-mini", activity: "chat" });
    assert.equal(d.backend, "mock-openai");
    assert.equal(d.placement, "cloud");
  });

  it("routes local/* to local-ollama", () => {
    const d = policy.decide({ model: "local/llama3.2", activity: "code" });
    assert.equal(d.backend, "local-ollama");
    assert.equal(d.placement, "onprem");
  });

  it("routes foundry/* to azure-foundry", () => {
    const d = policy.decide({ model: "foundry/gpt-4o" });
    assert.equal(d.backend, "azure-foundry");
  });

  it("honors placement override", () => {
    const d = policy.decide({
      model: "gpt-4o-mini",
      placement: "onprem",
    });
    assert.equal(d.placement, "onprem");
  });

  it("honors backend override", () => {
    const d = policy.decide({
      model: "gpt-4o-mini",
      backend: "aws-bedrock",
    });
    assert.equal(d.backend, "aws-bedrock");
  });
});
