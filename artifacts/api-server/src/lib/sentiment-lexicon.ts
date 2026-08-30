/**
 * Shared deterministic sentiment lexicon used by every text-based signal
 * source (X posts, news headlines, Discord messages). No LLM, no cost, and
 * fully reproducible: a text is bullish/bearish only because of the real
 * words it contains.
 */

export const BULLISH_TERMS = [
  "bullish", "moon", "pump", "rally", "rallying", "breakout", "accumulate",
  "accumulating", "buying", "long", "surge", "surging", "soar", "soaring",
  "upgrade", "adoption", "partnership", "all-time high", "ath", "undervalued",
  "strong", "growth", "inflow", "inflows", "recover", "recovery",
];

export const BEARISH_TERMS = [
  "bearish", "dump", "dumping", "crash", "crashing", "rug", "scam", "selling",
  "sell-off", "selloff", "short", "shorting", "exploit", "exploited", "hack",
  "hacked", "depeg", "depegged", "fud", "lawsuit", "plunge", "plunging",
  "liquidation", "liquidations", "bankrupt", "insolvent", "outflow", "outflows",
  "collapse", "overvalued", "weak",
];

function countHits(text: string, terms: string[]): number {
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits;
}

export interface LexiconScore {
  /** Signed sentiment: -100 (bearish) .. +100 (bullish). */
  score: number;
  sampleSize: number;
  bullish: number;
  bearish: number;
  neutral: number;
}

/** Scores a set of real fetched texts; null when there is nothing to score. */
export function scoreTexts(texts: string[]): LexiconScore | null {
  if (texts.length === 0) return null;
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  for (const raw of texts) {
    const text = raw.toLowerCase();
    const bull = countHits(text, BULLISH_TERMS);
    const bear = countHits(text, BEARISH_TERMS);
    if (bull > bear) bullish += 1;
    else if (bear > bull) bearish += 1;
    else neutral += 1;
  }
  const total = texts.length;
  const score = Math.round(
    Math.max(-100, Math.min(100, ((bullish - bearish) / total) * 100)),
  );
  return { score, sampleSize: total, bullish, bearish, neutral };
}
