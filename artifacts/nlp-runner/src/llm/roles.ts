/**
 * Role-keyed model selection (PLAN-live-agent.md Phase 0).
 *
 * Mirrors browser-use's `page_extraction_llm` split: the agent can run on a
 * different (larger/vision-capable) model than the planner / compaction /
 * done-check calls. Falls back to the main configured model.
 */
import { OpenAIChatClient, type LLMClient, type OpenAIConfig } from "./client.js";
import type { LlmConfig } from "../config.js";

export type ModelRole = "agent" | "planner";

export function modelForRole(
  config: LlmConfig,
  role: ModelRole,
): string {
  if (role === "agent" && config.agentModel) return config.agentModel;
  if (role === "planner" && config.plannerModel) return config.plannerModel;
  return config.model;
}

export function clientForRole(
  config: LlmConfig,
  role: ModelRole,
): LLMClient {
  return new OpenAIChatClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: modelForRole(config, role),
  });
}

export function asOpenAIConfig(config: LlmConfig, model: string): OpenAIConfig {
  return { baseUrl: config.baseUrl, apiKey: config.apiKey, model };
}
