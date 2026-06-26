import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject, publishProject, writeProjectAsset, writeProjectFile } from "../src/projects/store.js";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createShareArtifact } from "../src/share/store.js";
import { clearHomepage, getHomepage } from "../src/site/store.js";
import { siteTools } from "../src/mcp/tools/site.js";
import { approveUser, registerUser, updateRegistrationSettings } from "../src/user-store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "coding-mcp-admin-api-"));
process.env.ADMIN_PASSCODE = "test-admin-passcode";
process.env.ADMIN_EMAIL = "admin@example.test";
process.env.ADMIN_PASSWORD = "test-admin-password";
process.env.PUBLIC_BASE_URL = "https://example.test";
process.env.CONTENT_BASE_URL = "https://content.example.test";
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
process.env.SHARE_ROOT = path.join(root, "shares");
process.env.ARTIFACT_ROOT = path.join(root, "artifacts");
process.env.PROJECT_ROOT = path.join(root, "projects");
process.env.USERS_ROOT = path.join(root, "users");
process.env.USER_STATE_PATH = path.join(root, "state", "users-state.json");
process.env.SKILL_STATE_PATH = path.join(root, "state", "skill-state.json");
process.env.TOOL_STATE_PATH = path.join(root, "state", "tool-state.json");
process.env.SITE_STATE_PATH = path.join(root, "state", "site-state.json");
process.env.OAUTH_STATE_PATH = path.join(root, "state", "oauth-state.json");
process.env.ADMIN_UI_DIST = path.join(root, "missing-admin-dist");

const { app } = await import("../src/server.js");

const tinyWav = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([36, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]),
  Buffer.from("data"),
  Buffer.from([0, 0, 0, 0])
]);

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

async function requestWithHost(baseUrl: string, pathname: string, host: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { Host: host, ...headers }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    req.end();
  });
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

function mcpContext(projectRoot: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    contentBaseUrl: "https://content.example.test",
    workspaceRoot: process.env.WORKSPACE_ROOT!,
    commandTimeoutMs: 1000,
    shareRoot: process.env.SHARE_ROOT!,
    artifactRoot: process.env.ARTIFACT_ROOT!,
    feedbackRoot: path.join(root, "feedback"),
    projectRoot,
    clientId: "admin-api-test",
    userId: "admin-api-test-user"
  };
}

async function loginResponse(baseUrl: string, headers: Record<string, string> = {}, password = "test-admin-password", email = "admin@example.test"): Promise<Response> {
  return fetch(`${baseUrl}/admin/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email, password })
  });
}

test("admin API protects session endpoints and enforces CSRF", async () => {
  await withServer(async (baseUrl) => {
    const anonymousSession = await fetch(`${baseUrl}/admin/api/session`);
    assert.equal(anonymousSession.status, 200);
    assert.equal((await anonymousSession.json() as { authenticated: boolean }).authenticated, false);

    const malformedCookieSession = await fetch(`${baseUrl}/admin/api/session`, {
      headers: { Cookie: "coding_mcp_session=%E0%A4%A" }
    });
    assert.equal(malformedCookieSession.status, 200);
    assert.equal((await malformedCookieSession.json() as { authenticated: boolean }).authenticated, false);

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

    const project = await createProject(userProjectRoot, {
      title: "Username Share Project",
      createdByClientId: "test-client"
    });
    await writeProjectFile(userProjectRoot, project.id, "index.html", "<!doctype html><html><head><title>Named</title></head><body>Named</body></html>");
    const initiallyPublished = await publishProject(userProjectRoot, project.id, "https://content.example.test", "index.html", { privateBaseUrl: "https://example.test" });
    assert.equal(initiallyPublished.publishedUrl, `https://example.test/share/${project.id}/index.html`);
    assert.equal(initiallyPublished.shareAccess, "private");

    const anonymousPrivateShare = await fetch(`${baseUrl}/share/${project.id}/index.html`);
    assert.equal(anonymousPrivateShare.status, 404);
    assert.equal(anonymousPrivateShare.headers.get("cache-control"), "private, no-store");
    const malformedCookiePrivateShare = await fetch(`${baseUrl}/share/${project.id}/index.html`, {
      headers: { Cookie: "coding_mcp_session=%E0%A4%A" }
    });
    assert.equal(malformedCookiePrivateShare.status, 404);
    const signedInPrivateShare = await fetch(`${baseUrl}/share/${project.id}/index.html`, { headers: { Cookie: cookie } });
    assert.equal(signedInPrivateShare.status, 200);
    assert.equal(signedInPrivateShare.headers.get("cache-control"), "private, no-store");
    assert.equal(signedInPrivateShare.headers.get("vary"), "Cookie");
    const appHostPrivateShare = await requestWithHost(baseUrl, `/share/${project.id}/index.html`, "example.test", { Cookie: cookie });
    assert.equal(appHostPrivateShare.status, 200);
    const appHostPrivateShareCsp = String(appHostPrivateShare.headers["content-security-policy"] ?? "");
    assert.match(appHostPrivateShareCsp, /sandbox/);
    assert.doesNotMatch(appHostPrivateShareCsp, /allow-same-origin/);

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
    const profileBody = await profile.json() as { user: { username?: string; publicShareUsernameEnabled: boolean }; updatedProjectCount: number };
    assert.equal(profileBody.user.username, "demo_user");
    assert.equal(profileBody.user.publicShareUsernameEnabled, true);
    assert.equal(profileBody.updatedProjectCount, 1);

    const projectDetail = await fetch(`${baseUrl}/admin/api/projects/${project.id}`, { headers: { Cookie: cookie } });
    assert.equal(projectDetail.status, 200);
    const projectDetailBody = await projectDetail.json() as { project: { publishedUrl?: string; shareAccess?: string } };
    assert.equal(projectDetailBody.project.publishedUrl, `https://example.test/@demo_user/share/${project.id}/index.html`);
    assert.equal(projectDetailBody.project.shareAccess, "private");

    const namedShare = await fetch(`${baseUrl}/@demo_user/share/${project.id}/index.html`);
    assert.equal(namedShare.status, 404);
    const signedInNamedShare = await requestWithHost(baseUrl, `/@demo_user/share/${project.id}/index.html`, "example.test", { Cookie: cookie });
    assert.equal(signedInNamedShare.status, 200);

    // Private published projects do not appear on the per-user public index.
    const userIndex = await fetch(`${baseUrl}/@demo_user`);
    assert.equal(userIndex.status, 200);
    const userIndexHtml = await userIndex.text();
    assert.ok(!userIndexHtml.includes(project.id), "private project should not be listed on the public index");

    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
    const makePublic = await fetch(`${baseUrl}/admin/api/projects/${project.id}/share-access`, {
      method: "POST",
      headers,
      body: JSON.stringify({ shareAccess: "anyone_with_link" })
    });
    assert.equal(makePublic.status, 200);
    const publicBody = await makePublic.json() as { project: { publishedUrl?: string; shareAccess?: string } };
    assert.equal(publicBody.project.shareAccess, "anyone_with_link");
    assert.equal(publicBody.project.publishedUrl, `https://content.example.test/@demo_user/share/${project.id}/index.html`);

    const appHostShare = await requestWithHost(baseUrl, `/share/${project.id}/index.html`, "example.test");
    assert.equal(appHostShare.status, 302);
    assert.equal(appHostShare.headers.location, `https://content.example.test/@demo_user/share/${project.id}/index.html`);

    const contentHostShare = await requestWithHost(baseUrl, `/share/${project.id}/index.html`, "content.example.test");
    assert.equal(contentHostShare.status, 200);
    const shareCsp = String(contentHostShare.headers["content-security-policy"] ?? "");
    assert.match(shareCsp, /sandbox/);
    assert.match(shareCsp, /allow-same-origin/);
    assert.match(shareCsp, /allow-forms/);
    assert.match(shareCsp, /allow-downloads/);
    assert.doesNotMatch(shareCsp, /form-action 'none'/);

    const contentHostAdmin = await requestWithHost(baseUrl, "/admin/api/session", "content.example.test");
    assert.equal(contentHostAdmin.status, 404);

    const publicNamedShare = await fetch(`${baseUrl}/@demo_user/share/${project.id}/index.html`);
    assert.equal(publicNamedShare.status, 200);
    assert.match(publicNamedShare.headers.get("cache-control") ?? "", /public/);
    assert.match(await publicNamedShare.text(), /rel="canonical" href="https:\/\/content\.example\.test\/@demo_user\/share\//);

    const publicUserIndex = await fetch(`${baseUrl}/@demo_user`);
    assert.equal(publicUserIndex.status, 200);
    const publicUserIndexHtml = await publicUserIndex.text();
    assert.ok(publicUserIndexHtml.includes(project.id), "user index should list the public link project");
    assert.ok(publicUserIndexHtml.includes(`/@demo_user/share/${project.id}`), "user index should link via the username share path");

    // An unknown / not-public username index is 404.
    const unknownIndex = await fetch(`${baseUrl}/@other_user`);
    assert.equal(unknownIndex.status, 404);

    const legacyShare = await fetch(`${baseUrl}/share/${project.id}/index.html`);
    assert.equal(legacyShare.status, 200);

    const wrongUserShare = await fetch(`${baseUrl}/@other_user/share/${project.id}/index.html`);
    assert.equal(wrongUserShare.status, 404);
  });
});

test("MCP publish_project defaults to public access and serves binary project assets", async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const session = await fetch(`${baseUrl}/admin/api/session`, { headers: { Cookie: cookie } });
    const sessionBody = await session.json() as { user?: { projectRoot?: string } };
    const userProjectRoot = sessionBody.user?.projectRoot;
    assert.ok(userProjectRoot);
    const ctx = mcpContext(userProjectRoot);

    const publicProject = await createProject(userProjectRoot, {
      title: "Public WAV Project",
      createdByClientId: "test-client"
    });
    await writeProjectFile(userProjectRoot, publicProject.id, "index.html", "<!doctype html><html><head><title>WAV</title></head><body><audio src=\"music/test.wav\"></audio></body></html>");
    await writeProjectAsset(userProjectRoot, publicProject.id, "music/test.wav", tinyWav, "audio/wav");

    const published = await callTool("publish_project", { projectId: publicProject.id, entryFile: "index.html" }, ctx);
    assert.equal(published.ok, true);
    assert.equal((published.structuredContent as { shareAccess?: string }).shareAccess, "anyone_with_link");
    assert.equal(published.shareUrl, `https://content.example.test/share/${publicProject.id}/index.html`);

    const publicHtml = await fetch(`${baseUrl}/share/${publicProject.id}/index.html`);
    assert.equal(publicHtml.status, 200);
    const publicWav = await fetch(`${baseUrl}/share/${publicProject.id}/music/test.wav`);
    assert.equal(publicWav.status, 200);
    assert.match(publicWav.headers.get("content-type") ?? "", /^audio\/wav\b/);
    assert.equal(Buffer.from(await publicWav.arrayBuffer()).subarray(0, 4).toString("ascii"), "RIFF");

    const reportProject = await createProject(userProjectRoot, {
      title: "Report Project",
      createdByClientId: "test-client"
    });
    await writeProjectFile(userProjectRoot, reportProject.id, "index.html", "<!doctype html><html><head><title>Report</title></head><body>Report</body></html>");
    const report = await callTool("publish_and_report", { projectId: reportProject.id, entryFile: "index.html" }, ctx);
    assert.equal(report.ok, true);
    assert.equal((report.structuredContent as { shareAccess?: string }).shareAccess, "anyone_with_link");
    assert.match(report.summary, /anyone_with_link/);

    const privateProject = await createProject(userProjectRoot, {
      title: "Private WAV Project",
      createdByClientId: "test-client"
    });
    await writeProjectFile(userProjectRoot, privateProject.id, "index.html", "<!doctype html><html><head><title>Private WAV</title></head><body><audio src=\"music/private.wav\"></audio></body></html>");
    await writeProjectAsset(userProjectRoot, privateProject.id, "music/private.wav", tinyWav, "audio/wav");
    const privatePublished = await callTool("publish_project", { projectId: privateProject.id, entryFile: "index.html", shareAccess: "private" }, ctx);
    assert.equal(privatePublished.ok, true);
    assert.equal((privatePublished.structuredContent as { shareAccess?: string }).shareAccess, "private");

    const anonymousPrivateWav = await fetch(`${baseUrl}/share/${privateProject.id}/music/private.wav`);
    assert.equal(anonymousPrivateWav.status, 404);
    const ownerPrivateWav = await fetch(`${baseUrl}/share/${privateProject.id}/music/private.wav`, { headers: { Cookie: cookie } });
    assert.equal(ownerPrivateWav.status, 200);
    assert.match(ownerPrivateWav.headers.get("content-type") ?? "", /^audio\/wav\b/);
  });
});

test("legacy shares are private by default and public only when explicitly link-shared", async () => {
  await withServer(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const ownerSession = await fetch(`${baseUrl}/admin/api/session`, { headers: { Cookie: cookie } });
    const ownerSessionBody = await ownerSession.json() as { user?: { id?: string } };
    const ownerUserId = ownerSessionBody.user?.id;
    assert.ok(ownerUserId);

    await updateRegistrationSettings({ allowRegistration: true, allowedEmailDomains: [] });
    const otherEmail = `other-${Date.now()}@example.test`;
    const otherPassword = "test-user-password";
    const otherUser = await registerUser(otherEmail, otherPassword);
    await approveUser(otherUser.id, ownerUserId);
    const otherLogin = await loginResponse(baseUrl, {}, otherPassword, otherEmail);
    assert.equal(otherLogin.status, 200);
    const otherCookie = otherLogin.headers.get("set-cookie")?.split(";")[0];
    assert.ok(otherCookie);

    const privateShare = await createShareArtifact({
      shareRoot: process.env.SHARE_ROOT!,
      title: "Private legacy share",
      summary: "legacy private",
      filename: "private.html",
      html: "<h1>PRIVATE_LEGACY_SHARE</h1>",
      ownerUserId
    });
    const anonymousPrivate = await fetch(`${baseUrl}/share/${privateShare.id}/${privateShare.filename}`);
    assert.equal(anonymousPrivate.status, 404);
    const signedInPrivate = await fetch(`${baseUrl}/share/${privateShare.id}/${privateShare.filename}`, { headers: { Cookie: cookie } });
    assert.equal(signedInPrivate.status, 200);
    assert.match(await signedInPrivate.text(), /PRIVATE_LEGACY_SHARE/);
    const wrongUserPrivate = await fetch(`${baseUrl}/share/${privateShare.id}/${privateShare.filename}`, { headers: { Cookie: otherCookie } });
    assert.equal(wrongUserPrivate.status, 404);

    const publicShare = await createShareArtifact({
      shareRoot: process.env.SHARE_ROOT!,
      title: "Public legacy share",
      summary: "legacy public",
      filename: "public.html",
      html: "<h1>PUBLIC_LEGACY_SHARE</h1>",
      shareAccess: "anyone_with_link",
      ownerUserId
    });
    const anonymousPublic = await fetch(`${baseUrl}/share/${publicShare.id}/${publicShare.filename}`);
    assert.equal(anonymousPublic.status, 200);
    assert.match(await anonymousPublic.text(), /PUBLIC_LEGACY_SHARE/);
  });
});

test("site homepage serves at root and set_homepage is admin-gated", async () => {
  clearHomepage();
  await withServer(async (baseUrl) => {
    // No homepage yet -> default landing (not "Cannot GET /").
    const empty = await fetch(`${baseUrl}/`);
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /No homepage has been published yet/);

    const { cookie } = await login(baseUrl);
    const sessionBody = await (await fetch(`${baseUrl}/admin/api/session`, { headers: { Cookie: cookie } })).json() as { user?: { id?: string; projectRoot?: string; role?: string } };
    const adminId = sessionBody.user?.id;
    const adminRoot = sessionBody.user?.projectRoot;
    assert.ok(adminId && adminRoot);
    assert.equal(sessionBody.user?.role, "admin");

    const project = await createProject(adminRoot, { title: "Landing", createdByClientId: "test-client" });
    await writeProjectFile(adminRoot, project.id, "index.html", "<!doctype html><title>Home</title><link rel=stylesheet href=./styles.css><h1>HOMEPAGE_MARKER</h1>");
    await writeProjectFile(adminRoot, project.id, "styles.css", "h1{color:rebeccapurple}");
    await publishProject(adminRoot, project.id, "https://example.test", "index.html");
    const draftProject = await createProject(adminRoot, { title: "Draft home", createdByClientId: "test-client" });

    // set_homepage must reject a non-admin caller (no userId).
    const setHomepageTool = siteTools.find((tool) => tool.definition.name === "set_homepage");
    assert.ok(setHomepageTool);
    const ctxBase = { publicBaseUrl: "https://example.test", workspaceRoot: root, commandTimeoutMs: 1000, shareRoot: root, artifactRoot: root, feedbackRoot: root, projectRoot: adminRoot, clientId: "test-client" };
    const denied = await setHomepageTool.handler({ projectId: project.id }, { ...ctxBase, userId: undefined });
    assert.equal(denied.ok, false);
    assert.equal(getHomepage().homeProjectId, null);
    const rejectedDraft = await setHomepageTool.handler({ projectId: draftProject.id }, { ...ctxBase, userId: adminId });
    assert.equal(rejectedDraft.ok, false);
    assert.match(rejectedDraft.summary, /published/);
    assert.equal(getHomepage().homeProjectId, null);

    await updateRegistrationSettings({ allowRegistration: true, allowedEmailDomains: [] });
    const otherUser = await registerUser(`homepage-owner-${Date.now()}@example.test`, "test-user-password");
    const approvedOtherUser = await approveUser(otherUser.id, adminId);
    const otherProject = await createProject(approvedOtherUser.projectRoot, { title: "Other User Landing", createdByClientId: "test-client" });
    await writeProjectFile(approvedOtherUser.projectRoot, otherProject.id, "index.html", "<!doctype html><title>OtherHome</title><h1>OTHER_HOME_MARKER</h1>");
    await publishProject(approvedOtherUser.projectRoot, otherProject.id, "https://example.test", "index.html");
    const deniedDeveloper = await setHomepageTool.handler(
      { projectId: otherProject.id },
      { ...ctxBase, projectRoot: approvedOtherUser.projectRoot, userId: approvedOtherUser.id }
    );
    assert.equal(deniedDeveloper.ok, false);
    assert.equal(getHomepage().homeProjectId, null);

    // Admin MCP set_homepage can target a published project owned by another user.
    const crossUser = await setHomepageTool.handler({ projectId: otherProject.id }, { ...ctxBase, userId: adminId });
    assert.equal(crossUser.ok, true);
    assert.equal(getHomepage().homeProjectId, otherProject.id);
    assert.equal(getHomepage().homeOwnerUserId, approvedOtherUser.id);
    assert.match(await (await fetch(`${baseUrl}/`)).text(), /OTHER_HOME_MARKER/);

    // set_homepage succeeds for an admin caller.
    const allowed = await setHomepageTool.handler({ projectId: project.id }, { ...ctxBase, userId: adminId });
    assert.equal(allowed.ok, true);
    assert.equal(getHomepage().homeProjectId, project.id);
    assert.equal(getHomepage().homeOwnerUserId, adminId);

    // Root now serves the homepage entry file and its sibling asset.
    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /HOMEPAGE_MARKER/);
    const homepageCsp = home.headers.get("content-security-policy") ?? "";
    assert.match(homepageCsp, /sandbox/);
    assert.doesNotMatch(homepageCsp, /allow-same-origin/);

    const css = await fetch(`${baseUrl}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /rebeccapurple/);

    clearHomepage();
    const clearedHome = await fetch(`${baseUrl}/`);
    assert.equal(clearedHome.status, 200);
    assert.match(await clearedHome.text(), /No homepage has been published yet/);
  });
});

test("admin API sets and clears the homepage", async () => {
  clearHomepage();
  await withServer(async (baseUrl) => {
    const { cookie, csrfToken } = await login(baseUrl);
    const sessionBody = await (await fetch(`${baseUrl}/admin/api/session`, { headers: { Cookie: cookie } })).json() as { user?: { projectRoot?: string } };
    const adminRoot = sessionBody.user?.projectRoot;
    assert.ok(adminRoot);

    const project = await createProject(adminRoot, { title: "Admin Set Home", createdByClientId: "test-client" });
    await writeProjectFile(adminRoot, project.id, "index.html", "<!doctype html><title>AdminHome</title><h1>ADMIN_HOME_MARKER</h1>");
    await publishProject(adminRoot, project.id, "https://example.test", "index.html");

    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken };

    // Setting the homepage requires the CSRF token.
    const noCsrf = await fetch(`${baseUrl}/admin/api/projects/${project.id}/homepage`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" } });
    assert.equal(noCsrf.status, 403);

    const setRes = await fetch(`${baseUrl}/admin/api/projects/${project.id}/homepage`, { method: "POST", headers });
    assert.equal(setRes.status, 200);

    const current = await (await fetch(`${baseUrl}/admin/api/site/home`, { headers: { Cookie: cookie } })).json() as { homepage?: { projectId?: string; title?: string } };
    assert.equal(current.homepage?.projectId, project.id);
    assert.equal(current.homepage?.title, "Admin Set Home");

    assert.match(await (await fetch(`${baseUrl}/`)).text(), /ADMIN_HOME_MARKER/);

    await rm(path.join(adminRoot, project.id, "files", "index.html"));
    const unavailable = await fetch(`${baseUrl}/`);
    assert.equal(unavailable.status, 503);
    assert.match(await unavailable.text(), /Configured homepage is unavailable/);
    const stillConfigured = await (await fetch(`${baseUrl}/admin/api/site/home`, { headers: { Cookie: cookie } })).json() as { homepage?: { projectId?: string; title?: string } };
    assert.equal(stillConfigured.homepage?.projectId, project.id);

    const clearRes = await fetch(`${baseUrl}/admin/api/site/home`, { method: "DELETE", headers });
    assert.equal(clearRes.status, 200);
    const afterClear = await (await fetch(`${baseUrl}/admin/api/site/home`, { headers: { Cookie: cookie } })).json() as { homepage: unknown };
    assert.equal(afterClear.homepage, null);
  });
});

test("admin session cookie Secure flag follows request and ADMIN_COOKIE_SECURE mode", async () => {
  await withServer(async (baseUrl) => {
    process.env.ADMIN_COOKIE_SECURE = "auto";
    const localHttp = await loginResponse(baseUrl);
    assert.equal(localHttp.status, 200);
    assert.doesNotMatch(localHttp.headers.get("set-cookie") ?? "", /;\s*Secure/i);

    const forwardedHttpsNoTrust = await loginResponse(baseUrl, { "X-Forwarded-Proto": "https" });
    assert.equal(forwardedHttpsNoTrust.status, 200);
    assert.doesNotMatch(forwardedHttpsNoTrust.headers.get("set-cookie") ?? "", /;\s*Secure/i, "X-Forwarded-Proto must not be trusted without ADMIN_TRUST_PROXY");

    process.env.ADMIN_TRUST_PROXY = "true";
    const forwardedHttps = await loginResponse(baseUrl, { "X-Forwarded-Proto": "https" });
    assert.equal(forwardedHttps.status, 200);
    assert.match(forwardedHttps.headers.get("set-cookie") ?? "", /;\s*Secure/i, "X-Forwarded-Proto should be trusted when ADMIN_TRUST_PROXY=true");
    process.env.ADMIN_TRUST_PROXY = "";

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

test("admin user management protects the last active admin", async () => {
  await withServer(async (baseUrl) => {
    const { cookie, csrfToken } = await login(baseUrl);
    const sessionBody = await (await fetch(`${baseUrl}/admin/api/session`, { headers: { Cookie: cookie } })).json() as { user?: { id?: string } };
    const adminId = sessionBody.user?.id;
    assert.ok(adminId);
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken };

    const noOpRole = await fetch(`${baseUrl}/admin/api/users/${adminId}/role`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "admin" })
    });
    assert.equal(noOpRole.status, 200);

    const disableOnlyAdmin = await fetch(`${baseUrl}/admin/api/users/${adminId}/disable`, {
      method: "POST",
      headers
    });
    assert.equal(disableOnlyAdmin.status, 400);
    assert.match(JSON.stringify(await disableOnlyAdmin.json()), /last active admin/);

    const demoteOnlyAdmin = await fetch(`${baseUrl}/admin/api/users/${adminId}/role`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "viewer" })
    });
    assert.equal(demoteOnlyAdmin.status, 400);
    assert.match(JSON.stringify(await demoteOnlyAdmin.json()), /last active admin/);

    await updateRegistrationSettings({ allowRegistration: true, allowedEmailDomains: [] });
    const secondEmail = `second-admin-${Date.now()}@example.test`;
    const secondPassword = "test-second-admin-password";
    const secondUser = await registerUser(secondEmail, secondPassword);
    await approveUser(secondUser.id, adminId);
    const promoteSecond = await fetch(`${baseUrl}/admin/api/users/${secondUser.id}/role`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "admin" })
    });
    assert.equal(promoteSecond.status, 200);

    const secondLogin = await loginResponse(baseUrl, {}, secondPassword, secondEmail);
    assert.equal(secondLogin.status, 200);

    const demoteFirst = await fetch(`${baseUrl}/admin/api/users/${adminId}/role`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "viewer" })
    });
    assert.equal(demoteFirst.status, 200);
    const demoteFirstBody = await demoteFirst.json() as { user?: { role?: string } };
    assert.equal(demoteFirstBody.user?.role, "viewer");
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

test("favicon is served on both app and content hosts (no 404 console noise)", async () => {
  await withServer(async (baseUrl) => {
    for (const host of ["example.test", "content.example.test"]) {
      const res = await requestWithHost(baseUrl, "/favicon.ico", host);
      assert.equal(res.status, 200, `favicon should 200 on ${host}`);
      assert.match(String(res.headers["content-type"]), /image\/svg\+xml/);
      assert.match(res.body, /<svg/);
    }
  });
});
