/**
 * Repo Scanner — feeds the Context Builder agent.
 *
 * Scans a repository to produce a structured summary:
 * - File tree (directories + files, respecting .gitignore patterns)
 * - Language breakdown by file extension
 * - Package manifests (package.json, csproj, sln, etc.)
 * - Config files (tsconfig, webpack, eslint, docker, etc.)
 * - Sampled source files for deeper analysis
 *
 * Designed for large repos (100+ files): uses smart sampling
 * instead of reading everything.
 */

import * as fs from "fs";
import * as path from "path";
import {
  RepoScan,
  FileNode,
  LanguageBreakdown,
  PackageManifest,
  SampledFile,
} from "./types";

// ── Extension → Language mapping ──

const EXTENSION_MAP: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript",
  ".cs": "C#", ".csx": "C#",
  ".fs": "F#", ".fsx": "F#",
  ".py": "Python",
  ".java": "Java",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".scala": "Scala",
  ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++",
  ".c": "C", ".h": "C",
  ".sql": "SQL",
  ".xml": "XML",
  ".json": "JSON",
  ".yaml": "YAML", ".yml": "YAML",
  ".md": "Markdown",
  ".html": "HTML", ".htm": "HTML",
  ".css": "CSS", ".scss": "SCSS", ".less": "LESS",
  ".sh": "Shell", ".bash": "Shell",
  ".ps1": "PowerShell",
  ".dockerfile": "Docker",
  ".tf": "Terraform",
  ".bicep": "Bicep",
};

// ── Directories to skip ──

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "bin", "obj",
  ".vs", ".idea", ".vscode", "__pycache__", ".next",
  "coverage", ".nyc_output", "vendor",
  ".nuget", "TestResults", "artifacts", ".terraform",
  ".agents",  // Don't scan our own config
]);

// ── Package manifest detection ──

type ManifestType = PackageManifest["type"];

const MANIFEST_FILES: Record<string, ManifestType> = {
  "package.json": "package.json",
  "tsconfig.json": "other",
  ".csproj": "csproj",
  ".sln": "sln",
  "pom.xml": "pom.xml",
  "build.gradle": "build.gradle",
  "Cargo.toml": "Cargo.toml",
  "go.mod": "go.mod",
  "requirements.txt": "requirements.txt",
  "pyproject.toml": "pyproject.toml",
  "composer.json": "composer.json",
  "Gemfile": "Gemfile",
};

// ── Config file patterns ──

const CONFIG_PATTERNS = [
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^tsconfig.*\.json$/,
  /^webpack\./,
  /^vite\.config/,
  /^jest\.config/,
  /^\.editorconfig$/,
  /^Dockerfile/,
  /^docker-compose/,
  /^\.dockerignore$/,
  /^\.env\.example$/,
  /^\.gitignore$/,
  /^nuget\.config$/i,
  /^appsettings.*\.json$/,
  /^launchSettings\.json$/,
  /^global\.json$/,
  /^Directory\.Build\.(props|targets)$/,
];

// ── Scanner ──

function walkDir(
  dir: string,
  rootPath: string,
  nodes: FileNode[],
  maxDepth: number = 8,
  currentDepth: number = 0
): void {
  if (currentDepth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Permission denied or other read error
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      nodes.push({ path: relativePath, type: "directory" });
      walkDir(fullPath, rootPath, nodes, maxDepth, currentDepth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      let sizeBytes: number | undefined;
      try {
        sizeBytes = fs.statSync(fullPath).size;
      } catch {
        // ignore
      }
      nodes.push({ path: relativePath, type: "file", extension: ext, sizeBytes });
    }
  }
}

function detectManifests(rootPath: string, nodes: FileNode[]): PackageManifest[] {
  const manifests: PackageManifest[] = [];

  for (const node of nodes) {
    if (node.type !== "file") continue;
    const fileName = path.basename(node.path);
    const ext = node.extension ?? "";

    let type: ManifestType | undefined;

    // Check exact filename matches
    if (MANIFEST_FILES[fileName]) {
      type = MANIFEST_FILES[fileName];
    }
    // Check extension matches (e.g., .csproj, .sln)
    else if (MANIFEST_FILES[ext]) {
      type = MANIFEST_FILES[ext];
    }

    if (type) {
      try {
        const content = fs.readFileSync(path.join(rootPath, node.path), "utf-8");
        // Limit content size to avoid blowing up context
        const truncated = content.length > 5000
          ? content.substring(0, 5000) + "\n... [truncated]"
          : content;
        manifests.push({ path: node.path, type, content: truncated });
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Limit to most important manifests (root-level first, then deeper)
  return manifests
    .sort((a, b) => a.path.split(path.sep).length - b.path.split(path.sep).length)
    .slice(0, 15);
}

function detectConfigFiles(nodes: FileNode[]): string[] {
  const configs: string[] = [];
  for (const node of nodes) {
    if (node.type !== "file") continue;
    const fileName = path.basename(node.path);
    if (CONFIG_PATTERNS.some(p => p.test(fileName))) {
      configs.push(node.path);
    }
  }
  return configs.slice(0, 30);
}

function computeLanguages(nodes: FileNode[]): LanguageBreakdown[] {
  const counts: Record<string, number> = {};
  let totalSourceFiles = 0;

  for (const node of nodes) {
    if (node.type !== "file" || !node.extension) continue;
    const lang = EXTENSION_MAP[node.extension];
    if (!lang) continue;
    // Skip non-source languages for the breakdown
    if (["JSON", "YAML", "Markdown", "XML"].includes(lang)) continue;
    counts[lang] = (counts[lang] ?? 0) + 1;
    totalSourceFiles++;
  }

  if (totalSourceFiles === 0) return [];

  return Object.entries(counts)
    .map(([language, fileCount]) => ({
      language,
      fileCount,
      percentage: Math.round((fileCount / totalSourceFiles) * 100),
    }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

function detectFrameworks(manifests: PackageManifest[]): string[] {
  const frameworks: string[] = [];

  for (const m of manifests) {
    const content = m.content.toLowerCase();

    // Node/JS frameworks
    if (content.includes("express")) frameworks.push("Express.js");
    if (content.includes("@nestjs")) frameworks.push("NestJS");
    if (content.includes("next")) frameworks.push("Next.js");
    if (content.includes("react")) frameworks.push("React");
    if (content.includes("angular")) frameworks.push("Angular");
    if (content.includes("vue")) frameworks.push("Vue.js");
    if (content.includes("fastify")) frameworks.push("Fastify");

    // .NET frameworks
    if (content.includes("microsoft.aspnetcore")) frameworks.push("ASP.NET Core");
    if (content.includes("microsoft.entityframeworkcore")) frameworks.push("Entity Framework Core");
    if (content.includes("mediatr")) frameworks.push("MediatR");
    if (content.includes("fluentvalidation")) frameworks.push("FluentValidation");
    if (content.includes("xunit")) frameworks.push("xUnit");
    if (content.includes("nunit")) frameworks.push("NUnit");
    if (content.includes("microsoft.net.sdk.worker")) frameworks.push(".NET Worker Service");
    if (content.includes("microsoft.net.sdk.web")) frameworks.push(".NET Web SDK");

    // Python frameworks
    if (content.includes("django")) frameworks.push("Django");
    if (content.includes("flask")) frameworks.push("Flask");
    if (content.includes("fastapi")) frameworks.push("FastAPI");

    // Test frameworks
    if (content.includes("jest")) frameworks.push("Jest");
    if (content.includes("mocha")) frameworks.push("Mocha");
    if (content.includes("vitest")) frameworks.push("Vitest");
    if (content.includes("pytest")) frameworks.push("pytest");

    // D365 / X++ indicators
    if (content.includes("dynamics") || content.includes("x++")) frameworks.push("Dynamics 365 FO");
  }

  return [...new Set(frameworks)];
}

/**
 * Smart file sampling for large repos.
 * Picks representative files across the codebase rather than reading everything.
 */
function sampleFiles(
  rootPath: string,
  nodes: FileNode[],
  languages: LanguageBreakdown[],
  maxFiles: number = 20,
  maxFileSize: number = 8000
): SampledFile[] {
  const sampled: SampledFile[] = [];
  const sourceFiles = nodes.filter(
    n => n.type === "file" && n.extension && EXTENSION_MAP[n.extension]
      && !["JSON", "YAML", "Markdown", "XML"].includes(EXTENSION_MAP[n.extension]!)
  );

  // Strategy 1: Entry points and important files
  const importantPatterns = [
    { pattern: /^(src\/)?(index|main|app|program|startup)\.(ts|js|cs|py)$/i, reason: "Entry point" },
    { pattern: /^(src\/)?server\.(ts|js)$/i, reason: "Server entry" },
    { pattern: /controllers?\//i, reason: "Controller (API surface)" },
    { pattern: /services?\//i, reason: "Service layer" },
    { pattern: /models?\//i, reason: "Domain model" },
    { pattern: /entities?\//i, reason: "Entity definition" },
    { pattern: /middleware\//i, reason: "Middleware" },
    { pattern: /handlers?\//i, reason: "Handler" },
    { pattern: /routes?\//i, reason: "Route definition" },
    { pattern: /\.test\.(ts|js|cs)$/i, reason: "Test file (pattern reference)" },
    { pattern: /\.spec\.(ts|js)$/i, reason: "Spec file (pattern reference)" },
  ];

  for (const file of sourceFiles) {
    if (sampled.length >= maxFiles) break;
    for (const { pattern, reason } of importantPatterns) {
      if (pattern.test(file.path) && !sampled.some(s => s.path === file.path)) {
        try {
          let content = fs.readFileSync(path.join(rootPath, file.path), "utf-8");
          if (content.length > maxFileSize) {
            content = content.substring(0, maxFileSize) + "\n// ... [truncated]";
          }
          const lang = EXTENSION_MAP[file.extension!] ?? "Unknown";
          sampled.push({ path: file.path, content, language: lang, reason });
        } catch {
          // Skip unreadable
        }
        break;
      }
    }
  }

  // Strategy 2: Sample from each detected language proportionally
  for (const lang of languages) {
    if (sampled.length >= maxFiles) break;
    const langFiles = sourceFiles.filter(
      f => f.extension && EXTENSION_MAP[f.extension] === lang.language
        && !sampled.some(s => s.path === f.path)
    );
    // Pick files from different directories for diversity
    const dirs = new Set(langFiles.map(f => path.dirname(f.path)));
    for (const dir of dirs) {
      if (sampled.length >= maxFiles) break;
      const file = langFiles.find(f => path.dirname(f.path) === dir);
      if (file) {
        try {
          let content = fs.readFileSync(path.join(rootPath, file.path), "utf-8");
          if (content.length > maxFileSize) {
            content = content.substring(0, maxFileSize) + "\n// ... [truncated]";
          }
          sampled.push({
            path: file.path,
            content,
            language: lang.language,
            reason: `Representative ${lang.language} file from ${dir}/`,
          });
        } catch {
          // Skip
        }
      }
    }
  }

  return sampled;
}

// ── Public API ──

export function scanRepo(rootPath: string): RepoScan {
  console.log(`[scanner] Scanning repository: ${rootPath}`);
  const start = Date.now();

  const nodes: FileNode[] = [];
  walkDir(rootPath, rootPath, nodes);

  const totalFiles = nodes.filter(n => n.type === "file").length;
  const totalDirectories = nodes.filter(n => n.type === "directory").length;
  console.log(`[scanner] Found ${totalFiles} files in ${totalDirectories} directories`);

  const languages = computeLanguages(nodes);
  console.log(`[scanner] Languages: ${languages.map(l => `${l.language} (${l.percentage}%)`).join(", ")}`);

  const packageManifests = detectManifests(rootPath, nodes);
  console.log(`[scanner] Found ${packageManifests.length} package manifests`);

  const configFiles = detectConfigFiles(nodes);
  console.log(`[scanner] Found ${configFiles.length} config files`);

  const frameworks = detectFrameworks(packageManifests);
  console.log(`[scanner] Detected frameworks: ${frameworks.join(", ") || "none"}`);

  const sampledFiles = sampleFiles(rootPath, nodes, languages);
  console.log(`[scanner] Sampled ${sampledFiles.length} files for analysis`);

  console.log(`[scanner] Scan completed in ${Date.now() - start}ms`);

  return {
    rootPath,
    fileTree: nodes,
    totalFiles,
    totalDirectories,
    languages,
    frameworks,
    packageManifests,
    configFiles,
    sampledFiles,
  };
}
