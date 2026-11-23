export const MOBILE_WEB_BREAKPOINT_PX = 768;

export const MOBILE_WEB_NAV_TABS = ["threads", "projects", "worklog", "settings"] as const;
export type MobileWebNavTab = (typeof MOBILE_WEB_NAV_TABS)[number];

export type MobileSheetKind =
  | "thread-switcher"
  | "project-picker"
  | "artifact-viewer"
  | "pm-board"
  | "worklog-detail"
  | "import-diagnostics";

export interface MobileSheetEntry {
  readonly id: string;
  readonly kind: MobileSheetKind;
  readonly title?: string | undefined;
  readonly payloadId?: string | undefined;
}

export interface MobileWebNavState {
  readonly activeTab: MobileWebNavTab;
  readonly sheetStack: ReadonlyArray<MobileSheetEntry>;
}

export const INITIAL_MOBILE_WEB_NAV_STATE: MobileWebNavState = {
  activeTab: "threads",
  sheetStack: [],
};

export function isMobileWebViewport(viewportWidthPx: number): boolean {
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) return false;
  return viewportWidthPx < MOBILE_WEB_BREAKPOINT_PX;
}

export function resolveMobileWebNavTabFromPath(pathname: string): MobileWebNavTab {
  const normalized = pathname.trim().toLowerCase();
  if (normalized.startsWith("/worklog")) return "worklog";
  if (normalized.startsWith("/settings")) return "settings";
  if (normalized.startsWith("/workspace") || normalized.startsWith("/projects")) {
    return "projects";
  }
  return "threads";
}

export function routePathForMobileWebNavTab(tab: MobileWebNavTab): string {
  switch (tab) {
    case "threads":
      return "/";
    case "projects":
      return "/workspace";
    case "worklog":
      return "/worklog";
    case "settings":
      return "/settings/connections";
  }
}

export function selectMobileWebNavTab(
  state: MobileWebNavState,
  tab: MobileWebNavTab,
): MobileWebNavState {
  return {
    activeTab: tab,
    sheetStack: [],
  };
}

export function pushMobileSheet(
  stack: ReadonlyArray<MobileSheetEntry>,
  entry: MobileSheetEntry,
): ReadonlyArray<MobileSheetEntry> {
  const withoutSameId = stack.filter((item) => item.id !== entry.id);
  return [...withoutSameId, entry];
}

export function popMobileSheet(
  stack: ReadonlyArray<MobileSheetEntry>,
): ReadonlyArray<MobileSheetEntry> {
  if (stack.length === 0) return stack;
  return stack.slice(0, -1);
}

export function replaceMobileSheet(
  stack: ReadonlyArray<MobileSheetEntry>,
  entry: MobileSheetEntry,
): ReadonlyArray<MobileSheetEntry> {
  if (stack.length === 0) return [entry];
  return [...stack.slice(0, -1), entry];
}

export function closeAllMobileSheets(): ReadonlyArray<MobileSheetEntry> {
  return [];
}

export function topMobileSheet(stack: ReadonlyArray<MobileSheetEntry>): MobileSheetEntry | null {
  return stack.at(-1) ?? null;
}

export interface WorklogSwipeGestureInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly elapsedMs: number;
  readonly minDistancePx?: number | undefined;
  readonly maxVerticalRatio?: number | undefined;
  readonly maxDurationMs?: number | undefined;
}

export type WorklogSwipeDirection = "prev" | "next" | null;

/**
 * Resolves a horizontal swipe on the mobile worklog calendar.
 * Swiping left (`deltaX < 0`) advances to the next day; swiping right moves to the previous day.
 */
export function resolveWorklogSwipeDirection(
  input: WorklogSwipeGestureInput,
): WorklogSwipeDirection {
  const minDistancePx = input.minDistancePx ?? 48;
  const maxVerticalRatio = input.maxVerticalRatio ?? 0.65;
  const maxDurationMs = input.maxDurationMs ?? 600;

  if (!Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY)) return null;
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0 || input.elapsedMs > maxDurationMs) {
    return null;
  }

  const absX = Math.abs(input.deltaX);
  const absY = Math.abs(input.deltaY);
  if (absX < minDistancePx) return null;
  if (absY > absX * maxVerticalRatio) return null;

  return input.deltaX < 0 ? "next" : "prev";
}

export interface MobileViewportInsetsInput {
  readonly layoutViewportHeightPx: number;
  readonly visualViewportHeightPx: number;
  readonly visualViewportOffsetTopPx?: number | undefined;
  readonly safeAreaBottomPx?: number | undefined;
  readonly bottomNavHeightPx?: number | undefined;
  readonly keyboardThresholdPx?: number | undefined;
}

export interface MobileViewportMetrics {
  readonly keyboardOpen: boolean;
  readonly keyboardHeightPx: number;
  readonly bottomNavVisible: boolean;
  readonly effectiveSafeBottomPx: number;
  readonly contentBottomPaddingPx: number;
  readonly sheetMaxHeightPx: number;
}

export function computeMobileViewportMetrics(
  input: MobileViewportInsetsInput,
): MobileViewportMetrics {
  const layoutHeight = Math.max(0, Math.round(input.layoutViewportHeightPx));
  const visualHeight = Math.max(0, Math.round(input.visualViewportHeightPx));
  const offsetTop = Math.max(0, Math.round(input.visualViewportOffsetTopPx ?? 0));
  const safeBottom = Math.max(0, Math.round(input.safeAreaBottomPx ?? 0));
  const bottomNavHeight = Math.max(0, Math.round(input.bottomNavHeightPx ?? 56));
  const keyboardThreshold = Math.max(40, Math.round(input.keyboardThresholdPx ?? 120));

  const occludedBottom = Math.max(0, layoutHeight - (visualHeight + offsetTop));
  const keyboardOpen = occludedBottom >= keyboardThreshold;
  const keyboardHeightPx = keyboardOpen ? occludedBottom : 0;
  const bottomNavVisible = !keyboardOpen;
  const effectiveSafeBottomPx = keyboardOpen ? 0 : safeBottom;
  const contentBottomPaddingPx = bottomNavVisible
    ? bottomNavHeight + effectiveSafeBottomPx
    : effectiveSafeBottomPx;
  const availableSheetHeight = Math.max(200, (visualHeight || layoutHeight) - 24);
  const sheetMaxHeightPx = Math.min(
    availableSheetHeight,
    Math.round(layoutHeight * 0.92) || availableSheetHeight,
  );

  return {
    keyboardOpen,
    keyboardHeightPx,
    bottomNavVisible,
    effectiveSafeBottomPx,
    contentBottomPaddingPx,
    sheetMaxHeightPx,
  };
}
