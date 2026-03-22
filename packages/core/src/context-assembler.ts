/**
 * Context Assembler — Layer 2.
 *
 * Reads and merges the layered context:
 *   1. Org defaults (from sdlc-agents repo or a shared location)
 *   2. Stack profile (selected by the repo's stack-profile.yaml)
 *   3. Repo overrides (from .agents/context.yaml)
 *
 * The merged context is what agents receive. Repo overrides win.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { AgentsConfig, LayeredContext } from "./types";

// ── YAML helpers ──

function loadYaml(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    console.warn(`[context] File not found, skipping: ${filePath}`);
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return (yaml.load(raw) as Record<string, unknown>) ?? {};
}

// ── Deep merge (repo overrides win) ──

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key]) &&
      typeof override[key] === "object" &&
      !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        override[key] as Record<string, unknown>
      );
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

// ── Public API ──

/**
 * Load the .agents/config.yaml from a target repo.
 */
export function loadAgentsConfig(repoRoot: string): AgentsConfig {
  const configPath = path.join(repoRoot, ".agents", "config.yaml");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No .agents/config.yaml found at ${configPath}. ` +
      `Copy the sample-agents-dir/ into your repo as .agents/ to get started.`
    );
  }
  const raw = loadYaml(configPath);
  // Basic validation
  if (!raw.models) {
    throw new Error(".agents/config.yaml must have a 'models' section");
  }
  return raw as unknown as AgentsConfig;
}

/**
 * Assemble the full layered context for a repo.
 *
 * @param repoRoot - Path to the target repository
 * @param platformRoot - Path to the sdlc-agents platform repo (for org defaults + stack profiles)
 */
export function assembleContext(
  repoRoot: string,
  platformRoot: string
): LayeredContext {
  // 1. Org defaults
  const orgDefaultsDir = path.join(platformRoot, "org-defaults");
  let orgDefaults: Record<string, unknown> = {};
  if (fs.existsSync(orgDefaultsDir)) {
    const files = fs.readdirSync(orgDefaultsDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    for (const file of files) {
      const data = loadYaml(path.join(orgDefaultsDir, file));
      orgDefaults = deepMerge(orgDefaults, data);
    }
  }
  console.log(`[context] Loaded org defaults (${Object.keys(orgDefaults).length} keys)`);

  // 2. Stack profile
  const stackProfileRef = path.join(repoRoot, ".agents", "stack-profile.yaml");
  let stackProfile: Record<string, unknown> = {};

  if (fs.existsSync(stackProfileRef)) {
    const ref = loadYaml(stackProfileRef);
    const profileName = ref.profile as string | undefined;

    if (profileName) {
      // Look for the profile in the platform repo
      const profilePath = path.join(platformRoot, "stack-profiles", `${profileName}.yaml`);
      if (fs.existsSync(profilePath)) {
        stackProfile = loadYaml(profilePath);
        console.log(`[context] Loaded stack profile: ${profileName}`);
      } else {
        console.warn(`[context] Stack profile "${profileName}" not found at ${profilePath}`);
      }
    }

    // The stack-profile.yaml in the repo can also contain inline overrides
    const { profile: _, ...inlineOverrides } = ref;
    if (Object.keys(inlineOverrides).length > 0) {
      stackProfile = deepMerge(stackProfile, inlineOverrides);
    }
  }

  // 3. Repo overrides
  const repoOverrides = loadYaml(path.join(repoRoot, ".agents", "context.yaml"));
  console.log(`[context] Loaded repo overrides (${Object.keys(repoOverrides).length} keys)`);

  // Merge: org < stack < repo
  const merged = deepMerge(deepMerge(orgDefaults, stackProfile), repoOverrides);

  return { orgDefaults, stackProfile, repoOverrides, merged };
}
