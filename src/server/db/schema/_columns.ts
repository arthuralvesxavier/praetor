import { timestamp, uuid } from "drizzle-orm/pg-core";

/** Primary key used by every table. */
export const id = () => uuid("id").primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Soft delete marker. Rows with `deleted_at` set must be excluded from every read. */
export const deletedAt = () => timestamp("deleted_at", { withTimezone: true, mode: "date" });

export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
