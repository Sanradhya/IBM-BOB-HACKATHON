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
    await launchDiffViewer(gitRoot);
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

// ── Diff Viewer launcher ──────────────────────────────────────────────────────
// Starts `next dev` (or `next start` if a build exists) on a free port and
// opens the /diff-viewer page in the user's default browser.
async function launchDiffViewer(gitRoot) {
  const VIEWER_PORT = 3579;
  const viewerUrl = `http://localhost:${VIEWER_PORT}/diff-viewer`;

  // Detect whether a production build is available
  const buildIdPath = path.join(gitRoot, ".next", "BUILD_ID");
  let hasProductionBuild = false;
  try {
    fs.accessSync(buildIdPath, fs.constants.F_OK);
    hasProductionBuild = true;
  } catch {
    hasProductionBuild = false;
  }

  const nextCmd = hasProductionBuild ? "next start" : "next dev";
  const nextBin = path.join(gitRoot, "node_modules", ".bin", "next");

  console.log(`\n${YELLOW}Launching diff viewer at ${viewerUrl}${RESET}`);
  console.log(`Using: ${nextCmd} (port ${VIEWER_PORT})`);

  // Spawn the Next.js server in the background
  const { spawn } = require("child_process");
  const serverProc = spawn(
    nextBin,
    [hasProductionBuild ? "start" : "dev", "--port", String(VIEWER_PORT)],
    { cwd: gitRoot, stdio: "pipe", detached: false },
  );

  serverProc.stderr.on("data", () => {}); // suppress noise
  serverProc.on("error", (err) => {
    console.error(`\x1b[31mFailed to start diff viewer server: ${err.message}${RESET}`);
  });

  // Poll until the server responds, then open the browser
  await waitForServer(viewerUrl, 30_000);

  openBrowser(viewerUrl);

  console.log(`\n${GREEN}Diff viewer open at ${viewerUrl}${RESET}`);
  console.log(`Press Ctrl+C to stop the viewer server.\n`);

  // Keep the CLI alive so the server stays up
  await new Promise((resolve) => {
    process.on("SIGINT", () => {
      serverProc.kill();
      resolve(undefined);
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const client = url.startsWith("https:") ? https : http;
        const req = client.get(url, (res) => { res.resume(); resolve(); });
        req.on("error", reject);
        req.setTimeout(500, () => { req.destroy(); reject(new Error("timeout")); });
      });
      return; // server is up
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  console.warn(`${YELLOW}Timed out waiting for the diff viewer server.${RESET}`);
}

function openBrowser(url) {
  const { platform } = process;
  const cmd =
    platform === "win32" ? `start "" "${url}"` :
    platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  try {
    execSync(cmd, { stdio: "ignore" });
  } catch {
    console.log(`${YELLOW}Open your browser at: ${url}${RESET}`);
  }
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
