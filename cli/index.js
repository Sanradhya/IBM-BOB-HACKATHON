#!/usr/bin/env node

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { execSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const os = require("os");
const readline = require("readline");
const { Command } = require("commander");
const cliProgress = require("cli-progress");
const simpleGit = require("simple-git");
const { runReviewAgent } = require("./engine");

const SESSION_LOG_FILENAME = "bob-session-logs.json";

const MODEL_DIR = path.join(os.homedir(), ".blindspot");
const MODEL_PATH = path.join(MODEL_DIR, "model.gguf");
const MODEL_URL =
  "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf";
const REPORT_FILENAME = "blindspot-report.md";

const DIFF_EXCLUDE_PATHSPECS = [
  ":!package-lock.json",
  ":!yarn.lock",
  ":!pnpm-lock.yaml",
  ":!*.min.*",
  ":!dist/*",
  ":!.next/*",
  ":!build/*",
  ":!*.png",
  ":!*.jpg",
  ":!*.pdf",
  ":!*.ico",
  ":!*.wasm",
  ":!*.sqlite",
];

const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function modelExists() {
  try {
    fs.accessSync(MODEL_PATH, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function request(url, options = {}) {
  const client = url.startsWith("https:") ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent": "blindspot-cli",
          ...options.headers,
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          request(nextUrl, options).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(`Download failed with status ${res.statusCode} for ${url}`),
          );
          return;
        }

        resolve(res);
      },
    );

    req.on("error", reject);
  });
}

async function downloadModel() {
  await fsp.mkdir(MODEL_DIR, { recursive: true });

  console.log("Model not found. Downloading Llama-3.2-1B-Instruct-Q4_K_M...");
  console.log(`Saving to ${MODEL_PATH}`);

  const response = await request(MODEL_URL);
  const totalBytes = Number.parseInt(response.headers["content-length"] || "0", 10);
  const bar = new cliProgress.SingleBar(
    {
      format:
        "Downloading |{bar}| {percentage}% | {value}/{total} MB | ETA: {eta}s",
    },
    cliProgress.Presets.shades_classic,
  );

  if (totalBytes > 0) {
    bar.start(Math.ceil(totalBytes / (1024 * 1024)), 0);
  } else {
    bar.start(100, 0, { speed: "N/A" });
  }

  let downloaded = 0;

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(MODEL_PATH);

    response.on("data", (chunk) => {
      downloaded += chunk.length;

      if (totalBytes > 0) {
        bar.update(Math.ceil(downloaded / (1024 * 1024)));
      } else {
        const pseudoTotal = Math.max(
          100,
          Math.ceil(downloaded / (1024 * 1024)),
        );
        bar.setTotal(pseudoTotal);
        bar.update(Math.ceil(downloaded / (1024 * 1024)));
      }
    });

    response.on("error", (error) => {
      fileStream.close();
      bar.stop();
      reject(error);
    });

    fileStream.on("error", (error) => {
      bar.stop();
      reject(error);
    });

    fileStream.on("finish", () => {
      bar.stop();
      resolve();
    });

    response.pipe(fileStream);
  });

  if (!modelExists()) {
    throw new Error("Model download completed but file was not found on disk.");
  }

  console.log("Model download complete.");
}

function resolveGitRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();
  } catch {
    console.warn(
      "Could not resolve git repository root. Using current working directory.",
    );
    return process.cwd();
  }
}

async function collectGitDiff(gitRoot) {
  const git = simpleGit(gitRoot);
  const isRepo = await git.checkIsRepo();

  if (!isRepo) {
    return "";
  }

  const staged = await git.diff(["--cached", "--", ...DIFF_EXCLUDE_PATHSPECS]);
  const unstaged = await git.diff(["--", ...DIFF_EXCLUDE_PATHSPECS]);

  return [staged, unstaged].filter(Boolean).join("\n");
}

async function ensureGitignoreEntry(gitRoot, entry) {
  const gitignorePath = path.join(gitRoot, ".gitignore");
  let content = "";

  try {
    content = await fsp.readFile(gitignorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const hasEntry = content
    .split("\n")
    .some((line) => line.trim() === entry);

  if (hasEntry) {
    return;
  }

  const needsNewline = content.length > 0 && !content.endsWith("\n");
  const updated = content.length === 0 ? `${entry}\n` : `${content}${needsNewline ? "\n" : ""}${entry}\n`;
  await fsp.writeFile(gitignorePath, updated, "utf8");
}

function startSpinner(message) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIndex = 0;

  const interval = setInterval(() => {
    process.stdout.write(`\r${frames[frameIndex % frames.length]} ${message}`);
    frameIndex += 1;
  }, 80);

  return () => {
    clearInterval(interval);
    process.stdout.write("\r\x1b[K");
  };
}

function resolveEngineProvider(cliProvider) {
  const raw = cliProvider || process.env.ENGINE_PROVIDER || "bob";
  return String(raw).trim().toLowerCase();
}

async function run(cliOptions = {}) {
  const gitRoot = resolveGitRoot();
  const provider = resolveEngineProvider(cliOptions.provider);
  process.env.ENGINE_PROVIDER = provider;
  const exportLogs = Boolean(cliOptions.exportLogs);

  const diff = await collectGitDiff(gitRoot);
  if (!diff.trim()) {
    console.log(
      `${YELLOW}No uncommitted changes found. Modify some files before running Blindspot.${RESET}`,
    );
    process.exit(0);
  }

  if (provider === "llama" && !modelExists()) {
    await downloadModel();
  }

  const stopSpinner = startSpinner("Agent is analyzing your code...");
  let markdown;
  let telemetry = null;

  try {
    const review = await runReviewAgent(diff, gitRoot, MODEL_PATH, {
      provider,
    });
    markdown = typeof review === "string" ? review : review.markdown;
    telemetry = review && typeof review === "object" ? review.telemetry : null;
    if (typeof markdown !== "string" || !markdown.trim()) {
      throw new Error("Review engine did not return Markdown.");
    }
  } finally {
    stopSpinner();
  }

  if (markdown.length > 60000) {
    markdown =
      markdown.slice(0, 60000) +
      "\n\n---\n*Note: Report truncated to meet GitHub comment length limits.*";
  }

  const reportPath = path.join(process.cwd(), REPORT_FILENAME);
  await fsp.writeFile(reportPath, markdown, "utf8");
  await ensureGitignoreEntry(gitRoot, REPORT_FILENAME);
  await ensureGitignoreEntry(gitRoot, SESSION_LOG_FILENAME);

  if (exportLogs && telemetry != null) {
    const logPath = path.join(process.cwd(), SESSION_LOG_FILENAME);
    await fsp.writeFile(logPath, JSON.stringify(telemetry, null, 2), "utf8");
  }

  console.log(`${GREEN}✅ Scan complete! Report saved to blindspot-report.md${RESET}`);

  // ── Diff Viewer: launch the side-by-side UI when --diff-viewer is set ─────
  if (cliOptions.diffViewer) {
    await launchDiffViewer(gitRoot, markdown);
    return; // Skip interactive CLI fix-mode; the UI handles it
  }

  // Interactive Fix Mode
  // Capture: title, file path, optional original block, suggestion block
  const suggestionRegex = /### (.*?)\n[\s\S]*?- \*\*File:\*\* `(.*?)`[\s\S]*?(?:```original\n([\s\S]*?)```[\s\S]*?)?```suggestion\n([\s\S]*?)```/g;
  const matches = [...markdown.matchAll(suggestionRegex)];

  if (matches.length > 0) {
    console.log(`\n${YELLOW}Blindspot found ${matches.length} auto-fixable issues.${RESET}`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    for (const match of matches) {
      const [_, title, filePath, originalCode, suggestedCode] = match;
      const fixedCode = suggestedCode.trim();

      console.log(`\n--------------------------------------------------`);
      console.log(`${YELLOW}Issue:${RESET} ${title}`);
      console.log(`${YELLOW}File:${RESET} ${filePath}`);
      if (originalCode) {
        console.log(`${YELLOW}Original:${RESET}\n${originalCode.trim()}`);
      }
      console.log(`${GREEN}Suggested Fix:${RESET}\n${fixedCode}`);
      console.log(`--------------------------------------------------`);

      const answer = await askQuestion(`Apply this fix to ${filePath}? [y/N]: `);

      if (answer.toLowerCase() === "y") {
        try {
          const absolutePath = path.resolve(gitRoot, filePath);
          const fileContent = await fsp.readFile(absolutePath, "utf8");

          let updatedContent;
          if (originalCode) {
            // Precise search-and-replace: swap original block with suggested fix
            const original = originalCode.trim();
            if (!fileContent.includes(original)) {
              console.log(`\x1b[31mCould not locate original snippet in ${filePath}. Skipping.${RESET}`);
              continue;
            }
            updatedContent = fileContent.replace(original, fixedCode);
          } else {
            // No original block provided — find the rule whose pattern matches this
            // finding's title, then apply only that rule across the file's lines.
            const INLINE_RULES = [
              { title: /buffer/i,   pattern: /\bnew Buffer\s*\(/,   fix: (l) => l.replace(/\bnew Buffer\s*\(/, "Buffer.from(") },
              { title: /url\.parse/i, pattern: /\burl\.parse\s*\(/, fix: (l) => l.replace(/\burl\.parse\s*\(/, "new URL(") },
              { title: /fs\.exists/i, pattern: /\bfs\.exists\s*\(/, fix: (l) => l.replace(/\bfs\.exists\s*\(/, "fs.access(") },
              { title: /substr/i,   pattern: /\.substr\s*\(/,       fix: (l) => l.replace(/\.substr\s*\(\s*([^,)]+)\s*,\s*([^)]+)\)/, ".slice($1, $1 + $2)") },
              { title: /var/i,      pattern: /\bvar\s+/,            fix: (l) => l.replace(/\bvar\b/g, "const") },
            ];
            const rule = INLINE_RULES.find((r) => r.title.test(title));
            if (!rule) {
              console.log(`\x1b[31mNo rule matched finding "${title}". Skipping.${RESET}`);
              continue;
            }
            const lines = fileContent.split("\n");
            let changed = false;
            const patched = lines.map((line) => {
              if (rule.pattern.test(line)) {
                changed = true;
                return rule.fix(line);
              }
              return line;
            });
            if (!changed) {
              console.log(`\x1b[31mPattern for "${title}" not found in ${filePath} — already fixed or not present. Skipping.${RESET}`);
              continue;
            }
            updatedContent = patched.join("\n");
          }

          await fsp.writeFile(absolutePath, updatedContent, "utf8");
          console.log(`${GREEN}✔ Fix applied to ${filePath}${RESET}`);
        } catch (err) {
          console.log(`\x1b[31mFailed to modify file: ${err.message}${RESET}`);
        }
      } else {
        console.log(`Skipped.`);
      }
    }
    rl.close();
  }
}

// ── Diff Viewer ───────────────────────────────────────────────────────────────
// Generates a fully self-contained HTML file from the scan findings and opens
// it inside the IDE's built-in Simple Browser panel.
// No server is started — the CLI exits cleanly as soon as the panel opens.
const DIFF_HTML_FILENAME = "blindspot-diff-viewer.html";

// Fallback demo findings shown when the live scan produces no suggestion blocks
// (e.g. when the diff only contains already-fixed code, or on the demo branch).
const DEMO_FINDINGS = [
  {
    filePath: "lib/auth.js",
    title: "Broken-hash password storage (MD5)",
    severity: "Critical",
    description: "MD5 is cryptographically broken — trivially reversible via rainbow tables. Use bcrypt or scrypt.",
    originalCode: `function hashPassword(password) {\n  return crypto.createHash("md5").update(password).digest("hex");\n}`,
    fixedCode: `const bcrypt = require("bcrypt");\n\nasync function hashPassword(password) {\n  return bcrypt.hash(password, 12);\n}`,
  },
  {
    filePath: "lib/auth.js",
    title: "Timing-attack-vulnerable token comparison",
    severity: "High",
    description: "=== exits early on the first mismatched character, leaking timing. Use crypto.timingSafeEqual.",
    originalCode: `function verifyToken(inputToken, storedToken) {\n  return inputToken === storedToken;\n}`,
    fixedCode: `function verifyToken(inputToken, storedToken) {\n  const a = Buffer.from(inputToken);\n  const b = Buffer.from(storedToken);\n  if (a.length !== b.length) return false;\n  return crypto.timingSafeEqual(a, b);\n}`,
  },
  {
    filePath: "lib/auth.js",
    title: "Hardcoded JWT secret in source code",
    severity: "Critical",
    description: "Secrets committed to source code are visible to anyone with repo access. Use environment variables.",
    originalCode: `const JWT_SECRET = "super_secret_key_12345";`,
    fixedCode: `const JWT_SECRET = process.env.JWT_SECRET;\nif (!JWT_SECRET) throw new Error("JWT_SECRET env var is not set");`,
  },
  {
    filePath: "lib/auth.js",
    title: "eval() on user-controlled input (RCE)",
    severity: "Critical",
    description: "eval() executes arbitrary JavaScript — passing user input to it is Remote Code Execution.",
    originalCode: `function parseConfig(configStr) {\n  return eval(configStr);\n}`,
    fixedCode: `function parseConfig(configStr) {\n  return JSON.parse(configStr);\n}`,
  },
  {
    filePath: "lib/dataProcessor.js",
    title: "Off-by-one error in array loop",
    severity: "High",
    description: "i <= arr.length reads arr[arr.length] which is undefined, silently corrupting the sum to NaN.",
    originalCode: `function sumArray(arr) {\n  let total = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}`,
    fixedCode: `function sumArray(arr) {\n  let total = 0;\n  for (let i = 0; i < arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}`,
  },
  {
    filePath: "lib/dataProcessor.js",
    title: "Array mutation in removeDuplicates",
    severity: "Medium",
    description: "splice() mutates the caller's original array — unexpected side-effect for the call site.",
    originalCode: `function removeDuplicates(items) {\n  for (let i = 0; i < items.length; i++) {\n    for (let j = i + 1; j < items.length; j++) {\n      if (items[i] === items[j]) { items.splice(j, 1); j--; }\n    }\n  }\n  return items;\n}`,
    fixedCode: `function removeDuplicates(items) {\n  return [...new Set(items)];\n}`,
  },
  {
    filePath: "lib/dataProcessor.js",
    title: "SQL injection via string concatenation",
    severity: "Critical",
    description: "Interpolating userId directly allows an attacker to inject arbitrary SQL. Use parameterised queries.",
    originalCode: "function buildQuery(tableName, userId) {\n  return `SELECT * FROM ${tableName} WHERE id = ` + userId;\n}",
    fixedCode: `function buildQuery(tableName, userId) {\n  return { sql: "SELECT * FROM users WHERE id = ?", values: [userId] };\n}`,
  },
  {
    filePath: "lib/fileHandler.js",
    title: "Path traversal in file read",
    severity: "Critical",
    description: "path.join does not strip '../' — a caller can escape the base directory (e.g. ../../etc/passwd).",
    originalCode: `function readUserFile(baseDir, filename) {\n  const filePath = path.join(baseDir, filename);\n  return fs.readFileSync(filePath, "utf8");\n}`,
    fixedCode: `function readUserFile(baseDir, filename) {\n  const resolved = path.resolve(baseDir, filename);\n  if (!resolved.startsWith(path.resolve(baseDir) + path.sep))\n    throw new Error("Path traversal detected");\n  return fs.readFileSync(resolved, "utf8");\n}`,
  },
  {
    filePath: "lib/fileHandler.js",
    title: "Blocking readFileSync inside async function",
    severity: "Medium",
    description: "readFileSync blocks the Node.js event loop, stalling all concurrent requests.",
    originalCode: `async function countLines(filePath) {\n  const content = fs.readFileSync(filePath, "utf8");\n  return content.split("\\n").length;\n}`,
    fixedCode: `const fsp = require("fs/promises");\n\nasync function countLines(filePath) {\n  const content = await fsp.readFile(filePath, "utf8");\n  return content.split("\\n").length;\n}`,
  },
];

async function launchDiffViewer(gitRoot, markdown) {
  // ── 1. Parse findings from scan markdown; fall back to demo set ───────────
  let findings = parseFindingsForViewer(markdown);
  const usingDemo = findings.length === 0;
  if (usingDemo) {
    findings = DEMO_FINDINGS;
    console.log(`${YELLOW}No suggestion blocks in scan report — showing demo findings from this branch.${RESET}`);
  }

  // ── 2. Write self-contained HTML file ─────────────────────────────────────
  const htmlPath = path.join(gitRoot, DIFF_HTML_FILENAME);
  const html = buildDiffHtml(findings);
  await fsp.writeFile(htmlPath, html, "utf8");
  await ensureGitignoreEntry(gitRoot, DIFF_HTML_FILENAME);

  // ── 3. Open inside IDE — no server, no hanging process ────────────────────
  openInIde(htmlPath);

  console.log(`\n${GREEN}✅ Diff viewer opened — ${findings.length} issue(s)${usingDemo ? " (demo)" : ""}${RESET}`);
  console.log(`   File: ${htmlPath}\n`);
  // CLI exits immediately — no await, no server to keep alive
}

// ── Parse findings from scan markdown ────────────────────────────────────────
function parseFindingsForViewer(markdown) {
  const results = [];
  const re = /###\s+(.*?)\n([\s\S]*?)(?=###\s+|\s*$)/g;
  for (const section of markdown.matchAll(re)) {
    const title = section[1].trim();
    const body  = section[2];
    const fileMatch = body.match(/\*\*File:\*\*\s+`([^`]+)`/);
    const sevMatch  = body.match(/\*\*Severity:\*\*\s+(\w+)/);
    const descMatch = body.match(/\*\*Description:\*\*\s+([\s\S]*?)(?=\n\s*[-*]|\n```|$)/);
    const origMatch = body.match(/```original\n([\s\S]*?)```/);
    const suggMatch = body.match(/```suggestion\n([\s\S]*?)```/);
    if (!fileMatch || !suggMatch) continue;
    results.push({
      filePath:     fileMatch[1],
      title,
      severity:     normaliseSeverity(sevMatch ? sevMatch[1] : "Medium"),
      description:  descMatch ? descMatch[1].trim() : "",
      originalCode: origMatch ? origMatch[1].trim() : "",
      fixedCode:    suggMatch[1].trim(),
    });
  }
  return results;
}

function normaliseSeverity(raw) {
  const s = String(raw).trim();
  if (/critical/i.test(s)) return "Critical";
  if (/high/i.test(s))     return "High";
  if (/low/i.test(s))      return "Low";
  return "Medium";
}

// ── Build the self-contained HTML diff viewer ─────────────────────────────────
function buildDiffHtml(findings) {
  const SEV_COLOR = { Critical: "#dc2626", High: "#ea580c", Medium: "#d97706", Low: "#65a30d" };

  // Compute line-level diff (LCS) between two code strings.
  // Returns { left: Line[], right: Line[] } where each Line has { type, content, lineNo }.
  function lineDiff(original, fixed) {
    const oLines = original.split("\n");
    const fLines = fixed.split("\n");
    const m = oLines.length, n = fLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = oLines[i-1] === fLines[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oLines[i-1] === fLines[j-1]) { ops.unshift({ t:"eq", oi:i-1, fi:j-1 }); i--; j--; }
      else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.unshift({ t:"ins", fi:j-1 }); j--; }
      else { ops.unshift({ t:"del", oi:i-1 }); i--; }
    }
    const left = [], right = [];
    let ono = 1, fno = 1;
    for (const op of ops) {
      if (op.t === "eq") {
        left.push({ type:"context", content: oLines[op.oi], lineNo: ono++ });
        right.push({ type:"context", content: fLines[op.fi], lineNo: fno++ });
      } else if (op.t === "del") {
        left.push({ type:"removed", content: oLines[op.oi], lineNo: ono++ });
        right.push({ type:"added", content:"", lineNo:null });
      } else {
        left.push({ type:"removed", content:"", lineNo:null });
        right.push({ type:"added", content: fLines[op.fi], lineNo: fno++ });
      }
    }
    return { left, right };
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;");
  }

  function renderPane(lines, side) {
    const isLeft = side === "left";
    return lines.map(line => {
      const blank = line.lineNo === null;
      const bg =
        line.type === "removed" && !blank ? "background:#3d1212" :
        line.type === "added"   && !blank ? "background:#0d3a1e" :
        blank                             ? "background:#161b22" : "";
      const gutter =
        line.type === "removed" && !blank ? `<span style="color:#f87171;width:14px;display:inline-block;text-align:center;user-select:none">−</span>` :
        line.type === "added"   && !blank ? `<span style="color:#4ade80;width:14px;display:inline-block;text-align:center;user-select:none">+</span>` :
        `<span style="width:14px;display:inline-block"> </span>`;
      const linenoColor =
        line.type === "removed" && !blank ? "#f87171" :
        line.type === "added"   && !blank ? "#4ade80" : "#484f58";
      return `<div style="display:flex;align-items:flex-start;min-height:22px;font-size:12px;line-height:22px;${bg}">` +
        `<span style="width:40px;min-width:40px;text-align:right;padding-right:10px;color:${linenoColor};font-size:11px;user-select:none">${line.lineNo ?? ""}</span>` +
        gutter +
        `<pre style="margin:0;padding:0 8px;white-space:pre;tab-size:2;flex:1;background:transparent;font-family:inherit;font-size:inherit">${esc(line.content)}</pre>` +
        `</div>`;
    }).join("");
  }

  const sidebarItems = findings.map((f, i) =>
    `<li onclick="show(${i})" id="si-${i}" style="display:flex;align-items:flex-start;gap:10px;padding:11px 14px;cursor:pointer;border-bottom:1px solid #30363d;transition:background .1s">` +
    `<span style="width:8px;height:8px;border-radius:50%;background:${SEV_COLOR[f.severity] ?? "#888"};margin-top:6px;flex-shrink:0"></span>` +
    `<div style="display:flex;flex-direction:column;gap:2px;min-width:0">` +
    `<span style="font-size:12px;font-weight:500;color:#e6edf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.title)}</span>` +
    `<span style="font-size:11px;color:#8b949e;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.filePath)}</span>` +
    `</div></li>`
  ).join("");

  const panels = findings.map((f, i) => {
    const { left, right } = lineDiff(f.originalCode, f.fixedCode);
    const sevColor = SEV_COLOR[f.severity] ?? "#888";
    return `<div id="panel-${i}" style="display:none;flex-direction:column;flex:1;overflow:hidden">` +
      // header
      `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid #30363d;background:#161b22;flex-wrap:wrap;gap:10px">` +
      `<div style="display:flex;align-items:center;gap:10px">` +
      `<span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;color:#fff;background:${sevColor};text-transform:uppercase;letter-spacing:.5px">${esc(f.severity)}</span>` +
      `<span style="font-size:14px;font-weight:600;color:#e6edf3">${esc(f.title)}</span>` +
      `</div>` +
      `<span style="font-size:12px;font-family:monospace;color:#8b949e">${esc(f.filePath)}</span>` +
      `</div>` +
      // description
      (f.description ? `<p style="margin:0;padding:9px 18px;font-size:13px;color:#8b949e;border-bottom:1px solid #30363d;background:#161b22">${esc(f.description)}</p>` : "") +
      // split panes
      `<div style="display:flex;flex:1;overflow:hidden">` +
      // left pane
      `<div style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0">` +
      `<div style="padding:7px 12px;font-size:12px;font-weight:600;color:#f87171;background:#2d1212;border-bottom:1px solid #30363d;display:flex;justify-content:space-between">` +
      `<span>◀ Original</span><span style="opacity:.6;font-family:monospace;font-size:11px">${esc(f.filePath)}</span></div>` +
      `<div style="overflow:auto;flex:1;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace">${renderPane(left,"left")}</div>` +
      `</div>` +
      // divider
      `<div style="width:1px;background:#30363d;flex-shrink:0"></div>` +
      // right pane
      `<div style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0">` +
      `<div style="padding:7px 12px;font-size:12px;font-weight:600;color:#4ade80;background:#0d2a18;border-bottom:1px solid #30363d;display:flex;justify-content:space-between">` +
      `<span>Fixed ▶</span><span style="opacity:.6;font-family:monospace;font-size:11px">${esc(f.filePath)}</span></div>` +
      `<div style="overflow:auto;flex:1;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace">${renderPane(right,"right")}</div>` +
      `</div>` +
      `</div>` +
      // nav
      `<div style="display:flex;align-items:center;justify-content:center;gap:14px;padding:10px 18px;border-top:1px solid #30363d;background:#161b22;flex-shrink:0">` +
      `<button onclick="show(${i-1})" ${i===0?"disabled":""} style="background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:5px 14px;font-size:13px;cursor:pointer">← Prev</button>` +
      `<span style="font-size:13px;color:#8b949e">${i+1} / ${findings.length}</span>` +
      `<button onclick="show(${i+1})" ${i===findings.length-1?"disabled":""} style="background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:5px 14px;font-size:13px;cursor:pointer">Next →</button>` +
      `</div>` +
      `</div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blindspot — Diff Viewer (${findings.length} issue${findings.length !== 1 ? "s" : ""})</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#0d1117;color:#e6edf3;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.6}
button:disabled{opacity:.4;cursor:default}
button:not(:disabled):hover{background:#30363d!important}
li:hover{background:rgba(255,255,255,.04)}
li.active{background:rgba(59,130,212,.12)!important;border-left:3px solid #3b82d4!important;padding-left:11px!important}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0d1117}
::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
</style>
</head>
<body style="display:flex;height:100vh;overflow:hidden">
<!-- sidebar -->
<aside style="width:270px;min-width:220px;background:#161b22;border-right:1px solid #30363d;display:flex;flex-direction:column;overflow:hidden">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #30363d">
    <span style="font-weight:600;font-size:13px">🔍 Blindspot Issues</span>
    <span style="background:#30363d;color:#8b949e;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px">${findings.length}</span>
  </div>
  <ul id="sidebar" style="list-style:none;overflow-y:auto;flex:1">${sidebarItems}</ul>
</aside>
<!-- main -->
<main id="main" style="flex:1;display:flex;flex-direction:column;overflow:hidden">${panels}</main>
<script>
var current = 0;
function show(idx) {
  if (idx < 0 || idx >= ${findings.length}) return;
  document.getElementById('panel-' + current).style.display = 'none';
  document.getElementById('si-' + current).classList.remove('active');
  current = idx;
  document.getElementById('panel-' + current).style.display = 'flex';
  document.getElementById('si-' + current).classList.add('active');
  document.getElementById('si-' + current).scrollIntoView({ block: 'nearest' });
}
show(0);
</script>
</body>
</html>`;
}

// ── Open a local file inside the IDE's Simple Browser panel ──────────────────
// Uses the `vscode://` URI scheme understood by VS Code, Cursor, and Windsurf.
// The `code --open-url` / `cursor --open-url` CLI triggers it without opening
// an external browser window. The CLI exits immediately after — no server.
function openInIde(filePath) {
  const fileUrl = "file:///" + filePath.replace(/\\/g, "/");
  const ideUri  = `vscode://vscode.simpleBrowser/show?url=${encodeURIComponent(fileUrl)}`;

  const cliCandidates = ["cursor", "code", "windsurf"];
  for (const cli of cliCandidates) {
    try {
      execSync(`${cli} --open-url "${ideUri}"`, { stdio: "ignore" });
      return;
    } catch {
      // binary not on PATH — try next
    }
  }

  // Fallback: print the URI as a clickable link in the integrated terminal.
  // VS Code/Cursor terminal renders vscode:// links as clickable.
  console.log(`\n${YELLOW}Click to open the diff viewer inside your IDE:${RESET}`);
  console.log(`  ${ideUri}`);
}

const program = new Command();

program
  .name("blindspot")
  .description("Local AI code reviewer")
  .version("0.1.0")
  .option(
    "--provider <type>",
    "Inference provider to use (bob or llama)",
    "bob",
  )
  .option(
    "--export-logs",
    "Export session logs and telemetry to a local JSON file",
  )
  .option(
    "--diff-viewer",
    "After scanning, open a side-by-side diff viewer in the browser (requires Next.js)",
  )
  .action(async (options) => {
    try {
      await run(options);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error during review";
      console.error(message);
      process.exit(1);
    }
  });

program.parse();
