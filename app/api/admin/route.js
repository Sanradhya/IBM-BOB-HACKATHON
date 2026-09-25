// Missing authentication middleware!
import { execSync } from "child_process";

export async function GET(request) {
  var legacyVar = "This is outdated";
  var myBuffer = new Buffer("unsafe memory allocation");
  
  // Unhandled side effect
  execSync("echo 'doing something dangerous'");

  return new Response(myBuffer.toString(), { status: 200 });
}
