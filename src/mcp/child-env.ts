// Minimal allowlisted environment for child processes (git, npm, dev servers).
//
// SECURITY: these child processes execute user-controlled code — test/build/lint
// scripts from package.json, freshly cloned repositories, dev servers. They must
// NOT inherit the server's secrets (DATABASE_URL, admin/OAuth passcodes, dev token,
// registry/API credentials). We deliberately use an ALLOWLIST, not a denylist: a
// missing variable produces a loud, safe build failure, whereas a denylist silently
// leaks any secret whose name it forgot to match (e.g. OPENAI_KEY, GH_PAT).
//
// This is the ONLY sanctioned way these modules should build a child-process env —
// keeping the safe path the only path so a new tool can't reintroduce the leak.

const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TZ",
  "PWD",
  "COLORTERM",
]);

// Prefix allowlist: families of variables npm/node/tooling legitimately need.
const ALLOWED_ENV_PREFIXES = ["LC_", "NODE_", "NPM_CONFIG_", "npm_config_", "SSL_CERT", "SSH_AUTH"];

function isAllowedEnvKey(key: string): boolean {
  return ALLOWED_ENV_KEYS.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Build a scrubbed, allowlisted environment for a child process. */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isAllowedEnvKey(key)) env[key] = value;
  }
  return extra ? { ...env, ...extra } : env;
}

/**
 * Scrubbed environment for git, additionally hardened against the known git RCE
 * vectors:
 *  - GIT_ALLOW_PROTOCOL omits `ext::` (arbitrary command transport) and `file:`
 *    (would let one tenant clone another tenant's on-disk repo as the same uid).
 *  - GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL neutralize system/global config so a
 *    poisoned core.pager / core.sshCommand outside the repo cannot execute.
 *  - GIT_TERMINAL_PROMPT=0 prevents hangs on credential prompts.
 */
export function gitChildEnv(): NodeJS.ProcessEnv {
  return childEnv({
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "http:https:ssh:git",
    GIT_PROTOCOL_FROM_USER: "0",
  });
}
