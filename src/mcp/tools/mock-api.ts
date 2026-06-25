import http, { type Server } from "node:http";
import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type MockRoute = z.infer<typeof mockRouteSchema>;
type MockApiConfig = z.infer<typeof mockApiConfigSchema>;

interface MockApiSession {
  projectId: string;
  server: Server;
  url: string;
  startedAt: string;
  configPath: string;
  requestCount: number;
}

const sessions = new Map<string, MockApiSession>();

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
]));

const paginationSchema = z.object({
  pageParam: z.string().min(1).max(40).default("page"),
  pageSizeParam: z.string().min(1).max(40).default("pageSize"),
  defaultPageSize: z.number().int().min(1).max(200).default(10),
  maxPageSize: z.number().int().min(1).max(500).default(100)
});

const searchSchema = z.object({
  queryParam: z.string().min(1).max(40).default("q"),
  fields: z.array(z.string().min(1).max(80)).min(1).max(20)
});

const stateSchema = z.object({
  stateParam: z.string().min(1).max(40).default("mockState"),
  errorStatus: z.number().int().min(400).max(599).default(500),
  errorBody: jsonValueSchema.default({ error: "Mock error" }),
  authExpiredStatus: z.number().int().min(400).max(499).default(401),
  authExpiredBody: jsonValueSchema.default({ error: "Session expired" }),
  slowDelayMs: z.number().int().min(0).max(30000).default(1500)
});

const mockRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
  path: z.string().min(1).max(160).regex(/^\/[A-Za-z0-9/_:.-]*$/, "path must start with / and contain URL-safe characters"),
  name: z.string().min(1).max(120).optional(),
  status: z.number().int().min(100).max(599).default(200),
  headers: z.record(z.string(), z.string()).default({}),
  delayMs: z.number().int().min(0).max(30000).default(0),
  body: jsonValueSchema.optional(),
  collection: z.array(z.record(z.string(), jsonValueSchema)).max(10000).optional(),
  pagination: paginationSchema.optional(),
  search: searchSchema.optional(),
  states: stateSchema.default({})
});

const mockApiConfigSchema = z.object({
  version: z.literal(1).default(1),
  routes: z.array(mockRouteSchema).min(1).max(200)
});

const createProjectMockApiInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  routes: z.array(mockRouteSchema).min(1).max(200).optional(),
  outputPath: z.string().min(1).max(240).default("mock-api/routes.json"),
  includeClientHelper: z.boolean().default(true),
  includeReadme: z.boolean().default(true)
});

const startProjectMockApiInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  configPath: z.string().min(1).max(240).default("mock-api/routes.json"),
  host: z.string().min(1).max(128).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(0),
  corsOrigin: z.string().min(1).max(240).default("*")
});

const stopProjectMockApiInputSchema = z.object({
  projectId: z.string().min(8).max(80)
});

function defaultRoutes(): MockRoute[] {
  return [
    {
      method: "GET",
      path: "/api/items",
      name: "Paginated demo items",
      status: 200,
      headers: {},
      delayMs: 0,
      collection: [
        { id: 1, name: "Alpha", status: "active" },
        { id: 2, name: "Beta", status: "pending" },
        { id: 3, name: "Gamma", status: "active" }
      ],
      pagination: { pageParam: "page", pageSizeParam: "pageSize", defaultPageSize: 10, maxPageSize: 100 },
      search: { queryParam: "q", fields: ["name", "status"] },
      states: { stateParam: "mockState", errorStatus: 500, errorBody: { error: "Mock error" }, authExpiredStatus: 401, authExpiredBody: { error: "Session expired" }, slowDelayMs: 1500 }
    }
  ];
}

function clientHelper(): string {
  return `export function mockApiUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function fetchMockJson(baseUrl, path, params = {}, init = {}) {
  const response = await fetch(mockApiUrl(baseUrl, path, params), {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error ?? \`Mock API request failed with \${response.status}\`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
`;
}

function readme(configPath: string): string {
  return `# Project Mock API

Start the mock API with \`start_project_mock_api\` and this config path:

\`\`\`json
{ "projectId": "PROJECT_ID", "configPath": "${configPath}" }
\`\`\`

Use query parameters to exercise frontend states:

- \`?mockState=empty\`: return an empty list for collection routes.
- \`?mockState=error\`: return the configured error status/body.
- \`?mockState=auth-expired\`: return the configured auth-expired status/body.
- \`?mockState=slow\`: apply the configured slow delay.
- \`?q=alpha&page=1&pageSize=10\`: search and paginate collection routes when configured.

The server sends permissive CORS headers by default so local frontend demos can fetch it safely without real keys or a backend deployment.
`;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string>, corsOrigin: string): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    ...headers
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function normalizeRoute(route: MockRoute): MockRoute {
  return mockRouteSchema.parse(route);
}

function applySearch(items: Array<Record<string, unknown>>, route: MockRoute, url: URL): Array<Record<string, unknown>> {
  if (!route.search) return items;
  const query = (url.searchParams.get(route.search.queryParam) ?? "").trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => route.search!.fields.some((field) => String(item[field] ?? "").toLowerCase().includes(query)));
}

function applyPagination(items: Array<Record<string, unknown>>, route: MockRoute, url: URL): unknown {
  if (!route.pagination) return items;
  const page = Math.max(1, Number.parseInt(url.searchParams.get(route.pagination.pageParam) ?? "1", 10) || 1);
  const requestedPageSize = Number.parseInt(url.searchParams.get(route.pagination.pageSizeParam) ?? String(route.pagination.defaultPageSize), 10) || route.pagination.defaultPageSize;
  const pageSize = Math.min(route.pagination.maxPageSize, Math.max(1, requestedPageSize));
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize))
  };
}

function routeBody(route: MockRoute, url: URL): unknown {
  const state = url.searchParams.get(route.states.stateParam);
  if (state === "empty" && route.collection) return route.pagination ? applyPagination([], route, url) : [];
  if (route.collection) return applyPagination(applySearch(route.collection, route, url), route, url);
  return route.body ?? {};
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleMockRequest(config: MockApiConfig, req: http.IncomingMessage, res: http.ServerResponse, corsOrigin: string): Promise<void> {
  if (req.method === "OPTIONS") {
    jsonResponse(res, 204, {}, {}, corsOrigin);
    return;
  }
  const url = new URL(req.url ?? "/", "http://mock.local");
  const route = config.routes.map(normalizeRoute).find((candidate) => candidate.method === req.method && candidate.path === url.pathname);
  if (!route) {
    jsonResponse(res, 404, { error: "Mock route not found", method: req.method, path: url.pathname }, {}, corsOrigin);
    return;
  }
  const state = url.searchParams.get(route.states.stateParam);
  const waitMs = state === "slow" ? Math.max(route.delayMs, route.states.slowDelayMs) : route.delayMs;
  if (waitMs > 0) await delay(waitMs);
  if (state === "error") {
    jsonResponse(res, route.states.errorStatus, route.states.errorBody, route.headers, corsOrigin);
    return;
  }
  if (state === "auth-expired") {
    jsonResponse(res, route.states.authExpiredStatus, route.states.authExpiredBody, route.headers, corsOrigin);
    return;
  }
  jsonResponse(res, route.status, routeBody(route, url), route.headers, corsOrigin);
}

async function listen(server: Server, host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve(`http://${host}:${actualPort}`);
    });
  });
}

export const mockApiTools: ToolModule[] = [
  {
    definition: {
      name: "create_project_mock_api",
      description: "Create project-scoped mock API route fixtures, optional frontend fetch helper, and README for API-driven frontend demos.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          routes: { type: "array", items: { type: "object" } },
          outputPath: { type: "string" },
          includeClientHelper: { type: "boolean" },
          includeReadme: { type: "boolean" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createProjectMockApiInputSchema,
    handler: async (input, ctx) => {
      const parsed = createProjectMockApiInputSchema.parse(input);
      await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const config: MockApiConfig = mockApiConfigSchema.parse({ version: 1, routes: parsed.routes?.length ? parsed.routes : defaultRoutes() });
      const artifacts = [];
      const routeFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(config, null, 2)}\n`);
      artifacts.push(routeFile.path);
      if (parsed.includeClientHelper) {
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, "mock-api/client.js", clientHelper())).path);
      }
      if (parsed.includeReadme) {
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, "mock-api/README.md", readme(parsed.outputPath))).path);
      }
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "create_project_mock_api", ok: true, summary: `Created ${config.routes.length} mock API route(s).`, details: { configPath: parsed.outputPath, routes: config.routes } });
      return { ok: true, summary: `Created ${config.routes.length} mock API route(s).`, jobId: parsed.projectId, artifacts, structuredContent: { projectId: parsed.projectId, configPath: parsed.outputPath, routes: config.routes, nextSteps: ["start_project_mock_api", "fetch generated local baseUrl from the frontend demo", "use mockState=empty|error|auth-expired|slow to test states"] }, logs: [JSON.stringify({ configPath: parsed.outputPath, routes: config.routes }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "start_project_mock_api",
      description: "Start a project-scoped local CORS mock API server from a mock-api/routes.json fixture.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          configPath: { type: "string" },
          host: { type: "string" },
          port: { type: "number" },
          corsOrigin: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: startProjectMockApiInputSchema,
    handler: async (input, ctx) => {
      const parsed = startProjectMockApiInputSchema.parse(input);
      const existing = sessions.get(parsed.projectId);
      if (existing) {
        return { ok: true, summary: `Mock API already running at ${existing.url}.`, jobId: parsed.projectId, previewUrl: existing.url, artifacts: [existing.url], structuredContent: { projectId: parsed.projectId, baseUrl: existing.url, configPath: existing.configPath, requestCount: existing.requestCount }, logs: [`Mock API already running at ${existing.url}.`], errors: [] };
      }
      const raw = await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.configPath, 2 * 1024 * 1024);
      const config = mockApiConfigSchema.parse(JSON.parse(raw));
      const server = http.createServer((req, res) => {
        const session = sessions.get(parsed.projectId);
        if (session) session.requestCount += 1;
        handleMockRequest(config, req, res, parsed.corsOrigin).catch((error) => {
          jsonResponse(res, 500, { error: error instanceof Error ? error.message : "Mock API failed" }, {}, parsed.corsOrigin);
        });
      });
      const url = await listen(server, parsed.host, parsed.port);
      const session: MockApiSession = { projectId: parsed.projectId, server, url, startedAt: new Date().toISOString(), configPath: parsed.configPath, requestCount: 0 };
      sessions.set(parsed.projectId, session);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "start_project_mock_api", ok: true, summary: `Started mock API at ${url}.`, details: { url, configPath: parsed.configPath, routeCount: config.routes.length } });
      return { ok: true, summary: `Started mock API at ${url}.`, jobId: parsed.projectId, previewUrl: url, artifacts: [url], structuredContent: { projectId: parsed.projectId, baseUrl: url, configPath: parsed.configPath, routes: config.routes.map((route) => ({ method: route.method, path: route.path, name: route.name })) }, logs: [`Mock API baseUrl: ${url}`, `Routes: ${config.routes.map((route) => `${route.method} ${route.path}`).join(", ")}`], errors: [] };
    }
  },
  {
    definition: {
      name: "stop_project_mock_api",
      description: "Stop a running project-scoped mock API server.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: stopProjectMockApiInputSchema,
    handler: async (input, ctx) => {
      const parsed = stopProjectMockApiInputSchema.parse(input);
      const session = sessions.get(parsed.projectId);
      if (!session) return { ok: false, summary: "No running mock API server for project.", jobId: parsed.projectId, artifacts: [], logs: [], errors: ["No running mock API server for project."] };
      await new Promise<void>((resolve, reject) => session.server.close((error) => error ? reject(error) : resolve()));
      sessions.delete(parsed.projectId);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "stop_project_mock_api", ok: true, summary: `Stopped mock API at ${session.url}.`, details: { url: session.url, requestCount: session.requestCount } });
      return { ok: true, summary: `Stopped mock API at ${session.url}.`, jobId: parsed.projectId, artifacts: [session.url], structuredContent: { projectId: parsed.projectId, baseUrl: session.url, requestCount: session.requestCount }, logs: [`Stopped mock API at ${session.url}.`, `Requests handled: ${session.requestCount}`], errors: [] };
    }
  }
];
