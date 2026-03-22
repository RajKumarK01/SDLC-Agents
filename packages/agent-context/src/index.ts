/**
 * Context Builder Agent — Agent 0.
 *
 * Analyzes a repository and generates structured documentation
 * that all other agents depend on. This is the foundation of the
 * entire agent platform.
 *
 * Outputs:
 *   .agents/docs/tech-stack.yaml    — Detected tech stack, frameworks, dependencies
 *   .agents/docs/architecture.md    — Architecture overview, project structure, patterns
 *   .agents/docs/conventions.md     — Coding conventions, naming patterns, file organization
 */

import * as fs from "fs";
import * as path from "path";
import {
  callModelWithFallback,
  scanRepo,
  assembleContext,
  AgentResult,
  AgentOutput,
  RepoScan,
  LayeredContext,
} from "@sdlc-agents/core";

// ── Prompt builder ──

function buildSystemPrompt(): string {
  return `You are the Context Builder agent for an AI-powered software development platform.

Your job is to analyze a repository's structure, source code, and configuration to produce accurate, structured documentation. This documentation will be consumed by other AI agents (Code Reviewer, Code Generator, Test Generator) to understand the codebase.

CRITICAL REQUIREMENTS:
- Be ACCURATE. If you're not sure about something, say "uncertain" rather than guessing.
- Be SPECIFIC. Don't say "uses modern patterns" — say "uses the Repository pattern with dependency injection via constructor injection."
- Be CONCISE. Other agents will consume this in their context window. Every token counts.
- DISCOVER the tech stack from the evidence. Don't assume. Analyze package manifests, imports, file structure.
- Note PATTERNS you observe: how files are organized, how modules communicate, naming conventions.
- Identify DOMAIN concepts: what business domain does this code serve? What are the key entities?

You will be given:
1. A file tree summary
2. Package manifests (package.json, .csproj, etc.)
3. Config files list
4. Sampled source code files
5. Any existing context from the .agents/ directory

Produce THREE outputs, each wrapped in specific XML tags:

<tech_stack>
Produce YAML content for tech-stack.yaml. Include:
- primary_language: (language name and version if detectable)
- framework: (main framework)
- runtime: (e.g., Node 20, .NET 8)
- dependencies: (key dependencies, not exhaustive — focus on architectural ones)
- build_tool: (e.g., tsc, dotnet build, webpack)
- test_framework: (e.g., Jest, xUnit)
- infrastructure: (Docker, Terraform, etc. if present)
- database: (if detectable from config or ORM)
</tech_stack>

<architecture>
Produce Markdown content for architecture.md. Include:
- Brief project description (what this repo appears to do)
- Project structure overview (how directories are organized)
- Key architectural patterns (MVC, CQRS, microservices, monolith, etc.)
- Module/package boundaries (if multi-project)
- API surface (REST endpoints, GraphQL, gRPC if detectable)
- Data flow (how data moves through the system)
- Key integration points (external services, databases, message queues)
</architecture>

<conventions>
Produce Markdown content for conventions.md. Include:
- File naming conventions (kebab-case, PascalCase, etc.)
- Code organization patterns (where do controllers go, where do services go)
- Import/module patterns
- Error handling patterns (if observable)
- Testing patterns (file naming, test structure, what's tested)
- Any observable coding style preferences
</conventions>`;
}

function buildUserPrompt(scan: RepoScan, context: LayeredContext): string {
  const parts: string[] = [];

  // File tree (truncated for large repos)
  const treeSummary = scan.fileTree
    .filter(n => n.type === "directory" || (n.type === "file" && n.path.split(path.sep).length <= 3))
    .slice(0, 200)
    .map(n => `${n.type === "directory" ? "📁" : "📄"} ${n.path}`)
    .join("\n");

  parts.push(`## Repository Summary
- Total files: ${scan.totalFiles}
- Total directories: ${scan.totalDirectories}
- Languages: ${scan.languages.map(l => `${l.language} (${l.percentage}%, ${l.fileCount} files)`).join(", ")}
- Detected frameworks: ${scan.frameworks.join(", ") || "none detected yet"}

## File Tree (top 3 levels)
\`\`\`
${treeSummary}
\`\`\``);

  // Package manifests
  if (scan.packageManifests.length > 0) {
    parts.push(`## Package Manifests`);
    for (const m of scan.packageManifests) {
      parts.push(`### ${m.path} (${m.type})
\`\`\`
${m.content}
\`\`\``);
    }
  }

  // Config files
  if (scan.configFiles.length > 0) {
    parts.push(`## Config Files Found
${scan.configFiles.map(f => `- ${f}`).join("\n")}`);
  }

  // Sampled source files
  if (scan.sampledFiles.length > 0) {
    parts.push(`## Sampled Source Files`);
    for (const f of scan.sampledFiles) {
      parts.push(`### ${f.path} (${f.language}) — Sampled because: ${f.reason}
\`\`\`${f.language.toLowerCase()}
${f.content}
\`\`\``);
    }
  }

  // Existing context (if any)
  if (Object.keys(context.merged).length > 0) {
    parts.push(`## Existing Context (from .agents/ config)
\`\`\`yaml
${JSON.stringify(context.merged, null, 2)}
\`\`\``);
  }

  return parts.join("\n\n");
}

// ── Output parser ──

function extractTag(content: string, tag: string): string {
  const regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "m");
  const match = content.match(regex);
  if (!match) {
    console.warn(`[context-builder] Could not find <${tag}> in model response`);
    return "";
  }
  return match[1].trim();
}

// ── Public API ──

export async function runContextBuilder(
  repoRoot: string,
  platformRoot: string,
  modelName: string = "claude-sonnet-4-20250514",
  fallbackModel?: string
): Promise<AgentResult> {
  const start = Date.now();
  const outputs: AgentOutput[] = [];

  console.log("\n═══════════════════════════════════════");
  console.log("  SDLC Agent: Context Builder (Agent 0)");
  console.log("═══════════════════════════════════════\n");

  // Step 1: Scan the repo
  console.log("Step 1/3: Scanning repository...");
  const scan = scanRepo(repoRoot);

  // Step 2: Assemble existing context
  console.log("\nStep 2/3: Assembling context...");
  let context: LayeredContext;
  try {
    context = assembleContext(repoRoot, platformRoot);
  } catch {
    // If no .agents/ dir exists yet, use empty context
    context = {
      orgDefaults: {},
      stackProfile: {},
      repoOverrides: {},
      merged: {},
    };
    console.log("[context-builder] No existing .agents/ context found, starting fresh");
  }

  // Step 3: Call the model
  console.log("\nStep 3/3: Analyzing with AI model...");
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(scan, context);

  console.log(`[context-builder] Prompt size: ~${Math.round(userPrompt.length / 4)} tokens (estimated)`);

  const response = await callModelWithFallback(
    {
      model: modelName,
      systemPrompt,
      userPrompt,
      maxTokens: 8192,
      temperature: 0.1,
    },
    fallbackModel
  );

  console.log(`[context-builder] Model responded in ${response.durationMs}ms`);
  console.log(`[context-builder] Tokens: ${response.inputTokens} in / ${response.outputTokens} out`);

  // Step 4: Parse and write outputs
  const docsDir = path.join(repoRoot, ".agents", "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  const techStack = extractTag(response.content, "tech_stack");
  if (techStack) {
    const outputPath = path.join(docsDir, "tech-stack.yaml");
    // Strip any ```yaml fencing the model might add
    const cleaned = techStack.replace(/^```ya?ml\n?/m, "").replace(/\n?```$/m, "").trim();
    fs.writeFileSync(outputPath, cleaned, "utf-8");
    outputs.push({ path: ".agents/docs/tech-stack.yaml", content: cleaned, action: "create" });
    console.log(`✅ Written: ${outputPath}`);
  }

  const architecture = extractTag(response.content, "architecture");
  if (architecture) {
    const outputPath = path.join(docsDir, "architecture.md");
    const cleaned = architecture.replace(/^```ma?rkdown\n?/m, "").replace(/\n?```$/m, "").trim();
    fs.writeFileSync(outputPath, cleaned, "utf-8");
    outputs.push({ path: ".agents/docs/architecture.md", content: cleaned, action: "create" });
    console.log(`✅ Written: ${outputPath}`);
  }

  const conventions = extractTag(response.content, "conventions");
  if (conventions) {
    const outputPath = path.join(docsDir, "conventions.md");
    const cleaned = conventions.replace(/^```ma?rkdown\n?/m, "").replace(/\n?```$/m, "").trim();
    fs.writeFileSync(outputPath, cleaned, "utf-8");
    outputs.push({ path: ".agents/docs/conventions.md", content: cleaned, action: "create" });
    console.log(`✅ Written: ${outputPath}`);
  }

  const result: AgentResult = {
    agent: "context-builder",
    success: outputs.length === 3,
    outputs,
    summary: outputs.length === 3
      ? `Successfully generated ${outputs.length} context documents.`
      : `Partial success: generated ${outputs.length}/3 documents. Check model response for issues.`,
    durationMs: Date.now() - start,
    modelCalls: 1,
    totalTokens: response.inputTokens + response.outputTokens,
  };

  console.log(`\n${"═".repeat(40)}`);
  console.log(`  Result: ${result.success ? "✅ SUCCESS" : "⚠️ PARTIAL"}`);
  console.log(`  Files: ${outputs.length}/3 generated`);
  console.log(`  Duration: ${result.durationMs}ms`);
  console.log(`  Tokens: ${result.totalTokens}`);
  console.log(`${"═".repeat(40)}\n`);

  return result;
}
