import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase } from "./helpers/db";
import { organizations } from "@/server/db/schema";

describe("database", () => {
  it("applies migrations on PGlite and round-trips a row", async () => {
    const { db, close } = await createTestDatabase();
    const [org] = await db.insert(organizations).values({ name: "Org", slug: "org" }).returning();
    expect(org.settings.ai.maxInputChars).toBeGreaterThan(0);
    const r = await db.execute(sql`select to_tsvector('portuguese', 'contratos') as v`);
    expect(r.rows.length).toBe(1);
    await close();
  });
});
