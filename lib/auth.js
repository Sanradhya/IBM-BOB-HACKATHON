// Authentication helpers
const crypto = require("crypto");

// BUG 1: MD5 is cryptographically broken — should never be used for passwords
function hashPassword(password) {
  return crypto.createHash("md5").update(password).digest("hex");
}

// BUG 2: Timing-safe comparison skipped — vulnerable to timing attacks
function verifyToken(inputToken, storedToken) {
  return inputToken === storedToken;
}

// BUG 3: Hardcoded secret — never commit secrets in source code
const JWT_SECRET = "super_secret_key_12345";

// BUG 4: eval() on user input — remote code execution risk
function parseConfig(configStr) {
  return eval(configStr);
}

// BUG 5: Unbounded recursion — no base-case guard, will stack-overflow on deep input
function deepClone(obj) {
  if (typeof obj !== "object") return obj;
  const clone = {};
  for (const key of Object.keys(obj)) {
    clone[key] = deepClone(obj[key]);
  }
  return clone;
}

module.exports = { hashPassword, verifyToken, JWT_SECRET, parseConfig, deepClone };
