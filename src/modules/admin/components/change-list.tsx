import type { EntityType } from "@/domain/enums";
import { cn } from "@/lib/utils";
import { fieldLabel, formatChangeValue } from "../history-format";

export type ChangeListProps = {
  changes: Record<string, { from: unknown; to: unknown }> | null;
  entityType: EntityType | null;
  /** Names for ids that appear in the diff (users, units, teams). */
  names?: Record<string, string>;
  className?: string;
};

/** Field-level diff rendered as "Campo: de → para". Renders nothing when there are no changes. */
export function ChangeList({ changes, entityType, names = {}, className }: ChangeListProps) {
  const entries = Object.entries(changes ?? {});
  if (entries.length === 0) return null;
  return (
    <ul className={cn("mt-1 space-y-0.5 text-sm text-slate-700", className)}>
      {entries.map(([key, change]) => (
        <li key={key} className="break-words">
          <span className="font-medium text-slate-800">{fieldLabel(key)}:</span>{" "}
          <span className="text-muted-foreground">{formatChangeValue(key, change.from, entityType, names)}</span>{" "}
          <span aria-hidden="true">→</span>
          <span className="sr-only">para</span>{" "}
          <span>{formatChangeValue(key, change.to, entityType, names)}</span>
        </li>
      ))}
    </ul>
  );
}
