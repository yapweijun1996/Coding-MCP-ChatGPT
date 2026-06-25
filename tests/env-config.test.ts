import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
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
    clientId: "env-config-test"
  };
}

test("environment config tools manage profiles, entries, secret redaction, validation, and reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "env-config-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Env config project", createdByClientId: "coder" });
    const profile = getToolModule("upsert_env_config_profile");
    const entry = getToolModule("upsert_env_config_entry");
    const list = getToolModule("list_env_config_profiles");
    const validate = getToolModule("validate_env_config");
    const report = getToolModule("export_env_config_report");
    assert.ok(profile, "upsert_env_config_profile registered");
    assert.ok(entry, "upsert_env_config_entry registered");
    assert.ok(list, "list_env_config_profiles registered");
    assert.ok(validate, "validate_env_config registered");
    assert.ok(report, "export_env_config_report registered");

    const profileResult = await profile!.handler({ projectId: project.id, environment: "demo", label: "Demo", safeDefaultsPolicy: "strict" }, ctx);
    assert.equal(profileResult.ok, true);
    assert.deepEqual(profileResult.artifacts, ["env-config/env-config.json"]);

    await entry!.handler({
      projectId: project.id,
      environment: "demo",
      key: "PUBLIC_API_BASE_URL",
      required: true,
      status: "configured",
      safeDefault: "https://example.test/api",
      value: "https://demo.example.test/api",
      description: "Demo API endpoint"
    }, ctx);

    const secretResult = await entry!.handler({
      projectId: project.id,
      environment: "demo",
      key: "PAYMENT_API_KEY",
      required: true,
      secret: true,
      status: "configured",
      value: "sk_live_should_not_persist"
    }, ctx);
    assert.equal(secretResult.ok, false);
    const secretPayload = secretResult.structuredContent as { entry: { value?: string; valueRedacted?: boolean; status: string }; warnings: string[] };
    assert.equal(secretPayload.entry.value, undefined);
    assert.equal(secretPayload.entry.valueRedacted, true);
    assert.equal(secretPayload.entry.status, "external_secret");
    assert.match(secretPayload.warnings[0], /not stored/);

    await entry!.handler({
      projectId: project.id,
      environment: "production",
      key: "ENABLE_BETA_CHECKOUT",
      kind: "feature_flag",
      required: false,
      status: "configured",
      value: true
    }, ctx);

    const listed = (await list!.handler({ projectId: project.id, environment: "demo" }, ctx)).structuredContent as { profiles: unknown[]; entries: Array<{ key: string; value?: string }> };
    assert.equal(listed.profiles.length, 1);
    assert.equal(listed.entries.length, 2);
    assert.equal(listed.entries.some((item) => item.key === "PAYMENT_API_KEY" && item.value === undefined), true);

    const raw = await readProjectFile(ctx.projectRoot, project.id, "env-config/env-config.json");
    assert.equal(raw.includes("sk_live_should_not_persist"), false);

    const validation = (await validate!.handler({ projectId: project.id }, ctx)).structuredContent as { status: string; findings: Array<{ severity: string; key?: string; message: string }> };
    assert.equal(validation.status, "ready");
    assert.equal(validation.findings.some((finding) => finding.key === "PAYMENT_API_KEY" && /persisted value/.test(finding.message)), false);

    const reportResult = await report!.handler({ projectId: project.id }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "env-config/env-config-report.md");
    assert.match(markdown, /Environment Configuration Report/);
    assert.match(markdown, /PAYMENT_API_KEY/);
    assert.doesNotMatch(markdown, /sk_live_should_not_persist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment config tools are exposed through core, coding, debug, and dedicated skills", () => {
  for (const skillId of ["core", "coding", "debug", "environment-config"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill registered`);
    assert.ok(skill!.toolNames.includes("upsert_env_config_profile"));
    assert.ok(skill!.toolNames.includes("upsert_env_config_entry"));
    assert.ok(skill!.toolNames.includes("list_env_config_profiles"));
    assert.ok(skill!.toolNames.includes("validate_env_config"));
    assert.ok(skill!.toolNames.includes("export_env_config_report"));
  }
});
