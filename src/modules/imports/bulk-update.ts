/**
 * Set-based UPDATE for rows that change different columns (import commit).
 * Rows are grouped by the set of changed columns and each group is written with
 * `UPDATE … FROM (VALUES …)`, chunked, instead of one statement per row.
 * Values travel as text parameters and are cast to the column's SQL type.
 */
import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@/server/db/client";

export type RowChanges = { id: string; changes: Record<string, unknown> };

function toParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Applies `changes` (keys = Drizzle property names of `table`) to each row id.
 * `where` is ANDed to every statement (tenant scope); `updatedAt` is written to
 * the table's `updatedAt` column (raw SQL skips Drizzle's `$onUpdate`).
 * Returns the number of statements executed.
 */
export async function bulkUpdateById(
  db: DbOrTx,
  table: PgTable,
  rows: readonly RowChanges[],
  opts: { where?: SQL; updatedAt?: Date; chunkSize?: number } = {},
): Promise<number> {
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const groups = new Map<string, RowChanges[]>();
  for (const row of rows) {
    const keys = Object.keys(row.changes)
      .filter((k) => row.changes[k] !== undefined)
      .sort();
    if (keys.length === 0) continue;
    for (const k of keys) {
      if (!columns[k] || k === "id") throw new Error(`bulk_update_unknown_column:${k}`);
    }
    const signature = keys.join(",");
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature)!.push(row);
  }

  const tableName = sql.identifier(getTableName(table));
  const touched = opts.updatedAt && columns.updatedAt ? columns.updatedAt : null;
  const size = Math.max(1, opts.chunkSize ?? 200);
  let statements = 0;
  for (const [signature, list] of groups) {
    const keys = signature.split(",");
    const sets = keys.map((k, i) => sql`${sql.identifier(columns[k].name)} = ${sql.raw(`v.c${i}::${columns[k].getSQLType()}`)}`);
    if (touched) sets.push(sql`${sql.identifier(touched.name)} = ${opts.updatedAt!.toISOString()}::timestamptz`);
    const alias = sql.raw(`v(id, ${keys.map((_, i) => `c${i}`).join(", ")})`);
    for (let i = 0; i < list.length; i += size) {
      const part = list.slice(i, i + size);
      const values = sql.join(
        part.map((r) => sql`(${r.id}, ${sql.join(keys.map((k) => sql`${toParam(r.changes[k])}`), sql`, `)})`),
        sql`, `,
      );
      await db.execute(sql`
        update ${tableName} set ${sql.join(sets, sql`, `)}
        from (values ${values}) as ${alias}
        where ${tableName}."id" = v.id::uuid${opts.where ? sql` and ${opts.where}` : sql``}`);
      statements += 1;
    }
  }
  return statements;
}
