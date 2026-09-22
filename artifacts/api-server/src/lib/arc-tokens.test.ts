/**
 * Invariants of the token registry. Every one of these is a rule the rest of
 * the system leans on without re-checking, so a registry edit that breaks
 * one must fail here rather than at the first live trade.
 */
import { describe, expect, it } from "vitest";
import { isAddress, getAddress } from "viem";
import {
  ARC_TOKENS,
  describePriceSource,
  isTradedSymbol,
  priceIdOf,
  tokenByAddress,
  tradableRiskTokens,
  tradableTokens,
} from "./arc-tokens";

const tokens = Object.values(ARC_TOKENS);

describe("Arc token registry", () => {
  it("keys every entry by its own symbol and uses checksummed, unique addresses", () => {
    const seen = new Set<string>();
    for (const [key, token] of Object.entries(ARC_TOKENS)) {
      expect(token.symbol).toBe(key);
      expect(isAddress(token.address)).toBe(true);
      expect(getAddress(token.address)).toBe(token.address);
      expect(seen.has(token.address.toLowerCase())).toBe(false);
      seen.add(token.address.toLowerCase());
    }
  });

  it("has exactly one stable leg, USDC, and it has no pools against itself", () => {
    const stable = tokens.filter((t) => t.role === "stable");
    expect(stable.map((t) => t.symbol)).toEqual(["USDC"]);
    expect(ARC_TOKENS.USDC.pools).toEqual([]);
  });

  it("gives every tradable non-USDC token at least one pinned pool with a sane tier", () => {
    for (const token of tradableTokens()) {
      if (token.symbol === "USDC") continue;
      expect(token.pools.length, `${token.symbol} has no pool`).toBeGreaterThan(0);
      for (const pool of token.pools) {
        expect(Number.isInteger(pool.fee) && pool.fee > 0 && pool.fee < 1_000_000).toBe(true);
        expect(Number.isInteger(pool.tickSpacing) && pool.tickSpacing > 0).toBe(true);
      }
    }
  });

  it("gives every token an independent price source with a stable id", () => {
    for (const token of tokens) {
      const id = priceIdOf(token.price);
      expect(id).toMatch(/^(coingecko:[a-z0-9-]+|fx:[A-Z]{3})$/);
      expect(describePriceSource(token.price).length).toBeGreaterThan(0);
    }
  });

  it("explains every untradable token and never lists it as a sleeve candidate", () => {
    for (const token of tokens) {
      if (token.tradable) {
        expect(token.untradableReason).toBeUndefined();
      } else {
        expect(token.untradableReason?.length ?? 0).toBeGreaterThan(20);
      }
    }
    expect(tradableRiskTokens().every((t) => t.tradable && t.role === "risk")).toBe(true);
    expect(tradableRiskTokens().map((t) => t.symbol)).not.toContain("wARS");
  });

  it("lists only issuer controls the contract really has", () => {
    // Verified against each contract on Arc mainnet on 22 September 2026.
    expect(ARC_TOKENS.USDC.issuerControls).toEqual(["paused", "isBlacklisted"]);
    expect(ARC_TOKENS.EURC.issuerControls).toEqual(["paused", "isBlacklisted"]);
    expect(ARC_TOKENS.cirBTC.issuerControls).toEqual(["paused", "isBlacklisted"]);
    expect(ARC_TOKENS.syrupUSDC.issuerControls).toEqual([]);
    expect(ARC_TOKENS.WETH.issuerControls).toEqual(["paused"]);
    expect(ARC_TOKENS.wARS.issuerControls).toEqual(["paused", "isBlocked"]);
  });

  it("does not carry the spoofed names that circulate on Arc's venue", () => {
    for (const symbol of ["CRCL", "NVDA", "SPY", "AAPL", "TSLA", "VIRTUAL"]) {
      expect(isTradedSymbol(symbol)).toBe(false);
    }
  });

  it("resolves addresses case-insensitively and rejects strangers", () => {
    expect(tokenByAddress(ARC_TOKENS.EURC.address.toLowerCase())?.symbol).toBe("EURC");
    expect(tokenByAddress("0x000000000000000000000000000000000000dead")).toBeUndefined();
  });
});
