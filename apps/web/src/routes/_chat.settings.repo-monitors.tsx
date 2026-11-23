import { createFileRoute } from "@tanstack/react-router";

import { RepoMonitorPanel } from "../components/repoMonitor/RepoMonitorPanel";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsRepoMonitorsRoute() {
  return (
    <SettingsPageContainer>
      <RepoMonitorPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/repo-monitors")({
  component: SettingsRepoMonitorsRoute,
});
