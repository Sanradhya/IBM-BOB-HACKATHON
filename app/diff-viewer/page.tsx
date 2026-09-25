import { promises as fsp } from "fs";
import path from "path";
import FileDiffViewerPage, { type DiffFile } from "./FileDiffViewerPage";

// Force dynamic rendering so the server always reads the latest findings file
export const dynamic = "force-dynamic";

// ── Demo fallback data (shown when no live scan findings are present) ─────────
const DEMO_FILES: DiffFile[] = [
  {
    filePath: "lib/auth.js",
    title: "Broken-hash password storage (MD5)",
    severity: "Critical",
    description:
      "MD5 is a broken hash function, trivially reversible via rainbow tables. " +
      "Passwords must be hashed with a slow, salted KDF such as bcrypt or scrypt.",
    originalCode: `function hashPassword(password) {
  return crypto.createHash("md5").update(password).digest("hex");
}`,
    fixedCode: `const bcrypt = require("bcrypt");

async function hashPassword(password) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}`,
  },
  {
    filePath: "lib/auth.js",
    title: "Timing-attack-vulnerable token comparison",
    severity: "High",
    description:
      "String equality (===) exits early on the first mismatched character, " +
      "leaking timing information. Use crypto.timingSafeEqual instead.",
    originalCode: `function verifyToken(inputToken, storedToken) {
  return inputToken === storedToken;
}`,
    fixedCode: `function verifyToken(inputToken, storedToken) {
  const a = Buffer.from(inputToken);
  const b = Buffer.from(storedToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}`,
  },
  {
    filePath: "lib/auth.js",
    title: "Hardcoded JWT secret in source code",
    severity: "Critical",
    description:
      "Secrets committed to source code are exposed to anyone with repo access. " +
      "Load secrets exclusively from environment variables at runtime.",
    originalCode: `const JWT_SECRET = "super_secret_key_12345";`,
    fixedCode: `const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET environment variable is not set");`,
  },
  {
    filePath: "lib/auth.js",
    title: "eval() on unsanitised user input (RCE)",
    severity: "Critical",
    description:
      "eval() executes arbitrary JavaScript. Passing user-controlled input to it " +
      "enables Remote Code Execution. Use JSON.parse or a safe schema validator.",
    originalCode: `function parseConfig(configStr) {
  return eval(configStr);
}`,
    fixedCode: `function parseConfig(configStr) {
  return JSON.parse(configStr);
}`,
  },
  {
    filePath: "lib/dataProcessor.js",
    title: "Off-by-one error in array loop",
    severity: "High",
    description:
      "Loop condition is i <= arr.length, which reads arr[arr.length] — " +
      "an out-of-bounds undefined, silently turning the sum into NaN.",
    originalCode: `function sumArray(arr) {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i];
  }
  return total;
}`,
    fixedCode: `function sumArray(arr) {
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    total += arr[i];
  }
  return total;
}`,
  },
  {
    filePath: "lib/dataProcessor.js",
    title: "Array mutation instead of copy in removeDuplicates",
    severity: "Medium",
    description:
      "splice() mutates the original array passed by the caller. Work on a copy instead.",
    originalCode: `function removeDuplicates(items) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i] === items[j]) {
        items.splice(j, 1);
        j--;
      }
    }
  }
  return items;
}`,
    fixedCode: `function removeDuplicates(items) {
  return [...new Set(items)];
}`,
  },
  {
    filePath: "lib/dataProcessor.js",
    title: "SQL injection via string concatenation",
    severity: "Critical",
    description:
      "Interpolating userId directly into the query allows arbitrary SQL injection. " +
      "Always use parameterised queries.",
    originalCode: `function buildQuery(tableName, userId) {
  return \`SELECT * FROM \${tableName} WHERE id = \` + userId;
}`,
    fixedCode: `function buildQuery(tableName, userId) {
  return { sql: "SELECT * FROM users WHERE id = ?", values: [userId] };
}`,
  },
  {
    filePath: "lib/fileHandler.js",
    title: "Path traversal in file read",
    severity: "Critical",
    description:
      "path.join does not prevent '../' segments — a caller can escape the intended base directory.",
    originalCode: `function readUserFile(baseDir, filename) {
  const filePath = path.join(baseDir, filename);
  return fs.readFileSync(filePath, "utf8");
}`,
    fixedCode: `function readUserFile(baseDir, filename) {
  const resolved = path.resolve(baseDir, filename);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error("Path traversal detected");
  }
  return fs.readFileSync(resolved, "utf8");
}`,
  },
  {
    filePath: "lib/fileHandler.js",
    title: "Blocking fs.readFileSync inside async function",
    severity: "Medium",
    description:
      "readFileSync blocks the Node.js event loop. Use the promise-based fs/promises API.",
    originalCode: `async function countLines(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return content.split("\\n").length;
}`,
    fixedCode: `const fsp = require("fs/promises");

async function countLines(filePath) {
  const content = await fsp.readFile(filePath, "utf8");
  return content.split("\\n").length;
}`,
  },
];

// ── Load live findings from the CLI-written JSON if available ─────────────────
async function loadFindings(): Promise<DiffFile[]> {
  const findingsPath = path.join(process.cwd(), ".blindspot-findings.json");
  try {
    const raw = await fsp.readFile(findingsPath, "utf8");
    const parsed = JSON.parse(raw) as DiffFile[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // File doesn't exist or is invalid — fall through to demo data
  }
  return DEMO_FILES;
}

export default async function DiffViewerPage() {
  const files = await loadFindings();
  return <FileDiffViewerPage files={files} />;
}
