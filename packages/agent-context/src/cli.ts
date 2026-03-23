#!/usr/bin/env node

/**
 * Context Builder CLI.
 *
 * Usage:
 *   npx sdlc-agents context-builder --repo /path/to/repo
 *   npm run context-builder -- --repo /path/to/repo
 *   node packages/agent-context/dist/cli.js --repo /path/to/repo
 *
 * Options:
 *   --repo       Path to the target repository (required)
 *   --platform   Path to the sdlc-agents platform repo (defaults to cwd)
 *   --model      Model to use (default: claude-sonnet-4-6)
 *   --fallback   Fallback model (optional)
 *   --dry-run    Scan repo and show prompt, but don't call the model
 */

import * as path from "path";
import * as fs from "fs";
import { scanRepo, assembleContext } from "@sdlc-agents/core";
import { runContextBuilder } from "./index";

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].replace("--", "");
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      args[key] = value;
      if (value !== "true") i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.repo) {
    console.error(`
SDLC Agent Platform — Context Builder (Agent 0)

Usage:
  npm run context-builder -- --repo /path/to/your/repo

Options:
  --repo       Path to the target repository (REQUIRED)
  --platform   Path to sdlc-agents repo (default: current directory)
  --model      Model name (default: claude-sonnet-4-6)
  --fallback   Fallback model name
  --dry-run    Show scan results without calling the model

Environment:
  ANTHROPIC_API_KEY  Your Anthropic API key (required unless --dry-run)

Example:
  export ANTHROPIC_API_KEY=sk-ant-...
  npm run context-builder -- --repo ../my-project
`);
    process.exit(1);
  }

  const repoRoot = path.resolve(args.repo);
  const platformRoot = path.resolve(args.platform ?? process.cwd());
  const model = args.model ?? "claude-sonnet-4-6";
  const fallback = args.fallback;
  const dryRun = args["dry-run"] === "true";

  // Validate repo exists
  if (!fs.existsSync(repoRoot)) {
    console.error(`Error: Repository path does not exist: ${repoRoot}`);
    process.exit(1);
  }

  // Ensure .agents/ directory exists in target repo
  const agentsDir = path.join(repoRoot, ".agents");
  if (!fs.existsSync(agentsDir)) {
    console.log(`Creating .agents/ directory in ${repoRoot}`);
    fs.mkdirSync(path.join(agentsDir, "docs"), { recursive: true });

    // Copy sample config if it doesn't exist
    const sampleConfig = path.join(platformRoot, "sample-agents-dir", "config.yaml");
    const targetConfig = path.join(agentsDir, "config.yaml");
    if (fs.existsSync(sampleConfig) && !fs.existsSync(targetConfig)) {
      fs.copyFileSync(sampleConfig, targetConfig);
      console.log("Copied sample config.yaml to .agents/");
    }
  }

  if (dryRun) {
    console.log("\n🔍 DRY RUN — Scanning repo without calling the model\n");
    const scan = scanRepo(repoRoot);

    console.log("\n--- SCAN RESULTS ---");
    console.log(`Files: ${scan.totalFiles}`);
    console.log(`Directories: ${scan.totalDirectories}`);
    console.log(`Languages: ${scan.languages.map(l => `${l.language} (${l.percentage}%)`).join(", ")}`);
    console.log(`Frameworks: ${scan.frameworks.join(", ") || "none detected"}`);
    console.log(`Package manifests: ${scan.packageManifests.map(m => m.path).join(", ")}`);
    console.log(`Config files: ${scan.configFiles.join(", ")}`);
    console.log(`Sampled files: ${scan.sampledFiles.map(f => f.path).join(", ")}`);
    console.log("\nRun without --dry-run to generate documentation.");
    return;
  }

  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
    console.error("Set it with: export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }

  // Run the agent
  const result = await runContextBuilder(repoRoot, platformRoot, model, fallback);

  if (!result.success) {
    console.error("Agent completed with warnings. Check output above.");
    process.exit(1);
  }

  console.log("🎉 Context documentation generated successfully!");
  console.log(`   Check: ${path.join(repoRoot, ".agents", "docs")}/`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
