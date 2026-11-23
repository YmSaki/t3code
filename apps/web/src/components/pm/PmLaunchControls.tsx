import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PmWorkerPolicy, ThreadId, ThreadRole } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { BotIcon } from "lucide-react";
import { useState } from "react";

import { pmBoardEnvironment, usePmBoardActions } from "~/state/pmBoard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface PmSessionLaunchButtonProps {
  readonly metaProjectId: string;
  readonly metaProjectName: string;
  readonly disabled?: boolean | undefined;
  readonly onLaunchPmSession: (input: {
    readonly metaProjectId: string;
    readonly role: ThreadRole;
  }) => void | Promise<void>;
}

/** One-click PM session launch button for MetaProject dashboards. */
export function PmSessionLaunchButton(props: PmSessionLaunchButtonProps) {
  const gt = useGT();
  const [launching, setLaunching] = useState(false);

  const handleClick = async () => {
    if (launching || props.disabled) return;
    setLaunching(true);
    await props.onLaunchPmSession({
      metaProjectId: props.metaProjectId,
      role: "pm",
    });
    setLaunching(false);
  };

  return (
    <Button
      size="sm"
      variant="default"
      disabled={props.disabled || launching}
      aria-label={gt("Start PM session for {name}", { name: props.metaProjectName })}
      onClick={() => void handleClick()}
    >
      <BotIcon className="size-4" aria-hidden />
      <span>
        <T>Start PM Session</T>
      </span>
    </Button>
  );
}

export interface PmThreadRoleSwitchProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly role: ThreadRole;
  readonly metaProjectId?: string | null | undefined;
  readonly policy?: PmWorkerPolicy | undefined;
  readonly onRoleChanged?: ((role: ThreadRole) => void) | undefined;
}

/** Switches an existing thread between standard and PM roles. */
export function PmThreadRoleSwitch(props: PmThreadRoleSwitchProps) {
  const gt = useGT();
  const actions = usePmBoardActions();
  const canSetRole = useAtomValue(pmBoardEnvironment.setRole.permissionAtom(props.environmentId));
  const [busy, setBusy] = useState(false);

  const isPm = props.role === "pm";
  const isWorker = props.role === "worker";

  const handleToggle = async (checked: boolean) => {
    if (busy || isWorker) return;
    const nextRole: ThreadRole = checked ? "pm" : "standard";
    setBusy(true);
    const result = await actions.setRole({
      environmentId: props.environmentId,
      threadId: props.threadId,
      role: nextRole,
      metaProjectId: props.metaProjectId,
      policy: props.policy,
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not change thread role"),
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    } else if (result._tag === "Success") {
      props.onRoleChanged?.(result.value.role);
    }
  };

  if (isWorker) {
    return (
      <Badge variant="info" size="sm">
        <BotIcon className="size-3" aria-hidden />
        <span>
          <T>Worker thread</T>
        </span>
      </Badge>
    );
  }

  return (
    <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground">
      <BotIcon className="size-3.5 text-primary" aria-hidden />
      <span>
        <T>PM thread</T>
      </span>
      <Switch
        size="sm"
        checked={isPm}
        disabled={!canSetRole || busy}
        aria-label={gt("Toggle PM role for this thread")}
        onCheckedChange={(checked) => void handleToggle(checked)}
      />
    </label>
  );
}
