import {
  CLI_INSTALL_BIN_DIRNAME,
  CLI_INSTALL_PS1_FILE,
  CLI_INSTALL_SH_FILE,
  cliReleaseAssetUrl,
} from "@t3tools/shared/cliRelease";
import { DEFAULT_HOME_DIRECTORY } from "@t3tools/shared/productIdentity";
import { T } from "gt-react";
import { APP_VERSION } from "~/branding";
import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

/**
 * Setup steps for another computer: install `t3`, then run the action. Both installers are shown
 * because the browser showing this is often not the computer being set up.
 */
export function InstallT3Commands({
  action,
  className,
}: {
  readonly action: "connect" | "pair";
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">macOS, Linux</p>
      <CommandBlock
        command={`curl -fsSL ${cliReleaseAssetUrl(APP_VERSION, CLI_INSTALL_SH_FILE)} | sh`}
      />
      <p className="text-xs text-muted-foreground">
        <T>Then</T>
      </p>
      <CommandBlock
        command={`~/${DEFAULT_HOME_DIRECTORY}/${CLI_INSTALL_BIN_DIRNAME}/t3 ${action}`}
      />
      <p className="text-xs text-muted-foreground">Windows (PowerShell)</p>
      <CommandBlock
        command={`irm ${cliReleaseAssetUrl(APP_VERSION, CLI_INSTALL_PS1_FILE)} | iex`}
      />
      <p className="text-xs text-muted-foreground">
        <T>Then</T>
      </p>
      <CommandBlock
        command={`& "$HOME\\${DEFAULT_HOME_DIRECTORY}\\${CLI_INSTALL_BIN_DIRNAME}\\t3.cmd" ${action}`}
      />
    </div>
  );
}
