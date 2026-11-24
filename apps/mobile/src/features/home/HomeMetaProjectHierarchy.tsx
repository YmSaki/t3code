import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useMetaProjectTrees } from "../../state/metaProjects";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import {
  canOpenMetaProjectThread,
  countMetaProjectThreads,
  mergeMetaProjectTrees,
  type MetaProjectThreadNode,
  type MetaProjectTreeNode,
} from "./metaProjectHierarchy.logic";

type ThreadTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** MetaProjects above Home's thread list; draws nothing until a machine reports one. */
export function HomeMetaProjectHierarchy() {
  const selectDetail = useSelectWorkspaceDetail();
  const openThread = (target: ThreadTarget) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(target.environmentId), threadId: String(target.threadId) },
    });
  const connected = useConnectedEnvironmentIds();
  const metaProjects = mergeMetaProjectTrees(useMetaProjectTrees(connected));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  if (metaProjects.length === 0) return null;
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <View className="gap-2 px-3 pb-2">
      {metaProjects.map((node) => (
        <MetaProjectCard
          key={node.metaProjectId}
          node={node}
          expanded={expanded}
          onToggle={toggle}
          connected={connected}
          onOpenThread={openThread}
        />
      ))}
    </View>
  );
}

function MetaProjectCard(props: {
  readonly node: MetaProjectTreeNode;
  readonly expanded: ReadonlySet<string>;
  readonly connected: ReadonlyArray<string>;
  readonly onToggle: (key: string) => void;
  readonly onOpenThread: (target: ThreadTarget) => void;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { node } = props;
  const open = props.expanded.has(node.metaProjectId);
  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card">
      <DisclosureRow
        icon={node.pinned ? "pin" : "square.grid.2x2"}
        label={node.title}
        detail={gt("{count} threads", { count: countMetaProjectThreads(node) })}
        open={open}
        onPress={() => props.onToggle(node.metaProjectId)}
      />
      {open ? (
        <View className="pb-1">
          {node.pmThreads.map((thread) => (
            <ThreadRow
              key={`pm:${thread.environmentId}:${thread.threadId}`}
              icon="person.2"
              thread={thread}
              connected={props.connected}
              onOpen={props.onOpenThread}
              trailingLabel={gt("Board")}
              onTrailing={() =>
                navigation.navigate("PmBoard", {
                  environmentId: thread.environmentId,
                  pmThreadId: thread.threadId,
                })
              }
            />
          ))}
          {node.crossCuttingThreads.map((thread) => (
            <ThreadRow
              key={`x:${thread.environmentId}:${thread.threadId}`}
              icon="flowchart"
              thread={thread}
              connected={props.connected}
              onOpen={props.onOpenThread}
            />
          ))}
          {node.repositories.map((repository) => {
            const key = `${node.metaProjectId}:${repository.environmentId}:${repository.projectId}`;
            const repositoryOpen = props.expanded.has(key);
            return (
              <View key={key}>
                <DisclosureRow
                  icon="folder"
                  label={repository.title}
                  detail={
                    props.connected.includes(repository.environmentId)
                      ? repository.environmentBadge.label
                      : gt("{machine} · offline", { machine: repository.environmentBadge.label })
                  }
                  open={repositoryOpen}
                  disabled={repository.threads.length === 0}
                  inset
                  onPress={() => props.onToggle(key)}
                />
                {repositoryOpen
                  ? repository.threads.map((thread) => (
                      <ThreadRow
                        key={`${thread.environmentId}:${thread.threadId}`}
                        icon="text.bubble"
                        thread={thread}
                        connected={props.connected}
                        inset
                        onOpen={props.onOpenThread}
                      />
                    ))
                  : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function DisclosureRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly detail: string;
  readonly open: boolean;
  readonly disabled?: boolean;
  readonly inset?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.detail}`}
      accessibilityState={{ expanded: props.open, disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View
        className={`flex-row items-center gap-2.5 py-2.5 pr-3 ${props.inset ? "pl-7" : "pl-3"}`}
      >
        <SymbolView name={props.icon} size={16} tintColorClassName="accent-icon-muted" />
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.detail}
        </Text>
        {props.disabled ? null : (
          <SymbolView
            name={props.open ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        )}
      </View>
    </RowPressable>
  );
}

function ThreadRow(props: {
  readonly icon: AppSymbolName;
  readonly connected: ReadonlyArray<string>;
  readonly thread: MetaProjectThreadNode;
  readonly inset?: boolean;
  readonly onOpen: (target: ThreadTarget) => void;
  readonly trailingLabel?: string;
  readonly onTrailing?: () => void;
}) {
  const { thread } = props;
  const enabled = canOpenMetaProjectThread(thread, props.connected);
  return (
    <View className="flex-row items-center">
      <RowPressable
        accessibilityRole="link"
        accessibilityState={{ disabled: !enabled }}
        disabled={!enabled}
        className="min-w-0 flex-1"
        onPress={() =>
          props.onOpen({ environmentId: thread.environmentId, threadId: thread.threadId })
        }
      >
        <View
          className={`flex-row items-center gap-2.5 py-2 pr-3 ${props.inset ? "pl-12" : "pl-7"}`}
          style={{ opacity: enabled ? 1 : 0.5 }}
        >
          <SymbolView name={props.icon} size={14} tintColorClassName="accent-icon-muted" />
          <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
            {thread.title}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {thread.environmentBadge.label}
          </Text>
          {thread.isActive ? <View className="size-2 rounded-full bg-primary" /> : null}
        </View>
      </RowPressable>
      {props.trailingLabel && props.onTrailing ? (
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={props.trailingLabel}
          className="rounded-full px-3 py-2"
          disabled={!enabled}
          onPress={props.onTrailing}
        >
          <Text className="font-t3-medium text-xs text-primary">{props.trailingLabel}</Text>
        </RowPressable>
      ) : null}
    </View>
  );
}
