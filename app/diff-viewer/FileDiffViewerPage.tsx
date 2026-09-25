"use client";

import { useState } from "react";
import FileDiffViewer from "../components/FileDiffViewer";

export interface DiffFile {
  filePath: string;
  title: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  originalCode: string;
  fixedCode: string;
  description: string;
}

interface FileDiffViewerPageProps {
  files: DiffFile[];
  initialIndex?: number;
}

export default function FileDiffViewerPage({
  files,
  initialIndex = 0,
}: FileDiffViewerPageProps) {
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  if (!files || files.length === 0) {
    return (
      <div className="no-issues">
        <p>No issues found to display.</p>
      </div>
    );
  }

  const current = files[activeIndex];

  const severityColour: Record<DiffFile["severity"], string> = {
    Critical: "#dc2626",
    High: "#ea580c",
    Medium: "#d97706",
    Low: "#65a30d",
  };

  return (
    <div className="diff-page">
      {/* ── Sidebar: file list ─────────────────────────────── */}
      <aside className="diff-sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">Issues Found</span>
          <span className="sidebar-count">{files.length}</span>
        </div>
        <ul className="sidebar-list">
          {files.map((f, i) => (
            <li
              key={i}
              className={`sidebar-item ${i === activeIndex ? "active" : ""}`}
              onClick={() => setActiveIndex(i)}
            >
              <span
                className="severity-dot"
                style={{ background: severityColour[f.severity] }}
              />
              <div className="sidebar-item-text">
                <span className="sidebar-item-title">{f.title}</span>
                <span className="sidebar-item-path">{f.filePath}</span>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Main panel: side-by-side diff ──────────────────── */}
      <main className="diff-main">
        <div className="diff-header">
          <div className="diff-header-left">
            <span
              className="diff-severity-badge"
              style={{ background: severityColour[current.severity] }}
            >
              {current.severity}
            </span>
            <h2 className="diff-issue-title">{current.title}</h2>
          </div>
          <span className="diff-filepath">{current.filePath}</span>
        </div>

        {current.description && (
          <p className="diff-description">{current.description}</p>
        )}

        <FileDiffViewer
          originalCode={current.originalCode}
          fixedCode={current.fixedCode}
          filePath={current.filePath}
        />

        {/* ── Navigation ─────────────────────────────────── */}
        <div className="diff-nav">
          <button
            className="diff-nav-btn"
            disabled={activeIndex === 0}
            onClick={() => setActiveIndex((i) => i - 1)}
          >
            ← Previous
          </button>
          <span className="diff-nav-counter">
            {activeIndex + 1} / {files.length}
          </span>
          <button
            className="diff-nav-btn"
            disabled={activeIndex === files.length - 1}
            onClick={() => setActiveIndex((i) => i + 1)}
          >
            Next →
          </button>
        </div>
      </main>
    </div>
  );
}
