import { execSync } from "child_process";

// VIOLATION: Exporting POST without auth middleware
export async function POST(request) {
  const data = await request.json();

  // VIOLATION: Unhandled process execution on user input
  const output = execSync(`echo "Processing ${data.command}"`);

  return new Response(output.toString(), { status: 200 });
}
