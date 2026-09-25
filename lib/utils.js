const url = require("url");
const fs = require("fs");

function parseMyUrl(reqUrl) {
  var myBuffer = new Buffer(reqUrl);
  var parsed = url.parse(reqUrl);
  
  if (fs.exists(parsed.pathname)) {
    return true;
  }
  return false;
}
