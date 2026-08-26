import type { TestSuiteReport, TestSuiteGroup, TestResult, TestStatus } from "./types.js";

const STATUS_ICON: Record<TestStatus, string> = {
  passed: "\u2713",
  failed: "\u2717",
  skipped: "\u2192",
  error: "\u2717",
};

const STATUS_COLOR: Record<TestStatus, string> = {
  passed: "#16a34a",
  failed: "#dc2626",
  skipped: "#ca8a04",
  error: "#dc2626",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function renderTest(test: TestResult): string {
  const icon = STATUS_ICON[test.status];
  const color = STATUS_COLOR[test.status];
  const duration = test.duration != null ? `<span class="duration">${formatDuration(test.duration)}</span>` : "";
  const retryBadge = test.retries && test.retries > 0
    ? `<span class="retry-badge">${test.retries} retry</span>`
    : "";
  const errorBlock = test.error
    ? `<pre class="error-detail">${escapeHtml(test.error)}</pre>`
    : "";

  return `
    <tr class="test-row test-${test.status}">
      <td class="test-status" style="color: ${color}">${icon}</td>
      <td class="test-name">${escapeHtml(test.name)}${retryBadge}</td>
      <td class="test-duration">${duration}</td>
    </tr>
    ${errorBlock ? `<tr class="error-row"><td></td><td colspan="2">${errorBlock}</td></tr>` : ""}`;
}

function renderSuiteGroup(group: TestSuiteGroup, depth: number = 0): string {
  const indent = depth * 20;
  const groupTests = group.tests.map(renderTest).join("");
  const nestedGroups = (group.groups ?? []).map((g) => renderSuiteGroup(g, depth + 1)).join("");

  return `
    <div class="suite-group" style="margin-left: ${indent}px">
      <h3 class="suite-name">${escapeHtml(group.name)}</h3>
      <table class="tests-table">
        <tbody>${groupTests}</tbody>
      </table>
      ${nestedGroups}
    </div>`;
}

function renderSummary(report: TestSuiteReport): string {
  const { summary } = report;
  const passRate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
  const barWidth = 100;
  const passedWidth = summary.total > 0 ? (summary.passed / summary.total) * barWidth : 0;
  const failedWidth = summary.total > 0 ? (summary.failed / summary.total) * barWidth : 0;

  return `
    <div class="summary-card">
      <div class="summary-grid">
        <div class="summary-stat">
          <span class="stat-value">${summary.total}</span>
          <span class="stat-label">Total</span>
        </div>
        <div class="summary-stat stat-passed">
          <span class="stat-value">${summary.passed}</span>
          <span class="stat-label">Passed</span>
        </div>
        <div class="summary-stat stat-failed">
          <span class="stat-value">${summary.failed}</span>
          <span class="stat-label">Failed</span>
        </div>
        <div class="summary-stat stat-skipped">
          <span class="stat-value">${summary.skipped}</span>
          <span class="stat-label">Skipped</span>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-passed" style="width: ${passedWidth}%"></div>
        <div class="progress-failed" style="width: ${failedWidth}%"></div>
      </div>
      <div class="summary-meta">
        <span>${passRate}% pass rate</span>
        <span>Duration: ${formatDuration(report.duration)}</span>
      </div>
    </div>`;
}

function renderMetadata(report: TestSuiteReport): string {
  const entries = Object.entries(report.metadata ?? {});
  if (entries.length === 0) return "";
  const rows = entries.map(([k, v]) => `<tr><td class="meta-key">${escapeHtml(k)}</td><td class="meta-value">${escapeHtml(v)}</td></tr>`).join("");
  return `
    <div class="metadata-section">
      <h3>Environment</h3>
      <table class="metadata-table">${rows}</table>
    </div>`;
}

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a2e;
    background: #fff;
    line-height: 1.6;
    padding: 40px;
    max-width: 960px;
    margin: 0 auto;
  }

  /* Header */
  .report-header {
    border-bottom: 3px solid #e2e8f0;
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .report-header h1 {
    font-size: 24px;
    font-weight: 700;
    color: #0f172a;
    margin-bottom: 4px;
  }
  .report-header .timestamp {
    font-size: 13px;
    color: #64748b;
  }

  /* Summary Card */
  .summary-card {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 28px;
  }
  .summary-grid {
    display: flex;
    gap: 32px;
    margin-bottom: 16px;
  }
  .summary-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .stat-value {
    font-size: 28px;
    font-weight: 700;
    color: #0f172a;
    line-height: 1;
  }
  .stat-label {
    font-size: 12px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 4px;
  }
  .stat-passed .stat-value { color: #16a34a; }
  .stat-failed .stat-value { color: #dc2626; }
  .stat-skipped .stat-value { color: #ca8a04; }

  .progress-bar {
    height: 6px;
    background: #e2e8f0;
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .progress-passed { background: #16a34a; height: 100%; float: left; }
  .progress-failed { background: #dc2626; height: 100%; float: left; }

  .summary-meta {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: #64748b;
  }

  /* Suite Groups */
  .suite-group {
    margin-bottom: 20px;
  }
  .suite-name {
    font-size: 15px;
    font-weight: 600;
    color: #334155;
    padding: 8px 12px;
    background: #f1f5f9;
    border-radius: 4px;
    margin-bottom: 4px;
  }

  /* Tests Table */
  .tests-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 8px;
  }
  .test-row td {
    padding: 6px 12px;
    border-bottom: 1px solid #f1f5f9;
    font-size: 14px;
  }
  .test-status {
    width: 28px;
    font-weight: 700;
    font-size: 16px;
    text-align: center;
  }
  .test-name {
    font-weight: 400;
    color: #1e293b;
  }
  .test-duration {
    width: 80px;
    text-align: right;
    color: #94a3b8;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .retry-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 6px;
    font-size: 11px;
    background: #fef3c7;
    color: #92400e;
    border-radius: 3px;
    vertical-align: middle;
  }

  /* Error Details */
  .error-detail {
    margin: 4px 12px 8px 40px;
    padding: 10px 14px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 4px;
    font-size: 12px;
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
    color: #991b1b;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }

  /* Metadata */
  .metadata-section {
    margin-top: 28px;
    padding-top: 16px;
    border-top: 1px solid #e2e8f0;
  }
  .metadata-section h3 {
    font-size: 13px;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .metadata-table {
    font-size: 13px;
  }
  .metadata-table td {
    padding: 3px 16px 3px 0;
  }
  .meta-key {
    color: #64748b;
    font-weight: 500;
  }
  .meta-value {
    color: #1e293b;
  }

  /* Print / PDF */
  @media print {
    body { padding: 20px; }
    .suite-group { break-inside: avoid; }
    .test-row { break-inside: avoid; }
    .error-detail { break-inside: avoid; }
  }
`;

export function renderReportHtml(report: TestSuiteReport): string {
  const suites = report.suites.map((s) => renderSuiteGroup(s)).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="report-header">
    <h1>${escapeHtml(report.title)}</h1>
    <div class="timestamp">Generated: ${escapeHtml(report.timestamp)}</div>
  </header>

  ${renderSummary(report)}

  <section class="results-section">
    <h2 style="font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #334155;">Results</h2>
    ${suites}
  </section>

  ${renderMetadata(report)}
</body>
</html>`;
}
