# Adding a New MCP Tool

This is a step-by-step, copy-pasteable guide for adding a brand-new tool to this MCP server.
It is written for someone touching the tool registry for the first time. Read it top to bottom
once; after that the numbered steps are a checklist.

For the operational side (how the change reaches ChatGPT without re-adding the connector) see
[`updating-tools.md`](./updating-tools.md). For the catalog of existing tools see
[`mcp-tools.md`](./mcp-tools.md).

## Mental model

A working tool is **four** pieces, and **all four are required** — miss one and the tool is
either invisible or un-callable, no matter how good the code is:

1. **`definition`** — the JSON-Schema that ChatGPT sees. Name, description, and `inputSchema`.
   This is the contract the model reads to decide how to call you.
2. **`schema`** — a parallel **zod** schema used for runtime validation inside the handler.
   The JSON-Schema describes the input; the zod schema *enforces* it on the way in.
3. **`handler`** — the function that does the work and returns the standard `ToolResult`.
4. **registration + skill exposure** — the tool module must be added to `allToolModules`
   (so the server knows it exists) **and** named in at least one *enabled* skill's `toolNames`
   (so the access gate will actually surface it). A tool that is registered but in no skill
   catalog can **never** appear in `tools/list` — and `npm run check:mcp` turns that into a
   build failure.

Why two schemas (#1 and #2)? They serve different consumers. The JSON-Schema in `definition`
is shipped to the model and to ChatGPT's UI; zod cannot be sent over the wire. The zod `schema`
runs in-process to parse/validate/coerce the actual input before your handler trusts it. They
describe the same shape but live in different worlds, so **you must keep them in sync by hand**
(see Gotchas).

The relevant types live in [`src/mcp/types.ts`](../src/mcp/types.ts):

```ts
export interface ToolModule {
  definition: ToolDefinition;                    // name + description + JSON-Schema inputSchema
  enabledByDefault: boolean;                      // is it on without an opt-in skill toggle?
  schema?: z.ZodType<unknown>;                    // zod schema used for runtime validation
  handler: (input: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
```

### What the handler receives: `ToolContext`

Every handler gets `(input, ctx)`. `ctx` is the `ToolContext` (from `src/mcp/types.ts`) — these
are the per-call roots and identifiers you should use instead of inventing your own paths:

| Field | Meaning |
| --- | --- |
| `projectRoot` | Root directory where MCP projects live. |
| `workspaceRoot` | Root for the active workspace (command/file tools resolve paths under this). |
| `artifactRoot` | Where generated artifacts should be written. |
| `shareRoot` | Where shareable/published output goes. |
| `feedbackRoot` | Root for feedback storage. |
| `commandTimeoutMs` | Default timeout (ms) for child-process/network work. |
| `publicBaseUrl` | Public base URL used to build outcome/preview links. |
| `contentBaseUrl?` | Optional separate base URL for served content. |
| `publicShareBasePath?` | Optional base path for public shares. |
| `clientId` | Identifier for the calling client. |
| `userId?` | Optional user identifier. |

## Worked example

We'll add a trivial read-only tool, `text_stats`, that counts characters/words/lines of an
input string. Read [`src/mcp/tools/preview.ts`](../src/mcp/tools/preview.ts) and
[`src/mcp/tools/public-api.ts`](../src/mcp/tools/public-api.ts) alongside this — they are the two
smallest real modules and show the exact shape.

### Step (a) — write the tool module

Create `src/mcp/tools/text-stats.ts`. Note the **dual-schema pattern**: a JSON-Schema literal in
`definition.inputSchema` *and* a parallel zod `schema`. Both describe `{ text: string }`.

```ts
import { z } from "zod";
import type { ToolModule, ToolContext } from "../types.js";

// (2) zod schema — runtime validation. `.strict()` rejects unknown keys, matching
// `additionalProperties: false` in the JSON-Schema below. Keep the two in sync.
const textStatsInputSchema = z
  .object({
    text: z.string().min(1).max(100000)
  })
  .strict();

export const textStatsTools: ToolModule[] = [
  {
    // (1) definition — the JSON-Schema ChatGPT sees.
    definition: {
      name: "text_stats",
      description: "Count characters, words, and lines in a string. Read-only, no I/O.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 100000, description: "Text to measure." }
        },
        required: ["text"],
        additionalProperties: false
      }
    },
    // (4a) on by default? read-only and safe, so yes. See step (d).
    enabledByDefault: true,
    // (2) the zod schema reference.
    schema: textStatsInputSchema,
    // (3) handler — does the work, returns the standard ToolResult.
    handler: (input: unknown, _ctx: ToolContext) => {
      const parsed = textStatsInputSchema.parse(input ?? {});
      const characters = parsed.text.length;
      const words = parsed.text.trim() === "" ? 0 : parsed.text.trim().split(/\s+/).length;
      const lines = parsed.text.split(/\r\n|\r|\n/).length;
      const structuredContent = { characters, words, lines };
      return {
        ok: true,
        summary: `${characters} chars, ${words} words, ${lines} lines.`,
        artifacts: [],
        structuredContent,
        logs: [JSON.stringify(structuredContent, null, 2)],
        errors: []
      };
    }
  }
];
```

Notes:
- **Always call `schema.parse(input)` first.** `input` is typed `unknown` and arrives untrusted.
  Parsing it is how the zod schema actually protects you; declaring the schema is not enough.
- Imports use the `.js` extension (e.g. `"../types.js"`) even though the file is `.ts` — this
  project compiles to ESM and that is the required style throughout.
- Export an **array** of modules (`textStatsTools: ToolModule[]`), even for a single tool. That
  matches how every other module is aggregated.

### Step (b) — register it in the tool index

The registry ([`src/mcp/registry.ts`](../src/mcp/registry.ts)) re-exports `allToolModules` from
[`src/mcp/tools/index.ts`](../src/mcp/tools/index.ts). Add your module there: an `import` at the
top and a spread in the `allToolModules` array.

```ts
// near the other imports in src/mcp/tools/index.ts
import { textStatsTools } from "./text-stats.js";

// inside the `export const allToolModules: ToolModule[] = [ ... ]` array
  ...textStatsTools,
```

`registry.ts` then aggregates and **enforces name uniqueness** — a duplicate name throws at
startup:

```ts
for (const tool of toolRegistry) {
  if (toolByName.has(tool.definition.name)) {
    throw new Error(`Duplicate MCP tool registration: ${tool.definition.name}`);
  }
  toolByName.set(tool.definition.name, tool);
}
```

You can look a tool up later with `getToolModule(name)` / `hasToolModule(name)`.

### Step (c) — expose it via a skill pack

Registration alone is **not** enough. The access gate only surfaces a tool if at least one
*enabled* skill lists its name in `toolNames`. Open [`src/skills/registry.ts`](../src/skills/registry.ts)
and add `"text_stats"` to the relevant skill(s):

- **`core`** — foundational / read-only tools available in the baseline path.
- **`coding`** — project build / edit / validate / publish work.
- **`debug`** — diagnostics and failure investigation.
- **`agent-integration-readonly`** — the read-only integration surface.
- **`high-risk`** — destructive actions; **disabled by default** (opt-in only).

For our read-only `text_stats`, `core` is the right home:

```ts
// inside the `core` skill's toolNames array in src/skills/registry.ts
"text_stats",
```

If a tool should appear for project work, add it to `coding` (and usually `debug`) too. For a
concrete multi-skill example, see how `public-api` tool names are spread into `coding`, `debug`,
and `agent-integration-readonly` via `...publicApiToolNames`.

### Step (d) — decide `enabledByDefault` vs high-risk-disabled

Pick using this rule of thumb:

- **Read-only / safe** (lookups, formatting, analysis that mutates nothing): `enabledByDefault: true`
  and list it in an enabled skill (`core` / `coding` / `debug`).
- **Destructive / dangerous** (deletes data, opens servers, runs lint/format that rewrites files):
  `enabledByDefault: false` and list it **only** in the `high-risk` skill (which is itself
  disabled by default, so the tool is opt-in twice over).

This is not advisory — `scripts/check-mcp-registry.mjs` hard-codes a `defaultDisabledTools`
list (e.g. `delete_project`, `create_share`, `open_local_server`, `run_lint`,
`run_format_write`, `diagnostic_bundle`) and **fails the build** if any of them is
`enabledByDefault: true`. If you add a destructive tool, keep it disabled.

### Step (e) — write a test

Tests live in `tests/*.test.ts` and use node's built-in test runner. The convention (see
[`tests/public-api-tools.test.ts`](../tests/public-api-tools.test.ts)) is: get the module via
`getToolModule`, or invoke through `callTool`, with a small `toolContext()` helper that supplies
the `ToolContext` roots. Create `tests/text-stats.test.ts`:

```ts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root = "/tmp/text-stats-test"): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "text-stats-test"
  };
}

test("text_stats is registered and exposed by the core skill", () => {
  assert.ok(getToolModule("text_stats"), "text_stats registered");
  const core = skillRegistry.find((s) => s.id === "core");
  assert.ok(core?.toolNames.includes("text_stats"), "core exposes text_stats");
});

test("text_stats counts characters, words, and lines", async () => {
  const result = await callTool("text_stats", { text: "hello world\nsecond line" }, toolContext());
  assert.equal(result.ok, true);
  const stats = result.structuredContent as { characters: number; words: number; lines: number };
  assert.equal(stats.words, 4);
  assert.equal(stats.lines, 2);
});

test("text_stats rejects unknown keys", async () => {
  const result = await callTool("text_stats", { text: "x", bogus: 1 }, toolContext());
  assert.equal(result.ok, false);
});
```

The last test is the one that catches **dual-schema drift**: `.strict()` on the zod schema makes
an unknown key fail, mirroring `additionalProperties: false` in the JSON-Schema.

### Step (f) — run the gates

Run all three before you consider the tool done:

```bash
npm run typecheck     # tsc --noEmit (server + admin-ui)
npm test              # runs typecheck, then `tsx --test tests/*.test.ts`
npm run check:mcp     # builds, then runs scripts/check-mcp-registry.mjs
```

`npm test` first runs `tsc --noEmit` and only then the node test files, so a type error fails the
test run early. `npm run check:mcp` does a full build then runs the registry guard. (There is also
`npm run check:tools`, which builds only the server before the same guard — handy for a faster
loop.)

## The result contract (`ToolResult`)

Every handler returns a `ToolResult` (from `src/mcp/types.ts`). Always set `ok`, `summary`,
`artifacts`, `logs`, and `errors` — the others are optional. Use a helper like `createJobResult`
(see `preview.ts`) when your tool produces an outcome link.

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `ok` | `boolean` | yes | Did the tool succeed? `false` signals failure to the caller. |
| `summary` | `string` | yes | One-line human-readable result; shown to the model/user. |
| `artifacts` | `string[]` | yes | Paths/URLs of files this call produced (use `[]` if none). |
| `logs` | `string[]` | yes | Diagnostic log lines (use `[]` if none). |
| `errors` | `string[]` | yes | Error messages; non-empty when `ok` is `false`. |
| `structuredContent` | `Record<string, unknown>` | no | Machine-readable result payload for the model. |
| `jobId` | `string` | no | Identifier for an async/long-running job. |
| `previewUrl` | `string` | no | Link to a rendered preview of the output. |
| `shareUrl` | `string` | no | Link to a shareable/published version. |

On the error path, set `ok: false`, put the message in `errors`, and still return a useful
`summary` (e.g. `` `${name} request failed: ${message}` ``). See the `catch` block in
`public-api.ts` for the canonical shape.

## Gotchas

- **Dual-schema drift.** The JSON-Schema in `definition.inputSchema` and the zod `schema` are two
  hand-maintained copies of the same shape. If you add a field to one and forget the other, the
  model and the validator disagree: the model may send a field the validator rejects, or send junk
  the validator silently drops. Use `.strict()` on the zod object and `additionalProperties: false`
  on the JSON-Schema, and add a test that an unknown key fails (step e).
- **Forgetting skill exposure.** A tool can be registered in `allToolModules` and still be
  **completely un-callable** because it is in no skill `toolNames`. The access gate returns
  `blocked_by_skill` and reconnecting the client does not help. `npm run check:mcp` makes this a
  build failure for `enabledByDefault` tools — but if you mark a tool `enabledByDefault: false`
  and never add it to a skill, it is just dead. Always do step (c).
- **High-risk tools must be disabled by default.** Anything destructive must be
  `enabledByDefault: false` and live only in the `high-risk` skill. `check-mcp-registry.mjs`
  enforces a `defaultDisabledTools` allow-list and the existence of a disabled `high-risk` skill;
  flipping one of those tools on fails the build.
- **Never write files with raw `fs` to arbitrary paths.** File writes must go through the project
  store / workspace path allow-listing, not bare `node:fs` against a caller-supplied path.
  Command/file tools resolve every path under `ctx.workspaceRoot` (or `ctx.projectRoot`) and
  **reject anything that escapes it** — see `safeResolveCwd` in
  [`src/mcp/tools/command.ts`](../src/mcp/tools/command.ts), which throws
  `Invalid cwd outside workspace` for out-of-root paths. Reuse the project/workspace write helpers
  (`write_project_file`, `write_file`, etc. and their underlying resolvers) so traversal
  (`../../etc/...`) is blocked for you. A tool that does `fs.writeFile(input.path, ...)` directly
  is a path-traversal hole.
- **Network calls go through `safeFetch`.** If your tool fetches a URL, use `safeFetch` from
  `src/security/url.js` (as `public-api.ts` does) — it blocks non-`https` URLs and private/reserved
  IPs and follows redirects safely. Do not call bare `fetch` on a caller-supplied URL.
- **Name format.** Tool names are lower_snake_case and must be unique across the whole registry;
  a collision throws at startup (see step b).

## Checklist

1. Write `src/mcp/tools/<your-tool>.ts` with `definition` + zod `schema` + `handler`, exported as a `ToolModule[]`.
2. Import and spread it into `allToolModules` in `src/mcp/tools/index.ts`.
3. Add the tool name to the right skill(s) in `src/skills/registry.ts`.
4. Set `enabledByDefault` correctly (destructive ⇒ `false` + `high-risk` only).
5. Add a test in `tests/<your-tool>.test.ts`.
6. Run `npm run typecheck`, `npm test`, and `npm run check:mcp` — all green.

Then follow [`updating-tools.md`](./updating-tools.md) to rebuild the server and open a new
ChatGPT conversation so the tool appears.
