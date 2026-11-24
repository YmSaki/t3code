import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { msg, useGT, useMessages } from "gt-react";
import { CalendarDaysIcon, FolderIcon, MessagesSquareIcon, Settings2Icon } from "lucide-react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { GlobalVoiceInputIndicator } from "../components/chat/GlobalVoiceInputIndicator";
import { isAppModalPage, isSidebarUtilityPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { cn } from "../lib/utils";
import {
  MOBILE_WEB_NAV_TABS,
  resolveMobileWebNavTabFromPath,
  type MobileWebNavTab,
} from "../mobileWebNav.logic";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useShownThreadRouteTarget } from "../hooks/useShownThreadRouteTarget";

const MOBILE_WEB_NAV_ITEMS = {
  threads: { label: msg("Threads"), Icon: MessagesSquareIcon },
  projects: { label: msg("Projects"), Icon: FolderIcon },
  worklog: { label: msg("Worklog"), Icon: CalendarDaysIcon },
  settings: { label: msg("Settings"), Icon: Settings2Icon },
} satisfies Record<MobileWebNavTab, unknown>;

// Threads, drafts, issues and pull requests own the bottom edge with a composer, so the bar skips them.
function MobileWebBottomNav() {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  if (isSidebarUtilityPage(pathname)) return null;
  const activeTab = resolveMobileWebNavTabFromPath(pathname);

  const selectTab = (tab: MobileWebNavTab) => {
    switch (tab) {
      case "threads":
        void navigate({ to: "/" });
        return;
      // There is no project index route; the mobile sidebar sheet is the project list.
      case "projects":
        setOpenMobile(true);
        return;
      case "worklog":
        void navigate({ to: "/worklog" });
        return;
      case "settings":
        void navigate({ to: "/settings/connections" });
        return;
    }
  };

  return (
    <nav
      aria-label={gt("Main navigation")}
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-background pb-safe md:hidden"
    >
      {MOBILE_WEB_NAV_TABS.map((tab) => {
        const { label, Icon } = MOBILE_WEB_NAV_ITEMS[tab];
        const isActive = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => selectTab(tab)}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center gap-0.5 text-2xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              isActive ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden className="size-5" />
            <span>{m(label)}</span>
          </button>
        );
      })}
    </nav>
  );
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const { shownTarget, modalOpen } = useShownThreadRouteTarget();
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
      {shownTarget || modalOpen ? null : <MobileWebBottomNav />}
      <GlobalVoiceInputIndicator hidden={modalOpen} />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
