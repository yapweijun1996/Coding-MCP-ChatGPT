import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, readProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "mock-api-test"
  };
}

test("project mock API creates fixtures and serves CORS JSON states", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mock-api-"));
  let projectId = "";
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "API demo", createdByClientId: "coder" });
    projectId = project.id;

    const createResult = await callTool("create_project_mock_api", {
      projectId,
      routes: [
        {
          method: "GET",
          path: "/api/users",
          collection: [
            { id: 1, name: "Ada Lovelace", role: "admin" },
            { id: 2, name: "Grace Hopper", role: "engineer" },
            { id: 3, name: "Alan Turing", role: "research" }
          ],
          pagination: { pageParam: "page", pageSizeParam: "pageSize", defaultPageSize: 2, maxPageSize: 5 },
          search: { queryParam: "q", fields: ["name", "role"] },
          states: {
            stateParam: "mockState",
            errorStatus: 503,
            errorBody: { error: "planned outage" },
            authExpiredStatus: 401,
            authExpiredBody: { error: "login again" },
            slowDelayMs: 5
          }
        }
      ]
    }, ctx);
    assert.equal(createResult.ok, true);
    assert.deepEqual(createResult.artifacts.sort(), ["mock-api/README.md", "mock-api/client.js", "mock-api/routes.json"].sort());

    const config = JSON.parse(await readProjectFile(ctx.projectRoot, projectId, "mock-api/routes.json")) as { routes: Array<{ path: string }> };
    assert.equal(config.routes[0].path, "/api/users");
    assert.match(await readProjectFile(ctx.projectRoot, projectId, "mock-api/client.js"), /fetchMockJson/);

    const startResult = await callTool("start_project_mock_api", { projectId, port: 0 }, ctx);
    assert.equal(startResult.ok, true);
    const baseUrl = (startResult.structuredContent as { baseUrl: string }).baseUrl;
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const pageResponse = await fetch(`${baseUrl}/api/users?page=1&pageSize=2`);
    assert.equal(pageResponse.headers.get("access-control-allow-origin"), "*");
    assert.equal(pageResponse.status, 200);
    assert.deepEqual(await pageResponse.json(), {
      items: [
        { id: 1, name: "Ada Lovelace", role: "admin" },
        { id: 2, name: "Grace Hopper", role: "engineer" }
      ],
      total: 3,
      page: 1,
      pageSize: 2,
      totalPages: 2
    });

    const searchResponse = await fetch(`${baseUrl}/api/users?q=grace`);
    const searchBody = await searchResponse.json() as { items: Array<{ name: string }>; total: number };
    assert.equal(searchBody.total, 1);
    assert.equal(searchBody.items[0].name, "Grace Hopper");

    const emptyResponse = await fetch(`${baseUrl}/api/users?mockState=empty`);
    const emptyBody = await emptyResponse.json() as { items: unknown[]; total: number };
    assert.deepEqual(emptyBody.items, []);
    assert.equal(emptyBody.total, 0);

    const errorResponse = await fetch(`${baseUrl}/api/users?mockState=error`);
    assert.equal(errorResponse.status, 503);
    assert.deepEqual(await errorResponse.json(), { error: "planned outage" });

    const authResponse = await fetch(`${baseUrl}/api/users?mockState=auth-expired`);
    assert.equal(authResponse.status, 401);
    assert.deepEqual(await authResponse.json(), { error: "login again" });

    const slowStarted = Date.now();
    const slowResponse = await fetch(`${baseUrl}/api/users?mockState=slow`);
    assert.equal(slowResponse.status, 200);
    assert.equal(Date.now() - slowStarted >= 5, true);

    const missingResponse = await fetch(`${baseUrl}/api/missing`);
    assert.equal(missingResponse.status, 404);

    const stopResult = await callTool("stop_project_mock_api", { projectId }, ctx);
    assert.equal(stopResult.ok, true);
    assert.equal((stopResult.structuredContent as { requestCount: number }).requestCount >= 7, true);
    projectId = "";
  } finally {
    if (projectId) {
      await callTool("stop_project_mock_api", { projectId }, toolContext(root)).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("mock API tools are exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of ["create_project_mock_api", "start_project_mock_api", "stop_project_mock_api"]) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
