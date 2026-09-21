/**
 * Discord community sentiment - DORMANT until configured.
 *
 * Activates only when BOTH are present:
 *  - DISCORD_BOT_TOKEN   (secret; a bot the user creates and invites)
 *  - DISCORD_CHANNEL_IDS (comma-separated channel IDs the bot can read)
 *
 * Without them, fetchDiscordSentiment() returns null and the community
 * signal is simply absent - the same never-fabricate pattern as X.
 * Discord's API is free but rate-limited, so the same guard set applies:
 * single-flight dedup, 30min success cache, 15min failure cooldown, and a
 * hard cap on channels/messages read per refresh.
 */

import { scoreTexts, type LexiconScore } from "./sentiment-lexicon";

const DISCORD_API = "https://discord.com/api/v10";
const SUCCESS_TTL_MS = 30 * 60_000; // 30 minutes
const FAILURE_COOLDOWN_MS = 15 * 60_000; // 15 minutes
const MAX_CHANNELS = 3;
const MESSAGES_PER_CHANNEL = 50;

export interface DiscordSentiment extends LexiconScore {
  /** How many configured channels actually responded. */
  channels: number;
  fetchedAt: number;
}

function configuredChannels(): string[] {
  return (process.env.DISCORD_CHANNEL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .slice(0, MAX_CHANNELS);
}

export function discordSentimentEnabled(): boolean {
  return Boolean(process.env.DISCORD_BOT_TOKEN) && configuredChannels().length > 0;
}

/** Defensively extract human message texts from a Discord messages payload. */
function extractMessageTexts(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  const texts: string[] = [];
  for (const item of body) {
    if (typeof item !== "object" || item === null) continue;
    const message = item as { content?: unknown; author?: { bot?: unknown } };
    if (message.author && message.author.bot === true) continue; // humans only
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      texts.push(message.content);
    }
  }
  return texts;
}

interface CacheEntry {
  /** Null when the channels were readable but held no scoreable human text. */
  sentiment: DiscordSentiment | null;
  fetchedAt: number;
}

// The attempt timestamp is tracked independently of the (nullable) result so
// an empty-but-successful read still honors the success TTL instead of
// re-polling Discord on every /signals request.
let cached: CacheEntry | null = null;
let inFlight: Promise<DiscordSentiment | null> | null = null;
let failureCooldownUntil = 0;

async function fetchChannelMessages(channelId: string, token: string): Promise<string[]> {
  const res = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages?limit=${MESSAGES_PER_CHANNEL}`,
    {
      signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "revo-treasury",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Discord API responded ${res.status}`);
  }
  return extractMessageTexts(await res.json());
}

async function refreshSentiment(token: string, channels: string[]): Promise<DiscordSentiment | null> {
  const results = await Promise.allSettled(
    channels.map((id) => fetchChannelMessages(id, token)),
  );
  const texts: string[] = [];
  let okChannels = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      okChannels += 1;
      texts.push(...result.value);
    } else {
      console.error("Discord channel unavailable:", result.reason);
    }
  }
  if (okChannels === 0) {
    throw new Error("No configured Discord channel was readable");
  }

  const scored = scoreTexts(texts);
  const sentiment: DiscordSentiment | null = scored
    ? { ...scored, channels: okChannels, fetchedAt: Date.now() }
    : null;
  cached = { sentiment, fetchedAt: Date.now() };
  failureCooldownUntil = 0;
  return sentiment;
}

export async function fetchDiscordSentiment(): Promise<DiscordSentiment | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channels = configuredChannels();
  if (!token || channels.length === 0) return null; // dormant until configured

  const now = Date.now();
  if (cached && now - cached.fetchedAt < SUCCESS_TTL_MS) {
    return cached.sentiment;
  }
  if (now < failureCooldownUntil) {
    return null; // cooling down - omit, never fabricate
  }

  if (!inFlight) {
    inFlight = refreshSentiment(token, channels).finally(() => {
      inFlight = null;
    });
  }
  try {
    return await inFlight;
  } catch (error) {
    console.error("Discord sentiment unavailable:", error);
    failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    return null;
  }
}
