export type SkillStatus = "stable" | "beta" | "disabled";
export type SkillRiskLevel = "low" | "medium" | "high";

export interface SkillDefinition {
  id: string;
  label: string;
  category: string;
  description: string;
  enabledByDefault: boolean;
  status: SkillStatus;
  riskLevel: SkillRiskLevel;
  toolNames: readonly string[];
  protocolMarkdown: string;
}

export const skillRegistry: readonly SkillDefinition[] = [
  {
    id: "core",
    label: "Core Agent Basics",
    category: "foundation",
    description: "Baseline discovery, safe read-only workspace access, project lookup, and skill protocol retrieval.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "ping",
      "create_preview",
      "list_agent_skills",
      "get_agent_skill",
      "list_projects",
      "get_project",
      "get_project_manifest",
      "get_project_activity",
      "read_project_file",
      "list_project_files",
      "search_in_project",
      "list_dir",
      "read_file",
      "search_files",
      "file_exists",
      "symlink_info",
      "file_info",
      "file_hash",
      "folder_size",
      "tail_file",
      "git_status",
      "git_diff",
      "git_diff_staged",
      "git_show",
      "git_blame",
      "git_ls_files",
      "git_log",
      "git_rev_parse",
      "git_show_ref",
      "git_for_each_ref",
      "git_cat_file",
      "git_check_ref_format",
      "git_merge_base",
      "git_count_objects",
      "git_verify_pack",
      "git_fsck",
      "git_reflog",
      "git_symbolic_ref",
      "git_name_rev",
      "refactor_hints",
      "report_issue",
      "list_reported_issues",
      "run_tool_async",
      "get_job_status"
    ],
    protocolMarkdown: `# Core Agent Basics

Use this skill to discover the available workspace/project context before taking larger actions.

- Prefer read-only project and workspace inspection first.
- Use \`refactor_hints\` when the agent needs advisory signals for oversized or mixed-responsibility files before proposing refactor work.
- Use \`list_agent_skills\` and \`get_agent_skill\` when the agent needs to know which protocols are available.
- Use \`report_issue\` to flag any tool error, missing capability, or unclear behavior you hit instead of silently giving up; use \`list_reported_issues\` to check for an existing report before filing a duplicate.
- Keep destructive file, process, and git actions out of this baseline path.`
  },
  {
    id: "coding",
    label: "Coding Delivery",
    category: "development",
    description: "Create, edit, validate, build, test, and publish coding projects through the MCP project workflow.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_project",
      "list_projects",
      "get_project",
      "get_project_manifest",
      "get_project_activity",
      "write_project_file",
      "write_project_asset",
      "import_project_asset_from_url",
      "deliver_static_project",
      "create_app_project",
      "write_app_project_file",
      "read_app_project_file",
      "install_project_dependencies",
      "run_project_dev",
      "stop_project_dev",
      "run_project_build",
      "publish_project_dist",
      "get_app_project_report",
      "bind_project_workspace",
      "init_project_git",
      "list_project_files",
      "search_in_project",
      "apply_patch",
      "write_project_workspace_asset",
      "import_project_workspace_asset_from_local_file",
      "run_project_npm_command",
      "inspect_project_workspace",
      "record_project_workspace_video",
      "publish_project_workspace",
      "record_project_task",
      "import_project_asset_from_local_file",
      "patch_project_file",
      "fork_project",
      "screenshot_project",
      "submit_review_feedback",
      "get_review_feedback",
      "resolve_review_feedback",
      "read_project_file",
      "delete_project_file",
      "validate_project",
      "publish_project",
      "publish_and_report",
      "write_file",
      "replace_in_file",
      "create_directory",
      "copy_file",
      "read_file",
      "search_files",
      "list_dir",
      "run_command",
      "run_typecheck",
      "run_tests",
      "run_build",
      "refactor_hints",
      "git_status",
      "git_diff",
      "git_diff_staged",
      "git_show",
      "git_log",
      "git_add",
      "git_commit",
      "git_branch",
      "git_checkout",
      "git_stash",
      "git_stash_apply",
      "git_stash_pop",
      "git_merge",
      "git_fetch",
      "git_remote",
      "git_revert",
      "repo_summary",
      "test_failure_digest",
      "changed_files_context",
      "search_project_docs",
      "extract_project_conventions",
      "write_agent_note",
      "api_healthcheck",
      "openapi_summary",
      "create_html_deck",
      "create_pptx_deck",
      "create_immersive_page",
      "create_video_presentation",
      "set_homepage",
      "clear_homepage",
      "get_homepage",
      "publish_blog_post",
      "list_blog_posts",
      "get_blog_post",
      "delete_blog_post",
      "set_blog_theme"
    ],
    protocolMarkdown: `# Coding Delivery

Use this skill when the user asks the agent to build, edit, validate, or publish project files.

- Prefer \`deliver_static_project\` for complete static HTML/CSS/JS deliverables.
- Use the app project workflow for React/Vue/Vite idea-to-demo requests: create, edit source, install, build, then publish dist.
- For incremental work, create or inspect a project, write files, validate, then publish.
- Use \`refactor_hints\` before broad cleanup to identify oversized modules, mixed responsibilities, and reviewable refactor candidates.
- Run typecheck/tests/build when the user asks for verification or when the change has shared behavior risk.
- Keep changes scoped to the requested project and preserve unrelated workspace state.`
  },
  {
    id: "debug",
    label: "Debug and Diagnostics",
    category: "debugging",
    description: "Run validation, inspect project history, and collect diagnostic signals for failed builds or broken pages.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "get_project",
      "get_project_manifest",
      "get_project_activity",
      "read_project_file",
      "validate_project",
      "run_command",
      "run_typecheck",
      "run_tests",
      "run_build",
      "run_lint",
      "run_format_check",
      "run_project_npm_command",
      "inspect_project_workspace",
      "record_project_workspace_video",
      "repo_summary",
      "test_failure_digest",
      "changed_files_context",
      "browser_dom_snapshot",
      "browser_network_trace",
      "browser_console_log",
      "browser_storage_snapshot",
      "run_a11y_audit_detailed",
      "run_visual_regression_snapshot",
      "run_smoke_flow",
      "diagnostic_bundle",
      "diagnostic_bundle_full",
      "check_url",
      "inspect_webpage",
      "inspect_webpage_plus",
      "audit_accessibility",
      "audit_lighthouse",
      "inspect_interaction_flow",
      "inspect_local_project"
    ],
    protocolMarkdown: `# Debug and Diagnostics

Use this skill to reproduce a failure, collect evidence, identify the root cause, and verify the repair.

- Start with the failing command, validation result, activity history, or browser inspection output.
- Explain the root cause before changing behavior.
- Prefer minimal fixes and rerun the smallest relevant check first.`
  },
  {
    id: "research",
    label: "Research Workspace",
    category: "research",
    description: "Persist research sources, evidence, notes, reports, and published research artifacts.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "create_research_project",
      "add_research_source",
      "list_research_sources",
      "add_research_note",
      "record_research_evidence",
      "get_research_manifest",
      "write_research_report",
      "publish_research_report"
    ],
    protocolMarkdown: `# Research Workspace

Use this skill when the agent needs to persist a research trail and publish a sourced report.

- The MCP stores sources, claims, evidence, notes, and reports.
- The agent should still use its own approved web/search tools for discovery.
- Every report should link findings back to stored source records.`
  },
  {
    id: "web-rebuild",
    label: "Web Capture and Rebuild",
    category: "web",
    description: "Capture webpages, analyze UI structure, and generate improved static pages.",
    enabledByDefault: true,
    status: "beta",
    riskLevel: "medium",
    toolNames: [
      "capture_webpage",
      "analyze_webpage_capture",
      "generate_improved_static_page"
    ],
    protocolMarkdown: `# Web Capture and Rebuild

Use this skill to inspect an existing webpage and rebuild it as a validated static project.

- Capture first, analyze the saved capture, then generate the improved page.
- Treat generated pages as project deliverables and validate before publishing.
- Keep source attribution and capture IDs in the final project history.`
  },
  {
    id: "browser-qa",
    label: "Browser QA",
    category: "quality",
    description: "Inspect webpages, accessibility, Lighthouse signals, and interaction flows.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "browser_dom_snapshot",
      "browser_network_trace",
      "browser_console_log",
      "browser_storage_snapshot",
      "run_a11y_audit_detailed",
      "run_visual_regression_snapshot",
      "run_smoke_flow",
      "inspect_webpage",
      "inspect_webpage_plus",
      "audit_accessibility",
      "audit_lighthouse",
      "inspect_interaction_flow",
      "inspect_local_project",
      "check_url"
    ],
    protocolMarkdown: `# Browser QA

Use this skill to validate runtime, layout, accessibility, and interaction behavior.

- Check console errors, page errors, failed requests, and horizontal overflow.
- Use accessibility and Lighthouse audits when the request needs quality evidence.
- Report blocking errors separately from warnings.`
  },
  {
    id: "agent-browser-observability",
    label: "Agent Browser Observability",
    category: "quality",
    description: "Collect browser runtime snapshots, traces, console, and storage data for scripted diagnostics.",
    enabledByDefault: false,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "browser_dom_snapshot",
      "browser_network_trace",
      "browser_console_log",
      "browser_storage_snapshot"
    ],
    protocolMarkdown: `# Agent Browser Observability

Use this skill when the agent needs deterministic evidence of DOM, network, console, and storage behavior.

- Prefer browser session-based observation before DOM mutation.
- Use traces for flaky request/page failures and console errors.
- Treat findings as evidence and keep fix proposals scoped.`
  },
  {
    id: "agent-code-intelligence",
    label: "Agent Code Intelligence",
    category: "development",
    description: "Summarize project structure and extract actionable signals from command outputs, diffs, and failure traces.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "repo_summary",
      "test_failure_digest",
      "changed_files_context"
    ],
    protocolMarkdown: `# Agent Code Intelligence

Use this skill for repository-level diagnostics before editing.

- Start with repo_summary and changed_files_context.
- Run test_failure_digest to get high-signal failure evidence.
- Use concrete command outputs for the next repair decision.`
  },
  {
    id: "agent-docs-knowledge",
    label: "Agent Docs and Knowledge",
    category: "knowledge",
    description: "Search and extract conventions from project docs, then write non-invasive agent notes.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "search_project_docs",
      "extract_project_conventions",
      "write_agent_note"
    ],
    protocolMarkdown: `# Agent Docs and Knowledge

Use this skill when the agent needs project conventions before changing behavior.

- Search docs for coding style, testing, and deployment instructions.
- Keep agent notes in artifact by default.
- Use research target only when explicitly requested.`
  },
  {
    id: "agent-integration-readonly",
    label: "Agent Integration Readonly",
    category: "integration",
    description: "Perform safe readonly external checks for APIs and API specifications.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "api_healthcheck",
      "openapi_summary"
    ],
    protocolMarkdown: `# Agent Integration Readonly

Use this skill for safe external API checks and API contract summarization.

- Run checks only on allowlisted hosts.
- Treat API summaries as input to endpoint coverage planning.`
  },
  {
    id: "high-risk",
    label: "High Risk Operations",
    category: "operations",
    description: "Destructive, process-control, mutating formatter, legacy share, and risky git/file operations.",
    enabledByDefault: false,
    status: "stable",
    riskLevel: "high",
    toolNames: [
      "delete_project",
      "create_share",
      "delete_file",
      "rename_file",
      "chmod_mode",
      "git_reset",
      "git_rebase",
      "git_bisect",
      "git_cherry_pick",
      "git_submodule",
      "git_notes",
      "git_worktree",
      "git_config",
      "git_archive",
      "git_maintenance",
      "git_prune",
      "git_repack",
      "git_update_ref",
      "git_gc",
      "git_lfs",
      "git_clean",
      "git_clone",
      "git_init",
      "git_pull",
      "git_push",
      "git_tag",
      "run_shell_command",
      "run_format_write",
      "open_local_server",
      "stop_local_server",
      "open_local_server_and_check"
    ],
    protocolMarkdown: `# High Risk Operations

Use this skill only when an admin has deliberately enabled it for the connected agent.

- Confirm destructive intent before deleting, resetting, force-updating refs, or controlling local processes.
- Prefer non-mutating diagnostics first.
- Record a clear summary of every high-risk action.`
  }
] as const;

const skillById = new Map(skillRegistry.map((skill) => [skill.id, skill]));

export function getSkillDefinition(id: string): SkillDefinition | undefined {
  return skillById.get(id);
}

export function hasSkillDefinition(id: string): boolean {
  return skillById.has(id);
}
