import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db, pool, workerStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { assertWorkerLease } from "./index";

const stateIds: string[] = [];

afterAll(async () => {
  for (const id of stateIds) {
    await db.delete(workerStateTable).where(eq(workerStateTable.id, id));
  }
});

describe("worker leadership fencing", () => {
  it("blocks takeover while the advisory fence is held and prevents a stale runner mutation", async () => {
    const lockKey = `worker-fence-test-${randomUUID()}`;
    const staleStateId = `worker-fence-stale-${randomUUID()}`;
    const freshStateId = `worker-fence-fresh-${randomUUID()}`;
    stateIds.push(staleStateId, freshStateId);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      const held = await first.query<{ held: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS held",
        [lockKey],
      );
      expect(held.rows[0]?.held).toBe(true);
      const blocked = await second.query<{ held: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS held",
        [lockKey],
      );
      expect(blocked.rows[0]?.held).toBe(false);

      let continueStale!: () => void;
      const staleGate = new Promise<void>((resolve) => {
        continueStale = resolve;
      });
      const staleController = new AbortController();
      const staleRun = (async () => {
        await staleGate;
        assertWorkerLease(staleController.signal);
        await db.insert(workerStateTable).values({ id: staleStateId });
      })();

      // Simulate lease ownership changing while the old runner is doing slow
      // read/RPC work. Its mandatory pre-mutation fence must stop the commit.
      staleController.abort(new Error("lease taken over"));
      continueStale();
      await expect(staleRun).rejects.toThrow("lease taken over");
      expect(
        await db.select().from(workerStateTable).where(eq(workerStateTable.id, staleStateId)),
      ).toHaveLength(0);

      await first.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      const takeover = await second.query<{ held: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS held",
        [lockKey],
      );
      expect(takeover.rows[0]?.held).toBe(true);

      const freshController = new AbortController();
      assertWorkerLease(freshController.signal);
      await db.insert(workerStateTable).values({ id: freshStateId });
      expect(
        await db.select().from(workerStateTable).where(eq(workerStateTable.id, freshStateId)),
      ).toHaveLength(1);
      await second.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    } finally {
      first.release();
      second.release();
    }
  });
});