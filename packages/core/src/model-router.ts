/**
 * Model Router — Layer 1.
 *
 * Thin abstraction over AI model providers. Currently supports Anthropic (Claude).
 * Designed to add OpenAI/other providers by adding a new case to the router.
 *
 * NOTE: For the POC, we call Anthropic directly instead of using LiteLLM.
 * This keeps dependencies minimal. LiteLLM can be swapped in later without
 * changing any agent code — only this file changes.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  ModelCallOptions,
  ModelResponse,
  ModelProvider,
} from "./types";

// ── Provider detection ──

function detectProvider(model: string): ModelProvider {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  // Default to anthropic for the POC
  console.warn(`Unknown model prefix for "${model}", defaulting to anthropic`);
  return "anthropic";
}

// ── Anthropic client (lazy singleton) ──

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required. " +
        "Set it before running the agent."
      );
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// ── Provider-specific callers ──

async function callAnthropic(opts: ModelCallOptions): Promise<ModelResponse> {
  const client = getAnthropicClient();
  const start = Date.now();

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8192,
    temperature: opts.temperature ?? 0.2,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt }],
  });

  const content = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return {
    content,
    model: opts.model,
    provider: "anthropic",
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    durationMs: Date.now() - start,
  };
}

async function callOpenAI(_opts: ModelCallOptions): Promise<ModelResponse> {
  // TODO: Implement OpenAI provider
  // This is where you'd add the OpenAI SDK call.
  // The interface is identical — ModelCallOptions in, ModelResponse out.
  throw new Error(
    "OpenAI provider not yet implemented. " +
    "Add openai SDK dependency and implement callOpenAI() in model-router.ts"
  );
}

// ── Public router ──

export async function callModel(opts: ModelCallOptions): Promise<ModelResponse> {
  const provider = detectProvider(opts.model);

  console.log(`[model-router] Calling ${provider}/${opts.model} (max_tokens=${opts.maxTokens ?? 8192})`);

  switch (provider) {
    case "anthropic":
      return callAnthropic(opts);
    case "openai":
      return callOpenAI(opts);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Call with automatic fallback.
 * Tries the primary model first; if it fails, tries the fallback.
 */
export async function callModelWithFallback(
  primary: ModelCallOptions,
  fallbackModel?: string
): Promise<ModelResponse> {
  try {
    return await callModel(primary);
  } catch (err) {
    if (fallbackModel) {
      console.warn(
        `[model-router] Primary model ${primary.model} failed, falling back to ${fallbackModel}:`,
        err instanceof Error ? err.message : err
      );
      return callModel({ ...primary, model: fallbackModel });
    }
    throw err;
  }
}
