import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";
import { mobileAppScheme } from "../../lib/appScheme";

export function dismissEndedAgentLiveActivities() {
  AgentActivity.dismissEnded();
}

export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function startAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return AgentActivity.start({ ...props, appScheme: mobileAppScheme() }, undefined, staleDate);
}
