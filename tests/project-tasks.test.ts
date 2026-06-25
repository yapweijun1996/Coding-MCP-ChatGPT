import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, getProjectActivity, getProjectManifest, publishProject, recordProjectBrowserInspection, validateProject, writeProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "project-task-test"
  };
}

test("project task tools persist status, priority, progress, notes, and evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-tasks-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Tasked project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    const recordEvidence = getToolModule("record_project_task_evidence");
    const list = getToolModule("list_project_tasks");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(recordEvidence, "record_project_task_evidence registered");
    assert.ok(list, "list_project_tasks registered");

    const created = await upsert!.handler({
      projectId: project.id,
      title: "Validate responsive layout",
      status: "doing",
      priority: "high",
      notes: "Run mobile and desktop checks.",
      progress: 35,
      evidence: [{ label: "initial plan", artifact: "tests/project-test-plan.md" }]
    }, ctx);
    assert.equal(created.ok, true);
    const taskId = (created.structuredContent as { task: { id: string } }).task.id;
    assert.equal(taskId, "task_001");

    const updated = await upsert!.handler({
      projectId: project.id,
      taskId,
      title: "Validate responsive layout",
      status: "done",
      priority: "high",
      notes: "Desktop and mobile validation passed.",
      progress: 100,
      evidence: [{ label: "browser report", url: "https://example.test/share/report.html" }]
    }, ctx);
    assert.equal(updated.ok, true);

    const evidenceResult = await recordEvidence!.handler({
      projectId: project.id,
      taskId,
      evidence: [
        { label: "visual validation", kind: "validation", artifact: "artifacts/visual-validation.json" },
        { label: "desktop screenshot", kind: "screenshot", artifact: "screenshots/desktop.png" },
        { label: "published page", kind: "published_url", url: "https://example.test/projects/tasked" },
        { label: "changed stylesheet", kind: "changed_file", filePath: "styles.css" }
      ]
    }, ctx);
    assert.equal(evidenceResult.ok, true);

    const listed = await list!.handler({ projectId: project.id, status: "done" }, ctx);
    const payload = listed.structuredContent as { tasks: Array<{ id: string; status: string; progress: number; evidence: Array<{ kind?: string; recordedAt?: string }> }>; counts: Record<string, number> };
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.tasks[0].id, taskId);
    assert.equal(payload.tasks[0].status, "done");
    assert.equal(payload.tasks[0].progress, 100);
    assert.equal(payload.tasks[0].evidence.length, 5);
    assert.equal(payload.tasks[0].evidence.some((item) => item.kind === "screenshot" && item.recordedAt), true);
    assert.equal(payload.tasks[0].evidence.some((item) => item.kind === "published_url" && item.recordedAt), true);
    assert.equal(payload.tasks[0].evidence.some((item) => item.kind === "changed_file" && item.recordedAt), true);
    assert.equal(payload.counts.done, 1);

    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.equal(manifest.taskList.length, 1);
    assert.equal(manifest.taskList[0].title, "Validate responsive layout");
    const activity = await getProjectActivity(ctx.projectRoot, project.id);
    assert.equal(activity.taskList.length, 1);
    assert.equal(activity.taskHistory.at(-1)?.toolName, "record_project_task_evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task graph reports dependencies, ready tasks, and blocked tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-graph-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Dependency project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    const graphTool = getToolModule("get_project_task_graph");
    const viewTool = getToolModule("get_project_task_dependency_view");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(graphTool, "get_project_task_graph registered");
    assert.ok(viewTool, "get_project_task_dependency_view registered");

    const first = await upsert!.handler({ projectId: project.id, title: "Design API contract", status: "todo", priority: "high" }, ctx);
    const firstId = (first.structuredContent as { task: { id: string } }).task.id;
    const second = await upsert!.handler({ projectId: project.id, title: "Build client UI", status: "todo", priority: "high", dependsOn: [firstId] }, ctx);
    const secondId = (second.structuredContent as { task: { id: string } }).task.id;

    const graphResult = await graphTool!.handler({ projectId: project.id }, ctx);
    assert.equal(graphResult.ok, true);
    const graph = graphResult.structuredContent as {
      edges: Array<{ from: string; to: string }>;
      readyTasks: Array<{ id: string }>;
      blockedTasks: Array<{ id: string; blockedBy: string[] }>;
    };
    assert.deepEqual(graph.edges, [{ from: firstId, to: secondId }]);
    assert.equal(graph.readyTasks.some((task) => task.id === firstId), true);
    assert.equal(graph.blockedTasks.some((task) => task.id === secondId && task.blockedBy.includes(firstId)), true);
    const view = (await viewTool!.handler({ projectId: project.id }, ctx)).structuredContent as {
      lanes: { ready: Array<{ id: string }>; blocked: Array<{ id: string; blockedBy: string[] }> };
      chains: Array<{ taskId: string; chain: string[] }>;
      mermaid: string;
      nextActions: string[];
    };
    assert.equal(view.lanes.ready.some((task) => task.id === firstId), true);
    assert.equal(view.lanes.blocked.some((task) => task.id === secondId && task.blockedBy.some((label) => label.includes(firstId))), true);
    assert.equal(view.chains.some((chain) => chain.taskId === secondId && chain.chain.length === 2), true);
    assert.match(view.mermaid, new RegExp(`${firstId} --> ${secondId}`));
    assert.match(view.nextActions[0], new RegExp(firstId));

    await upsert!.handler({ projectId: project.id, taskId: firstId, title: "Design API contract", status: "done", priority: "high", progress: 100 }, ctx);
    const unblocked = (await graphTool!.handler({ projectId: project.id }, ctx)).structuredContent as { readyTasks: Array<{ id: string }>; blockedTasks: Array<{ id: string }> };
    assert.equal(unblocked.readyTasks.some((task) => task.id === secondId), true);
    assert.equal(unblocked.blockedTasks.some((task) => task.id === secondId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project resume state selects the last unfinished task after interruption", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-resume-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Resume project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    const recordEvidence = getToolModule("record_project_task_evidence");
    const resumeTool = getToolModule("get_project_resume_state");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(recordEvidence, "record_project_task_evidence registered");
    assert.ok(resumeTool, "get_project_resume_state registered");

    const setup = await upsert!.handler({ projectId: project.id, title: "Set up baseline", status: "done", priority: "high", progress: 100 }, ctx);
    const setupId = (setup.structuredContent as { task: { id: string } }).task.id;
    const active = await upsert!.handler({ projectId: project.id, title: "Continue visual QA", status: "doing", priority: "medium", progress: 45, dependsOn: [setupId] }, ctx);
    const activeId = (active.structuredContent as { task: { id: string } }).task.id;
    const next = await upsert!.handler({ projectId: project.id, title: "Publish final", status: "todo", priority: "urgent", dependsOn: [activeId] }, ctx);
    const nextId = (next.structuredContent as { task: { id: string } }).task.id;

    await recordEvidence!.handler({
      projectId: project.id,
      taskId: activeId,
      evidence: [{ label: "latest inspect report", kind: "inspect_report", artifact: "artifacts/inspect.json" }]
    }, ctx);

    const resume = (await resumeTool!.handler({ projectId: project.id, historyLimit: 3 }, ctx)).structuredContent as {
      resumeTask: { id: string; evidence: unknown[] };
      reason: string;
      recentActivity: Array<{ toolName: string }>;
      unfinished: Array<{ id: string; blocked: boolean }>;
      nextActions: string[];
    };
    assert.equal(resume.resumeTask.id, activeId);
    assert.equal(resume.resumeTask.evidence.length, 1);
    assert.equal(resume.reason, "resume_in_progress");
    assert.equal(resume.recentActivity[0].toolName, "record_project_task_evidence");
    assert.equal(resume.unfinished.some((task) => task.id === nextId && task.blocked), true);
    assert.match(resume.nextActions[0], new RegExp(activeId));

    await upsert!.handler({ projectId: project.id, taskId: activeId, title: "Continue visual QA", status: "done", priority: "medium", progress: 100 }, ctx);
    const fallback = (await resumeTool!.handler({ projectId: project.id }, ctx)).structuredContent as { resumeTask: { id: string }; reason: string };
    assert.equal(fallback.resumeTask.id, nextId);
    assert.equal(fallback.reason, "start_next_ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task board returns lanes, counts, and progress percentages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-board-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Board project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    const boardTool = getToolModule("get_project_task_board");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(boardTool, "get_project_task_board registered");

    const done = await upsert!.handler({ projectId: project.id, title: "Done setup", status: "done", priority: "high", progress: 100 }, ctx);
    const doneId = (done.structuredContent as { task: { id: string } }).task.id;
    const pending = await upsert!.handler({ projectId: project.id, title: "Pending copy review", status: "todo", priority: "medium", progress: 10, dependsOn: [doneId] }, ctx);
    const pendingId = (pending.structuredContent as { task: { id: string } }).task.id;
    const doing = await upsert!.handler({ projectId: project.id, title: "Doing browser QA", status: "doing", priority: "urgent", progress: 50 }, ctx);
    const doingId = (doing.structuredContent as { task: { id: string } }).task.id;
    const blocked = await upsert!.handler({ projectId: project.id, title: "Blocked publish", status: "todo", priority: "high", dependsOn: [doingId] }, ctx);
    const blockedId = (blocked.structuredContent as { task: { id: string } }).task.id;

    const board = (await boardTool!.handler({ projectId: project.id }, ctx)).structuredContent as {
      lanes: {
        pending: Array<{ id: string }>;
        doing: Array<{ id: string }>;
        blocked: Array<{ id: string; blockedBy: string[] }>;
        done: Array<{ id: string }>;
      };
      counts: { pending: number; doing: number; blocked: number; done: number; total: number };
      progress: { completionPercent: number; averageProgress: number; byLane: Record<string, number> };
      nextActions: string[];
    };
    assert.deepEqual(board.counts, { pending: 1, doing: 1, blocked: 1, done: 1, total: 4 });
    assert.deepEqual(board.lanes.pending.map((task) => task.id), [pendingId]);
    assert.deepEqual(board.lanes.doing.map((task) => task.id), [doingId]);
    assert.deepEqual(board.lanes.done.map((task) => task.id), [doneId]);
    assert.equal(board.lanes.blocked.some((task) => task.id === blockedId && task.blockedBy.some((label) => label.includes(doingId))), true);
    assert.equal(board.progress.completionPercent, 25);
    assert.equal(board.progress.averageProgress, 40);
    assert.equal(board.progress.byLane.doing, 50);
    assert.match(board.nextActions[0], new RegExp(doingId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project next task picker selects in-progress, ready, and blocked fallback tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-picker-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Picker project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    const picker = getToolModule("pick_next_project_task");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(picker, "pick_next_project_task registered");

    const doing = await upsert!.handler({ projectId: project.id, title: "Active QA", status: "doing", priority: "medium", progress: 30 }, ctx);
    const doingId = (doing.structuredContent as { task: { id: string } }).task.id;
    const ready = await upsert!.handler({ projectId: project.id, title: "Urgent API fix", status: "todo", priority: "urgent", progress: 0 }, ctx);
    const readyId = (ready.structuredContent as { task: { id: string } }).task.id;
    const blocked = await upsert!.handler({ projectId: project.id, title: "Blocked deploy", status: "todo", priority: "high", dependsOn: [doingId] }, ctx);
    const blockedId = (blocked.structuredContent as { task: { id: string } }).task.id;

    const resumePick = (await picker!.handler({ projectId: project.id }, ctx)).structuredContent as {
      selected: { id: string };
      reason: string;
      candidates: Array<{ id: string; score: number }>;
      skipped: { blocked: Array<{ id: string }> };
      nextActions: string[];
    };
    assert.equal(resumePick.selected.id, doingId);
    assert.equal(resumePick.reason, "resume_in_progress");
    assert.equal(resumePick.skipped.blocked.some((task) => task.id === blockedId), true);
    assert.match(resumePick.nextActions[0], new RegExp(doingId));

    const readyPick = (await picker!.handler({ projectId: project.id, mode: "ready_only" }, ctx)).structuredContent as { selected: { id: string }; reason: string };
    assert.equal(readyPick.selected.id, readyId);
    assert.equal(readyPick.reason, "ready_dependency_unblocked");

    await upsert!.handler({ projectId: project.id, taskId: doingId, title: "Active QA", status: "blocked", priority: "medium", progress: 30 }, ctx);
    await upsert!.handler({ projectId: project.id, taskId: readyId, title: "Urgent API fix", status: "done", priority: "urgent", progress: 100 }, ctx);
    const blockedPick = (await picker!.handler({ projectId: project.id, mode: "blocked_if_none" }, ctx)).structuredContent as { selected: { id: string; blockedBy: string[] }; reason: string };
    assert.equal(blockedPick.selected.id, doingId);
    assert.equal(blockedPick.reason, "blocked_fallback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task ranking sorts by dependency readiness, priority, risk, and impact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-ranking-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Ranking project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    const rank = getToolModule("rank_project_tasks");
    const list = getToolModule("list_project_tasks");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(rank, "rank_project_tasks registered");
    assert.ok(list, "list_project_tasks registered");

    const lowReady = await upsert!.handler({ projectId: project.id, title: "Polish copy", status: "todo", priority: "low", notes: "Small wording cleanup." }, ctx);
    const lowReadyId = (lowReady.structuredContent as { task: { id: string } }).task.id;
    const risky = await upsert!.handler({ projectId: project.id, title: "Fix payment auth regression", status: "todo", priority: "high", notes: "Security and billing release blocker." }, ctx);
    const riskyId = (risky.structuredContent as { task: { id: string } }).task.id;
    const urgentBlocked = await upsert!.handler({ projectId: project.id, title: "Deploy production migration", status: "todo", priority: "urgent", dependsOn: [riskyId] }, ctx);
    const urgentBlockedId = (urgentBlocked.structuredContent as { task: { id: string } }).task.id;
    const doing = await upsert!.handler({ projectId: project.id, title: "Continue incident triage", status: "doing", priority: "medium", progress: 20 }, ctx);
    const doingId = (doing.structuredContent as { task: { id: string } }).task.id;

    const ranked = (await rank!.handler({ projectId: project.id }, ctx)).structuredContent as {
      ranked: Array<{ id: string; dependencyState: string; priority: string; riskScore: number; sortReasons: string[] }>;
      sorting: string[];
      nextActions: string[];
    };
    assert.deepEqual(ranked.ranked.map((task) => task.id), [doingId, riskyId, lowReadyId, urgentBlockedId]);
    assert.equal(ranked.ranked[0].dependencyState, "doing");
    assert.equal(ranked.ranked[1].priority, "high");
    assert.ok(ranked.ranked[1].riskScore > ranked.ranked[2].riskScore);
    assert.ok(ranked.ranked[1].sortReasons.some((reason) => reason.startsWith("risk=")));
    assert.ok(ranked.sorting.includes("dependency readiness"));
    assert.match(ranked.nextActions[0], new RegExp(doingId));

    const listed = (await list!.handler({ projectId: project.id }, ctx)).structuredContent as {
      tasks: Array<{ id: string }>;
      ranked: Array<{ id: string; rank: number; dependencyState: string }>;
      sortBy: string;
    };
    assert.equal(listed.sortBy, "rank");
    assert.deepEqual(listed.tasks.map((task) => task.id), [doingId, riskyId, lowReadyId, urgentBlockedId]);
    assert.deepEqual(listed.ranked.map((task) => task.rank), [1, 2, 3, 4]);
    assert.equal(listed.ranked.at(-1)?.dependencyState, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task blockers record reasons and unblock requirements across task views", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-blockers-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Blocked task project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    const setBlocker = getToolModule("set_project_task_blocker");
    const getTask = getToolModule("get_project_task");
    const graphTool = getToolModule("get_project_task_graph");
    const boardTool = getToolModule("get_project_task_board");
    const rank = getToolModule("rank_project_tasks");
    const resume = getToolModule("get_project_resume_state");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(setBlocker, "set_project_task_blocker registered");

    const created = await upsert!.handler({ projectId: project.id, title: "Wait for API credentials", status: "todo", priority: "high" }, ctx);
    const taskId = (created.structuredContent as { task: { id: string } }).task.id;
    const blocked = await setBlocker!.handler({
      projectId: project.id,
      taskId,
      blockedReason: "OAuth client secret is missing from staging.",
      unblockRequirement: "Provision staging OAuth credentials and rerun login smoke test."
    }, ctx);
    assert.equal(blocked.ok, true);
    const blockedTask = (await getTask!.handler({ projectId: project.id, taskId }, ctx)).structuredContent as { task: { status: string; blockedReason?: string; unblockRequirement?: string; blockedAt?: string } };
    assert.equal(blockedTask.task.status, "blocked");
    assert.equal(blockedTask.task.blockedReason, "OAuth client secret is missing from staging.");
    assert.equal(blockedTask.task.unblockRequirement, "Provision staging OAuth credentials and rerun login smoke test.");
    assert.ok(blockedTask.task.blockedAt);

    const graph = (await graphTool!.handler({ projectId: project.id }, ctx)).structuredContent as { blockedTasks: Array<{ id: string; blockedReasons: Array<{ type: string; reason: string; unblockRequirement: string }> }> };
    assert.equal(graph.blockedTasks.some((task) => task.id === taskId && task.blockedReasons.some((reason) => reason.type === "explicit" && reason.reason.includes("OAuth"))), true);

    const board = (await boardTool!.handler({ projectId: project.id }, ctx)).structuredContent as { lanes: { blocked: Array<{ id: string; blockedReason?: string; unblockRequirement?: string }> } };
    assert.equal(board.lanes.blocked.some((task) => task.id === taskId && task.blockedReason?.includes("OAuth")), true);

    const ranked = (await rank!.handler({ projectId: project.id }, ctx)).structuredContent as { ranked: Array<{ id: string; blockedReason?: string; unblockRequirement?: string; dependencyState: string }> };
    assert.equal(ranked.ranked.some((task) => task.id === taskId && task.dependencyState === "blocked" && task.unblockRequirement?.includes("smoke test")), true);

    const resumeState = (await resume!.handler({ projectId: project.id }, ctx)).structuredContent as { resumeTask: { id: string; blockedReason?: string }; reason: string };
    assert.equal(resumeState.resumeTask.id, taskId);
    assert.equal(resumeState.reason, "unblock_required");
    assert.equal(resumeState.resumeTask.blockedReason, "OAuth client secret is missing from staging.");

    const cleared = await setBlocker!.handler({ projectId: project.id, taskId, clear: true, statusWhenCleared: "todo" }, ctx);
    assert.equal(cleared.ok, true);
    const clearedTask = (await getTask!.handler({ projectId: project.id, taskId }, ctx)).structuredContent as { task: { status: string; blockedReason?: string; unblockRequirement?: string; blockedAt?: string } };
    assert.equal(clearedTask.task.status, "todo");
    assert.equal(clearedTask.task.blockedReason, undefined);
    assert.equal(clearedTask.task.unblockRequirement, undefined);
    assert.equal(clearedTask.task.blockedAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task completion summaries include changed files, validation, and evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-completion-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Completion project", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Done</h1></body></html>");
    await validateProject(ctx.projectRoot, project.id);

    const upsert = getToolModule("upsert_project_task");
    const summarize = getToolModule("summarize_project_task_completion");
    const getTask = getToolModule("get_project_task");
    const rank = getToolModule("rank_project_tasks");
    const dependencyView = getToolModule("get_project_task_dependency_view");
    const board = getToolModule("get_project_task_board");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(summarize, "summarize_project_task_completion registered");

    const created = await upsert!.handler({ projectId: project.id, title: "Ship static demo", status: "doing", priority: "high" }, ctx);
    const taskId = (created.structuredContent as { task: { id: string } }).task.id;
    const completed = await summarize!.handler({
      projectId: project.id,
      taskId,
      changedFiles: ["index.html", "styles.css"]
    }, ctx);
    assert.equal(completed.ok, true);
    const completion = (completed.structuredContent as {
      completion: {
        completionSummary: string;
        completedFiles: string[];
        completionValidation?: { ok: boolean; status: string; entryFile: string };
        evidenceAdded: Array<{ kind?: string; filePath?: string; label: string }>;
      };
    }).completion;
    assert.match(completion.completionSummary, /Completed Ship static demo/);
    assert.match(completion.completionSummary, /Changed files: index\.html, styles\.css/);
    assert.match(completion.completionSummary, /Validation passed/);
    assert.deepEqual(completion.completedFiles, ["index.html", "styles.css"]);
    assert.equal(completion.completionValidation?.ok, true);
    assert.equal(completion.completionValidation?.entryFile, "index.html");
    assert.equal(completion.evidenceAdded.some((item) => item.kind === "changed_file" && item.filePath === "index.html"), true);
    assert.equal(completion.evidenceAdded.some((item) => item.kind === "validation"), true);

    const stored = (await getTask!.handler({ projectId: project.id, taskId }, ctx)).structuredContent as {
      task: {
        status: string;
        progress: number;
        completionSummary?: string;
        completedFiles?: string[];
        completionValidation?: { ok: boolean; status: string };
        completedAt?: string;
        evidence: Array<{ kind?: string; filePath?: string }>;
      };
    };
    assert.equal(stored.task.status, "done");
    assert.equal(stored.task.progress, 100);
    assert.equal(stored.task.completedAt !== undefined, true);
    assert.deepEqual(stored.task.completedFiles, ["index.html", "styles.css"]);
    assert.equal(stored.task.completionValidation?.status, "valid");
    assert.equal(stored.task.evidence.some((item) => item.kind === "changed_file" && item.filePath === "styles.css"), true);

    const ranked = (await rank!.handler({ projectId: project.id, includeDone: true }, ctx)).structuredContent as { ranked: Array<{ id: string; completionSummary?: string; completedFiles: string[] }> };
    assert.equal(ranked.ranked.some((task) => task.id === taskId && task.completionSummary?.includes("Ship static demo") && task.completedFiles.includes("index.html")), true);

    const view = (await dependencyView!.handler({ projectId: project.id }, ctx)).structuredContent as { lanes: { done: Array<{ id: string; completionSummary?: string; completedFiles: string[] }> } };
    assert.equal(view.lanes.done.some((task) => task.id === taskId && task.completionSummary?.includes("Ship static demo") && task.completedFiles.includes("styles.css")), true);

    const boardPayload = (await board!.handler({ projectId: project.id }, ctx)).structuredContent as { lanes: { done: Array<{ id: string; completionValidation?: { ok: boolean } }> } };
    assert.equal(boardPayload.lanes.done.some((task) => task.id === taskId && task.completionValidation?.ok), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task evidence binding collects validation, reports, screenshots, published URLs, and changed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-evidence-bind-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Evidence binding project", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Ready</h1></body></html>");
    await validateProject(ctx.projectRoot, project.id);
    await publishProject(ctx.projectRoot, project.id, ctx.publicBaseUrl);
    await recordProjectBrowserInspection(ctx.projectRoot, project.id, {
      ok: true,
      blockingErrors: [],
      warnings: [],
      reportUrl: "https://example.test/share/browser-report.html",
      inspectedAt: "2026-06-22T14:00:00.000Z",
      screenshotUrls: ["https://example.test/artifact/desktop.png"]
    } as Parameters<typeof recordProjectBrowserInspection>[2], "screenshot_project");

    const upsert = getToolModule("upsert_project_task");
    const bindEvidence = getToolModule("bind_project_task_evidence");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(bindEvidence, "bind_project_task_evidence registered");

    const created = await upsert!.handler({ projectId: project.id, title: "Verify evidence binding", status: "doing", priority: "high" }, ctx);
    const taskId = (created.structuredContent as { task: { id: string } }).task.id;
    const bound = await bindEvidence!.handler({
      projectId: project.id,
      taskId,
      changedFiles: ["index.html", "styles.css"],
      reports: [{ label: "Manual QA report", url: "https://example.test/share/manual-qa.html" }],
      screenshots: [{ label: "Mobile screenshot", url: "https://example.test/artifact/mobile.png" }],
      artifacts: [{ label: "Validation JSON", kind: "validation", artifact: "artifacts/validation.json" }]
    }, ctx);
    assert.equal(bound.ok, true);
    const payload = bound.structuredContent as { task: { evidence: Array<{ kind?: string; url?: string; filePath?: string; artifact?: string }> }; boundEvidence: Array<{ kind?: string }> };
    assert.equal(payload.boundEvidence.some((item) => item.kind === "validation"), true);
    assert.equal(payload.task.evidence.some((item) => item.kind === "inspect_report" && item.url?.includes("browser-report")), true);
    assert.equal(payload.task.evidence.some((item) => item.kind === "screenshot" && item.url?.includes("desktop.png")), true);
    assert.equal(payload.task.evidence.some((item) => item.kind === "screenshot" && item.url?.includes("mobile.png")), true);
    assert.equal(payload.task.evidence.some((item) => item.kind === "published_url" && item.url?.includes(project.id)), true);
    assert.equal(payload.task.evidence.some((item) => item.kind === "changed_file" && item.filePath === "styles.css"), true);
    assert.equal(payload.task.evidence.some((item) => item.kind === "validation" && item.artifact === "artifacts/validation.json"), true);
    const activity = await getProjectActivity(ctx.projectRoot, project.id);
    assert.equal(activity.taskHistory.at(-1)?.toolName, "record_project_task_evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task queue step claims, completes, validates, and stops on validation failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-queue-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Queue project", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Queue</h1></body></html>");
    const upsert = getToolModule("upsert_project_task");
    const queueStep = getToolModule("execute_project_task_queue_step");
    const getTask = getToolModule("get_project_task");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(queueStep, "execute_project_task_queue_step registered");
    assert.ok(getTask, "get_project_task registered");

    const first = await upsert!.handler({ projectId: project.id, title: "Implement queue step", status: "todo", priority: "urgent" }, ctx);
    const firstId = (first.structuredContent as { task: { id: string } }).task.id;
    const second = await upsert!.handler({ projectId: project.id, title: "Document queue step", status: "todo", priority: "medium", dependsOn: [firstId] }, ctx);
    const secondId = (second.structuredContent as { task: { id: string } }).task.id;

    const claimed = (await queueStep!.handler({ projectId: project.id, action: "claim_next", changedFiles: ["src/mcp/tools/project.ts"] }, ctx)).structuredContent as {
      task: { id: string; status: string; progress: number };
      stopReason: string;
    };
    assert.equal(claimed.task.id, firstId);
    assert.equal(claimed.task.status, "doing");
    assert.equal(claimed.task.progress, 1);
    assert.equal(claimed.stopReason, "step_claimed");

    const completed = (await queueStep!.handler({
      projectId: project.id,
      taskId: firstId,
      action: "complete_task",
      validation: "static_project",
      completionNote: "Static validation passed.",
      changedFiles: ["index.html"]
    }, ctx)).structuredContent as {
      task: { id: string; status: string; progress: number; completionSummary?: string; completedFiles?: string[]; completionValidation?: { ok: boolean; status: string }; evidence: Array<{ kind?: string }> };
      validation: { ok: boolean; status: string };
      stopReason: string;
      nextTask: { id: string };
    };
    assert.equal(completed.task.id, firstId);
    assert.equal(completed.task.status, "done");
    assert.equal(completed.task.progress, 100);
    assert.equal(completed.validation.ok, true);
    assert.match(completed.task.completionSummary ?? "", /Static validation passed/);
    assert.match(completed.task.completionSummary ?? "", /Changed files: index\.html/);
    assert.match(completed.task.completionSummary ?? "", /Validation passed/);
    assert.deepEqual(completed.task.completedFiles, ["index.html"]);
    assert.equal(completed.task.completionValidation?.ok, true);
    assert.equal(completed.task.completionValidation?.status, "valid");
    assert.equal(completed.stopReason, "step_completed_next_ready");
    assert.equal(completed.nextTask.id, secondId);

    const storedFirst = (await getTask!.handler({ projectId: project.id, taskId: firstId }, ctx)).structuredContent as { task: { completionSummary?: string; completedFiles?: string[]; completionValidation?: { ok: boolean }; evidence: Array<{ kind?: string; filePath?: string }> } };
    assert.match(storedFirst.task.completionSummary ?? "", /Changed files: index\.html/);
    assert.deepEqual(storedFirst.task.completedFiles, ["index.html"]);
    assert.equal(storedFirst.task.completionValidation?.ok, true);
    assert.equal(storedFirst.task.evidence.some((item) => item.kind === "validation"), true);
    assert.equal(storedFirst.task.evidence.some((item) => item.kind === "changed_file" && item.filePath === "index.html"), true);

    const invalidProject = await createProject(ctx.projectRoot, { title: "Invalid queue project", createdByClientId: "coder", entryFile: "missing.html" });
    const invalidTask = await upsert!.handler({ projectId: invalidProject.id, title: "Validate missing entry", status: "doing", priority: "high" }, ctx);
    const invalidTaskId = (invalidTask.structuredContent as { task: { id: string } }).task.id;
    const failed = await queueStep!.handler({ projectId: invalidProject.id, taskId: invalidTaskId, action: "complete_task", validation: "static_project" }, ctx);
    assert.equal(failed.ok, false);
    const failedPayload = failed.structuredContent as { task: { id: string; status: string }; stopReason: string; validation: { ok: boolean } };
    assert.equal(failedPayload.task.id, invalidTaskId);
    assert.equal(failedPayload.task.status, "blocked");
    assert.equal(failedPayload.stopReason, "validation_failed");
    assert.equal(failedPayload.validation.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task CRUD tools read, search, and delete tasks safely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-crud-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "CRUD project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    const getTask = getToolModule("get_project_task");
    const searchTasks = getToolModule("search_project_tasks");
    const deleteTask = getToolModule("delete_project_task");
    const list = getToolModule("list_project_tasks");
    assert.ok(upsert, "upsert_project_task registered");
    assert.ok(getTask, "get_project_task registered");
    assert.ok(searchTasks, "search_project_tasks registered");
    assert.ok(deleteTask, "delete_project_task registered");
    assert.ok(list, "list_project_tasks registered");

    const api = await upsert!.handler({
      projectId: project.id,
      title: "Design payment API",
      status: "todo",
      priority: "urgent",
      notes: "Contract tests and auth cases.",
      evidence: [{ label: "contract draft", kind: "artifact", artifact: "docs/api-contract.md" }]
    }, ctx);
    const apiId = (api.structuredContent as { task: { id: string } }).task.id;
    const ui = await upsert!.handler({
      projectId: project.id,
      title: "Build checkout UI",
      status: "todo",
      priority: "high",
      dependsOn: [apiId]
    }, ctx);
    const uiId = (ui.structuredContent as { task: { id: string } }).task.id;

    const read = (await getTask!.handler({ projectId: project.id, taskId: apiId }, ctx)).structuredContent as { task: { id: string; title: string; priority: string } };
    assert.equal(read.task.id, apiId);
    assert.equal(read.task.title, "Design payment API");
    assert.equal(read.task.priority, "urgent");

    const search = (await searchTasks!.handler({ projectId: project.id, query: "contract auth", priority: "urgent" }, ctx)).structuredContent as { tasks: Array<{ id: string }> };
    assert.deepEqual(search.tasks.map((task) => task.id), [apiId]);

    await assert.rejects(deleteTask!.handler({ projectId: project.id, taskId: apiId }, ctx), /dependent task/);
    const deletedUi = (await deleteTask!.handler({ projectId: project.id, taskId: uiId }, ctx)).structuredContent as { deletedTask: { id: string } };
    assert.equal(deletedUi.deletedTask.id, uiId);
    const deletedApi = (await deleteTask!.handler({ projectId: project.id, taskId: apiId }, ctx)).structuredContent as { deletedTask: { id: string } };
    assert.equal(deletedApi.deletedTask.id, apiId);

    const listed = (await list!.handler({ projectId: project.id }, ctx)).structuredContent as { tasks: unknown[]; total: number };
    assert.equal(listed.total, 0);
    assert.equal(listed.tasks.length, 0);
    const activity = await getProjectActivity(ctx.projectRoot, project.id);
    assert.equal(activity.taskHistory.at(-1)?.toolName, "delete_project_task");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project task graph rejects unknown dependencies and cycles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-task-graph-invalid-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Invalid graph project", createdByClientId: "coder" });
    const upsert = getToolModule("upsert_project_task");
    assert.ok(upsert, "upsert_project_task registered");
    await assert.rejects(upsert!.handler({ projectId: project.id, title: "Bad dependency", dependsOn: ["task_999"] }, ctx), /unknown task/);

    const first = await upsert!.handler({ projectId: project.id, title: "First" }, ctx);
    const firstId = (first.structuredContent as { task: { id: string } }).task.id;
    const second = await upsert!.handler({ projectId: project.id, title: "Second", dependsOn: [firstId] }, ctx);
    const secondId = (second.structuredContent as { task: { id: string } }).task.id;
    await assert.rejects(upsert!.handler({ projectId: project.id, taskId: firstId, title: "First", dependsOn: [secondId] }, ctx), /cycle/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding and debug skills expose project task list tools", () => {
  for (const id of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === id);
    assert.ok(skill, `${id} skill registered`);
    assert.ok(skill!.toolNames.includes("upsert_project_task"));
    assert.ok(skill!.toolNames.includes("set_project_task_blocker"));
    assert.ok(skill!.toolNames.includes("summarize_project_task_completion"));
    assert.ok(skill!.toolNames.includes("get_project_task"));
    assert.ok(skill!.toolNames.includes("delete_project_task"));
    assert.ok(skill!.toolNames.includes("search_project_tasks"));
    assert.ok(skill!.toolNames.includes("record_project_task_evidence"));
    assert.ok(skill!.toolNames.includes("bind_project_task_evidence"));
    assert.ok(skill!.toolNames.includes("list_project_tasks"));
    assert.ok(skill!.toolNames.includes("rank_project_tasks"));
    assert.ok(skill!.toolNames.includes("get_project_task_graph"));
    assert.ok(skill!.toolNames.includes("get_project_task_dependency_view"));
    assert.ok(skill!.toolNames.includes("get_project_task_board"));
    assert.ok(skill!.toolNames.includes("pick_next_project_task"));
    assert.ok(skill!.toolNames.includes("execute_project_task_queue_step"));
    assert.ok(skill!.toolNames.includes("get_project_resume_state"));
  }
});
