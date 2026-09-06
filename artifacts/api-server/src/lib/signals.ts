import { ARC_TOKENS, type TradedSymbol } from "./arc-tokens";
import { getMarketQuote } from "./market";
import { fetchXSentiment } from "./x-sentiment";
import { fetchNewsSentiment } from "./news-sentiment";
import { fetchWhaleActivity } from "./whale-watch";
import { fetchDiscordSentiment } from "./discord-sentiment";

/**
 * Alpha signals computed from real public data sources:
 *  - CoinGecko market quotes (price, 24h momentum, USDC peg deviation)
 *  - GitHub public API (7-day commit activity on the issuer contracts behind
 *    the treasury's tokens)
 *  - Crypto news RSS feeds (live headline sentiment, keyless)
 *  - Arc Testnet RPC whale scan (live large-USDC-transfer monitoring)
 *  - X (Twitter) recent-post sentiment - dormant until X_API_BEARER_TOKEN is set
 *  - Discord community sentiment - dormant until DISCORD_BOT_TOKEN + DISCORD_CHANNEL_IDS are set
 *
 * The feed only ever reports on assets the treasury can actually hold, which
 * is the pinned Arc token registry and nothing else. A risk signal for a
 * position an operator cannot take is worse than no signal: it invites a
 * decision the treasury has no way to act on.
 *
 * Each signal is a per-asset COMPOSITE: every upstream source contributes a
 * signed component score (-100 bearish .. +100 bullish) with a weight, and
 * the composite 0-100 score is derived from the weighted sum. Every number
 * shown in a component is derived from actually fetched data. When a source
 * is unavailable its component is simply omitted and the remaining weights
 * are renormalized - components are never fabricated.
 */

export interface SignalComponent {
  source: string;
  label: string;
  /** Signed contribution: -100 (bearish) .. +100 (bullish). */
  score: number;
  /** Weight in the composite (0..1); weights across a signal sum to 1. */
  weight: number;
  detail: string;
}

export interface ComputedSignal {
  id: string;
  /**
   * The treasury token this signal is about, typed to the pinned registry so a
   * signal cannot be scoped to an asset the treasury has no way to hold.
   *
   * Omitted, never faked, when a signal is not about a token at all. Community
   * sentiment is the case in point: it reads the DAO's mood, not a position,
   * and labelling it with a ticker-shaped placeholder would put a tradable-
   * looking asset in front of an operator where there is none.
   */
  asset?: TradedSymbol;
  score: number;
  direction: string;
  title: string;
  sources: string[];
  confidence: number;
  time: string;
  detail: string;
  components: SignalComponent[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Renormalizes weights of the available components so they sum to EXACTLY 1
 * after 2-decimal rounding: any rounding residual is assigned to the
 * largest-weight component so displayed weights never total 0.99 or 1.01.
 */
function normalizeWeights(components: SignalComponent[]): SignalComponent[] {
  const total = components.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) return components;
  const rounded = components.map((c) => ({
    ...c,
    weight: Math.round((c.weight / total) * 100) / 100,
  }));
  const roundedSum = rounded.reduce((sum, c) => sum + c.weight, 0);
  const residual = Math.round((1 - roundedSum) * 100) / 100;
  if (residual !== 0) {
    let idx = 0;
    for (let i = 1; i < rounded.length; i += 1) {
      if (rounded[i].weight > rounded[idx].weight) idx = i;
    }
    rounded[idx] = {
      ...rounded[idx],
      weight: Math.round((rounded[idx].weight + residual) * 100) / 100,
    };
  }
  return rounded;
}

/** Weighted signed sum (-100..+100) mapped onto the 0-100 composite scale. */
function compositeScore(components: SignalComponent[]): number {
  const weighted = components.reduce((sum, c) => sum + c.score * c.weight, 0);
  return Math.round(clamp(50 + weighted / 2, 2, 98));
}

interface RepoActivity {
  commits: number;
  windowDays: number;
  fetchedAt: number;
}

const GITHUB_CACHE_TTL_MS = 15 * 60_000;
const githubCache = new Map<string, RepoActivity>();

/**
 * Scales a signed 24h percentage change onto the -100..+100 component range.
 * The factor sets where the component saturates, which has to differ per
 * asset: a 5% day is ordinary for BTC and would be an extraordinary one for
 * EURC, whose USD value tracks the euro and moves an order of magnitude less.
 */
const BTC_MOMENTUM_SCALE = 20; // saturates around a 5% day
const EURC_MOMENTUM_SCALE = 60; // saturates around a 1.7% day

/**
 * Derived from the pinned registry rather than written out, so the copy on the
 * reserve card can never drift away from the tokens the treasury can hold.
 */
const TOKEN_SET_LABEL = Object.keys(ARC_TOKENS).join(" / ");

async function fetchRepoActivity(owner: string, repo: string): Promise<RepoActivity | null> {
  const key = `${owner}/${repo}`;
  const cached = githubCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < GITHUB_CACHE_TTL_MS) {
    return cached;
  }

  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&per_page=100`,
      {
        signal: AbortSignal.timeout(6_000),
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "revo-treasury-testnet-simulator",
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub responded ${res.status}`);
    }
    const commits = (await res.json()) as unknown[];
    const activity: RepoActivity = {
      commits: Array.isArray(commits) ? commits.length : 0,
      windowDays: 7,
      fetchedAt: Date.now(),
    };
    githubCache.set(key, activity);
    return activity;
  } catch (error) {
    console.error(`GitHub activity unavailable for ${key}:`, error);
    return cached ?? null;
  }
}

export async function buildSignals(): Promise<ComputedSignal[]> {
  const now = new Date().toISOString();
  const signals: ComputedSignal[] = [];

  const [
    quote,
    issuerRepoActivity,
    btcSentiment,
    eurcSentiment,
    usdcSentiment,
    btcNews,
    eurcNews,
    usdcNews,
    whale,
    discord,
  ] = await Promise.all([
    getMarketQuote(),
    // Circle's FiatToken implementation is the issuer contract behind both the
    // USDC reserve and the EURC sleeve on Arc, so its churn is real risk for
    // both legs rather than a per-asset curiosity.
    fetchRepoActivity("circlefin", "stablecoin-evm"),
    fetchXSentiment("BTC"),
    fetchXSentiment("EURC"),
    fetchXSentiment("USDC"),
    fetchNewsSentiment("BTC"),
    fetchNewsSentiment("EURC"),
    fetchNewsSentiment("USDC"),
    fetchWhaleActivity(),
    fetchDiscordSentiment(),
  ]);

  // ---- cirBTC composite: the Bitcoin sleeve, marked against the real BTC market ----
  {
    const token = ARC_TOKENS.cirBTC;
    const components: SignalComponent[] = [];
    const btcUsd = quote?.btcUsd;
    const btcChange = quote?.btcChange24h;

    if (quote && typeof btcUsd === "number" && typeof btcChange === "number") {
      components.push({
        source: "CoinGecko market data",
        label: "24h momentum",
        score: Math.round(clamp(btcChange * BTC_MOMENTUM_SCALE, -100, 100)),
        weight: 0.6,
        detail: `BTC at $${btcUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}, ${btcChange >= 0 ? "up" : "down"} ${Math.abs(btcChange).toFixed(2)}% in 24h${quote.stale ? " (last successful fetch)" : ""}. This is the reference market the ${token.symbol} sleeve is marked against, not the Arc pool rate.`,
      });
    }

    if (btcSentiment) {
      components.push({
        source: "X (Twitter) public posts",
        label: "Social sentiment",
        score: btcSentiment.score,
        weight: 0.25,
        detail: `${btcSentiment.sampleSize} recent English posts on BTC: ${btcSentiment.bullish} bullish vs ${btcSentiment.bearish} bearish (${btcSentiment.neutral} neutral).`,
      });
    }

    if (btcNews) {
      components.push({
        source: "Crypto news RSS feeds",
        label: "News sentiment",
        score: btcNews.score,
        weight: 0.25,
        detail: `${btcNews.sampleSize} live headline${btcNews.sampleSize === 1 ? "" : "s"} mentioning BTC from ${btcNews.feeds.join(", ")}: ${btcNews.bullish} bullish vs ${btcNews.bearish} bearish (${btcNews.neutral} neutral).`,
      });
    }

    if (components.length > 0) {
      const normalized = normalizeWeights(components);
      const score = compositeScore(normalized);
      signals.push({
        id: "sig-cirbtc-composite",
        asset: token.symbol,
        score,
        direction: score >= 58 ? "positive" : score <= 38 ? "warning" : "neutral",
        title:
          score >= 58
            ? `${token.symbol} sleeve reads constructive`
            : score <= 38
              ? `${token.symbol} sleeve under pressure`
              : `${token.symbol} sleeve balanced`,
        sources: normalized.map((c) => c.source),
        confidence: Math.round(
          clamp(55 + normalized.length * 12 + Math.abs(btcChange ?? 0) * 3, 55, 95),
        ),
        time: quote && quote.stale ? new Date(quote.fetchedAt).toISOString() : now,
        detail: `Composite of ${normalized.length} live source${normalized.length > 1 ? "s" : ""} on the ${token.name.toLowerCase()} the treasury holds as ${token.symbol}, read from the real BTC market.${token.tradable ? "" : ` Price risk only: Revo will not route a trade in ${token.symbol}, because ${token.untradableReason}.`} Each component score below is computed from actually fetched data.`,
        components: normalized,
      });
    }
  }

  // ---- EURC composite: the only risk sleeve Revo can actually trade ----
  {
    const token = ARC_TOKENS.EURC;
    const components: SignalComponent[] = [];
    const eurUsd = quote?.eurUsd;
    const eurChange = quote?.eurChange24h;

    if (quote && typeof eurUsd === "number" && typeof eurChange === "number") {
      components.push({
        source: "CoinGecko market data",
        label: "24h momentum",
        score: Math.round(clamp(eurChange * EURC_MOMENTUM_SCALE, -100, 100)),
        weight: 0.6,
        detail: `${token.symbol} last traded at $${eurUsd.toFixed(4)}, ${eurChange >= 0 ? "up" : "down"} ${Math.abs(eurChange).toFixed(2)}% in 24h${quote.stale ? " (last successful fetch)" : ""}. The sleeve's USD value moves with the euro, so this is currency exposure rather than crypto beta.`,
      });
    }

    if (issuerRepoActivity) {
      components.push({
        source: "GitHub public API",
        label: "Issuer contract churn",
        score: Math.round(clamp(24 - issuerRepoActivity.commits * 8, -100, 100)),
        weight: 0.3,
        detail: `circlefin/stablecoin-evm landed ${issuerRepoActivity.commits} commits in ${issuerRepoActivity.windowDays} days; ${token.symbol} is issued from the same Circle contract family as USDC, so issuer-side changes are monitored for both.`,
      });
    }

    if (eurcSentiment) {
      components.push({
        source: "X (Twitter) public posts",
        label: "Social sentiment",
        score: eurcSentiment.score,
        weight: 0.2,
        detail: `${eurcSentiment.sampleSize} recent English posts on ${token.symbol}: ${eurcSentiment.bullish} bullish vs ${eurcSentiment.bearish} bearish (${eurcSentiment.neutral} neutral).`,
      });
    }

    if (eurcNews) {
      components.push({
        source: "Crypto news RSS feeds",
        label: "News sentiment",
        score: eurcNews.score,
        weight: 0.2,
        detail: `${eurcNews.sampleSize} live headline${eurcNews.sampleSize === 1 ? "" : "s"} mentioning ${token.symbol} from ${eurcNews.feeds.join(", ")}: ${eurcNews.bullish} bullish vs ${eurcNews.bearish} bearish (${eurcNews.neutral} neutral).`,
      });
    }

    if (components.length > 0) {
      const normalized = normalizeWeights(components);
      const score = compositeScore(normalized);
      signals.push({
        id: "sig-eurc-composite",
        asset: token.symbol,
        score,
        direction: score >= 58 ? "positive" : score <= 38 ? "warning" : "neutral",
        title:
          score >= 58
            ? `${token.symbol} sleeve reads constructive`
            : score <= 38
              ? `${token.symbol} sleeve under pressure`
              : `${token.symbol} sleeve balanced`,
        sources: normalized.map((c) => c.source),
        confidence: Math.round(clamp(55 + normalized.length * 12, 55, 90)),
        time: quote && quote.stale ? new Date(quote.fetchedAt).toISOString() : now,
        detail: `Composite of ${normalized.length} live source${normalized.length > 1 ? "s" : ""} on the ${token.name.toLowerCase()}, the one risk leg Revo will actually route a trade in. Each component score below is computed from actually fetched data.`,
        components: normalized,
      });
    }
  }

  // ---- USDC composite: peg stability + issuer contract churn ----
  {
    const token = ARC_TOKENS.USDC;
    const components: SignalComponent[] = [];

    if (quote) {
      const pegDeviationBps = Math.abs(1 - quote.usdcUsd) * 10_000;
      components.push({
        source: "CoinGecko market data",
        label: "Peg stability",
        score: Math.round(clamp(96 - pegDeviationBps * 12, -100, 100)),
        weight: 0.7,
        detail: `USDC last traded at $${quote.usdcUsd.toFixed(4)}, a peg deviation of ${pegDeviationBps.toFixed(1)} bps.`,
      });
    }

    if (issuerRepoActivity) {
      components.push({
        source: "GitHub public API",
        label: "Issuer contract churn",
        score: Math.round(clamp(24 - issuerRepoActivity.commits * 8, -100, 100)),
        weight: 0.3,
        detail: `circlefin/stablecoin-evm landed ${issuerRepoActivity.commits} commits in ${issuerRepoActivity.windowDays} days; issuer-side contract changes are monitored for reserve risk.`,
      });
    }

    if (usdcSentiment) {
      components.push({
        source: "X (Twitter) public posts",
        label: "Social sentiment",
        score: usdcSentiment.score,
        weight: 0.2,
        detail: `${usdcSentiment.sampleSize} recent English posts on USDC: ${usdcSentiment.bullish} bullish vs ${usdcSentiment.bearish} bearish (${usdcSentiment.neutral} neutral).`,
      });
    }

    if (usdcNews) {
      components.push({
        source: "Crypto news RSS feeds",
        label: "News sentiment",
        score: usdcNews.score,
        weight: 0.2,
        detail: `${usdcNews.sampleSize} live headline${usdcNews.sampleSize === 1 ? "" : "s"} on USDC/stablecoins from ${usdcNews.feeds.join(", ")}: ${usdcNews.bullish} bullish vs ${usdcNews.bearish} bearish (${usdcNews.neutral} neutral).`,
      });
    }

    if (components.length > 0) {
      const normalized = normalizeWeights(components);
      const score = compositeScore(normalized);
      const pegDeviationBps = quote ? Math.abs(1 - quote.usdcUsd) * 10_000 : null;
      signals.push({
        id: "sig-usdc-composite",
        asset: "USDC",
        score,
        direction:
          pegDeviationBps !== null && pegDeviationBps >= 20
            ? "warning"
            : score >= 58
              ? "positive"
              : "neutral",
        title:
          pegDeviationBps !== null && pegDeviationBps >= 20
            ? "USDC peg deviation above tolerance"
            : "USDC reserve backdrop steady",
        sources: normalized.map((c) => c.source),
        confidence: Math.round(clamp(58 + normalized.length * 16, 58, 92)),
        time: quote && quote.stale ? new Date(quote.fetchedAt).toISOString() : now,
        detail: `Composite of ${normalized.length} live source${normalized.length > 1 ? "s" : ""} guarding the ${token.name.toLowerCase()}, the stable leg of a ${TOKEN_SET_LABEL} book. Each component score below is computed from actually fetched data.`,
        components: normalized,
      });
    }
  }

  // ---- On-chain whale flow: live scan of large USDC transfers on Arc ----
  if (whale) {
    const windowLabel =
      whale.windowMinutes !== null
        ? `~${whale.windowMinutes >= 120 ? `${Math.round(whale.windowMinutes / 60)} hours` : `${whale.windowMinutes} minutes`}`
        : `${whale.windowBlocks} blocks`;
    const components: SignalComponent[] = [
      {
        source: "Arc Testnet RPC",
        label: "Large USDC moves",
        score: Math.round(clamp(25 - whale.whaleCount * 20, -100, 100)),
        weight: 1,
        detail: `${whale.totalTransfers} on-chain USDC transfer${whale.totalTransfers === 1 ? "" : "s"} observed over ${windowLabel} (${whale.windowBlocks} blocks); ${whale.whaleCount} at or above the ${whale.whaleThresholdUsdc.toLocaleString("en-US")} USDC whale threshold${whale.whaleCount > 0 ? `, moving ${Math.round(whale.whaleVolumeUsdc).toLocaleString("en-US")} USDC total (largest ${Math.round(whale.largestUsdc).toLocaleString("en-US")} USDC)` : whale.totalTransfers > 0 ? ` (largest seen ${whale.largestUsdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC)` : ""}.`,
      },
    ];
    const score = compositeScore(components);
    signals.push({
      id: "sig-whale-flow",
      asset: "USDC",
      score,
      direction: whale.whaleCount >= 2 ? "warning" : score >= 58 ? "positive" : "neutral",
      title:
        whale.whaleCount >= 2
          ? "Heavy whale movement on Arc"
          : whale.whaleCount === 1
            ? "One whale-sized USDC move on Arc"
            : "Whale flows calm on Arc",
      sources: ["Arc Testnet RPC"],
      confidence: Math.round(clamp(60 + Math.min(whale.totalTransfers, 30), 60, 90)),
      time: new Date(whale.fetchedAt).toISOString(),
      detail: `Live scan of USDC ERC-20 transfers on Arc Testnet. Every number is a real observed on-chain event; whale threshold is ${whale.whaleThresholdUsdc.toLocaleString("en-US")} USDC.`,
      components,
    });
  }

  // ---- Community pulse: Discord sentiment (dormant until bot configured) ----
  if (discord) {
    const components: SignalComponent[] = [
      {
        source: "Discord community channels",
        label: "Community sentiment",
        score: discord.score,
        weight: 1,
        detail: `${discord.sampleSize} recent human messages across ${discord.channels} channel${discord.channels === 1 ? "" : "s"}: ${discord.bullish} bullish vs ${discord.bearish} bearish (${discord.neutral} neutral).`,
      },
    ];
    const score = compositeScore(components);
    signals.push({
      // No asset: community mood is not a position. Scoping this card to a
      // ticker would put an asset in front of an operator that this signal
      // says nothing about, which is the same mistake as reporting on a token
      // the treasury cannot hold.
      id: "sig-community-pulse",
      score,
      direction: score >= 58 ? "positive" : score <= 38 ? "warning" : "neutral",
      title:
        score >= 58
          ? "Community pulse upbeat"
          : score <= 38
            ? "Community pulse souring"
            : "Community pulse steady",
      sources: ["Discord community channels"],
      confidence: Math.round(clamp(55 + Math.min(discord.sampleSize, 30), 55, 88)),
      time: new Date(discord.fetchedAt).toISOString(),
      detail: `Lexicon sentiment over real messages read from the configured Discord channels.`,
      components,
    });
  }

  return signals;
}
