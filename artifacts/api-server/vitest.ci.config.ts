import { defineConfig } from "vitest/config";

/**
 * The subset of the test suite that needs neither a PostgreSQL database nor
 * Arc RPC access. CI runs this; `pnpm run test` runs everything.
 *
 * Some of these modules still import the db client at load time, which only
 * checks that DATABASE_URL is set, so CI passes a placeholder value.
 */
export default defineConfig({
  test: {
    include: [
      "src/lib/appkit.test.ts",
      "src/lib/auth-origin.test.ts",
      "src/lib/proposal-contract.test.ts",
      "src/lib/rebalance-execution.test.ts",
      "src/lib/signals.test.ts",
      "src/lib/synthra.test.ts",
      "src/lib/tower.test.ts",
    ],
  },
});
