export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function asJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string") return undefined;
  const id = typeof record.id === "string" || typeof record.id === "number" || record.id === null || record.id === undefined ? record.id : null;
  return {
    jsonrpc: "2.0",
    id,
    method: record.method,
    params: record.params
  };
}
