import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolModule } from "../types.js";
import {
  ensureUnderWorkspace,
  sanitizeSecretLikeValue,
  trimLogLines,
  trimStructuredContent
} from "./agent-tool-utils.js";
import { safeFetch } from "../../security/url.js";

const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "::1"];

const healthcheckSchema = z.object({
  url: z.string().url({ message: "url must be a valid http(s) URL." }),
  method: z.enum(["GET", "HEAD", "POST"]).optional().default("GET"),
  headers: z.record(z.string(), z.string()).optional().default({}),
  body: z.string().optional(),
  expectStatus: z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599))]).optional(),
  timeoutMs: z.number().int().min(200).max(120000).optional().default(10000),
  maxBodyBytes: z.number().int().min(120).max(120000).optional().default(4000),
  allowlistedHosts: z.array(z.string().min(1).max(240)).optional().default([])
});

const openapiSchema = z.object({
  path: z.string().min(1).max(300),
  maxPaths: z.number().int().min(1).max(4000).optional().default(300)
});

const jsonContractSchema: z.ZodType<Record<string, unknown>> = z.lazy(() => z.object({
  type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]).optional(),
  required: z.array(z.string().min(1).max(160)).max(100).optional(),
  properties: z.record(z.string(), jsonContractSchema).optional(),
  items: jsonContractSchema.optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).optional()
}).passthrough());

const contractAssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json_path_exists"), path: z.string().min(1).max(240) }),
  z.object({ kind: z.literal("json_path_equals"), path: z.string().min(1).max(240), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({ kind: z.literal("json_path_type"), path: z.string().min(1).max(240), type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]) }),
  z.object({ kind: z.literal("header_exists"), name: z.string().min(1).max(160) }),
  z.object({ kind: z.literal("header_equals"), name: z.string().min(1).max(160), value: z.string().max(500) })
]);

const apiContractCaseSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200).optional(),
  url: z.string().url({ message: "url must be a valid http(s) URL." }),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET"),
  headers: z.record(z.string(), z.string()).optional().default({}),
  body: z.string().max(200000).optional(),
  expectStatus: z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599))]).optional(),
  expectJsonSchema: jsonContractSchema.optional(),
  assertions: z.array(contractAssertionSchema).max(80).optional().default([]),
  pagination: z.object({
    itemsPath: z.string().min(1).max(240),
    nextPath: z.string().min(1).max(240).optional(),
    minItems: z.number().int().min(0).max(10000).optional().default(0)
  }).optional()
});

const apiContractTestSchema = z.object({
  cases: z.array(apiContractCaseSchema).min(1).max(30),
  allowlistedHosts: z.array(z.string().min(1).max(240)).optional().default([]),
  timeoutMs: z.number().int().min(200).max(120000).optional().default(10000),
  compareMockToReal: z.object({
    mockBaseUrl: z.string().url(),
    realBaseUrl: z.string().url(),
    ignorePaths: z.array(z.string().min(1).max(240)).max(80).optional().default([])
  }).optional(),
  maxBodyBytes: z.number().int().min(120).max(250000).optional().default(120000)
});

function isAllowlistedHost(parsedUrl: string, allowlistedHosts: string[]): boolean {
  const parsed = new URL(parsedUrl);
  const host = parsed.hostname.toLowerCase();
  const defaultPass = DEFAULT_HOSTS.includes(host) || parsed.host === "::1";
  if (defaultPass) return true;

  for (const entry of allowlistedHosts) {
    const candidate = entry.toLowerCase().trim();
    if (!candidate) continue;
    if (candidate === "localhost" || candidate === "127.0.0.1") {
      if (host === "localhost" || host === "127.0.0.1") return true;
      continue;
    }
    if (candidate.startsWith("*.") && host.endsWith(candidate.slice(2))) {
      return true;
    }
    if (host === candidate || host.endsWith(`.${candidate}`)) {
      return true;
    }
  }
  return false;
}

function parseIntToArray(value?: number | number[]) {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [value];
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function readJsonPath(root: unknown, expression: string): { found: boolean; value?: unknown } {
  const normalized = expression.trim().replace(/^\$\.?/, "");
  if (!normalized) return { found: true, value: root };
  const parts = normalized.split(".").flatMap((part) => {
    const segments: string[] = [];
    const re = /([^\[\]]+)|\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(part))) segments.push(match[1] ?? match[2]);
    return segments;
  }).filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      const index = Number(part);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

function validateJsonContract(value: unknown, schema: Record<string, unknown>, pathExpression = "$"): string[] {
  const errors: string[] = [];
  const expectedType = typeof schema.type === "string" ? schema.type : undefined;
  if (expectedType) {
    const actual = jsonTypeOf(value);
    const ok = expectedType === "number" ? actual === "number" || actual === "integer" : actual === expectedType;
    if (!ok) return [`${pathExpression} expected ${expectedType}, got ${actual}`];
  }
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${pathExpression} expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (schema.required && Array.isArray(schema.required)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${pathExpression} expected object with required fields`);
    } else {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) errors.push(`${pathExpression}.${key} is required`);
      }
    }
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, childSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (key in value && childSchema && typeof childSchema === "object") {
        errors.push(...validateJsonContract((value as Record<string, unknown>)[key], childSchema as Record<string, unknown>, `${pathExpression}.${key}`));
      }
    }
  }
  if (schema.items && typeof schema.items === "object" && Array.isArray(value)) {
    value.slice(0, 50).forEach((item, index) => {
      errors.push(...validateJsonContract(item, schema.items as Record<string, unknown>, `${pathExpression}[${index}]`));
    });
  }
  return errors;
}

async function runContractCase(testCase: z.infer<typeof apiContractCaseSchema>, options: z.infer<typeof apiContractTestSchema>, urlOverride?: string): Promise<Record<string, unknown>> {
  const url = urlOverride ?? testCase.url;
  if (!isAllowlistedHost(url, options.allowlistedHosts)) {
    return { id: testCase.id, ok: false, url, method: testCase.method, errors: ["Host not in allowlist"] };
  }
  const expectedStatuses = parseIntToArray(testCase.expectStatus) ?? [200, 201, 204];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const startAt = Date.now();
  try {
    const response = await safeFetch(url, {
      method: testCase.method,
      headers: {
        "Content-Type": "application/json",
        ...testCase.headers
      },
      body: ["POST", "PUT", "PATCH", "DELETE"].includes(testCase.method) ? testCase.body : undefined,
      signal: controller.signal
    }, { protocols: ["http:", "https:"], allowPrivateNetwork: true });
    const elapsedMs = Date.now() - startAt;
    const rawBody = testCase.method === "HEAD" ? "" : (await response.text()).slice(0, options.maxBodyBytes);
    let json: unknown;
    let jsonParseError: string | undefined;
    if (rawBody.trim()) {
      try {
        json = JSON.parse(rawBody);
      } catch (error) {
        jsonParseError = error instanceof Error ? error.message : "Invalid JSON response.";
      }
    }
    const errors: string[] = [];
    if (!expectedStatuses.includes(response.status)) errors.push(`Expected status ${expectedStatuses.join(",")}, got ${response.status}`);
    if (testCase.expectJsonSchema) {
      if (jsonParseError) errors.push(`Response is not valid JSON: ${jsonParseError}`);
      else errors.push(...validateJsonContract(json, testCase.expectJsonSchema));
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    for (const assertion of testCase.assertions) {
      switch (assertion.kind) {
        case "header_exists":
          if (!(assertion.name.toLowerCase() in headers)) errors.push(`Missing header ${assertion.name}`);
          break;
        case "header_equals":
          if (headers[assertion.name.toLowerCase()] !== assertion.value) errors.push(`Header ${assertion.name} expected ${assertion.value}, got ${headers[assertion.name.toLowerCase()] ?? "(missing)"}`);
          break;
        case "json_path_exists": {
          if (jsonParseError) {
            errors.push(`Cannot evaluate ${assertion.path}: response is not JSON`);
            break;
          }
          const target = readJsonPath(json, assertion.path);
          if (!target.found) errors.push(`Missing JSON path ${assertion.path}`);
          break;
        }
        case "json_path_equals": {
          if (jsonParseError) {
            errors.push(`Cannot evaluate ${assertion.path}: response is not JSON`);
            break;
          }
          const target = readJsonPath(json, assertion.path);
          if (!target.found || !Object.is(target.value, assertion.value)) errors.push(`JSON path ${assertion.path} expected ${JSON.stringify(assertion.value)}, got ${JSON.stringify(target.value)}`);
          break;
        }
        case "json_path_type": {
          if (jsonParseError) {
            errors.push(`Cannot evaluate ${assertion.path}: response is not JSON`);
            break;
          }
          const target = readJsonPath(json, assertion.path);
          if (!target.found || (assertion.type === "number" ? !["number", "integer"].includes(jsonTypeOf(target.value)) : jsonTypeOf(target.value) !== assertion.type)) errors.push(`JSON path ${assertion.path} expected type ${assertion.type}, got ${target.found ? jsonTypeOf(target.value) : "(missing)"}`);
          break;
        }
      }
    }
    if (testCase.pagination) {
      const items = readJsonPath(json, testCase.pagination.itemsPath);
      if (!items.found || !Array.isArray(items.value)) errors.push(`Pagination itemsPath ${testCase.pagination.itemsPath} is not an array`);
      else if (items.value.length < testCase.pagination.minItems) errors.push(`Pagination expected at least ${testCase.pagination.minItems} item(s), got ${items.value.length}`);
      if (testCase.pagination.nextPath) {
        const next = readJsonPath(json, testCase.pagination.nextPath);
        if (!next.found) errors.push(`Pagination nextPath ${testCase.pagination.nextPath} is missing`);
      }
    }
    return sanitizeSecretLikeValue({
      id: testCase.id,
      name: testCase.name,
      ok: errors.length === 0,
      url,
      method: testCase.method,
      status: response.status,
      elapsedMs,
      expectedStatuses,
      bodyJsonValid: !jsonParseError,
      bodyPreview: rawBody.slice(0, 2000),
      errors
    }) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error.";
    return { id: testCase.id, ok: false, url, method: testCase.method, elapsedMs: Date.now() - startAt, errors: [message] };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeOpenapi(payload: Record<string, unknown>) {
  const paths = (payload.paths && typeof payload.paths === "object" && !Array.isArray(payload.paths))
    ? payload.paths as Record<string, unknown>
    : {};
  const methods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
  const endpoints: Array<Record<string, unknown>> = [];
  const tagDistribution: Record<string, number> = {};

  for (const [route, definition] of Object.entries(paths)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    const byMethod = definition as Record<string, unknown>;
    for (const method of methods) {
      const operation = byMethod[method];
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
      const operationNode = operation as Record<string, unknown>;
      const tags = Array.isArray(operationNode.tags)
        ? operationNode.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      tags.forEach((tag) => {
        tagDistribution[tag] = (tagDistribution[tag] ?? 0) + 1;
      });

      const requestBody = operationNode.requestBody && typeof operationNode.requestBody === "object"
        ? operationNode.requestBody as Record<string, unknown>
        : undefined;
      const responses = operationNode.responses && typeof operationNode.responses === "object"
        ? operationNode.responses as Record<string, unknown>
        : undefined;
      const requestSchemas = requestBody && typeof requestBody.content === "object"
        ? Object.keys(requestBody.content as Record<string, unknown>)
        : [];

      endpoints.push({
        path: route,
        method: method.toUpperCase(),
        operationId: typeof operationNode.operationId === "string" ? operationNode.operationId : undefined,
        summary: typeof operationNode.summary === "string" ? operationNode.summary : undefined,
        description: typeof operationNode.description === "string" ? operationNode.description : undefined,
        tags,
        requestSchemas,
        responseCount: responses ? Object.keys(responses).length : 0,
        security: operationNode.security
      });
    }
  }

  return {
    title: typeof (payload.info as Record<string, unknown>)?.title === "string" ? String((payload.info as Record<string, unknown>).title) : undefined,
    version: typeof (payload.info as Record<string, unknown>)?.version === "string" ? String((payload.info as Record<string, unknown>).version) : undefined,
    servers: payload.servers,
    pathCount: Object.keys(paths).length,
    endpointCount: endpoints.length,
    tagDistribution,
    endpointList: endpoints
  };
}

export const integrationReadonlyTools: ToolModule[] = [
  {
    definition: {
      name: "api_healthcheck",
      description: "Readonly HTTP healthcheck for allowlisted local endpoints with status, headers, body preview, latency and classification.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "HEAD", "POST"] },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
          expectStatus: {
            anyOf: [
              { type: "number", minimum: 100, maximum: 599 },
              { type: "array", items: { type: "number", minimum: 100, maximum: 599 } }
            ]
          },
          timeoutMs: { type: "number" },
          maxBodyBytes: { type: "number" },
          allowlistedHosts: { type: "array", items: { type: "string" } }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: healthcheckSchema,
    handler: async (input) => {
      const parsed = input as z.infer<typeof healthcheckSchema>;
      const startAt = Date.now();
      const parsedUrl = new URL(parsed.url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return {
          ok: false,
          summary: "Invalid URL protocol.",
          artifacts: [],
          logs: ["Protocol must be http or https."],
          structuredContent: trimStructuredContent({ url: parsed.url, error: "Invalid protocol" }),
          errors: ["Disallowed protocol in api_healthcheck."]
        };
      }

      if (!isAllowlistedHost(parsed.url, parsed.allowlistedHosts)) {
        return {
          ok: false,
          summary: "Target host is not allowlisted for api_healthcheck.",
          artifacts: [],
          logs: ["Host allowlist check failed.", `url=${parsed.url}`],
          structuredContent: trimStructuredContent({ url: parsed.url, allowlistedHosts: [...DEFAULT_HOSTS, ...parsed.allowlistedHosts] }),
          errors: ["Host not in allowlist"]
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), parsed.timeoutMs);
      const expected = parseIntToArray(parsed.expectStatus);

      try {
        // safeFetch re-validates every redirect hop so an allowlisted host cannot
        // 30x-redirect the request into a private/internal address (SSRF).
        const response = await safeFetch(parsed.url, {
          method: parsed.method,
          headers: {
            "Content-Type": "application/json",
            ...parsed.headers
          },
          body: parsed.method === "POST" ? parsed.body : undefined,
          signal: controller.signal
        }, { protocols: ["http:", "https:"] });

        const elapsedMs = Date.now() - startAt;
        const rawBody = parsed.method === "HEAD" ? "" : await response.text();
        const bodyPreview = rawBody.slice(0, parsed.maxBodyBytes);
        let bodyJsonValid = false;
        if (bodyPreview && bodyPreview.trim()) {
          try {
            JSON.parse(bodyPreview);
            bodyJsonValid = true;
          } catch {
            bodyJsonValid = false;
          }
        }

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        const expectedStatuses = expected ?? [200, 201, 204, 301, 302, 307, 308];
        const okStatus = expectedStatuses.includes(response.status);

        const result = {
          url: parsed.url,
          method: parsed.method,
          status: response.status,
          statusText: response.statusText,
          finalUrl: response.url,
          redirected: response.redirected,
          elapsedMs,
          expectedStatuses,
          okStatus,
          headers,
          bodyPreview,
          bodyJsonValid
        };

        return {
          ok: okStatus,
          summary: okStatus ? `api_healthcheck success: ${response.status}` : `api_healthcheck returned ${response.status}`,
          artifacts: [],
          logs: trimLogLines([`url=${parsed.url}`, `status=${response.status}`, `elapsedMs=${elapsedMs}`, `redirected=${response.redirected}`]),
          structuredContent: trimStructuredContent(sanitizeSecretLikeValue(result) as Record<string, unknown>),
          errors: okStatus ? [] : ["Status outside expected status list."]
        };
      } catch (error) {
        const reason = error instanceof Error ? error.name : "Error";
        const message = error instanceof Error ? error.message : "Unknown network error.";
        const isTimeout = message.includes("aborted") || message.includes("timeout") || reason === "AbortError";
        return {
          ok: false,
          summary: isTimeout ? `api_healthcheck timed out after ${parsed.timeoutMs}ms.` : "api_healthcheck failed.",
          artifacts: [],
          logs: trimLogLines([`url=${parsed.url}`, `error=${reason}: ${message}`]),
          structuredContent: trimStructuredContent({
            url: parsed.url,
            method: parsed.method,
            error: message,
            errorType: reason,
            timedOut: isTimeout,
            elapsedMs: Date.now() - startAt
          }),
          errors: [message]
        };
      } finally {
        clearTimeout(timer);
      }
    }
  },
  {
    definition: {
      name: "api_contract_test",
      description: "Run readonly API contract tests for request/response shape, status handling, JSON schema/path assertions, pagination, and optional mock-vs-real comparison.",
      inputSchema: {
        type: "object",
        properties: {
          cases: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                url: { type: "string" },
                method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
                headers: { type: "object", additionalProperties: { type: "string" } },
                body: { type: "string" },
                expectStatus: {
                  anyOf: [
                    { type: "number", minimum: 100, maximum: 599 },
                    { type: "array", items: { type: "number", minimum: 100, maximum: 599 } }
                  ]
                },
                expectJsonSchema: { type: "object" },
                assertions: { type: "array", items: { type: "object" } },
                pagination: { type: "object" }
              },
              required: ["id", "url"],
              additionalProperties: false
            }
          },
          allowlistedHosts: { type: "array", items: { type: "string" } },
          timeoutMs: { type: "number" },
          compareMockToReal: {
            type: "object",
            properties: {
              mockBaseUrl: { type: "string" },
              realBaseUrl: { type: "string" },
              ignorePaths: { type: "array", items: { type: "string" } }
            },
            required: ["mockBaseUrl", "realBaseUrl"],
            additionalProperties: false
          },
          maxBodyBytes: { type: "number" }
        },
        required: ["cases"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: apiContractTestSchema,
    handler: async (input) => {
      const parsed = apiContractTestSchema.parse(input);
      const caseResults = [];
      for (const testCase of parsed.cases) caseResults.push(await runContractCase(testCase, parsed));

      const comparisons: Array<Record<string, unknown>> = [];
      if (parsed.compareMockToReal) {
        const mockBase = parsed.compareMockToReal.mockBaseUrl.replace(/\/$/, "");
        const realBase = parsed.compareMockToReal.realBaseUrl.replace(/\/$/, "");
        for (const testCase of parsed.cases) {
          const caseUrl = new URL(testCase.url);
          const pathWithQuery = `${caseUrl.pathname}${caseUrl.search}`;
          const mockResult = await runContractCase(testCase, parsed, `${mockBase}${pathWithQuery}`);
          const realResult = await runContractCase(testCase, parsed, `${realBase}${pathWithQuery}`);
          const mockComparable = JSON.stringify({ status: mockResult.status, ok: mockResult.ok, errors: mockResult.errors });
          const realComparable = JSON.stringify({ status: realResult.status, ok: realResult.ok, errors: realResult.errors });
          comparisons.push({
            id: testCase.id,
            ok: mockComparable === realComparable,
            mock: mockResult,
            real: realResult,
            errors: mockComparable === realComparable ? [] : ["Mock and real contract outcomes differ."]
          });
        }
      }

      const failures = [
        ...caseResults.flatMap((result) => (result.errors as string[] | undefined ?? []).map((error) => `${result.id}: ${error}`)),
        ...comparisons.flatMap((result) => (result.errors as string[] | undefined ?? []).map((error) => `${result.id}: ${error}`))
      ];
      const report = {
        ok: failures.length === 0,
        caseCount: parsed.cases.length,
        passed: caseResults.filter((result) => result.ok).length,
        failed: caseResults.filter((result) => !result.ok).length,
        caseResults,
        comparisons,
        failures
      };
      return {
        ok: report.ok,
        summary: report.ok ? `api_contract_test passed ${report.passed}/${report.caseCount} case(s).` : `api_contract_test found ${failures.length} contract failure(s).`,
        artifacts: [],
        logs: trimLogLines([`cases=${report.caseCount}`, `passed=${report.passed}`, `failed=${report.failed}`, ...failures.slice(0, 20)]),
        structuredContent: trimStructuredContent(report),
        errors: failures
      };
    }
  },
  {
    definition: {
      name: "openapi_summary",
      description: "Summarize OpenAPI paths/methods/schemas and tag/security distribution for API docs review.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxPaths: { type: "number" }
        },
        required: ["path"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: openapiSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof openapiSchema>;
      const absolute = ensureUnderWorkspace(ctx.workspaceRoot, parsed.path);
      const ext = path.extname(absolute).toLowerCase();
      const raw = await fs.readFile(absolute, "utf8").catch(() => undefined);
      if (!raw) {
        return {
          ok: false,
          summary: `Cannot read OpenAPI file ${parsed.path}.`,
          artifacts: [],
          logs: ["read_failed"],
          structuredContent: trimStructuredContent({ path: parsed.path }),
          errors: ["OpenAPI file is unreadable or missing."]
        };
      }

      let payload: Record<string, unknown>;
      if (ext === ".yml" || ext === ".yaml") {
        try {
          const yaml = await import("yaml");
          payload = yaml.parse(raw) as Record<string, unknown>;
        } catch {
          return {
            ok: false,
            summary: "Failed to parse YAML OpenAPI file.",
            artifacts: [],
            logs: ["yaml_parse_failed"],
            structuredContent: trimStructuredContent({ path: parsed.path }),
            errors: ["Install yaml dependency or use JSON OpenAPI input."]
          };
        }
      } else {
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {
            ok: false,
            summary: "Failed to parse OpenAPI JSON.",
            artifacts: [],
            logs: ["json_parse_failed"],
            structuredContent: trimStructuredContent({ path: parsed.path }),
            errors: ["openapi file is not valid JSON"]
          };
        }
      }

      const summary = summarizeOpenapi(payload);
      const limited = {
        ...summary,
        endpointList: (summary.endpointList ?? []).slice(0, parsed.maxPaths)
      };

      return {
        ok: true,
        summary: `openapi_summary extracted ${limited.endpointList.length} endpoint(s).`,
        artifacts: [],
        logs: trimLogLines([`paths=${limited.pathCount}`, `endpoints=${limited.endpointCount}`]),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue(limited) as Record<string, unknown>),
        errors: []
      };
    }
  }
];
