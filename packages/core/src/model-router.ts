/**
 * Model Router — Layer 1.
 *
 * Thin abstraction over AI model providers.
 *
 * Supports three backends for Claude:
 *   1. Direct Anthropic API (api.anthropic.com)
 *   2. Azure Foundry (https://{resource}.services.ai.azure.com/anthropic)
 *   3. GitHub Copilot SDK (via Copilot CLI in server mode)
 *
 * The backend is selected automatically based on environment variables:
 *   - If USE_COPILOT_SDK=true → GitHub Copilot SDK
 *   - If AZURE_API_KEY + AZURE_API_BASE are set → Azure Foundry
 *   - If ANTHROPIC_API_KEY is set → Direct Anthropic
 *
 * Agents don't know or care which backend is used. They call
 * callModel() and get a ModelResponse back.
 *
 * COPILOT SDK NOTE:
 *   Requires: npm install @github/copilot-sdk
 *   Requires: Copilot CLI installed and authenticated (run: copilot --headless)
 *   Each call consumes 1 premium request from your Copilot subscription.
 *   The SDK is in Technical Preview — API may change.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  ModelCallOptions,
  ModelResponse,
  ModelProvider,
} from "./types";

// ── Backend detection ──

type ModelBackend = "copilot-sdk" | "azure-foundry" | "direct";

function detectBackend(): ModelBackend {
  const useCopilot = process.env.USE_COPILOT_SDK === "true";
  const hasAzure = process.env.AZURE_API_KEY && process.env.AZURE_API_BASE;
  const hasDirect = process.env.ANTHROPIC_API_KEY;

  if (useCopilot) return "copilot-sdk";
  if (hasAzure) return "azure-foundry";
  if (hasDirect) return "direct";

  throw new Error(
    "No API credentials found. Set one of:\n" +
    "  • USE_COPILOT_SDK=true                   — for GitHub Copilot SDK (requires Copilot CLI)\n" +
    "  • ANTHROPIC_API_KEY                      — for direct Anthropic API\n" +
    "  • AZURE_API_KEY + AZURE_API_BASE         — for Azure Foundry\n\n" +
    "GitHub Copilot SDK example:\n" +
    "  export USE_COPILOT_SDK=true\n" +
    "  # Ensure Copilot CLI is installed and authenticated\n\n" +
    "Azure Foundry example:\n" +
    "  export AZURE_API_KEY=your-azure-key\n" +
    "  export AZURE_API_BASE=https://your-resource.services.ai.azure.com/anthropic\n\n" +
    "Direct Anthropic example:\n" +
    "  export ANTHROPIC_API_KEY=sk-ant-your-key"
  );
}

// ── Provider detection ──

function detectProvider(model: string): ModelProvider {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  console.warn(`Unknown model prefix for "${model}", defaulting to anthropic`);
  return "anthropic";
}

// ── Anthropic client (lazy singleton — for direct + Azure backends) ──

let anthropicClient: Anthropic | null = null;
let activeBackend: ModelBackend | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const backend = detectBackend();
    activeBackend = backend;

    if (backend === "azure-foundry") {
      const apiKey = process.env.AZURE_API_KEY!;
      const baseURL = process.env.AZURE_API_BASE!;

      console.log(`[model-router] Backend: Azure Foundry`);
      console.log(`[model-router] Base URL: ${baseURL}`);

      anthropicClient = new Anthropic({ apiKey, baseURL });
    } else {
      const apiKey = process.env.ANTHROPIC_API_KEY!;
      console.log(`[model-router] Backend: Direct Anthropic API`);
      anthropicClient = new Anthropic({ apiKey });
    }
  }
  return anthropicClient;
}

// ── Copilot SDK client (lazy, dynamically imported) ──

let copilotClient: any = null;

async function getCopilotClient(): Promise<any> {
  if (!copilotClient) {
    console.log(`[model-router] Backend: GitHub Copilot SDK`);
    console.log(`[model-router] Requires: Copilot CLI installed and authenticated`);

    try {
      // Dynamic import — only loaded when USE_COPILOT_SDK=true
      // This avoids requiring @github/copilot-sdk as a dependency
      // unless you actually use this backend.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdkModule = await (Function('return import("@github/copilot-sdk")')() as Promise<any>);
      const { CopilotClient } = sdkModule;
      copilotClient = new CopilotClient();
      await copilotClient.start();
      console.log(`[model-router] Copilot SDK client started`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Cannot find module")) {
        throw new Error(
          "GitHub Copilot SDK not installed.\n" +
          "Run: npm install @github/copilot-sdk\n" +
          "Also ensure Copilot CLI is installed: https://docs.github.com/en/copilot/how-tos/copilot-cli"
        );
      }
      throw new Error(`Failed to start Copilot SDK client: ${msg}`);
    }
  }
  return copilotClient;
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

async function callCopilotSDK(opts: ModelCallOptions): Promise<ModelResponse> {
  const client = await getCopilotClient();
  const start = Date.now();

  // Map our model names to Copilot SDK model names
  // Copilot SDK uses slightly different identifiers
  const copilotModel = opts.model
    .replace("claude-sonnet-4-6", "claude-sonnet-4.6")
    .replace("claude-sonnet-4-20250514", "claude-sonnet-4.5")
    .replace("claude-opus-4-6", "claude-opus-4.6")
    .replace(/-(\d{8})$/, ""); // Strip date suffixes

  console.log(`[model-router] Copilot SDK model: ${copilotModel}`);

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const { approveAll } = await Function('return import("@github/copilot-sdk")')() as { approveAll: unknown };

  // Don't pass systemMessage in createSession — large system prompts cause
  // the CLI subprocess to hang waiting for session.idle. Prepend it to the
  // user message instead, which is sent after the session is idle.
  const session = await client.createSession({
    model: copilotModel,
    onPermissionRequest: approveAll,
  });

  try {
    const combinedPrompt = `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`;
    const response = await session.sendAndWait({
      prompt: combinedPrompt,
    }, 300_000); // 5 minute timeout — Copilot CLI needs time for large prompts

    const content = response?.data?.content ?? "";

    return {
      content,
      model: opts.model,
      provider: "anthropic", // Still Claude under the hood
      // Copilot SDK doesn't expose token counts directly
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - start,
    };
  } finally {
    await session.disconnect();
  }
}

async function callOpenAI(_opts: ModelCallOptions): Promise<ModelResponse> {
  throw new Error(
    "OpenAI provider not yet implemented. " +
    "Add openai SDK dependency and implement callOpenAI() in model-router.ts"
  );
}

// ── Public API ──

/**
 * Returns which backend is active. Useful for logging/diagnostics.
 */
export function getActiveBackend(): string {
  if (!activeBackend) {
    activeBackend = detectBackend();
  }
  return activeBackend;
}

export async function callModel(opts: ModelCallOptions): Promise<ModelResponse> {
  const backend = activeBackend ?? detectBackend();
  activeBackend = backend;

  const provider = detectProvider(opts.model);
  console.log(`[model-router] Calling ${provider}/${opts.model} via ${backend} (max_tokens=${opts.maxTokens ?? 8192})`);

  // Copilot SDK handles both Claude and GPT models
  if (backend === "copilot-sdk") {
    return callCopilotSDK(opts);
  }

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

/**
 * Cleanup — call when shutting down to stop Copilot CLI process.
 */
export async function shutdown(): Promise<void> {
  if (copilotClient) {
    console.log("[model-router] Stopping Copilot SDK client...");
    await copilotClient.stop();
    copilotClient = null;
  }
}
