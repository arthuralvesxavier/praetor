import type { RiskLevel } from "@/domain/enums";

/**
 * Chart colors (validated with the dataviz palette validator on a white surface:
 * all checks pass; aqua is below 3:1 contrast, so every chart ships visible
 * values and a table view). Text never uses these colors — only marks do.
 */
export const SERIES = {
  blue: "#2a78d6",
  orange: "#eb6834",
  aqua: "#1baf7a",
} as const;

/**
 * Risk uses the reserved status palette (good → critical). Never color alone:
 * every risk mark is accompanied by its pt-BR label in legend, tooltip and table.
 */
export const RISK_COLORS: Record<RiskLevel, string> = {
  low: "#0ca30c",
  medium: "#fab219",
  high: "#ec835a",
  critical: "#d03b3b",
};

/** Overdue/critical marks (e.g. the "Vencidos" column). */
export const CRITICAL = "#d03b3b";
