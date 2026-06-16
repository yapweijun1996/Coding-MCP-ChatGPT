export const visibleBrowserToolNames = [
  "open_browser_session",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_screenshot",
  "browser_wait",
  "close_browser_session"
] as const;

const visibleBrowserToolNameSet = new Set<string>(visibleBrowserToolNames);

export interface VisibleBrowserControlState {
  name: "visible_browser_control";
  label: string;
  enabled: boolean;
  enabledUntil: string | null;
  enabledBy: string | null;
  enabledAt: string | null;
  lastDisabledAt: string | null;
}

const visibleBrowserControl: VisibleBrowserControlState = {
  name: "visible_browser_control",
  label: "Visible Browser Control",
  enabled: false,
  enabledUntil: null,
  enabledBy: null,
  enabledAt: null,
  lastDisabledAt: null
};
let visibleBrowserExpiredCleanupPending = false;

function refreshVisibleBrowserControl(now = new Date()): VisibleBrowserControlState {
  if (visibleBrowserControl.enabled && visibleBrowserControl.enabledUntil) {
    const expiresAt = new Date(visibleBrowserControl.enabledUntil);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) {
      visibleBrowserControl.enabled = false;
      visibleBrowserControl.lastDisabledAt = now.toISOString();
      visibleBrowserExpiredCleanupPending = true;
    }
  }
  return { ...visibleBrowserControl };
}

export function isVisibleBrowserToolName(name: string): boolean {
  return visibleBrowserToolNameSet.has(name);
}

export function getSpecialToolStates(): VisibleBrowserControlState[] {
  return [refreshVisibleBrowserControl()];
}

export function enableVisibleBrowserControl(durationMinutes: number, adminId: string): VisibleBrowserControlState {
  if (![15, 30, 60].includes(durationMinutes)) {
    throw new Error("Visible browser control duration must be 15, 30, or 60 minutes.");
  }
  const now = new Date();
  visibleBrowserControl.enabled = true;
  visibleBrowserControl.enabledAt = now.toISOString();
  visibleBrowserControl.enabledUntil = new Date(now.getTime() + durationMinutes * 60 * 1000).toISOString();
  visibleBrowserControl.enabledBy = adminId;
  visibleBrowserExpiredCleanupPending = false;
  return { ...visibleBrowserControl };
}

export function disableVisibleBrowserControl(_reason = "disabled"): VisibleBrowserControlState {
  visibleBrowserControl.enabled = false;
  visibleBrowserControl.lastDisabledAt = new Date().toISOString();
  visibleBrowserExpiredCleanupPending = false;
  return { ...visibleBrowserControl };
}

export function isVisibleBrowserControlEnabled(): boolean {
  return refreshVisibleBrowserControl().enabled;
}

export function assertVisibleBrowserControlEnabled(toolName: string): void {
  if (isVisibleBrowserToolName(toolName) && !isVisibleBrowserControlEnabled()) {
    throw new Error("Tool is disabled: visible browser control is off");
  }
}

export function consumeVisibleBrowserExpiredCleanup(): boolean {
  refreshVisibleBrowserControl();
  if (!visibleBrowserExpiredCleanupPending) return false;
  visibleBrowserExpiredCleanupPending = false;
  return true;
}
