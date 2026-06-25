import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Minimal, fast (non-type-checked) lint pass for the server source and tests. This is the
// mechanical safety net tsc doesn't provide: unused vars/imports, lexical foot-guns. Tuned
// to be high-signal-green on the current codebase — noisy or intentional patterns are
// relaxed below so the gate fails only on real regressions, not on house style.
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "admin-ui/**",
      ".artifacts/**",
      ".captures/**",
      "output/**",
      "scripts/**",
      "*.config.js"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          // `^_` for intentional throwaways; `(Schema|Enum)$` for zod schema consts that are
          // referenced only via `z.infer<typeof X>` — a value used purely as a type source,
          // which the rule otherwise reports. This is the project's single-source-of-truth
          // schema→type idiom, not dead code.
          varsIgnorePattern: "^_|(Schema|Enum)$"
        }
      ],
      // The codebase builds large HTML/CSS/SVG template strings where escape analysis is noisy
      // and low value, and uses deliberate control-char regexes in file-safety guards.
      "no-useless-escape": "off",
      "no-control-regex": "off",
      // `while (true)` worker loops with internal breaks are intentional here.
      "no-constant-condition": ["error", { checkLoops: false }]
    }
  }
);
