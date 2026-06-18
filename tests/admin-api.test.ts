import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject, publishProject, writeProjectFile } from "../src/projects/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "coding-mcp-admin-api-"));
process.env.ADMIN_PASSCODE = "test-admin-passcode";
process.env.ADMIN_EMAIL = "admin@example.test";
process.env.ADMIN_PASSWORD = "test-admin-password";
process.env.PUBLIC_BASE_URL = "https://example.test";
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
process.env.SHARE_ROOT = path.join(root, "shares");
process.env.ARTIFACT_ROOT = path.join(root, "artifacts");
process.env.PROJECT_ROOT = path.join(root, "projects");
process.env.USERS_ROOT = path.join(root, "users");
process.env.USER_STATE_PATH = path.join(root, "state", "users-state.json");
process.env.SKILL_STATE_PATH = path.join(root, "state", "skill-state.json");
process.env.OAUTH_STATE_PATH = path.join(root, "state", "oauth-state.json");
process.env.ADMIN_UI_DIST = path.join(root, "missing-admin-dist");

const { app } = await import("../src/server.js");

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function login(baseUrl: string): Promise<{ cookie: string; csrfToken: string }> {
  const response = await loginResponse(baseUrl);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const body = await response.json() as { csrfToken?: string };
  assert.ok(body.csrfToken);
  return { cookie, csrfToken: body.csrfToken };
}

async function loginResponse(baseUrl: string, headers: Record<string, string> = {}, password = "test-admin-password"): Promise<Response> {
  return fetch(`${baseUrl}/admin/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email: "admin@example.test", password })
  });
}

test("admin API protects session endpoints and enforces CSRF", async () => {
  await withServer(async (baseUrl) => {
    const anonymousSession = await fetch(`${baseUrl}/admin/api/session`);
    assert.equal(anonymousSession.status, 200);
    assert.equal((await anonymousSession.json() as { authenticated: boolean }).authenticated, false);

    const protectedRead = await fetch(`${baseUrl}/admin/api/overview`);
    assert.equal(protectedRead.status, 401);

    const invalidLogin = await fetch(`${baseUrl}/admin/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: "wrong" })
    });
    assert.equal(invalidLogin.status, 401);

    const { cookie, csrfToken } = await login(baseUrl);
    const overview = await fetch(`${baseUrl}/admin/api/overview`, { headers: { Cookie: cookie } });
    assert.equal(overview.status, 200);

    const project = await createProject(process.env.PROJECT_ROOT!, {
      title: "Admin API Project",
      summary: "Used by admin API test",
      createdByClientId: "test-client"
    });
    await writeProjectFile(process.env.PROJECT_ROOT!, project.id, "index.html", "<!doctype html><title>Admin API Project</title>");

    const missingCsrf = await fetch(`${baseUrl}/admin/api/projects/${project.id}/status`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "private" })
    });
    assert.equal(missingCsrf.status, 403);

    const statusUpdate = await fetch(`${baseUrl}/admin/api/projects/${project.id}/status`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ status: "private" })
    });
    assert.equal(statusUpdate.status, 200);

    const projects = await fetch(`${baseUrl}/admin/api/projects?q=Admin%20API&status=private&page=1&pageSize=5`, {
      headers: { Cookie: cookie }
    });
    assert.equal(projects.status, 200);
    const payload = await projects.json() as { total: number; items: Array<{ id: string; status: string }> };
    assert.equal(payload.total, 1);
    assert.equal(payload.items[0]?.id, project.id);
    assert.equal(payload.items[0]?.status, "private");
  });
});

test("profile username controls public username share URLs", async () => {
  await withServer(async (baseUrl) => {
    const { cookie, csrfToken } = await login(baseUrl);
    const session = await fetch(`${baseUrl}/admin/api/session`, { headers: { Cookie: cookie } });
    const sessionBody = await session.json() as { user?: { projectRoot?: string } };
    const userProjectRoot = sessionBody.user?.projectRoot;
    assert.ok(userProjectRoot);

    const invalidProfile = await fetch(`${baseUrl}/admin/api/profile`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ username: "share", publicShareUsernameEnabled: true })
    });
    assert.equal(invalidProfile.status, 400);

    const profile = await fetch(`${baseUrl}/admin/api/profile`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ username: "demo_user", publicShareUsernameEnabled: true })
    });
    assert.equal(profile.status, 200);
    const profileBody = await profile.json() as { user: { username?: string; publicShareUsernameEnabled: boolean } };
    assert.equal(profileBody.user.username, "demo_user");
    assert.equal(profileBody.user.publicShareUsernameEnabled, true);

    const project = await createProject(userProjectRoot, {
      title: "Username Share Project",
      createdByClientId: "test-client"
    });
    await writeProjectFile(userProjectRoot, project.id, "index.html", "<!doctype html><html><head><title>Named</title></head><body>Named</body></html>");
    const published = await publishProject(userProjectRoot, project.id, "https://example.test", "index.html", { shareBasePath: "/@demo_user/share" });
    assert.equal(published.publishedUrl, `https://example.test/@demo_user/share/${project.id}/index.html`);

    const namedShare = await fetch(`${baseUrl}/@demo_user/share/${project.id}/index.html`);
    assert.equal(namedShare.status, 200);
    assert.match(await namedShare.text(), /rel="canonical" href="https:\/\/example\.test\/@demo_user\/share\//);

    const legacyShare = await fetch(`${baseUrl}/share/${project.id}/index.html`);
    assert.equal(legacyShare.status, 200);

    const wrongUserShare = await fetch(`${baseUrl}/@other_user/share/${project.id}/index.html`);
    assert.equal(wrongUserShare.status, 404);
  });
});

test("admin session cookie Secure flag follows request and ADMIN_COOKIE_SECURE mode", async () => {
  await withServer(async (baseUrl) => {
    process.env.ADMIN_COOKIE_SECURE = "auto";
    const localHttp = await loginResponse(baseUrl);
    assert.equal(localHttp.status, 200);
    assert.doesNotMatch(localHttp.headers.get("set-cookie") ?? "", /;\s*Secure/i);

    const forwardedHttps = await loginResponse(baseUrl, { "X-Forwarded-Proto": "https" });
    assert.equal(forwardedHttps.status, 200);
    assert.match(forwardedHttps.headers.get("set-cookie") ?? "", /;\s*Secure/i);

    process.env.ADMIN_COOKIE_SECURE = "false";
    const forcedInsecure = await loginResponse(baseUrl, { "X-Forwarded-Proto": "https" });
    assert.equal(forcedInsecure.status, 200);
    assert.doesNotMatch(forcedInsecure.headers.get("set-cookie") ?? "", /;\s*Secure/i);

    process.env.ADMIN_COOKIE_SECURE = "true";
    const forcedSecure = await loginResponse(baseUrl);
    assert.equal(forcedSecure.status, 200);
    assert.match(forcedSecure.headers.get("set-cookie") ?? "", /;\s*Secure/i);

    process.env.ADMIN_COOKIE_SECURE = "auto";
  });
});

test("admin login rate limit locks repeated bad passwords and success clears failures", async () => {
  await withServer(async (baseUrl) => {
    process.env.ADMIN_COOKIE_SECURE = "auto";
    for (let index = 0; index < 4; index += 1) {
      const badLogin = await loginResponse(baseUrl, {}, "wrong");
      assert.equal(badLogin.status, 401);
    }

    const successfulLogin = await loginResponse(baseUrl);
    assert.equal(successfulLogin.status, 200);

    for (let index = 0; index < 4; index += 1) {
      const badLogin = await loginResponse(baseUrl, {}, "wrong");
      assert.equal(badLogin.status, 401);
    }

    const thresholdLogin = await loginResponse(baseUrl, {}, "wrong");
    assert.equal(thresholdLogin.status, 429);
    assert.deepEqual(await thresholdLogin.json(), { ok: false, error: "Too many login attempts. Try again later." });

    const lockedLogin = await loginResponse(baseUrl);
    assert.equal(lockedLogin.status, 429);
  });
});
