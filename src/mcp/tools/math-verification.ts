import { z } from "zod";
import { writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type Token = { type: "number" | "identifier" | "operator" | "paren" | "comma"; value: string };
type Expr =
  | { type: "number"; value: number }
  | { type: "variable"; name: string }
  | { type: "unary"; op: "+" | "-"; expr: Expr }
  | { type: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: Expr; right: Expr }
  | { type: "call"; name: string; args: Expr[] };

const variableRangeSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  min: z.number().finite().default(-10),
  max: z.number().finite().default(10),
  samples: z.number().int().min(2).max(41).default(9)
}).refine((input) => input.max > input.min, { message: "max must be greater than min." });

const verifyNumericClaimInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  expression: z.string().min(1).max(2000),
  expected: z.number().finite(),
  variables: z.record(z.string(), z.number().finite()).optional().default({}),
  tolerance: z.number().positive().max(1).default(1e-9),
  outputPath: z.string().min(1).max(240).default("math-verification/numeric-claim.json"),
  writeToProject: z.boolean().default(false)
});

const searchCounterexampleInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  statement: z.string().min(1).max(2000),
  variables: z.array(variableRangeSchema).min(1).max(5),
  tolerance: z.number().positive().max(1).default(1e-9),
  maxChecks: z.number().int().min(1).max(20000).default(5000),
  outputPath: z.string().min(1).max(240).default("math-verification/counterexample-search.json"),
  writeToProject: z.boolean().default(false)
});

const solveEquationInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  equation: z.string().min(1).max(2000),
  variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  min: z.number().finite(),
  max: z.number().finite(),
  fixedVariables: z.record(z.string(), z.number().finite()).optional().default({}),
  tolerance: z.number().positive().max(1).default(1e-9),
  maxIterations: z.number().int().min(10).max(200).default(80),
  outputPath: z.string().min(1).max(240).default("math-verification/equation-solve.json"),
  writeToProject: z.boolean().default(false)
}).refine((input) => input.max > input.min, { message: "max must be greater than min." });

const verifyDerivationInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  steps: z.array(z.string().min(1).max(2000)).min(2).max(50),
  variables: z.array(variableRangeSchema).max(5).optional().default([]),
  tolerance: z.number().positive().max(1).default(1e-8),
  samplesPerVariable: z.number().int().min(2).max(21).default(7),
  outputPath: z.string().min(1).max(240).default("math-verification/derivation-check.json"),
  writeToProject: z.boolean().default(false)
});

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  ln: Math.log,
  log: Math.log10,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  round: Math.round,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const number = input.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (number) {
      tokens.push({ type: "number", value: number[0] });
      index += number[0].length;
      continue;
    }
    const identifier = input.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    if ("+-*/^".includes(char)) tokens.push({ type: "operator", value: char });
    else if ("()".includes(char)) tokens.push({ type: "paren", value: char });
    else if (char === ",") tokens.push({ type: "comma", value: char });
    else throw new Error(`Unsupported character in expression: ${char}`);
    index += 1;
  }
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expr = this.parseAddSub();
    if (this.peek()) throw new Error(`Unexpected token: ${this.peek()?.value}`);
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private consume(value?: string): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error("Unexpected end of expression.");
    if (value && token.value !== value) throw new Error(`Expected ${value}, got ${token.value}.`);
    this.index += 1;
    return token;
  }

  private parseAddSub(): Expr {
    let expr = this.parseMulDiv();
    while (this.peek()?.value === "+" || this.peek()?.value === "-") {
      const op = this.consume().value as "+" | "-";
      expr = { type: "binary", op, left: expr, right: this.parseMulDiv() };
    }
    return expr;
  }

  private parseMulDiv(): Expr {
    let expr = this.parsePower();
    while (this.peek()?.value === "*" || this.peek()?.value === "/") {
      const op = this.consume().value as "*" | "/";
      expr = { type: "binary", op, left: expr, right: this.parsePower() };
    }
    return expr;
  }

  private parsePower(): Expr {
    let expr = this.parseUnary();
    if (this.peek()?.value === "^") {
      this.consume("^");
      expr = { type: "binary", op: "^", left: expr, right: this.parsePower() };
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.peek()?.value === "+" || this.peek()?.value === "-") {
      const op = this.consume().value as "+" | "-";
      return { type: "unary", op, expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.consume();
    if (token.type === "number") return { type: "number", value: Number(token.value) };
    if (token.type === "identifier") {
      if (this.peek()?.value !== "(") return { type: "variable", name: token.value };
      this.consume("(");
      const args: Expr[] = [];
      if (this.peek()?.value !== ")") {
        do {
          args.push(this.parseAddSub());
          if (this.peek()?.value !== ",") break;
          this.consume(",");
        } while (true);
      }
      this.consume(")");
      return { type: "call", name: token.value.toLowerCase(), args };
    }
    if (token.value === "(") {
      const expr = this.parseAddSub();
      this.consume(")");
      return expr;
    }
    throw new Error(`Unexpected token: ${token.value}`);
  }
}

function parseExpression(input: string): Expr {
  return new Parser(tokenize(input)).parse();
}

function evaluate(expr: Expr, variables: Record<string, number>): number {
  switch (expr.type) {
    case "number":
      return expr.value;
    case "variable": {
      if (expr.name === "pi") return Math.PI;
      if (expr.name === "e") return Math.E;
      const value = variables[expr.name];
      if (value === undefined) throw new Error(`Missing variable: ${expr.name}`);
      return value;
    }
    case "unary": {
      const value = evaluate(expr.expr, variables);
      return expr.op === "-" ? -value : value;
    }
    case "binary": {
      const left = evaluate(expr.left, variables);
      const right = evaluate(expr.right, variables);
      if (expr.op === "+") return left + right;
      if (expr.op === "-") return left - right;
      if (expr.op === "*") return left * right;
      if (expr.op === "/") return left / right;
      return left ** right;
    }
    case "call": {
      const fn = FUNCTIONS[expr.name];
      if (!fn) throw new Error(`Unsupported function: ${expr.name}`);
      return fn(...expr.args.map((arg) => evaluate(arg, variables)));
    }
  }
}

function evalExpression(input: string, variables: Record<string, number>): number {
  const value = evaluate(parseExpression(input), variables);
  if (!Number.isFinite(value)) throw new Error(`Expression produced a non-finite value: ${value}`);
  return value;
}

function splitComparison(input: string): { left: string; op: string; right: string } | undefined {
  const operators = ["<=", ">=", "==", "!=", "=", "<", ">"];
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth !== 0) continue;
    for (const op of operators) {
      if (input.slice(index, index + op.length) === op) {
        return { left: input.slice(0, index).trim(), op, right: input.slice(index + op.length).trim() };
      }
    }
  }
  return undefined;
}

function residual(statement: string, variables: Record<string, number>): { left: number; right: number; difference: number; op: string } {
  const comparison = splitComparison(statement);
  if (!comparison) {
    const value = evalExpression(statement, variables);
    return { left: value, right: 0, difference: value, op: "=" };
  }
  const left = evalExpression(comparison.left, variables);
  const right = evalExpression(comparison.right, variables);
  return { left, right, difference: left - right, op: comparison.op };
}

function comparisonPass(result: { left: number; right: number; difference: number; op: string }, tolerance: number): boolean {
  if (result.op === "=" || result.op === "==") return Math.abs(result.difference) <= tolerance;
  if (result.op === "!=") return Math.abs(result.difference) > tolerance;
  if (result.op === "<") return result.left < result.right || Math.abs(result.difference) <= tolerance;
  if (result.op === "<=") return result.left <= result.right || Math.abs(result.difference) <= tolerance;
  if (result.op === ">") return result.left > result.right || Math.abs(result.difference) <= tolerance;
  if (result.op === ">=") return result.left >= result.right || Math.abs(result.difference) <= tolerance;
  return false;
}

function sampleValues(min: number, max: number, samples: number): number[] {
  if (samples === 1) return [(min + max) / 2];
  return Array.from({ length: samples }, (_, index) => min + ((max - min) * index) / (samples - 1));
}

function sampleAssignments(ranges: Array<z.infer<typeof variableRangeSchema>>, maxChecks: number): Record<string, number>[] {
  const output: Record<string, number>[] = [];
  const values = ranges.map((range) => sampleValues(range.min, range.max, range.samples));
  function visit(index: number, current: Record<string, number>) {
    if (output.length >= maxChecks) return;
    if (index === ranges.length) {
      output.push({ ...current });
      return;
    }
    for (const value of values[index]) {
      current[ranges[index].name] = value;
      visit(index + 1, current);
      if (output.length >= maxChecks) return;
    }
  }
  visit(0, {});
  return output;
}

function inferVariables(texts: string[]): string[] {
  const names = new Set<string>();
  const reserved = new Set([...Object.keys(FUNCTIONS), "pi", "e"]);
  for (const text of texts) {
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (!reserved.has(match[0].toLowerCase())) names.add(match[0]);
    }
  }
  return [...names].slice(0, 5);
}

function round(value: number, digits = 12): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function maybeWrite(ctxProjectRoot: string, projectId: string | undefined, shouldWrite: boolean, outputPath: string, report: unknown): Promise<string[]> {
  if (!projectId || !shouldWrite) return [];
  const written = await writeProjectFile(ctxProjectRoot, projectId, outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return [written.path];
}

export const mathVerificationTools: ToolModule[] = [
  {
    definition: {
      name: "verify_numeric_claim",
      description: "Evaluate a bounded math expression with supplied variables and compare it to an expected numeric value using a tolerance. No eval or arbitrary code execution.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          expression: { type: "string" },
          expected: { type: "number" },
          variables: { type: "object" },
          tolerance: { type: "number" },
          writeToProject: { type: "boolean" },
          outputPath: { type: "string" }
        },
        required: ["expression", "expected"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: verifyNumericClaimInputSchema,
    handler: async (input, ctx) => {
      const parsed = verifyNumericClaimInputSchema.parse(input);
      const actual = evalExpression(parsed.expression, parsed.variables);
      const error = actual - parsed.expected;
      const report = {
        status: Math.abs(error) <= parsed.tolerance ? "passed" : "failed",
        expression: parsed.expression,
        variables: parsed.variables,
        expected: parsed.expected,
        actual: round(actual),
        error: round(error),
        tolerance: parsed.tolerance,
        caveats: ["Numeric verification only; symbolic equivalence is not proven by this tool."]
      };
      const artifacts = await maybeWrite(ctx.projectRoot, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: report.status === "passed", summary: `Numeric claim ${report.status}: ${parsed.expression} = ${report.actual}.`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: report.status === "passed" ? [] : [`Expected ${parsed.expected}, got ${actual}.`] };
    }
  },
  {
    definition: {
      name: "search_math_counterexample",
      description: "Search a bounded deterministic sample grid for a counterexample to an equation or inequality statement.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          statement: { type: "string" },
          variables: { type: "array", items: { type: "object" } },
          tolerance: { type: "number" },
          maxChecks: { type: "number" },
          writeToProject: { type: "boolean" },
          outputPath: { type: "string" }
        },
        required: ["statement", "variables"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: searchCounterexampleInputSchema,
    handler: async (input, ctx) => {
      const parsed = searchCounterexampleInputSchema.parse(input);
      const assignments = sampleAssignments(parsed.variables, parsed.maxChecks);
      let counterexample: Record<string, unknown> | undefined;
      let checked = 0;
      for (const variables of assignments) {
        checked += 1;
        try {
          const result = residual(parsed.statement, variables);
          if (!comparisonPass(result, parsed.tolerance)) {
            counterexample = { variables, left: round(result.left), right: round(result.right), difference: round(result.difference), op: result.op };
            break;
          }
        } catch {
          continue;
        }
      }
      const report = {
        status: counterexample ? "counterexample_found" : "no_counterexample_found",
        statement: parsed.statement,
        checked,
        maxChecks: parsed.maxChecks,
        counterexample,
        caveats: ["Grid search is bounded and deterministic; absence of a counterexample is not a proof."]
      };
      const artifacts = await maybeWrite(ctx.projectRoot, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: !counterexample, summary: counterexample ? `Counterexample found for ${parsed.statement}.` : `No counterexample found in ${checked} sampled assignment(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: counterexample ? ["Statement failed for at least one sampled assignment."] : [] };
    }
  },
  {
    definition: {
      name: "solve_equation_numeric",
      description: "Solve one scalar equation for one variable on a bounded interval using sign-bracketed bisection.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          equation: { type: "string" },
          variable: { type: "string" },
          min: { type: "number" },
          max: { type: "number" },
          fixedVariables: { type: "object" },
          tolerance: { type: "number" },
          maxIterations: { type: "number" },
          writeToProject: { type: "boolean" },
          outputPath: { type: "string" }
        },
        required: ["equation", "variable", "min", "max"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: solveEquationInputSchema,
    handler: async (input, ctx) => {
      const parsed = solveEquationInputSchema.parse(input);
      const valueAt = (x: number) => residual(parsed.equation, { ...parsed.fixedVariables, [parsed.variable]: x }).difference;
      let low = parsed.min;
      let high = parsed.max;
      let fLow = valueAt(low);
      let fHigh = valueAt(high);
      if (Math.abs(fLow) <= parsed.tolerance) high = low;
      else if (Math.abs(fHigh) > parsed.tolerance && Math.sign(fLow) === Math.sign(fHigh)) throw new Error("Equation endpoints do not bracket a root. Choose a smaller interval or search for a sign change first.");
      let mid = (low + high) / 2;
      let fMid = valueAt(mid);
      let iterations = 0;
      while (iterations < parsed.maxIterations && Math.abs(fMid) > parsed.tolerance && Math.abs(high - low) > parsed.tolerance) {
        iterations += 1;
        if (Math.sign(fLow) === Math.sign(fMid)) {
          low = mid;
          fLow = fMid;
        } else {
          high = mid;
          fHigh = fMid;
        }
        mid = (low + high) / 2;
        fMid = valueAt(mid);
      }
      const report = {
        status: Math.abs(fMid) <= parsed.tolerance || Math.abs(high - low) <= parsed.tolerance ? "solved" : "iteration_limit",
        equation: parsed.equation,
        variable: parsed.variable,
        root: round(mid),
        residual: round(fMid),
        bracket: { min: parsed.min, max: parsed.max, finalLow: round(low), finalHigh: round(high), fLow: round(fLow), fHigh: round(fHigh) },
        iterations,
        tolerance: parsed.tolerance,
        caveats: ["Bisection returns one bracketed real root; it does not find all roots."]
      };
      const artifacts = await maybeWrite(ctx.projectRoot, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: report.status === "solved", summary: `Equation ${report.status}: ${parsed.variable} ~= ${report.root}.`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: report.status === "solved" ? [] : ["Reached iteration limit before tolerance was satisfied."] };
    }
  },
  {
    definition: {
      name: "verify_derivation_steps",
      description: "Check step-by-step algebra derivations by testing adjacent step equivalence over bounded sampled variable assignments.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          variables: { type: "array", items: { type: "object" } },
          tolerance: { type: "number" },
          samplesPerVariable: { type: "number" },
          writeToProject: { type: "boolean" },
          outputPath: { type: "string" }
        },
        required: ["steps"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: verifyDerivationInputSchema,
    handler: async (input, ctx) => {
      const parsed = verifyDerivationInputSchema.parse(input);
      const variables = parsed.variables.length ? parsed.variables : inferVariables(parsed.steps).map((name) => ({ name, min: -5, max: 5, samples: parsed.samplesPerVariable }));
      const assignments = variables.length ? sampleAssignments(variables, 5000) : [{}];
      const checks = parsed.steps.slice(0, -1).map((step, index) => {
        const next = parsed.steps[index + 1];
        let checked = 0;
        let mismatch: Record<string, unknown> | undefined;
        for (const assignment of assignments) {
          try {
            const left = residual(step, assignment).difference;
            const right = residual(next, assignment).difference;
            if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
            checked += 1;
            if (Math.abs(left - right) > parsed.tolerance) {
              mismatch = { variables: assignment, stepValue: round(left), nextValue: round(right), difference: round(left - right) };
              break;
            }
          } catch {
            continue;
          }
        }
        return { fromStep: index + 1, toStep: index + 2, checked, equivalentOnSamples: !mismatch && checked > 0, mismatch };
      });
      const failed = checks.filter((check) => !check.equivalentOnSamples);
      const report = {
        status: failed.length ? "failed" : "passed_on_samples",
        steps: parsed.steps,
        variables,
        checks,
        tolerance: parsed.tolerance,
        caveats: ["Sampled equivalence is not a formal proof; use this to catch algebra mistakes and identify counterexamples."]
      };
      const artifacts = await maybeWrite(ctx.projectRoot, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: failed.length === 0, summary: failed.length ? `Derivation check failed at ${failed.length} transition(s).` : `Derivation passed ${checks.length} sampled transition check(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: failed.map((check) => `Step ${check.fromStep} -> ${check.toStep} is not equivalent on sampled assignments.`) };
    }
  }
];
