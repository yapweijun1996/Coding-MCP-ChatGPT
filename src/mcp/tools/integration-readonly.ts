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
