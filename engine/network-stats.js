// Kaspa network statistics for the Portfolio screen's hashrate card and its chart: the hashrate
// series, the current block reward, and when the next chromatic halving lands.
//
// Port of iOS's KaspaNetworkStatsService. All three come off the same Kaspa REST API the rest of
// the app already talks to, so there is no extra host and no key.

import { getEndpoint } from "./endpoints.js";

/// Daily samples. The finer resolutions return tens of thousands of points for the full chain
/// history, which is a chart nobody can read and a payload nobody needs.
const RESOLUTION = "1d";
/// The card is not worth re-fetching on every visit; the series moves on the scale of days.
const MIN_REFETCH_MS = 5 * 60_000;

let cache = null;
let inFlight = null;

function base() {
  return String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
}

async function getJson(path) {
  const response = await fetch(`${base()}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/// `[[timestampMs, hashrateHs], …]`, oldest first. The API reports in TH/s in some deployments
/// and H/s in others, so the value is normalised to hashes per second on the way in - a chart
/// silently off by 10^12 is worse than no chart.
function seriesFrom(samples) {
  if (!Array.isArray(samples)) return [];
  const points = [];
  for (const sample of samples) {
    const ts = Number(sample?.timestamp);
    const raw = Number(sample?.hashrate_kh ?? sample?.hashrate ?? NaN);
    if (!Number.isFinite(ts) || !Number.isFinite(raw) || raw <= 0) continue;
    // `hashrate_kh` is kilohashes per second; a bare `hashrate` field is already H/s.
    const hs = sample?.hashrate_kh !== undefined ? raw * 1e3 : raw;
    points.push([ts < 1e12 ? ts * 1000 : ts, hs]);
  }
  return points.sort((a, b) => a[0] - b[0]);
}

/// Everything the hashrate card and screen need, or null when the network could not be read.
/// Deliberately never throws: a chart nobody asked for is not worth an error banner, so a failure
/// leaves the card empty and the last good answer standing.
export async function fetchNetworkStats({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.fetchedAt < MIN_REFETCH_MS) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const history = seriesFrom(await getJson(`/info/hashrate/history?resolution=${RESOLUTION}`));
      if (!history.length) return cache;

      // The reward is NOT a constant: Kaspa steps it down every month on the chromatic halving
      // (a smooth 1/2^(1/12) rather than a cliff every four years), so a hardcoded figure would
      // be wrong within weeks. Both of these are best-effort - the chart stands without them.
      let blockRewardKas = cache?.blockRewardKas ?? null;
      let nextHalving = cache?.nextHalving ?? null;
      try {
        const reward = Number((await getJson("/info/blockreward"))?.blockreward);
        if (Number.isFinite(reward) && reward > 0) blockRewardKas = reward;
      } catch { /* keep the previous figure */ }
      try {
        const halving = await getJson("/info/halving");
        const amount = Number(halving?.nextHalvingAmount);
        const timestamp = Number(halving?.nextHalvingTimestamp);
        if (Number.isFinite(amount) && amount > 0 && Number.isFinite(timestamp)) {
          nextHalving = { amountKas: amount, at: timestamp < 1e12 ? timestamp * 1000 : timestamp };
        }
      } catch { /* keep the previous figure */ }

      cache = {
        history,
        currentHashrate: history[history.length - 1][1],
        blockRewardKas,
        nextHalving,
        fetchedAt: Date.now(),
      };
      return cache;
    } catch {
      return cache;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function peekNetworkStats() { return cache; }

/// One blocks-per-second figure for the mining estimate. Kaspa targets ten blocks a second, and
/// the estimate is a rule of thumb rather than a promise, so this is stated rather than derived.
export const BLOCKS_PER_SECOND = 10;

/// H/s rendered as the unit people actually quote, stepping exactly the way iOS's
/// `HashrateFormat.display` steps so the same series reads identically on both.
///
/// The API reports kilohashes per second in `hashrate_kh`, which is where the trap is: 1 PH/s is
/// 1e12 kH/s, and reading that as EH/s draws the network a thousand times bigger than it is. iOS
/// hit exactly that and left the note; both endpoints agree at ~317 PH/s.
export function formatHashrate(hs) {
  const value = Number(hs);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const phs = value / 1e15;
  if (phs >= 1000) return `${(phs / 1000).toFixed(2)} EH/s`;
  if (phs >= 1) return `${phs.toFixed(1)} PH/s`;
  if (phs >= 0.001) return `${(phs * 1000).toFixed(1)} TH/s`;
  // iOS bottoms out at GH/s, which renders the chain's earliest samples as "0.0 GH/s". One more
  // step down costs nothing and only differs from iOS where iOS says nothing useful.
  if (phs >= 1e-6) return `${(phs * 1e6).toFixed(1)} GH/s`;
  return `${(phs * 1e9).toFixed(1)} MH/s`;
}

/// Parses what someone types into the mining estimate ("120 TH/s", "3.5 ph", "500") into H/s.
/// A bare number is read as TH/s, which is the unit a single miner's rig is quoted in.
export function parseHashrateInput(text) {
  const raw = String(text || "").trim().toLowerCase().replace(/,/g, "");
  if (!raw) return null;
  const match = /^([0-9]*\.?[0-9]+)\s*(e|p|t|g|m|k)?h?\/?s?$/.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const scale = { e: 1e18, p: 1e15, t: 1e12, g: 1e9, m: 1e6, k: 1e3 }[match[2] || "t"];
  return amount * scale;
}

/// Daily KAS for a given share of the network, at the current reward.
///
/// Your share of the hashrate times the network's daily emission. It ignores luck, pool fees,
/// orphan rate and every other real-world subtraction, which is why the screen calls it an
/// estimate and says so.
export function estimateDailyKas({ yourHashrateHs, networkHashrateHs, blockRewardKas }) {
  const yours = Number(yourHashrateHs);
  const network = Number(networkHashrateHs);
  const reward = Number(blockRewardKas);
  if (!Number.isFinite(yours) || yours <= 0) return null;
  if (!Number.isFinite(network) || network <= 0) return null;
  if (!Number.isFinite(reward) || reward <= 0) return null;
  const dailyNetworkEmission = reward * BLOCKS_PER_SECOND * 86_400;
  return dailyNetworkEmission * (yours / network);
}
