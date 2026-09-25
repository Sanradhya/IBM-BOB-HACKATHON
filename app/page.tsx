import Link from "next/link";

export default function HomePage() {
  return (
    <div className="home-container">
      <h1 className="home-logo">🔍 Blindspot</h1>
      <p className="home-tagline">Local AI code reviewer — catches what git diff misses.</p>

      <div className="home-card">
        <h2>Side-by-Side Diff Viewer</h2>
        <p>
          Blindspot detected <strong>9 issues</strong> across{" "}
          <code>lib/auth.js</code>, <code>lib/dataProcessor.js</code>, and{" "}
          <code>lib/fileHandler.js</code> on this branch. Open the viewer to
          inspect each finding — the left pane shows the original (buggy) code
          highlighted in red; the right pane shows the corrected version in green.
        </p>
        <Link href="/diff-viewer" className="btn">
          Open Diff Viewer →
        </Link>
      </div>

      <div className="home-card">
        <h2>Issues on this branch</h2>
        <p>
          This branch (<code>demo-wrong-code</code>) contains intentional code
          bugs across three files — logic errors, security vulnerabilities, and
          bad practices — designed to demonstrate Blindspot&apos;s detection and
          side-by-side fix presentation.
        </p>
        <ul style={{ marginTop: 12, paddingLeft: 20, color: "var(--muted)", fontSize: 13 }}>
          <li><code>lib/auth.js</code> — MD5 password hashing, timing attack, hardcoded secret, eval()</li>
          <li><code>lib/dataProcessor.js</code> — off-by-one loop, array mutation, SQL injection</li>
          <li><code>lib/fileHandler.js</code> — path traversal, sync I/O in async, missing encoding</li>
        </ul>
      </div>
    </div>
  );
}
