import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_MOBILE_WEB_NAV_STATE,
  MOBILE_WEB_NAV_TABS,
  closeAllMobileSheets,
  computeMobileViewportMetrics,
  isMobileWebViewport,
  popMobileSheet,
  pushMobileSheet,
  replaceMobileSheet,
  resolveMobileWebNavTabFromPath,
  resolveWorklogSwipeDirection,
  routePathForMobileWebNavTab,
  selectMobileWebNavTab,
  topMobileSheet,
  type MobileSheetEntry,
} from "./mobileWebNav.logic";

describe("mobileWebNav.logic", () => {
  it("evaluates <768px mobile viewport threshold and route tab mapping", () => {
    expect(isMobileWebViewport(390)).toBe(true);
    expect(isMobileWebViewport(767)).toBe(true);
    expect(isMobileWebViewport(768)).toBe(false);
    expect(isMobileWebViewport(1280)).toBe(false);
    expect(isMobileWebViewport(0)).toBe(false);

    expect(MOBILE_WEB_NAV_TABS).toEqual(["threads", "projects", "worklog", "settings"]);
    expect(resolveMobileWebNavTabFromPath("/")).toBe("threads");
    expect(resolveMobileWebNavTabFromPath("/threads/t-1")).toBe("threads");
    expect(resolveMobileWebNavTabFromPath("/workspace/mp-1")).toBe("projects");
    expect(resolveMobileWebNavTabFromPath("/worklog")).toBe("worklog");
    expect(resolveMobileWebNavTabFromPath("/settings/connections")).toBe("settings");

    expect(routePathForMobileWebNavTab("worklog")).toBe("/worklog");
  });

  it("manages slide-up sheet stack with push, pop, replace, closeAll, and tab switch reset", () => {
    const first: MobileSheetEntry = { id: "s1", kind: "pm-board", title: "PM" };
    const second: MobileSheetEntry = { id: "s2", kind: "artifact-viewer", payloadId: "art-1" };
    const replacement: MobileSheetEntry = { id: "s3", kind: "worklog-detail", payloadId: "w-1" };

    let stack = pushMobileSheet(INITIAL_MOBILE_WEB_NAV_STATE.sheetStack, first);
    stack = pushMobileSheet(stack, second);
    expect(stack.map((item) => item.id)).toEqual(["s1", "s2"]);
    expect(topMobileSheet(stack)?.id).toBe("s2");

    // Re-pushing an existing id moves it to the top without duplicating it.
    stack = pushMobileSheet(stack, first);
    expect(stack.map((item) => item.id)).toEqual(["s2", "s1"]);

    stack = replaceMobileSheet(stack, replacement);
    expect(stack.map((item) => item.id)).toEqual(["s2", "s3"]);

    stack = popMobileSheet(stack);
    expect(stack.map((item) => item.id)).toEqual(["s2"]);

    const switched = selectMobileWebNavTab({ activeTab: "threads", sheetStack: stack }, "worklog");
    expect(switched.activeTab).toBe("worklog");
    expect(switched.sheetStack).toEqual([]);
    expect(closeAllMobileSheets()).toEqual([]);
  });

  it("computes horizontal worklog swipe direction and rejects vertical or slow gestures", () => {
    expect(resolveWorklogSwipeDirection({ deltaX: -72, deltaY: 12, elapsedMs: 180 })).toBe("next");
    expect(resolveWorklogSwipeDirection({ deltaX: 84, deltaY: -10, elapsedMs: 220 })).toBe("prev");
    expect(resolveWorklogSwipeDirection({ deltaX: -30, deltaY: 0, elapsedMs: 120 })).toBeNull();
    expect(resolveWorklogSwipeDirection({ deltaX: -80, deltaY: 75, elapsedMs: 150 })).toBeNull();
    expect(resolveWorklogSwipeDirection({ deltaX: -90, deltaY: 0, elapsedMs: 900 })).toBeNull();
  });

  it("computes safe-area padding and hides bottom nav while soft keyboard is open", () => {
    const idle = computeMobileViewportMetrics({
      layoutViewportHeightPx: 844,
      visualViewportHeightPx: 844,
      safeAreaBottomPx: 34,
    });
    expect(idle.keyboardOpen).toBe(false);
    expect(idle.bottomNavVisible).toBe(true);
    expect(idle.effectiveSafeBottomPx).toBe(34);
    expect(idle.contentBottomPaddingPx).toBe(90);

    const typing = computeMobileViewportMetrics({
      layoutViewportHeightPx: 844,
      visualViewportHeightPx: 520,
      safeAreaBottomPx: 34,
    });
    expect(typing.keyboardOpen).toBe(true);
    expect(typing.keyboardHeightPx).toBe(324);
    expect(typing.bottomNavVisible).toBe(false);
    expect(typing.effectiveSafeBottomPx).toBe(0);
    expect(typing.contentBottomPaddingPx).toBe(0);
    expect(typing.sheetMaxHeightPx).toBe(496);
  });
});
