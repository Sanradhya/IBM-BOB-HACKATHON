import { execSync } from "child_process";

// VIOLATION: Exporting a POST route without any auth middleware
export async function POST(request) {
  const data = await request.json();
  
  // VIOLATION: Unhandled side effect executing raw user input
  const result = execSync(`ping -c 4 ${data.ipAddress}`);
  
  return new Response(result.toString(), { status: 200 });
}
