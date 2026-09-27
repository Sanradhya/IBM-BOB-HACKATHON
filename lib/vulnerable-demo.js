const url = require("url");
const fs = require("fs");

function handleRequest(reqUrl, filePath) {
  // VIOLATION: var declaration (Legacy rule)
  var status = "pending";

  // VIOLATION: Deprecated url.parse (Legacy rule)
  var parsed = url.parse(reqUrl);

  // VIOLATION: Deprecated Buffer constructor (Legacy rule)
  var buf = new Buffer(parsed.hostname || "localhost");

  // VIOLATION: Deprecated fs.exists (Legacy rule)
  if (fs.exists(filePath)) {
    status = "processed";
  }

  return status;
}

module.exports = { handleRequest };
