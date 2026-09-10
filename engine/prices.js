// KAS price data via CoinGecko's public API, in the user's selected currency, with a
// localStorage cache per currency so the portfolio doesn't hammer the endpoint (10-minute
// refresh floor, mirroring the KNS cache policy).
//
// Ported from iOS CoinGeckoService + PortfolioAddressImporter's pricing pipeline:
//   * every call is currency-aware (`vs_currency` / `vs_currencies`) - CoinGecko's public API
//     natively serves any of its listed codes, so switching away from USD needs nothing more
//     than passing the selected code through;
//   * the keyless tier throttles bursts hard (429 for a stretch after a few rapid calls), so
//     every request inspects the response status and gives a 429/5xx exactly one retry that
//     honors `Retry-After` (capped at 10s) - matching CoinGeckoService.getPriceHistory;
//   * historical day prices come from ONE batched `market_chart` range call plus a persistent
//     forever-cache, not a request per day - matching PortfolioAddressImporter.resolveDailyPrices;
//   * nothing here ever throws. Every function degrades to its cached value (however stale) or
//     null/[], so callers can always keep painting their last known good state.

const BASE_URL = "https://api.coingecko.com/api/v3";

const PRICE_CACHE_KEY = "kachat-kas-price-cache-v2";            // { [currency]: { price, change24h, fetchedAt } }
const HISTORY_CACHE_KEY = "kachat-kas-price-history-cache-v2";  // { [currency]: { [days]: { points, fetchedAt } } }
const DAILY_CACHE_KEY = "kachat-kas-daily-price-v2";            // { [currency]: { "YYYY-MM-DD": price } }
// USD-only, "DD-MM-YYYY"-keyed daily cache written by the pre-currency portfolio build. A past
// day's price never changes, so it's worth migrating rather than dropping.
const LEGACY_DAILY_CACHE_KEY = "kachat-kas-daily-price-v1";

const MIN_REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 2000;
const MAX_RETRY_AFTER_MS = 10_000;
/** CoinGecko's keyless tier serves at most the last 365 days of market_chart data. */
const KEYLESS_HISTORY_WINDOW_DAYS = 365;
/** Spacing between per-day `/history` fallback calls - only the backfill's fallback path pays
 *  this, since the main pricing path is a single batched range call. */
export const PRICE_REQUEST_SPACING_MS = 1200;
/** Currency-history buckets untouched for this long are pruned on the next write, so cycling
 *  through many currencies can't slowly fill the localStorage quota with dead range caches. */
const HISTORY_BUCKET_TTL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readCache(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

function normalizeCurrency(currency) {
  const code = String(currency || "usd").trim().toLowerCase();
  return /^[a-z]{2,5}$/.test(code) ? code : "usd";
}

// --- UTC day keys -----------------------------------------------------------
// CoinGecko's history endpoints are UTC-day granularity, so every day key in the pricing
// pipeline (candidate rows, cache keys, backfill matching) is a UTC start-of-day. "YYYY-MM-DD"
// is the internal form (it sorts lexicographically); the /history endpoint wants "DD-MM-YYYY".

const pad2 = (n) => String(n).padStart(2, "0");

export function utcDayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dayKeyToMs(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function dayKeyToCoinGecko(key) {
  const [y, m, d] = String(key).split("-");
  return `${d}-${m}-${y}`;
}

(function migrateLegacyDailyCache() {
  const legacy = readCache(LEGACY_DAILY_CACHE_KEY);
  if (!legacy) return;
  const all = readCache(DAILY_CACHE_KEY) || {};
  const usd = all.usd || {};
  for (const [key, value] of Object.entries(legacy)) {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(key);
    if (!match || !Number.isFinite(Number(value))) continue;
    usd[`${match[3]}-${match[2]}-${match[1]}`] = Number(value);
  }
  all.usd = usd;
  writeCache(DAILY_CACHE_KEY, all);
  try { localStorage.removeItem(LEGACY_DAILY_CACHE_KEY); } catch { /* ignore */ }
})();

// --- low-level HTTP ---------------------------------------------------------

function retryDelayMs(response) {
  const seconds = Number(response.headers.get("Retry-After"));
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** One attempt, plus exactly one Retry-After-honoring retry when the first came back 429/5xx.
 *  Returns the decoded JSON, or null on any failure (network, non-2xx, unparseable body) -
 *  never throws, matching CoinGeckoService's return-nil-on-failure contract. */
async function fetchJsonWithRetry(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch {
      return null; // offline / aborted - a retry would just fail the same way
    }
    if (response.ok) {
      try { return await response.json(); } catch { return null; }
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (attempt > 0 || !retryable) return null;
    await sleep(retryDelayMs(response));
  }
  return null;
}

// --- current price ----------------------------------------------------------

/** Synchronous, no-fetch read of the cached current price for `currency` (or null). */
export function peekKasPrice(currency) {
  const entry = (readCache(PRICE_CACHE_KEY) || {})[normalizeCurrency(currency)];
  return Number.isFinite(entry?.price) ? entry : null;
}

/** Current KAS price in `currency`. Returns `{ price, change24h, currency, fetchedAt }`, cached
 *  for 10 minutes. On any failure returns the cached entry (however stale) or null - callers
 *  keep their last known good price rather than blanking. */
export async function fetchKasPrice({ force = false, currency = "usd" } = {}) {
  const code = normalizeCurrency(currency);
  const cached = peekKasPrice(code);
  if (!force && cached && Date.now() - cached.fetchedAt < MIN_REFRESH_MS) return cached;

  const url = `${BASE_URL}/simple/price?ids=kaspa&vs_currencies=${encodeURIComponent(code)}&include_24hr_change=true`;
  const json = await fetchJsonWithRetry(url);
  const raw = Number(json?.kaspa?.[code]);
  if (!Number.isFinite(raw) || raw <= 0) return cached;

  const result = {
    price: raw,
    change24h: Number(json.kaspa[`${code}_24h_change`]) || 0,
    currency: code,
    fetchedAt: Date.now(),
  };
  const all = readCache(PRICE_CACHE_KEY) || {};
  all[code] = result;
  writeCache(PRICE_CACHE_KEY, all);
  return result;
}

// --- price history ----------------------------------------------------------

/** Raw, uncached `market_chart` range call. `[[timestampMs, price], ...]`, oldest first;
 *  `[]` on any failure. */
async function fetchMarketChart(days, currency) {
  const url = `${BASE_URL}/coins/kaspa/market_chart?vs_currency=${encodeURIComponent(currency)}&days=${encodeURIComponent(String(days))}`;
  const json = await fetchJsonWithRetry(url);
  if (!Array.isArray(json?.prices)) return [];
  return json.prices
    .filter((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => [point[0], point[1]]);
}

/** Synchronous, no-fetch read of the cached history for one (currency, days) pair:
 *  `{ points, fetchedAt }` or null. Lets the chart paint the right range's stale curve
 *  instantly instead of going blank while a refresh is in flight. */
export function peekKasPriceHistory(days, currency) {
  const entry = (readCache(HISTORY_CACHE_KEY) || {})[normalizeCurrency(currency)]?.[String(days)];
  return Array.isArray(entry?.points) && entry.points.length ? entry : null;
}

function persistHistory(days, currency, points) {
  const all = readCache(HISTORY_CACHE_KEY) || {};
  const now = Date.now();
  // Prune currency buckets nothing has touched in a day (see HISTORY_BUCKET_TTL_MS).
  for (const [code, bucket] of Object.entries(all)) {
    if (code === currency) continue;
    const newest = Math.max(0, ...Object.values(bucket || {}).map((entry) => entry?.fetchedAt || 0));
    if (now - newest > HISTORY_BUCKET_TTL_MS) delete all[code];
  }
  const bucket = all[currency] || {};
  bucket[String(days)] = { points, fetchedAt: now };
  all[currency] = bucket;
  writeCache(HISTORY_CACHE_KEY, all);
}

/** Price history for `days` (1|7|30|90|365) in `currency`. Returns `[[timestampMs, price], ...]`.
 *  On failure returns this exact range's cached points (a stale copy of the range that was asked
 *  for beats showing a different range's curve), or `[]` when there's nothing cached. */
/// Market cap and rank, from CoinGecko's `/coins/markets` - the same keyless source everything
/// else here uses (iOS `CoinGeckoService.getMarketStats`).
///
/// CoinMarketCap's own API needs a key, and its rank agrees with CoinGecko's in all but the
/// occasional off-by-one around ties, so this is the figure people recognise without shipping a
/// second provider and a secret to reach it.
///
/// Cached for the same window as the price: these move slowly and the endpoint is rate limited.
let marketStatsCache = null;
export async function fetchKasMarketStats({ currency = "usd", force = false } = {}) {
  const code = normalizeCurrency(currency);
  if (!force && marketStatsCache?.currency === code
      && Date.now() - marketStatsCache.fetchedAt < MIN_REFRESH_MS) {
    return marketStatsCache;
  }
  try {
    const url = `${BASE_URL}/coins/markets?vs_currency=${encodeURIComponent(code)}&ids=kaspa`;
    const json = await fetchJsonWithRetry(url);
    const row = Array.isArray(json) ? json[0] : null;
    const marketCap = Number(row?.market_cap);
    if (!Number.isFinite(marketCap) || marketCap <= 0) return marketStatsCache;
    marketStatsCache = {
      marketCap,
      rank: Number.isFinite(Number(row?.market_cap_rank)) ? Number(row.market_cap_rank) : null,
      currency: code,
      fetchedAt: Date.now(),
    };
    return marketStatsCache;
  } catch {
    // A stat nobody asked for is not worth an error; the card just stays blank.
    return marketStatsCache;
  }
}

export function peekKasMarketStats(currency = "usd") {
  const code = normalizeCurrency(currency);
  return marketStatsCache?.currency === code ? marketStatsCache : null;
}

export async function fetchKasPriceHistory(days = 7, { currency = "usd", force = false } = {}) {
  const code = normalizeCurrency(currency);
  const cached = peekKasPriceHistory(days, code);
  if (!force && cached && Date.now() - cached.fetchedAt < MIN_REFRESH_MS) return cached.points;

  const points = await fetchMarketChart(days, code);
  if (!points.length) return cached?.points || [];
  persistHistory(days, code, points);
  return points;
}

// --- historical day prices --------------------------------------------------

/** Cached-only read for a set of "YYYY-MM-DD" UTC day keys: `{ [dayKey]: price }`. */
export function peekDailyPrices(dayKeys, currency) {
  const bucket = (readCache(DAILY_CACHE_KEY) || {})[normalizeCurrency(currency)] || {};
  const result = {};
  for (const key of dayKeys || []) {
    if (Number.isFinite(bucket[key])) result[key] = bucket[key];
  }
  return result;
}

/** A past day's historical price never changes, so resolved days are cached forever (per
 *  currency) - re-imports and backfill passes never re-pay a network call for a day any earlier
 *  import already priced. Today's "price" is still moving, so it's never frozen into the cache. */
function storeDailyPrices(prices, currency) {
  const todayKey = utcDayKey(Date.now()); // "YYYY-MM-DD" sorts lexicographically
  const entries = Object.entries(prices || {}).filter(([key, value]) => key < todayKey && Number.isFinite(value));
  if (!entries.length) return;
  const all = readCache(DAILY_CACHE_KEY) || {};
  const bucket = all[currency] || {};
  for (const [key, value] of entries) bucket[key] = value;
  all[currency] = bucket;
  writeCache(DAILY_CACHE_KEY, all);
}

/** Resolves historical prices for a set of UTC day keys: persistent cache first, then ONE
 *  `market_chart` range call covering every still-unpriced day inside CoinGecko's keyless
 *  365-day window - replacing the one-request-per-day burst that tripped the rate limit on any
 *  import with more than a handful of trading days. Days it can't cover (older than a year, or
 *  the range call failed) are simply absent from the result, for the per-day fallback to pick up.
 *  Port of PortfolioAddressImporter.resolveDailyPrices. */
export async function resolveDailyPrices(dayKeys, currency) {
  const code = normalizeCurrency(currency);
  const unique = [...new Set(dayKeys || [])].sort();
  if (!unique.length) return {};

  const resolved = peekDailyPrices(unique, code);
  const missing = unique.filter((key) => resolved[key] === undefined);
  const oldestMissing = missing[0];
  if (!oldestMissing) return resolved;

  const daysBack = Math.max(1, Math.ceil((Date.now() - dayKeyToMs(oldestMissing)) / 86_400_000) + 1);
  const points = await fetchMarketChart(Math.min(daysBack, KEYLESS_HISTORY_WINDOW_DAYS), code);
  if (!points.length) return resolved;

  // Last sample per UTC day = that day's close (daily-granularity ranges have exactly one sample
  // per day; shorter ranges arrive hourly and collapse the same way, since points are ordered
  // oldest-first and each write overwrites the previous one for that day).
  const byDay = {};
  for (const [ts, value] of points) byDay[utcDayKey(ts)] = value;
  // Cache the WHOLE fetched range, not just the days asked for - future imports and backfill
  // passes for other addresses then price those days with no network call at all.
  storeDailyPrices(byDay, code);
  for (const key of missing) {
    if (byDay[key] !== undefined) resolved[key] = byDay[key];
  }
  return resolved;
}

/** Per-day fallback through `/coins/kaspa/history` for days the batched range couldn't cover.
 *  Cache-first; one paced retry on failure (on top of the 429 Retry-After retry inside
 *  fetchJsonWithRetry); successful lookups join the forever-cache. Returns null when CoinGecko
 *  simply has no snapshot for that date, which callers must treat like any other "couldn't
 *  price this" case. Port of PortfolioAddressImporter.resolveDailyPriceSingle. */
export async function resolveDailyPriceSingle(dayKey, currency) {
  const code = normalizeCurrency(currency);
  const cached = peekDailyPrices([dayKey], code)[dayKey];
  if (cached !== undefined) return cached;

  const lookup = async () => {
    const url = `${BASE_URL}/coins/kaspa/history?date=${encodeURIComponent(dayKeyToCoinGecko(dayKey))}&localization=false`;
    const json = await fetchJsonWithRetry(url);
    const value = Number(json?.market_data?.current_price?.[code]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  let value = await lookup();
  if (value === null) {
    await sleep(PRICE_REQUEST_SPACING_MS);
    value = await lookup();
  }
  if (value !== null) storeDailyPrices({ [dayKey]: value }, code);
  return value;
}
