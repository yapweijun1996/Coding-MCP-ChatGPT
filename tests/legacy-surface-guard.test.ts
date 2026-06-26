import assert from "node:assert/strict";
import test from "node:test";
// Importing the tool registry forces every tool module (workspace/command/git/…) to
// evaluate, which runs their legacyDelegatedTools(...) calls and populates the delegated set.
import { allToolModules } from "../src/mcp/tools/index.js";
import { getDelegatedLegacyToolNames } from "../src/mcp/tools/legacy-delegate.js";
import { toolDefinitions as legacyToolDefinitions } from "../src/mcp/legacy-tools.js";

void allToolModules; // referenced only for its import side effect (delegate registration)

// Institutionalizes the 2026-06 cleanup: legacy-tools.ts is a delegation-only module mid-
// migration to src/mcp/tools/. A definition that nobody delegates is dead weight — a second,
// drift-prone source of truth for a tool's contract. This guard fails the moment a dead
// definition is reintroduced, so the cleanup can't silently regress.
test("every legacy tool definition is actually delegated (no dead defs)", () => {
  const delegated = getDelegatedLegacyToolNames();
  const dead = legacyToolDefinitions.map((d) => d.name).filter((name) => !delegated.has(name));
  assert.deepEqual(
    dead,
    [],
    `Dead legacy tool definitions (declared in legacy-tools.ts but never delegated): ${dead.join(", ")}. ` +
      `Either delegate them from a tools/ module or delete the definition + its callTool handler.`
  );
});
