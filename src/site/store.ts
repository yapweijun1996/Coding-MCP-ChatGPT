import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SiteState {
  homeProjectId: string | null;
  homeOwnerUserId: string | null;
  updatedAt: string | null;
}

interface SiteStateFile {
  version: 1;
  homeProjectId: string | null;
  homeOwnerUserId: string | null;
  updatedAt: string;
}

let statePath = path.join(process.cwd(), ".state", "site-state.json");
let loaded = false;
let state: SiteState = { homeProjectId: null, homeOwnerUserId: null, updatedAt: null };

function loadState(): void {
  if (loaded) return;
  state = { homeProjectId: null, homeOwnerUserId: null, updatedAt: null };
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SiteStateFile>;
    if (parsed && typeof parsed === "object") {
      state = {
        homeProjectId: typeof parsed.homeProjectId === "string" ? parsed.homeProjectId : null,
        homeOwnerUserId: typeof parsed.homeOwnerUserId === "string" ? parsed.homeOwnerUserId : null,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
      };
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
  loaded = true;
}

function persistState(): void {
  const payload: SiteStateFile = {
    version: 1,
    homeProjectId: state.homeProjectId,
    homeOwnerUserId: state.homeOwnerUserId,
    updatedAt: state.updatedAt ?? new Date().toISOString()
  };
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function initializeSiteState(pathname: string): void {
  statePath = pathname;
  loaded = false;
  loadState();
}

export function getHomepage(): SiteState {
  loadState();
  return { ...state };
}

export function setHomepage(input: { projectId: string; ownerUserId: string }): SiteState {
  loadState();
  state = { homeProjectId: input.projectId, homeOwnerUserId: input.ownerUserId, updatedAt: new Date().toISOString() };
  persistState();
  return { ...state };
}

export function clearHomepage(): SiteState {
  loadState();
  state = { homeProjectId: null, homeOwnerUserId: null, updatedAt: new Date().toISOString() };
  persistState();
  return { ...state };
}
