/**
 * UniversalRouter calldata for Revo's one swap shape, and the decoder the
 * custody signer runs against every router call before key material is
 * opened.
 *
 * The signer must not take the caller's word for what a payload does. The
 * only router calldata it signs is exactly what `encodeV4Swap` produces:
 * one V4_SWAP command carrying one exact-input single-pool swap between two
 * pinned, tradable tokens, one of which is USDC, on a hook-less pinned pool,
 * settled and taken in full with no hook data and no price limit. Anything
 * else is refused with the reason, whatever the caller claims.
 *
 * This module depends only on viem and the token registry so the signer can
 * import it without pulling in RPC clients.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  type Address,
  type Hex,
} from "viem";
import { ARC_TOKENS, tokenByAddress, type ArcToken } from "./arc-tokens";

/** Uniswap v4 on Arc mainnet (chain 5042), from Uniswap's deployment registry. */
export const UNIVERSAL_ROUTER: Address = "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1";
/** Canonical Permit2, same address on every chain. The router pulls input tokens through it. */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export const poolKeyAbi = {
  type: "tuple",
  name: "poolKey",
  components: [
    { type: "address", name: "currency0" },
    { type: "address", name: "currency1" },
    { type: "uint24", name: "fee" },
    { type: "int24", name: "tickSpacing" },
    { type: "address", name: "hooks" },
  ],
} as const;

export const universalRouterAbi = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { type: "bytes", name: "commands" },
      { type: "bytes[]", name: "inputs" },
      { type: "uint256", name: "deadline" },
    ],
    outputs: [],
  },
] as const;

export const permit2Abi = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "owner" },
      { type: "address", name: "token" },
      { type: "address", name: "spender" },
    ],
    outputs: [
      { type: "uint160", name: "amount" },
      { type: "uint48", name: "expiration" },
      { type: "uint48", name: "nonce" },
    ],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "token" },
      { type: "address", name: "spender" },
      { type: "uint160", name: "amount" },
      { type: "uint48", name: "expiration" },
    ],
    outputs: [],
  },
] as const;

/** UniversalRouter command and v4 router actions, from the Uniswap sources. */
const COMMAND_V4_SWAP = 0x10;
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

/**
 * The router deployed on Arc decodes the earlier v4-periphery
 * ExactInputSingleParams, which still carries `sqrtPriceLimitX96`. Verified
 * on 22 September 2026 by simulating both layouts against the live router:
 * this one executes, the five-field layout reverts. Zero means "no price
 * limit"; `amountOutMinimum` is the protection.
 */
const exactInputSingleAbi = [
  {
    type: "tuple",
    components: [
      poolKeyAbi,
      { type: "bool", name: "zeroForOne" },
      { type: "uint128", name: "amountIn" },
      { type: "uint128", name: "amountOutMinimum" },
      { type: "uint160", name: "sqrtPriceLimitX96" },
      { type: "bytes", name: "hookData" },
    ],
  },
] as const;

const currencyAmountAbi = [{ type: "address" }, { type: "uint256" }] as const;
const v4InputAbi = [{ type: "bytes" }, { type: "bytes[]" }] as const;

const EXPECTED_COMMANDS = encodePacked(["uint8"], [COMMAND_V4_SWAP]).toLowerCase();
const EXPECTED_ACTIONS = encodePacked(
  ["uint8", "uint8", "uint8"],
  [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL],
).toLowerCase();

export function encodeV4Swap(params: {
  key: PoolKey;
  input: Address;
  output: Address;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
}): Hex {
  const { key, input, output, amountIn, minOut, deadline } = params;
  const zeroForOne = key.currency0.toLowerCase() === input.toLowerCase();
  if (!zeroForOne && key.currency1.toLowerCase() !== input.toLowerCase()) {
    throw new Error("Swap input is not one of the pool's currencies");
  }
  if (amountIn <= 0n || amountIn >= 2n ** 128n || minOut <= 0n || minOut >= 2n ** 128n) {
    throw new Error("Swap amounts must fit uint128 and be positive");
  }
  const swapParams = encodeAbiParameters(exactInputSingleAbi, [
    { poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n, hookData: "0x" },
  ]);
  const settleParams = encodeAbiParameters(currencyAmountAbi, [input, amountIn]);
  const takeParams = encodeAbiParameters(currencyAmountAbi, [output, minOut]);
  const v4Input = encodeAbiParameters(v4InputAbi, [
    EXPECTED_ACTIONS as Hex,
    [swapParams, settleParams, takeParams],
  ]);
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [EXPECTED_COMMANDS as Hex, [v4Input], deadline],
  });
}

/** Permit2 `approve(token, spender, amount, expiration)` calldata: exact amount, short expiry. */
export function encodePermit2Approval(token: Address, amount: bigint, expiration: number): Hex {
  if (amount <= 0n || amount >= 2n ** 160n) throw new Error("Permit2 amount must fit uint160");
  return encodeFunctionData({
    abi: permit2Abi,
    functionName: "approve",
    args: [token, UNIVERSAL_ROUTER, amount, expiration],
  });
}

/** What a router payload the signer accepts actually does. */
export interface PinnedSwap {
  key: PoolKey;
  input: ArcToken;
  output: ArcToken;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
}

/** Thrown by `decodePinnedSwap`; the message names the first rule the payload broke. */
export class SwapCalldataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapCalldataError";
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Decodes UniversalRouter calldata and proves it is one pinned swap. Every
 * rule below is checked from the bytes; nothing is taken from the caller.
 */
export function decodePinnedSwap(data: Hex): PinnedSwap {
  let decoded: ReturnType<typeof decodeFunctionData<typeof universalRouterAbi>>;
  try {
    decoded = decodeFunctionData({ abi: universalRouterAbi, data });
  } catch {
    throw new SwapCalldataError("Router calldata is not UniversalRouter.execute(bytes,bytes[],uint256)");
  }
  const [commands, inputs, deadline] = decoded.args;
  // One command byte, V4_SWAP, without the allow-revert flag: a swap that is
  // permitted to fail silently would spend the approval and move nothing.
  if (commands.toLowerCase() !== EXPECTED_COMMANDS) {
    throw new SwapCalldataError(`Router command bytes ${commands} are not a single V4_SWAP`);
  }
  if (inputs.length !== 1) {
    throw new SwapCalldataError(`Router payload carries ${inputs.length} inputs, expected 1`);
  }

  let actions: Hex;
  let params: readonly Hex[];
  try {
    [actions, params] = decodeAbiParameters(v4InputAbi, inputs[0]!);
  } catch {
    throw new SwapCalldataError("V4_SWAP input does not decode as (bytes actions, bytes[] params)");
  }
  if (actions.toLowerCase() !== EXPECTED_ACTIONS) {
    throw new SwapCalldataError(`Router actions ${actions} are not SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL`);
  }
  if (params.length !== 3) {
    throw new SwapCalldataError(`Router actions carry ${params.length} parameter blobs, expected 3`);
  }

  let swap: {
    poolKey: PoolKey;
    zeroForOne: boolean;
    amountIn: bigint;
    amountOutMinimum: bigint;
    sqrtPriceLimitX96: bigint;
    hookData: Hex;
  };
  let settle: readonly [Address, bigint];
  let take: readonly [Address, bigint];
  try {
    [swap] = decodeAbiParameters(exactInputSingleAbi, params[0]!);
    settle = decodeAbiParameters(currencyAmountAbi, params[1]!);
    take = decodeAbiParameters(currencyAmountAbi, params[2]!);
  } catch {
    throw new SwapCalldataError("Swap parameters do not decode as an exact-input single-pool swap");
  }

  const { poolKey } = swap;
  if (!same(poolKey.hooks, ZERO_ADDRESS)) {
    throw new SwapCalldataError(`Pool ${poolKey.hooks} carries a hook; Revo only pins hook-less pools`);
  }
  if (swap.hookData !== "0x") {
    throw new SwapCalldataError("Swap carries hook data on a pool that must have no hook");
  }
  if (swap.sqrtPriceLimitX96 !== 0n) {
    throw new SwapCalldataError("Swap sets a price limit; the minimum output is the only protection Revo signs");
  }
  if (BigInt(poolKey.currency0) >= BigInt(poolKey.currency1)) {
    throw new SwapCalldataError("Pool currencies are not in canonical order");
  }

  const token0 = tokenByAddress(poolKey.currency0);
  const token1 = tokenByAddress(poolKey.currency1);
  if (!token0 || !token1) {
    throw new SwapCalldataError(
      `Pool currency ${!token0 ? poolKey.currency0 : poolKey.currency1} is not a pinned token`,
    );
  }
  for (const token of [token0, token1]) {
    if (!token.tradable) {
      throw new SwapCalldataError(`${token.symbol} is held but never traded: ${token.untradableReason ?? ""}`.trim());
    }
  }
  const usdc = ARC_TOKENS.USDC!;
  const usdcSides = [token0, token1].filter((t) => same(t.address, usdc.address));
  if (usdcSides.length !== 1) {
    throw new SwapCalldataError(
      `Revo routes every trade through USDC; ${token0.symbol}/${token1.symbol} has ${usdcSides.length} USDC sides`,
    );
  }
  const other = same(token0.address, usdc.address) ? token1 : token0;
  const pinned = other.pools.some((p) => p.fee === poolKey.fee && p.tickSpacing === poolKey.tickSpacing);
  if (!pinned) {
    throw new SwapCalldataError(
      `${other.symbol}/USDC fee ${poolKey.fee} tick spacing ${poolKey.tickSpacing} is not a pinned pool`,
    );
  }

  if (swap.amountIn <= 0n || swap.amountOutMinimum <= 0n) {
    throw new SwapCalldataError("Swap amounts must be positive");
  }
  const input = swap.zeroForOne ? token0 : token1;
  const output = swap.zeroForOne ? token1 : token0;
  if (!same(settle[0], input.address) || settle[1] !== swap.amountIn) {
    throw new SwapCalldataError("SETTLE_ALL does not settle exactly the swap input");
  }
  if (!same(take[0], output.address) || take[1] !== swap.amountOutMinimum) {
    throw new SwapCalldataError("TAKE_ALL does not take the swap output at its minimum");
  }

  return {
    key: poolKey,
    input,
    output,
    amountIn: swap.amountIn,
    minOut: swap.amountOutMinimum,
    deadline,
  };
}
