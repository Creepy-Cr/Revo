import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARC_TRADED_TOKENS,
  TOWER_CHAIN_ID,
  checkPairSupport,
  fromBaseUnits,
  isTowerConfigured,
  resetTowerRegistryCache,
  toBaseUnits,
} from "./tower";

const ARC = 5042;

const GOOD_CHAINS = {
  success: true,
  data: [{ numericId: ARC, name: "Arc", key: "arc", supportedFeatures: ["swaps"] }],
};

const GOOD_TOKENS = {
  success: true,
  data: [
    { symbol: "USDC", address: ARC_TRADED_TOKENS.USDC!.address, decimals: 6, chainId: ARC },
    { symbol: "EURC", address: ARC_TRADED_TOKENS.EURC!.address, decimals: 6, chainId: ARC },
  ],
};

function mockTower(chains: unknown = GOOD_CHAINS, tokens: unknown = GOOD_TOKENS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = url.toString();
      const body = href.endsWith("/chains") ? chains : tokens;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

beforeEach(() => {
  resetTowerRegistryCache();
  process.env.TOWER_API_KEY = "test-key-not-a-real-credential";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TOWER_API_KEY;
  resetTowerRegistryCache();
});

describe("amount conversion", () => {
  it("converts human amounts into ERC-20 base units", () => {
    expect(toBaseUnits("1", 6)).toBe(1_000_000n);
    expect(toBaseUnits("12.5", 6)).toBe(12_500_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
  });

  it("rejects amounts that cannot be represented exactly", () => {
    expect(toBaseUnits("0.0000001", 6)).toBeNull();
    expect(toBaseUnits("abc", 6)).toBeNull();
    expect(toBaseUnits("-1", 6)).toBeNull();
  });

  it("renders base units as a human amount", () => {
    expect(fromBaseUnits(12_500_000n, 6)).toBe("12.5");
    expect(fromBaseUnits(0n, 6)).toBe("0");
  });
});

describe("Tower registry cross-check", () => {
  it("uses Arc mainnet", () => {
    expect(TOWER_CHAIN_ID).toBe(ARC);
  });

  it("reports configuration without revealing the key", () => {
    expect(isTowerConfigured()).toBe(true);
    delete process.env.TOWER_API_KEY;
    expect(isTowerConfigured()).toBe(false);
  });

  it("accepts the pinned USDC and EURC addresses", async () => {
    mockTower();
    const support = await checkPairSupport("USDC", "EURC");
    expect(support.supported).toBe(true);
  });

  it("rejects a different EURC address", async () => {
    mockTower(GOOD_CHAINS, {
      success: true,
      data: [
        GOOD_TOKENS.data[0],
        { ...GOOD_TOKENS.data[1], address: "0x000000000000000000000000000000000000dead" },
      ],
    });
    const support = await checkPairSupport("USDC", "EURC");
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/different contract address/i);
  });

  it("rejects unapproved tokens before reading the registry", async () => {
    const support = await checkPairSupport("USDC", "NVDA");
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/not an approved/i);
  });
});