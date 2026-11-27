import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { toastManager } from "./ui/toast";

const { add, update, openExternal, runCommand, commands, starred, page } = vi.hoisted(() => ({
  add: vi.fn<typeof toastManager.add>(),
  update: vi.fn<typeof toastManager.update>(),
  openExternal: vi.fn(async (_url: string) => {}),
  runCommand: vi.fn<(command: unknown, input: unknown) => void>(),
  commands: { checkStarred: {}, star: {} },
  starred: { value: false, failed: false, starWorks: true, duringCheck: () => {} },
  page: {
    focused: true,
    activeElement: null as { matches: (selector: string) => boolean } | null,
    events: new EventTarget(),
  },
}));
vi.mock("./ui/toast", () => ({ toastManager: { add, update, close: vi.fn() } }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/sourceControl", () => ({ sourceControlEnvironment: commands }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async (_registry: unknown, command: unknown, input: unknown) => {
    runCommand(command, input);
    if (command === commands.star) return { _tag: "Success", value: starred.starWorks };
    starred.duringCheck();
    return starred.failed ? { _tag: "Failure" } : { _tag: "Success", value: starred.value };
  },
}));

const environmentId = EnvironmentId.make("environment-1");
const IDLE_MS = 30_000;

function setup({ sent = 0, writable = true, alreadyStarred = false } = {}) {
  add.mockReset();
  update.mockReset();
  openExternal.mockClear();
  runCommand.mockClear();
  starred.value = alreadyStarred;
  starred.failed = false;
  starred.starWorks = true;
  starred.duringCheck = () => {};
  page.focused = true;
  page.activeElement = null;
  page.events = new EventTarget();
  const store = new Map([["t3code:github-star-prompt:sent", String(sent)]]);
  vi.stubGlobal("document", {
    hasFocus: () => page.focused,
    get activeElement() {
      return page.activeElement;
    },
  });
  vi.stubGlobal("window", {
    addEventListener: page.events.addEventListener.bind(page.events),
    removeEventListener: page.events.removeEventListener.bind(page.events),
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (!writable) throw new Error("QuotaExceededError");
        store.set(key, value);
      },
    },
  });
  return store;
}

// A fresh module import stands in for an app reload; storage survives it.
async function startSession() {
  vi.resetModules();
  const session = await import("./GitHubStarPrompt");
  return {
    // Sends a prompt, then leaves the page idle long enough to ask.
    send: async () => {
      const sent = session.recordPromptSent(environmentId);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await sent;
    },
    sendWithoutWaiting: () => void session.recordPromptSent(environmentId),
  };
}

// The toast's handlers ignore their click event.
const click = (props: unknown) => (props as { onClick: () => unknown }).onClick();

describe("recordPromptSent", () => {
  vi.useFakeTimers();

  it("asks only after the focused page is idle", async () => {
    setup({ sent: 5 });
    (await startSession()).sendWithoutWaiting();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    page.events.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(add).not.toHaveBeenCalled();

    page.focused = false;
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(add).not.toHaveBeenCalled();

    page.focused = true;
    page.activeElement = { matches: (selector) => selector.includes("iframe") };
    page.events.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(add).not.toHaveBeenCalled();

    page.activeElement = null;
    page.events.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(add).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("asks after five prompts, once per session, and never again once closed", async () => {
    setup();
    let session = await startSession();
    for (let sent = 0; sent < 5; sent++) await session.send();
    expect(add).not.toHaveBeenCalled();

    await session.send();
    await session.send();
    expect(add).toHaveBeenCalledOnce();

    session = await startSession();
    await session.send();
    expect(add).toHaveBeenCalledTimes(2);

    add.mock.lastCall?.[0].onClose?.();
    session = await startSession();
    for (let sent = 0; sent < 10; sent++) await session.send();
    expect(add).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("never asks when a dismissal could not be saved", async () => {
    setup({ sent: 5, writable: false });
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never asks once the environment's GitHub account starred the repo", async () => {
    setup({ sent: 5, alreadyStarred: true });
    await (await startSession()).send();
    starred.value = false;
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("skips an unavailable server check without permanently dismissing", async () => {
    const store = setup({ sent: 5 });
    starred.failed = true;
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    expect(store.has("t3code:github-star-prompt:dismissed")).toBe(false);
    starred.failed = false;
    await (await startSession()).send();
    expect(add).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("never asks when another tab dismisses it during the star check", async () => {
    const store = setup({ sent: 5 });
    starred.duringCheck = () => store.set("t3code:github-star-prompt:dismissed", "true");
    await (await startSession()).send();
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("stars on click, opens GitHub when starring fails, and asks for a click once the click expired", async () => {
    const store = setup({ sent: 5 });
    await (await startSession()).send();
    expect(add.mock.lastCall?.[0]).toMatchObject({
      title: "Enjoying T3CodeJP?",
      description: "Give YmSaki/t3codeJP a star on GitHub to let us know!",
    });
    expect(runCommand).toHaveBeenCalledWith(
      commands.checkStarred,
      expect.objectContaining({
        input: expect.objectContaining({ repository: "YmSaki/t3codeJP" }),
      }),
    );

    click(add.mock.lastCall?.[0].actionProps);
    await vi.advanceTimersByTimeAsync(0);
    expect(runCommand).toHaveBeenCalledWith(
      commands.star,
      expect.objectContaining({
        input: expect.objectContaining({ repository: "YmSaki/t3codeJP" }),
      }),
    );
    expect(update.mock.lastCall?.[1]).toMatchObject({
      title: "Thanks for the star!",
      description: "It really helps T3CodeJP grow.",
    });
    expect(store.get("t3code:github-star-prompt:dismissed")).toBe("true");
    expect(openExternal).not.toHaveBeenCalled();

    setup({ sent: 5 });
    starred.starWorks = false;
    await (await startSession()).send();
    click(add.mock.lastCall?.[0].actionProps);
    await vi.advanceTimersByTimeAsync(0);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/YmSaki/t3codeJP");
    expect(update.mock.lastCall?.[1]).not.toMatchObject({
      actionProps: { children: "Open GitHub" },
    });

    setup({ sent: 5 });
    starred.starWorks = false;
    vi.stubGlobal("navigator", { userActivation: { isActive: false } });
    await (await startSession()).send();
    click(add.mock.lastCall?.[0].actionProps);
    await vi.advanceTimersByTimeAsync(0);
    const fallback = update.mock.lastCall?.[1];
    expect(fallback).toMatchObject({ actionProps: { children: "Open GitHub" } });
    expect(openExternal).not.toHaveBeenCalled();
    click(typeof fallback === "object" ? fallback.actionProps : undefined);
    expect(openExternal).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("uses VITE_GITHUB_STAR_REPOSITORY consistently for copy, API calls, and fallback links", async () => {
    setup({ sent: 5 });
    vi.stubEnv("VITE_GITHUB_STAR_REPOSITORY", "example/custom-fork");
    starred.starWorks = false;
    await (await startSession()).send();
    expect(add.mock.lastCall?.[0]).toMatchObject({
      description: "Give example/custom-fork a star on GitHub to let us know!",
    });
    expect(runCommand).toHaveBeenCalledWith(
      commands.checkStarred,
      expect.objectContaining({
        input: expect.objectContaining({ repository: "example/custom-fork" }),
      }),
    );
    click(add.mock.lastCall?.[0].actionProps);
    await vi.advanceTimersByTimeAsync(0);
    expect(runCommand).toHaveBeenCalledWith(
      commands.star,
      expect.objectContaining({
        input: expect.objectContaining({ repository: "example/custom-fork" }),
      }),
    );
    expect(openExternal).toHaveBeenCalledWith("https://github.com/example/custom-fork");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["", "off", "false", "not-a-repo"])(
    "does not prompt or record counts when VITE_GITHUB_STAR_REPOSITORY=%j",
    async (configured) => {
      const store = setup({ sent: 5 });
      vi.stubEnv("VITE_GITHUB_STAR_REPOSITORY", configured);
      await (await startSession()).send();
      expect(runCommand).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(store.get("t3code:github-star-prompt:sent")).toBe("5");
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    },
  );
});
