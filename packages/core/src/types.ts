/**
 * Core types for the SDLC Agent Platform.
 * These types define the contracts between layers.
 */

// ── Model Layer Types ──

export type ModelProvider = "anthropic" | "openai";

export interface ModelConfig {
  primary: string;       // e.g., "claude-opus-4-6"
  fallback?: string;     // e.g., "gpt-4o"
  fast?: string;         // e.g., "claude-sonnet-4-6"
}

export interface ModelCallOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelResponse {
  content: string;
  model: string;
  provider: ModelProvider;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

// ── Context Layer Types ──

export interface LayeredContext {
  orgDefaults: Record<string, unknown>;
  stackProfile: Record<string, unknown>;
  repoOverrides: Record<string, unknown>;
  merged: Record<string, unknown>;
}

export interface RepoScan {
  rootPath: string;
  fileTree: FileNode[];
  totalFiles: number;
  totalDirectories: number;
  languages: LanguageBreakdown[];
  frameworks: string[];
  packageManifests: PackageManifest[];
  configFiles: string[];
  sampledFiles: SampledFile[];
}

export interface FileNode {
  path: string;
  type: "file" | "directory";
  extension?: string;
  sizeBytes?: number;
}

export interface LanguageBreakdown {
  language: string;
  fileCount: number;
  percentage: number;
}

export interface PackageManifest {
  path: string;
  type: "package.json" | "csproj" | "sln" | "pom.xml" | "build.gradle" | "Cargo.toml" | "go.mod" | "requirements.txt" | "pyproject.toml" | "composer.json" | "Gemfile" | "other";
  content: string;
}

export interface SampledFile {
  path: string;
  content: string;
  language: string;
  reason: string;  // Why this file was sampled
}

// ── Agent Layer Types ──

export interface AgentConfig {
  enabled: boolean;
  model: "primary" | "fallback" | "fast";
  trigger: string[];
  autoMerge?: boolean;
}

export interface AgentsConfig {
  models: ModelConfig;
  runtime: {
    type: "github-actions" | "codespaces";
    maxRetries: number;
    timeoutMinutes: number;
  };
  agents: Record<string, AgentConfig>;
  guardrails: {
    requireHumanReview: boolean;
    maxFilesChanged: number;
    blockedPaths: string[];
  };
}

export interface AgentResult {
  agent: string;
  success: boolean;
  outputs: AgentOutput[];
  summary: string;
  durationMs: number;
  modelCalls: number;
  totalTokens: number;
}

export interface AgentOutput {
  path: string;
  content: string;
  action: "create" | "update" | "delete";
}

// ── Trigger Layer Types ──

export type TriggerEvent =
  | { type: "issue_labeled"; label: string; issueNumber: number; issueBody: string }
  | { type: "pr_opened"; prNumber: number; diff: string }
  | { type: "pr_updated"; prNumber: number; diff: string }
  | { type: "manual"; args: Record<string, string> }
  | { type: "schedule"; cron: string };
