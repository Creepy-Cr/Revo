import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db, pool, workerStateTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { withCustodyLock } from "./arc-chain";

const insertedIds: string[] = [];

afterAll(async () => {
  for (const id of insertedIds) {
    await db.delete(workerStateTable).where(eq(workerStateTable.id, id));
  }
});

describe("custody advisory-lock executor", () => {
  it(
    "completes one distinct-treasury operation per pool slot without nested-pool starvation",
    async () => {
      const poolMaximum = pool.options.max;
      expect(poolMaximum).toBeGreaterThan(0);

      const operations = Array.from({ length: poolMaximum }, async () => {
        const suffix = randomUUID();
        const id = `custody-pool-regression-${suffix}`;
        insertedIds.push(id);
        await withCustodyLock(`treasury-${suffix}`, async (custodyTx) => {
          // Both statements must use the executor bound to the already-held
          // advisory-lock client. A global-db call here deadlocks when every
          // pool slot is occupied by a distinct treasury operation.
          await custodyTx.execute(sql`SELECT pg_sleep(0.02)`);
          await custodyTx.insert(workerStateTable).values({ id });
        });
      });

      await Promise.race([
        Promise.all(operations),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("custody operations starved waiting for nested pool clients")),
            2_000,
          ).unref();
        }),
      ]);

      const rows = await db
        .select({ id: workerStateTable.id })
        .from(workerStateTable)
        .where(sql`${workerStateTable.id} LIKE 'custody-pool-regression-%'`);
      const inserted = new Set(insertedIds);
      expect(rows.filter((row) => inserted.has(row.id))).toHaveLength(poolMaximum);
    },
    3_000,
  );
});