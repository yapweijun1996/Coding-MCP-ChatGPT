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
      "git_check_ref_format"
    ],
    protocolMarkdown: `# Core Agent Basics

Use this skill to discover the available workspace/project context before taking larger actions.

- Prefer read-only project and workspace inspection first.
- Use \`list_agent_skills\` and \`get_agent_skill\` when the agent needs to know which protocols are available.
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
      "create_html_deck",
      "create_pptx_deck",
      "create_immersive_page",
      "create_video_presentation"
    ],
    protocolMarkdown: `# Coding Delivery

Use this skill when the user asks the agent to build, edit, validate, or publish project files.

- Prefer \`deliver_static_project\` for complete static HTML/CSS/JS deliverables.
- For incremental work, create or inspect a project, write files, validate, then publish.
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
