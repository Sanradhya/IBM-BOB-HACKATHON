"use client";

import React, { useMemo } from "react";

interface Line {
  type: "added" | "removed" | "context";
  content: string;
  lineNo: number | null;
}

function computeLineDiff(original: string, fixed: string): { left: Line[]; right: Line[] } {
  const origLines = original.split("\n");
  const fixedLines = fixed.split("\n");

  // Build a simple LCS-based diff
  const m = origLines.length;
  const n = fixedLines.length;

  // dp[i][j] = LCS length for origLines[0..i-1], fixedLines[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origLines[i - 1] === fixedLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff segments
  const segments: Array<{ type: "equal" | "replace" | "delete" | "insert"; orig: string[]; fixed: string[] }> = [];
  let i = m, j = n;
  const ops: Array<{ type: "eq" | "del" | "ins"; oi: number; fi: number }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === fixedLines[j - 1]) {
      ops.unshift({ type: "eq", oi: i - 1, fi: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "ins", oi: -1, fi: j - 1 });
      j--;
    } else {
      ops.unshift({ type: "del", oi: i - 1, fi: -1 });
      i--;
    }
  }

  const left: Line[] = [];
  const right: Line[] = [];
  let origNo = 1, fixedNo = 1;

  for (const op of ops) {
    if (op.type === "eq") {
      left.push({ type: "context", content: origLines[op.oi], lineNo: origNo++ });
      right.push({ type: "context", content: fixedLines[op.fi], lineNo: fixedNo++ });
    } else if (op.type === "del") {
      left.push({ type: "removed", content: origLines[op.oi], lineNo: origNo++ });
      right.push({ type: "added", content: "", lineNo: null }); // blank spacer
    } else {
      left.push({ type: "removed", content: "", lineNo: null }); // blank spacer
      right.push({ type: "added", content: fixedLines[op.fi], lineNo: fixedNo++ });
    }
  }

  return { left, right };
}

interface FileDiffViewerProps {
  originalCode: string;
  fixedCode: string;
  filePath: string;
}

export default function FileDiffViewer({
  originalCode,
  fixedCode,
  filePath,
}: FileDiffViewerProps) {
  const { left, right } = useMemo(
    () => computeLineDiff(originalCode, fixedCode),
    [originalCode, fixedCode],
  );

  const renderLine = (line: Line, side: "left" | "right") => {
    const isBlank = line.lineNo === null;
    const bg =
      line.type === "removed"
        ? isBlank
          ? "var(--diff-blank)"
          : "var(--diff-del-bg)"
        : line.type === "added"
        ? isBlank
          ? "var(--diff-blank)"
          : "var(--diff-add-bg)"
        : "transparent";

    const linenoColour =
      line.type === "removed" && !isBlank
        ? "var(--diff-del-lineno)"
        : line.type === "added" && !isBlank
        ? "var(--diff-add-lineno)"
        : "var(--diff-lineno)";

    return (
      <div className="diff-line" style={{ background: bg }}>
        <span className="diff-lineno" style={{ color: linenoColour }}>
          {line.lineNo ?? ""}
        </span>
        <span className="diff-gutter">
          {line.type === "removed" && !isBlank
            ? "−"
            : line.type === "added" && !isBlank
            ? "+"
            : " "}
        </span>
        <pre className="diff-code">{line.content}</pre>
      </div>
    );
  };

  return (
    <div className="diff-split-container">
      {/* ── Left pane: original (bad code) ─────────────────── */}
      <div className="diff-pane diff-pane-left">
        <div className="diff-pane-header diff-pane-header-left">
          <span className="diff-pane-label">◀ Original</span>
          <span className="diff-pane-filename">{filePath}</span>
        </div>
        <div className="diff-pane-body">
          {left.map((line, idx) => (
            <React.Fragment key={idx}>{renderLine(line, "left")}</React.Fragment>
          ))}
        </div>
      </div>

      {/* ── Divider ──────────────────────────────────────────── */}
      <div className="diff-divider" aria-hidden="true" />

      {/* ── Right pane: fixed (correct code) ──────────────── */}
      <div className="diff-pane diff-pane-right">
        <div className="diff-pane-header diff-pane-header-right">
          <span className="diff-pane-label">Fixed ▶</span>
          <span className="diff-pane-filename">{filePath}</span>
        </div>
        <div className="diff-pane-body">
          {right.map((line, idx) => (
            <React.Fragment key={idx}>{renderLine(line, "right")}</React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
