import { publicApiRegistry, publicApiToolName } from "../mcp/tools/public-api.js";

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

const publicApiToolNames = publicApiRegistry.map((api) => publicApiToolName(api.id));

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
      "search_projects_global",
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
      "git_safe_change_plan",
      "refactor_hints",
      "report_issue",
      "list_reported_issues",
      "list_custom_mcp_tool_blueprints",
      "get_custom_mcp_tool_blueprint",
      "validate_custom_mcp_tool_spec",
      "discover_mcp_plugins",
      "register_mcp_plugin",
      "set_mcp_plugin_enabled",
      "test_mcp_plugin_capabilities",
      "mcp_plugin_version_report",
      "export_mcp_plugin_docs",
      "verify_numeric_claim",
      "search_math_counterexample",
      "solve_equation_numeric",
      "verify_derivation_steps",
      "check_tool_action_permission",
      "check_workspace_path_scope",
      "check_project_scope",
      "check_publish_permission",
      "create_risk_approval_checklist",
      "summarize_permission_scope",
      "record_audit_event",
      "list_audit_events",
      "import_project_activity_audit",
      "summarize_audit_log",
      "record_delivery_audit",
      "export_audit_log_report",
      "record_usage_event",
      "create_usage_budget",
      "summarize_usage_costs",
      "import_telemetry_usage",
      "export_usage_cost_report",
      "upsert_env_config_profile",
      "upsert_env_config_entry",
      "list_env_config_profiles",
      "validate_env_config",
      "export_env_config_report",
      "create_demo_feedback_form",
      "submit_demo_feedback",
      "list_demo_feedback",
      "link_demo_feedback_to_task",
      "export_demo_feedback_report",
      "create_demo_analytics_plan",
      "record_demo_analytics_event",
      "list_demo_analytics_events",
      "summarize_demo_analytics",
      "analyze_demo_interaction_funnel",
      "export_demo_analytics_report",
      "register_project_template",
      "list_project_templates",
      "recommend_project_templates",
      "create_project_from_template",
      "export_project_template_catalog",
      "register_workflow_template",
      "list_workflow_templates",
      "recommend_workflow_templates",
      "create_workflow_runbook_from_template",
      "export_workflow_library_report",
      "register_reusable_component",
      "list_reusable_components",
      "recommend_reusable_components",
      "create_component_reuse_plan",
      "export_component_registry_report",
      "create_model_comparison",
      "add_model_comparison_candidate",
      "score_model_comparison",
      "compare_model_tradeoffs",
      "export_model_comparison_report",
      "create_content_brief",
      "create_content_version",
      "review_content_version",
      "list_content_versions",
      "approve_content_version",
      "export_content_workflow_report",
      "create_export_package_manifest",
      "build_zip_export_package",
      "create_html_export_bundle",
      "list_export_packages",
      "export_package_report",
      "configure_notification_channel",
      "send_project_notification",
      "schedule_project_notification",
      "list_project_notifications",
      "process_due_project_notifications",
      "export_notification_report",
      "run_tool_async",
      "get_job_status",
      "list_background_jobs",
      "diagnose_code_mcp_status",
      "cancel_background_job",
      "retry_background_job",
      "recover_job_partial_result",
      "create_agent_evaluation_rubric",
      "score_agent_output",
      "evaluate_requirement_satisfaction",
      "compare_agent_output_versions",
      "detect_agent_regressions",
      "export_agent_evaluation_report",
      "record_fix_learning",
      "record_user_preference_learning",
      "search_fix_learnings",
      "import_resolved_feedback_learnings",
      "detect_recurring_fix_pattern",
      "export_fix_learning_report",
      "build_tool_output_search_index",
      "ingest_tool_output_record",
      "search_tool_outputs",
      "find_similar_tool_errors",
      "summarize_tool_output_search_sources",
      "export_tool_output_search_report",
      "register_data_connector",
      "list_data_connectors",
      "check_connector_auth_scope",
      "update_connector_status",
      "create_connector_healthcheck_plan",
      "export_connector_inventory_report",
      "create_sandbox_profile",
      "prepare_sandbox_workspace",
      "run_sandboxed_command",
      "list_sandbox_runs",
      "cleanup_sandbox",
      "export_sandbox_report",
      "create_project_backup",
      "list_project_backups",
      "verify_recovery_point",
      "restore_project_backup",
      "restore_latest_project_backup",
      "recover_deleted_project_file",
      "export_project_backup_archive"
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
      "upsert_project_task",
      "set_project_task_blocker",
      "summarize_project_task_completion",
      "get_project_task",
      "delete_project_task",
      "search_project_tasks",
      "record_project_task_evidence",
      "bind_project_task_evidence",
      "list_project_tasks",
      "rank_project_tasks",
      "get_project_task_graph",
      "get_project_task_dependency_view",
      "get_project_task_board",
      "pick_next_project_task",
      "execute_project_task_queue_step",
      "get_project_resume_state",
      "list_custom_mcp_tool_blueprints",
      "get_custom_mcp_tool_blueprint",
      "generate_custom_mcp_tool_spec",
      "validate_custom_mcp_tool_spec",
      "discover_mcp_plugins",
      "register_mcp_plugin",
      "set_mcp_plugin_enabled",
      "test_mcp_plugin_capabilities",
      "mcp_plugin_version_report",
      "export_mcp_plugin_docs",
      "load_dataset_preview",
      "profile_dataset_quality",
      "clean_dataset_preview",
      "create_dataset_chart_spec",
      "forecast_dataset_trend",
      "export_data_analysis_report",
      "create_database_schema_inventory",
      "generate_readonly_sql",
      "validate_readonly_sql",
      "create_database_sample_preview_query",
      "suggest_database_performance_hints",
      "export_database_analysis_report",
      "create_prediction_model_spec",
      "run_scenario_simulation",
      "backtest_time_series_forecast",
      "calculate_prediction_intervals",
      "evaluate_prediction_model",
      "explain_prediction_errors",
      "verify_numeric_claim",
      "search_math_counterexample",
      "solve_equation_numeric",
      "verify_derivation_steps",
      "inspect_convertible_file",
      "list_safe_archive_entries",
      "convert_table_data_format",
      "create_file_conversion_plan",
      "export_file_conversion_report",
      "create_media_conversion_manifest",
      "create_image_workflow_brief",
      "inspect_project_image_assets",
      "create_sprite_sheet_spec",
      "create_icon_manifest",
      "check_image_style_consistency",
      "create_placeholder_svg_asset",
      "generate_svg_scene",
      "layout_svg_elements",
      "fit_svg_typography",
      "inspect_svg_visual_quality",
      "apply_svg_design_tokens",
      "optimize_svg_paths",
      "generate_svg_diagram",
      "generate_svg_chart",
      "generate_isometric_svg",
      "generate_svg_icon_set",
      "animate_svg_scene",
      "add_svg_interactivity",
      "animate_and_interact_svg",
      "inspect_svg_accessibility",
      "export_svg_project",
      "process_svg_revision_feedback",
      "create_music_style_brief",
      "compose_edit_midi",
      "generate_music_variations",
      "publish_music_audition_demo",
      "extend_music_arrangement",
      "extend_original_music_arrangement",
      "assemble_original_music_session",
      "assemble_music_session",
      "normalize_music_loudness",
      "create_production_music_render_plan",
      "apply_music_mix_master_chain",
      "review_music_production_export",
      "export_music_project",
      "process_music_revision_feedback",
      "import_musicxml_score",
      "validate_music_ensemble",
      "edit_midi",
      "render_midi_to_audio",
      "check_music_render_environment",
      "render_production_music",
      "install_free_soundfont_pack",
      "discover_soundfont_packs",
      "render_midi_with_soundfont",
      "generate_jazz_harmony",
      "generate_drum_groove",
      "inspect_audio_quality",
      "build_music_license_manifest",
      "manage_jazz_instrument_packs",
      "export_music_assets",
      "audition_music_variations",
      "create_3d_game_build_brief",
      "validate_gltf_asset",
      "inspect_3d_asset",
      "generate_blocky_character",
      "compose_3d_scene",
      "validate_3d_animation_controls",
      "create_3d_scene_manifest",
      "generate_game_map_spec",
      "test_collision_rules",
      "create_game_loop_qa_plan",
      "create_camera_control_test_plan",
      "profile_game_performance_budget",
      "create_3d_visual_qa_plan",
      "critique_3d_scene_design",
      "search_3d_asset_library",
      "export_3d_showcase_package",
      "optimize_3d_asset",
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
      "create_project_mock_api",
      "start_project_mock_api",
      "stop_project_mock_api",
      "generate_mock_data_fixture",
      "scan_project_security",
      "audit_design_system_consistency",
      "audit_i18n_coverage",
      "audit_seo_social_meta",
      "classify_project_errors",
      "optimize_project_assets",
      "optimize_project_svgs",
      "generate_project_docs",
      "generate_component_library",
      "modernize_legacy_project",
      "monitor_published_demo_health",
      "test_form_persistence",
      "bind_project_workspace",
      "init_project_git",
      "list_project_files",
      "search_in_project",
      "search_projects_global",
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
      "run_project_fix_loop",
      "auto_fix_accessibility",
      "submit_review_feedback",
      "get_review_feedback",
      "resolve_review_feedback",
      "review_project_code",
      "add_project_review_comment",
      "list_project_review_comments",
      "reply_project_review_comment",
      "resolve_project_review_comment",
      "export_project_review_summary",
      "read_project_file",
      "delete_project_file",
      "validate_project",
      "audit_project_pwa",
      "generate_project_test_plan",
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
      "git_commit",
      "git_safe_change_plan",
      "repo_summary",
      "test_failure_digest",
      "changed_files_context",
      "git_safe_change_plan",
      "search_project_docs",
      "extract_project_conventions",
      "write_agent_note",
      "ingest_knowledge_document",
      "chunk_knowledge_document",
      "build_project_knowledge_index",
      "search_knowledge_base",
      "cite_knowledge_sources",
      "detect_stale_knowledge",
      "update_project_memory_note",
      "create_workflow_automation_spec",
      "validate_workflow_automation_spec",
      "simulate_workflow_execution",
      "create_workflow_schedule_plan",
      "create_workflow_recovery_plan",
      "export_workflow_automation_report",
      "create_test_automation_plan",
      "generate_test_case_spec",
      "create_test_run_matrix",
      "explain_test_results",
      "create_coverage_report",
      "export_test_automation_report",
      "check_tool_action_permission",
      "check_workspace_path_scope",
      "check_project_scope",
      "check_publish_permission",
      "create_risk_approval_checklist",
      "summarize_permission_scope",
      "record_audit_event",
      "list_audit_events",
      "import_project_activity_audit",
      "summarize_audit_log",
      "record_delivery_audit",
      "export_audit_log_report",
      "record_usage_event",
      "create_usage_budget",
      "summarize_usage_costs",
      "import_telemetry_usage",
      "export_usage_cost_report",
      "upsert_env_config_profile",
      "upsert_env_config_entry",
      "list_env_config_profiles",
      "validate_env_config",
      "export_env_config_report",
      "create_demo_feedback_form",
      "submit_demo_feedback",
      "list_demo_feedback",
      "link_demo_feedback_to_task",
      "export_demo_feedback_report",
      "create_demo_analytics_plan",
      "record_demo_analytics_event",
      "list_demo_analytics_events",
      "summarize_demo_analytics",
      "analyze_demo_interaction_funnel",
      "export_demo_analytics_report",
      "register_project_template",
      "list_project_templates",
      "recommend_project_templates",
      "create_project_from_template",
      "export_project_template_catalog",
      "register_workflow_template",
      "list_workflow_templates",
      "recommend_workflow_templates",
      "create_workflow_runbook_from_template",
      "export_workflow_library_report",
      "register_reusable_component",
      "list_reusable_components",
      "recommend_reusable_components",
      "create_component_reuse_plan",
      "export_component_registry_report",
      "create_model_comparison",
      "add_model_comparison_candidate",
      "score_model_comparison",
      "compare_model_tradeoffs",
      "export_model_comparison_report",
      "create_content_brief",
      "create_content_version",
      "review_content_version",
      "list_content_versions",
      "approve_content_version",
      "export_content_workflow_report",
      "create_export_package_manifest",
      "build_zip_export_package",
      "create_html_export_bundle",
      "list_export_packages",
      "export_package_report",
      "configure_notification_channel",
      "send_project_notification",
      "schedule_project_notification",
      "list_project_notifications",
      "process_due_project_notifications",
      "export_notification_report",
      "run_tool_async",
      "get_job_status",
      "list_background_jobs",
      "diagnose_code_mcp_status",
      "cancel_background_job",
      "retry_background_job",
      "recover_job_partial_result",
      "create_agent_evaluation_rubric",
      "score_agent_output",
      "evaluate_requirement_satisfaction",
      "compare_agent_output_versions",
      "detect_agent_regressions",
      "export_agent_evaluation_report",
      "create_release_record",
      "create_release_notes",
      "update_project_changelog",
      "compare_before_release",
      "create_rollback_point",
      "list_project_releases",
      "upsert_project_requirement",
      "list_project_requirements",
      "map_requirement_evidence",
      "create_requirements_traceability_matrix",
      "summarize_requirements_status",
      "export_requirements_report",
      "list_quality_gate_presets",
      "create_quality_gate_plan",
      "evaluate_quality_gate_results",
      "create_quality_gate_runbook",
      "compare_quality_gate_presets",
      "export_quality_gate_report",
      "record_fix_learning",
      "record_user_preference_learning",
      "search_fix_learnings",
      "import_resolved_feedback_learnings",
      "detect_recurring_fix_pattern",
      "export_fix_learning_report",
      "build_tool_output_search_index",
      "ingest_tool_output_record",
      "search_tool_outputs",
      "find_similar_tool_errors",
      "summarize_tool_output_search_sources",
      "export_tool_output_search_report",
      "scan_project_compliance_sources",
      "create_asset_attribution_manifest",
      "evaluate_license_compliance",
      "audit_privacy_data_handling",
      "create_compliance_checklist",
      "export_compliance_report",
      "register_data_connector",
      "list_data_connectors",
      "check_connector_auth_scope",
      "update_connector_status",
      "create_connector_healthcheck_plan",
      "export_connector_inventory_report",
      "create_sandbox_profile",
      "prepare_sandbox_workspace",
      "run_sandboxed_command",
      "list_sandbox_runs",
      "cleanup_sandbox",
      "export_sandbox_report",
      "create_project_backup",
      "list_project_backups",
      "verify_recovery_point",
      "restore_project_backup",
      "restore_latest_project_backup",
      "recover_deleted_project_file",
      "export_project_backup_archive",
      "api_healthcheck",
      "api_contract_test",
      "openapi_summary",
      "create_html_deck",
      "create_pptx_deck",
      "create_immersive_page",
      "create_video_presentation",
      "create_media_scene_timeline",
      "add_media_captions",
      "attach_media_voice_audio",
      "preview_media_frames",
      "export_media_project",
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
- For first-pass static pages, call \`deliver_static_project\` with \`title\`, \`entryFile\`, and a \`files\` array of \`{ path, content }\`; return the resulting \`shareUrl\` or \`publishedUrl\`.
- For landing/hero pages, prefer \`deliver_static_project\` or the fixed \`product-landing-page\` starter, then customize the copy and visual hierarchy for the user's brand before handoff.
- Final handoff publish tools default to \`shareAccess: "anyone_with_link"\` so users and sandboxed previews can load referenced assets. Use \`shareAccess: "private"\` only for internal previews.
- Treat \`projectId\` as the persistent Project identifier for follow-up calls. Tool results may also set \`jobId\` to the same value for generic job UIs, but follow-up Project tools should receive \`projectId\`.
- For incremental repairs, use \`create_project\` or inspect an existing project, then \`write_project_file\`, \`validate_project\`, and \`publish_and_report\`. Use \`publish_project\` only when validation/report evidence already passed and a browser/report handoff is not needed.
- When blocked by validation or a failed write, call \`get_project_activity\`, \`get_project_manifest\`, and \`read_project_file\` before overwriting files; use \`create_project_backup\` before broad rewrites and \`restore_latest_project_backup\` if the repair regresses.
- Use the app project workflow for React/Vue/Vite idea-to-demo requests: create, edit source, install, build, then publish dist.
- For API-driven frontend demos without real keys or backend deployment, use \`create_project_mock_api\` and \`start_project_mock_api\` to provide project-scoped CORS JSON endpoints with pagination, search, empty, error, auth-expired, and slow states; call \`stop_project_mock_api\` after verification.
- For admin, ERP, inventory, sales, or dashboard demos, use \`generate_mock_data_fixture\` to create deterministic JSON/CSV tables with schema fields, relationships, row counts, and edge cases before wiring UI state.
- Run \`scan_project_security\` before publishing projects that use package dependencies, external CDN assets, embedded third-party pages, browser storage, permissions APIs, or any user-provided source that may contain secrets.
- For admin panels or multi-page UIs, run \`audit_design_system_consistency\` to catch color, spacing, typography, radius, button variant, table density, and CSS token drift before visual handoff.
- For multilingual projects, run \`audit_i18n_coverage\` to catch missing locale keys, hardcoded UI copy, fallback gaps, terminology drift, translation overflow risk, and missing language persistence.
- Before publishing static demos, run \`audit_seo_social_meta\` to check title, description, canonical URL, favicon, Open Graph, Twitter cards, viewport, robots, theme color, and share-preview readiness.
- When validation, browser QA, build/test, or tool calls fail, run \`classify_project_errors\` to group failures by root cause, affected files/selectors, likely fixes, and the next diagnostic tool to call.
- When a tool call is blocked before MCP execution with vague safety wording, pass the exact blocked message to \`classify_project_errors\`; use its \`reasonCategory\` and \`safeRetrySuggestion\` before retrying.
- Before publishing image-heavy demos, run \`optimize_project_assets\` to detect oversized images/media, strip safe PNG metadata, minify SVGs, flag embedded data URIs, suggest WebP/AVIF/video conversions, and report before/after size impact.
- For SVG-heavy demos or icon systems, run \`optimize_project_svgs\` to validate viewBox, preserve title/desc accessibility labels, remove editor metadata/unused attributes, collapse duplicate groups, minify safely, and report size reduction.
- After project creation, refactor, validation, or publish, run \`generate_project_docs\` to create durable README and CHANGELOG files from project files, task history, validation results, published URL, features, known limitations, and next steps.
- For reusable admin/demo UI work, run \`generate_component_library\` to create shared design tokens, buttons, cards, tables, modals, sidebars, topbars, empty states, toasts, tabs, form fields, SVG icons, usage docs, and a style guide page before duplicating component markup by hand.
- For old single-file or messy static demos, run \`modernize_legacy_project\` to analyze legacy patterns, split inline CSS/JS into modular files, preserve the original entry, produce a migration report, and validate the modernized entry before continuing feature work.
- After publishing a demo, run \`monitor_published_demo_health\` to collect production-style health evidence: HTTP uptime, runtime/page errors, console errors, failed requests, broken assets, slow loads, slow requests, and recent deploy health history.
- For admin/PWA forms, drafts, filters, theme/language preferences, or local persistence, run \`test_form_persistence\` to seed/reset storage, fill fields, reload, assert form values, localStorage/sessionStorage, IndexedDB databases, and same-context page reopen behavior.
- After project generation, refactor, or publish, run \`review_project_code\` to get a structured static code review covering accessibility, performance, maintainability, security, duplication, and naming — with file/line references and severity tags. Use \`syncComments=true\` (default) to automatically write findings as project review comments, then use \`resolve_project_review_comment\` to close each finding and \`export_project_review_summary\` for the final handoff report.
- For larger human reviews, use \`add_project_review_comment\` to attach file/line, screenshot region, UI selector, issue, or project-level comments; use \`reply_project_review_comment\`, \`resolve_project_review_comment\`, and \`export_project_review_summary\` to close the review loop.
- For project task queues with competing work, call \`rank_project_tasks\` or \`list_project_tasks\` with default rank sorting to choose by dependency readiness, priority, inferred risk, dependency impact, progress, and recency.
- When a task is blocked, use \`set_project_task_blocker\` or \`upsert_project_task\` with \`blockedReason\` and \`unblockRequirement\` so resume, board, dependency, and ranking views explain why it is blocked and what must happen next.
- When a task is done, use \`summarize_project_task_completion\` or queue completion fields to persist a completion summary, changed files, validation snapshot, and evidence links.
- For incremental work, create or inspect a project, write files, validate, then publish.
- Use \`refactor_hints\` before broad cleanup to identify oversized modules, mixed responsibilities, and reviewable refactor candidates.
- Use sandbox execution tools when code, scripts, builds, data jobs, or experiments need bounded local execution with logs, artifacts, and cleanup.
- Use backup/recovery tools before risky edits, release promotion, broad refactors, or file deletion.
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
      "upsert_project_task",
      "set_project_task_blocker",
      "summarize_project_task_completion",
      "get_project_task",
      "delete_project_task",
      "search_project_tasks",
      "record_project_task_evidence",
      "bind_project_task_evidence",
      "list_project_tasks",
      "rank_project_tasks",
      "get_project_task_graph",
      "get_project_task_dependency_view",
      "get_project_task_board",
      "pick_next_project_task",
      "execute_project_task_queue_step",
      "get_project_resume_state",
      "list_custom_mcp_tool_blueprints",
      "get_custom_mcp_tool_blueprint",
      "generate_custom_mcp_tool_spec",
      "validate_custom_mcp_tool_spec",
      "discover_mcp_plugins",
      "register_mcp_plugin",
      "set_mcp_plugin_enabled",
      "test_mcp_plugin_capabilities",
      "mcp_plugin_version_report",
      "export_mcp_plugin_docs",
      "load_dataset_preview",
      "profile_dataset_quality",
      "clean_dataset_preview",
      "create_dataset_chart_spec",
      "forecast_dataset_trend",
      "export_data_analysis_report",
      "create_database_schema_inventory",
      "generate_readonly_sql",
      "validate_readonly_sql",
      "create_database_sample_preview_query",
      "suggest_database_performance_hints",
      "export_database_analysis_report",
      "create_prediction_model_spec",
      "run_scenario_simulation",
      "backtest_time_series_forecast",
      "calculate_prediction_intervals",
      "evaluate_prediction_model",
      "explain_prediction_errors",
      "verify_numeric_claim",
      "search_math_counterexample",
      "solve_equation_numeric",
      "verify_derivation_steps",
      "inspect_convertible_file",
      "list_safe_archive_entries",
      "convert_table_data_format",
      "create_file_conversion_plan",
      "export_file_conversion_report",
      "create_media_conversion_manifest",
      "create_image_workflow_brief",
      "inspect_project_image_assets",
      "create_sprite_sheet_spec",
      "create_icon_manifest",
      "check_image_style_consistency",
      "create_placeholder_svg_asset",
      "generate_svg_scene",
      "layout_svg_elements",
      "fit_svg_typography",
      "inspect_svg_visual_quality",
      "apply_svg_design_tokens",
      "optimize_svg_paths",
      "generate_svg_diagram",
      "generate_svg_chart",
      "generate_isometric_svg",
      "generate_svg_icon_set",
      "animate_svg_scene",
      "add_svg_interactivity",
      "animate_and_interact_svg",
      "inspect_svg_accessibility",
      "export_svg_project",
      "process_svg_revision_feedback",
      "create_music_style_brief",
      "compose_edit_midi",
      "generate_music_variations",
      "publish_music_audition_demo",
      "extend_music_arrangement",
      "extend_original_music_arrangement",
      "assemble_original_music_session",
      "assemble_music_session",
      "normalize_music_loudness",
      "create_production_music_render_plan",
      "apply_music_mix_master_chain",
      "review_music_production_export",
      "export_music_project",
      "process_music_revision_feedback",
      "import_musicxml_score",
      "validate_music_ensemble",
      "edit_midi",
      "render_midi_to_audio",
      "check_music_render_environment",
      "render_production_music",
      "install_free_soundfont_pack",
      "discover_soundfont_packs",
      "render_midi_with_soundfont",
      "generate_jazz_harmony",
      "generate_drum_groove",
      "inspect_audio_quality",
      "build_music_license_manifest",
      "manage_jazz_instrument_packs",
      "export_music_assets",
      "audition_music_variations",
      "create_3d_game_build_brief",
      "validate_gltf_asset",
      "inspect_3d_asset",
      "generate_blocky_character",
      "compose_3d_scene",
      "validate_3d_animation_controls",
      "create_3d_scene_manifest",
      "generate_game_map_spec",
      "test_collision_rules",
      "create_game_loop_qa_plan",
      "create_camera_control_test_plan",
      "profile_game_performance_budget",
      "create_3d_visual_qa_plan",
      "critique_3d_scene_design",
      "search_3d_asset_library",
      "export_3d_showcase_package",
      "optimize_3d_asset",
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
      "git_safe_change_plan",
      "ingest_knowledge_document",
      "chunk_knowledge_document",
      "build_project_knowledge_index",
      "search_knowledge_base",
      "cite_knowledge_sources",
      "detect_stale_knowledge",
      "update_project_memory_note",
      "create_workflow_automation_spec",
      "validate_workflow_automation_spec",
      "simulate_workflow_execution",
      "create_workflow_schedule_plan",
      "create_workflow_recovery_plan",
      "export_workflow_automation_report",
      "create_test_automation_plan",
      "generate_test_case_spec",
      "create_test_run_matrix",
      "explain_test_results",
      "create_coverage_report",
      "export_test_automation_report",
      "check_tool_action_permission",
      "check_workspace_path_scope",
      "check_project_scope",
      "check_publish_permission",
      "create_risk_approval_checklist",
      "summarize_permission_scope",
      "record_audit_event",
      "list_audit_events",
      "import_project_activity_audit",
      "summarize_audit_log",
      "record_delivery_audit",
      "export_audit_log_report",
      "record_usage_event",
      "create_usage_budget",
      "summarize_usage_costs",
      "import_telemetry_usage",
      "export_usage_cost_report",
      "upsert_env_config_profile",
      "upsert_env_config_entry",
      "list_env_config_profiles",
      "validate_env_config",
      "export_env_config_report",
      "create_demo_feedback_form",
      "submit_demo_feedback",
      "list_demo_feedback",
      "link_demo_feedback_to_task",
      "export_demo_feedback_report",
      "create_demo_analytics_plan",
      "record_demo_analytics_event",
      "list_demo_analytics_events",
      "summarize_demo_analytics",
      "analyze_demo_interaction_funnel",
      "export_demo_analytics_report",
      "register_project_template",
      "list_project_templates",
      "recommend_project_templates",
      "create_project_from_template",
      "export_project_template_catalog",
      "register_workflow_template",
      "list_workflow_templates",
      "recommend_workflow_templates",
      "create_workflow_runbook_from_template",
      "export_workflow_library_report",
      "register_reusable_component",
      "list_reusable_components",
      "recommend_reusable_components",
      "create_component_reuse_plan",
      "export_component_registry_report",
      "create_model_comparison",
      "add_model_comparison_candidate",
      "score_model_comparison",
      "compare_model_tradeoffs",
      "export_model_comparison_report",
      "create_content_brief",
      "create_content_version",
      "review_content_version",
      "list_content_versions",
      "approve_content_version",
      "export_content_workflow_report",
      "create_export_package_manifest",
      "build_zip_export_package",
      "create_html_export_bundle",
      "list_export_packages",
      "export_package_report",
      "configure_notification_channel",
      "send_project_notification",
      "schedule_project_notification",
      "list_project_notifications",
      "process_due_project_notifications",
      "export_notification_report",
      "run_tool_async",
      "get_job_status",
      "list_background_jobs",
      "diagnose_code_mcp_status",
      "cancel_background_job",
      "retry_background_job",
      "recover_job_partial_result",
      "create_agent_evaluation_rubric",
      "score_agent_output",
      "evaluate_requirement_satisfaction",
      "compare_agent_output_versions",
      "detect_agent_regressions",
      "export_agent_evaluation_report",
      "create_release_record",
      "create_release_notes",
      "update_project_changelog",
      "compare_before_release",
      "create_rollback_point",
      "list_project_releases",
      "upsert_project_requirement",
      "list_project_requirements",
      "map_requirement_evidence",
      "create_requirements_traceability_matrix",
      "summarize_requirements_status",
      "export_requirements_report",
      "list_quality_gate_presets",
      "create_quality_gate_plan",
      "evaluate_quality_gate_results",
      "create_quality_gate_runbook",
      "compare_quality_gate_presets",
      "export_quality_gate_report",
      "record_fix_learning",
      "record_user_preference_learning",
      "search_fix_learnings",
      "import_resolved_feedback_learnings",
      "detect_recurring_fix_pattern",
      "export_fix_learning_report",
      "build_tool_output_search_index",
      "ingest_tool_output_record",
      "search_tool_outputs",
      "find_similar_tool_errors",
      "summarize_tool_output_search_sources",
      "export_tool_output_search_report",
      "scan_project_compliance_sources",
      "create_asset_attribution_manifest",
      "evaluate_license_compliance",
      "audit_privacy_data_handling",
      "create_compliance_checklist",
      "export_compliance_report",
      "register_data_connector",
      "list_data_connectors",
      "check_connector_auth_scope",
      "update_connector_status",
      "create_connector_healthcheck_plan",
      "export_connector_inventory_report",
      "create_sandbox_profile",
      "prepare_sandbox_workspace",
      "run_sandboxed_command",
      "list_sandbox_runs",
      "cleanup_sandbox",
      "export_sandbox_report",
      "create_project_backup",
      "list_project_backups",
      "verify_recovery_point",
      "restore_project_backup",
      "restore_latest_project_backup",
      "recover_deleted_project_file",
      "export_project_backup_archive",
      "run_a11y_audit_detailed",
      "run_visual_regression_snapshot",
      "profile_web_performance",
      "record_interaction_flow",
      "replay_interaction_recording",
      "run_smoke_flow",
      "test_form_persistence",
      "analyze_webpage_visual",
      "inspect_3d_scene_visuals",
      "inspect_dom_at_point",
      "diagnostic_bundle",
      "diagnostic_bundle_full",
      "create_project_mock_api",
      "start_project_mock_api",
      "stop_project_mock_api",
      "generate_mock_data_fixture",
      "scan_project_security",
      "audit_design_system_consistency",
      "audit_i18n_coverage",
      "audit_seo_social_meta",
      "classify_project_errors",
      "optimize_project_assets",
      "optimize_project_svgs",
      "generate_project_docs",
      "generate_component_library",
      "modernize_legacy_project",
      "monitor_published_demo_health",
      "review_project_code",
      "add_project_review_comment",
      "list_project_review_comments",
      "reply_project_review_comment",
      "resolve_project_review_comment",
      "export_project_review_summary",
      "check_url",
      "inspect_webpage",
      "inspect_webpage_plus",
      "inspect_webpage_multibrowser",
      "audit_accessibility",
      "auto_fix_accessibility",
      "audit_lighthouse",
      "inspect_interaction_flow",
      "inspect_local_project"
    ],
    protocolMarkdown: `# Debug and Diagnostics

Use this skill to reproduce a failure, collect evidence, identify the root cause, and verify the repair.

- Start with the failing command, validation result, activity history, or browser inspection output.
- Use \`review_project_code\` for a structured static code review with severity-tagged findings across accessibility, performance, maintainability, security, duplication, and naming. It integrates \`validate_project\` results and can sync findings as project review comments for the resolve/export workflow.
- Use sandbox execution tools for bounded reproductions that need isolated input files, output limits, artifact capture, and cleanup.
- Use backup/recovery tools to compare against or restore from known-good project recovery points.
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
    id: "data-analysis",
    label: "Data Analysis",
    category: "analysis",
    description: "Load bounded datasets, inspect schema, clean data previews, detect quality issues, create chart specs, forecast trends, and export reports.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "load_dataset_preview",
      "profile_dataset_quality",
      "clean_dataset_preview",
      "create_dataset_chart_spec",
      "forecast_dataset_trend",
      "export_data_analysis_report"
    ],
    protocolMarkdown: `# Data Analysis

Use this skill for bounded local dataset analysis from project CSV/JSON files or inline rows.

- Start with \`load_dataset_preview\` or \`profile_dataset_quality\` before drawing conclusions.
- Use \`clean_dataset_preview\` to inspect deterministic cleaning effects without mutating source data.
- Use \`create_dataset_chart_spec\` for chart-ready bounded data and \`forecast_dataset_trend\` only for simple exploratory trends.
- Export a Markdown report when analysis needs durable project evidence.
- Treat all inferred types, statistics, and forecasts as exploratory until domain assumptions are checked.`
  },
  {
    id: "database-analysis",
    label: "Database Analysis",
    category: "analysis",
    description: "Create read-only database schema inventories, safe SQL query packs, sample preview queries, performance hints, and reports.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_database_schema_inventory",
      "generate_readonly_sql",
      "validate_readonly_sql",
      "create_database_sample_preview_query",
      "suggest_database_performance_hints",
      "export_database_analysis_report"
    ],
    protocolMarkdown: `# Database Analysis

Use this skill for read-only database analysis planning and reporting.

- Start with \`create_database_schema_inventory\` when schema, keys, indexes, or relationships need to be captured.
- Use \`generate_readonly_sql\` to draft bounded SELECT-only query packs from known table metadata.
- Use \`validate_readonly_sql\` before running any SQL in an external database client.
- Use \`create_database_sample_preview_query\` for bounded row previews and null profiling.
- Use \`suggest_database_performance_hints\` with query text and optional EXPLAIN output for advisory performance notes.
- Use \`export_database_analysis_report\` to preserve findings, query packs, schema summaries, and read-only caveats.
- These tools do not connect to databases or execute SQL; execute only through approved read-only database workflows.`
  },
  {
    id: "prediction-simulation",
    label: "Prediction and Simulation",
    category: "analysis",
    description: "Create prediction specs, run scenario simulations, backtest forecasts, calculate intervals, evaluate models, and explain errors.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_prediction_model_spec",
      "run_scenario_simulation",
      "backtest_time_series_forecast",
      "calculate_prediction_intervals",
      "evaluate_prediction_model",
      "explain_prediction_errors"
    ],
    protocolMarkdown: `# Prediction and Simulation

Use this skill for bounded forecasting, scenario modeling, model evaluation, backtesting, uncertainty intervals, and error diagnosis.

- Start with \`create_prediction_model_spec\` when target, horizon, features, assumptions, or metrics are not explicit.
- Use \`run_scenario_simulation\` for transparent deterministic what-if models; treat outputs as assumption-driven scenarios, not facts.
- Use \`backtest_time_series_forecast\` before trusting a forecasting method.
- Use \`calculate_prediction_intervals\` only when residuals or an error standard deviation are available.
- Use \`evaluate_prediction_model\` and \`explain_prediction_errors\` to report accuracy, bias, largest misses, and segment-level issues.
- Always state caveats for sampling, uncertainty, missing drivers, and regime changes.`
  },
  {
    id: "math-verification",
    label: "Math Verification",
    category: "analysis",
    description: "Verify numeric claims, search bounded counterexamples, solve scalar equations, and check derivation steps with reproducible evidence.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "verify_numeric_claim",
      "search_math_counterexample",
      "solve_equation_numeric",
      "verify_derivation_steps"
    ],
    protocolMarkdown: `# Math Verification

Use this skill when an answer depends on formulas, equations, numeric claims, algebra steps, or counterexample checks.

- Use \`verify_numeric_claim\` to evaluate a bounded expression with explicit variable values and tolerance.
- Use \`search_math_counterexample\` to test equations or inequalities across deterministic bounded sample grids.
- Use \`solve_equation_numeric\` for one real scalar root on a bracketed interval.
- Use \`verify_derivation_steps\` to catch invalid algebra transitions by comparing adjacent steps over sampled assignments.
- These tools are reproducible numeric/sampling checks, not full formal proof assistants. State assumptions, variable ranges, and tolerances in the final answer.`
  },
  {
    id: "mcp-plugin-registry",
    label: "MCP Plugin Registry",
    category: "development",
    description: "Discover, register, enable, disable, version-check, capability-test, and document MCP plugins and their tool surfaces.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "discover_mcp_plugins",
      "register_mcp_plugin",
      "set_mcp_plugin_enabled",
      "test_mcp_plugin_capabilities",
      "mcp_plugin_version_report",
      "export_mcp_plugin_docs"
    ],
    protocolMarkdown: `# MCP Plugin Registry

Use this skill when an agent needs to understand or manage MCP plugin capabilities.

- Use \`discover_mcp_plugins\` to inspect built-in skill-backed plugins and project-registered plugin manifests by query, category, status, version, and tools.
- Use \`register_mcp_plugin\` to save a project-local plugin manifest with version, capabilities, linked tools, linked skills, docs, and provenance.
- Use \`set_mcp_plugin_enabled\` to enable or disable project plugin records. Use \`applyToLinkedSkills=true\` only when you intentionally want to update linked built-in skill state.
- Use \`test_mcp_plugin_capabilities\` to validate metadata, linked tools, linked skills, tool schemas, and effective tool access before relying on a plugin.
- Use \`mcp_plugin_version_report\` to compare built-in and project plugin versions/status.
- Use \`export_mcp_plugin_docs\` to create Markdown documentation for available plugins, capabilities, linked tools, and status.
- These tools do not install third-party code or store secrets; they document and manage registry state around already available MCP capabilities.`
  },
  {
    id: "file-conversion",
    label: "File Conversion",
    category: "media",
    description: "Inspect convertible files, list archive contents safely, convert bounded table data, and export conversion plans/reports.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "inspect_convertible_file",
      "list_safe_archive_entries",
      "convert_table_data_format",
      "create_file_conversion_plan",
      "export_file_conversion_report",
      "create_media_conversion_manifest",
      "create_media_scene_timeline",
      "add_media_captions",
      "attach_media_voice_audio",
      "preview_media_frames",
      "export_media_project",
      "create_video_project",
      "import_video_asset_from_local_file",
      "probe_video_asset",
      "extract_video_frames",
      "create_video_scene_asset",
      "write_video_timeline",
      "preview_video_timeline",
      "render_video_timeline"
    ],
    protocolMarkdown: `# File Conversion

Use this skill for safe file inspection, conversion planning, bounded table conversion, archive review, and conversion reports.

- Start with \`inspect_convertible_file\` to identify format by magic bytes and extension before choosing a converter.
- Use \`list_safe_archive_entries\` before extracting ZIP, DOCX, XLSX, EPUB, or other ZIP-based containers.
- Use \`convert_table_data_format\` for bounded CSV/JSON table conversion to JSON, CSV, or Markdown.
- Use \`create_file_conversion_plan\` and \`export_file_conversion_report\` when a durable handoff or audit trail is needed.
- Use \`create_media_conversion_manifest\` for image/audio/video transcode requirements; actual byte transcoding requires a separate verified converter step.
- Use \`create_media_scene_timeline\`, \`add_media_captions\`, \`attach_media_voice_audio\`, \`preview_media_frames\`, and \`export_media_project\` for scripted media export handoff from project files/data; keep the workflow on Code-MCP project files, browser standards, and commercially usable open dependencies, and record license status for any optional encoder.
- Use \`create_video_project\`, \`import_video_asset_from_local_file\`, \`probe_video_asset\`, \`extract_video_frames\`, \`create_video_scene_asset\`, \`write_video_timeline\`, \`preview_video_timeline\`, and \`render_video_timeline\` when ChatGPT needs to CRUD an AI-operable video project, inspect uploaded video, create SVG/WebGL scene assets, preview an edit timeline, or render the MVP ffmpeg video-only output.
- Reject traversal paths, hidden archive paths, oversized files, and high compression-ratio entries before extraction.`
  },
  {
    id: "image-workflow",
    label: "Image Workflow",
    category: "media",
    description: "Plan image generation/editing, inspect project image assets, create sprite/icon specs, generate safe SVG placeholders, and run style QA.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "create_image_workflow_brief",
      "inspect_project_image_assets",
      "create_sprite_sheet_spec",
      "create_icon_manifest",
      "check_image_style_consistency",
      "create_placeholder_svg_asset",
      "generate_svg_scene",
      "layout_svg_elements",
      "fit_svg_typography",
      "inspect_svg_visual_quality",
      "apply_svg_design_tokens",
      "optimize_svg_paths",
      "generate_svg_diagram",
      "generate_svg_chart",
      "generate_isometric_svg",
      "generate_svg_icon_set",
      "animate_svg_scene",
      "add_svg_interactivity",
      "animate_and_interact_svg",
      "inspect_svg_accessibility",
      "export_svg_project",
      "process_svg_revision_feedback"
    ],
    protocolMarkdown: `# Image Workflow

Use this skill for project-local image generation/editing planning, sprite/icon handoff, and visual asset QA.

- Start with \`create_image_workflow_brief\` to define target assets, prompts, edits, background-removal needs, references, and constraints.
- Use \`create_placeholder_svg_asset\` when the project needs a safe temporary icon or visual placeholder before final artwork exists.
- Use \`generate_svg_scene\`, \`generate_svg_diagram\`, \`generate_svg_chart\`, \`generate_isometric_svg\`, or \`generate_svg_icon_set\` for production SVG illustrations, diagrams, charts, isometric scenes, and icon families.
- Use \`layout_svg_elements\`, \`fit_svg_typography\`, \`apply_svg_design_tokens\`, \`inspect_svg_visual_quality\`, \`inspect_svg_accessibility\`, and \`optimize_svg_paths\` before delivery to catch overlap, tiny text, missing viewBox/title/desc, style drift, and bloated SVG markup.
- Use \`animate_svg_scene\`, \`add_svg_interactivity\`, or \`animate_and_interact_svg\` for animated/interactive SVG handoff; prefer \`animate_and_interact_svg\` when CSS, WAAPI config, hotspots/tooltips, reduced-motion support, and interaction QA should be produced together.
- Use \`create_sprite_sheet_spec\` and \`create_icon_manifest\` to make implementation-ready asset specs.
- Run \`inspect_project_image_assets\` and \`check_image_style_consistency\` before publish or visual review.
- Treat generated briefs/specs as handoff artifacts; import final raster assets with the project asset tools.`
  },
  {
    id: "three-d-game",
    label: "3D and Game Building",
    category: "media",
    description: "Plan 3D/game builds, validate GLB/GLTF assets, generate scene/map specs, test collisions, QA controls, and profile performance budgets.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_3d_game_build_brief",
      "validate_gltf_asset",
      "inspect_3d_asset",
      "generate_blocky_character",
      "compose_3d_scene",
      "validate_3d_animation_controls",
      "create_3d_scene_manifest",
      "generate_game_map_spec",
      "test_collision_rules",
      "create_game_loop_qa_plan",
      "create_camera_control_test_plan",
      "profile_game_performance_budget",
      "create_3d_visual_qa_plan",
      "critique_3d_scene_design",
      "search_3d_asset_library",
      "export_3d_showcase_package",
      "optimize_3d_asset"
    ],
    protocolMarkdown: `# 3D and Game Building

Use this skill for project-local 3D assets, game scene planning, gameplay QA, and performance budgeting.

- Start with \`create_3d_game_build_brief\` when mechanics, target platform, or asset requirements are not explicit.
- Validate model files with \`validate_gltf_asset\`, then use \`inspect_3d_asset\` before scene code when geometry, texture, material, animation, scale, pivot, or mobile risk matters.
- Use \`generate_blocky_character\` for repeatable Minecraft-like, voxel, toy, mini-RPG, robot, or mascot characters before hand-coding cube geometry.
- Use \`compose_3d_scene\` to generate camera, lighting, orbit controls, environment, mobile framing, and no-interior constraints from model bounds.
- Use \`create_3d_scene_manifest\` and \`generate_game_map_spec\` to make scene and level structure reviewable.
- Use \`test_collision_rules\`, \`create_game_loop_qa_plan\`, and \`create_camera_control_test_plan\` before browser gameplay checks.
- Use \`profile_game_performance_budget\` to flag triangle, draw-call, texture, and animation risks before final visual QA.
- Use \`create_3d_visual_qa_plan\` to define front/back/side/top/mobile screenshot captures and checks for darkness, scale, clipping, facing, contrast, UI readability, shadows, camera interior clipping, and mobile framing.
- Use \`critique_3d_scene_design\` with screenshot evidence to compare against Minecraft collectible, toy figurine, product showcase, hero select, cyberpunk showroom, or Apple product intro style targets.
- Use \`search_3d_asset_library\` before importing external models, textures, HDRIs, sounds, or animations to prefer commercial-safe sources and capture attribution requirements.
- Use \`export_3d_showcase_package\` for screenshot card, poster, turntable, model report, PWA checklist, and asset manifest handoff.
- Browser/canvas verification is still required before claiming a rendered 3D/game experience works.`
  },
  {
    id: "music-workflow",
    label: "Music Workflow",
    category: "media",
    description: "Import handwritten MusicXML scores, edit MIDI, render Salamander/other SoundFont previews, generate harmony/drum grooves, QA audio, and export music assets.",
    enabledByDefault: true,
    status: "beta",
    riskLevel: "medium",
    toolNames: [
      "create_music_style_brief",
      "compose_edit_midi",
      "generate_music_variations",
      "publish_music_audition_demo",
      "extend_music_arrangement",
      "extend_original_music_arrangement",
      "assemble_original_music_session",
      "assemble_music_session",
      "normalize_music_loudness",
      "create_production_music_render_plan",
      "apply_music_mix_master_chain",
      "review_music_production_export",
      "export_music_project",
      "process_music_revision_feedback",
      "import_musicxml_score",
      "edit_midi",
      "render_midi_to_audio",
      "check_music_render_environment",
      "render_production_music",
      "install_free_soundfont_pack",
      "discover_soundfont_packs",
      "render_midi_with_soundfont",
      "generate_jazz_harmony",
      "generate_drum_groove",
      "inspect_audio_quality",
      "build_music_license_manifest",
      "manage_jazz_instrument_packs",
      "export_music_assets",
      "audition_music_variations",
      "author_handwritten_music_score",
      "validate_music_audition_distinctness",
      "validate_music_ensemble"
    ],
    protocolMarkdown: `# Music Workflow

Use this skill for score-driven MusicXML import, strict handwritten solo piano, original background music, MIDI edits, professional SoundFont/SFZ rendering, jazz harmony, grooves, and export handoff.

- Start with \`create_music_style_brief\` when the user references a venue, brand, artist, or vibe; convert it into broad non-copying musical traits.
- **Default composition path:** the AI agent must author the score itself as explicit MusicXML first, then call \`import_musicxml_score\` to convert that score into the project composition manifest + MIDI. Do not use generic MIDI composition tools for user-facing music.
- **Professional / client-ready solo piano:** write explicit RH/LH MusicXML (or use \`author_handwritten_music_score\` when note arrays are already the source of truth), run \`import_musicxml_score\`, run \`validate_music_audition_distinctness\` when producing multiple versions, install/register \`salamander_grand\` with \`install_free_soundfont_pack\`, render with \`render_midi_with_soundfont(soundfontPackId="salamander_grand")\`, then run \`inspect_audio_quality\`. If Salamander is unavailable, fail closed or report the required install steps; do not silently relabel a fallback.
- **MusicXML import path:** use \`import_musicxml_score\` for user-provided or agent-authored MusicXML; it writes a composition manifest + MIDI with \`scoreSource.scoreDriven=true\`, \`compositionPlan\`, and \`performance\` already populated so \`inspect_audio_quality\` does not reject it.
- Use \`import_musicxml_score\` when the user provides MusicXML or wants score-first generation; it writes the normal composition manifest plus standard MIDI, defaults missing tempo/instrument metadata conservatively, and records warnings in the manifest.
- Use \`validate_music_ensemble\` before publishing duet/ensemble requests to fail closed when a requested instrument is silent, only sequential, or missing meaningful overlap.
- Use \`edit_midi\` for quantize, transpose, humanize, swing, and velocity shaping.
- Use \`install_free_soundfont_pack\` for the v1 free GeneralUser GS candidate. Docker images bundle it under \`/app/soundfonts/generaluser-gs/\`, so this tool copies the runtime cache into project assets before falling back to upstream download. Then call \`manage_jazz_instrument_packs\` with retained license text, README, source URL, SHA-256, \`productionUseApproved=true\`, and \`qualityTier=production_candidate\`. GeneralUser GS is free/commercial-friendly, not MIT.
- Use \`discover_soundfont_packs\` to read-only scan project assets and optional \`.music-packs/\` for \`.sf2\`, \`.sf3\`, and \`.sfz\` candidates before registration.
- Use \`check_music_render_environment\` to detect \`sfizz_render\`, FluidSynth, FFmpeg, SoX, and available \`.sf2\`/\`.sf3\`/\`.sfz\` candidates. Use \`render_production_music\` when a complete offline handoff is needed; it renders MIDI stems with a license-cleared pack, mixes stems, encodes \`music/preview.mp3\` with FFmpeg, writes \`LICENSES.md\`, and publishes a truthful player. For long-form tracks whose WAV/stem assets exceed the project media limit, it keeps MP3 playback publishable and records omitted WAV assets instead of failing after render.
- Use \`render_midi_to_audio\` only for internal scratch previews when the user explicitly accepts preview-only audio. Never use its built-in procedural synth output as finished music, professional music, a public listening demo, or a production handoff. Use \`render_midi_with_soundfont\` for lower-level FluidSynth/SFZ + ready commercial-safe instrument pack \`production_candidate\` renders. MP3/OGG require a verified encoder step.
- For V1 piano rendering, prefer a registered \`salamander_grand\` / Salamander Grand Piano pack. DecentSampler/Decent Samples references require stored license text, README, source URL, attribution, redistribution notes, and commercial-use flags before public use.
- Use \`generate_jazz_harmony\` for section-aware original jazz progressions, piano voicings, bass guide tones, MIDI-ready voicing data, and variation notes before composing cafe/lounge tracks; use \`generate_drum_groove\` for section-aware MIDI-ready drum/brush grooves with swing, velocities, fills, background safety constraints, and variation maps.
- Run \`inspect_audio_quality\` before delivery or publishing to check clipping, loudness, dynamic range, silence gaps, harshness/bass proxies, density, repetition, loop seams, session transitions, severity-ranked findings, and background suitability fixes.
- Use \`assemble_original_music_session\` or \`assemble_music_session\` after 5-10 minute arrangements to create 30/60/90/120 minute background programs with energy profile, transition map, loudness report, source manifest, and render/export plan.
- Use \`process_music_revision_feedback\` after an audition listener picks a version or leaves timestamped comments; turn subjective feedback into MIDI edit operations, arrangement/mix changes, QA checks, revision history, and the next tool sequence.
- Use \`build_music_license_manifest\` before public demos, website/cafe/video/game use, ZIP exports, or client delivery to classify generated assets, soundfonts, samples, drum kits, ambience beds, stems, session mixes, attribution, and commercial-use safety.
- Use \`manage_jazz_instrument_packs\` before claiming realistic piano/upright bass/brush drum rendering; register SFZ/SoundFont/WAV multisample/impulse-response packs, verify hashes, source URL, license text path, README path, commercial-use permission, attribution, redistribution rules, GPL/LGPL/proprietary/non-commercial risk, and select only ready \`production_candidate\` packs. Production handoff requires commercial-safe ready SoundFont render evidence, not procedural preview audio.
- Use \`export_music_assets\` for MIDI/WAV/chord-chart/license metadata handoff.
- Do not copy melodies, lyrics, recordings, artist identity, or distinctive arrangements from copyrighted works.`
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
      "convert_design_to_static_project",
      "capture_webpage",
      "analyze_webpage_capture",
      "generate_improved_static_page"
    ],
    protocolMarkdown: `# Web Capture and Rebuild

Use this skill to inspect an existing webpage and rebuild it as a validated static project.

- Convert screenshots, wireframes, or design briefs into editable static projects when no source URL exists.
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
      "run_a11y_audit_detailed",
      "run_visual_regression_snapshot",
      "profile_web_performance",
      "record_interaction_flow",
      "replay_interaction_recording",
      "run_smoke_flow",
      "test_form_persistence",
      "monitor_published_demo_health",
      "inspect_webpage",
      "inspect_webpage_plus",
      "inspect_webpage_multibrowser",
      "inspect_network_conditions",
      "analyze_webpage_visual",
      "inspect_3d_scene_visuals",
      "inspect_dom_at_point",
      "audit_accessibility",
      "auto_fix_accessibility",
      "audit_lighthouse",
      "inspect_interaction_flow",
      "inspect_local_project",
      "check_url"
    ],
    protocolMarkdown: `# Browser QA

Use this skill to validate runtime, layout, accessibility, and interaction behavior.

- Check console errors, page errors, failed requests, and horizontal overflow.
- Use \`inspect_3d_scene_visuals\` for WebGL/Three.js pages that need canvas, lighting, framing, clipping, overlay, mobile, or multi-view visual QA.
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
      "browser_storage_snapshot",
      "profile_web_performance",
      "record_interaction_flow",
      "replay_interaction_recording",
      "test_form_persistence"
    ],
    protocolMarkdown: `# Agent Browser Observability

Use this skill when the agent needs deterministic evidence of DOM, network, console, and storage behavior.

- Prefer browser session-based observation before DOM mutation.
- Use traces for flaky request/page failures and console errors.
- Use \`profile_web_performance\` for laggy WebGL, SVG animation, chart-heavy, or large DOM pages; review FPS, long tasks, memory growth, layout shift, paint cost, script hot spots, and heavy selectors.
- Use \`record_interaction_flow\` and \`replay_interaction_recording\` to preserve clicks, inputs, scrolls, screenshots, console, and network evidence for manual UI bugs.
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
      "changed_files_context",
      "git_safe_change_plan"
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
    id: "knowledge-base",
    label: "RAG and Knowledge Base",
    category: "knowledge",
    description: "Ingest documents, chunk content, build lexical knowledge indexes, search with citations, detect stale content, and update project memory.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "ingest_knowledge_document",
      "chunk_knowledge_document",
      "build_project_knowledge_index",
      "search_knowledge_base",
      "cite_knowledge_sources",
      "detect_stale_knowledge",
      "update_project_memory_note"
    ],
    protocolMarkdown: `# RAG and Knowledge Base

Use this skill for project-local retrieval augmented generation and durable memory.

- Use \`ingest_knowledge_document\` to persist source content or wrap a project file as a knowledge document.
- Use \`chunk_knowledge_document\` for bounded chunk previews before indexing.
- Use \`build_project_knowledge_index\` to create a local lexical index with deterministic token weights.
- Use \`search_knowledge_base\` and \`cite_knowledge_sources\` to produce answer context with source citations.
- Use \`detect_stale_knowledge\` to identify documents that need review.
- Use \`update_project_memory_note\` for durable project memory that should survive handoff.
- This skill does not call an external embedding service; treat scores as lexical retrieval signals.`
  },
  {
    id: "workflow-automation",
    label: "Workflow Automation",
    category: "operations",
    description: "Build and test workflow specs with triggers, steps, retries, approvals, notifications, logs, schedules, and failure recovery.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_workflow_automation_spec",
      "validate_workflow_automation_spec",
      "simulate_workflow_execution",
      "create_workflow_schedule_plan",
      "create_workflow_recovery_plan",
      "export_workflow_automation_report"
    ],
    protocolMarkdown: `# Workflow Automation

Use this skill for project-local workflow design, validation, simulation, scheduling plans, and failure recovery plans.

- Use \`create_workflow_automation_spec\` to define triggers, steps, dependencies, retries, approvals, notifications, logs, and failure policy.
- Use \`validate_workflow_automation_spec\` before implementing or running an automation.
- Use \`simulate_workflow_execution\` to test success, failure, approval, retry, and recovery paths.
- Use \`create_workflow_schedule_plan\` for cron/timezone schedules and \`create_workflow_recovery_plan\` for operational failure modes.
- Use \`export_workflow_automation_report\` to preserve findings and handoff state.
- These tools do not execute workflows, send notifications, or create real schedules; they produce reviewable specs and test evidence.`
  },
  {
    id: "test-automation",
    label: "Test Automation",
    category: "quality",
    description: "Plan, generate, run-map, explain, and report unit, smoke, browser, API, regression, and coverage testing workflows.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_test_automation_plan",
      "generate_test_case_spec",
      "create_test_run_matrix",
      "explain_test_results",
      "create_coverage_report",
      "export_test_automation_report"
    ],
    protocolMarkdown: `# Test Automation

Use this skill to create reviewable test automation plans and interpret test evidence.

- Use \`create_test_automation_plan\` to cover unit, smoke, browser, API, regression, and coverage targets.
- Use \`generate_test_case_spec\` when a single target needs a concrete setup/steps/assertions spec.
- Use \`create_test_run_matrix\` to map suites to safe MCP tools such as \`run_tests\`, \`run_smoke_flow\`, \`run_visual_regression_snapshot\`, and \`api_contract_test\`.
- Use \`explain_test_results\` after a test command to extract likely failures and missing suites.
- Use \`create_coverage_report\` and \`export_test_automation_report\` to preserve coverage thresholds, weak files, and handoff evidence.
- These tools do not run arbitrary commands directly; they produce bounded plans and explanations around existing safe test execution tools.`
  },
  {
    id: "permission-scope",
    label: "Permission and Scope Control",
    category: "foundation",
    description: "Preflight tool access, project scope, file boundaries, write/publish permissions, and approval requirements for risky operations.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "check_tool_action_permission",
      "check_workspace_path_scope",
      "check_project_scope",
      "check_publish_permission",
      "create_risk_approval_checklist",
      "summarize_permission_scope"
    ],
    protocolMarkdown: `# Permission and Scope Control

Use this skill before actions that may be blocked by tool state, skill state, file boundaries, project status, publish readiness, or risky-operation approval.

- Use \`check_tool_action_permission\` before relying on a tool that may be disabled or high-risk.
- Use \`check_workspace_path_scope\` before reading, writing, deleting, or importing local workspace paths.
- Use \`check_project_scope\` before mutating project files or tasks.
- Use \`check_publish_permission\` before publishing; a passing validation for the selected entry file may be required.
- Use \`create_risk_approval_checklist\` for delete, publish, command execution, git mutation, admin, or boundary-risk operations.
- Use \`summarize_permission_scope\` to combine several preflight checks into one allow/block/approval-required decision.
- These tools report permission and scope decisions; they do not grant permissions or override disabled tools.`
  },
  {
    id: "audit-log",
    label: "Audit Log",
    category: "foundation",
    description: "Record, import, query, summarize, and export project-local audit logs for tool calls, file changes, publishes, failures, retries, approvals, and deliveries.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "record_audit_event",
      "list_audit_events",
      "import_project_activity_audit",
      "summarize_audit_log",
      "record_delivery_audit",
      "export_audit_log_report"
    ],
    protocolMarkdown: `# Audit Log

Use this skill when project work needs a durable history of what happened and why.

- Use \`record_audit_event\` for tool calls, file changes, publishes, failures, retries, approvals, validation, and other important events.
- Use \`import_project_activity_audit\` to seed the audit log from existing project task history.
- Use \`list_audit_events\` and \`summarize_audit_log\` to inspect handoff state, failures, approvals, publishes, and delivery records.
- Use \`record_delivery_audit\` before final handoff to capture delivered files, validation evidence, and published URLs.
- Use \`export_audit_log_report\` to produce a Markdown audit report for review.
- Audit tools write project-local records; they do not replace telemetry or grant permissions.`
  },
  {
    id: "usage-cost",
    label: "Usage and Cost Tracking",
    category: "operations",
    description: "Track estimated project usage and costs for model calls, tool calls, storage, publishes, browser QA, and long workflows.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "record_usage_event",
      "create_usage_budget",
      "summarize_usage_costs",
      "import_telemetry_usage",
      "export_usage_cost_report"
    ],
    protocolMarkdown: `# Usage and Cost Tracking

Use this skill when project work needs cost awareness, budget checks, or usage handoff.

- Use \`create_usage_budget\` to set project budget metadata and warning thresholds.
- Use \`record_usage_event\` to track model calls, tool calls, storage, publishes, browser QA runs, and long workflow costs with explicit pricing assumptions.
- Use \`import_telemetry_usage\` to convert recent MCP tool-call telemetry into project usage events with a per-call estimate.
- Use \`summarize_usage_costs\` before long workflows or final handoff to show spend by category, tool, model, and units.
- Use \`export_usage_cost_report\` to create a Markdown cost report.
- Costs are estimates from supplied pricing and telemetry; state assumptions and do not treat them as provider billing invoices.`
  },
  {
    id: "environment-config",
    label: "Environment Configuration",
    category: "operations",
    description: "Manage dev, preview, demo, and production environment config metadata, feature flags, required variables, and safe defaults without storing secrets.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "upsert_env_config_profile",
      "upsert_env_config_entry",
      "list_env_config_profiles",
      "validate_env_config",
      "export_env_config_report"
    ],
    protocolMarkdown: `# Environment Configuration

Use this skill when project work needs environment-specific config, feature flags, required variables, or publish readiness checks.

- Use \`upsert_env_config_profile\` to define dev, preview, demo, or production config policy and notes.
- Use \`upsert_env_config_entry\` for environment variables, feature flags, and config values. Mark secrets with \`secret=true\`; real secret values are not persisted.
- Use \`list_env_config_profiles\` to inspect current profiles and entries.
- Use \`validate_env_config\` before preview/demo/production handoff to find missing required values, placeholders, unsafe secret persistence, and safe-default gaps.
- Use \`export_env_config_report\` to create a Markdown handoff report.
- Keep real credentials in external secret management. These tools track config metadata, defaults, and readiness only.`
  },
  {
    id: "demo-feedback",
    label: "Demo User Feedback",
    category: "operations",
    description: "Collect published demo user feedback with forms, ratings, screenshot notes, and links back to project tasks.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "create_demo_feedback_form",
      "submit_demo_feedback",
      "list_demo_feedback",
      "link_demo_feedback_to_task",
      "export_demo_feedback_report"
    ],
    protocolMarkdown: `# Demo User Feedback

Use this skill after preview/demo/publish handoff when external or internal users need a lightweight feedback loop.

- Use \`create_demo_feedback_form\` to define the feedback form, rating scale, screenshot support, and task-linking policy.
- Use \`submit_demo_feedback\` to capture ratings, summaries, page URLs, screenshot notes, selectors, tags, and optional task links.
- Use \`list_demo_feedback\` to triage by status, sentiment, tag, or project task.
- Use \`link_demo_feedback_to_task\` to attach existing feedback to project task evidence.
- Use \`export_demo_feedback_report\` before implementation follow-up or stakeholder handoff.
- Do not store secrets or private credentials in feedback metadata.`
  },
  {
    id: "demo-analytics",
    label: "Demo Analytics",
    category: "operations",
    description: "Track and analyze published demo usage with page views, devices, clicks, errors, funnels, and drop-off points.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "create_demo_analytics_plan",
      "record_demo_analytics_event",
      "list_demo_analytics_events",
      "summarize_demo_analytics",
      "analyze_demo_interaction_funnel",
      "export_demo_analytics_report"
    ],
    protocolMarkdown: `# Demo Analytics

Use this skill after a demo is published or shared and the agent needs usage evidence beyond health monitoring.

- Use \`create_demo_analytics_plan\` to define tracked event types, goals, privacy notes, and interaction funnels.
- Use \`record_demo_analytics_event\` to ingest page views, clicks, runtime errors, funnel steps, custom events, session ids, and device types.
- Use \`list_demo_analytics_events\` when debugging raw events by session, path, event type, or device.
- Use \`summarize_demo_analytics\` to report page views, device mix, top click targets, and top errors.
- Use \`analyze_demo_interaction_funnel\` to find step-level conversion and drop-off points.
- Use \`export_demo_analytics_report\` for stakeholder handoff or the next implementation task.
- Keep analytics project-local and avoid collecting secrets, credentials, or unnecessary personal data.`
  },
  {
    id: "project-templates",
    label: "Project Template Marketplace",
    category: "development",
    description: "Discover, register, recommend, instantiate, and export reusable project templates for common app and site categories.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "register_project_template",
      "list_project_templates",
      "recommend_project_templates",
      "create_project_from_template",
      "export_project_template_catalog"
    ],
    protocolMarkdown: `# Project Template Marketplace

Use this skill before starting a common project type where a reusable starter can reduce scaffold time.

- Use \`list_project_templates\` to browse built-in and project-local templates for admin panels, PWA apps, dashboards, games, landing pages, data tools, and docs sites.
- Use \`recommend_project_templates\` with the user goal and desired features before choosing a starter.
- Use \`create_project_from_template\` to create and validate a static starter project from a selected template.
- For \`product-landing-page\`, treat the generated files as a real landing-page starter, not a template catalog; still customize brand-specific copy, proof, screenshots, CTA targets, and run browser/visual QA before sharing.
- Use \`register_project_template\` when a project has a reusable custom template worth saving in the project-local marketplace.
- Use \`export_project_template_catalog\` to hand off available template choices.
- Treat generated starter files as a baseline; customize copy, data, visuals, accessibility, and validation for the actual user request.`
  },
  {
    id: "workflow-library",
    label: "Prompt and Workflow Library",
    category: "development",
    description: "Save, discover, recommend, instantiate, and export reusable prompt/workflow templates for common agent jobs.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "register_workflow_template",
      "list_workflow_templates",
      "recommend_workflow_templates",
      "create_workflow_runbook_from_template",
      "export_workflow_library_report"
    ],
    protocolMarkdown: `# Prompt and Workflow Library

Use this skill when a common job should follow a reusable SOP or prompt pattern before execution.

- Use \`list_workflow_templates\` to browse built-in and project-local workflows for refactor, QA, publish, data report, PWA polish, and bug fix loops.
- Use \`recommend_workflow_templates\` with the job description and desired tools before choosing a workflow.
- Use \`create_workflow_runbook_from_template\` to instantiate a template into a project-local Markdown runbook with variables filled in.
- Use \`register_workflow_template\` when a stable project workflow or prompt should be saved for reuse.
- Use \`export_workflow_library_report\` to hand off available workflow choices.
- This library stores reusable instructions; execution still happens through the relevant project, QA, workflow automation, test, publish, or analysis tools.`
  },
  {
    id: "component-registry",
    label: "Reusable Component Registry",
    category: "development",
    description: "Save, search, recommend, plan reuse, and export working components, icons, layouts, game objects, charts, and interaction patterns.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "register_reusable_component",
      "list_reusable_components",
      "recommend_reusable_components",
      "create_component_reuse_plan",
      "export_component_registry_report"
    ],
    protocolMarkdown: `# Reusable Component Registry

Use this skill when a working UI/component pattern should be saved or reused across project work.

- Use \`register_reusable_component\` to save components, icons, layouts, game objects, charts, or interaction patterns with files, props, variants, dependencies, usage notes, and accessibility notes.
- Use \`list_reusable_components\` to inspect registry entries by kind, tag, maturity, or text query.
- Use \`recommend_reusable_components\` before rebuilding a component from scratch.
- Use \`create_component_reuse_plan\` to hand off selected components with source files, props, dependencies, and reuse guidance.
- Use \`export_component_registry_report\` for a Markdown registry handoff.
- Use \`generate_component_library\` when a new component library must be generated; use this registry when existing working components should be cataloged and reused.`
  },
  {
    id: "model-comparison",
    label: "Multi-Model Comparison",
    category: "analysis",
    description: "Compare model candidates for coding, analysis, writing, vision, cost, speed, and reliability using recorded outputs and metrics.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "create_model_comparison",
      "add_model_comparison_candidate",
      "score_model_comparison",
      "compare_model_tradeoffs",
      "export_model_comparison_report"
    ],
    protocolMarkdown: `# Multi-Model Comparison

Use this skill when choosing between model outputs or documenting why one model is better for a task.

- Use \`create_model_comparison\` to define the prompt, task type, and weighted criteria.
- Use \`add_model_comparison_candidate\` for each recorded model output, with quality scores, latency, cost, and reliability metrics.
- Use \`score_model_comparison\` to rank candidates with normalized cost/speed and weighted rubric scores.
- Use \`compare_model_tradeoffs\` to identify the weighted winner, fastest, cheapest, and most reliable candidate.
- Use \`export_model_comparison_report\` for a Markdown handoff.
- These tools compare supplied evidence; they do not call model provider APIs or verify claims automatically.`
  },
  {
    id: "content-workflow",
    label: "Content Generation Workflow",
    category: "development",
    description: "Manage content briefs, draft versions, reviews, approvals, and reports for articles, emails, docs, scripts, slide outlines, video scripts, and social posts.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "create_content_brief",
      "create_content_version",
      "review_content_version",
      "list_content_versions",
      "approve_content_version",
      "export_content_workflow_report"
    ],
    protocolMarkdown: `# Content Generation Workflow

Use this skill for writing deliverables that need reviewable drafts and versioning.

- Use \`create_content_brief\` to define type, audience, goal, tone, channels, constraints, and review checklist.
- Use \`create_content_version\` to store article, email, doc, script, slide outline, video script, or social post drafts as versioned artifacts.
- Use \`review_content_version\` to attach reviewer decisions, comments, and checklist results.
- Use \`approve_content_version\` only after review is complete and the draft is ready for handoff.
- Use \`list_content_versions\` to inspect draft status by brief, type, or status.
- Use \`export_content_workflow_report\` to hand off briefs, versions, reviews, and approvals.
- These tools do not send emails, publish posts, or claim factual verification; use separate review/compliance checks for high-stakes claims.`
  },
  {
    id: "export-package",
    label: "Export Package",
    category: "operations",
    description: "Create export package manifests, ZIP packages, HTML bundle indexes, package listings, and handoff reports for project deliverables.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "create_export_package_manifest",
      "build_zip_export_package",
      "create_html_export_bundle",
      "list_export_packages",
      "export_package_report"
    ],
    protocolMarkdown: `# Export Package

Use this skill when a project or report needs a share-ready handoff package.

- Use \`create_export_package_manifest\` to define requested formats such as ZIP, PDF, DOCX, PPTX, HTML bundle, screenshots, and share archive.
- Use \`build_zip_export_package\` to create a real ZIP package from project files and optional workspace files.
- Use \`create_html_export_bundle\` to create a share-ready HTML index with files, readiness, and published URL.
- Use \`list_export_packages\` to inspect the current manifest and generated package artifacts.
- Use \`export_package_report\` to produce a Markdown handoff report with completed packages and pending converter steps.
- PDF/DOCX/PPTX generation may require dedicated converter tools; this package layer records readiness and remaining steps.`
  },
  {
    id: "notifications",
    label: "Project Notifications",
    category: "operations",
    description: "Configure project notification channels, send immediate notifications, schedule reminders, process due notifications, and export notification reports.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "configure_notification_channel",
      "send_project_notification",
      "schedule_project_notification",
      "list_project_notifications",
      "process_due_project_notifications",
      "export_notification_report"
    ],
    protocolMarkdown: `# Project Notifications

Use this skill when work should notify humans or follow-up agents about completed tasks, failed jobs, review requests, blocked tasks, or important project changes.

- Use \`configure_notification_channel\` to define project-local channels such as in-app, email, webhook, Slack, SMS, or calendar without storing external secrets.
- Use \`send_project_notification\` for immediate completed-task, failed-job, review-needed, blocked-task, project-change, release, deployment, or budget notifications.
- Use \`schedule_project_notification\` to queue a future reminder or review request.
- Use \`process_due_project_notifications\` to mark due scheduled notifications as sent and return delivery packets.
- Use \`list_project_notifications\` to inspect sent, scheduled, failed, or event-specific notifications.
- Use \`export_notification_report\` for a Markdown handoff of channels, sent items, scheduled reminders, and failures.
- These tools store auditable project-local notification records; actual external delivery still requires a configured external integration.`
  },
  {
    id: "job-queue",
    label: "Job Queue and Background Status",
    category: "operations",
    description: "Run long tools asynchronously, inspect queue status, cancel jobs, retry failed/timeout jobs, and recover partial results.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "run_tool_async",
      "get_job_status",
      "list_background_jobs",
      "diagnose_code_mcp_status",
      "cancel_background_job",
      "retry_background_job",
      "recover_job_partial_result"
    ],
    protocolMarkdown: `# Job Queue and Background Status

Use this skill for long-running operations that should not block a client request.

- Use \`run_tool_async\` for eligible long-running tools and set \`timeoutMs\` when the operation needs a bounded wait.
- Use \`get_job_status\` to poll until a job is terminal: success, error, cancelled, or timeout.
- Use \`list_background_jobs\` to inspect the queue and recent history.
- Use \`diagnose_code_mcp_status\` when the user asks what is happening, why work stopped, whether work can continue, or what tool should be called next.
- Use \`cancel_background_job\` when a non-terminal job should stop contributing results.
- Use \`retry_background_job\` when a failed or timed-out job has stored source metadata and retry budget remains.
- Use \`recover_job_partial_result\` before retrying so logs, artifacts, and errors are not lost.`
  },
  {
    id: "agent-evaluation",
    label: "Agent Evaluation",
    category: "quality",
    description: "Score final output quality, compare versions, detect regressions, and measure user requirement satisfaction.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "create_agent_evaluation_rubric",
      "score_agent_output",
      "evaluate_requirement_satisfaction",
      "compare_agent_output_versions",
      "detect_agent_regressions",
      "export_agent_evaluation_report"
    ],
    protocolMarkdown: `# Agent Evaluation

Use this skill before final handoff or when comparing agent outputs.

- Use \`create_agent_evaluation_rubric\` to persist weighted criteria and required/negative signals.
- Use \`score_agent_output\` to score final output quality against the rubric.
- Use \`evaluate_requirement_satisfaction\` to check whether user requirements are satisfied with evidence.
- Use \`compare_agent_output_versions\` to compare baseline and candidate outputs.
- Use \`detect_agent_regressions\` to catch pass-to-fail or missing-check regressions.
- Use \`export_agent_evaluation_report\` to produce a Markdown handoff report.
- These tools provide deterministic evaluation scaffolding; they do not replace human review for subjective judgment.`
  },
  {
    id: "release-management",
    label: "Release Management",
    category: "operations",
    description: "Manage version tags, release notes, changelogs, rollback points, and compare-before-release checks for published projects.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_release_record",
      "create_release_notes",
      "update_project_changelog",
      "compare_before_release",
      "create_rollback_point",
      "list_project_releases"
    ],
    protocolMarkdown: `# Release Management

Use this skill when a project is ready to publish or when published output needs versioned release history.

- Use \`compare_before_release\` before publishing or promoting a version.
- Use \`create_release_record\` to store version tag, status, release checks, published URL, and rollback metadata.
- Use \`create_release_notes\` and \`update_project_changelog\` for release notes and changelog links.
- Use \`create_rollback_point\` before or immediately after release promotion.
- Use \`list_project_releases\` to inspect project release history.
- These tools create project-local release metadata; actual publishing still uses \`publish_project\` or \`publish_and_report\`.`
  },
  {
    id: "requirements-tracking",
    label: "Requirements Tracking",
    category: "quality",
    description: "Store user requirements, acceptance criteria, constraints, completed work, and evidence in a project-local traceability record.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "upsert_project_requirement",
      "list_project_requirements",
      "map_requirement_evidence",
      "create_requirements_traceability_matrix",
      "summarize_requirements_status",
      "export_requirements_report"
    ],
    protocolMarkdown: `# Requirements Tracking

Use this skill when a project needs durable requirement traceability from request to verified delivery.

- Use \`upsert_project_requirement\` to store user requirements, acceptance criteria, constraints, source, priority, and status.
- Use \`map_requirement_evidence\` to connect completed work, changed files, tests, screenshots, URLs, notes, and acceptance-criteria status back to a requirement.
- Use \`list_project_requirements\` and \`summarize_requirements_status\` to inspect outstanding or satisfied requirements.
- Use \`create_requirements_traceability_matrix\` before handoff to identify requirements missing evidence or unresolved criteria.
- Use \`export_requirements_report\` to produce a Markdown traceability report for review.
- These tools create project-local traceability records; they do not replace implementation, validation, or human approval.`
  },
  {
    id: "quality-gates",
    label: "Quality Gates",
    category: "quality",
    description: "Create, compare, evaluate, and report preset quality gates for demo, production, PWA, mobile, accessibility, data app, and game projects.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "list_quality_gate_presets",
      "create_quality_gate_plan",
      "evaluate_quality_gate_results",
      "create_quality_gate_runbook",
      "compare_quality_gate_presets",
      "export_quality_gate_report"
    ],
    protocolMarkdown: `# Quality Gates

Use this skill before demo handoff, production release, PWA/mobile/accessibility review, data app delivery, or game delivery.

- Use \`list_quality_gate_presets\` to inspect available presets and their checks.
- Use \`create_quality_gate_plan\` to generate project-local checks, recommended tools, and expected evidence for a selected preset.
- Use \`evaluate_quality_gate_results\` after validation to identify blocking checks, warnings, missing evidence, and next actions.
- Use \`create_quality_gate_runbook\` when a reviewer or agent needs a step-by-step quality gate execution guide.
- Use \`compare_quality_gate_presets\` when deciding whether a project needs demo, production, PWA, mobile, accessibility, data app, or game gates.
- Use \`export_quality_gate_report\` for handoff/release review.
- Quality gates are deterministic presets; they do not execute tests by themselves or replace human acceptance for subjective checks.`
  },
  {
    id: "fix-learning",
    label: "Fix Learning",
    category: "knowledge",
    description: "Learn from recurring bugs, user preferences, resolved feedback, and successful fix patterns across projects.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "record_fix_learning",
      "record_user_preference_learning",
      "search_fix_learnings",
      "import_resolved_feedback_learnings",
      "detect_recurring_fix_pattern",
      "export_fix_learning_report"
    ],
    protocolMarkdown: `# Fix Learning

Use this skill before debugging a similar-looking issue, after a verified fix, or when a stable user preference should influence future work.

- Use \`search_fix_learnings\` before fixing recurring symptoms to find prior successful fixes and preferences.
- Use \`detect_recurring_fix_pattern\` with a new failure or feedback item to surface similar past records and reuse recommendations.
- Use \`record_fix_learning\` after a verified fix to store bug pattern, root cause, fix, verification, and next-time detection.
- Use \`record_user_preference_learning\` only for stable preferences that should carry across future work.
- Use \`import_resolved_feedback_learnings\` to turn resolved feedback issues into searchable successful-fix records.
- Use \`export_fix_learning_report\` for review or handoff.
- Do not store secrets, credentials, customer data, or unverified guesses as learnings.`
  },
  {
    id: "tool-output-search",
    label: "Tool Output Search",
    category: "knowledge",
    description: "Search across prior tool outputs, reports, errors, screenshot metadata, issues, project notes, artifacts, and fix learnings.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      "build_tool_output_search_index",
      "ingest_tool_output_record",
      "search_tool_outputs",
      "find_similar_tool_errors",
      "summarize_tool_output_search_sources",
      "export_tool_output_search_report"
    ],
    protocolMarkdown: `# Tool Output Search

Use this skill when the agent needs to find prior evidence, reports, errors, screenshots, issues, notes, artifacts, or fix learnings before deciding the next action.

- Use \`build_tool_output_search_index\` to index project task history, project report/note files, feedback issues, and fix learnings.
- Use \`ingest_tool_output_record\` to add an explicit tool log, error, screenshot metadata, or external note to the index.
- Use \`search_tool_outputs\` for general retrieval across indexed tool outputs and project evidence.
- Use \`find_similar_tool_errors\` before debugging a failure that may have occurred before.
- Use \`summarize_tool_output_search_sources\` to audit index coverage.
- Use \`export_tool_output_search_report\` when search results need to be handed off or reviewed.
- This is local lexical semantic search with deterministic scoring; it does not call an external embedding service.`
  },
  {
    id: "compliance-review",
    label: "Compliance and License Review",
    category: "quality",
    description: "Review project licenses, third-party assets, attribution, privacy notes, data handling, and commercial-use risk.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "scan_project_compliance_sources",
      "create_asset_attribution_manifest",
      "evaluate_license_compliance",
      "audit_privacy_data_handling",
      "create_compliance_checklist",
      "export_compliance_report"
    ],
    protocolMarkdown: `# Compliance and License Review

Use this skill before publishing, commercial use, public demos with third-party assets, data apps, or handoffs requiring attribution/privacy notes.

- Use \`scan_project_compliance_sources\` to inspect project files for license, attribution, privacy, external URL, asset, and data handling signals.
- Use \`create_asset_attribution_manifest\` to record source URL, author, license, attribution text, and intended use for assets.
- Use \`evaluate_license_compliance\` to flag unknown, proprietary, non-commercial, and copyleft license risk.
- Use \`audit_privacy_data_handling\` when a project collects analytics, stores personal data, uses third-party services, or handles datasets.
- Use \`create_compliance_checklist\` for demo, production, commercial, or data app delivery.
- Use \`export_compliance_report\` for release/handoff evidence.
- These tools provide deterministic risk screening and documentation; they are not legal advice.`
  },
  {
    id: "data-connectors",
    label: "Data Connector Management",
    category: "integration",
    description: "Manage connector inventory, auth status, scope status, healthcheck plans, and reports for databases, APIs, files, calendars, email, storage, and internal apps.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "register_data_connector",
      "list_data_connectors",
      "check_connector_auth_scope",
      "update_connector_status",
      "create_connector_healthcheck_plan",
      "export_connector_inventory_report"
    ],
    protocolMarkdown: `# Data Connector Management

Use this skill before relying on databases, APIs, files, calendars, email, storage, or internal app integrations.

- Use \`register_data_connector\` to record connector type, owner, auth status, scope level, allowed operations, data classes, and required scopes. Do not store secrets.
- Use \`list_data_connectors\` to find available or blocked connectors by type/status/project.
- Use \`check_connector_auth_scope\` before using a connector for a specific operation.
- Use \`create_connector_healthcheck_plan\` to create safe readonly healthcheck steps for the connector type.
- Use \`update_connector_status\` after a healthcheck, outage, expired credential, or scope change.
- Use \`export_connector_inventory_report\` for handoff or operational review.
- These tools manage connector metadata and safety posture; they do not grant credentials or execute external reads/writes.`
  },
  {
    id: "sandbox-execution",
    label: "Sandbox Execution",
    category: "operations",
    description: "Run code, scripts, builds, data jobs, and experiments in bounded local sandboxes with limits, logs, artifacts, reports, and cleanup.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_sandbox_profile",
      "prepare_sandbox_workspace",
      "run_sandboxed_command",
      "list_sandbox_runs",
      "cleanup_sandbox",
      "export_sandbox_report"
    ],
    protocolMarkdown: `# Sandbox Execution

Use this skill when an agent needs to run code, scripts, builds, data jobs, or experiments without using arbitrary shell execution.

- Use \`create_sandbox_profile\` to define kind, allowed commands, timeout, output limit, artifact limit, and cleanup policy.
- Use \`prepare_sandbox_workspace\` to create a dedicated artifact sandbox and write bounded input files.
- Use \`run_sandboxed_command\` to execute only allowlisted \`node\`, \`python3\`, or constrained \`npm\` commands without a shell.
- Use \`list_sandbox_runs\` and \`export_sandbox_report\` for run history, logs, exit status, and artifact references.
- Use \`cleanup_sandbox\` when a sandbox no longer needs to be retained.
- Do not place secrets in sandbox input files, logs, or artifacts.`
  },
  {
    id: "backup-recovery",
    label: "Backup and Disaster Recovery",
    category: "operations",
    description: "Create project recovery points, verify backups, restore versions, recover deleted files, and export portable backup archives.",
    enabledByDefault: true,
    status: "stable",
    riskLevel: "medium",
    toolNames: [
      "create_project_backup",
      "list_project_backups",
      "verify_recovery_point",
      "restore_project_backup",
      "restore_latest_project_backup",
      "recover_deleted_project_file",
      "export_project_backup_archive"
    ],
    protocolMarkdown: `# Backup and Disaster Recovery

Use this skill before broad edits, risky refactors, release promotion, file deletion, or when recovering from a bad project state.

- Use \`create_project_backup\` to create a recovery point with copied project files, file sizes, hashes, and project metadata.
- Use \`verify_recovery_point\` before restore/export to ensure every backup file still matches its manifest hash.
- Use \`recover_deleted_project_file\` to restore one file from a verified backup without replacing the full project.
- Use \`restore_project_backup\` with \`confirm=true\` for full recovery, choosing \`overwrite_all\` or \`missing_only\`.
- Use \`restore_latest_project_backup\` as the one-click rollback path: preview the latest verified backup by default, then rerun with \`confirm=true\` to restore it.
- Use \`list_project_backups\` to find recovery points and \`export_project_backup_archive\` for portable handoff.
- Do not put secrets in project files or backup archives.`
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
      "api_contract_test",
      "openapi_summary",
      "register_data_connector",
      "list_data_connectors",
      "check_connector_auth_scope",
      "update_connector_status",
      "create_connector_healthcheck_plan",
      "export_connector_inventory_report"
    ],
    protocolMarkdown: `# Agent Integration Readonly

Use this skill for safe external API checks and API contract summarization.

- Run checks only on allowlisted hosts.
- Use contract tests for request/response shape, status, pagination, and mock-vs-real drift.
- Treat API summaries as input to endpoint coverage planning.`
  },
  {
    id: "public-api-sandbox",
    label: "Public API Sandbox",
    category: "integration",
    description: "No-key third-party public API demo tools (weather, geo, finance, media, gov data). Opt-in only: a 2026-06-20..06-30 production telemetry audit showed 0 calls across all 91 tools while enabled by default, and ChatGPT already has its own web search for discovery. Enable from Admin only for a request that specifically needs one of these fixed demo endpoints.",
    enabledByDefault: false,
    status: "stable",
    riskLevel: "low",
    toolNames: [
      ...publicApiToolNames
    ],
    protocolMarkdown: `# Public API Sandbox

Fixed-endpoint, no-key public API demo tools. Use only when a request specifically needs one
of these allowlisted third-party endpoints (e.g. weather, geocoding, government open data,
finance reference rates, museum/media catalogues).

- Prefer ChatGPT's own web search for general discovery; these tools are narrow, fixed demo
  endpoints, not a search replacement.
- Treat responses as read-only, best-effort demo data — check each API's licence/commercial
  status field before using output in a client-facing deliverable.
- This skill is disabled by default; enable it from Admin only for the specific task at hand.`
  },
  {
    id: "git-advanced",
    label: "Git Advanced",
    category: "development",
    description: "Non-destructive but rarely-needed git plumbing and history/branch tools beyond the core status/diff/commit workflow. Opt-in: a 2026-06-20..06-30 production telemetry audit showed 0 calls across all of these while default-enabled in core/coding, versus 5 calls for git_status in the same window.",
    enabledByDefault: false,
    status: "stable",
    riskLevel: "low",
    toolNames: [
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
      "git_add",
      "git_branch",
      "git_checkout",
      "git_stash",
      "git_stash_apply",
      "git_stash_pop",
      "git_merge",
      "git_fetch",
      "git_remote",
      "git_revert"
    ],
    protocolMarkdown: `# Git Advanced

Non-destructive but rarely-needed git plumbing (blame, cat-file, verify-pack, reflog, ...) and
branch/stash/merge tools beyond the always-on \`git_status\` / \`git_diff\` / \`git_commit\` workflow.

- The core workflow (\`git_status\`, \`git_diff\`, \`git_commit\`, plus \`git_push\` in \`high-risk\`)
  covers the documented "bind a repo, inspect, commit, publish" path and stays enabled by default.
- Enable this skill from Admin only when a task specifically needs branch/stash management,
  history plumbing, or a merge/fetch/revert operation.`
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
