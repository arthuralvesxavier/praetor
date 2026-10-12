/** Pure text helpers for the app header (unit-tested in tests/shell/shell-format.test.ts). */

const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

/** "12" / "99+". */
export function formatBadgeCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n > 99 ? "99+" : String(Math.floor(n));
}

/** Accessible name of the alerts bell, e.g. "Alertas e pendências: 5 abertos, 2 críticos". */
export function alertsBellLabel(counts: { total: number; critical: number }): string {
  if (counts.total <= 0) return "Alertas e pendências: nenhum alerta aberto";
  const open = counts.total === 1 ? "1 aberto" : `${integer.format(counts.total)} abertos`;
  if (counts.critical <= 0) return `Alertas e pendências: ${open}`;
  const critical = counts.critical === 1 ? "1 crítico" : `${integer.format(counts.critical)} críticos`;
  return `Alertas e pendências: ${open}, ${critical}`;
}
