import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MOCK_REPO_DIR = path.join(PROJECT_ROOT, "evals", "mock-repo");
const BLINDSPOT_DATA_PATH = path.join(PROJECT_ROOT, ".blindspot-data.json");
const REVIEW_URL = "http://localhost:3000/api/review";

const JSON_FALLBACK_REGEX = /\{[\s\S]*\}/;

const SCENARIOS = [
  {
    name: "Middleware Bypass",
    description:
      "New dashboard settings route queries sensitive data, but middleware only protects /admin",
    files: {
      "middleware.ts": `import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const token = request.cookies.get("auth-token");

  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
`,
    },
    diff: `diff --git a/app/dashboard/settings/page.tsx b/app/dashboard/settings/page.tsx
new file mode 100644
index 0000000..a1b2c3d
--- /dev/null
+++ b/app/dashboard/settings/page.tsx
@@ -0,0 +1,18 @@
+"use client";
+
+import { useEffect, useState } from "react";
+
+export default function SettingsPage() {
+  const [secrets, setSecrets] = useState<Record<string, string>>({});
+
+  useEffect(() => {
+    fetch("/api/internal/admin-secrets")
+      .then((res) => res.json())
+      .then(setSecrets);
+  }, []);
+
+  return (
+    <main>
+      <h1>Account Settings</h1>
+      <pre>{JSON.stringify(secrets, null, 2)}</pre>
+    </main>
+  );
+}
`,
  },
  {
    name: "Supply Chain Poisoning",
    description:
      'Dependency swap from "lodash" to suspicious typosquat "lodash-utils"',
    files: {
      "package.json": JSON.stringify(
        {
          name: "acme-dashboard",
          version: "1.0.0",
          private: true,
          dependencies: {
            "lodash-utils": "^4.17.21",
            react: "^19.0.0",
            "next": "^15.0.0",
          },
        },
        null,
        2,
      ),
    },
    diff: `diff --git a/package.json b/package.json
index 1234567..89abcdef 100644
--- a/package.json
+++ b/package.json
@@ -4,7 +4,7 @@
   "version": "1.0.0",
   "private": true,
   "dependencies": {
-    "lodash": "^4.17.21",
+    "lodash-utils": "^4.17.21",
     "react": "^19.0.0",
     "next": "^15.0.0"
   }
`,
  },
];

function parseAnalysisPayload(analysis) {
  if (!analysis) {
    return null;
  }

  if (typeof analysis === "object") {
    return analysis;
  }

  const trimmed = analysis.trim();
  const jsonMatch = trimmed.match(JSON_FALLBACK_REGEX);

  if (!jsonMatch) {
    return { analysis: trimmed };
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { analysis: trimmed };
  }
}

function normalizeIssues(analysis) {
  const issues = analysis.issues ?? analysis.findings;

  if (!Array.isArray(issues)) {
    return [];
  }

  return issues.filter(
    (issue) =>
      typeof issue === "object" &&
      issue !== null &&
      typeof issue.title === "string",
  );
}

function riskColor(riskLevel) {
  const normalized = (riskLevel ?? "").toLowerCase();

  if (normalized === "high" || normalized === "critical") {
    return "\x1b[31m";
  }

  if (normalized === "medium") {
    return "\x1b[33m";
  }

  if (normalized === "low") {
    return "\x1b[34m";
  }

  return "\x1b[32m";
}

function severityColor(severity) {
  return riskColor(severity);
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";

function printDivider(char = "─", width = 72) {
  console.log(DIM + char.repeat(width) + RESET);
}

function printScenarioHeader(index, scenario) {
  console.log();
  printDivider("═");
  console.log(
    `${BOLD}${CYAN}Scenario ${index + 1}: ${scenario.name}${RESET}`,
  );
  console.log(`${DIM}${scenario.description}${RESET}`);
  printDivider("═");
}

function printFindings(scenario, parsed) {
  const issues = normalizeIssues(parsed);
  const riskLevel = parsed.riskLevel ?? "Unknown";
  const summary = parsed.summary ?? parsed.analysis ?? "(no summary provided)";

  console.log();
  console.log(`${BOLD}Summary${RESET}`);
  printDivider();
  console.log(summary);

  console.log();
  console.log(
    `${BOLD}Risk Level${RESET}  ${riskColor(riskLevel)}${riskLevel}${RESET}`,
  );

  console.log();
  console.log(`${BOLD}Issues${RESET} (${issues.length})`);
  printDivider();

  if (issues.length === 0) {
    console.log(`${DIM}  No structured issues returned.${RESET}`);
    return;
  }

  for (const [issueIndex, issue] of issues.entries()) {
    const severity = issue.severity ?? "unknown";
    console.log();
    console.log(
      `  ${BOLD}${issueIndex + 1}. ${issue.title}${RESET}  ${severityColor(severity)}[${severity}]${RESET}`,
    );

    if (issue.file) {
      console.log(`     ${DIM}File:${RESET} ${issue.file}`);
    }

    if (issue.description) {
      console.log(`     ${DIM}Description:${RESET} ${issue.description}`);
    }

    if (issue.recommendation) {
      console.log(`     ${DIM}Fix:${RESET} ${issue.recommendation}`);
    }
  }
}

async function writeScenarioFiles(files) {
  await fs.mkdir(MOCK_REPO_DIR, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(MOCK_REPO_DIR, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
}

async function updateBlindspotData(diff, repoPath) {
  const payload = {
    diff,
    repositoryRoot: repoPath,
    repoPath,
    savedAt: new Date().toISOString(),
  };

  await fs.writeFile(
    BLINDSPOT_DATA_PATH,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

async function cleanupMockRepo() {
  await fs.rm(MOCK_REPO_DIR, { recursive: true, force: true });
}

async function runScenario(index, scenario) {
  const repoPath = path.resolve(MOCK_REPO_DIR);

  printScenarioHeader(index, scenario);

  try {
    await writeScenarioFiles(scenario.files);
    await updateBlindspotData(scenario.diff, repoPath);

    console.log();
    console.log(`${DIM}Mock repo:${RESET} ${repoPath}`);
    console.log(`${DIM}POST${RESET}       ${REVIEW_URL}`);

    const response = await fetch(REVIEW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        diff: scenario.diff,
        repoPath,
      }),
    });

    const payload = await response.json();

    if (!response.ok) {
      console.error(
        `\n\x1b[31mAPI error (${response.status}):${RESET} ${payload.error ?? "Unknown error"}`,
      );
      return { scenario: scenario.name, ok: false, error: payload.error };
    }

    const parsed = parseAnalysisPayload(payload.analysis);

    if (!parsed) {
      console.error("\n\x1b[31mCould not parse analysis from API response.\x1b[0m");
      return { scenario: scenario.name, ok: false, error: "Unparseable analysis" };
    }

    printFindings(scenario, parsed);
    return { scenario: scenario.name, ok: true, riskLevel: parsed.riskLevel };
  } finally {
    await cleanupMockRepo();
  }
}

async function loadOriginalBlindspotData() {
  try {
    const raw = await fs.readFile(BLINDSPOT_DATA_PATH, "utf8");
    return { existed: true, content: raw };
  } catch {
    return { existed: false, content: null };
  }
}

async function restoreBlindspotData(original) {
  if (original.existed) {
    await fs.writeFile(BLINDSPOT_DATA_PATH, original.content, "utf8");
    return;
  }

  await fs.rm(BLINDSPOT_DATA_PATH, { force: true });
}

async function main() {
  console.log(`${BOLD}Blindspot Agentic ReAct Evaluation Suite${RESET}`);
  console.log(`${DIM}Project root: ${PROJECT_ROOT}${RESET}`);

  const originalData = await loadOriginalBlindspotData();
  const results = [];

  try {
    for (const [index, scenario] of SCENARIOS.entries()) {
      results.push(await runScenario(index, scenario));
    }
  } finally {
    await restoreBlindspotData(originalData);
  }

  console.log();
  printDivider("═");
  console.log(`${BOLD}Evaluation Summary${RESET}`);
  printDivider("═");

  for (const result of results) {
    const status = result.ok
      ? `\x1b[32mPASS\x1b[0m`
      : `\x1b[31mFAIL\x1b[0m`;
    const detail = result.ok
      ? `(risk: ${result.riskLevel ?? "unknown"})`
      : `(${result.error})`;
    console.log(`  ${status}  ${result.scenario}  ${DIM}${detail}${RESET}`);
  }

  console.log();

  const failed = results.filter((result) => !result.ok).length;

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("\n\x1b[31mEval runner crashed:\x1b[0m", error);
  process.exitCode = 1;
});
