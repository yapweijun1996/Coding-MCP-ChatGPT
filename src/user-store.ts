import crypto from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";

const scrypt = promisify(crypto.scrypt);

export type UserRole = "admin" | "developer" | "viewer";
export type UserStatus = "pending" | "active" | "disabled";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  username?: string;
  publicShareUsernameEnabled: boolean;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
}

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  username?: string;
  publicShareUsernameEnabled: boolean;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  projectRoot?: string;
}

export interface UserSession {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface RegistrationSettings {
  allowRegistration: boolean;
  requireApproval: true;
  defaultRole: "developer";
  allowedEmailDomains: string[];
}

export interface UserStoreConfig {
  databaseUrl?: string;
  statePath: string;
  projectRoot: string;
  usersRoot: string;
  adminEmail?: string;
  adminPassword?: string;
  fallbackAdminPasscode?: string;
  sessionTtlMs: number;
}

interface PersistedState {
  users: UserRecord[];
  sessions: UserSession[];
  registrationSettings: RegistrationSettings;
  projectRoots: Record<string, string>;
  migrations: Record<string, string>;
}

const defaultSettings: RegistrationSettings = {
  allowRegistration: false,
  requireApproval: true,
  defaultRole: "developer",
  allowedEmailDomains: []
};
const reservedUsernames = new Set(["admin", "api", "share", "artifact", "mcp", "register", "login", "health", "oauth", "authorize", "token", "revoke", "users", "settings"]);

let config: UserStoreConfig | undefined;
let pool: pg.Pool | undefined;
let state: PersistedState = {
  users: [],
  sessions: [],
  registrationSettings: defaultSettings,
  projectRoots: {},
  migrations: {}
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeUsername(username: string | undefined): string | undefined {
  const normalized = username?.trim().toLowerCase();
  return normalized || undefined;
}

function validateUsername(username: string | undefined): string | undefined {
  const normalized = normalizeUsername(username);
  if (!normalized) return undefined;
  if (!/^[a-z0-9_-]{3,32}$/.test(normalized)) throw new Error("Username must be 3-32 characters using lowercase letters, numbers, hyphen, or underscore.");
  if (reservedUsernames.has(normalized)) throw new Error("Username is reserved.");
  return normalized;
}

function cloneSettings(settings: RegistrationSettings): RegistrationSettings {
  return {
    allowRegistration: Boolean(settings.allowRegistration),
    requireApproval: true,
    defaultRole: "developer",
    allowedEmailDomains: [...(settings.allowedEmailDomains ?? [])].map((domain) => domain.toLowerCase()).filter(Boolean)
  };
}

function toPublicUser(user: UserRecord, projectRoot?: string): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    username: user.username,
    publicShareUsernameEnabled: user.publicShareUsernameEnabled,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt,
    approvedBy: user.approvedBy,
    projectRoot
  };
}

async function ensureConfig(): Promise<UserStoreConfig> {
  if (!config) throw new Error("User store is not initialized.");
  return config;
}

async function loadFileState(): Promise<void> {
  const cfg = await ensureConfig();
  try {
    const raw = await readFile(cfg.statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    state = {
      users: (parsed.users ?? []).map((user) => ({ ...user, publicShareUsernameEnabled: Boolean(user.publicShareUsernameEnabled) })),
      sessions: parsed.sessions ?? [],
      registrationSettings: cloneSettings(parsed.registrationSettings ?? defaultSettings),
      projectRoots: parsed.projectRoots ?? {},
      migrations: parsed.migrations ?? {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to load user state from ${cfg.statePath}:`, error);
    }
  }
}

async function saveFileState(): Promise<void> {
  const cfg = await ensureConfig();
  if (pool) return;
  await mkdir(path.dirname(cfg.statePath), { recursive: true });
  await writeFile(cfg.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  if (!pool) throw new Error("Postgres is not configured.");
  const result = await pool.query(sql, values);
  return result.rows as T[];
}

async function runMigrations(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    create table if not exists users (
      id text primary key,
      email text not null unique,
      password_hash text not null,
      role text not null check (role in ('admin', 'developer', 'viewer')),
      status text not null check (status in ('pending', 'active', 'disabled')),
      username text unique,
      public_share_username_enabled boolean not null default false,
      created_at timestamptz not null,
      approved_at timestamptz,
      approved_by text
    );
    create table if not exists sessions (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      csrf_token text not null,
      created_at timestamptz not null,
      expires_at timestamptz not null
    );
    create table if not exists registration_settings (
      id integer primary key default 1,
      allow_registration boolean not null default false,
      require_approval boolean not null default true,
      default_role text not null default 'developer',
      allowed_email_domains text[] not null default '{}'
    );
    create table if not exists user_project_roots (
      user_id text primary key references users(id) on delete cascade,
      project_root text not null
    );
    create table if not exists audit_events (
      id bigserial primary key,
      time timestamptz not null default now(),
      user_id text,
      client_id text,
      method text not null,
      tool_name text,
      ok boolean not null,
      summary text not null
    );
    create table if not exists migration_state (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    );
    insert into registration_settings (id, allow_registration, require_approval, default_role, allowed_email_domains)
    values (1, false, true, 'developer', '{}')
    on conflict (id) do nothing;
    alter table users add column if not exists username text;
    alter table users add column if not exists public_share_username_enabled boolean not null default false;
    create unique index if not exists users_username_unique on users(username) where username is not null;
  `);
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    role: row.role as UserRole,
    status: row.status as UserStatus,
    username: row.username ? String(row.username) : undefined,
    publicShareUsernameEnabled: Boolean(row.public_share_username_enabled),
    createdAt: new Date(String(row.created_at)).toISOString(),
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : undefined,
    approvedBy: row.approved_by ? String(row.approved_by) : undefined
  };
}

function mapSession(row: Record<string, unknown>): UserSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    csrfToken: String(row.csrf_token),
    createdAt: new Date(String(row.created_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString()
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [scheme, salt, expected] = passwordHash.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  const expectedBuffer = Buffer.from(expected, "base64url");
  return derived.length === expectedBuffer.length && crypto.timingSafeEqual(derived, expectedBuffer);
}

async function getUserRecordByEmail(email: string): Promise<UserRecord | undefined> {
  const normalized = normalizeEmail(email);
  if (pool) {
    const rows = await query<Record<string, unknown>>("select * from users where email = $1", [normalized]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }
  return state.users.find((user) => user.email === normalized);
}

async function upsertUser(user: UserRecord): Promise<void> {
  if (pool) {
    await pool.query(`
      insert into users (id, email, password_hash, role, status, username, public_share_username_enabled, created_at, approved_at, approved_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict (id) do update set
        email = excluded.email,
        password_hash = excluded.password_hash,
        role = excluded.role,
        status = excluded.status,
        username = excluded.username,
        public_share_username_enabled = excluded.public_share_username_enabled,
        approved_at = excluded.approved_at,
        approved_by = excluded.approved_by
    `, [user.id, user.email, user.passwordHash, user.role, user.status, user.username, user.publicShareUsernameEnabled, user.createdAt, user.approvedAt, user.approvedBy]);
    return;
  }
  const index = state.users.findIndex((item) => item.id === user.id);
  if (index >= 0) state.users[index] = user;
  else state.users.push(user);
  await saveFileState();
}

export async function getUserById(userId: string): Promise<PublicUser | undefined> {
  if (pool) {
    const rows = await query<Record<string, unknown>>("select * from users where id = $1", [userId]);
    if (!rows[0]) return undefined;
    return toPublicUser(mapUser(rows[0]), await getProjectRootForUser(userId));
  }
  const user = state.users.find((item) => item.id === userId);
  return user ? toPublicUser(user, await getProjectRootForUser(user.id)) : undefined;
}

export async function getUserByEmail(email: string): Promise<PublicUser | undefined> {
  const user = await getUserRecordByEmail(email);
  return user ? toPublicUser(user, await getProjectRootForUser(user.id)) : undefined;
}

export async function getUserByUsername(username: string): Promise<PublicUser | undefined> {
  const normalized = normalizeUsername(username);
  if (!normalized) return undefined;
  if (pool) {
    const rows = await query<Record<string, unknown>>("select * from users where username = $1", [normalized]);
    return rows[0] ? toPublicUser(mapUser(rows[0]), await getProjectRootForUser(String(rows[0].id))) : undefined;
  }
  const user = state.users.find((item) => item.username === normalized);
  return user ? toPublicUser(user, await getProjectRootForUser(user.id)) : undefined;
}

async function getUserRecordById(userId: string): Promise<UserRecord | undefined> {
  if (pool) {
    const rows = await query<Record<string, unknown>>("select * from users where id = $1", [userId]);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }
  return state.users.find((item) => item.id === userId);
}

export async function listUsers(options: { status?: string; q?: string } = {}): Promise<PublicUser[]> {
  const users = pool
    ? (await query<Record<string, unknown>>("select * from users order by created_at desc")).map(mapUser)
    : [...state.users].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const q = options.q?.trim().toLowerCase() ?? "";
  const filtered = users.filter((user) => {
    if (options.status && user.status !== options.status) return false;
    if (!q) return true;
    return user.email.includes(q) || user.id.toLowerCase().includes(q) || user.role.includes(q) || Boolean(user.username?.includes(q));
  });
  return Promise.all(filtered.map(async (user) => toPublicUser(user, await getProjectRootForUser(user.id))));
}

export async function getUserByProjectRoot(projectRoot: string): Promise<PublicUser | undefined> {
  const normalizedRoot = path.resolve(projectRoot);
  if (pool) {
    const rows = await query<Record<string, unknown>>(`
      select users.* from users
      join user_project_roots on user_project_roots.user_id = users.id
      where user_project_roots.project_root = $1
    `, [normalizedRoot]);
    return rows[0] ? toPublicUser(mapUser(rows[0]), normalizedRoot) : undefined;
  }
  const userId = Object.entries(state.projectRoots).find(([, root]) => path.resolve(root) === normalizedRoot)?.[0];
  if (!userId) return undefined;
  const user = state.users.find((item) => item.id === userId);
  return user ? toPublicUser(user, normalizedRoot) : undefined;
}

async function setProjectRootForUser(userId: string, projectRoot: string): Promise<void> {
  if (pool) {
    await pool.query(`
      insert into user_project_roots (user_id, project_root)
      values ($1, $2)
      on conflict (user_id) do update set project_root = excluded.project_root
    `, [userId, projectRoot]);
    return;
  }
  state.projectRoots[userId] = projectRoot;
  await saveFileState();
}

export async function getProjectRootForUser(userId: string): Promise<string> {
  const cfg = await ensureConfig();
  if (pool) {
    const rows = await query<{ project_root: string }>("select project_root from user_project_roots where user_id = $1", [userId]);
    if (rows[0]?.project_root) return rows[0].project_root;
  } else if (state.projectRoots[userId]) {
    return state.projectRoots[userId];
  }
  const projectRoot = path.join(cfg.usersRoot, userId, "projects");
  await mkdir(projectRoot, { recursive: true });
  await setProjectRootForUser(userId, projectRoot);
  return projectRoot;
}

export async function getAllProjectRoots(): Promise<string[]> {
  const cfg = await ensureConfig();
  const roots = new Set<string>([cfg.projectRoot]);
  if (pool) {
    const rows = await query<{ project_root: string }>("select project_root from user_project_roots");
    for (const row of rows) roots.add(row.project_root);
  } else {
    for (const root of Object.values(state.projectRoots)) roots.add(root);
  }
  return [...roots];
}

export async function getRegistrationSettings(): Promise<RegistrationSettings> {
  if (pool) {
    const rows = await query<Record<string, unknown>>("select * from registration_settings where id = 1");
    const row = rows[0];
    if (!row) return defaultSettings;
    return cloneSettings({
      allowRegistration: Boolean(row.allow_registration),
      requireApproval: true,
      defaultRole: "developer",
      allowedEmailDomains: Array.isArray(row.allowed_email_domains) ? row.allowed_email_domains.map(String) : []
    });
  }
  return cloneSettings(state.registrationSettings);
}

export async function updateRegistrationSettings(input: Partial<RegistrationSettings>): Promise<RegistrationSettings> {
  const settings = cloneSettings({
    ...(await getRegistrationSettings()),
    allowRegistration: Boolean(input.allowRegistration),
    allowedEmailDomains: Array.isArray(input.allowedEmailDomains) ? input.allowedEmailDomains : []
  });
  if (pool) {
    await pool.query(`
      update registration_settings
      set allow_registration = $1, require_approval = true, default_role = 'developer', allowed_email_domains = $2
      where id = 1
    `, [settings.allowRegistration, settings.allowedEmailDomains]);
  } else {
    state.registrationSettings = settings;
    await saveFileState();
  }
  return settings;
}

export async function registerUser(email: string, password: string): Promise<PublicUser> {
  const settings = await getRegistrationSettings();
  if (!settings.allowRegistration) throw new Error("Registration is disabled.");
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) throw new Error("A valid email is required.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (settings.allowedEmailDomains.length > 0) {
    const domain = normalized.split("@")[1] ?? "";
    if (!settings.allowedEmailDomains.includes(domain)) throw new Error("Email domain is not allowed.");
  }
  if (await getUserRecordByEmail(normalized)) throw new Error("Email is already registered.");
  const user: UserRecord = {
    id: crypto.randomUUID(),
    email: normalized,
    passwordHash: await hashPassword(password),
    role: "developer",
    status: "pending",
    publicShareUsernameEnabled: false,
    createdAt: nowIso()
  };
  await upsertUser(user);
  await getProjectRootForUser(user.id);
  return toPublicUser(user, await getProjectRootForUser(user.id));
}

export async function loginUser(email: string, password: string): Promise<UserRecord> {
  const user = await getUserRecordByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new Error("Invalid email or password.");
  if (user.status === "pending") throw new Error("Account is pending admin approval.");
  if (user.status === "disabled") throw new Error("Account is disabled.");
  return user;
}

export async function createUserSession(userId: string): Promise<UserSession> {
  const cfg = await ensureConfig();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + cfg.sessionTtlMs);
  const session: UserSession = {
    id: crypto.randomBytes(32).toString("base64url"),
    userId,
    csrfToken: crypto.randomBytes(32).toString("base64url"),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  if (pool) {
    await pool.query(
      "insert into sessions (id, user_id, csrf_token, created_at, expires_at) values ($1, $2, $3, $4, $5)",
      [session.id, session.userId, session.csrfToken, session.createdAt, session.expiresAt]
    );
  } else {
    state.sessions.push(session);
    await saveFileState();
  }
  return session;
}

export async function getSession(sessionId: string | undefined): Promise<{ session: UserSession; user: PublicUser } | undefined> {
  if (!sessionId) return undefined;
  const current = Date.now();
  let session: UserSession | undefined;
  if (pool) {
    await pool.query("delete from sessions where expires_at <= now()");
    const rows = await query<Record<string, unknown>>("select * from sessions where id = $1", [sessionId]);
    session = rows[0] ? mapSession(rows[0]) : undefined;
  } else {
    state.sessions = state.sessions.filter((item) => Date.parse(item.expiresAt) > current);
    session = state.sessions.find((item) => item.id === sessionId);
    await saveFileState();
  }
  if (!session) return undefined;
  const user = await getUserById(session.userId);
  if (!user || user.status !== "active") return undefined;
  return { session, user };
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (pool) await pool.query("delete from sessions where id = $1", [sessionId]);
  else {
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
    await saveFileState();
  }
}

export async function approveUser(userId: string, approvedBy: string): Promise<PublicUser> {
  const user = await getUserRecordById(userId);
  if (!user) throw new Error("User not found.");
  user.status = "active";
  user.role = user.role === "admin" ? "admin" : "developer";
  user.approvedAt = nowIso();
  user.approvedBy = approvedBy;
  await upsertUser(user);
  return toPublicUser(user, await getProjectRootForUser(user.id));
}

export async function updateUserProfile(userId: string, input: { username?: string; publicShareUsernameEnabled?: boolean }): Promise<PublicUser> {
  const user = await getUserRecordById(userId);
  if (!user) throw new Error("User not found.");
  const username = validateUsername(input.username);
  if (username) {
    const existing = pool
      ? (await query<Record<string, unknown>>("select id from users where username = $1 and id <> $2", [username, userId]))[0]
      : state.users.find((item) => item.username === username && item.id !== userId);
    if (existing) throw new Error("Username is already taken.");
  }
  user.username = username;
  user.publicShareUsernameEnabled = Boolean(input.publicShareUsernameEnabled && username);
  await upsertUser(user);
  return toPublicUser(user, await getProjectRootForUser(user.id));
}

export function getPublicShareBasePathForUser(user: PublicUser | undefined): string {
  if (user?.username && user.publicShareUsernameEnabled) return `/@${user.username}/share`;
  return "/share";
}

export async function disableUser(userId: string): Promise<PublicUser> {
  const user = await getUserRecordById(userId);
  if (!user) throw new Error("User not found.");
  user.status = "disabled";
  await upsertUser(user);
  return toPublicUser(user, await getProjectRootForUser(user.id));
}

export async function updateUserRole(userId: string, role: UserRole): Promise<PublicUser> {
  const user = await getUserRecordById(userId);
  if (!user) throw new Error("User not found.");
  user.role = role;
  await upsertUser(user);
  return toPublicUser(user, await getProjectRootForUser(user.id));
}

async function hasAnyAdmin(): Promise<boolean> {
  if (pool) {
    const rows = await query<{ count: string }>("select count(*)::text as count from users where role = 'admin'");
    return Number(rows[0]?.count ?? 0) > 0;
  }
  return state.users.some((user) => user.role === "admin");
}

export async function loginBootstrapAdminWithPasscode(passcode: string): Promise<UserRecord> {
  const cfg = await ensureConfig();
  if (!cfg.fallbackAdminPasscode) throw new Error("Invalid passcode.");
  const a = crypto.createHmac("sha256", "passcode-compare").update(passcode).digest();
  const b = crypto.createHmac("sha256", "passcode-compare").update(cfg.fallbackAdminPasscode).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new Error("Invalid passcode.");
  if (await hasAnyAdmin()) throw new Error("Passcode bootstrap is disabled after an admin account exists.");
  const existing = await getUserRecordByEmail("bootstrap-admin@local");
  if (existing) return existing;
  const user: UserRecord = {
    id: crypto.randomUUID(),
    email: "bootstrap-admin@local",
    passwordHash: await hashPassword(crypto.randomBytes(24).toString("base64url")),
    role: "admin",
    status: "active",
    publicShareUsernameEnabled: false,
    createdAt: nowIso(),
    approvedAt: nowIso(),
    approvedBy: "bootstrap"
  };
  await upsertUser(user);
  await getProjectRootForUser(user.id);
  return user;
}

async function ensureBootstrapAdmin(): Promise<void> {
  const cfg = await ensureConfig();
  if (await hasAnyAdmin()) return;
  if (!cfg.adminEmail || !cfg.adminPassword) return;
  const user: UserRecord = {
    id: crypto.randomUUID(),
    email: normalizeEmail(cfg.adminEmail),
    passwordHash: await hashPassword(cfg.adminPassword),
    role: "admin",
    status: "active",
    publicShareUsernameEnabled: false,
    createdAt: nowIso(),
    approvedAt: nowIso(),
    approvedBy: "bootstrap"
  };
  await upsertUser(user);
  await getProjectRootForUser(user.id);
}

async function directoryHasEntries(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length > 0;
  } catch {
    return false;
  }
}

async function migrationValue(key: string): Promise<string | undefined> {
  if (pool) {
    const rows = await query<{ value: string }>("select value from migration_state where key = $1", [key]);
    return rows[0]?.value;
  }
  return state.migrations[key];
}

async function setMigrationValue(key: string, value: string): Promise<void> {
  if (pool) {
    await pool.query(`
      insert into migration_state (key, value, updated_at)
      values ($1, $2, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `, [key, value]);
    return;
  }
  state.migrations[key] = value;
  await saveFileState();
}

async function ensureLegacyUserMigration(): Promise<void> {
  const cfg = await ensureConfig();
  if (await migrationValue("legacy-projects-v1")) return;
  if (!(await directoryHasEntries(cfg.projectRoot))) {
    await setMigrationValue("legacy-projects-v1", "skipped-empty");
    return;
  }
  let legacy = await getUserRecordByEmail("legacy-user@local");
  if (!legacy) {
    legacy = {
      id: crypto.randomUUID(),
      email: "legacy-user@local",
      passwordHash: await hashPassword(crypto.randomBytes(24).toString("base64url")),
      role: "developer",
      status: "active",
      publicShareUsernameEnabled: false,
      createdAt: nowIso(),
      approvedAt: nowIso(),
      approvedBy: "migration"
    };
    await upsertUser(legacy);
  }
  const targetRoot = path.join(cfg.usersRoot, legacy.id, "projects");
  await mkdir(targetRoot, { recursive: true });
  if (!(await directoryHasEntries(targetRoot))) {
    try {
      await stat(cfg.projectRoot);
      await cp(cfg.projectRoot, targetRoot, { recursive: true, force: false, errorOnExist: false });
    } catch (error) {
      console.error("Legacy project copy failed:", error);
    }
  }
  await setProjectRootForUser(legacy.id, targetRoot);
  await setMigrationValue("legacy-projects-v1", legacy.id);
}

export async function initializeUserStore(input: UserStoreConfig): Promise<void> {
  config = input;
  if (input.databaseUrl) {
    pool = new pg.Pool({ connectionString: input.databaseUrl });
    await runMigrations();
  } else {
    await loadFileState();
  }
  await mkdir(input.usersRoot, { recursive: true });
  await ensureBootstrapAdmin();
  await ensureLegacyUserMigration();
}
