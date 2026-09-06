/**
 * Crypto news headline sentiment from free public RSS feeds - LIVE, keyless.
 *
 * Real headlines are fetched from major crypto outlets' public RSS feeds,
 * bucketed per asset by literal keyword match, and scored with the shared
 * deterministic lexicon. When every feed is unreachable (or no headline
 * mentions an asset) the component is OMITTED - never fabricated, never
 * served stale past its TTL.
 *
 * Guards: single fetch shared across assets, single-flight dedup so
 * concurrent /signals callers never fan out, 30min success cache,
 * 10min failure cooldown, per-feed timeout with partial tolerance
 * (one dead feed does not kill the snapshot).
 */

import { scoreTexts, type LexiconScore } from "./sentiment-lexicon";

const FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

const SUCCESS_TTL_MS = 30 * 60_000; // 30 minutes
const FAILURE_COOLDOWN_MS = 10 * 60_000; // 10 minutes
const FEED_TIMEOUT_MS = 8_000;

/**
 * Assets the news pipeline buckets headlines for. These mirror the pinned Arc
 * token registry: BTC stands in for the cirBTC sleeve, whose only honest
 * reference is the real Bitcoin market.
 */
export type NewsAsset = "BTC" | "EURC" | "USDC";

export interface NewsSentiment extends LexiconScore {
  asset: NewsAsset;
  /** Names of the feeds that actually responded. */
  feeds: string[];
  fetchedAt: number;
}

/**
 * Literal keyword buckets. Deliberately tight: a headline is counted for an
 * asset only when it names it, because a loose match ("euro" catching every
 * European regulator story) would score noise as sentiment.
 */
const PATTERNS: Record<NewsAsset, RegExp> = {
  BTC: /\bbtc\b|bitcoin/i,
  EURC: /\beurc\b|euro coin|euro stablecoin|euro-backed/i,
  USDC: /\busdc\b|usd coin|stablecoin|\bcircle\b/i,
};

const NEWS_ASSETS = Object.keys(PATTERNS) as NewsAsset[];

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  let value = m[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1];
  return decodeEntities(stripTags(value)).replace(/\s+/g, " ").trim();
}

/** Pulls "title description" text out of every <item> in an RSS document. */
function parseFeedItems(xml: string): string[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  return items
    .map((item) => `${extractTag(item, "title")} ${extractTag(item, "description")}`.trim())
    .filter((text) => text.length > 0);
}

interface NewsSnapshot {
  assets: Record<NewsAsset, NewsSentiment | null>;
  fetchedAt: number;
}

let snapshot: NewsSnapshot | null = null;
let inFlight: Promise<NewsSnapshot> | null = null;
let failureCooldownUntil = 0;

async function fetchFeed(url: string): Promise<string[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml, */*",
      "User-Agent": "revo-treasury-testnet-simulator",
    },
  });
  if (!res.ok) {
    throw new Error(`Feed responded ${res.status}`);
  }
  return parseFeedItems(await res.text());
}

async function refreshSnapshot(): Promise<NewsSnapshot> {
  const results = await Promise.allSettled(FEEDS.map((feed) => fetchFeed(feed.url)));
  const texts: string[] = [];
  const okFeeds: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      okFeeds.push(FEEDS[i].name);
      texts.push(...result.value);
    } else {
      console.error(`News feed unavailable (${FEEDS[i].name}):`, result.reason);
    }
  });
  if (okFeeds.length === 0) {
    throw new Error("All news feeds unreachable");
  }

  const now = Date.now();
  const build = (asset: NewsAsset): NewsSentiment | null => {
    const matched = texts.filter((t) => PATTERNS[asset].test(t));
    const scored = scoreTexts(matched);
    return scored ? { ...scored, asset, feeds: okFeeds, fetchedAt: now } : null;
  };

  const assets = {} as Record<NewsAsset, NewsSentiment | null>;
  for (const asset of NEWS_ASSETS) {
    assets[asset] = build(asset);
  }

  const next: NewsSnapshot = { assets, fetchedAt: now };
  snapshot = next;
  failureCooldownUntil = 0;
  return next;
}

export async function fetchNewsSentiment(asset: NewsAsset): Promise<NewsSentiment | null> {
  const now = Date.now();
  if (snapshot && now - snapshot.fetchedAt < SUCCESS_TTL_MS) {
    return snapshot.assets[asset];
  }
  if (now < failureCooldownUntil) {
    return null; // cooling down - omit, never refetch early, never serve stale
  }

  if (!inFlight) {
    inFlight = refreshSnapshot().finally(() => {
      inFlight = null;
    });
  }
  try {
    const fresh = await inFlight;
    return fresh.assets[asset];
  } catch (error) {
    console.error("News sentiment unavailable:", error);
    failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    return null;
  }
}
