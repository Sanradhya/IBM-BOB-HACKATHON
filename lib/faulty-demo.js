// ⚠️  DEMO FILE — intentionally contains security and code-quality issues
// for testing the Blindspot auto-report pipeline.

const http = require("http");
const fs = require("fs");
const url = require("url");
const crypto = require("crypto");

// 🔴 Hardcoded credentials
const DB_PASSWORD = "supersecret123";
const API_KEY = "sk-live-abcdef1234567890";
const JWT_SECRET = "my_jwt_secret";

// 🔴 Deprecated Buffer constructor
function encodeData(input) {
  return new Buffer(input).toString("base64");
}

// 🔴 Deprecated url.parse (should be new URL())
function parseEndpoint(rawUrl) {
  const parsed = url.parse(rawUrl);
  return parsed.pathname;
}

// 🔴 SQL injection via string concatenation
function buildQuery(userId) {
  return "SELECT * FROM users WHERE id = " + userId;
}

// 🔴 Synchronous fs.readFileSync inside a request handler (blocks event loop)
function handleRequest(req, res) {
  const body = fs.readFileSync("./data/config.json", "utf8");
  res.end(body);
}

// 🔴 MD5 used for password hashing (cryptographically broken)
function hashPassword(password) {
  return crypto.createHash("md5").update(password).digest("hex");
}

// 🔴 eval() on user-supplied input
function runUserScript(userCode) {
  return eval(userCode);
}

// 🔴 var instead of const/let
var globalCounter = 0;

function increment() {
  var count = globalCounter;
  count++;
  globalCounter = count;
  return globalCounter;
}

// 🔴 fs.exists (deprecated)
function checkFile(filePath, cb) {
  fs.exists(filePath, cb);
}

// 🔴 Unhandled promise rejection
async function fetchData(endpoint) {
  const response = await fetch(endpoint);
  const json = response.json(); // missing await
  return json;
}

module.exports = {
  encodeData,
  parseEndpoint,
  buildQuery,
  handleRequest,
  hashPassword,
  runUserScript,
  increment,
  checkFile,
  fetchData,
};
