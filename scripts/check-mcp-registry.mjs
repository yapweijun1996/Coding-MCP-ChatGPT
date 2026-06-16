import { readFileSync } from "node:fs";
import { toolRegistry, toolDefinitions } from "../dist/mcp/registry.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageScripts = packageJson.scripts ?? {};
const names = toolDefinitions.map((tool) => tool.name);
const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
const moduleNames = toolRegistry.map((tool) => tool.definition.name);
const criticalTools = [
  "ping",
  "create_project",
  "write_project_file",
  "read_project_file",
  "get_project_manifest",
  "validate_project",
  "publish_project",
  "publish_and_report",
  "run_command",
  "run_typecheck",
  "run_tests",
  "run_build",
  "inspect_webpage"
];
const defaultDisabledTools = [
  "delete_project",
  "create_share"
];
const enabledToolRequiredScripts = new Map([
  ["run_typecheck", "typecheck"],
  ["run_tests", "test"],
  ["run_build", "build"],
  ["run_lint", "lint"],
  ["run_format_check", "format"],
  ["run_format_write", "format"],
  ["diagnostic_bundle", "lint"],
  ["diagnostic_bundle_full", "lint"]
]);
const errors = [];

if (duplicateNames.length > 0) {
  errors.push(`Duplicate tool names: ${[...new Set(duplicateNames)].join(", ")}`);
}

if (moduleNames.length !== names.length) {
  errors.push(`Registry/module count mismatch: modules=${moduleNames.length}, definitions=${names.length}`);
}

for (const toolName of criticalTools) {
  if (!names.includes(toolName)) errors.push(`Missing critical tool: ${toolName}`);
}

for (const toolName of defaultDisabledTools) {
  const tool = toolRegistry.find((candidate) => candidate.definition.name === toolName);
  if (!tool) {
    errors.push(`Missing expected default-disabled tool: ${toolName}`);
  } else if (tool.enabledByDefault) {
    errors.push(`Tool must be disabled by default: ${toolName}`);
  }
}

for (const [toolName, scriptName] of enabledToolRequiredScripts.entries()) {
  const tool = toolRegistry.find((candidate) => candidate.definition.name === toolName);
  if (tool?.enabledByDefault && typeof packageScripts[scriptName] !== "string") {
    errors.push(`Default-enabled tool ${toolName} requires missing package script: ${scriptName}`);
  }
}

const summary = {
  toolCount: names.length,
  duplicateCount: duplicateNames.length,
  defaultDisabledTools,
  criticalTools
};

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors, summary }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, summary }, null, 2));
