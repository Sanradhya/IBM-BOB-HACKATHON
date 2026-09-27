// File handling utilities
const fs = require("fs");
const path = require("path");

// BUG 1: Path traversal — user-supplied filename not sanitised
function readUserFile(baseDir, filename) {
  const filePath = path.join(baseDir, filename); // "../../../etc/passwd" works!
  return fs.readFileSync(filePath, "utf8");
}

// BUG 2: Synchronous fs call inside an async function — blocks the event loop
async function countLines(filePath) {
  const content = fs.readFileSync(filePath, "utf8"); // should be await fsp.readFile
  return content.split("\n").length;
}

// BUG 3: Race condition — TOCTOU (check-then-act) on file existence
function safeWrite(filePath, data) {
  if (fs.existsSync(filePath)) {
    throw new Error("File already exists");
  }
  // Another process could create the file between the check and write ↓
  fs.writeFileSync(filePath, data);
}

// BUG 4: Missing encoding in readFile — returns Buffer, caller expects string
function loadConfig(configPath) {
  return fs.readFileSync(configPath); // missing "utf8" second arg
}

// BUG 5: Recursive delete without a root-path guard — rm -rf style footgun
function deleteDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file) => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteDir(curPath); // no guard against deleting "/" or "C:\\"
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}

module.exports = { readUserFile, countLines, safeWrite, loadConfig, deleteDir };
