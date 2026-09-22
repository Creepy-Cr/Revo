/**
 * Contract guards for the proposal response shape.
 *
 * The list endpoint serves two different things through one schema: real rows
 * from the database and the in-memory safety drill, which reports its own
 * display-only phases. Tightening `status` into an enum reads like an
 * improvement and quietly 500s the whole endpoint the moment a drill is
 * running, so that combination is pinned here.
 */
import { describe, expect, it } from "vitest";
import { ListTreasuryProposalsResponse } from "@workspace/api-zod";

describe("proposal response contract", () => {
  it("parses the in-memory drill's display-only status", () => {
    for (const status of ["PENDING", "EXECUTING", "EXECUTED"]) {
      expect(() =>
        ListTreasuryProposalsResponse.parse([
          {
            id: "revo-drill-1",
            title: "[DRILL] Emergency exit",
            summary: "s",
            status,
            createdAt: new Date().toISOString(),
            action: "a",
            safetyChecks: ["x"],
            command: "c",
          },
        ]),
      ).not.toThrow();
    }
  });

  it("parses a settled proposal carrying its transaction", () => {
    const parsed = ListTreasuryProposalsResponse.parse([
      {
        id: "p-1", title: "t", summary: "s", status: "executed",
        createdAt: new Date().toISOString(), action: "a", safetyChecks: [], command: "c",
        executionTxHash: "0xabc", explorerTxUrl: "https://explorer.arc.io/tx/0xabc",
      },
    ]);
    expect(parsed[0]!.explorerTxUrl).toContain("0xabc");
  });
});
