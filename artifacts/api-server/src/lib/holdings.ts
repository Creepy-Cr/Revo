/**
 * Real custody holdings, read from Arc.
 *
 * The treasury's composition used to be four numbers in a database row -
 * USDC, aUSDC, sUSDC and ETH - valued at read time. Three of those were
 * fictions: there is no aUSDC or sUSDC protocol here, and ETH does not exist on
 * Arc at all. This module replaces them with the only thing that can honestly
 * be called a holding, the token balances actually sitting in the treasury's
 * custody wallet.
 *
 * A failed read is reported as a failed read. It never comes back as a zero
 * balance, because "the RPC is down" and "the treasury is empty" must not look
 * the same to anything downstream.
 */

import type { PublicClient } from "viem";
import { arcPublicClient, ensureTreasuryWallet } from "./arc-chain";
import { ARC_TOKENS, priceIdOf, type ArcToken } from "./arc-tokens";
import { fromBaseUnits } from "./tower";

const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

function rpc(): PublicClient {
  return arcPublicClient();
}

/** Test seam, kept for callers; the shared client owns its own lifecycle. */
export function resetHoldingsClient(): void {}

export interface Holding extends Pick<ArcToken, "symbol" | "name" | "decimals" | "role" | "tradable"> {
  address: string;
  untradableReason?: string;
  /** Key of this token's independent reference price in the market quote. */
  priceId: string;
  /** Human units held. */
  units: number;
  /** Base units held, exact. */
  raw: string;
}

export interface CustodyHoldings {
  /** False when the chain could not be read. Callers must not treat this as an empty treasury. */
  ok: boolean;
  walletAddress: string | null;
  holdings: Holding[];
  error?: string;
  readAt: string;
}

/**
 * Read every pinned Arc token's balance for a treasury's custody wallet.
 *
 * Every pinned token is included so the dashboard reflects the full custody
 * wallet.
 */
export async function readCustodyHoldings(
  treasuryId: string,
  signal?: AbortSignal,
): Promise<CustodyHoldings> {
  const readAt = new Date().toISOString();
  let walletAddress: string | null = null;

  try {
    const wallet = await ensureTreasuryWallet(treasuryId, signal);
    walletAddress = wallet.address;
    signal?.throwIfAborted();

    const c = rpc();
    const tokens = Object.values(ARC_TOKENS);
    const balances = await Promise.all(
      tokens.map((token) =>
        c.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet.address as `0x${string}`],
        }) as Promise<bigint>,
      ),
    );

    const holdings = tokens.map((token, i) => {
      const raw = balances[i] ?? 0n;
      return {
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        decimals: token.decimals,
        role: token.role,
        tradable: token.tradable,
        ...(token.untradableReason ? { untradableReason: token.untradableReason } : {}),
        priceId: priceIdOf(token.price),
        units: Number(fromBaseUnits(raw, token.decimals)),
        raw: raw.toString(),
      } satisfies Holding;
    });

    return { ok: true, walletAddress, holdings, readAt };
  } catch (error) {
    return {
      ok: false,
      walletAddress,
      holdings: [],
      error: error instanceof Error ? error.message : "Arc RPC unreachable",
      readAt,
    };
  }
}
