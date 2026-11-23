import { createFileRoute } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { DownloadIcon } from "lucide-react";

import { UnifiedImportWizard } from "../components/import/UnifiedImportWizard";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";

function SettingsImportRoute() {
  const gt = useGT();
  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        id="import"
        title={gt("Import")}
        icon={<DownloadIcon className="size-4 text-muted-foreground" />}
        variant="plain"
      >
        <UnifiedImportWizard />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/import")({
  component: SettingsImportRoute,
});
