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
      task: { id: string; status: string; progress: number; evidence: Array<{ kind?: string }> };
      validation: { ok: boolean };
      stopReason: string;
      nextTask: { id: string };
    };
    assert.equal(completed.task.id, firstId);
    assert.equal(completed.task.status, "done");
    assert.equal(completed.task.progress, 100);
    assert.equal(completed.validation.ok, true);
    assert.equal(completed.stopReason, "step_completed_next_ready");
    assert.equal(completed.nextTask.id, secondId);

    const storedFirst = (await getTask!.handler({ projectId: project.id, taskId: firstId }, ctx)).structuredContent as { task: { evidence: Array<{ kind?: string; filePath?: string }> } };
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
    assert.ok(skill!.toolNames.includes("get_project_task"));
    assert.ok(skill!.toolNames.includes("delete_project_task"));
    assert.ok(skill!.toolNames.includes("search_project_tasks"));
    assert.ok(skill!.toolNames.includes("record_project_task_evidence"));
    assert.ok(skill!.toolNames.includes("bind_project_task_evidence"));
    assert.ok(skill!.toolNames.includes("list_project_tasks"));
    assert.ok(skill!.toolNames.includes("get_project_task_graph"));
    assert.ok(skill!.toolNames.includes("get_project_task_dependency_view"));
    assert.ok(skill!.toolNames.includes("get_project_task_board"));
    assert.ok(skill!.toolNames.includes("pick_next_project_task"));
    assert.ok(skill!.toolNames.includes("execute_project_task_queue_step"));
    assert.ok(skill!.toolNames.includes("get_project_resume_state"));
  }
});
