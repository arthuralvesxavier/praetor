/**
 * Helpers to build `{ value, label }` option lists for selects from the
 * `*_LABELS` maps in `@/domain/enums`.
 *
 *   optionsFromLabels(RISK_LEVEL_LABELS)
 *   optionsFromLabels(PROCESS_STATUS_LABELS, ["active", "suspended"]) // subset / custom order
 */
export type Option = { value: string; label: string };

export function optionsFromLabels<K extends string>(labels: Record<K, string>, order?: readonly K[]): Option[] {
  const keys = order ?? (Object.keys(labels) as K[]);
  return keys.map((value) => ({ value, label: labels[value] }));
}
