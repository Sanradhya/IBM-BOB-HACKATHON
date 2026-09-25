const { randomUUID } = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const pdfParse = require("pdf-parse");

const SYSTEM_PROMPT = `You are Blindspot, an elite, autonomous local security agent. Your goal is to find architectural vulnerabilities, logic flaws, and supply-chain risks that a standard git diff would miss.

You operate using a strict Reason-Act-Observe loop:
1. REASON: Analyze the provided git diff. Ask yourself: "How does this change impact the broader system? Do I need more context?"
2. ACT: If you need context, use your tools (readFile, readPackageJson) to investigate.
3. OBSERVE: Read the tool output and evaluate the vulnerability.

CRITICAL RULES:
- Never assume context. If a function signature changes, read the files that import it.
- If a route is added, check the authentication middleware.
- If dependencies change, check for known malicious patterns.
- Output your final analysis as clean, readable Markdown. Use headers (##), **bold** for emphasis, and bullet points for findings. Structure it with sections such as Summary, Risk Level, and Issues. For each issue include the title, severity, affected file, description, and recommendation. Do not output JSON.`;

const FINDING_FORMAT = `For every finding use exactly this Markdown structure:
### <short title>
- **Severity:** Critical | High | Medium | Low
- **File:** \`<path>\`
- **Description:** <what you observed>
- **Recommendation:** <what to verify or change>
- **Refactor:**
\`\`\`suggestion
<exact code fix>
\`\`\`

The suggestion fence must contain the exact replacement code so GitHub can apply it as a one-click commit suggestion. Do not include exploit procedures, payloads, or attack steps. If you find nothing, emit one Low finding whose title is "No issues observed" and omit the Refactor block.`;

const SUBAGENT_SECURITY_PROMPT = `You are Subagent A, Blindspot's Security & Supply Chain reviewer.

Scope:
- You may use only the readPackageJson tool. Do not request any other tool.
- Review the git diff for typosquatting (package names one edit away from a well-known package), dependency poisoning (non-registry specifiers, unexpected new dependencies), and risky updates (unpinned versions such as latest or *, floating ranges, or registry switches).
- If you detect typosquatting (e.g., 'lodash' swapped to 'Iodash' or 'lodash-utils') or unauthorized registry specifiers in the package.json diff, you MUST flag it as a CRITICAL severity finding.
- For every supply-chain finding, always include a \`\`\`suggestion\`\`\` block that reverts the malicious dependency back to the safe, intended version (the well-known package name and its previous legitimate specifier).

${FINDING_FORMAT}`;

const SUBAGENT_ARCHITECTURE_PROMPT = `You are Subagent B, Blindspot's Architecture & Auth reviewer.

Scope:
- First, USE the readFile tool to read \`.cursorrules\` or \`ARCHITECTURE.md\` to understand the project's internal engineering guidelines.
- You may use only the readFile tool. Do not request any other tool.
- Trace route changes, unhandled side effects, and authentication or middleware bypasses introduced by the diff.
- When a route or middleware file changes, read that file before concluding.
- Explicitly cross-reference the git diff against the guidelines in \`.cursorrules\` or \`ARCHITECTURE.md\`.
- If a change violates a documented rule, flag it as a violation and explicitly cite the rule from the document in the description.

${FINDING_FORMAT}`;

const SUBAGENT_LEGACY_PROMPT = `You are Subagent C, Blindspot's Legacy Modernization reviewer.

Scope:
- Scan the changed files for outdated idioms, deprecated syntax, and deprecated APIs.
- You may use only the readFile tool to inspect those changed files.
- For each issue, put the modern replacement in the Refactor suggestion block as the exact code fix.

${FINDING_FORMAT}`;

const MANAGER_PROMPT = `You are the Blindspot Manager Agent.

You receive independent reviews from three subagents: security (supply chain), architecture (routes, side effects, and auth), and legacy (modernization). You do not call tools.

Deduplicate overlapping observations that describe the same issue in the same file. When duplicates disagree on severity, keep the highest severity. Preserve 1-click refactor suggestion blocks from every subagent.

Return one cohesive Markdown document with exactly these sections, in this order:
## Summary
## Critical
## High
## Medium
## Low

Under each severity header, list the surviving findings. If a severity has no findings, write "_None._" under that header. Do not output JSON.`;

const SEVERITY_LEVELS = Object.freeze(["Critical", "High", "Medium", "Low"]);
const SEVERITY_RANK = Object.freeze({
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
});
const POPULAR_PACKAGES = Object.freeze([
  "react",
  "react-dom",
  "lodash",
  "express",
  "next",
  "axios",
  "chalk",
  "debug",
  "commander",
  "typescript",
  "webpack",
  "vue",
  "moment",
  "uuid",
  "semver",
  "request",
  "cors",
  "dotenv",
  "eslint",
  "prettier",
]);
const SOURCE_FILE = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;
const MAX_STUB_FILES = 8;

const DEFAULT_LOG_FILENAME = "bob-session-logs.json";
const DEFAULT_BOB_API_URL = "https://api.bob.ibm.com";
const BOB_AGENT_MAX_STEPS = 8;

/** @type {Map<string, Promise<import("node-llama-cpp").LlamaModel>>} */
const modelPromises = new Map();

/**
 * Clean JSON Schema tool definitions shared by node-llama-cpp function
 * calling and the Bob 2.0 Agent API.
 */
const TOOL_SCHEMAS = Object.freeze({
  readFile: {
    name: "readFile",
    description:
      "Reads the content of a local file to understand architectural context",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative file path",
        },
      },
      required: ["path"],
    },
  },
  readPackageJson: {
    name: "readPackageJson",
    description:
      "Reads package.json and returns the project's dependency manifests",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional repository-relative path to package.json (defaults to the project root)",
        },
      },
    },
  },
});

function getToolSchemas() {
  return JSON.parse(JSON.stringify(TOOL_SCHEMAS));
}

function toBobAgentTools(schemas = getToolSchemas()) {
  return Object.values(schemas).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

async function resolveWithinRepo(repositoryRoot, requestedPath) {
  const normalizedRoot = path.resolve(repositoryRoot);
  const absolutePath = path.resolve(
    path.join(repositoryRoot, requestedPath),
  );
  const relative = path.relative(normalizedRoot, absolutePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path "${requestedPath}" is outside the repository root`,
    );
  }

  const realRoot = await fs.realpath(normalizedRoot);
  let realPath;

  try {
    realPath = await fs.realpath(absolutePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }

    const realParent = await fs.realpath(path.dirname(absolutePath));
    realPath = path.join(realParent, path.basename(absolutePath));
  }

  const realRelative = path.relative(realRoot, realPath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(
      `Path "${requestedPath}" resolves to a location outside the repository root`,
    );
  }

  return realPath;
}

function createToolHandlers(repositoryRoot) {
  return {
    async readFile({ path: filePath } = {}) {
      try {
        const absolutePath = await resolveWithinRepo(repositoryRoot, filePath);
        if (filePath.toLowerCase().endsWith(".pdf")) {
          const buffer = await fs.readFile(absolutePath);
          const parsedData = await pdfParse(buffer);
          return { path: filePath, content: parsedData.text };
        }
        const content = await fs.readFile(absolutePath, "utf8");
        return { path: filePath, content };
      } catch (error) {
        if (error && error.code === "ENOENT") {
          return {
            path: filePath,
            content: "",
            note: "File was deleted or moved in this PR",
          };
        }
        const message =
          error instanceof Error ? error.message : "Failed to read file";
        return { path: filePath, error: message };
      }
    },
    async readPackageJson(params = {}) {
      const packageJsonPath = params?.path;
      try {
        const absolutePath = await resolveWithinRepo(
          repositoryRoot,
          packageJsonPath ?? "package.json",
        );
        const raw = await fs.readFile(absolutePath, "utf8");
        const manifest = JSON.parse(raw);

        return {
          path: packageJsonPath ?? "package.json",
          dependencies: manifest.dependencies ?? {},
          devDependencies: manifest.devDependencies ?? {},
          optionalDependencies: manifest.optionalDependencies ?? {},
          peerDependencies: manifest.peerDependencies ?? {},
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to read package.json";
        return { error: message };
      }
    },
  };
}

function createLlamaFunctions(repositoryRoot, defineChatSessionFunction) {
  const schemas = getToolSchemas();
  const handlers = createToolHandlers(repositoryRoot);

  return {
    readFile: defineChatSessionFunction({
      description: schemas.readFile.description,
      params: schemas.readFile.parameters,
      handler: handlers.readFile,
    }),
    readPackageJson: defineChatSessionFunction({
      description: schemas.readPackageJson.description,
      params: schemas.readPackageJson.parameters,
      handler: handlers.readPackageJson,
    }),
  };
}

/** @deprecated Use createLlamaFunctions with shared JSON schemas. */
function createReviewFunctions(repositoryRoot, defineChatSessionFunction) {
  return createLlamaFunctions(repositoryRoot, defineChatSessionFunction);
}

function createSessionData(provider, repositoryRoot, id = randomUUID()) {
  return {
    id,
    provider,
    startedAt: new Date().toISOString(),
    repositoryRoot: path.resolve(repositoryRoot),
    tokenUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    subagentTraces: [],
    toolCalls: [],
    execution: {},
  };
}

function mergeTokenUsage(sessionData, usage = {}) {
  const promptTokens = Number(usage.promptTokens ?? usage.prompt_tokens ?? 0);
  const completionTokens = Number(
    usage.completionTokens ?? usage.completion_tokens ?? 0,
  );
  const totalTokens = Number(
    usage.totalTokens ??
      usage.total_tokens ??
      promptTokens + completionTokens,
  );

  sessionData.tokenUsage.promptTokens += promptTokens;
  sessionData.tokenUsage.completionTokens += completionTokens;
  sessionData.tokenUsage.totalTokens += totalTokens;
}

function isTruthyEnv(value) {
  if (value == null) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function shouldExportLogs(options = {}) {
  return Boolean(
    options.exportLogs ||
      isTruthyEnv(process.env.EXPORT_LOGS) ||
      isTruthyEnv(process.env.BOB_EXPORT_LOGS),
  );
}

/**
 * Writes raw execution metadata, token usage, and subagent traces.
 *
 * @param {object} sessionData
 * @param {string} [filePath]
 * @returns {Promise<string>} Absolute path written
 */
async function exportSessionLogs(sessionData, filePath) {
  const target = path.resolve(
    filePath || path.join(process.cwd(), DEFAULT_LOG_FILENAME),
  );

  const payload = {
    exportedAt: new Date().toISOString(),
    id: sessionData?.id ?? null,
    provider: sessionData?.provider ?? null,
    startedAt: sessionData?.startedAt ?? null,
    finishedAt: sessionData?.finishedAt ?? null,
    repositoryRoot: sessionData?.repositoryRoot ?? null,
    tokenUsage: sessionData?.tokenUsage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    telemetry: sessionData?.telemetry ?? null,
    execution: sessionData?.execution ?? {},
    toolCalls: sessionData?.toolCalls ?? [],
    subagentTraces: sessionData?.subagentTraces ?? [],
    error: sessionData?.error ?? null,
  };

  await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
  return target;
}

function resolveEngineProvider(options = {}) {
  const raw = options.provider || process.env.ENGINE_PROVIDER || "bob";
  return String(raw).trim().toLowerCase();
}

function createBobClient() {
  const apiKey = process.env.BOB_API_KEY;
  if (!apiKey) {
    console.warn(
      "BOB_API_KEY is not configured. Falling back to local stub mode for review execution.",
    );
  }

  return {
    apiKey: apiKey || null,
    baseUrl: (process.env.BOB_API_URL || DEFAULT_BOB_API_URL).replace(
      /\/$/,
      "",
    ),
    teamId: process.env.BOB_TEAM_ID || null,
  };
}

async function executeToolCalls(toolCalls, handlers, sessionData, subagentId) {
  const startedAt = Date.now();
  const results = await Promise.all(
    toolCalls.map(async (call, index) => {
      const name = call.name || call.function?.name;
      const rawArgs = call.arguments ?? call.function?.arguments ?? {};
      const args =
        typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs;
      const handler = handlers[name];
      const callStarted = Date.now();

      let output;
      if (!handler) {
        output = { error: `Unknown tool "${name}"` };
      } else {
        output = await handler(args);
      }

      const record = {
        id: call.id || `tool-${index}`,
        name,
        arguments: args,
        output,
        durationMs: Date.now() - callStarted,
        subagentId: subagentId ?? null,
      };
      sessionData.toolCalls.push(record);

      return {
        tool_call_id: record.id,
        name,
        output,
      };
    }),
  );

  sessionData.subagentTraces.push({
    id: subagentId || `tool-batch-${sessionData.subagentTraces.length + 1}`,
    type: "parallel_tool_calls",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    toolCallIds: results.map((result) => result.tool_call_id),
  });

  return results;
}

const NOISY_DIFF_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);
const NOISY_DIFF_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".pdf",
  ".ico",
  ".wasm",
  ".sqlite",
]);
const NOISY_DIFF_DIRECTORIES = new Set(["dist", ".next", "build"]);

function isNoisyDiffPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const basename = (segments[segments.length - 1] || "").toLowerCase();

  if (NOISY_DIFF_BASENAMES.has(basename)) {
    return true;
  }

  if (/\.min\.(js|css)$/i.test(basename)) {
    return true;
  }

  if (
    segments.some((segment) =>
      NOISY_DIFF_DIRECTORIES.has(segment.toLowerCase()),
    )
  ) {
    return true;
  }

  const extension = path.extname(basename).toLowerCase();
  return NOISY_DIFF_EXTENSIONS.has(extension);
}

function parseDiffFiles(diff) {
  const files = [];
  let current = null;

  for (const line of String(diff || "").split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      if (isNoisyDiffPath(header[1]) || isNoisyDiffPath(header[2])) {
        current = null;
        continue;
      }
      current = { path: header[2], added: [], removed: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("index ") ||
      line.startsWith("\\")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      current.added.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
    }
  }

  return files;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function recordEstimatedUsage(sessionData, promptText, completionText) {
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  mergeTokenUsage(sessionData, {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });
  sessionData.tokenUsage.estimated = true;
}

function selectToolSchemas(names) {
  const schemas = getToolSchemas();
  const selected = {};
  for (const name of names) {
    if (schemas[name]) {
      selected[name] = schemas[name];
    }
  }
  return selected;
}

function restrictHandlers(handlers, names) {
  const allowed = new Set(names);
  return Object.fromEntries(
    Object.entries(handlers).filter(([name]) => allowed.has(name)),
  );
}

function normalizeSeverity(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("crit")) {
    return "Critical";
  }
  if (raw.startsWith("high")) {
    return "High";
  }
  if (raw.startsWith("med")) {
    return "Medium";
  }
  return "Low";
}

function levenshtein(left, right) {
  if (Math.abs(left.length - right.length) > 2) {
    return 99;
  }
  const rows = Array.from({ length: right.length + 1 }, (_, index) => [index]);
  for (let i = 0; i <= left.length; i += 1) {
    rows[0][i] = i;
  }
  for (let y = 1; y <= right.length; y += 1) {
    for (let x = 1; x <= left.length; x += 1) {
      const cost = left[x - 1] === right[y - 1] ? 0 : 1;
      rows[y][x] = Math.min(
        rows[y - 1][x] + 1,
        rows[y][x - 1] + 1,
        rows[y - 1][x - 1] + cost,
      );
    }
  }
  return rows[right.length][left.length];
}

function findingTokens(finding) {
  return new Set(
    `${finding.title} ${finding.description}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
}

function jaccard(left, right) {
  if (!left.size || !right.size) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function findingsOverlap(left, right) {
  if (!left.file || !right.file || left.file !== right.file) {
    return false;
  }
  if (left.title.trim().toLowerCase() === right.title.trim().toLowerCase()) {
    return true;
  }
  return jaccard(findingTokens(left), findingTokens(right)) >= 0.45;
}

function mergeFindingPair(left, right) {
  const primary = (SEVERITY_RANK[left.severity] || 0) >= (SEVERITY_RANK[right.severity] || 0)
    ? left
    : right;
  const secondary = primary === left ? right : left;
  return {
    ...primary,
    description: primary.description || secondary.description,
    recommendation: primary.recommendation || secondary.recommendation,
    refactor: primary.refactor || secondary.refactor,
    sources: [...new Set([...(left.sources || []), ...(right.sources || [])])],
    placeholder: Boolean(left.placeholder && right.placeholder),
  };
}

function dedupeFindings(findings) {
  const real = findings.filter((finding) => finding && !finding.placeholder && finding.title);
  const merged = [];

  for (const finding of real) {
    const existingIndex = merged.findIndex((candidate) =>
      findingsOverlap(candidate, finding),
    );
    if (existingIndex === -1) {
      merged.push({
        ...finding,
        sources: [...(finding.sources || [])],
      });
    } else {
      merged[existingIndex] = mergeFindingPair(merged[existingIndex], finding);
    }
  }

  return merged.sort(
    (left, right) =>
      (SEVERITY_RANK[right.severity] || 0) - (SEVERITY_RANK[left.severity] || 0),
  );
}

function parseFindings(markdown, source) {
  const chunks = String(markdown || "").split(/^### /m).slice(1);
  const findings = chunks
    .map((chunk) => {
      const [titleLine, ...rest] = chunk.split(/\r?\n/);
      const body = rest.join("\n");
      const severity = normalizeSeverity(
        (body.match(/\*\*Severity:\*\*\s*(.+)/i) || [])[1],
      );
      const file = ((body.match(/\*\*File:\*\*\s*`?([^`\n]+)`?/) || [])[1] || "")
        .trim();
      const description = (
        (body.match(/\*\*Description:\*\*\s*(.+)/i) || [])[1] || ""
      ).trim();
      const recommendation = (
        (body.match(/\*\*Recommendation:\*\*\s*(.+)/i) || [])[1] || ""
      ).trim();
      const refactorMatch = body.match(/```suggestion\s*([\s\S]*?)```/);
      const title = titleLine.trim();
      return {
        title,
        severity,
        file,
        description,
        recommendation,
        refactor: refactorMatch ? refactorMatch[1].trim() : "",
        sources: [source],
        placeholder: /no issues observed/i.test(title),
      };
    })
    .filter((finding) => finding.title);

  if (!findings.length && String(markdown || "").trim()) {
    return [
      {
        title: `${source} review notes`,
        severity: "Low",
        file: "n/a",
        description: String(markdown).trim().slice(0, 4000),
        recommendation: "Review the subagent notes and confirm whether they describe a distinct issue.",
        refactor: "",
        sources: [source],
        placeholder: false,
      },
    ];
  }

  return findings;
}

function renderFinding(finding) {
  const lines = [
    `### ${finding.title}`,
    `- **File:** \`${finding.file || "n/a"}\``,
    `- **Sources:** ${(finding.sources || []).join(", ") || "manager"}`,
    `- **Description:** ${finding.description || "No description provided."}`,
    `- **Recommendation:** ${finding.recommendation || "Review this change before merging."}`,
  ];

  if (finding.refactor) {
    lines.push("- **Refactor:**", "```suggestion", finding.refactor, "```");
  }

  return lines.join("\n");
}

function formatConsolidatedReport(findings) {
  const deduped = dedupeFindings(findings);
  const buckets = {
    Critical: [],
    High: [],
    Medium: [],
    Low: [],
  };

  for (const finding of deduped) {
    const severity = buckets[finding.severity] ? finding.severity : "Low";
    buckets[severity].push(finding);
  }

  const summary = [
    "## Summary",
    "Consolidated review from Security & Supply Chain, Architecture & Auth, and Legacy Modernization.",
    deduped.length
      ? `${deduped.length} unique finding${deduped.length === 1 ? "" : "s"} remain after overlapping observations were merged.`
      : "No issues were reported by the subagents.",
  ].join("\n");

  const sections = SEVERITY_LEVELS.map((level) => {
    const items = buckets[level];
    const body = items.length
      ? items.map((finding) => renderFinding(finding)).join("\n\n")
      : "_None._";
    return `## ${level}\n${body}`;
  });

  return [summary, ...sections].join("\n\n");
}

function hasSeverityHeaders(markdown) {
  return SEVERITY_LEVELS.every((level) =>
    String(markdown || "").includes(`## ${level}`),
  );
}

function makeFinding({
  title,
  severity,
  file,
  description,
  recommendation,
  refactor = "",
  source,
  placeholder = false,
}) {
  return {
    title,
    severity: normalizeSeverity(severity),
    file,
    description,
    recommendation,
    refactor,
    sources: [source],
    placeholder,
  };
}

function renderSubagentMarkdown(findings) {
  if (!findings.length) {
    return [
      "### No issues observed",
      "- **Severity:** Low",
      "- **File:** `n/a`",
      "- **Description:** Nothing in scope was flagged.",
      "- **Recommendation:** No change required from this subagent.",
    ].join("\n");
  }

  return findings.map((finding) => renderFinding(finding)).join("\n\n");
}

function extractChangedPackageJsonPaths(diff) {
  return parseDiffFiles(diff)
    .map((file) => file.path)
    .filter((filePath) => filePath.endsWith("package.json"));
}

function extractDependencyAdditions(diff) {
  const additions = [];
  let packageJsonPath = null;
  let section = null;

  for (const line of String(diff || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      packageJsonPath =
        header && header[2].endsWith("package.json") ? header[2] : null;
      section = null;
      continue;
    }
    if (!packageJsonPath) {
      continue;
    }

    const sectionMatch = line
      .replace(/^[+-]/, "")
      .match(
        /"(dependencies|devDependencies|optionalDependencies|peerDependencies)"\s*:/,
      );
    if (sectionMatch) {
      section = sectionMatch[1];
    }
    if (!section || !line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }

    const dependencyMatch = line.match(/^\+\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?/);
    if (dependencyMatch && !dependencyMatch[1].startsWith("/")) {
      additions.push({
        packageJsonPath,
        section,
        name: dependencyMatch[1],
        version: dependencyMatch[2],
      });
    }
  }

  return additions;
}

function classifyDependency(dep) {
  const notes = [];
  const name = dep.name;
  const version = String(dep.version || "");

  for (const popular of POPULAR_PACKAGES) {
    if (name !== popular && levenshtein(name, popular) === 1) {
      notes.push({
        severity: "Critical",
        title: `Possible typosquat of ${popular}`,
        description: `"${name}" in ${dep.section} is one character edit away from the package "${popular}".`,
        recommendation:
          "Confirm the package name against the intended dependency before installing or merging.",
      });
      break;
    }
  }

  if (/^(git\+|git:|github:|http:|file:)/i.test(version) || version.includes("://")) {
    notes.push({
      severity: "Critical",
      title: "Dependency specifier is outside the registry",
      description: `"${name}" is pinned to \`${version}\`, which is not a normal registry version and can be used for dependency poisoning.`,
        recommendation:
          "Replace the specifier with a pinned registry version and update the lockfile.",
    });
  } else if (/^(latest|\*|x)$/i.test(version) || /(^|\.)x(\.|$)/i.test(version)) {
    notes.push({
      severity: "High",
      title: "Unpinned dependency update",
      description: `"${name}" uses the floating specifier \`${version}\` in ${dep.section}.`,
      recommendation: "Pin an exact version and commit the lockfile with the update.",
    });
  }

  return notes;
}

async function readChangedFiles(filePaths, handlers, session, predicate) {
  const selected = filePaths.filter(predicate).slice(0, MAX_STUB_FILES);
  if (!selected.length) {
    return [];
  }

  return executeToolCalls(
    selected.map((filePath, index) => ({
      id: `${session.id}-readFile-${index + 1}`,
      name: "readFile",
      arguments: { path: filePath },
    })),
    handlers,
    session,
    session.id,
  );
}

async function runSecurityStub(diff, handlers, session) {
  const changedManifests = extractChangedPackageJsonPaths(diff);
  const additions = extractDependencyAdditions(diff);
  const packageChanged = changedManifests.length > 0;
  const primaryManifest = changedManifests[0] || "package.json";
  const manifestsToRead = packageChanged
    ? changedManifests
    : additions.length
      ? ["package.json"]
      : [];
  const findings = [];

  if (manifestsToRead.length) {
    await executeToolCalls(
      manifestsToRead.map((manifestPath, index) => ({
        id: `${session.id}-readPackageJson-${index + 1}`,
        name: "readPackageJson",
        arguments: { path: manifestPath },
      })),
      handlers,
      session,
      session.id,
    );
  }

  for (const dep of additions) {
    for (const note of classifyDependency(dep)) {
      findings.push(
        makeFinding({
          ...note,
          file: dep.packageJsonPath || primaryManifest,
          source: "security",
        }),
      );
    }
  }

  if (!findings.length) {
    findings.push(
      makeFinding({
        title: "No issues observed",
        severity: "Low",
        file: primaryManifest,
        description: packageChanged
          ? `${primaryManifest} changed, and the added dependency specifiers did not match typosquatting, poisoning, or unpinned-update checks.`
          : "The diff does not change a dependency manifest.",
        recommendation: "No supply-chain action is indicated by this diff.",
        source: "security",
        placeholder: true,
      }),
    );
  }

  return findings;
}

async function runArchitectureStub(diff, handlers, session) {
  const files = parseDiffFiles(diff);
  await readChangedFiles(
    files.map((file) => file.path),
    handlers,
    session,
    (filePath) => SOURCE_FILE.test(filePath),
  );

  const findings = [];
  const routePattern =
    /(?:^|\/)(?:route|middleware)\.(?:js|jsx|ts|tsx|mjs)$|(?:^|\/)pages\/api\/|(?:^|\/)app\/api\//;

  for (const file of files) {
    const added = file.added.join("\n");
    const removed = file.removed.join("\n");
    const isRoute = routePattern.test(file.path);
    const removedAuth = /\b(auth|middleware|session|verify|jwt)\b/i.test(removed);
    const addedHandler = /\b(export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)|export\s+default)\b/.test(
      added,
    );
    const mentionsAuth = /\b(auth|middleware|session|jwt|getServerSession|requireAuth|withAuth)\b/i.test(
      `${added}\n${removed}`,
    );

    if (removedAuth) {
      findings.push(
        makeFinding({
          title: "Authentication or middleware check removed",
          severity: "High",
          file: file.path,
          description:
            "The diff deletes a line that referenced authentication, session handling, or middleware.",
          recommendation:
            "Confirm the route is still covered by an authentication check or shared middleware.",
          source: "architecture",
        }),
      );
    } else if (isRoute && addedHandler && !mentionsAuth) {
      findings.push(
        makeFinding({
          title: "Route change without a visible auth check",
          severity: "Medium",
          file: file.path,
          description:
            "A route handler was added or changed, and the diff does not show an authentication or middleware check.",
          recommendation:
            "Trace the middleware chain for this route and confirm unauthenticated callers cannot reach it.",
          source: "architecture",
        }),
      );
    }

    if (/\b(child_process|execSync|spawn\(|eval\()/.test(added)) {
      findings.push(
        makeFinding({
          title: "Unhandled process or evaluation side effect",
          severity: "High",
          file: file.path,
          description:
            "Added lines call process execution or eval. The diff does not show a guard around that side effect.",
          recommendation:
            "Remove the dynamic execution or constrain it to a reviewed, non-user-controlled input.",
          source: "architecture",
        }),
      );
    }
  }

  if (!findings.length) {
    findings.push(
      makeFinding({
        title: "No issues observed",
        severity: "Low",
        file: "n/a",
        description:
          "Changed files did not show new routes, removed auth checks, or process side effects.",
        recommendation: "No architecture follow-up is indicated by this diff.",
        source: "architecture",
        placeholder: true,
      }),
    );
  }

  return findings;
}

const LEGACY_RULES = [
  {
    pattern: /\bvar\s+([A-Za-z_$][\w$]*)\b/,
    severity: "Low",
    title: "var declaration",
    description: "Added code uses var, which is function-scoped and leaks outside blocks.",
    recommendation: "Use const, or let when the binding is reassigned.",
    refactor(line) {
      return line.replace(/\bvar\b/, "const");
    },
  },
  {
    pattern: /\bnew Buffer\s*\(/,
    severity: "Medium",
    title: "Deprecated Buffer constructor",
    description: "new Buffer() is deprecated and can expose uninitialized memory on older Node versions.",
    recommendation: "Construct the buffer with Buffer.from().",
    refactor(line) {
      return line.replace(/\bnew Buffer\s*\(/, "Buffer.from(");
    },
  },
  {
    pattern: /\.substr\s*\(/,
    severity: "Low",
    title: "Deprecated String.prototype.substr",
    description: "substr() is a legacy string API.",
    recommendation: "Use slice() with an explicit end index.",
    refactor(line) {
      return line.replace(/\.substr\s*\(\s*([^,)]+)\s*,\s*([^)]+)\)/, ".slice($1, $1 + $2)");
    },
  },
  {
    pattern: /\burl\.parse\s*\(/,
    severity: "Medium",
    title: "Deprecated url.parse",
    description: "url.parse() is legacy and has surprising parsing behavior.",
    recommendation: "Parse the URL with the WHATWG URL constructor.",
    refactor(line) {
      return line.replace(/\burl\.parse\s*\(/, "new URL(");
    },
  },
  {
    pattern: /\bfs\.exists\s*\(/,
    severity: "Low",
    title: "Deprecated fs.exists",
    description: "fs.exists() is deprecated.",
    recommendation: "Check presence with fs.access() or fs.stat().",
    refactor(line) {
      return line.replace(/\bfs\.exists\s*\(/, "fs.access(");
    },
  },
  {
    pattern: /\bcomponentWillMount\b/,
    severity: "Medium",
    title: "Deprecated React lifecycle",
    description: "componentWillMount is an unsafe legacy React lifecycle.",
    recommendation: "Move the work into the constructor or a useEffect hook.",
    refactor() {
      return "useEffect(() => {\n  // migrated from componentWillMount\n}, []);";
    },
  },
];

async function runLegacyStub(diff, handlers, session) {
  const files = parseDiffFiles(diff);
  await readChangedFiles(
    files.map((file) => file.path),
    handlers,
    session,
    (filePath) =>
      SOURCE_FILE.test(filePath) && path.basename(filePath) !== "package.json",
  );

  const findings = [];
  const seen = new Set();

  for (const file of files) {
    if (!SOURCE_FILE.test(file.path)) {
      continue;
    }
    for (const line of file.added) {
      for (const rule of LEGACY_RULES) {
        if (!rule.pattern.test(line)) {
          continue;
        }
        const key = `${file.path}:${rule.title}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        findings.push(
          makeFinding({
            title: rule.title,
            severity: rule.severity,
            file: file.path,
            description: rule.description,
            recommendation: rule.recommendation,
            refactor: rule.refactor(line.trim()),
            source: "legacy",
          }),
        );
      }
    }
  }

  if (!findings.length) {
    findings.push(
      makeFinding({
        title: "No issues observed",
        severity: "Low",
        file: "n/a",
        description: "Added lines did not match the legacy idiom or deprecated API checks.",
        recommendation: "No modernization refactor was generated.",
        source: "legacy",
        placeholder: true,
      }),
    );
  }

  return findings;
}

function absorbSubagentSession(parent, child) {
  parent.toolCalls.push(...child.toolCalls);
  parent.subagentTraces.push({
    id: child.id,
    role: child.role || null,
    type: "subagent",
    startedAt: child.startedAt,
    finishedAt: child.finishedAt ?? null,
    durationMs: child.execution?.durationMs ?? null,
    mode: child.execution?.mode ?? null,
    status: child.execution?.status ?? null,
    tokenUsage: { ...(child.tokenUsage || {}) },
    toolCallCount: child.toolCalls.length,
  });

  for (const trace of child.subagentTraces) {
    parent.subagentTraces.push({
      ...trace,
      parentSessionId: child.id,
    });
  }
}

function buildMergedTelemetry(reviewSessionId, agentResults, wallClockMs) {
  const tokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimated: false,
  };
  const sessions = {};

  for (const agent of agentResults) {
    const usage = agent.session.tokenUsage || {};
    tokenUsage.promptTokens += Number(usage.promptTokens || 0);
    tokenUsage.completionTokens += Number(usage.completionTokens || 0);
    tokenUsage.totalTokens += Number(usage.totalTokens || 0);
    tokenUsage.estimated = tokenUsage.estimated || Boolean(usage.estimated);
    sessions[agent.session.id] = {
      role: agent.role,
      tokenUsage: { ...usage },
      durationMs: agent.session.execution?.durationMs ?? null,
      mode: agent.session.execution?.mode ?? null,
      status: agent.session.execution?.status ?? null,
      toolCallCount: agent.session.toolCalls.length,
    };
  }

  return {
    reviewSessionId,
    sessionIds: agentResults.map((agent) => agent.session.id),
    tokenUsage,
    sessions,
    execution: {
      parallelSubagents: agentResults
        .filter((agent) => agent.role !== "manager")
        .map((agent) => agent.role),
      manager: "manager",
      durationMs: wallClockMs,
      agents: agentResults.map((agent) => ({
        sessionId: agent.session.id,
        role: agent.role,
        durationMs: agent.session.execution?.durationMs ?? null,
        mode: agent.session.execution?.mode ?? null,
        status: agent.session.execution?.status ?? null,
        toolCallCount: agent.session.toolCalls.length,
      })),
    },
  };
}

async function invokeBobAgent(client, payload) {
  const url = `${client.baseUrl}/v2/agent/run`;
  const headers = {
    Authorization: `Bearer ${client.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (client.teamId) {
    headers["X-IBM-Bob-Team-Id"] = client.teamId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      `IBM Bob 2.0 agent request failed with status ${response.status}`,
    );
    error.status = response.status;
    error.body = data;
    throw error;
  }

  return data;
}

function normalizeBobResponse(data) {
  const message = data.message || data.choices?.[0]?.message || data;
  const toolCalls = message.tool_calls || data.tool_calls || [];
  const content =
    message.content || data.content || data.output_text || data.analysis || "";
  const usage = data.usage || data.token_usage || {};
  const subagents = data.subagents || data.subagent_traces || [];

  return { content, toolCalls, usage, subagents, finished: !toolCalls.length };
}

const SUBAGENT_SPECS = Object.freeze([
  {
    role: "security",
    systemPrompt: SUBAGENT_SECURITY_PROMPT,
    allowedTools: ["readPackageJson"],
    stub: runSecurityStub,
  },
  {
    role: "architecture",
    systemPrompt: SUBAGENT_ARCHITECTURE_PROMPT,
    allowedTools: ["readFile"],
    stub: runArchitectureStub,
  },
  {
    role: "legacy",
    systemPrompt: SUBAGENT_LEGACY_PROMPT,
    allowedTools: ["readFile"],
    stub: runLegacyStub,
  },
]);

function finishSubagentSession(session, startedMs) {
  session.finishedAt = new Date().toISOString();
  session.execution.durationMs = Date.now() - startedMs;
  if (!session.execution.status) {
    session.execution.status = "ok";
  }
}

async function runBobSubagent({
  spec,
  diff,
  client,
  handlers,
  useLiveApi,
  repositoryRoot,
}) {
  const session = createSessionData(
    "bob",
    repositoryRoot,
    `bob-${spec.role}-${randomUUID()}`,
  );
  session.role = spec.role;
  const startedMs = Date.now();
  session.execution = {
    engine: "bob-2.0",
    role: spec.role,
    tools: [...spec.allowedTools],
    mode: useLiveApi ? "live" : "stub",
  };

  const scopedHandlers = restrictHandlers(handlers, spec.allowedTools);
  let findings = [];
  let markdown = "";

  try {
    if (!useLiveApi) {
      findings = await spec.stub(diff, scopedHandlers, session);
      markdown = renderSubagentMarkdown(findings);
      recordEstimatedUsage(session, `${spec.systemPrompt}\n${diff}`, markdown);
    } else {
      markdown = await runBobAgentLoop(
        client,
        scopedHandlers,
        toBobAgentTools(selectToolSchemas(spec.allowedTools)),
        [
          { role: "system", content: spec.systemPrompt },
          { role: "user", content: diff },
        ],
        session,
        spec.systemPrompt,
      );
      findings = parseFindings(markdown, spec.role);
      if (!session.tokenUsage.totalTokens) {
        recordEstimatedUsage(session, `${spec.systemPrompt}\n${diff}`, markdown);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Subagent failed";
    session.execution.liveError = message;
    session.execution.mode = "stub";
    session.subagentTraces.push({
      id: `${session.id}-fallback`,
      type: "fallback_to_stub",
      error: message,
    });
    findings = await spec.stub(diff, scopedHandlers, session);
    markdown = renderSubagentMarkdown(findings);
    recordEstimatedUsage(session, `${spec.systemPrompt}\n${diff}`, markdown);
  }

  finishSubagentSession(session, startedMs);
  return {
    id: session.id,
    role: spec.role,
    markdown,
    findings,
    session,
  };
}

async function runManagerPass({
  subagentResults,
  client,
  useLiveApi,
  repositoryRoot,
}) {
  const session = createSessionData(
    "bob",
    repositoryRoot,
    `bob-manager-${randomUUID()}`,
  );
  session.role = "manager";
  const startedMs = Date.now();
  session.execution = {
    engine: "bob-2.0",
    role: "manager",
    tools: [],
    mode: useLiveApi ? "live" : "stub",
  };

  const collected = subagentResults.flatMap((result) =>
    result.findings?.length
      ? result.findings
      : parseFindings(result.markdown, result.role),
  );
  const combined = subagentResults
    .map(
      (result) =>
        `## Subagent ${result.role} (${result.id})\n\n${result.markdown}`,
    )
    .join("\n\n");
  let markdown = formatConsolidatedReport(collected);

  if (!useLiveApi) {
    recordEstimatedUsage(session, `${MANAGER_PROMPT}\n${combined}`, markdown);
  } else {
    try {
      const liveMarkdown = await runBobAgentLoop(
        client,
        {},
        [],
        [
          { role: "system", content: MANAGER_PROMPT },
          { role: "user", content: combined },
        ],
        session,
        MANAGER_PROMPT,
      );
      if (hasSeverityHeaders(liveMarkdown)) {
        markdown = liveMarkdown;
      }
      if (!session.tokenUsage.totalTokens) {
        recordEstimatedUsage(
          session,
          `${MANAGER_PROMPT}\n${combined}`,
          markdown,
        );
      }
    } catch (error) {
      session.execution.mode = "stub";
      session.execution.liveError =
        error instanceof Error ? error.message : "Manager request failed";
      session.subagentTraces.push({
        id: `${session.id}-fallback`,
        type: "fallback_to_stub",
        error: session.execution.liveError,
      });
      recordEstimatedUsage(session, `${MANAGER_PROMPT}\n${combined}`, markdown);
    }
  }

  finishSubagentSession(session, startedMs);
  return {
    id: session.id,
    role: "manager",
    markdown,
    session,
  };
}

/**
 * IBM Bob review: three specialized subagents run concurrently, then a
 * manager pass deduplicates their findings into one Markdown report.
 *
 * @param {string} diff
 * @param {string} repositoryRoot
 * @param {object} sessionData
 * @returns {Promise<{ markdown: string, telemetry: object }>}
 */
async function runBobReviewAgent(diff, repositoryRoot, sessionData) {
  const client = createBobClient();
  const handlers = createToolHandlers(repositoryRoot);
  const useLiveApi =
    Boolean(client.apiKey) &&
    (isTruthyEnv(process.env.BOB_LIVE_API) || Boolean(process.env.BOB_API_URL));
  const startedMs = Date.now();

  sessionData.execution = {
    engine: "bob-2.0",
    baseUrl: client.baseUrl,
    teamId: client.teamId,
    mode: useLiveApi ? "live" : "stub",
    parallelSubagents: SUBAGENT_SPECS.map((spec) => spec.role),
  };

  const subagentResults = await Promise.all(
    SUBAGENT_SPECS.map((spec) =>
      runBobSubagent({
        spec,
        diff,
        client,
        handlers,
        useLiveApi,
        repositoryRoot,
      }),
    ),
  );

  const managerResult = await runManagerPass({
    subagentResults,
    client,
    useLiveApi,
    repositoryRoot,
  });
  const agentResults = [...subagentResults, managerResult];

  for (const result of agentResults) {
    absorbSubagentSession(sessionData, result.session);
  }

  const telemetry = buildMergedTelemetry(
    sessionData.id,
    agentResults,
    Date.now() - startedMs,
  );
  sessionData.tokenUsage = { ...telemetry.tokenUsage };
  sessionData.telemetry = telemetry;
  sessionData.execution.durationMs = telemetry.execution.durationMs;
  sessionData.execution.sessionIds = telemetry.sessionIds;

  return {
    markdown: managerResult.markdown,
    telemetry,
  };
}

async function runBobAgentLoop(
  client,
  handlers,
  tools,
  messages,
  sessionData,
  systemPrompt = SYSTEM_PROMPT,
) {
  sessionData.execution.mode = sessionData.execution.mode || "live";

  for (let step = 0; step < BOB_AGENT_MAX_STEPS; step += 1) {
    const data = await invokeBobAgent(client, {
      model: process.env.BOB_MODEL || "bob-2.0",
      system: systemPrompt,
      messages,
      tools,
      parallel_tool_calls: tools.length > 0,
    });

    mergeTokenUsage(sessionData, data.usage || data.token_usage);
    const normalized = normalizeBobResponse(data);

    for (const trace of normalized.subagents) {
      sessionData.subagentTraces.push({
        ...trace,
        step,
      });
    }

    if (normalized.toolCalls.length) {
      const toolResults = await executeToolCalls(
        normalized.toolCalls,
        handlers,
        sessionData,
        sessionData.id || `bob-step-${step + 1}`,
      );
      messages.push({
        role: "assistant",
        content: normalized.content || "",
        tool_calls: normalized.toolCalls,
      });
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResults),
      });
      continue;
    }

    if (normalized.content) {
      return normalized.content;
    }
  }

  throw new Error("IBM Bob 2.0 agent exceeded the maximum tool-calling steps.");
}

async function loadModel(modelPath) {
  const resolvedModelPath = path.resolve(modelPath);

  if (!modelPromises.has(resolvedModelPath)) {
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama();
    modelPromises.set(
      resolvedModelPath,
      llama.loadModel({ modelPath: resolvedModelPath }),
    );
  }

  return modelPromises.get(resolvedModelPath);
}

/**
 * Local node-llama-cpp ReAct review agent (ENGINE_PROVIDER=llama).
 *
 * @param {string} diff
 * @param {string} repositoryRoot
 * @param {string} modelPath
 * @param {object} [sessionData]
 * @returns {Promise<string>} Markdown analysis
 */
async function runLlamaReviewAgent(
  diff,
  repositoryRoot,
  modelPath,
  sessionData = createSessionData("llama", repositoryRoot),
) {
  const resolvedRepoRoot = path.resolve(repositoryRoot);
  const resolvedModelPath = path.resolve(modelPath);

  await fs.access(resolvedModelPath);
  await fs.access(resolvedRepoRoot);

  const { defineChatSessionFunction, LlamaChatSession } = await import(
    "node-llama-cpp"
  );

  const model = await loadModel(resolvedModelPath);
  const context = await model.createContext();
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: SYSTEM_PROMPT,
  });

  const functions = createLlamaFunctions(
    resolvedRepoRoot,
    defineChatSessionFunction,
  );

  sessionData.execution = {
    engine: "node-llama-cpp",
    modelPath: resolvedModelPath,
    tools: Object.keys(TOOL_SCHEMAS),
  };

  const analysis = await session.prompt(diff, {
    functions,
    maxTokens: 2048,
    temperature: 0.2,
  });

  return analysis;
}

/**
 * Run the Blindspot ReAct review agent against a git diff.
 *
 * @param {string} diff
 * @param {string} repositoryRoot
 * @param {string} modelPath
 * @param {{ provider?: string, exportLogs?: boolean, logPath?: string }} [options]
 * @returns {Promise<{ markdown: string, telemetry: object }>}
 */
async function runReviewAgent(diff, repositoryRoot, modelPath, options = {}) {
  const provider = resolveEngineProvider(options);
  const sessionData = createSessionData(provider, repositoryRoot);
  const logPath =
    options.logPath || path.join(process.cwd(), DEFAULT_LOG_FILENAME);
  const startedMs = Date.now();

  try {
    let markdown = "";
    let telemetry = null;

    if (provider === "llama") {
      markdown = await runLlamaReviewAgent(
        diff,
        repositoryRoot,
        modelPath,
        sessionData,
      );
    } else if (provider === "bob") {
      const result = await runBobReviewAgent(diff, repositoryRoot, sessionData);
      markdown = result.markdown;
      telemetry = result.telemetry;
    } else {
      throw new Error(
        `Unknown ENGINE_PROVIDER "${provider}". Use "bob" or "llama".`,
      );
    }

    if (sessionData.execution.durationMs == null) {
      sessionData.execution.durationMs = Date.now() - startedMs;
    }
    sessionData.finishedAt = new Date().toISOString();
    sessionData.execution.status = "ok";

    if (!telemetry) {
      telemetry = {
        reviewSessionId: sessionData.id,
        sessionIds: [sessionData.id],
        tokenUsage: { ...sessionData.tokenUsage },
        sessions: {
          [sessionData.id]: {
            role: provider,
            tokenUsage: { ...sessionData.tokenUsage },
            durationMs: sessionData.execution.durationMs ?? null,
            mode: sessionData.execution.mode ?? null,
            status: sessionData.execution.status,
            toolCallCount: sessionData.toolCalls.length,
          },
        },
        execution: {
          parallelSubagents: [],
          manager: null,
          durationMs: sessionData.execution.durationMs ?? null,
          agents: [],
        },
      };
      sessionData.telemetry = telemetry;
    }

    return { markdown, telemetry };
  } catch (error) {
    sessionData.finishedAt = new Date().toISOString();
    sessionData.execution.status = "error";
    sessionData.error =
      error instanceof Error ? error.message : "Unknown review engine error";
    throw error;
  } finally {
    if (shouldExportLogs(options)) {
      await exportSessionLogs(sessionData, logPath);
    }
  }
}

module.exports = {
  MANAGER_PROMPT,
  SUBAGENT_ARCHITECTURE_PROMPT,
  SUBAGENT_LEGACY_PROMPT,
  SUBAGENT_SECURITY_PROMPT,
  SYSTEM_PROMPT,
  TOOL_SCHEMAS,
  createLlamaFunctions,
  createReviewFunctions,
  createToolHandlers,
  exportSessionLogs,
  getToolSchemas,
  resolveWithinRepo,
  runLlamaReviewAgent,
  runReviewAgent,
  toBobAgentTools,
};
