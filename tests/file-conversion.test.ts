import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile, writeProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "workspace"),
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "file-conversion-test"
  };
}

function tinyZip(entries: Array<{ name: string; content: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, content);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(content.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + content.length;
  }
  const centralOffset = offset;
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...parts, centralBuffer, eocd]);
}

test("file conversion tools inspect files, list archives, convert tables, and export reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "file-conversion-"));
  try {
    const ctx = toolContext(root);
    await mkdir(ctx.workspaceRoot, { recursive: true });
    await writeFile(path.join(ctx.workspaceRoot, "sample.pdf"), Buffer.from("%PDF-1.7\n"));
    await writeFile(path.join(ctx.workspaceRoot, "bundle.docx"), tinyZip([
      { name: "[Content_Types].xml", content: "<Types/>" },
      { name: "word/document.xml", content: "<w:document/>" },
      { name: "../evil.txt", content: "bad" }
    ]));
    const project = await createProject(ctx.projectRoot, { title: "Conversion project", createdByClientId: "converter" });
    await writeProjectFile(ctx.projectRoot, project.id, "data/table.txt", "name,value\nA,10\nB,20\n");

    const inspect = getToolModule("inspect_convertible_file");
    const archive = getToolModule("list_safe_archive_entries");
    const table = getToolModule("convert_table_data_format");
    const plan = getToolModule("create_file_conversion_plan");
    const report = getToolModule("export_file_conversion_report");
    const media = getToolModule("create_media_conversion_manifest");
    for (const [name, tool] of Object.entries({ inspect, archive, table, plan, report, media })) assert.ok(tool, `${name} registered`);

    const pdfResult = await inspect!.handler({ workspacePath: "sample.pdf" }, ctx);
    const pdfPayload = pdfResult.structuredContent as { format: string; mime: string };
    assert.equal(pdfPayload.format, "pdf");
    assert.equal(pdfPayload.mime, "application/pdf");

    const docxResult = await inspect!.handler({ workspacePath: "bundle.docx" }, ctx);
    const docxPayload = docxResult.structuredContent as { format: string; archive: { entries: Array<{ name: string }> } };
    assert.equal(docxPayload.format, "docx");
    assert.equal(docxPayload.archive.entries.some((entry) => entry.name === "word/document.xml"), true);

    const archiveResult = await archive!.handler({ workspacePath: "bundle.docx" }, ctx);
    assert.equal(archiveResult.ok, false);
    const archivePayload = archiveResult.structuredContent as { entries: Array<{ name: string; safe: boolean }> };
    assert.equal(archivePayload.entries.some((entry) => entry.name === "../evil.txt" && entry.safe === false), true);

    const tableResult = await table!.handler({
      projectId: project.id,
      path: "data/table.txt",
      inputFormat: "csv",
      outputFormat: "markdown",
      writeToProject: true,
      outputPath: "file-conversion/table.md"
    }, ctx);
    assert.equal(tableResult.ok, true);
    assert.ok(tableResult.artifacts.includes("file-conversion/table.md"));
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "file-conversion/table.md");
    assert.match(markdown, /\| name \| value \|/);

    const planResult = await plan!.handler({
      projectId: project.id,
      sources: [
        { path: "sample.pdf", format: "pdf", desiredOutput: "markdown" },
        { path: "video.mp4", format: "video", desiredOutput: "transcode_report" }
      ],
      writeToProject: true
    }, ctx);
    assert.equal(planResult.ok, true);
    assert.ok(planResult.artifacts.includes("file-conversion/conversion-plan.json"));

    const reportResult = await report!.handler({
      projectId: project.id,
      title: "Conversion Report",
      findings: ["Unsafe archive path found."],
      inspectedFiles: [docxPayload]
    }, ctx);
    assert.equal(reportResult.ok, true);
    const reportText = await readProjectFile(ctx.projectRoot, project.id, "file-conversion/conversion-report.md");
    assert.match(reportText, /Unsafe archive path found/);

    const mediaResult = await media!.handler({
      projectId: project.id,
      assets: [{ path: "clip.mov", mediaType: "video", sourceFormat: "mov", targetFormat: "mp4", bitrateKbps: 4000 }]
    }, ctx);
    assert.equal(mediaResult.ok, true);
    assert.ok(mediaResult.artifacts.includes("file-conversion/media-conversion-manifest.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file-conversion skill exposes tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "inspect_convertible_file",
    "list_safe_archive_entries",
    "convert_table_data_format",
    "create_file_conversion_plan",
    "export_file_conversion_report",
    "create_media_conversion_manifest"
  ];
  const fileConversion = skillRegistry.find((entry) => entry.id === "file-conversion");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(fileConversion);
  for (const toolName of toolNames) {
    assert.ok(fileConversion!.toolNames.includes(toolName), `${toolName} exposed in file-conversion`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
