// Visible browser control gates one capability: opening a browser window that is actually
// visible on the server's display. It used to gate a *list of tool names* instead, which meant
// the whole browser_* family bypassed tool state and skill exposure and was reachable only
// during a 15/30/60-minute window. Those tools are now ordinary tools behind the normal two
// gates; what remains time-boxed is the headed mode itself, enforced in open_browser_session.
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

export function consumeVisibleBrowserExpiredCleanup(): boolean {
  refreshVisibleBrowserControl();
  if (!visibleBrowserExpiredCleanupPending) return false;
  visibleBrowserExpiredCleanupPending = false;
  return true;
}
