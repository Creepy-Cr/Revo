/**
 * The halts and limits on the OTHER way value leaves the treasury: a
 * withdrawal to a depositor's wallet.
 *
 * An approval sends a swap; a withdrawal sends the money itself. Both are
 * stopped by the same emergency pause, and the withdrawal additionally has to
 * fit three persisted caps - one per withdrawal, one rolling 24h total per
 * wallet, and one rolling 24h total for the whole treasury. All four checks
 * live in checkWithdrawalCaps, which the withdrawal route runs INSIDE its
 * reservation transaction, under the treasury transition lock, so that two
 * requests in flight at once cannot quietly share one cap's room.
 *
 * What is pinned here is that each of those refusals happens on its own, that
 * nothing is reserved and nothing is signed when one does, and that the caps
 * still hold when two withdrawals contend for the same room at the same
 * instant. Every test checks the custody signer was never reached: a 409 that
 * still signs a transfer is the failure that costs money.
 *
 * The database is the real development one, so the treasury id is unique per
 * run and every row it owns is deleted afterwards. Only the chain boundary is
 * stubbed, so a withdrawal that gets past the guards settles instantly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  auditEventsTable,
  alertsTable,
  db,
  onchainTransfersTable,
  securityControlsTable,
  treasuriesTable,
  treasuryStateTable,
} from "@workspace/db";
import {
  checkWithdrawalCaps,
  setEmergencyPause,
  setSecurityLimits,
  treasuryTransitionLock,
} from "../lib/security-controls";

const TEST_TREASURY_ID = `test-treasury-withdrawal-caps-${randomUUID()}`;
const TREASURY_ADDRESS = "0x00000000000000000000000000000000000Ae917";
const OPERATOR_WALLET = "0x0000000000000000000000000000000000000003";

/**
 * Small caps, so every refusal in this file is the one named in its test and
 * never an accidental collision with another limit.
 */
const PER_WITHDRAWAL_CAP = 100;
const WALLET_24H_CAP = 150;
const GLOBAL_24H_CAP = 250;
/** Liquid reserve and per-wallet deposits, both far above every cap. */
const LIQUID_UNITS = 5_000;
const DEPOSIT_PER_WALLET = 1_000;

process.env.CUSTODY_MASTER_SECRET ??= "test-only-custody-master-secret";

function randomHash(): Hex {
  const bytes = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  return `0x${bytes}` as Hex;
}

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return {
    ...actual,
    requireOperator: vi.fn(() => (req: any, _res: any, next: () => void) => {
      req.operator = {
        wallet: OPERATOR_WALLET,
        role: "admin",
        treasuryId: TEST_TREASURY_ID,
        sessionId: "test-session",
        sessionCreatedAt: new Date(),
      };
      next();
    }),
  };
});

/**
 * The chain boundary. signUsdcTransfer is the first thing a withdrawal
 * touches that could move money, so its call count IS the number of transfers
 * this treasury attempted to send.
 */
vi.mock("../lib/arc-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/arc-chain")>();
  return {
    ...actual,
    ensureTreasuryWallet: vi.fn(async () => ({
      address: TREASURY_ADDRESS,
      privateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    })),
    signUsdcTransfer: vi.fn(async () => ({
      hash: randomHash(),
      serialized: "0x00" as Hex,
      nonce: 3,
    })),
    broadcastSignedTransfer: vi.fn(async () => {}),
    confirmTransfer: vi.fn(async () => {}),
    getTransferRecoveryStatus: vi.fn(async () => "unknown" as const),
  };
});

// Issuer controls are read from Arc mainnet in production; these tests cover
// the treasury's own limits, so the issuer answers "not blocked" throughout.
vi.mock("../lib/custody-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/custody-policy")>();
  return {
    ...actual,
    isBlockedByIssuer: vi.fn(async () => ({
      tokenPaused: false,
      walletBlacklisted: false,
      destinationBlacklisted: false,
    })),
    assertIssuerAllows: vi.fn(async () => {}),
  };
});

// Keep the activity feed clean - tests must not surface fake entries in the UI.
vi.mock("../lib/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/state")>();
  return { ...actual, logActivity: vi.fn(async () => {}) };
});

/**
 * Audit writes are real, but spied: the withdrawal route's own audit write is
 * the one point between committing the reservation and reaching the custody
 * signer where a test can hold the request still and change the treasury
 * underneath it.
 */
vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, auditSafe: vi.fn(actual.auditSafe) };
});

const { signUsdcTransfer, withdrawalAuthMessage } = await import("../lib/arc-chain");
const { auditSafe } = await import("../lib/audit");
const { auditSafe: realAuditSafe } =
  await vi.importActual<typeof import("../lib/audit")>("../lib/audit");
const { default: app } = await import("../app");
const signTransfer = vi.mocked(signUsdcTransfer);
const audit = vi.mocked(auditSafe);

const walletA = privateKeyToAccount(generatePrivateKey());
const walletB = privateKeyToAccount(generatePrivateKey());
const walletC = privateKeyToAccount(generatePrivateKey());
const addressA = walletA.address.toLowerCase();
const addressB = walletB.address.toLowerCase();
const addressC = walletC.address.toLowerCase();

let baseUrl: string;
let server: ReturnType<typeof app.listen> | undefined;
let setupComplete = false;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** The exact body a depositor's browser posts, signed by that wallet. */
async function withdrawalBody(
  account: typeof walletA,
  amountUsdc: number,
): Promise<Record<string, unknown>> {
  const address = account.address.toLowerCase();
  const issuedAt = new Date().toISOString();
  const signature = await account.signMessage({
    message: withdrawalAuthMessage(address, amountUsdc.toString(), issuedAt),
  });
  return { address, amountUsdc, issuedAt, signature };
}

async function requestWithdrawal(
  account: typeof walletA,
  amountUsdc: number,
): Promise<Response> {
  return api("/treasury/wallet/withdrawals", {
    method: "POST",
    body: JSON.stringify(await withdrawalBody(account, amountUsdc)),
  });
}

async function treasuryUnits(): Promise<number> {
  const [state] = await db
    .select()
    .from(treasuryStateTable)
    .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
  return state!.usdcUnits;
}

async function withdrawals(wallet?: string) {
  const conditions = [
    eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID),
    eq(onchainTransfersTable.direction, "withdrawal"),
  ];
  if (wallet) conditions.push(eq(onchainTransfersTable.wallet, wallet));
  return db
    .select()
    .from(onchainTransfersTable)
    .where(and(...conditions));
}

/** USDC this treasury has committed to sending out and not refunded. */
async function outflowUsdc(): Promise<number> {
  const rows = await withdrawals();
  return rows
    .filter((row) => row.status !== "failed")
    .reduce((total, row) => total + row.amountUsdc, 0);
}

/**
 * The real pause path rather than a bare column write, so the flip takes the
 * same transition lock a withdrawal reservation takes and is ordered against
 * it exactly as production orders it.
 */
async function setPause(active: boolean, reason: string): Promise<void> {
  await setEmergencyPause({
    treasuryId: TEST_TREASURY_ID,
    active,
    reason,
    actorWallet: OPERATOR_WALLET,
    actorRole: "guardian",
  });
}

async function setLimits(
  maxPerWithdrawalUsdc: number,
  maxWallet24hUsdc: number,
  maxGlobal24hUsdc: number,
): Promise<void> {
  await setSecurityLimits({
    treasuryId: TEST_TREASURY_ID,
    maxPerWithdrawalUsdc,
    maxWallet24hUsdc,
    maxGlobal24hUsdc,
    actorWallet: OPERATOR_WALLET,
    actorRole: "admin",
  });
}

/** What the cap check would answer for a request made right now. */
async function capRefusal(wallet: string, amountUsdc: number): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(treasuryTransitionLock(TEST_TREASURY_ID));
    return checkWithdrawalCaps(tx, TEST_TREASURY_ID, wallet, amountUsdc);
  });
}

/**
 * The withdrawal route's reservation, reduced to the part the caps govern:
 * transition lock, cap check, pending ledger row, debited units - in that
 * order, in one transaction. Driving this directly is the only way to put two
 * reservations in contention, because the route refuses a second request
 * outright while any withdrawal of this treasury is still pending.
 */
async function reserveWithdrawal(
  wallet: string,
  amountUsdc: number,
): Promise<{ reserved: string } | { refused: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(treasuryTransitionLock(TEST_TREASURY_ID));
    const capError = await checkWithdrawalCaps(tx, TEST_TREASURY_ID, wallet, amountUsdc);
    if (capError) return { refused: capError };
    const id = `xfer-reserved-${randomUUID()}`;
    await tx.insert(onchainTransfersTable).values({
      id,
      treasuryId: TEST_TREASURY_ID,
      direction: "withdrawal",
      wallet,
      amountUsdc,
      status: "pending",
    });
    await tx
      .update(treasuryStateTable)
      .set({
        usdcUnits: sql`${treasuryStateTable.usdcUnits} - ${amountUsdc}`,
        updatedAt: new Date(),
      })
      .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
    return { reserved: id };
  });
}

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

function gate(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Long enough for a queued request to reach its lock and block on it. */
function settle(): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

beforeAll(async () => {
  await db.insert(treasuriesTable).values({
    id: TEST_TREASURY_ID,
    name: "Withdrawal caps integration test",
    ownerWallet: addressA,
  });
  await db.insert(treasuryStateTable).values({
    id: TEST_TREASURY_ID,
    usdcUnits: LIQUID_UNITS,
    lastUsdcPrice: 1,
  });
  // Confirmed deposits, so every wallet here has far more withdrawable
  // balance than any cap allows: the caps are what refuses, not the balance.
  await db.insert(onchainTransfersTable).values(
    [addressA, addressB, addressC].map((wallet) => ({
      id: `xfer-deposit-${randomUUID()}`,
      treasuryId: TEST_TREASURY_ID,
      direction: "deposit",
      wallet,
      amountUsdc: DEPOSIT_PER_WALLET,
      txHash: randomHash(),
      status: "confirmed",
      confirmedAt: new Date(),
    })),
  );
  const listeningServer = app.listen(0);
  server = listeningServer;
  await new Promise<void>((resolve) => listeningServer.once("listening", resolve));
  const addr = listeningServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  setupComplete = true;
});

beforeEach(async () => {
  // Every test starts from an unpaused treasury with the standard caps, an
  // empty 24h outflow history and a full reserve, so the rolling sums each
  // one reasons about are only the ones it created itself.
  await db
    .delete(onchainTransfersTable)
    .where(
      and(
        eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID),
        eq(onchainTransfersTable.direction, "withdrawal"),
      ),
    );
  await db
    .update(treasuryStateTable)
    .set({ usdcUnits: LIQUID_UNITS })
    .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
  await setLimits(PER_WITHDRAWAL_CAP, WALLET_24H_CAP, GLOBAL_24H_CAP);
  await setPause(false, "Test setup: treasury starts unpaused");
  signTransfer.mockClear();
  audit.mockClear();
  audit.mockImplementation(realAuditSafe);
});

afterAll(async () => {
  const cleanup = async () => {
    await db.delete(auditEventsTable).where(eq(auditEventsTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(alertsTable).where(eq(alertsTable.treasuryId, TEST_TREASURY_ID));
    await db
      .delete(onchainTransfersTable)
      .where(eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(securityControlsTable).where(eq(securityControlsTable.id, TEST_TREASURY_ID));
    await db.delete(treasuryStateTable).where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
    await db.delete(treasuriesTable).where(eq(treasuriesTable.id, TEST_TREASURY_ID));
  };
  const results = await Promise.allSettled([
    cleanup(),
    server
      ? new Promise<void>((resolve, reject) =>
          server!.close((err) => (err ? reject(err) : resolve())),
        )
      : Promise.resolve(),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  // When setup itself failed, preserve that original diagnostic rather than
  // replacing it with a secondary cleanup/server-close error.
  if (setupComplete && failure) throw failure.reason;
});

describe("withdrawing while the emergency pause is active", () => {
  it("refuses the withdrawal, reserves nothing, and signs nothing", async () => {
    await setPause(true, "Custody signer suspected compromised");
    const body = await withdrawalBody(walletA, 10);

    const refused = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(body),
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining("emergency pause is active"),
    });
    // Nothing was signed, nothing was reserved, nothing was debited: the
    // pause did not merely fail the request after committing to it.
    expect(signTransfer).not.toHaveBeenCalled();
    expect(await withdrawals()).toHaveLength(0);
    expect(await treasuryUnits()).toBeCloseTo(LIQUID_UNITS, 6);

    // And the pause is the only thing that stopped it: released, the very
    // same authorization goes through.
    await setPause(false, "Signer rotated, resuming");
    const allowed = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(body),
    });

    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toMatchObject({ status: "confirmed", amountUsdc: 10 });
    expect(signTransfer).toHaveBeenCalledTimes(1);
    expect(await treasuryUnits()).toBeCloseTo(LIQUID_UNITS - 10, 6);
  });

  /**
   * The pause has to bind a withdrawal that is ALREADY reserved.
   *
   * Reserving debits the units and records the intent, but the money only
   * leaves when the custody signer produces a transfer, and there are seconds
   * between the two. A guardian pulling the brake in exactly those seconds -
   * the case a compromised-signer pause exists for - must stop the send, not
   * arrive one instant too late for a withdrawal that had already passed the
   * check.
   *
   * The request is held at its audit write, which is after the reservation
   * has committed and before anything reaches custody.
   */
  it("refunds a reserved withdrawal instead of signing it when the pause lands first", async () => {
    const reserved = gate();
    const resume = gate();
    audit.mockImplementationOnce(async () => {
      reserved.release();
      await resume.promise;
    });

    const request = requestWithdrawal(walletA, 10);
    let refused: Response;
    try {
      await reserved.promise;
      // Reserved and debited, but nothing has been signed yet.
      expect(await treasuryUnits()).toBeCloseTo(LIQUID_UNITS - 10, 6);
      expect(signTransfer).not.toHaveBeenCalled();
      await setPause(true, "Custody signer suspected compromised");
    } finally {
      // Always let the request finish: a held request keeps a reservation
      // pending, which would block every later test in this file.
      resume.release();
      refused = await request;
    }

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining("emergency pause is active"),
    });
    // The signer was never reached, so no transfer of this treasury's money
    // exists anywhere - not in the mempool, not on the chain.
    expect(signTransfer).not.toHaveBeenCalled();
    // And the reservation was given back rather than left pending, which
    // would have blocked every other withdrawal for the length of the pause.
    expect(await treasuryUnits()).toBeCloseTo(LIQUID_UNITS, 6);
    const [row] = await withdrawals(addressA);
    expect(row!.status).toBe("failed");
  }, 15_000);

  /**
   * The other ordering. A transfer being signed right now cannot be recalled,
   * so the pause cannot stop it - but it must not report success while that
   * send is still in the air either, or a guardian would be told the treasury
   * is halted at the moment it is paying out. Activation therefore waits for
   * the custody send to finish, which is what makes "paused" mean nothing is
   * leaving.
   */
  it("waits for a transfer that is already being signed before reporting the treasury paused", async () => {
    const signing = gate();
    const finishSigning = gate();
    signTransfer.mockImplementationOnce(async () => {
      signing.release();
      await finishSigning.promise;
      return { hash: randomHash(), serialized: "0x00" as Hex, nonce: 7 };
    });

    const request = requestWithdrawal(walletA, 10);
    await signing.promise;

    let pauseCompleted = false;
    const pausing = setPause(true, "Custody signer suspected compromised").then(() => {
      pauseCompleted = true;
    });
    let sent: Response;
    try {
      await settle();
      // The send is mid-flight, so activation is still queued behind it.
      expect(pauseCompleted).toBe(false);
    } finally {
      // Always release the signer: a request stuck mid-send holds the custody
      // lock, which would block every later test in this file.
      finishSigning.release();
      [sent] = await Promise.all([request, pausing]);
    }

    // That withdrawal was already committed to and completes.
    expect(sent.status).toBe(201);
    // Once activation returns, nothing is in the air behind it: the next
    // withdrawal is refused outright.
    expect(pauseCompleted).toBe(true);
    expect((await requestWithdrawal(walletB, 10)).status).toBe(409);
    expect(signTransfer).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("tells the operator why, naming the reason the pause was pulled", async () => {
    await setPause(true, "Arc RPC returning inconsistent balances");

    const refused = await requestWithdrawal(walletA, 1);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining("Arc RPC returning inconsistent balances"),
    });
    expect(signTransfer).not.toHaveBeenCalled();
  });
});

describe("withdrawal caps", () => {
  it("refuses a withdrawal over the per-transaction cap and allows one exactly at it", async () => {
    const refused = await requestWithdrawal(walletA, PER_WITHDRAWAL_CAP + 1);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining(`per-transaction limit of ${PER_WITHDRAWAL_CAP}`),
    });
    expect(signTransfer).not.toHaveBeenCalled();
    expect(await withdrawals()).toHaveLength(0);
    expect(await treasuryUnits()).toBeCloseTo(LIQUID_UNITS, 6);

    // The cap is the only thing refusing it: a request at the limit settles.
    const allowed = await requestWithdrawal(walletA, PER_WITHDRAWAL_CAP);

    expect(allowed.status).toBe(201);
    expect(await treasuryUnits()).toBeCloseTo(LIQUID_UNITS - PER_WITHDRAWAL_CAP, 6);
  });

  it("refuses a withdrawal that would put the wallet over its rolling 24h cap", async () => {
    expect((await requestWithdrawal(walletA, 100)).status).toBe(201);

    // 100 already out, 60 more would be 160 against a 150 wallet cap.
    const refused = await requestWithdrawal(walletA, 60);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining(`rolling limit is ${WALLET_24H_CAP}`),
    });
    expect(await withdrawals(addressA)).toHaveLength(1);

    // It is that wallet's own 24h total that is spent, not the treasury's:
    // another depositor withdrawing the same amount is unaffected.
    expect((await requestWithdrawal(walletB, 60)).status).toBe(201);
    expect(signTransfer).toHaveBeenCalledTimes(2);
    expect(await treasuryUnits()).toBeCloseTo(LIQUID_UNITS - 160, 6);
  });

  it("refuses a withdrawal that would put the treasury over its global 24h cap", async () => {
    expect((await requestWithdrawal(walletA, 100)).status).toBe(201);
    expect((await requestWithdrawal(walletB, 100)).status).toBe(201);

    // Wallet C has withdrawn nothing, so only the treasury-wide total can
    // refuse this: 200 already out, 60 more would be 260 against 250.
    const refused = await requestWithdrawal(walletC, 60);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining(`global 24h outflow limit of ${GLOBAL_24H_CAP}`),
    });
    expect(signTransfer).toHaveBeenCalledTimes(2);
    expect(await withdrawals(addressC)).toHaveLength(0);

    // The room that is left is still usable, so the cap is a ceiling on the
    // treasury's outflow rather than a lockout after two withdrawals.
    expect((await requestWithdrawal(walletC, 50)).status).toBe(201);
    expect(await outflowUsdc()).toBeCloseTo(GLOBAL_24H_CAP, 6);
  });
});

/**
 * The caps are read inside the reservation transaction, under the transition
 * lock, and count withdrawals that are still pending. Together those are what
 * stops two withdrawals in flight at once from each being told there is room
 * for it. Both halves are driven here.
 */
describe("caps under contention", () => {
  it("counts a pending withdrawal against both rolling sums, and a refunded one against neither", async () => {
    const first = await reserveWithdrawal(addressA, 80);
    expect(first).toMatchObject({ reserved: expect.any(String) });

    // Nothing has been sent yet, but the units are reserved, so that 80 must
    // occupy the wallet's cap: 80 + 80 is over the 150 wallet limit.
    expect(await capRefusal(addressA, 80)).toContain(`rolling limit is ${WALLET_24H_CAP}`);
    // Another wallet's own 24h total is untouched by it.
    expect(await capRefusal(addressB, 80)).toBeNull();

    // And it occupies the treasury-wide total as well: two pending
    // withdrawals of 80 leave less than 100 of the 250 global cap.
    const second = await reserveWithdrawal(addressB, 80);
    expect(second).toMatchObject({ reserved: expect.any(String) });
    expect(await capRefusal(addressC, 100)).toContain(
      `global 24h outflow limit of ${GLOBAL_24H_CAP}`,
    );

    // A reservation that failed had its units refunded, so it holds no cap
    // room either - an operator is not billed twice for a withdrawal that
    // never left.
    await db
      .update(onchainTransfersTable)
      .set({ status: "failed" })
      .where(eq(onchainTransfersTable.id, (first as { reserved: string }).reserved));
    expect(await capRefusal(addressA, 80)).toBeNull();
    expect(signTransfer).not.toHaveBeenCalled();
  });

  /**
   * Two reservations that each fit on their own, run into each other for
   * real.
   *
   * Each one reads the rolling sums itself, so nothing about the reads keeps
   * them apart - only the transition lock does. To hold them in contention
   * rather than hope the two transactions collide, both are made to park on a
   * statement they reach only AFTER their cap check has passed: the debit of
   * the treasury's reserve, whose row is locked here first. Releasing it lets
   * both finish at one instant, which is exactly when two reservations would
   * jointly overspend a cap if the check were made anywhere but inside the
   * transaction.
   */
  it("lets only one of two concurrent reservations take the last of the global cap", async () => {
    // 150 each: either alone fits inside the 250 global cap, together they
    // do not.
    await setLimits(200, 200, GLOBAL_24H_CAP);
    const parked = gate();
    const release = gate();
    const holdingReserve = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT 1 FROM ${treasuryStateTable} WHERE ${treasuryStateTable.id} = ${TEST_TREASURY_ID} FOR UPDATE`,
      );
      parked.release();
      await release.promise;
    });
    await parked.promise;

    const reservations = Promise.all([
      reserveWithdrawal(addressA, 150),
      reserveWithdrawal(addressB, 150),
    ]);
    await settle();
    release.release();
    const [[first, second]] = await Promise.all([reservations, holdingReserve]);

    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => "reserved" in outcome)).toHaveLength(1);
    const [refused] = outcomes.filter((outcome): outcome is { refused: string } =>
      "refused" in outcome,
    );
    expect(refused.refused).toContain(`global 24h outflow limit of ${GLOBAL_24H_CAP}`);
    // One reservation exists and one debit was taken; the treasury never
    // committed to sending 300 out of a 250 cap.
    expect(await withdrawals()).toHaveLength(1);
    expect(await outflowUsdc()).toBeCloseTo(150, 6);
    expect(await treasuryUnits()).toBeCloseTo(LIQUID_UNITS - 150, 6);
  }, 15_000);

  /**
   * The same contention as seen by the route: an operator's withdrawal is
   * already in flight when a competing one commits and takes the cap room it
   * was going to use. The route reads the caps after it has the lock, so it
   * sees the competitor and refuses; a check made before the transaction
   * would have read the treasury as it was when the request arrived and let
   * both go out.
   */
  it("refuses a request whose cap room was taken while it queued for the lock", async () => {
    await setLimits(200, 200, GLOBAL_24H_CAP);
    const parked = gate();
    const release = gate();
    const competing = db.transaction(async (tx) => {
      await tx.execute(treasuryTransitionLock(TEST_TREASURY_ID));
      await tx.insert(onchainTransfersTable).values({
        id: `xfer-competing-${randomUUID()}`,
        treasuryId: TEST_TREASURY_ID,
        direction: "withdrawal",
        wallet: addressB,
        amountUsdc: 150,
        txHash: randomHash(),
        status: "confirmed",
        confirmedAt: new Date(),
      });
      await tx
        .update(treasuryStateTable)
        .set({ usdcUnits: sql`${treasuryStateTable.usdcUnits} - 150` })
        .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
      parked.release();
      await release.promise;
    });
    await parked.promise;

    // Fits the caps as the treasury stands when this request is made.
    const request = requestWithdrawal(walletA, 150);
    await settle();
    release.release();
    const [refused] = await Promise.all([request, competing]);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining(`global 24h outflow limit of ${GLOBAL_24H_CAP}`),
    });
    expect(signTransfer).not.toHaveBeenCalled();
    expect(await withdrawals(addressA)).toHaveLength(0);
    expect(await outflowUsdc()).toBeCloseTo(150, 6);
  }, 15_000);
});
