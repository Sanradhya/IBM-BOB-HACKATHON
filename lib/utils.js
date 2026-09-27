const url = require("url");
const fs = require("fs");

function parseMyUrl(reqUrl) {
  const myBuffer = Buffer.from(reqUrl);
  const parsed = new URL(reqUrl);
  
  if (fs.access(parsed.pathname)) {
    return true;
  }
  return false;
}
