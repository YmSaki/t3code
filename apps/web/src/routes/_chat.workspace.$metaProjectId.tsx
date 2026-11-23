import { MetaProjectId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { MetaProjectDashboard } from "../components/metaProject/MetaProjectDashboard";
import { usePrimaryEnvironmentId } from "../state/environments";

function WorkspaceMetaProjectRouteComponent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const metaProjectId = MetaProjectId.make(params.metaProjectId);

  return (
    <MetaProjectDashboard
      environmentId={primaryEnvironmentId}
      metaProjectId={metaProjectId}
      onOpenThread={({ environmentId, threadId }) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId },
        });
      }}
      onDeleted={() => {
        void navigate({ to: "/" });
      }}
    />
  );
}

export const Route = createFileRoute("/_chat/workspace/$metaProjectId")({
  component: WorkspaceMetaProjectRouteComponent,
});
