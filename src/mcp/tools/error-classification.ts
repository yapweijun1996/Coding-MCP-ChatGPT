import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type RootCause =
  | "schema"
  | "syntax"
  | "import-export"
  | "missing-file"
  | "css-layout"
  | "network"
  | "permission"
  | "safety-block"
  | "runtime-logic"
  | "validation"
  | "test-failure"
  | "unknown";

type FailureInput = {
  source?: string;
  toolName?: string;
  summary?: string;
  logs?: string[];
  errors?: string[];
  details?: Record<string, unknown>;
};

type ClassifiedFailure = {
  id: string;
  rootCause: RootCause;
  severity: "high" | "medium" | "low";
  title: string;
  likelyCause: string;
  reasonCategory?: string;
  safeRetrySuggestion?: string;
  occurrences: number;
  sources: string[];
  affectedFiles: string[];
  affectedSelectors: string[];
  evidence: string[];
  suggestedFixes: string[];
  recommendedNextTool: string;
};

const failureInputSchema = z.object({
  source: z.string().min(1).max(240).optional(),
  toolName: z.string().min(1).max(160).optional(),
  summary: z.string().min(1).max(2000).optional(),
  logs: z.array(z.string().max(12000)).max(20).optional().default([]),
  errors: z.array(z.string().max(12000)).max(20).optional().default([]),
  details: z.record(z.string(), z.unknown()).optional().default({})
});

const classifyProjectErrorsInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  failures: z.array(failureInputSchema).max(100).optional().default([]),
  rawText: z.string().min(1).max(60000).optional(),
  includeProjectHistory: z.boolean().default(true),
  outputJsonPath: z.string().min(1).max(240).default("diagnostics/error-classification.json"),
  outputMarkdownPath: z.string().min(1).max(240).default("diagnostics/error-classification.md")
});

const PATTERNS: Array<{
  rootCause: RootCause;
  severity: "high" | "medium" | "low";
  title: string;
  likelyCause: string;
  match: RegExp;
  suggestedFixes: string[];
  recommendedNextTool: string;
}> = [
  {
    rootCause: "schema",
    severity: "medium",
    title: "Invalid tool arguments or schema mismatch",
    likelyCause: "A tool was called with missing, misspelled, or incorrectly typed arguments.",
    match: /Invalid arguments|ZodError|required|unrecognized key|Expected .*received|too_small|too_big|invalid_type/i,
    suggestedFixes: ["Read the tool schema, correct field names and types, and retry with the smallest valid payload.", "If content exceeds a limit, split it across files or reduce optional fields."],
    recommendedNextTool: "get_agent_skill"
  },
  {
    rootCause: "syntax",
    severity: "high",
    title: "Syntax or parse error",
    likelyCause: "Source code or markup contains invalid syntax that prevents parsing or compilation.",
    match: /SyntaxError|Unexpected token|Unterminated|string literal|Parse error|TS1005|TS1128|Babel parser|Unexpected end of input/i,
    suggestedFixes: ["Open the referenced file and fix the nearest syntax error first.", "Run typecheck or build again after the smallest edit."],
    recommendedNextTool: "read_project_file"
  },
  {
    rootCause: "import-export",
    severity: "high",
    title: "Import/export mismatch",
    likelyCause: "A module import references a missing file, wrong path, or export name that does not exist.",
    match: /does not provide an export named|has no exported member|export .* not found|Module .* has no exported|Failed to resolve import|Cannot resolve module|ERR_MODULE_NOT_FOUND/i,
    suggestedFixes: ["Check the imported path and exported symbol names in both files.", "Prefer a local search for the symbol before renaming or adding exports."],
    recommendedNextTool: "search_in_project"
  },
  {
    rootCause: "missing-file",
    severity: "high",
    title: "Missing file or asset",
    likelyCause: "A referenced source file, static asset, package file, or route target is absent.",
    match: /ENOENT|no such file|file not found|Cannot find module|Cannot find package|404 .*\.|Not found:.*\.(?:js|css|html|png|jpg|jpeg|webp|svg|json)/i,
    suggestedFixes: ["Inspect the project manifest and verify the referenced path exists.", "Create the missing file, fix the reference path, or restore it from backup."],
    recommendedNextTool: "get_project_manifest"
  },
  {
    rootCause: "css-layout",
    severity: "medium",
    title: "CSS layout or responsive rendering issue",
    likelyCause: "The page likely has overflow, clipping, overlap, hidden content, or responsive sizing issues.",
    match: /horizontal overflow|overflow|overlap|clipped|behind .*footer|z-index|viewport|layout shift|not visible|covered by|outside the visible viewport/i,
    suggestedFixes: ["Inspect the affected selector at desktop and mobile sizes.", "Add responsive constraints, wrapping, safe spacing, or z-index adjustments and rerun visual QA."],
    recommendedNextTool: "inspect_dom_at_point"
  },
  {
    rootCause: "network",
    severity: "medium",
    title: "Network, server, or request failure",
    likelyCause: "A request failed because the server was unavailable, timed out, blocked by CORS, or returned an error status.",
    match: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out|timeout|net::ERR|Failed to fetch|fetch failed|CORS|HTTP 5\d\d|HTTP 4\d\d|ERR_CONNECTION/i,
    suggestedFixes: ["Confirm the local server or mock API is running and the URL is correct.", "Use mock API states to reproduce empty, error, auth-expired, and slow paths."],
    recommendedNextTool: "inspect_network_conditions"
  },
  {
    rootCause: "permission",
    severity: "high",
    title: "Permission or authorization failure",
    likelyCause: "The operation lacks filesystem, API, auth, or role permission.",
    match: /EACCES|EPERM|permission denied|Forbidden|Unauthorized|\b401\b|\b403\b|not authorized|access denied/i,
    suggestedFixes: ["Check the requested path, user/session state, and permission scope.", "Do not bypass authorization; adjust the allowed target or authenticate correctly."],
    recommendedNextTool: "check_project_scope"
  },
  {
    rootCause: "safety-block",
    severity: "high",
    title: "Safety or scope block",
    likelyCause: "A guard rejected the action because it may escape project scope, access a private network, or violate a safety boundary.",
    match: /unsafe path|path traversal|outside workspace|outside project|private-network|blocked by|safety|denylist|not within|sandbox escape/i,
    suggestedFixes: ["Keep paths inside the bound project/workspace and avoid private-network URLs.", "Use the permission/scope tools to understand the allowed boundary before retrying."],
    recommendedNextTool: "check_workspace_path_scope"
  },
  {
    rootCause: "runtime-logic",
    severity: "high",
    title: "Runtime logic error",
    likelyCause: "The app started but JavaScript logic failed at runtime.",
    match: /ReferenceError|TypeError|RangeError|Cannot read properties|is not a function|undefined is not|pageerror|console error|Unhandled promise rejection/i,
    suggestedFixes: ["Trace the runtime error to the referenced component or handler.", "Add null guards, initialize state, or fix event/data flow, then rerun browser inspection."],
    recommendedNextTool: "inspect_webpage_plus"
  },
  {
    rootCause: "validation",
    severity: "medium",
    title: "Project validation failure",
    likelyCause: "Static validation detected missing entry files, invalid HTML, unsafe references, or publish-readiness gaps.",
    match: /validation failed|validate_project|invalid html|missing entry|publish.*failed|PWA.*missing|accessibility.*failed/i,
    suggestedFixes: ["Read the validation findings and fix the highest severity entry first.", "Rerun project validation before publishing."],
    recommendedNextTool: "validate_project"
  },
  {
    rootCause: "test-failure",
    severity: "medium",
    title: "Automated test failure",
    likelyCause: "A unit, integration, or browser test assertion failed.",
    match: /AssertionError|not ok|FAIL|✖|expected .*actual|tests? failed|locator|Playwright|Vitest|Jest/i,
    suggestedFixes: ["Read the failing assertion and reproduce the smallest test case.", "Fix behavior before updating snapshots or expectations."],
    recommendedNextTool: "test_failure_digest"
  }
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFromFailure(failure: FailureInput): string {
  return normalizeWhitespace([
    failure.toolName,
    failure.source,
    failure.summary,
    ...(failure.errors ?? []),
    ...(failure.logs ?? []),
    JSON.stringify(failure.details ?? {})
  ].filter(Boolean).join("\n"));
}

function sourceLabel(failure: FailureInput, index: number): string {
  return failure.source ?? failure.toolName ?? `failure-${index + 1}`;
}

function classify(text: string) {
  return PATTERNS.find((pattern) => pattern.match.test(text)) ?? {
    rootCause: "unknown" as const,
    severity: "low" as const,
    title: "Unclassified failure",
    likelyCause: "No known signature matched this failure text.",
    suggestedFixes: ["Inspect the full logs, identify the first failing operation, and add a more specific diagnostic record if this recurs."],
    recommendedNextTool: "diagnostic_bundle"
  };
}

function safetyBlockDetails(text: string): { reasonCategory: string; safeRetrySuggestion: string } | undefined {
  if (!/blocked by|safety|denylist|unsafe|outside|private-network|sandbox escape|path traversal/i.test(text)) return undefined;
  if (/private-network|localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\./i.test(text)) {
    return {
      reasonCategory: "private-network-url",
      safeRetrySuggestion: "Retry with a public HTTPS URL, a project-published URL, or an approved local inspection tool instead of sending private-network URLs through the blocked call."
    };
  }
  if (/path traversal|\.\.\/|unsafe path|outside workspace|outside project|not within|sandbox escape/i.test(text)) {
    return {
      reasonCategory: "path-scope-escape",
      safeRetrySuggestion: "Retry with a normalized relative path inside the bound project/workspace, or inspect scope first before writing or reading files."
    };
  }
  if (/secret|credential|token|api[_ -]?key|password|private key/i.test(text)) {
    return {
      reasonCategory: "secret-or-credential-risk",
      safeRetrySuggestion: "Remove secrets from the payload and use environment variables, secret storage, or a redacted placeholder before retrying."
    };
  }
  if (/rm -rf|delete|destructive|reset --hard|force push|drop table|truncate/i.test(text)) {
    return {
      reasonCategory: "destructive-action-risk",
      safeRetrySuggestion: "Use a non-destructive inspection or preview step first, create a backup if applicable, and request explicit approval before retrying destructive operations."
    };
  }
  if (/large|too long|payload|content|size|1048576|data uri|base64|blocked by safety checks|double check/i.test(text)) {
    return {
      reasonCategory: "client-preflight-content-guard",
      safeRetrySuggestion: "Retry with a smaller bounded payload: split large files, avoid large inline data/base64, use project file tools for chunks, or pass a file path/artifact reference instead of raw content."
    };
  }
  return {
    reasonCategory: "unknown-safety-guard",
    safeRetrySuggestion: "Retry with the smallest safe input, remove unrelated content, keep paths and URLs in allowed scope, and run classify_project_errors with the exact blocked message if it recurs."
  };
}

function extractFiles(text: string): string[] {
  const values = new Set<string>();
  const patterns = [
    /(?:^|\s)([A-Za-z0-9._/-]+\.(?:tsx|ts|jsx|js|mjs|cjs|css|html|json|svg|png|jpe?g|webp|md))(?::\d+(?::\d+)?)?/g,
    /["'`]([^"'`]+\/[^"'`]+\.(?:tsx|ts|jsx|js|css|html|json|svg|png|jpe?g|webp))["'`]/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const filePath = match[1]?.replace(/^\.\//, "");
      if (filePath && !/^https?:\/\//i.test(filePath)) values.add(filePath);
    }
  }
  return [...values].slice(0, 20);
}

function extractSelectors(text: string): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(/(?:selector|locator|element)[:=]\s*["'`]?([.#][A-Za-z0-9_-][A-Za-z0-9_.#:[\]-]*)/gi)) {
    if (match[1]) values.add(normalizeWhitespace(match[1]).slice(0, 120));
  }
  for (const match of text.matchAll(/(?:^|[\s"'`(])([.#][A-Za-z][A-Za-z0-9_-]{2,})\b/g)) {
    if (match[1] && values.size < 10) values.add(match[1]);
  }
  return [...values].slice(0, 15);
}

function signature(rootCause: RootCause, text: string, files: string[]): string {
  const file = files[0] ?? "";
  if (file) return `${rootCause}:${file}`;
  const main = normalizeWhitespace(text)
    .replace(/\d+:\d+/g, "")
    .replace(/[0-9a-f]{8,}/gi, "")
    .replace(/\b\d+\b/g, "")
    .slice(0, 180)
    .toLowerCase();
  return `${rootCause}:${file}:${main}`;
}

function evidenceLines(text: string): string[] {
  return text
    .split(/\r?\n|(?<=\.)\s+/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 8)
    .slice(0, 4);
}

function classifyFailures(failures: FailureInput[]): ClassifiedFailure[] {
  const groups = new Map<string, ClassifiedFailure>();
  failures.forEach((failure, index) => {
    const text = textFromFailure(failure);
    if (!text) return;
    const pattern = classify(text);
    const safetyDetails = pattern.rootCause === "safety-block" ? safetyBlockDetails(text) : undefined;
    const affectedFiles = extractFiles(text);
    const affectedSelectors = extractSelectors(text);
    const key = signature(pattern.rootCause, text, affectedFiles);
    const existing = groups.get(key);
    const source = sourceLabel(failure, index);
    if (existing) {
      existing.occurrences += 1;
      existing.sources = [...new Set([...existing.sources, source])];
      existing.affectedFiles = [...new Set([...existing.affectedFiles, ...affectedFiles])].slice(0, 20);
      existing.affectedSelectors = [...new Set([...existing.affectedSelectors, ...affectedSelectors])].slice(0, 15);
      existing.evidence = [...new Set([...existing.evidence, ...evidenceLines(text)])].slice(0, 8);
      return;
    }
    groups.set(key, {
      id: `${pattern.rootCause}-${groups.size + 1}`,
      rootCause: pattern.rootCause,
      severity: pattern.severity,
      title: pattern.title,
      likelyCause: pattern.likelyCause,
      reasonCategory: safetyDetails?.reasonCategory,
      safeRetrySuggestion: safetyDetails?.safeRetrySuggestion,
      occurrences: 1,
      sources: [source],
      affectedFiles,
      affectedSelectors,
      evidence: evidenceLines(text),
      suggestedFixes: pattern.suggestedFixes,
      recommendedNextTool: pattern.recommendedNextTool
    });
  });
  return [...groups.values()].sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || right.occurrences - left.occurrences);
}

function severityRank(severity: "high" | "medium" | "low"): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function markdown(report: { projectId?: string; totalFailures: number; groups: ClassifiedFailure[]; summary: Record<string, number> }) {
  const rows = report.groups.map((group) => `| ${group.severity} | ${group.rootCause} | ${group.occurrences} | ${group.affectedFiles.join(", ") || "-"} | ${group.recommendedNextTool} | ${group.title.replaceAll("|", "\\|")} |`).join("\n");
  const details = report.groups.map((group) => `### ${group.id}: ${group.title}

- Likely cause: ${group.likelyCause}
${group.reasonCategory ? `- Reason category: ${group.reasonCategory}
` : ""}${group.safeRetrySuggestion ? `- Safe retry: ${group.safeRetrySuggestion}
` : ""}- Sources: ${group.sources.join(", ")}
- Affected selectors: ${group.affectedSelectors.join(", ") || "-"}
- Evidence: ${group.evidence.join(" / ") || "-"}
- Suggested fixes: ${group.suggestedFixes.join(" ")}
`).join("\n");
  return `# Error Classification Report

- Project: ${report.projectId ? `\`${report.projectId}\`` : "none"}
- Input failures: ${report.totalFailures}
- Groups: ${report.groups.length}

## Summary

\`\`\`json
${JSON.stringify(report.summary, null, 2)}
\`\`\`

## Groups

| Severity | Root Cause | Count | Affected Files | Next Tool | Title |
| --- | --- | ---: | --- | --- | --- |
${rows || "| low | unknown | 0 | - | diagnostic_bundle | No failures supplied. |"}

## Details

${details || "No failure groups."}
`;
}

function summarize(groups: ClassifiedFailure[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const group of groups) output[group.rootCause] = (output[group.rootCause] ?? 0) + group.occurrences;
  return output;
}

function historyFailures(manifest: Awaited<ReturnType<typeof getProjectManifest>>): FailureInput[] {
  return manifest.taskHistory
    .filter((item) => item.ok === false)
    .map((item, index) => ({
      source: `project-history-${index + 1}`,
      toolName: item.toolName,
      summary: item.summary,
      logs: [],
      errors: [],
      details: item.details as Record<string, unknown> | undefined
    }));
}

export const errorClassificationTools: ToolModule[] = [
  {
    definition: {
      name: "classify_project_errors",
      description: "Classify raw validation, browser QA, build/test, or tool failures into root-cause groups with duplicate grouping, affected files/selectors, suggested fixes, and recommended next tool calls.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          failures: { type: "array", items: { type: "object" } },
          rawText: { type: "string" },
          includeProjectHistory: { type: "boolean" },
          outputJsonPath: { type: "string" },
          outputMarkdownPath: { type: "string" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: classifyProjectErrorsInputSchema,
    handler: async (input, ctx) => {
      const parsed = classifyProjectErrorsInputSchema.parse(input);
      const manifest = parsed.projectId && parsed.includeProjectHistory ? await getProjectManifest(ctx.projectRoot, parsed.projectId).catch(() => undefined) : undefined;
      const failures: FailureInput[] = [
        ...parsed.failures,
        ...(parsed.rawText ? [{ source: "rawText", summary: parsed.rawText }] : []),
        ...(manifest ? historyFailures(manifest) : [])
      ];
      const groups = classifyFailures(failures);
      const report = { projectId: parsed.projectId, totalFailures: failures.length, groups, summary: summarize(groups) };
      const artifacts: string[] = [];
      if (parsed.projectId) {
        const jsonFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
        const markdownFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputMarkdownPath, markdown(report));
        artifacts.push(jsonFile.path, markdownFile.path);
        await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "classify_project_errors", ok: true, summary: `Classified ${failures.length} failure(s) into ${groups.length} group(s).`, details: { outputJsonPath: jsonFile.path, outputMarkdownPath: markdownFile.path, summary: report.summary } });
      }
      return { ok: true, summary: `Classified ${failures.length} failure(s) into ${groups.length} group(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  }
];
