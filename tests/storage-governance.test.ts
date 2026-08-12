import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  getStorageReport,
  measureDirectory,
  resolveStoragePolicy,
  StorageQuotaExceededError,
  withStorageQuota,
  type StoragePolicy
} from "../src/storage/manager.js";
import { createArtifact } from "../src/artifacts/store.js";
import { createShareArtifact, initializeShareStore } from "../src/share/store.js";
import {
  bindProjectWorkspace,
  createProject,
  deleteProject,
  listProjects,
  purgeProject,
  writeProjectFile
} from "../src/projects/store.js";
import { startStorageMonitor } from "../src/storage/monitor.js";

const testPolicy: StoragePolicy = {
  projectQuotaBytes: 0,
  userQuotaBytes: 0,
  globalQuotaBytes: 100000,
  warningThreshold: 0.8,
  deletedProjectRetentionDays: 7,
  monitorIntervalMs: 0
};

test("storage policy parses human-readable limits and durations", () => {
  const policy = resolveStoragePolicy({
    PROJECT_STORAGE_QUOTA: "2MiB",
    USER_STORAGE_QUOTA: "3 GB",
    GLOBAL_STORAGE_QUOTA: "4k",
    STORAGE_WARN_AT_PERCENT: "75",
    DELETED_PROJECT_RETENTION_DAYS: "2",
    STORAGE_MONITOR_INTERVAL_MS: "30m"
  });
  assert.equal(policy.projectQuotaBytes, 2 * 1024 * 1024);
  assert.equal(policy.userQuotaBytes, 3 * 1024 * 1024 * 1024);
  assert.equal(policy.globalQuotaBytes, 4 * 1024);
  assert.equal(policy.warningThreshold, 0.75);
  assert.equal(policy.deletedProjectRetentionDays, 2);
  assert.equal(policy.monitorIntervalMs, 30 * 60 * 1000);
});

test("storage quota rejects a write before the action runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "storage-quota-"));
  try {
    await writeFile(path.join(root, "existing.txt"), "12345678");
    let actionRan = false;
    await assert.rejects(
      withStorageQuota({
        projectRoot: root,
        projectDirectory: root,
        additionalBytes: 3,
        policy: { ...testPolicy, projectQuotaBytes: 10 }
      }, async () => {
        actionRan = true;
      }),
      (error: unknown) => error instanceof StorageQuotaExceededError && error.scope === "project"
    );
    assert.equal(actionRan, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global hard quota rejects a write across configured roots", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "storage-global-quota-"));
  const first = path.join(base, "first");
  const second = path.join(base, "second");
  try {
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(path.join(first, "existing.txt"), "12345678");
    let actionRan = false;
    await assert.rejects(
      withStorageQuota({
        projectRoot: first,
        additionalBytes: 3,
        globalRoots: [first, second],
        policy: { ...testPolicy, projectQuotaBytes: 0, userQuotaBytes: 0, globalQuotaBytes: 10 }
      }, async () => {
        actionRan = true;
      }),
      (error: unknown) => error instanceof StorageQuotaExceededError && error.scope === "global"
    );
    assert.equal(actionRan, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("storage report includes project, workspace, artifact, share, and telemetry bytes", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "storage-report-"));
  const root = path.join(base, "projects");
  const workspaceRoot = path.join(base, "workspace");
  const artifactRoot = path.join(base, "artifacts");
  const shareRoot = path.join(base, "shares");
  const telemetryRoot = path.join(base, "telemetry");
  try {
    await mkdir(root, { recursive: true });
    const project = await createProject(root, { title: "Storage report", createdByClientId: "test" });
    await writeProjectFile(root, project.id, "index.html", "<h1>storage</h1>");
    await mkdir(path.join(workspaceRoot, project.id), { recursive: true });
    await writeFile(path.join(workspaceRoot, project.id, "node_modules.marker"), "workspace");
    await mkdir(artifactRoot, { recursive: true });
    await mkdir(shareRoot, { recursive: true });
    await mkdir(telemetryRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "artifact.bin"), "artifact");
    await writeFile(path.join(shareRoot, "share.html"), "share");
    await writeFile(path.join(telemetryRoot, "events.jsonl"), "telemetry");

    const report = await getStorageReport([{
      id: "user:test",
      label: "Test user",
      projectRoot: root,
      workspaceRoot,
      projects: [{ id: project.id, title: project.title, status: project.status, workspacePath: path.join(workspaceRoot, project.id) }]
    }], { ...testPolicy, userQuotaBytes: 1, globalQuotaBytes: 1 }, { artifactRoot, shareRoot, telemetryRoot });

    assert.ok(report.totals.projectBytes > 0);
    assert.ok(report.totals.workspaceBytes > 0);
    assert.equal(report.totals.artifactBytes, Buffer.byteLength("artifact"));
    assert.equal(report.totals.shareBytes, Buffer.byteLength("share"));
    assert.equal(report.totals.telemetryBytes, Buffer.byteLength("telemetry"));
    assert.equal(report.globalQuota.state, "over_quota");
    assert.ok(report.warnings.length >= 1);
    assert.equal(JSON.stringify(report).includes(workspaceRoot), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("purgeProject removes project storage, bound workspace, and matching backups", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "storage-purge-"));
  const root = path.join(base, "projects");
  const workspaceRoot = path.join(base, "workspace-root");
  const artifactRoot = path.join(base, "artifacts");
  const shareRoot = path.join(base, "shares");
  try {
    await mkdir(root, { recursive: true });
    const project = await createProject(root, { title: "Purge me", createdByClientId: "test" });
    await writeProjectFile(root, project.id, "index.html", "<h1>remove</h1>");
    const boundWorkspace = path.join(workspaceRoot, project.id);
    await mkdir(boundWorkspace, { recursive: true });
    await writeFile(path.join(boundWorkspace, "generated.bin"), "generated");
    await bindProjectWorkspace(root, project.id, { path: boundWorkspace });
    await initializeShareStore(shareRoot);
    const generatedArtifact = await createArtifact({
      artifactRoot,
      filename: "project-recording.webm",
      contentType: "video/webm",
      content: "recording-with-metadata",
      projectId: project.id
    });
    const generatedShare = await createShareArtifact({
      shareRoot,
      title: "Project report",
      summary: "Project report",
      filename: "project-report.html",
      html: "<h1>report</h1>",
      projectId: project.id
    });
    const backupRoot = path.join(artifactRoot, "project-backups", "backup_test");
    await mkdir(backupRoot, { recursive: true });
    await writeFile(path.join(backupRoot, "backup-manifest.json"), JSON.stringify({ projectId: project.id }));
    await writeFile(path.join(backupRoot, "copy.bin"), "backup");
    const generatedArtifactRoot = path.join(artifactRoot, "11111111-1111-1111-1111-111111111111");
    await mkdir(generatedArtifactRoot, { recursive: true });
    await writeFile(path.join(generatedArtifactRoot, `${project.id}-recording.webm`), "recording");

    await deleteProject(root, project.id);
    const result = await purgeProject(root, project.id, { workspaceRoot, artifactRoot, shareRoot });

    assert.equal(result.projectId, project.id);
    assert.ok(result.projectBytes > 0);
    assert.ok(result.workspaceBytes > 0);
    assert.ok(result.artifactBytes > 0);
    assert.ok(result.shareBytes > 0);
    assert.equal(result.workspaceRemoved, true);
    await assert.rejects(stat(path.join(root, project.id)), /ENOENT/);
    await assert.rejects(stat(boundWorkspace), /ENOENT/);
    await assert.rejects(readFile(path.join(backupRoot, "copy.bin")), /ENOENT/);
    await assert.rejects(stat(generatedArtifactRoot), /ENOENT/);
    await assert.rejects(stat(path.join(artifactRoot, generatedArtifact.id)), /ENOENT/);
    await assert.rejects(stat(path.join(shareRoot, generatedShare.id)), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("purgeProject keeps a workspace still bound to another project", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "storage-shared-workspace-"));
  const root = path.join(base, "projects");
  const workspaceRoot = path.join(base, "workspace-root");
  try {
    await mkdir(root, { recursive: true });
    const first = await createProject(root, { title: "First", createdByClientId: "test" });
    const second = await createProject(root, { title: "Second", createdByClientId: "test" });
    const sharedWorkspace = path.join(workspaceRoot, "shared");
    await mkdir(sharedWorkspace, { recursive: true });
    await writeFile(path.join(sharedWorkspace, "keep.txt"), "keep");
    await bindProjectWorkspace(root, first.id, { path: sharedWorkspace });
    await bindProjectWorkspace(root, second.id, { path: sharedWorkspace });

    const result = await purgeProject(root, first.id, { workspaceRoot });
    assert.equal(result.workspaceRemoved, false);
    assert.equal((await measureDirectory(sharedWorkspace)).bytes, Buffer.byteLength("keep"));
    await assert.rejects(stat(path.join(root, first.id)), /ENOENT/);
    await stat(path.join(root, second.id));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("storage monitor purges expired soft-deleted projects before reporting", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "storage-monitor-"));
  const root = path.join(base, "projects");
  const workspaceRoot = path.join(base, "workspace");
  try {
    await mkdir(root, { recursive: true });
    const project = await createProject(root, { title: "Expired", createdByClientId: "test" });
    await writeProjectFile(root, project.id, "index.html", "expired");
    await deleteProject(root, project.id);
    const scopes = async () => {
      const projects = await listProjects(root, true);
      return [{
        id: "user:test",
        label: "Test user",
        projectRoot: root,
        workspaceRoot,
        projects: projects.map((item) => ({ id: item.id, title: item.title, status: item.status }))
      }];
    };
    const monitor = startStorageMonitor({
      policy: { ...testPolicy, deletedProjectRetentionDays: 0, monitorIntervalMs: 0 },
      collectScopes: scopes,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
    });
    const report = await monitor.runNow();
    monitor.stop();
    assert.ok(report);
    assert.equal(report.scopes[0]?.projectCount, 0);
    await assert.rejects(stat(path.join(root, project.id)), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
