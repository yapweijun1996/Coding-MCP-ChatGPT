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
    clientId: "mock-data-test"
  };
}

test("generate_mock_data_fixture writes deterministic related JSON and CSV tables", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mock-data-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "ERP demo", createdByClientId: "coder" });

    const args = {
      projectId: project.id,
      seed: 777,
      domain: "inventory",
      outputDir: "fixtures",
      tables: [
        {
          name: "warehouses",
          rowCount: 3,
          fields: [
            { name: "id", type: "id", prefix: "wh" },
            { name: "name", type: "string", values: ["North Hub", "South Hub", "East Hub"] },
            { name: "city", type: "city" }
          ]
        },
        {
          name: "products",
          rowCount: 5,
          fields: [
            { name: "id", type: "id", prefix: "prd" },
            { name: "warehouse_id", type: "foreignKey", reference: "warehouses.id" },
            { name: "sku", type: "sku", prefix: "INV" },
            { name: "price", type: "currency", min: 0, max: 1000 },
            { name: "status", type: "status", values: ["in_stock", "low_stock", "backorder"] },
            { name: "created_at", type: "date" }
          ]
        }
      ]
    };

    const first = await callTool("generate_mock_data_fixture", args, ctx);
    assert.equal(first.ok, true);
    assert.deepEqual(first.artifacts.sort(), ["fixtures/manifest.json", "fixtures/products.csv", "fixtures/products.json", "fixtures/warehouses.csv", "fixtures/warehouses.json"].sort());

    const products = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "fixtures/products.json")) as Array<{ warehouse_id: string; price: number; status: string }>;
    const warehouses = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "fixtures/warehouses.json")) as Array<{ id: string; name: string }>;
    const warehouseIds = new Set(warehouses.map((row) => row.id));
    assert.equal(products.length, 5);
    assert.equal(products.every((row) => warehouseIds.has(row.warehouse_id)), true);
    assert.equal(products[0].price, 0, "first numeric row includes an edge-case minimum");
    assert.equal(["in_stock", "low_stock", "backorder"].includes(products[0].status), true);

    const csv = await readProjectFile(ctx.projectRoot, project.id, "fixtures/products.csv");
    assert.match(csv, /^id,warehouse_id,sku,price,status,created_at\n/);
    assert.match(csv, /prd_0001/);

    const snapshot = await readProjectFile(ctx.projectRoot, project.id, "fixtures/products.json");
    const second = await callTool("generate_mock_data_fixture", args, ctx);
    assert.equal(second.ok, true);
    assert.equal(await readProjectFile(ctx.projectRoot, project.id, "fixtures/products.json"), snapshot);

    const manifest = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "fixtures/manifest.json")) as { seed: number; tables: Array<{ name: string; rowCount: number }> };
    assert.equal(manifest.seed, 777);
    assert.deepEqual(manifest.tables.map((table) => [table.name, table.rowCount]), [["warehouses", 3], ["products", 5]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generate_mock_data_fixture default admin schema produces related customer and order data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mock-data-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Admin demo", createdByClientId: "coder" });
    const result = await callTool("generate_mock_data_fixture", { projectId: project.id, seed: 42, formats: ["json"] }, ctx);
    assert.equal(result.ok, true);
    assert.ok(result.artifacts.includes("mock-data/customers.json"));
    assert.ok(result.artifacts.includes("mock-data/orders.json"));

    const customers = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "mock-data/customers.json")) as Array<{ id: string }>;
    const orders = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "mock-data/orders.json")) as Array<{ customer_id: string }>;
    const customerIds = new Set(customers.map((customer) => customer.id));
    assert.equal(customers.length, 25);
    assert.equal(orders.length, 60);
    assert.equal(orders.every((order) => customerIds.has(order.customer_id)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mock data generator is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("generate_mock_data_fixture"), `${skillId} exposes generate_mock_data_fixture`);
  }
});
