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
      "list_custom_mcp_tool_blueprints",
      "get_custom_mcp_tool_blueprint",
      "validate_custom_mcp_tool_spec",
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
      "run_tool_async",
      "get_job_status",
      "list_background_jobs",
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
      "get_project_task",
      "delete_project_task",
      "search_project_tasks",
      "record_project_task_evidence",
      "bind_project_task_evidence",
      "list_project_tasks",
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
      "create_music_style_brief",
      "compose_edit_midi",
      "generate_music_variations",
      "publish_music_audition_demo",
      "extend_music_arrangement",
      "extend_original_music_arrangement",
      "assemble_music_session",
      "normalize_music_loudness",
      "export_music_project",
      "compose_music",
      "edit_midi",
      "render_midi_to_audio",
      "generate_jazz_harmony",
      "generate_drum_groove",
      "inspect_audio_quality",
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
      "submit_review_feedback",
      "get_review_feedback",
      "resolve_review_feedback",
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
      "run_tool_async",
      "get_job_status",
      "list_background_jobs",
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
      "recover_deleted_project_file",
      "export_project_backup_archive",
      "api_healthcheck",
      "api_contract_test",
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
      "get_project_task",
      "delete_project_task",
      "search_project_tasks",
      "record_project_task_evidence",
      "bind_project_task_evidence",
      "list_project_tasks",
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
      "create_music_style_brief",
      "compose_edit_midi",
      "generate_music_variations",
      "publish_music_audition_demo",
      "extend_music_arrangement",
      "extend_original_music_arrangement",
      "assemble_music_session",
      "normalize_music_loudness",
      "export_music_project",
      "compose_music",
      "edit_midi",
      "render_midi_to_audio",
      "generate_jazz_harmony",
      "generate_drum_groove",
      "inspect_audio_quality",
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
      "run_tool_async",
      "get_job_status",
      "list_background_jobs",
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
      "recover_deleted_project_file",
      "export_project_backup_archive",
      "browser_dom_snapshot",
      "browser_network_trace",
      "browser_console_log",
      "browser_storage_snapshot",
      "run_a11y_audit_detailed",
      "run_visual_regression_snapshot",
      "run_smoke_flow",
      "analyze_webpage_visual",
      "inspect_3d_scene_visuals",
      "inspect_dom_at_point",
      "diagnostic_bundle",
      "diagnostic_bundle_full",
      "check_url",
      "inspect_webpage",
      "inspect_webpage_plus",
      "inspect_webpage_multibrowser",
      "audit_accessibility",
      "audit_lighthouse",
      "inspect_interaction_flow",
      "inspect_local_project"
    ],
    protocolMarkdown: `# Debug and Diagnostics

Use this skill to reproduce a failure, collect evidence, identify the root cause, and verify the repair.

- Start with the failing command, validation result, activity history, or browser inspection output.
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
      "create_media_conversion_manifest"
    ],
    protocolMarkdown: `# File Conversion

Use this skill for safe file inspection, conversion planning, bounded table conversion, archive review, and conversion reports.

- Start with \`inspect_convertible_file\` to identify format by magic bytes and extension before choosing a converter.
- Use \`list_safe_archive_entries\` before extracting ZIP, DOCX, XLSX, EPUB, or other ZIP-based containers.
- Use \`convert_table_data_format\` for bounded CSV/JSON table conversion to JSON, CSV, or Markdown.
- Use \`create_file_conversion_plan\` and \`export_file_conversion_report\` when a durable handoff or audit trail is needed.
- Use \`create_media_conversion_manifest\` for image/audio/video transcode requirements; actual byte transcoding requires a separate verified converter step.
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
      "create_placeholder_svg_asset"
    ],
    protocolMarkdown: `# Image Workflow

Use this skill for project-local image generation/editing planning, sprite/icon handoff, and visual asset QA.

- Start with \`create_image_workflow_brief\` to define target assets, prompts, edits, background-removal needs, references, and constraints.
- Use \`create_placeholder_svg_asset\` when the project needs a safe temporary icon or visual placeholder before final artwork exists.
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
- Browser/canvas verification is still required before claiming a rendered 3D/game experience works.`
  },
  {
    id: "music-workflow",
    label: "Music Workflow",
    category: "media",
    description: "Compose original music, edit MIDI, render WAV previews, generate harmony/drum grooves, QA audio, and export music assets.",
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
      "assemble_music_session",
      "normalize_music_loudness",
      "export_music_project",
      "compose_music",
      "edit_midi",
      "render_midi_to_audio",
      "generate_jazz_harmony",
      "generate_drum_groove",
      "inspect_audio_quality",
      "export_music_assets",
      "audition_music_variations"
    ],
    protocolMarkdown: `# Music Workflow

Use this skill for original background music, MIDI sketches, WAV previews, jazz harmony, grooves, and export handoff.

- Start with \`create_music_style_brief\` when the user references a venue, brand, artist, or vibe; convert it into broad non-copying musical traits.
- Use \`compose_music\` to generate the structured composition manifest and MIDI.
- Use \`edit_midi\` for quantize, transpose, humanize, swing, and velocity shaping.
- Use \`render_midi_to_audio\` for a project WAV preview from the built-in safe synth; MP3/OGG require a verified encoder step.
- Use \`generate_jazz_harmony\` and \`generate_drum_groove\` for readable chord charts, voicings, walking bass, and drum/brush patterns.
- Run \`inspect_audio_quality\` before delivery to check clipping, density, repetition, loop seams, and background suitability.
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
      "browser_dom_snapshot",
      "browser_network_trace",
      "browser_console_log",
      "browser_storage_snapshot",
      "run_a11y_audit_detailed",
      "run_visual_regression_snapshot",
      "run_smoke_flow",
      "inspect_webpage",
      "inspect_webpage_plus",
      "inspect_webpage_multibrowser",
      "inspect_network_conditions",
      "analyze_webpage_visual",
      "inspect_3d_scene_visuals",
      "inspect_dom_at_point",
      "audit_accessibility",
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
      "cancel_background_job",
      "retry_background_job",
      "recover_job_partial_result"
    ],
    protocolMarkdown: `# Job Queue and Background Status

Use this skill for long-running operations that should not block a client request.

- Use \`run_tool_async\` for eligible long-running tools and set \`timeoutMs\` when the operation needs a bounded wait.
- Use \`get_job_status\` to poll until a job is terminal: success, error, cancelled, or timeout.
- Use \`list_background_jobs\` to inspect the queue and recent history.
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
      "recover_deleted_project_file",
      "export_project_backup_archive"
    ],
    protocolMarkdown: `# Backup and Disaster Recovery

Use this skill before broad edits, risky refactors, release promotion, file deletion, or when recovering from a bad project state.

- Use \`create_project_backup\` to create a recovery point with copied project files, file sizes, hashes, and project metadata.
- Use \`verify_recovery_point\` before restore/export to ensure every backup file still matches its manifest hash.
- Use \`recover_deleted_project_file\` to restore one file from a verified backup without replacing the full project.
- Use \`restore_project_backup\` with \`confirm=true\` for full recovery, choosing \`overwrite_all\` or \`missing_only\`.
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
