import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  IMPORT_BATCH_STATUS_LABELS,
  IMPORT_ROW_ACTION_LABELS,
  ISSUE_LEVEL_LABELS,
  type ImportBatchStatus,
  type ImportRowAction,
  type IssueLevel,
} from "@/domain/enums";
import { formatNumber } from "@/lib/format";
import { IMPORT_BATCH_STATUS_TONES, IMPORT_ROW_ACTION_TONES, ISSUE_LEVEL_TONES } from "../labels";

export function BatchStatusBadge({ status }: { status: ImportBatchStatus }) {
  return <StatusBadge label={IMPORT_BATCH_STATUS_LABELS[status]} tone={IMPORT_BATCH_STATUS_TONES[status]} />;
}

export function RowActionBadge({ action }: { action: ImportRowAction }) {
  return <StatusBadge label={IMPORT_ROW_ACTION_LABELS[action]} tone={IMPORT_ROW_ACTION_TONES[action]} />;
}

const LEVEL_ICONS: Record<IssueLevel, React.ReactNode> = {
  error: <CircleAlert />,
  warning: <TriangleAlert />,
  info: <Info />,
};

export function IssueLevelBadge({ level }: { level: IssueLevel }) {
  return (
    <Badge tone={ISSUE_LEVEL_TONES[level]} icon={LEVEL_ICONS[level]}>
      {ISSUE_LEVEL_LABELS[level]}
    </Badge>
  );
}

const LEVEL_PLURAL: Record<IssueLevel, [string, string]> = {
  error: ["erro", "erros"],
  warning: ["alerta", "alertas"],
  info: ["informação", "informações"],
};

/** Compact count of a row's issues by level ("1 erro", "2 alertas"). */
export function IssueCounts({ issues }: { issues: readonly { level: IssueLevel }[] }) {
  const counts: Record<IssueLevel, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.level] += 1;
  const levels = (["error", "warning", "info"] as const).filter((l) => counts[l] > 0);
  if (levels.length === 0) return <span className="text-xs text-muted-foreground">Nenhuma</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {levels.map((l) => (
        <Badge key={l} tone={ISSUE_LEVEL_TONES[l]} icon={LEVEL_ICONS[l]}>
          {formatNumber(counts[l])} {LEVEL_PLURAL[l][counts[l] === 1 ? 0 : 1]}
        </Badge>
      ))}
    </span>
  );
}
