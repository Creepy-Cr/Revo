import { describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { ARC_TOKENS } from "./arc-tokens";
import {
  ZERO_ADDRESS,
  decodePinnedSwap,
  encodeV4Swap,
  universalRouterAbi,
  type PoolKey,
} from "./v4-calldata";

const USDC = ARC_TOKENS.USDC!;
const EURC = ARC_TOKENS.EURC!;
const CIRBTC = ARC_TOKENS.cirBTC!;
const WETH = ARC_TOKENS.WETH!;
const WARS = ARC_TOKENS.wARS!;

function keyFor(a: Address, b: Address, fee: number, tickSpacing: number, hooks: Address = ZERO_ADDRESS): PoolKey {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks };
}

const swapArgs = {
  key: keyFor(USDC.address, EURC.address, 500, 10),
  input: USDC.address,
  output: EURC.address,
  amountIn: 100_000_000n,
  minOut: 86_000_000n,
  deadline: 1_800_000_000n,
};


function rebuild(data: Hex, edit: (args: { commands: Hex; inputs: Hex[]; deadline: bigint }) => void): Hex {
  const { functionName, args } = decodeFunctionDataSafe(data);
  expect(functionName).toBe("execute");
  const mutable = { commands: args[0], inputs: [...args[1]], deadline: args[2] };
  edit(mutable);
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [mutable.commands, mutable.inputs, mutable.deadline],
  });
}

function decodeFunctionDataSafe(data: Hex): { functionName: "execute"; args: readonly [Hex, readonly Hex[], bigint] } {
  // viem's decodeFunctionData is what production uses; mirror it here via the
  // same ABI so the fixture cannot drift from the decoder.
  const selector = data.slice(0, 10);
  expect(selector).toBe("0x3593564c");
  const [commands, inputs, deadline] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }, { type: "uint256" }],
    ("0x" + data.slice(10)) as Hex,
  );
  return { functionName: "execute", args: [commands, inputs, deadline] };
}

function editV4Input(
  data: Hex,
  edit: (v4: { actions: Hex; params: Hex[] }) => void,
): Hex {
  return rebuild(data, (args) => {
    const [actions, params] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      args.inputs[0]!,
    );
    const v4 = { actions, params: [...params] };
    edit(v4);
    args.inputs[0] = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [v4.actions, v4.params]);
  });
}

describe("decodePinnedSwap round-trips what encodeV4Swap produces", () => {
  it("returns the legs, amounts and pool the bytes commit to", () => {
    const swap = decodePinnedSwap(encodeV4Swap(swapArgs));
    expect(swap.input.symbol).toBe("USDC");
    expect(swap.output.symbol).toBe("EURC");
    expect(swap.amountIn).toBe(100_000_000n);
    expect(swap.minOut).toBe(86_000_000n);
    expect(swap.deadline).toBe(1_800_000_000n);
    expect(swap.key.fee).toBe(500);
  });

  it("accepts every pinned pool of every tradable token in both directions", () => {
    for (const token of Object.values(ARC_TOKENS)) {
      if (token.symbol === "USDC" || !token.tradable) continue;
      for (const pool of token.pools) {
        const key = keyFor(USDC.address, token.address, pool.fee, pool.tickSpacing);
        for (const [input, output] of [
          [USDC.address, token.address],
          [token.address, USDC.address],
        ] as const) {
          const swap = decodePinnedSwap(
            encodeV4Swap({ key, input, output, amountIn: 1_000n, minOut: 1n, deadline: 1n }),
          );
          expect(swap.input.address.toLowerCase()).toBe(input.toLowerCase());
          expect(swap.output.address.toLowerCase()).toBe(output.toLowerCase());
        }
      }
    }
  });
});

describe("decodePinnedSwap refuses everything that is not one pinned swap", () => {
  it("refuses a pool with a held-only token even though it is pinned", () => {
    const key = keyFor(USDC.address, WARS.address, 100, 1);
    const data = encodeV4Swap({
      key,
      input: USDC.address,
      output: WARS.address,
      amountIn: 1_000n,
      minOut: 1n,
      deadline: 1n,
    });
    expect(() => decodePinnedSwap(data)).toThrow(/wARS is held but never traded/);
  });

  it("refuses a pool that is not pinned for the token", () => {
    const key = keyFor(USDC.address, CIRBTC.address, 500, 10);
    const data = encodeV4Swap({ key, input: USDC.address, output: CIRBTC.address, amountIn: 1n, minOut: 1n, deadline: 1n });
    expect(() => decodePinnedSwap(data)).toThrow(/cirBTC\/USDC fee 500 tick spacing 10 is not a pinned pool/);
  });

  it("refuses a risk-to-risk pool with no USDC side", () => {
    const key = keyFor(WETH.address, CIRBTC.address, 3000, 30);
    const data = encodeV4Swap({ key, input: WETH.address, output: CIRBTC.address, amountIn: 1n, minOut: 1n, deadline: 1n });
    expect(() => decodePinnedSwap(data)).toThrow(/has 0 USDC sides/);
  });

  it("refuses an unpinned token address even on USDC's other side", () => {
    const stranger = "0x2222222222222222222222222222222222222222" as Address;
    const key = keyFor(USDC.address, stranger, 500, 10);
    const data = encodeV4Swap({ key, input: USDC.address, output: stranger, amountIn: 1n, minOut: 1n, deadline: 1n });
    expect(() => decodePinnedSwap(data)).toThrow(/is not a pinned token/);
  });

  it("refuses a hooked pool", () => {
    const hooked = "0x00000000000000000000000000000000000000c0" as Address;
    const key = keyFor(USDC.address, EURC.address, 500, 10, hooked);
    const data = encodeV4Swap({ ...swapArgs, key });
    expect(() => decodePinnedSwap(data)).toThrow(/carries a hook/);
  });

  it("refuses more than one command, the allow-revert flag, and extra inputs", () => {
    const data = encodeV4Swap(swapArgs);
    expect(() => decodePinnedSwap(rebuild(data, (a) => { a.commands = "0x1010"; a.inputs.push(a.inputs[0]!); }))).toThrow(
      /not a single V4_SWAP/,
    );
    expect(() => decodePinnedSwap(rebuild(data, (a) => { a.commands = "0x90"; }))).toThrow(/not a single V4_SWAP/);
    expect(() => decodePinnedSwap(rebuild(data, (a) => { a.inputs.push(a.inputs[0]!); }))).toThrow(/2 inputs/);
  });

  it("refuses any action list other than swap, settle all, take all", () => {
    const data = encodeV4Swap(swapArgs);
    // SETTLE (0x0b) instead of SETTLE_ALL, and a fourth action appended.
    expect(() => decodePinnedSwap(editV4Input(data, (v4) => { v4.actions = "0x060b0f"; }))).toThrow(/not SWAP_EXACT_IN_SINGLE/);
    expect(() =>
      decodePinnedSwap(editV4Input(data, (v4) => { v4.actions = "0x060c0f0f"; v4.params.push(v4.params[2]!); })),
    ).toThrow(/not SWAP_EXACT_IN_SINGLE/);
  });

  it("refuses settle or take parameters that do not match the swap", () => {
    const data = encodeV4Swap(swapArgs);
    const settleLess = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [USDC.address, 1n]);
    expect(() => decodePinnedSwap(editV4Input(data, (v4) => { v4.params[1] = settleLess; }))).toThrow(
      /SETTLE_ALL does not settle exactly the swap input/,
    );
    const takeOther = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [CIRBTC.address, 86_000_000n]);
    expect(() => decodePinnedSwap(editV4Input(data, (v4) => { v4.params[2] = takeOther; }))).toThrow(
      /TAKE_ALL does not take the swap output/,
    );
  });

  it("refuses calldata for a different function", () => {
    expect(() => decodePinnedSwap("0xa9059cbb" as Hex)).toThrow(/not UniversalRouter.execute/);
  });
});
