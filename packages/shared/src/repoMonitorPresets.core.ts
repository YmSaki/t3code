import type { EnvironmentId, ProjectId, RuntimeMode, ThreadId } from "@t3tools/contracts";

import type {
  RepoMonitorEventKindValue,
  RepoMonitorFilterCriteria,
} from "./repoMonitorEval.core.ts";

export type RepoMonitorPresetId =
  | "pr_review_comment_autofix"
  | "new_issue_notify_pm"
  | "main_merge_verification"
  | "branch_push_review";

export type RepoMonitorActionKindValue = "notify_pm" | "launch_thread" | "send_to_thread";

export interface RepoMonitorPreset {
  readonly id: RepoMonitorPresetId;
  readonly name: string;
  readonly description: string;
  readonly eventKinds: ReadonlyArray<RepoMonitorEventKindValue>;
  readonly defaultFilter: RepoMonitorFilterCriteria;
  readonly actionKind: RepoMonitorActionKindValue;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly promptTemplate: string;
  readonly defaultCooldownSec: number;
  readonly defaultMaxTriggersPerHour: number;
}

export interface RepoMonitorRuleOverrides {
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly filter?: Partial<RepoMonitorFilterCriteria>;
  readonly actionKind?: RepoMonitorActionKindValue;
  readonly targetThreadId?: ThreadId | null;
  readonly runtimeMode?: RuntimeMode;
  readonly promptTemplate?: string;
  readonly cooldownSec?: number;
  readonly maxTriggersPerHour?: number;
}

export interface CreateRepoMonitorRuleFromPresetInput {
  readonly presetId: RepoMonitorPresetId;
  readonly id: string;
  readonly projectId: ProjectId;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly overrides?: RepoMonitorRuleOverrides;
}

export interface RepoMonitorGeneratedRule {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly environmentId?: EnvironmentId;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly eventKinds: ReadonlyArray<RepoMonitorEventKindValue>;
  readonly filter: RepoMonitorFilterCriteria;
  readonly actionKind: RepoMonitorActionKindValue;
  readonly targetThreadId: ThreadId | null;
  readonly runtimeMode: RuntimeMode;
  readonly promptTemplate: string;
  readonly cooldownSec: number;
  readonly maxTriggersPerHour: number;
  readonly presetId: RepoMonitorPresetId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const REPO_MONITOR_PRESETS: ReadonlyArray<RepoMonitorPreset> = [
  {
    id: "pr_review_comment_autofix",
    name: "PRレビューコメントに自動対応",
    description:
      "Pull Request に新しいレビューコメントが付いた際、対象ブランチのチェックアウト上で確認・修正スレッドを起動します。",
    eventKinds: ["pr_comment"],
    defaultFilter: {
      excludeBots: true,
    },
    actionKind: "launch_thread",
    defaultRuntimeMode: "auto-accept-edits",
    promptTemplate: [
      "PR #{{pr.number}} ({{title}}) に {{author}} から新しいレビューコメントが投稿されました。",
      "対象ブランチ: {{branch}}",
      "対象ファイル: {{path}}",
      "URL: {{url}}",
      "",
      "コメント内容:",
      "{{body}}",
      "",
      "指摘内容を確認し、必要なコード修正とテスト実行を行ってください。",
    ].join("\n"),
    defaultCooldownSec: 60,
    defaultMaxTriggersPerHour: 20,
  },
  {
    id: "new_issue_notify_pm",
    name: "新規IssueをPMへ起票通知",
    description:
      "新しい Issue が起票された際、PM スレッドへ内容を通知してトリアージとタスク分解を促します。",
    eventKinds: ["issue_opened"],
    defaultFilter: {
      excludeBots: true,
    },
    actionKind: "notify_pm",
    defaultRuntimeMode: "approval-required",
    promptTemplate: [
      "新規 Issue #{{issue.key}} が {{author}} によって起票されました。",
      "タイトル: {{title}}",
      "ラベル: {{labels[]}}",
      "URL: {{url}}",
      "",
      "本文:",
      "{{body}}",
      "",
      "重要度・影響範囲をトリアージし、対応方針とタスク割当を提案してください。",
    ].join("\n"),
    defaultCooldownSec: 0,
    defaultMaxTriggersPerHour: 30,
  },
  {
    id: "main_merge_verification",
    name: "mainブランチマージ後検証",
    description:
      "main ブランチへ Pull Request がマージされた際、ビルド・回帰テスト検証スレッドを自動起動します。",
    eventKinds: ["pr_merged"],
    defaultFilter: {
      branchGlobs: ["main"],
      excludeBots: false,
    },
    actionKind: "launch_thread",
    defaultRuntimeMode: "auto",
    promptTemplate: [
      "main ブランチへ PR #{{pr.number}} ({{title}}) がマージされました。",
      "マージ先ブランチ: {{baseBranch}}",
      "コミット: {{commitSha}}",
      "URL: {{url}}",
      "",
      "マージ後の統合ビルドおよび主要テストスイートを実行し、回帰がないか検証してください。",
    ].join("\n"),
    defaultCooldownSec: 120,
    defaultMaxTriggersPerHour: 15,
  },
  {
    id: "branch_push_review",
    name: "指定ブランチpushでレビュー起動",
    description:
      "指定ブランチパターン（feature/**, fix/** 等）への新規 push を検知し、差分レビューを起動します。",
    eventKinds: ["branch_push"],
    defaultFilter: {
      branchGlobs: ["feature/**", "fix/**"],
      excludeBots: true,
    },
    actionKind: "launch_thread",
    defaultRuntimeMode: "approval-required",
    promptTemplate: [
      "ブランチ {{branch}} に新しいコミット {{commitSha}} が push されました（作成者: {{author}}）。",
      "コミット概要: {{title}}",
      "URL: {{url}}",
      "",
      "直近の変更差分をレビューし、潜在的なバグ・型不整合・テスト不足があれば報告してください。",
    ].join("\n"),
    defaultCooldownSec: 120,
    defaultMaxTriggersPerHour: 20,
  },
];

export function listRepoMonitorPresets(): ReadonlyArray<RepoMonitorPreset> {
  return REPO_MONITOR_PRESETS;
}

export function getRepoMonitorPreset(presetId: string): RepoMonitorPreset | undefined {
  return REPO_MONITOR_PRESETS.find((preset) => preset.id === presetId);
}

function cloneFilter(
  base: RepoMonitorFilterCriteria,
  override?: Partial<RepoMonitorFilterCriteria>,
): RepoMonitorFilterCriteria {
  const merged: RepoMonitorFilterCriteria = {
    ...base,
    ...override,
  };
  return {
    ...(merged.branchGlobs ? { branchGlobs: [...merged.branchGlobs] } : {}),
    ...(merged.requiredLabels ? { requiredLabels: [...merged.requiredLabels] } : {}),
    ...(merged.excludedLabels ? { excludedLabels: [...merged.excludedLabels] } : {}),
    ...(merged.allowedAuthors ? { allowedAuthors: [...merged.allowedAuthors] } : {}),
    ...(merged.excludedAuthors ? { excludedAuthors: [...merged.excludedAuthors] } : {}),
    ...(merged.excludeBots !== undefined ? { excludeBots: merged.excludeBots } : {}),
    ...(merged.keywords ? { keywords: [...merged.keywords] } : {}),
  };
}

export function createRepoMonitorRuleFromPreset(
  input: CreateRepoMonitorRuleFromPresetInput,
): RepoMonitorGeneratedRule {
  const preset = getRepoMonitorPreset(input.presetId);
  if (!preset) {
    throw new Error(`Unknown RepoMonitorPresetId: ${input.presetId}`);
  }

  const overrides = input.overrides;
  const updatedAt = input.updatedAt ?? input.createdAt;

  return {
    id: input.id,
    projectId: input.projectId,
    ...(overrides?.environmentId !== undefined ? { environmentId: overrides.environmentId } : {}),
    name: overrides?.name?.trim() || preset.name,
    description: overrides?.description ?? preset.description,
    enabled: overrides?.enabled ?? true,
    eventKinds: [...preset.eventKinds],
    filter: cloneFilter(preset.defaultFilter, overrides?.filter),
    actionKind: overrides?.actionKind ?? preset.actionKind,
    targetThreadId: overrides?.targetThreadId ?? null,
    runtimeMode: overrides?.runtimeMode ?? preset.defaultRuntimeMode,
    promptTemplate: overrides?.promptTemplate?.trim() || preset.promptTemplate,
    cooldownSec: overrides?.cooldownSec ?? preset.defaultCooldownSec,
    maxTriggersPerHour: overrides?.maxTriggersPerHour ?? preset.defaultMaxTriggersPerHour,
    presetId: preset.id,
    createdAt: input.createdAt,
    updatedAt,
  };
}
