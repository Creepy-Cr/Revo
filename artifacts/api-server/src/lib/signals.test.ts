import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ARC_TOKENS } from "./arc-tokens";
import type { MarketQuote } from "./market";
import type { NewsSentiment } from "./news-sentiment";
import type { XSentiment } from "./x-sentiment";
import type { WhaleActivity } from "./whale-watch";
import type { DiscordSentiment } from "./discord-sentiment";
import type { ComputedSignal } from "./signals";

/**
 * The signals feed must only ever report on assets the treasury can actually
 * hold. That invariant is not enforceable by the API schema - `asset` is a
 * free-form string there, deliberately, because the in-memory safety drill
 * shares the response shape - so it is enforced here instead.
 *
 * A signal that names a token the treasury cannot hold is worse than no
 * signal: it invites a decision an operator has no way to act on. The feed
 * once shipped an ETH card for months alongside allocation rows that had long
 * stopped mentioning it, and nothing caught it.
 */

vi.mock("./market", () => ({ getMarketQuote: vi.fn() }));
vi.mock("./x-sentiment", () => ({ fetchXSentiment: vi.fn() }));
vi.mock("./news-sentiment", () => ({ fetchNewsSentiment: vi.fn() }));
vi.mock("./whale-watch", () => ({ fetchWhaleActivity: vi.fn() }));
vi.mock("./discord-sentiment", () => ({ fetchDiscordSentiment: vi.fn() }));

const REGISTRY_SYMBOLS = Object.keys(ARC_TOKENS);

const QUOTE: MarketQuote = {
  usdcUsd: 0.9999,
  eurUsd: 1.16,
  eurChange24h: -0.3,
  fetchedAt: Date.now(),
  stale: false,
};

const xSentiment = (asset: XSentiment["asset"]): XSentiment => ({
  asset,
  score: 20,
  sampleSize: 25,
  bullish: 10,
  bearish: 5,
  neutral: 10,
  fetchedAt: Date.now(),
});

const newsSentiment = (asset: NewsSentiment["asset"]): NewsSentiment => ({
  asset,
  score: -10,
  sampleSize: 12,
  bullish: 3,
  bearish: 5,
  neutral: 4,
  feeds: ["CoinDesk"],
  fetchedAt: Date.now(),
});

const WHALE: WhaleActivity = {
  windowBlocks: 5_000,
  windowMinutes: 180,
  totalTransfers: 42,
  whaleThresholdUsdc: 250_000,
  whaleCount: 3,
  whaleVolumeUsdc: 1_400_000,
  largestUsdc: 900_000,
  fetchedAt: Date.now(),
};

const DISCORD: DiscordSentiment = {
  score: 35,
  sampleSize: 60,
  bullish: 30,
  bearish: 8,
  neutral: 22,
  channels: 2,
  fetchedAt: Date.now(),
};

interface SourceToggles {
  market: boolean;
  github: boolean;
  x: boolean;
  news: boolean;
  whale: boolean;
  discord: boolean;
}

/**
 * Builds the feed with a chosen subset of upstream sources alive.
 *
 * The module is re-imported per run on purpose: `signals.ts` keeps a
 * process-lifetime GitHub cache, and without a fresh module a single
 * successful commit fetch would leak into every later "GitHub is down" case
 * and quietly stop exercising it.
 */
async function buildWith(sources: SourceToggles): Promise<ComputedSignal[]> {
  vi.resetModules();

  const market = await import("./market");
  const x = await import("./x-sentiment");
  const news = await import("./news-sentiment");
  const whaleWatch = await import("./whale-watch");
  const discord = await import("./discord-sentiment");

  vi.mocked(market.getMarketQuote).mockResolvedValue(sources.market ? QUOTE : null);
  vi.mocked(x.fetchXSentiment).mockImplementation(async (asset) =>
    sources.x ? xSentiment(asset) : null,
  );
  vi.mocked(news.fetchNewsSentiment).mockImplementation(async (asset) =>
    sources.news ? newsSentiment(asset) : null,
  );
  vi.mocked(whaleWatch.fetchWhaleActivity).mockResolvedValue(sources.whale ? WHALE : null);
  vi.mocked(discord.fetchDiscordSentiment).mockResolvedValue(sources.discord ? DISCORD : null);

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      sources.github
        ? new Response(JSON.stringify([{}, {}, {}]), { status: 200 })
        : new Response("nope", { status: 503 }),
    ),
  );

  const { buildSignals } = await import("./signals");
  return buildSignals();
}

/** Every on/off combination of the six upstream sources. */
function allSourceCombinations(): SourceToggles[] {
  const keys: (keyof SourceToggles)[] = ["market", "github", "x", "news", "whale", "discord"];
  const combinations: SourceToggles[] = [];
  for (let mask = 0; mask < 1 << keys.length; mask += 1) {
    const toggles = {} as SourceToggles;
    keys.forEach((key, i) => {
      toggles[key] = (mask & (1 << i)) !== 0;
    });
    combinations.push(toggles);
  }
  return combinations;
}

const describeSources = (s: SourceToggles) =>
  Object.entries(s)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join("+") || "nothing";

describe("signals feed asset scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never reports an asset the treasury cannot hold, whichever sources are alive", async () => {
    for (const sources of allSourceCombinations()) {
      const signals = await buildWith(sources);
      for (const signal of signals) {
        if (signal.asset === undefined) continue;
        expect(
          REGISTRY_SYMBOLS,
          `signal ${signal.id} reports asset "${signal.asset}", which is not a token the treasury can hold (sources: ${describeSources(sources)})`,
        ).toContain(signal.asset);
      }
    }
  });

  it("omits the asset entirely for a signal that is not about a holding", async () => {
    const signals = await buildWith({
      market: false,
      github: false,
      x: false,
      news: false,
      whale: false,
      discord: true,
    });

    const community = signals.find((s) => s.id === "sig-community-pulse");
    expect(community).toBeDefined();
    // Not "DAO", not "", not a placeholder ticker - absent.
    expect(community).not.toHaveProperty("asset");
  });

  it("covers each holdable token when every source is alive", async () => {
    const signals = await buildWith({
      market: true,
      github: true,
      x: true,
      news: true,
      whale: true,
      discord: true,
    });

    const covered = new Set(signals.map((s) => s.asset).filter(Boolean));
    expect([...covered].sort()).toEqual([...REGISTRY_SYMBOLS].sort());
  });

  it("drops a token's card rather than scoring it, when its sources are all down", async () => {
    // No market quote means no EUR reference price. The EURC card must
    // disappear instead of being built from a fabricated number.
    const signals = await buildWith({
      market: false,
      github: false,
      x: false,
      news: false,
      whale: false,
      discord: false,
    });

    expect(signals).toHaveLength(0);
  });
});
