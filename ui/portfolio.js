// Portfolio tab — desktop port of iOS 4.0's single continuous portfolio page: Robinhood-style
// portfolio picker cards (multi-portfolio, per account, today's change per card), iOS summary
// card (Holdings / Current Value / Total Invested / Total P&L / Avg. Buy Price), scrubbable
// KAS price chart with range selector, ledger-replayed Value Over Time chart, and a full
// buy/sell transaction ledger with an edit sheet, CoinMarketCap-compatible CSV import/export,
// and on-chain Kaspa address import. Charts are hand-drawn SVG — no chart library, matching
// the app's zero-dependency approach.

import {
  fetchKasPrice,
  fetchKasPriceHistory,
  peekKasPrice,
  peekKasPriceHistory,
  peekDailyPrices,
  fetchKasMarketStats,
  peekKasMarketStats,
  resolveDailyPrices,
  resolveDailyPriceSingle,
  utcDayKey,
  PRICE_REQUEST_SPACING_MS,
} from "../engine/prices.js";
import { getEndpoint } from "../engine/endpoints.js";
import {
  fetchNetworkStats, peekNetworkStats, formatHashrate, estimateDailyKas,
} from "../engine/network-stats.js";
import { validateMainnetAddress } from "../engine/utils.js";
import { looksLikeDomain, resolveDomain } from "../engine/kns.js";
import { closeActiveScanner, scanKaspaAddress } from "./qr-scan.js";
// Imported, not a string path: Vite only rewrites and emits assets it can SEE, and a path inside
// a template literal is invisible to it - which left this 404ing on the built site.
import kaspaLogoUrl from "./assets/kaspa-logo.png";

const PORTFOLIO_KEY = "kachat-portfolios-v1"; // account-scoped: { activeId, portfolios: [{id, name, transactions: [...] }] }
const MAX_PORTFOLIOS = 5;
// Mirrors iOS PortfolioAddressImporter.priceUnavailableNote — rows the import couldn't price
// synchronously carry this note, show a warning icon, and are filled in by the background price
// backfill (the user can also set a price by hand via the edit sheet).
const PRICE_PENDING_NOTE = "Price loading, will fill in automatically";
// Sentinel written by builds before the background backfill existed. Still recognized so rows
// imported by an older version keep their warning icon and get backfilled too — same two-
// generation scheme as iOS's priceUnavailableNote / legacyPriceUnavailableNote.
const LEGACY_PRICE_UNAVAILABLE_NOTE = "Price unavailable — set manually";

/** True when `notes` marks a row whose price is still pending (either sentinel generation). */
function isPricePending(notes) {
  return notes === PRICE_PENDING_NOTE || notes === LEGACY_PRICE_UNAVAILABLE_NOTE;
}

const RANGES = [
  { days: 1, label: "1D" },
  { days: 7, label: "7D" },
  { days: 30, label: "1M" },
  { days: 90, label: "3M" },
  { days: 365, label: "1Y" },
];

let deps = null;
let rootEl = null;
let modalsEl = null;
let state = { activeId: null, portfolios: [] };
let price = null;          // { price, change24h, currency, fetchedAt }
let history = [];          // [[ts, fiat]] for the selected range — resolved every render
let sevenDayHistory = [];  // fixed 7d window for per-card "today's change" (independent of range)
let valuePoints = [];      // ledger replay of `history` — rebuilt every render
// Session cache of fetched ranges for the CURRENT currency, so switching ranges (or coming back
// to one) repaints instantly instead of blanking while the network catches up. Cleared whenever
// the selected currency changes. Mirrors iOS PortfolioViewModel.priceHistoryCache.
let historyByRange = {};
let historyCurrency = null;
let rangeDays = 7;
let loading = false;
let editingTx = null;      // null = closed; { id } editing; { id: null } adding
// null = closed; otherwise { busy, progress, input, resolving, resolvedAddress, resolvedDomain,
// notFound } — the KNS resolution state for the Add Kaspa Address sheet.
let addressImport = null;
let priceBackfillTimer = null; // non-null while the background price backfill loop is running
let view = "main";         // "main" | "price" | "value" | "hashrate" — which screen is showing
/// What the mining estimate has been typed into. Held here rather than in the DOM so the figure
/// survives the re-render each keystroke triggers.
let hashrateInput = "";
/// The converter's two fields. Only the one being TYPED IN is authoritative - the other is
/// derived - so a rounded value can never be fed back through the rate and drift (iOS
/// KasConverterCard keeps the same rule).
/// The order being edited, which is NOT the live one until Done - the same reason Customize Dock
/// edits a draft: committing on every arrow press would re-render the cards underneath the sheet.
let reorderDraft = [];
/// The unit the mining estimate is entered in. A picker rather than parsing what someone types:
/// "120" alone is ambiguous, and guessing TH/s puts the answer out by three orders of magnitude
/// when they meant GH/s.
const HASHRATE_UNITS = [
  { key: "gh", label: "GH/s", scale: 1e9 },
  { key: "th", label: "TH/s", scale: 1e12 },
  { key: "ph", label: "PH/s", scale: 1e15 },
];
let hashrateUnit = "th";
/// Which card's settings overlay is open, and which step of it.
let cardModalId = null;
let cardModalMode = "menu"; // "menu" | "rename" | "delete"
/// Which of the two header overlays is open.
let actionSheetMode = "add"; // "add" | "io"
let converterKas = "1";
let converterFiat = "";

// ---------------------------------------------------------------------------
// Selected currency
// ---------------------------------------------------------------------------
// The preference itself lives in ui/app.js (Settings > Customization > Currency), which owns the
// picker, persists the choice under this key and fires `kachat:currency-changed` on every change.
// Portfolio is handed `currencyCode`/`currencySymbol` accessors and prefers them; the direct
// key read and the symbol table below stay as the fallback for wiring that predates them
// (app.js's own CURRENCIES table is not exported).
const CURRENCY_PREF_KEY = "kachat-currency-v1";
const CURRENCY_SYMBOLS = {
  usd: "$", eur: "€", gbp: "£", jpy: "¥", cny: "CN¥", aud: "A$", cad: "C$", chf: "CHF ",
  hkd: "HK$", inr: "₹", krw: "₩", sgd: "S$", nzd: "NZ$", mxn: "MX$", brl: "R$", rub: "₽",
  try: "₺", zar: "R", idr: "Rp", btc: "₿",
};

function currencyCode() {
  const fromDeps = deps?.currencyCode?.();
  if (fromDeps && CURRENCY_SYMBOLS[String(fromDeps).toLowerCase()]) return String(fromDeps).toLowerCase();
  try {
    const stored = String(localStorage.getItem(CURRENCY_PREF_KEY) || "").toLowerCase();
    if (CURRENCY_SYMBOLS[stored]) return stored;
  } catch { /* private mode */ }
  return "usd";
}

function currencySymbol() {
  return deps?.currencySymbol?.() || CURRENCY_SYMBOLS[currencyCode()] || "$";
}

// CoinMarketCap-style "what is Kaspa" blurb, paraphrased (not copied verbatim), shown on the
// full-screen KAS price chart below the range selector.
const KASPA_ABOUT = "Kaspa is a decentralized, open-source, proof-of-work cryptocurrency. It is built on the GHOSTDAG protocol - a generalization of Nakamoto consensus that, instead of discarding blocks created in parallel, orders them together in a blockDAG. This lets Kaspa reach very high block rates and near-instant transaction confirmation while keeping the security guarantees of proof of work. Kaspa launched in November 2021 with a fair release: no pre-mine, no pre-sale, and no coin allocations. Its native coin is KAS.";

function nowId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `p-${Date.now()}-${Math.random()}`;
}

// ---------------------------------------------------------------------------
// Persistence (per account)
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(deps.accountScopedKey(PORTFOLIO_KEY)) || "null");
    if (parsed?.portfolios?.length) { state = parsed; return; }
  } catch { /* fall through */ }
  state = { activeId: null, portfolios: [] };
}

function saveState() {
  localStorage.setItem(deps.accountScopedKey(PORTFOLIO_KEY), JSON.stringify(state));
}

function ensureDefaultPortfolio() {
  if (state.portfolios.length === 0) {
    const p = { id: nowId(), name: "My Portfolio", transactions: [] };
    state.portfolios.push(p);
    state.activeId = p.id;
    saveState();
  }
  if (!state.portfolios.some((p) => p.id === state.activeId)) {
    state.activeId = state.portfolios[0].id;
  }
}

function activePortfolio() {
  ensureDefaultPortfolio();
  return state.portfolios.find((p) => p.id === state.activeId);
}

// ---------------------------------------------------------------------------
// Pure math — direct ports of PortfolioViewModel's static functions
// ---------------------------------------------------------------------------

function computeSummary(transactions, priceUsd) {
  let holdingsKas = 0;
  let totalInvested = 0;
  let totalProceeds = 0;
  let totalBoughtKas = 0;
  for (const tx of transactions) {
    const amount = Number(tx.amountKas) || 0;
    const fiat = Number(tx.fiatValue) || 0;
    if (tx.type === "sell") {
      holdingsKas -= amount;
      totalProceeds += fiat;
    } else {
      holdingsKas += amount;
      totalInvested += fiat;
      totalBoughtKas += amount;
    }
  }
  const currentValue = holdingsKas * (priceUsd || 0);
  const totalPL = (currentValue + totalProceeds) - totalInvested;
  const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;
  const averageBuyPriceUsd = totalBoughtKas > 0 ? totalInvested / totalBoughtKas : null;
  return { holdingsKas, totalInvested, totalProceeds, currentValue, totalPL, totalPLPercent, averageBuyPriceUsd };
}

/** Replays the ledger against each price point to get holdings *as of that moment* — a
 *  buy/sell partway through the window changes the curve's shape from that point on, not
 *  retroactively. A transaction exactly at a point's timestamp counts as included. */
function computeValueHistory(transactions, pricePoints) {
  if (!pricePoints?.length) return [];
  const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  let holdings = 0;
  let txIndex = 0;
  return pricePoints.map(([ts, p]) => {
    while (txIndex < sorted.length && sorted[txIndex].timestamp <= ts) {
      const tx = sorted[txIndex];
      holdings += (tx.type === "sell" ? -1 : 1) * (Number(tx.amountKas) || 0);
      txIndex += 1;
    }
    return [ts, holdings * p];
  });
}

/** Real today-only $ and % change: latest value sample minus the sample closest to (but not
 *  after) 24h before it. Null when no sample exists that far back (e.g. created today). */
function computeTodayChange(points) {
  if (!points?.length) return null;
  const [latestTs, latestValue] = points[points.length - 1];
  const dayAgo = latestTs - 86_400_000;
  let base = null;
  for (const point of points) {
    if (point[0] <= dayAgo) base = point;
    else break;
  }
  if (!base) return null;
  const amount = latestValue - base[1];
  const percent = base[1] === 0 ? 0 : (amount / base[1]) * 100;
  return { amount, percent };
}

// ---------------------------------------------------------------------------
// Formatting — in the selected currency (iOS PortfolioFormat)
// ---------------------------------------------------------------------------

// iOS PortfolioFormat.currency: symbol prefix (built by hand rather than via an ISO-4217 currency
// formatter, whose behavior for a non-ISO code like BTC isn't worth relying on), 2 decimals.
function fmtFiat(value) {
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(Number(value) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return `${sign}${currencySymbol()}${magnitude}`;
}

// iOS PortfolioFormat.price: 5 decimals under a unit, else 2.
function fmtPrice(value) {
  const v = Number(value) || 0;
  return `${currencySymbol()}${v.toLocaleString(undefined, {
    minimumFractionDigits: v < 1 ? 5 : 2, maximumFractionDigits: v < 1 ? 5 : 2,
  })}`;
}

function fmtKas(value) {
  return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} KAS`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Charts (plain SVG polyline + HTML crosshair overlay for scrubbing)
// ---------------------------------------------------------------------------

/** yFractions[i] = distance from the wrapper's top as a 0..1 fraction, for the crosshair dot.
 *  Uses the same 10px top/bottom padding as bigChartSvg so the dot tracks the drawn line. */
function chartGeometry(points, height) {
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 10;
  const usable = height - pad * 2;
  return values.map((v) => (pad + (1 - (v - min) / span) * usable) / height);
}

/** Full-screen chart (area fill + horizontal gridlines + polyline) plus an HTML x-axis label
 *  row - reads like a real price/value graph rather than a bare sparkline. Scrub overlay + the
 *  data-portfolio-chart hook are shared with attachScrub(). Intraday spans (<= ~2d) label the
 *  x-axis with hours; longer spans with month/day, so 1D labels don't crowd. */
function bigChartSvg(points, { height = 240, stroke = "var(--kaspa)", chart = null, lineWidth = 2 } = {}) {
  if (!points || points.length < 2) return `<div class="portfolio-chart-empty">No data yet</div>`;
  const width = 560;
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 10;
  const usable = height - pad * 2;
  const step = width / (points.length - 1);
  const yFor = (v) => pad + (1 - (v - min) / span) * usable;
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${yFor(p[1]).toFixed(1)}`);
  const area = `0,${height} ${coords.join(" ")} ${width},${height}`;
  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const y = (pad + (usable * i) / gridCount).toFixed(1);
    return `<line class="portfolio-grid-line" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`;
  }).join("");
  const scrubAttr = chart ? ` data-portfolio-chart="${chart}"` : "";
  const intraday = (points[points.length - 1][0] - points[0][0]) <= 2 * 86_400_000;
  const labelCount = 4;
  const xLabels = Array.from({ length: labelCount }, (_, i) => {
    const idx = Math.round((i / (labelCount - 1)) * (points.length - 1));
    const ts = points[idx][0];
    const text = intraday
      ? new Date(ts).toLocaleTimeString(undefined, { hour: "numeric" })
      : new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<span>${text}</span>`;
  }).join("");
  return `
    <div class="portfolio-bigchart">
      <div class="portfolio-chart-wrap portfolio-chart-wrap-big"${scrubAttr} style="height:${height}px">
        <svg class="portfolio-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
          ${gridLines}
          <polygon class="portfolio-chart-area" points="${area}" fill="${stroke}"/>
          <polyline points="${coords.join(" ")}" fill="none" stroke="${stroke}" stroke-width="${lineWidth}" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
        ${chart ? `<div class="portfolio-scrub-line" hidden></div><div class="portfolio-scrub-dot" hidden style="background:${stroke}"></div>` : ""}
      </div>
      <div class="portfolio-xaxis">${xLabels}</div>
    </div>`;
}

function sparklineSvg(points, { height = 130, width = 560, stroke = "var(--kaspa)", chart = null, lineWidth = 2 } = {}) {
  if (!points || points.length < 2) return `<div class="portfolio-chart-empty">No data yet</div>`;
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = (i * step).toFixed(1);
    const y = (height - 8 - ((p[1] - min) / span) * (height - 16)).toFixed(1);
    return `${x},${y}`;
  });
  const scrubAttr = chart ? ` data-portfolio-chart="${chart}"` : "";
  return `
    <div class="portfolio-chart-wrap"${scrubAttr} style="height:${height}px">
      <svg class="portfolio-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${coords.join(" ")}" fill="none" stroke="${stroke}" stroke-width="${lineWidth}" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      ${chart ? `<div class="portfolio-scrub-line" hidden></div><div class="portfolio-scrub-dot" hidden style="background:${stroke}"></div>` : ""}
    </div>`;
}

/** Hover-to-scrub, matching iOS SparklineChart's drag crosshair: a vertical line + dot track
 *  the pointer, and the associated readout labels update live. Direct DOM updates only — no
 *  re-render per pointer event. */
function attachScrub(wrap, points, onScrub, onEnd) {
  if (!wrap || !points || points.length < 2) return;
  const line = wrap.querySelector(".portfolio-scrub-line");
  const dot = wrap.querySelector(".portfolio-scrub-dot");
  const fractions = chartGeometry(points, wrap.clientHeight || 130);

  const move = (event) => {
    const rect = wrap.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const index = Math.round((x / (rect.width || 1)) * (points.length - 1));
    const clamped = Math.min(Math.max(index, 0), points.length - 1);
    const px = (clamped / (points.length - 1)) * rect.width;
    const py = fractions[clamped] * rect.height;
    if (line) { line.hidden = false; line.style.left = `${px}px`; }
    if (dot) { dot.hidden = false; dot.style.left = `${px}px`; dot.style.top = `${py}px`; }
    onScrub(points[clamped]);
  };
  const leave = () => {
    if (line) line.hidden = true;
    if (dot) dot.hidden = true;
    onEnd();
  };
  wrap.addEventListener("pointermove", move);
  wrap.addEventListener("pointerdown", move);
  wrap.addEventListener("pointerleave", leave);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pickerCard(portfolio) {
  const isActive = portfolio.id === state.activeId;
  const summary = computeSummary(portfolio.transactions || [], price?.price || 0);
  const change = computeTodayChange(computeValueHistory(portfolio.transactions || [], sevenDayHistory));
  const positive = (change?.amount ?? 0) >= 0;
  return `
    <div class="portfolio-card${isActive ? " active" : ""}" data-portfolio-select="${portfolio.id}" role="button" tabindex="0">
      <div class="portfolio-card-top">
        <span class="portfolio-card-name">${deps.escapeHtml(portfolio.name)}</span>
        <button class="portfolio-card-menu-btn" type="button" data-portfolio-card-menu="${portfolio.id}" aria-label="Portfolio options">⋯</button>
      </div>
      <div class="portfolio-card-value">${price ? fmtFiat(summary.currentValue) : "—"}</div>
      ${change
        ? `<div class="portfolio-card-change ${positive ? "gain" : "loss"}">${positive ? "↑" : "↓"} ${Math.abs(change.percent).toFixed(2)}%</div>`
        : `<div class="portfolio-card-change muted">—</div>`}

    </div>`;
}

function summaryCardHtml(summary) {
  const change = price?.change24h ?? null;
  const positive = (change ?? 0) >= 0;
  return `
    <div class="profile-card portfolio-summary">
      <div class="portfolio-summary-head">
        <div>
          <p class="profile-card-label" data-portfolio-price-label>KAS Price</p>
          <div class="portfolio-summary-price" data-portfolio-price-value>${price ? fmtPrice(price.price) : "—"}</div>
        </div>
        ${change !== null ? `
          <div class="portfolio-summary-24h ${positive ? "gain" : "loss"}" data-portfolio-price-24h>
            ${positive ? "↑" : "↓"} ${Math.abs(change).toFixed(2)}%<span class="muted"> 24h</span>
          </div>` : ""}
      </div>
      <div class="portfolio-summary-grid">
        <div class="portfolio-stat">
          <span class="portfolio-stat-label">Holdings</span>
          <span class="portfolio-stat-value">${fmtKas(summary.holdingsKas)}</span>
        </div>
        <div class="portfolio-stat right">
          <span class="portfolio-stat-label">Current Value</span>
          <span class="portfolio-stat-value">${fmtFiat(summary.currentValue)}</span>
        </div>
      </div>
      <div class="portfolio-summary-divider"></div>
      <div class="portfolio-summary-grid">
        <div class="portfolio-stat">
          <span class="portfolio-stat-label">Total Invested</span>
          <span class="portfolio-stat-value">${fmtFiat(summary.totalInvested)}</span>
        </div>
        <div class="portfolio-stat right">
          <span class="portfolio-stat-label">Total P&amp;L</span>
          <span class="portfolio-stat-value ${summary.totalPL >= 0 ? "gain" : "loss"}">
            ${summary.totalPL >= 0 ? "↗" : "↘"} ${fmtFiat(summary.totalPL)} (${summary.totalPLPercent.toFixed(1)}%)
          </span>
        </div>
      </div>
      ${summary.averageBuyPriceUsd !== null ? `
        <div class="portfolio-summary-divider"></div>
        <div class="portfolio-summary-grid">
          <div class="portfolio-stat">
            <span class="portfolio-stat-label">Avg. Buy Price</span>
            <span class="portfolio-stat-value">${fmtPrice(summary.averageBuyPriceUsd)}</span>
          </div>
        </div>` : ""}
    </div>`;
}

function transactionRowHtml(tx) {
  const isBuy = tx.type !== "sell";
  const needsPrice = isPricePending(tx.notes);
  return `
    <div class="portfolio-tx-row" data-portfolio-tx-edit="${tx.id}" role="button" tabindex="0">
      <span class="portfolio-tx-icon ${isBuy ? "buy" : "sell"}">${isBuy ? "↓" : "↑"}</span>
      <div class="portfolio-tx-main">
        <span class="portfolio-tx-type ${isBuy ? "buy" : "sell"}">${isBuy ? "Buy" : "Sell"}${needsPrice ? ' <span class="portfolio-tx-warn" title="Price is still loading, it will fill in automatically. Click to set it yourself.">⚠</span>' : ""}</span>
        <span class="portfolio-tx-date">${fmtDate(tx.timestamp)}</span>
        ${tx.notes && !needsPrice ? `<span class="portfolio-tx-notes">${deps.escapeHtml(tx.notes)}</span>` : ""}
      </div>
      <div class="portfolio-tx-amounts">
        <span class="portfolio-tx-amount">${fmtKas(tx.amountKas)}</span>
        <span class="portfolio-tx-fiat">${fmtFiat(tx.fiatValue || 0)}</span>
      </div>
      <button class="portfolio-tx-delete" type="button" data-portfolio-tx-delete="${tx.id}" aria-label="Delete transaction">×</button>
    </div>`;
}

// Two tappable squares (KAS price | portfolio value) that open the full-screen chart screens.
function squaresHtml(summary) {
  const change = price?.change24h ?? null;
  const pPos = (change ?? 0) >= 0;
  const plPos = summary.totalPL >= 0;
  return `
    <div class="portfolio-squares">
      <button class="portfolio-square" type="button" data-portfolio-open="price">
        <div class="portfolio-square-head">
          <img src="${kaspaLogoUrl}" alt="" class="portfolio-square-logo"/>
          <span class="portfolio-square-title">Kaspa</span>
          <span class="portfolio-square-chev">›</span>
        </div>
        <div class="portfolio-square-value">${price ? fmtPrice(price.price) : "—"}</div>
        ${change !== null ? `<div class="portfolio-square-change ${pPos ? "gain" : "loss"}">${pPos ? "↑" : "↓"} ${Math.abs(change).toFixed(2)}%</div>` : `<div class="portfolio-square-change muted">—</div>`}
      </button>
      <button class="portfolio-square" type="button" data-portfolio-open="value">
        <div class="portfolio-square-head">
          <svg class="portfolio-square-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="16 7 21 7 21 12"/></svg>
          <span class="portfolio-square-title">Value</span>
          <span class="portfolio-square-chev">›</span>
        </div>
        <div class="portfolio-square-value">${fmtFiat(summary.currentValue)}</div>
        <div class="portfolio-square-change ${plPos ? "gain" : "loss"}">${plPos ? "↑" : "↓"} ${Math.abs(summary.totalPLPercent).toFixed(2)}%</div>
      </button>
    </div>`;
}

/// The card settings overlay: rename, reorder and delete all happen HERE rather than each opening
/// its own thing (iOS `PressedPortfolio`).
///
/// It replaces a dropdown that lived INSIDE the card, which the card then clipped - the menu came
/// out looking broken because half of it was behind the card's own edge. An overlay has no such
/// box to escape from. Rename is a step of it too, rather than a `window.prompt`: a browser dialog
/// looks like the website is asking, not the app.
function renderCardModal() {
  const body = modalsEl?.querySelector("[data-portfolio-card-body]");
  const portfolio = state.portfolios.find((p) => p.id === cardModalId);
  if (!body || !portfolio) return;
  const hasOthers = state.portfolios.length > 1;
  const head = (title) => `
    <div class="modal-header">
      <div><p class="modal-kicker">Portfolio</p><h2>${deps.escapeHtml(title)}</h2></div>
      <button class="modal-close" type="button" data-portfolio-card-close aria-label="Close">×</button>
    </div>`;

  if (cardModalMode === "rename") {
    body.innerHTML = `
      ${head("Rename Portfolio")}
      <div class="portfolio-editor-body">
        <label class="portfolio-editor-field">
          <span>Name</span>
          <input type="text" maxlength="40" data-portfolio-card-name value="${deps.escapeHtml(portfolio.name)}" />
        </label>
        <p class="field-hint">Only the name changes. Transactions stay where they are.</p>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-portfolio-card-back>Back</button>
        <button class="primary-button" type="button" data-portfolio-card-rename-save>Save</button>
      </div>`;
    body.querySelector("[data-portfolio-card-name]")?.focus();
    return;
  }

  if (cardModalMode === "delete") {
    const count = (portfolio.transactions || []).length;
    body.innerHTML = `
      ${head(`Delete ${portfolio.name}?`)}
      <p class="field-hint">This removes the portfolio and its ${count} transaction${count === 1 ? "" : "s"}. It cannot be undone.</p>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-portfolio-card-back>Cancel</button>
        <button class="primary-button danger" type="button" data-portfolio-card-delete-confirm>Delete</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    ${head(portfolio.name)}
    <div class="cold-action-rows">
      <button type="button" class="cold-action-row" data-portfolio-card-mode="rename">
        <span class="cold-action-copy"><strong>Rename</strong><small>Only the name changes. Transactions stay where they are.</small></span>
      </button>
      ${hasOthers ? `
      <button type="button" class="cold-action-row" data-portfolio-card-mode="reorder">
        <span class="cold-action-copy"><strong>Reorder Portfolios</strong><small>Sets the order the cards appear in.</small></span>
      </button>
      <button type="button" class="cold-action-row cold-action-row-warn" data-portfolio-card-mode="delete">
        <span class="cold-action-copy"><strong>Delete ${deps.escapeHtml(portfolio.name)}</strong><small>Removes it and everything recorded in it.</small></span>
      </button>` : `
      <p class="field-hint">This is your only portfolio, so it cannot be deleted or reordered.</p>`}
    </div>`;
}

/// An in-app confirm. Every native `window.confirm` reads as "localhost says", which is the
/// BROWSER asking rather than the app - and on a page people are trusting with money that is
/// exactly the wrong voice. Resolves true when the destructive button is pressed.
let confirmResolve = null;
function confirmOverlay({ title, message, confirmLabel = "Delete", destructive = true }) {
  return new Promise((resolve) => {
    const body = modalsEl?.querySelector("[data-portfolio-confirm-body]");
    if (!body) { resolve(false); return; }
    confirmResolve = resolve;
    body.innerHTML = `
      <div class="modal-header">
        <div><p class="modal-kicker">Portfolio</p><h2>${deps.escapeHtml(title)}</h2></div>
        <button class="modal-close" type="button" data-portfolio-confirm-cancel aria-label="Close">×</button>
      </div>
      <p class="field-hint">${deps.escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-portfolio-confirm-cancel>Cancel</button>
        <button class="primary-button${destructive ? " danger" : ""}" type="button" data-portfolio-confirm-ok>${deps.escapeHtml(confirmLabel)}</button>
      </div>`;
    modalsEl.querySelector("[data-portfolio-confirm-modal]").hidden = false;
  });
}

function settleConfirm(result) {
  const modal = modalsEl?.querySelector("[data-portfolio-confirm-modal]");
  if (modal) modal.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(result);
}

/// Naming a new portfolio, in the app rather than in a browser prompt.
let namePromptResolve = null;
function namePromptOverlay({ title, label, initial = "", confirmLabel = "Create" }) {
  return new Promise((resolve) => {
    const body = modalsEl?.querySelector("[data-portfolio-name-body]");
    if (!body) { resolve(null); return; }
    namePromptResolve = resolve;
    body.innerHTML = `
      <div class="modal-header">
        <div><p class="modal-kicker">Portfolio</p><h2>${deps.escapeHtml(title)}</h2></div>
        <button class="modal-close" type="button" data-portfolio-name-cancel aria-label="Close">×</button>
      </div>
      <div class="portfolio-editor-body">
        <label class="portfolio-editor-field">
          <span>${deps.escapeHtml(label)}</span>
          <input type="text" maxlength="40" data-portfolio-name-input value="${deps.escapeHtml(initial)}" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-portfolio-name-cancel>Cancel</button>
        <button class="primary-button" type="button" data-portfolio-name-ok>${deps.escapeHtml(confirmLabel)}</button>
      </div>`;
    modalsEl.querySelector("[data-portfolio-name-modal]").hidden = false;
    const input = body.querySelector("[data-portfolio-name-input]");
    input?.focus();
    input?.select();
  });
}

function settleNamePrompt(value) {
  const modal = modalsEl?.querySelector("[data-portfolio-name-modal]");
  if (modal) modal.hidden = true;
  const resolve = namePromptResolve;
  namePromptResolve = null;
  resolve?.(value);
}

function openAddressImport() {
  addressImport = {
    busy: false, progress: "", input: "",
    resolving: false, resolvedAddress: null, resolvedDomain: null, notFound: false,
  };
  knsResolveSeq += 1; // abandon any lookup left over from a previous open
  modalsEl.querySelector("[data-portfolio-import-address]").value = "";
  setImportProgress("");
  syncImportModal();
  modalsEl.querySelector("[data-portfolio-import-modal]").hidden = false;
}

/// The two header buttons open overlays rather than dropdowns.
///
/// Add offers both ways of getting a transaction in - typing one, or importing an address's whole
/// history - because those are the same intent and hiding one of them under Import/Export meant
/// looking for it in the wrong place. Import/Export is then exactly what its name says.
function renderPortfolioActionSheet() {
  const body = modalsEl?.querySelector("[data-portfolio-action-body]");
  if (!body) return;
  const rows = actionSheetMode === "add"
    ? [
        { action: "tx", title: "Add Transaction", subtitle: "Record a buy or a sell yourself." },
        { action: "address", title: "Add Kaspa Address", subtitle: "Imports every transaction an address has, priced at the day each happened." },
      ]
    : [
        { action: "import", title: "Import CSV", subtitle: "Reads a CoinMarketCap transaction history file." },
        { action: "export", title: "Export CSV", subtitle: "Writes this portfolio out in the same format." },
      ];
  body.innerHTML = `
    <div class="modal-header">
      <div><p class="modal-kicker">Portfolio</p><h2>${actionSheetMode === "add" ? "Add" : "Import / Export"}</h2></div>
      <button class="modal-close" type="button" data-portfolio-action-close aria-label="Close">×</button>
    </div>
    <div class="cold-action-rows">
      ${rows.map((row) => `
        <button type="button" class="cold-action-row" data-portfolio-action="${row.action}">
          <span class="cold-action-copy"><strong>${row.title}</strong><small>${row.subtitle}</small></span>
        </button>`).join("")}
    </div>`;
}

/// What was typed, in H/s, using the unit the picker has selected.
function typedHashrateHs() {
  const amount = Number(String(hashrateInput).replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * (HASHRATE_UNITS.find((u) => u.key === hashrateUnit)?.scale ?? 1e12);
}

/// One stat: label on the left, value on the right, with a divider between rows (iOS `statRow`).
/// A two-column grid squeezed four figures into two lines and left the reader matching labels to
/// values by position.
function statRowHtml(label, value, valueClass = "") {
  return `
    <div class="portfolio-stat-row">
      <span class="portfolio-stat-label">${label}</span>
      <span class="portfolio-stat-value ${valueClass}">${value}</span>
    </div>`;
}

/// The change over the SELECTED range, not always 24h (iOS `priceRangeChange`): the badge beside
/// the price has to answer the question the chart under it is asking. A 1Y chart with a 24h badge
/// invites reading the year's move as a day's.
function rangeChange(series) {
  if (!series || series.length < 2) return null;
  const first = series[0][1];
  const last = series[series.length - 1][1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const amount = last - first;
  return { amount, percent: first === 0 ? 0 : (amount / first) * 100 };
}

/// How the selected range is named beside that figure (iOS `priceRangeLabel`).
function rangeLabel() {
  return { 1: "24h", 7: "1W", 30: "1M", 90: "3M", 365: "1Y" }[rangeDays] || `${rangeDays}d`;
}

/// Reordering, offered from a card's own menu the way iOS offers it - one screen where the order
/// is edited and committed, rather than dragging the cards themselves.
///
/// Dragging the cards in place would fight the tap that SELECTS a portfolio, which is the thing
/// people do with them constantly. Moving the job into a list makes both gestures unambiguous.
function renderReorderModal() {
  const body = modalsEl?.querySelector("[data-portfolio-reorder-body]");
  if (!body) return;
  body.innerHTML = `
    <div class="modal-header">
      <div><p class="modal-kicker">Portfolio</p><h2>Reorder Portfolios</h2></div>
      <button class="modal-close" type="button" data-portfolio-reorder-close aria-label="Close">×</button>
    </div>
    <div class="portfolio-reorder-list">
      ${reorderDraft.map((p, i) => `
        <div class="portfolio-reorder-row">
          <span class="portfolio-reorder-name">${deps.escapeHtml(p.name)}</span>
          <span class="portfolio-reorder-buttons">
            <button type="button" data-portfolio-move="up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
            <button type="button" data-portfolio-move="down" data-index="${i}" ${i === reorderDraft.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          </span>
        </div>`).join("")}
    </div>
    <p class="field-hint">The order here is the order the cards appear in. Transactions stay where they are.</p>
    <div class="modal-actions">
      <button class="secondary-button" type="button" data-portfolio-reorder-close>Cancel</button>
      <button class="primary-button" type="button" data-portfolio-reorder-save>Done</button>
    </div>`;
}

/// Rank and market cap (iOS `marketStatsCard`), from the same keyless CoinGecko source the price
/// already comes from. Absent until the call lands, rather than showing a placeholder figure.
function marketStatsHtml() {
  const stats = peekKasMarketStats(deps.currencyCode?.().toLowerCase() || "usd");
  if (!stats) return "";
  return `
    <div class="profile-card portfolio-summary">
      <div class="portfolio-summary-grid">
        <div class="portfolio-stat"><span class="portfolio-stat-label">Market Cap</span><span class="portfolio-stat-value">${fmtFiat(stats.marketCap)}</span></div>
        ${stats.rank ? `<div class="portfolio-stat right"><span class="portfolio-stat-label">Rank</span><span class="portfolio-stat-value">#${stats.rank}</span></div>` : ""}
      </div>
    </div>`;
}

/// Network hashrate, full width under the two squares (iOS `hashrateCard`).
///
/// Full width rather than a third square: it is one series with a long history, and it reads far
/// better wide than squeezed into a third of a row. The sparkline says which way it is going
/// without anyone having to open it.
function hashrateCardHtml() {
  const stats = peekNetworkStats();
  const spark = stats && stats.history.length >= 2
    ? sparklineSvg(stats.history.slice(-90), { width: 96, height: 34 })
    : "";
  return `
    <button class="portfolio-hashrate-card" type="button" data-portfolio-open="hashrate">
      <span class="portfolio-hashrate-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M14 3l7 7-3 3-7-7z"/><path d="M11.5 5.5 4 13v7h7l7.5-7.5"/></svg>
      </span>
      <span class="portfolio-hashrate-copy">
        <span class="portfolio-hashrate-label">Network Hashrate</span>
        <span class="portfolio-hashrate-value">${stats ? formatHashrate(stats.currentHashrate) : "—"}</span>
      </span>
      ${spark}
      <span class="portfolio-square-chev">›</span>
    </button>`;
}

/// Full-screen network hashrate screen: the chart, what a block currently pays, an estimate of
/// what a given hashrate earns per day, and what the number actually means (iOS's hashrate view).
function hashrateViewHtml() {
  const stats = peekNetworkStats();
  const daily = estimateDailyKas({
    yourHashrateHs: typedHashrateHs(),
    networkHashrateHs: stats?.currentHashrate,
    blockRewardKas: stats?.blockRewardKas,
  });
  const halvingDate = stats?.nextHalving ? new Date(stats.nextHalving.at).toLocaleDateString() : null;
  return `
    <div class="portfolio-screen-header">
      <button class="portfolio-back-btn" type="button" data-portfolio-back aria-label="Back">‹ Portfolio</button>
    </div>
    <div class="profile-card">
      <div class="portfolio-detail-head">
        <span class="portfolio-hashrate-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M14 3l7 7-3 3-7-7z"/><path d="M11.5 5.5 4 13v7h7l7.5-7.5"/></svg>
        </span>
        <span class="portfolio-detail-name">Network Hashrate</span>
      </div>
      <div class="portfolio-detail-date" data-portfolio-hashrate-date hidden></div>
      <div class="portfolio-detail-price-row">
        <span class="portfolio-detail-price" data-portfolio-hashrate-value>${stats ? formatHashrate(stats.currentHashrate) : "—"}</span>
      </div>
      ${stats && stats.history.length >= 2
        ? bigChartSvg(stats.history, { height: 240, chart: "hashrate" })
        : `<div class="portfolio-chart-empty">Network history is still loading.</div>`}
    </div>

    ${stats?.blockRewardKas ? `
    <div class="profile-card portfolio-summary">
      ${statRowHtml("Block Reward", fmtKas(stats.blockRewardKas))}
      ${stats.nextHalving ? `
        ${statRowHtml("Next Block Reward", fmtKas(stats.nextHalving.amountKas))}
        ${statRowHtml("Next Block Reward Reduction", deps.escapeHtml(halvingDate))}` : ""}
      ${stats.nextHalving ? `<p class="portfolio-about-text">Kaspa steps the reward down a little every month rather than cutting it in half every few years, so this is a reduction rather than a halving.</p>` : ""}
    </div>` : ""}

    <div class="profile-card">
      <p class="profile-card-label">Mining Estimate</p>
      <div class="portfolio-hashrate-entry">
        <label class="portfolio-editor-field">
          <span>Your hashrate</span>
          <input type="text" inputmode="decimal" placeholder="e.g. 120" data-portfolio-hashrate-input value="${deps.escapeHtml(hashrateInput)}" />
        </label>
        <div class="settings-segmented" role="group" aria-label="Hashrate unit">
          ${HASHRATE_UNITS.map((unit) => `
            <button type="button" class="settings-segmented-option ${hashrateUnit === unit.key ? "active" : ""}" data-portfolio-hashrate-unit="${unit.key}">${unit.label}</button>`).join("")}
        </div>
      </div>
      ${statRowHtml("Estimated daily", daily === null ? "—" : fmtKas(daily))}
      ${statRowHtml("At today's price", daily === null || !price ? "—" : fmtFiat(daily * price.price))}
      <p class="field-hint">Your share of the network times what the network pays out in a day, at the current reward. It ignores luck, pool fees and orphaned blocks, so treat it as a ceiling rather than a forecast.</p>
    </div>

    <div class="profile-card portfolio-about">
      <p class="profile-card-label">About Hashrate</p>
      <p class="portfolio-about-text">Hashrate is how much computing work the whole network is doing every second. It is the clearest measure of how much it would cost to attack Kaspa: the higher it goes, the more hardware someone would have to out-spend to rewrite history. It also sets mining difficulty, which adjusts so blocks keep arriving about ten times a second whatever the hashrate does.</p>
    </div>`;
}

// Full-screen KAS price chart screen.
function priceViewHtml() {
  // Over the range on screen, falling back to the 24h figure only when there is not enough
  // history to compute one.
  const ranged = rangeChange(history);
  const change = ranged ? ranged.percent : (price?.change24h ?? null);
  const label = ranged ? rangeLabel() : "24h";
  const pPos = (change ?? 0) >= 0;
  return `
    <div class="portfolio-screen-header">
      <button class="portfolio-back-btn" type="button" data-portfolio-back aria-label="Back">‹ Portfolio</button>
    </div>
    <div class="profile-card">
      <div class="portfolio-detail-head">
        <img src="${kaspaLogoUrl}" alt="" class="portfolio-detail-logo"/>
        <span class="portfolio-detail-name">Kaspa</span>
      </div>
      <div class="portfolio-detail-date" data-portfolio-price-date hidden></div>
      <div class="portfolio-detail-price-row">
        <span class="portfolio-detail-price" data-portfolio-price-value>${price ? fmtPrice(price.price) : "—"}</span>
        ${change !== null ? `<span class="portfolio-detail-24h ${pPos ? "gain" : "loss"}" data-portfolio-price-24h>${pPos ? "↑" : "↓"} ${Math.abs(change).toFixed(2)}% (${deps.escapeHtml(label)})</span>` : ""}
      </div>
      ${bigChartSvg(history, { height: 240, chart: "price" })}
      <div class="portfolio-ranges portfolio-ranges-wide">
        ${RANGES.map((r) => `<button class="portfolio-range${r.days === rangeDays ? " active" : ""}" type="button" data-portfolio-range="${r.days}">${r.label}</button>`).join("")}
      </div>
    </div>
    <div class="profile-card">
      <p class="profile-card-label">Converter</p>
      <div class="portfolio-converter">
        <label class="portfolio-editor-field">
          <span>KAS</span>
          <input type="text" inputmode="decimal" data-portfolio-conv-kas value="${deps.escapeHtml(converterKas)}" />
        </label>
        <label class="portfolio-editor-field">
          <span>${deps.escapeHtml(deps.currencyCode?.() || "USD")}</span>
          <input type="text" inputmode="decimal" data-portfolio-conv-fiat value="${deps.escapeHtml(converterFiat)}" />
        </label>
      </div>
      ${price ? "" : `<p class="field-hint">Waiting for a price…</p>`}
    </div>

    ${marketStatsHtml()}

    <div class="profile-card portfolio-about">
      <p class="profile-card-label">About Kaspa</p>
      <p class="portfolio-about-text">${KASPA_ABOUT}</p>
    </div>`;
}

// Value-over-time stats (Holdings / Current Value / Invested / P&L / Avg. Buy Price).
function valueStatsHtml(summary) {
  return `
    <div class="profile-card portfolio-summary">
      ${statRowHtml("Holdings", fmtKas(summary.holdingsKas))}
      ${statRowHtml("Current Value", fmtFiat(summary.currentValue))}
      ${statRowHtml("Total Invested", fmtFiat(summary.totalInvested))}
      ${statRowHtml("Total P&amp;L",
        `${summary.totalPL >= 0 ? "↗" : "↘"} ${fmtFiat(summary.totalPL)} (${summary.totalPLPercent.toFixed(1)}%)`,
        summary.totalPL >= 0 ? "gain" : "loss")}
      ${summary.averageBuyPriceUsd !== null ? statRowHtml("Avg. Buy Price", fmtPrice(summary.averageBuyPriceUsd)) : ""}
    </div>`;
}

// Full-screen Value Over Time chart screen.
function valueViewHtml(summary) {
  const latest = valuePoints.length ? valuePoints[valuePoints.length - 1][1] : summary.currentValue;
  return `
    <div class="portfolio-screen-header">
      <button class="portfolio-back-btn" type="button" data-portfolio-back aria-label="Back">‹ Portfolio</button>
    </div>
    <div class="profile-card">
      <p class="profile-card-label" data-portfolio-value-label>Portfolio Value</p>
      <div class="portfolio-detail-date" data-portfolio-value-date hidden></div>
      <div class="portfolio-detail-price" data-portfolio-value-readout>${fmtFiat(latest)}</div>
      ${valuePoints.length >= 2
        ? bigChartSvg(valuePoints, { height: 220, stroke: "var(--kaspa-ink)", chart: "value", lineWidth: 3 })
        : `<div class="portfolio-chart-empty">Not enough history yet — check back after a few days of activity.</div>`}
      <div class="portfolio-ranges portfolio-ranges-wide">
        ${RANGES.map((r) => `<button class="portfolio-range${r.days === rangeDays ? " active" : ""}" type="button" data-portfolio-range="${r.days}">${r.label}</button>`).join("")}
      </div>
    </div>
    ${valueStatsHtml(summary)}`;
}

function render() {
  if (!rootEl) return;
  const portfolio = activePortfolio();
  const scoped = portfolio.transactions || [];
  // Resolved per render (session cache, else the persisted copy for this exact range) so a
  // refresh in flight never blanks the chart and a range switch repaints instantly.
  history = historyForRange(rangeDays);
  sevenDayHistory = historyForRange(7);
  const summary = computeSummary(scoped, price?.price || 0);
  valuePoints = computeValueHistory(scoped, history);

  if (view === "price") {
    rootEl.innerHTML = priceViewHtml();
    wireScrubbing();
    return;
  }
  if (view === "value") {
    rootEl.innerHTML = valueViewHtml(summary);
    wireScrubbing();
    return;
  }
  if (view === "hashrate") {
    rootEl.innerHTML = hashrateViewHtml();
    wireScrubbing();
    return;
  }

  const transactions = [...scoped].sort((a, b) => b.timestamp - a.timestamp);
  rootEl.innerHTML = `
    <div class="kaposts-header">
      <h1 class="kaposts-title">Portfolio</h1>
      <div class="kaposts-header-actions">
        <button class="kaposts-icon-button" type="button" data-portfolio-refresh title="Refresh">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>
        </button>
      </div>
    </div>

    <div class="portfolio-cards">
      ${state.portfolios.map(pickerCard).join("")}
      ${state.portfolios.length < MAX_PORTFOLIOS ? `
        <button class="portfolio-card portfolio-card-add" type="button" data-portfolio-add>
          <span class="portfolio-card-add-plus">+</span>
          <span>Add</span>
        </button>` : ""}
    </div>

    ${squaresHtml(summary)}

    ${hashrateCardHtml()}

    <div class="profile-card">
      <div class="portfolio-tx-header">
        <p class="profile-card-label">Transactions</p>
        <div class="portfolio-tx-header-actions">
          <button class="cold-inline-link" type="button" data-portfolio-add-menu>+ Add</button>
          <button class="cold-inline-link" type="button" data-portfolio-io-menu>Import/Export</button>
        </div>
      </div>
      ${transactions.length === 0
        ? `<div class="portfolio-chart-empty">No transactions yet — add your first buy, import a CSV, or add a Kaspa address.</div>`
        : transactions.map(transactionRowHtml).join("")}
    </div>
    ${loading ? `<div class="portfolio-chart-empty">Refreshing…</div>` : ""}`;
}

function wireScrubbing() {
  // Price screen: scrubbing shows the point's date + price and hides the 24h badge. The Kaspa
  // logo + name stay put (they're separate elements the scrub never touches), matching iOS.
  if (view === "price") {
    const wrap = rootEl.querySelector('[data-portfolio-chart="price"]');
    attachScrub(wrap, history, ([ts, p]) => {
      const date = rootEl.querySelector("[data-portfolio-price-date]");
      const value = rootEl.querySelector("[data-portfolio-price-value]");
      const change = rootEl.querySelector("[data-portfolio-price-24h]");
      if (date) { date.hidden = false; date.textContent = new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
      if (value) value.textContent = fmtPrice(p);
      if (change) change.style.visibility = "hidden";
    }, () => {
      const date = rootEl.querySelector("[data-portfolio-price-date]");
      const value = rootEl.querySelector("[data-portfolio-price-value]");
      const change = rootEl.querySelector("[data-portfolio-price-24h]");
      if (date) date.hidden = true;
      if (value) value.textContent = price ? fmtPrice(price.price) : "—";
      if (change) change.style.visibility = "";
    });
    return;
  }

  // Hashrate screen: scrubbing shows the point's date and what the network was doing then.
  if (view === "hashrate") {
    const stats = peekNetworkStats();
    const wrap = rootEl.querySelector('[data-portfolio-chart="hashrate"]');
    attachScrub(wrap, stats?.history || [], ([ts, hs]) => {
      const date = rootEl.querySelector("[data-portfolio-hashrate-date]");
      const value = rootEl.querySelector("[data-portfolio-hashrate-value]");
      if (date) { date.hidden = false; date.textContent = new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
      if (value) value.textContent = formatHashrate(hs);
    }, () => {
      const date = rootEl.querySelector("[data-portfolio-hashrate-date]");
      const value = rootEl.querySelector("[data-portfolio-hashrate-value]");
      if (date) date.hidden = true;
      if (value) value.textContent = stats ? formatHashrate(stats.currentHashrate) : "—";
    });
    return;
  }

  // Value screen: scrubbing shows the point's date + value; the "Portfolio Value" label stays.
  if (view === "value") {
    const wrap = rootEl.querySelector('[data-portfolio-chart="value"]');
    attachScrub(wrap, valuePoints, ([ts, v]) => {
      const date = rootEl.querySelector("[data-portfolio-value-date]");
      const readout = rootEl.querySelector("[data-portfolio-value-readout]");
      if (date) { date.hidden = false; date.textContent = new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
      if (readout) readout.textContent = fmtFiat(v);
    }, () => {
      const date = rootEl.querySelector("[data-portfolio-value-date]");
      const readout = rootEl.querySelector("[data-portfolio-value-readout]");
      if (date) date.hidden = true;
      if (readout) readout.textContent = fmtFiat(valuePoints.length ? valuePoints[valuePoints.length - 1][1] : 0);
    });
  }
}

// ---------------------------------------------------------------------------
// Transaction editor modal (iOS PortfolioTransactionEditor)
// ---------------------------------------------------------------------------

function toDatetimeLocal(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openTxEditor(txId) {
  const portfolio = activePortfolio();
  const tx = txId ? (portfolio.transactions || []).find((t) => t.id === txId) : null;
  editingTx = { id: tx?.id || null };
  const backdrop = modalsEl.querySelector("[data-portfolio-editor-modal]");
  modalsEl.querySelector("[data-portfolio-editor-title]").textContent = tx ? "Edit Transaction" : "Add Transaction";
  modalsEl.querySelector("[data-portfolio-editor-type]").value = tx?.type === "sell" ? "sell" : "buy";
  modalsEl.querySelector("[data-portfolio-editor-amount]").value = tx ? String(tx.amountKas) : "";
  modalsEl.querySelector("[data-portfolio-editor-fiat]").value = tx && tx.fiatValue ? String(tx.fiatValue) : "";
  modalsEl.querySelector("[data-portfolio-editor-date]").value = toDatetimeLocal(tx?.timestamp ?? Date.now());
  const notes = isPricePending(tx?.notes) ? "" : (tx?.notes || "");
  modalsEl.querySelector("[data-portfolio-editor-notes]").value = notes;
  const fiatLabel = modalsEl.querySelector("[data-portfolio-editor-fiat-label]");
  if (fiatLabel) fiatLabel.textContent = `Total Value (${currencyCode().toUpperCase()})`;
  modalsEl.querySelector("[data-portfolio-editor-delete]").hidden = !tx;
  updateEditorHint();
  backdrop.hidden = false;
}

function closeTxEditor() {
  editingTx = null;
  modalsEl.querySelector("[data-portfolio-editor-modal]").hidden = true;
}

/** "≈ $0.12345 / KAS" helper under the fiat field, plus a one-click "use current price" fill. */
function updateEditorHint() {
  const amount = Number(modalsEl.querySelector("[data-portfolio-editor-amount]")?.value);
  const fiat = Number(modalsEl.querySelector("[data-portfolio-editor-fiat]")?.value);
  const hint = modalsEl.querySelector("[data-portfolio-editor-hint]");
  if (!hint) return;
  if (Number.isFinite(amount) && amount > 0 && Number.isFinite(fiat) && fiat > 0) {
    hint.textContent = `≈ ${fmtPrice(fiat / amount)} / KAS`;
  } else if (price && Number.isFinite(amount) && amount > 0) {
    hint.textContent = `At current price: ${fmtFiat(amount * price.price)}`;
  } else {
    hint.textContent = "";
  }
}

function saveTxEditor() {
  const amount = Number(modalsEl.querySelector("[data-portfolio-editor-amount]")?.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    deps.showToast?.("Enter a KAS amount.");
    return;
  }
  const type = modalsEl.querySelector("[data-portfolio-editor-type]")?.value === "sell" ? "sell" : "buy";
  const fiatValue = Number(modalsEl.querySelector("[data-portfolio-editor-fiat]")?.value) || 0;
  const dateRaw = modalsEl.querySelector("[data-portfolio-editor-date]")?.value;
  const timestamp = dateRaw ? new Date(dateRaw).getTime() : Date.now();
  const notes = modalsEl.querySelector("[data-portfolio-editor-notes]")?.value?.trim() || null;

  const portfolio = activePortfolio();
  portfolio.transactions ||= [];
  if (editingTx?.id) {
    const index = portfolio.transactions.findIndex((t) => t.id === editingTx.id);
    if (index >= 0) {
      // Preserve on-chain provenance fields; a manual edit clears the needs-price warning.
      const existing = portfolio.transactions[index];
      portfolio.transactions[index] = { ...existing, type, amountKas: amount, fiatValue, timestamp, notes };
    }
  } else {
    portfolio.transactions.push({ id: nowId(), type, amountKas: amount, fiatValue, timestamp, notes });
  }
  saveState();
  closeTxEditor();
  render();
}

// ---------------------------------------------------------------------------
// CSV import/export (CoinMarketCap "Transaction History" format — matches iOS)
// ---------------------------------------------------------------------------

/** Splits on commas outside double quotes, unescapes "" back to " within a quoted field. */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes && c === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
    else if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) { fields.push(current); current = ""; }
    else current += c;
  }
  fields.push(current);
  return fields;
}

function parseLenientDouble(raw) {
  const value = Number(String(raw ?? "").trim().replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** CoinMarketCap bakes the exporter's UTC offset into the date column header, e.g.
 *  "Date (UTC-4:00)" — parsed once so every row's timestamp is interpreted correctly. */
function parseHeaderUtcOffsetMinutes(header) {
  const match = /UTC([+-]?\d+):(\d+)/i.exec(header || "");
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const sign = hours < 0 || match[1].startsWith("-") ? -1 : 1;
  return sign * (Math.abs(hours) * 60 + minutes);
}

function exportCsv() {
  const portfolio = activePortfolio();
  const rows = [...(portfolio.transactions || [])].sort((a, b) => a.timestamp - b.timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  let csv = "Date (UTC+0:00),Token,Type,Price (USD),Amount,Total value (USD),Fee,Fee Currency,Notes\n";
  for (const tx of rows) {
    const d = new Date(tx.timestamp);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const amount = Number(tx.amountKas) || 0;
    const fiat = Number(tx.fiatValue) || 0;
    const perKas = amount !== 0 ? fiat / amount : 0;
    const notes = String(tx.notes || "").replace(/"/g, '""');
    csv += `"${date}","KAS","${tx.type === "sell" ? "sell" : "buy"}","${perKas}","${amount}","${fiat}","0.00","USD","${notes}"\n`;
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kachat-portfolio-${new Date().toISOString().replace(/:/g, "-").slice(0, 19)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Same replace-by-timestamp dedup as iOS: a row whose timestamp exactly matches an existing
 *  transaction in the active portfolio replaces it in place rather than piling up copies. */
function importCsvText(content) {
  const lines = content.split(/\r?\n/);
  if (!lines.length) return 0;
  const header = lines.shift();
  const offsetMinutes = parseHeaderUtcOffsetMinutes(header);

  const portfolio = activePortfolio();
  portfolio.transactions ||= [];
  const indexByTimestamp = new Map();
  portfolio.transactions.forEach((tx, index) => indexByTimestamp.set(tx.timestamp, index));

  let imported = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 6) continue;
    if (String(fields[1]).trim().toUpperCase() !== "KAS") continue;
    const type = String(fields[2]).trim().toLowerCase();
    if (type !== "buy" && type !== "sell") continue;
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(fields[0]).trim());
    if (!dateMatch) continue;
    const [, y, mo, d, h, mi, s] = dateMatch.map(Number);
    const timestamp = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
    const kas = parseLenientDouble(fields[4]);
    const totalValue = parseLenientDouble(fields[5]);
    if (kas === null || totalValue === null) continue;

    // Fee folded into total when USD-denominated: added for buys, subtracted for sells.
    let fiatValue = totalValue;
    if (fields.length > 7 && String(fields[7]).trim().toUpperCase() === "USD") {
      const fee = parseLenientDouble(fields[6]);
      if (fee !== null) fiatValue = type === "buy" ? fiatValue + fee : Math.max(fiatValue - fee, 0);
    }
    const notes = fields.length > 8 && fields[8] ? fields[8] : null;

    const existingIndex = indexByTimestamp.get(timestamp);
    if (existingIndex !== undefined) {
      const existing = portfolio.transactions[existingIndex];
      portfolio.transactions[existingIndex] = { ...existing, type, amountKas: kas, fiatValue, timestamp, notes };
    } else {
      portfolio.transactions.push({ id: nowId(), type, amountKas: kas, fiatValue, timestamp, notes });
      indexByTimestamp.set(timestamp, portfolio.transactions.length - 1);
    }
    imported += 1;
  }

  if (imported > 0) { saveState(); render(); }
  return imported;
}

// ---------------------------------------------------------------------------
// On-chain address import (iOS PortfolioAddressImporter): every received tx becomes a buy,
// every sent tx a sell, priced at that day's historical KAS price.
// ---------------------------------------------------------------------------

const IMPORT_MAX_TRANSACTIONS = 500;

function txDirectionForAddress(tx, address) {
  const inputs = tx.inputs || [];
  const outputs = tx.outputs || [];
  const weAreSender = inputs.some((input) => input.previous_outpoint_address === address);
  let totalToUs = 0n;
  let totalToOthers = 0n;
  let recipientAmount = 0n;
  let haveRecipient = false;
  for (const output of outputs) {
    const outAddress = output.script_public_key_address;
    const amount = BigInt(output.amount || 0);
    if (!outAddress) continue;
    if (outAddress === address) {
      totalToUs += amount;
    } else {
      totalToOthers += amount;
      if (!haveRecipient || amount < recipientAmount) { recipientAmount = amount; haveRecipient = true; }
    }
  }
  if (weAreSender && totalToOthers > 0n) return { isOutgoing: true, amountSompi: haveRecipient ? recipientAmount : totalToOthers };
  if (!weAreSender && totalToUs > 0n) return { isOutgoing: false, amountSompi: totalToUs };
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setImportProgress(text) {
  if (addressImport) addressImport.progress = text;
  const el = modalsEl.querySelector("[data-portfolio-import-progress]");
  if (el) el.textContent = text || "";
}

// --- address field: raw address or KNS domain (iOS PortfolioAddAddressView) ---

function looksLikeRawAddress(input) {
  const lower = String(input || "").toLowerCase();
  return lower.startsWith("kaspa:") || lower.startsWith("kaspatest:");
}

function isValidRawAddress(input) {
  return /^kaspa:[a-z0-9]{50,90}$/.test(String(input || "").toLowerCase());
}

function shortenAddress(address) {
  return address.length > 26 ? `${address.slice(0, 16)}...${address.slice(-8)}` : address;
}

/** What Import actually runs against: the resolved owner of a KNS domain, else the raw input. */
function importEffectiveAddress() {
  return addressImport?.resolvedAddress || addressImport?.input || "";
}

function canImportAddress() {
  if (!addressImport || addressImport.busy) return false;
  if (addressImport.resolvedAddress) return true;
  return isValidRawAddress(addressImport.input);
}

/** Under-field status line + button states — port of iOS's `validationStatus`: nothing while
 *  empty or mid-resolution, "Resolves to ..." for a resolved domain, a quiet "Domain not found",
 *  or the raw address's valid/invalid affordance. */
function syncImportModal() {
  if (!modalsEl) return;
  const startBtn = modalsEl.querySelector("[data-portfolio-import-start]");
  const pasteBtn = modalsEl.querySelector("[data-portfolio-import-paste]");
  const scanBtn = modalsEl.querySelector("[data-portfolio-import-scan]");
  const status = modalsEl.querySelector("[data-portfolio-import-status]");
  if (startBtn) startBtn.disabled = !canImportAddress();
  if (pasteBtn) pasteBtn.disabled = Boolean(addressImport?.busy);
  if (scanBtn) scanBtn.disabled = Boolean(addressImport?.busy);
  if (!status) return;

  const input = addressImport?.input || "";
  status.style.color = "";
  if (addressImport?.resolving) { status.textContent = "Resolving domain…"; return; }
  if (!input) { status.textContent = ""; return; }
  if (addressImport.resolvedAddress) {
    status.textContent = `Resolves to ${shortenAddress(addressImport.resolvedAddress)}`;
    status.style.color = "#4cd964";
    return;
  }
  if (addressImport.notFound) { status.textContent = "Domain not found"; return; }
  if (looksLikeRawAddress(input)) {
    const valid = isValidRawAddress(input);
    status.textContent = valid ? "Valid address" : "Invalid address format";
    status.style.color = valid ? "#4cd964" : "#ff6b6b";
    return;
  }
  status.textContent = "";
}

// Bumped on every keystroke so an in-flight lookup for older input can't land on newer input.
let knsResolveSeq = 0;

function handleImportInputChange(raw) {
  if (!addressImport || addressImport.busy) return;
  const trimmed = String(raw || "").trim();
  addressImport.input = trimmed;
  addressImport.resolvedAddress = null;
  addressImport.resolvedDomain = null;
  addressImport.notFound = false;
  addressImport.resolving = false;
  const seq = (knsResolveSeq += 1);

  if (trimmed && !looksLikeRawAddress(trimmed) && looksLikeDomain(trimmed)) {
    addressImport.resolving = true;
    resolveImportDomain(trimmed, seq);
  }
  syncImportModal();
}

/** Clipboard fill for the address field — the desktop equivalent of iOS's Paste button. Setting
 *  the field's value programmatically fires no `input` event, so the change is fed through by
 *  hand (mirroring iOS, where assigning `addressText` triggers `handleInputChange`). */
async function pasteIntoImportField() {
  if (!addressImport || addressImport.busy) return;
  let text = "";
  try {
    text = String((await navigator.clipboard.readText()) || "").trim();
  } catch {
    setImportProgress("Couldn't read the clipboard. Paste into the field with Cmd+V instead.");
    return;
  }
  if (!text) return;
  // Strip URI query params (kaspa:addr?amount=...) so only the address itself lands in the
  // field — same normalization iOS's scan/paste handler applies.
  if (looksLikeRawAddress(text)) text = text.split("?")[0];
  fillImportField(text);
}

/** Camera scan for the address field, the desktop equivalent of iOS's Scan button
 *  (PortfolioTransactionsView's `showQRScanner` / `handleScannedQRCode`). The scanner
 *  already strips a `kaspa:addr?amount=...` query, and the result is fed through the
 *  SAME path the Paste button uses, so KNS resolution and validation still run. */
async function scanIntoImportField() {
  if (!addressImport || addressImport.busy) return;
  let scanned = null;
  try {
    scanned = await scanKaspaAddress();
  } catch {
    setImportProgress("The QR scanner could not be opened. Paste or type the address instead.");
    return;
  }
  // The sheet may have been closed while the scanner was up.
  if (!scanned || !addressImport || addressImport.busy) return;
  fillImportField(scanned);
}

/** Programmatic field fill: setting `value` fires no `input` event, so the change is fed
 *  through by hand (mirroring iOS, where assigning `addressText` triggers `handleInputChange`). */
function fillImportField(text) {
  const field = modalsEl.querySelector("[data-portfolio-import-address]");
  if (field) field.value = text;
  setImportProgress("");
  handleImportInputChange(text);
}

/** Debounced forward resolution — the same 300ms wait-then-check-input-unchanged pattern iOS
 *  uses, so mid-typing keystrokes never each fire a KNS request. */
async function resolveImportDomain(domain, seq) {
  await sleep(300);
  if (seq !== knsResolveSeq || addressImport?.input !== domain) return;

  let resolution = null;
  try {
    resolution = await resolveDomain(domain, { baseUrl: getEndpoint("knsApi") });
  } catch { resolution = null; }

  // Input may have moved on while the lookup was in flight — a stale answer must not overwrite
  // the state for what's in the field now.
  if (seq !== knsResolveSeq || addressImport?.input !== domain) return;
  addressImport.resolvedAddress = resolution?.ownerAddress || null;
  addressImport.resolvedDomain = resolution?.domain || null;
  addressImport.notFound = !resolution;
  addressImport.resolving = false;
  syncImportModal();
}

/** Backoff schedule for a failing history page: retry the SAME offset with growing pauses before
 *  declaring the fetch incomplete, instead of aborting the whole import on the first hiccup.
 *  Port of PortfolioAddressImporter.pageRetryDelaysSeconds. */
const PAGE_RETRY_DELAYS_MS = [0, 1000, 3000, 8000];
const IMPORT_PAGE_SIZE = 50;

/** Same endpoint and paging as before, but a failing page retries the SAME offset on a growing
 *  backoff — and when the retries are exhausted, whatever was fetched so far is returned (marked
 *  incomplete) so the import can still save the rows it has. A 429 on page 4 used to discard
 *  pages 1 through 3 entirely. Port of PortfolioAddressImporter.fetchTransactionsResumable. */
async function fetchTransactionsResumable(address, onProgress) {
  const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
  const all = [];
  let offset = 0;

  while (all.length < IMPORT_MAX_TRANSACTIONS) {
    const url = `${base}/addresses/${encodeURIComponent(address)}/full-transactions`
      + `?limit=${IMPORT_PAGE_SIZE}&offset=${offset}&resolve_previous_outpoints=light`;

    let page = null;
    for (let attempt = 0; attempt < PAGE_RETRY_DELAYS_MS.length; attempt += 1) {
      if (PAGE_RETRY_DELAYS_MS[attempt] > 0) {
        onProgress(`Fetching transactions… (retrying, ${all.length} so far)`);
        await sleep(PAGE_RETRY_DELAYS_MS[attempt]);
      }
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) continue;
        const json = await response.json();
        if (!Array.isArray(json)) continue;
        page = json;
        break;
      } catch { /* network hiccup — the next attempt waits longer */ }
    }

    if (page === null) return { transactions: all, complete: false };
    if (!page.length) break;
    all.push(...page);
    onProgress(`Fetching transactions… (${all.length})`);
    if (page.length < IMPORT_PAGE_SIZE) break;
    offset += IMPORT_PAGE_SIZE;
  }

  return { transactions: all.slice(0, IMPORT_MAX_TRANSACTIONS), complete: true };
}

/** Imports `address`'s on-chain history into the active portfolio. The rows are SAVED FIRST —
 *  with whatever prices the persistent day cache already knows — and everything still unpriced
 *  is handed to the background backfill, so a CoinGecko rate limit can never cost the user the
 *  ledger data itself. Mirrors iOS: PortfolioAddressImporter.importAddress returns rows and
 *  PortfolioViewModel.importAddress persists them before kicking off startPriceBackfillIfNeeded. */
async function runAddressImport(addressRaw) {
  const address = String(addressRaw || "").trim();
  try {
    validateMainnetAddress(address);
    // validateMainnetAddress only checks the prefix — also require a plausible bech32 payload
    // so obvious typos fail here instead of as an opaque Kaspa API error. KNS domains never
    // reach this check: the field resolves them to an address before Import is enabled.
    if (!/^kaspa:[a-z0-9]{50,90}$/.test(address)) throw new Error("bad payload");
  } catch {
    setImportProgress("That doesn't look like a valid mainnet Kaspa address.");
    return;
  }
  addressImport.busy = true;
  syncImportModal();

  try {
    // Re-importing the same address only adds transactions not already present anywhere in
    // this account's ledgers (deduped by on-chain tx id, matching iOS's whole-wallet dedup).
    const existingTxIds = new Set();
    for (const p of state.portfolios) {
      for (const tx of p.transactions || []) {
        if (tx.sourceAddress === address && tx.sourceTxId) existingTxIds.add(tx.sourceTxId);
      }
    }

    setImportProgress("Fetching transactions…");
    const historyResult = await fetchTransactionsResumable(address, setImportProgress);

    const candidates = [];
    for (const tx of historyResult.transactions) {
      const txId = tx.transaction_id;
      const blockTime = Number(tx.block_time);
      if (!txId || existingTxIds.has(txId) || !Number.isFinite(blockTime) || blockTime <= 0) continue;
      const direction = txDirectionForAddress(tx, address);
      if (!direction) continue;
      candidates.push({
        txId,
        isOutgoing: direction.isOutgoing,
        amountKas: Number(direction.amountSompi) / 1e8,
        timestamp: blockTime,
        day: utcDayKey(blockTime),
      });
    }
    if (!candidates.length) {
      setImportProgress(historyResult.complete
        ? "No new transactions found for this address."
        : "Couldn't fetch this address's transactions. Check your connection and try again.");
      return;
    }

    // Prices the day cache already holds are applied for free (no network call at all); every
    // other row lands with the pending sentinel and is filled in by the backfill below.
    const currency = currencyCode();
    const uniqueDays = [...new Set(candidates.map((c) => c.day))];
    const priceByDay = peekDailyPrices(uniqueDays, currency);

    const portfolio = activePortfolio();
    portfolio.transactions ||= [];
    let missingPriceCount = 0;
    for (const c of candidates) {
      const dayPrice = priceByDay[c.day];
      const priced = Number.isFinite(dayPrice);
      if (!priced) missingPriceCount += 1;
      portfolio.transactions.push({
        id: nowId(),
        type: c.isOutgoing ? "sell" : "buy",
        amountKas: c.amountKas,
        fiatValue: priced ? c.amountKas * dayPrice : 0,
        timestamp: c.timestamp,
        notes: priced ? null : PRICE_PENDING_NOTE,
        sourceAddress: address,
        sourceTxId: c.txId,
      });
    }
    // Saved BEFORE any pricing network call — this is the whole point: the ledger survives a
    // mid-import rate limit, whatever CoinGecko does next.
    saveState();
    render();

    setImportProgress(
      `Imported ${candidates.length} transaction${candidates.length === 1 ? "" : "s"}.`
      + (historyResult.complete ? "" : " Some pages couldn't be fetched, so this is partial - run it again later to pick up the rest.")
      + (missingPriceCount ? ` Prices for ${missingPriceCount} of them are still loading and will fill in automatically.` : ""),
    );
    startPriceBackfillIfNeeded();
  } catch (error) {
    setImportProgress(`Import failed: ${error.message}`);
  } finally {
    if (addressImport) addressImport.busy = false;
    syncImportModal();
  }
}

// ---------------------------------------------------------------------------
// Background price backfill (iOS PortfolioViewModel.startPriceBackfillIfNeeded)
// ---------------------------------------------------------------------------

function pendingPriceRows() {
  const rows = [];
  for (const p of state.portfolios) {
    for (const tx of p.transactions || []) {
      if (isPricePending(tx.notes) && tx.sourceTxId) rows.push(tx);
    }
  }
  return rows;
}

/** Prices auto-imported rows the import itself couldn't price. Runs a few passes on a growing
 *  backoff — each pass retries the batched range call first (cheap: cache + at most one request)
 *  and then walks the leftover days through the paced per-day fallback, saving every price the
 *  moment it lands so rows fill in incrementally rather than all-or-nothing. One loop at a time;
 *  re-triggering while it runs is a no-op (the running loop picks up any newly imported rows on
 *  its next pass). */
function startPriceBackfillIfNeeded() {
  if (priceBackfillTimer || !pendingPriceRows().length) return;
  const accountKey = deps.accountScopedKey(PORTFOLIO_KEY);
  priceBackfillTimer = (async () => {
    for (const delay of [0, 30_000, 120_000, 300_000]) {
      if (delay > 0) await sleep(delay);
      // An account switch reloaded `state` out from under this loop — its rows are gone.
      if (deps.accountScopedKey(PORTFOLIO_KEY) !== accountKey || !pendingPriceRows().length) break;
      await runPriceBackfillPass(accountKey);
    }
    priceBackfillTimer = null;
  })();
}

async function runPriceBackfillPass(accountKey) {
  const currency = currencyCode();
  const pending = pendingPriceRows();
  if (!pending.length) return;
  const days = [...new Set(pending.map((tx) => utcDayKey(tx.timestamp)))];

  const prices = await resolveDailyPrices(days, currency);
  // Days the batched range couldn't cover (older than CoinGecko's keyless 365-day window, or
  // the range call failed): paced per-day fallback, newest first, capped per pass so one pass
  // stays bounded — the rest wait for the next pass.
  const missing = days.filter((day) => prices[day] === undefined).sort().reverse().slice(0, 30);
  for (const day of missing) {
    if (deps.accountScopedKey(PORTFOLIO_KEY) !== accountKey) return;
    const value = await resolveDailyPriceSingle(day, currency);
    if (value !== null) prices[day] = value;
    await sleep(PRICE_REQUEST_SPACING_MS);
  }

  if (deps.accountScopedKey(PORTFOLIO_KEY) !== accountKey) return;
  let changed = false;
  for (const p of state.portfolios) {
    for (const tx of p.transactions || []) {
      if (!isPricePending(tx.notes) || !tx.sourceTxId) continue;
      const dayPrice = prices[utcDayKey(tx.timestamp)];
      if (!Number.isFinite(dayPrice)) continue;
      tx.fiatValue = (Number(tx.amountKas) || 0) * dayPrice;
      tx.notes = null;
      changed = true;
    }
  }
  if (changed) { saveState(); render(); }
}

// ---------------------------------------------------------------------------
// Modals (transaction editor + address import) — live outside rootEl so render() can't wipe them
// ---------------------------------------------------------------------------

function buildModals() {
  modalsEl = document.createElement("div");
  modalsEl.innerHTML = `
    <div class="modal-backdrop" data-portfolio-editor-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Transaction">
        <div class="modal-header">
          <div><p class="modal-kicker">Portfolio</p><h2 data-portfolio-editor-title>Add Transaction</h2></div>
          <button class="modal-close" type="button" data-portfolio-editor-close aria-label="Close">×</button>
        </div>
        <div class="portfolio-editor-body">
          <label class="portfolio-editor-field">
            <span>Type</span>
            <select data-portfolio-editor-type>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>
          <label class="portfolio-editor-field">
            <span>Amount (KAS)</span>
            <input type="number" step="any" min="0" placeholder="0.0" data-portfolio-editor-amount />
          </label>
          <label class="portfolio-editor-field">
            <span data-portfolio-editor-fiat-label>Total Value (USD)</span>
            <input type="number" step="any" min="0" placeholder="0.00" data-portfolio-editor-fiat />
          </label>
          <p class="portfolio-editor-hint" data-portfolio-editor-hint></p>
          <label class="portfolio-editor-field">
            <span>Date</span>
            <input type="datetime-local" data-portfolio-editor-date />
          </label>
          <label class="portfolio-editor-field">
            <span>Notes</span>
            <input type="text" maxlength="120" placeholder="Optional" data-portfolio-editor-notes />
          </label>
        </div>
        <div class="modal-actions portfolio-editor-actions">
          <button class="secondary-button" type="button" data-portfolio-editor-delete hidden>Delete</button>
          <button class="primary-button" type="button" data-portfolio-editor-save>Save</button>
        </div>
      </div>
    </div>

    <div class="modal-backdrop" data-portfolio-confirm-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Confirm" data-portfolio-confirm-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-name-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Name" data-portfolio-name-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-action-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Portfolio actions" data-portfolio-action-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-card-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Portfolio options" data-portfolio-card-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-reorder-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Reorder Portfolios" data-portfolio-reorder-body></div>
    </div>

    <div class="modal-backdrop" data-portfolio-import-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Add Kaspa Address">
        <div class="modal-header">
          <div><p class="modal-kicker">Portfolio</p><h2>Add Kaspa Address</h2></div>
          <button class="modal-close" type="button" data-portfolio-import-close aria-label="Close">×</button>
        </div>
        <div class="portfolio-editor-body">
          <p class="portfolio-import-note">Enter a Kaspa address or a KNS domain like name.kas. Imports that address's on-chain history: every received transaction becomes a buy and every sent one a sell, priced at that day's KAS price. Re-running later only adds new activity.</p>
          <label class="portfolio-editor-field">
            <span>Kaspa Address or KNS Domain</span>
            <input type="text" placeholder="kaspa:qr… or name.kas" data-portfolio-import-address spellcheck="false" autocomplete="off" autocapitalize="off" />
          </label>
          <p class="portfolio-editor-hint" data-portfolio-import-status></p>
          <div class="portfolio-tx-header-actions">
            <button class="cold-inline-link" type="button" data-portfolio-import-paste>Paste</button>
            <button class="cold-inline-link" type="button" data-portfolio-import-scan>Scan QR</button>
          </div>
          <p class="portfolio-import-progress" data-portfolio-import-progress></p>
        </div>
        <div class="modal-actions">
          <button class="primary-button" type="button" data-portfolio-import-start>Import</button>
        </div>
      </div>
    </div>

    <input type="file" accept=".csv,text/csv" data-portfolio-csv-input hidden />`;
  document.body.appendChild(modalsEl);

  modalsEl.addEventListener("click", async (event) => {
    if (event.target.closest("[data-portfolio-confirm-cancel]")) { settleConfirm(false); return; }
    if (event.target.closest("[data-portfolio-confirm-ok]")) { settleConfirm(true); return; }
    if (event.target.closest("[data-portfolio-name-cancel]")) { settleNamePrompt(null); return; }
    if (event.target.closest("[data-portfolio-name-ok]")) {
      settleNamePrompt(String(modalsEl.querySelector("[data-portfolio-name-input]")?.value || ""));
      return;
    }

    // --- Card settings overlay ---
    if (event.target.closest("[data-portfolio-card-close]")) {
      modalsEl.querySelector("[data-portfolio-card-modal]").hidden = true;
      cardModalId = null;
      return;
    }
    if (event.target.closest("[data-portfolio-card-back]")) { cardModalMode = "menu"; renderCardModal(); return; }
    const cardMode = event.target.closest("[data-portfolio-card-mode]");
    if (cardMode) {
      const mode = cardMode.dataset.portfolioCardMode;
      if (mode === "reorder") {
        // Reordering is about the whole set rather than this one card, so it hands over to its
        // own sheet instead of living as a step here.
        modalsEl.querySelector("[data-portfolio-card-modal]").hidden = true;
        reorderDraft = state.portfolios.map((p) => ({ id: p.id, name: p.name }));
        renderReorderModal();
        modalsEl.querySelector("[data-portfolio-reorder-modal]").hidden = false;
        return;
      }
      cardModalMode = mode;
      renderCardModal();
      return;
    }
    if (event.target.closest("[data-portfolio-card-rename-save]")) {
      const input = modalsEl.querySelector("[data-portfolio-card-name]");
      const name = String(input?.value || "").trim();
      const portfolio = state.portfolios.find((p) => p.id === cardModalId);
      if (portfolio && name) { portfolio.name = name; saveState(); }
      modalsEl.querySelector("[data-portfolio-card-modal]").hidden = true;
      cardModalId = null;
      render();
      return;
    }
    if (event.target.closest("[data-portfolio-card-delete-confirm]")) {
      const portfolio = state.portfolios.find((p) => p.id === cardModalId);
      if (portfolio && state.portfolios.length > 1) {
        state.portfolios = state.portfolios.filter((p) => p.id !== portfolio.id);
        if (state.activeId === portfolio.id) state.activeId = state.portfolios[0].id;
        saveState();
      }
      modalsEl.querySelector("[data-portfolio-card-modal]").hidden = true;
      cardModalId = null;
      render();
      return;
    }

    // --- Reorder ---
    if (event.target.closest("[data-portfolio-reorder-close]")) {
      modalsEl.querySelector("[data-portfolio-reorder-modal]").hidden = true;
      return;
    }
    const move = event.target.closest("[data-portfolio-move]");
    if (move) {
      const from = Number(move.dataset.index);
      const to = move.dataset.portfolioMove === "up" ? from - 1 : from + 1;
      if (to < 0 || to >= reorderDraft.length) return;
      [reorderDraft[from], reorderDraft[to]] = [reorderDraft[to], reorderDraft[from]];
      renderReorderModal();
      return;
    }
    if (event.target.closest("[data-portfolio-reorder-save]")) {
      // Reordered by id, so a portfolio added or removed while the sheet was open cannot be
      // dropped: anything not named in the draft keeps its place at the end.
      const order = reorderDraft.map((p) => p.id);
      const byId = new Map(state.portfolios.map((p) => [p.id, p]));
      const reordered = order.map((id) => byId.get(id)).filter(Boolean);
      for (const portfolio of state.portfolios) if (!order.includes(portfolio.id)) reordered.push(portfolio);
      state.portfolios = reordered;
      saveState();
      modalsEl.querySelector("[data-portfolio-reorder-modal]").hidden = true;
      render();
      return;
    }
    if (event.target.closest("[data-portfolio-editor-close]")) { closeTxEditor(); return; }
    if (event.target.closest("[data-portfolio-editor-save]")) { saveTxEditor(); return; }
    if (event.target.closest("[data-portfolio-editor-delete]")) {
      if (editingTx?.id && await confirmOverlay({ title: "Delete transaction?", message: "This removes it from the portfolio. It cannot be undone." })) {
        const portfolio = activePortfolio();
        portfolio.transactions = (portfolio.transactions || []).filter((t) => t.id !== editingTx.id);
        saveState();
        closeTxEditor();
        render();
      }
      return;
    }
    if (event.target.closest("[data-portfolio-import-close]")) {
      if (!addressImport?.busy) {
        addressImport = null;
        knsResolveSeq += 1; // any in-flight KNS lookup belongs to a sheet that's gone
        closeActiveScanner(); // and so does any camera it opened
        modalsEl.querySelector("[data-portfolio-import-modal]").hidden = true;
      }
      return;
    }
    if (event.target.closest("[data-portfolio-import-paste]")) {
      pasteIntoImportField();
      return;
    }
    if (event.target.closest("[data-portfolio-import-scan]")) {
      scanIntoImportField();
      return;
    }
    if (event.target.closest("[data-portfolio-import-start]")) {
      // Runs against the RESOLVED address when a KNS domain was typed, not the domain text.
      if (canImportAddress()) runAddressImport(importEffectiveAddress());
    }
  });

  modalsEl.addEventListener("input", (event) => {
    if (event.target.closest("[data-portfolio-editor-amount], [data-portfolio-editor-fiat]")) updateEditorHint();
    if (event.target.closest("[data-portfolio-import-address]")) handleImportInputChange(event.target.value);
  });

  modalsEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.closest("[data-portfolio-import-address]")) {
      event.preventDefault();
      if (canImportAddress()) runAddressImport(importEffectiveAddress());
    }
  });

  modalsEl.querySelector("[data-portfolio-csv-input]").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    const imported = importCsvText(text);
    deps.showToast?.(imported > 0 ? `Imported ${imported} row${imported === 1 ? "" : "s"}.` : "No KAS rows found in that CSV.");
  });
}

// ---------------------------------------------------------------------------
// Data refresh
// ---------------------------------------------------------------------------

/** Best data already on hand for a range, so every render paints something instead of blanking:
 *  this session's fetch first, else the persisted copy for THAT range (even past its 10-minute
 *  TTL — a 3-month curve from an hour ago is still the right shape, and it beats showing another
 *  range's curve). Port of iOS's stale-while-refresh per-range painting. */
function historyForRange(days) {
  const session = historyByRange[days];
  if (session?.length) return session;
  return peekKasPriceHistory(days, currencyCode())?.points || [];
}

/** Drops every cached curve when the selected currency changes — EUR numbers must never be
 *  painted from the USD cache. Mirrors iOS handleSettingsChanged -> refreshPrice(). */
function syncCurrencyState() {
  const currency = currencyCode();
  if (historyCurrency === currency) return false;
  historyCurrency = currency;
  historyByRange = {};
  attemptedRanges = new Set();
  price = peekKasPrice(currency);
  return true;
}

// Ranges this session has already tried to fetch for the current currency — stops the
// "range changed while we were fetching" catch-up below from looping forever on a range whose
// fetch keeps failing.
let attemptedRanges = new Set();

async function refreshData({ force = false } = {}) {
  if (loading) return;
  // The hashrate card sits on the main screen, so its series is pulled with everything else -
  // best-effort, and it repaints itself when it lands rather than holding up the price refresh.
  fetchNetworkStats({ force }).then((stats) => { if (stats && view === "main") render(); }).catch(() => {});
  syncCurrencyState();
  if (force) attemptedRanges = new Set();
  const currency = historyCurrency;
  // Capture the range this refresh is fetching — a range tap mid-refresh must not mis-key the
  // cache write or repaint the new range with the old range's data.
  const days = rangeDays;
  attemptedRanges.add(days);
  loading = true;
  render(); // paints from cache immediately; the fetch below only ever upgrades it
  try {
    const [priceResult, historyResult, sevenDayResult] = await Promise.all([
      fetchKasPrice({ force, currency }),
      fetchKasPriceHistory(days, { currency, force }),
      days === 7 ? null : fetchKasPriceHistory(7, { currency, force }),
    ]);
    // A currency switch while this was in flight makes every result stale — drop it.
    if (currencyCode() !== currency) return;
    if (priceResult) price = priceResult;
    if (historyResult?.length) historyByRange[days] = historyResult;
    if (days !== 7 && sevenDayResult?.length) historyByRange[7] = sevenDayResult;
  } finally {
    loading = false;
    render();
    // The user switched range or currency while this fetch was in flight, which made that tap's
    // own refreshData a no-op — go fetch what they're actually looking at now. Converges: a
    // currency switch resets attemptedRanges, and every pass records the range it tried.
    const currencyMoved = currencyCode() !== currency;
    const rangeUnfetched = rangeDays !== days && !historyByRange[rangeDays]?.length && !attemptedRanges.has(rangeDays);
    if (currencyMoved || rangeUnfetched) refreshData({ force: currencyMoved });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/** For the swap screen's "Add to Portfolio": the available portfolios (id + name). */
export function listPortfolios() {
  ensureDefaultPortfolio();
  return state.portfolios.map((p) => ({ id: p.id, name: p.name, isActive: p.id === state.activePortfolioId }));
}

/// Which portfolios already hold this on-chain transaction, so a chooser can flag a duplicate
/// while the choice is still being made rather than silently double-counting it (iOS
/// `portfolioIdsContaining(sourceTxId:)`).
export function portfolioIdsContainingTx(sourceTxId) {
  ensureDefaultPortfolio();
  const target = String(sourceTxId || "").trim();
  if (!target) return new Set();
  const ids = new Set();
  for (const portfolio of state.portfolios) {
    if ((portfolio.transactions || []).some((tx) => tx.sourceTxId === target)) ids.add(portfolio.id);
  }
  return ids;
}

/// The KAS price on a given day in the reader's currency, for pricing a transaction at what it
/// was worth WHEN IT HAPPENED. Today's number on a transaction from last year silently misstates
/// every figure the portfolio derives from it.
export async function historicalKasPrice(timestamp) {
  try { return await resolveDailyPriceSingle(utcDayKey(timestamp), currencyCode()); }
  catch { return null; }
}

/** Appends a transaction to a specific portfolio (used by completed swaps). */
export function addTransactionToPortfolio(portfolioId, {
  type, amountKas, fiatValue = null, notes = null,
  timestamp = null, sourceTxId = null, sourceAddress = null,
} = {}) {
  const portfolio = state.portfolios.find((p) => p.id === portfolioId) || activePortfolio();
  (portfolio.transactions ||= []).push({
    id: nowId(),
    type: type === "sell" ? "sell" : "buy",
    amountKas: Number(amountKas) || 0,
    fiatValue: Number(fiatValue) || 0,
    notes: notes || null,
    // The time it HAPPENED, not the time it was recorded - a chart replayed over the ledger puts
    // the transaction on the wrong day otherwise.
    timestamp: Number(timestamp) || Date.now(),
    // Recorded so a later add of the same transaction is recognised rather than double-counted.
    sourceTxId: sourceTxId || null,
    sourceAddress: sourceAddress || null,
  });
  saveState();
  render();
}

export function refreshPortfolio() {
  ensureDefaultPortfolio();
  view = "main"; // always land on the main portfolio screen when the tab is (re)opened
  render();
  refreshData();
  // Rows left unpriced by an import the browser was closed during (or by an older build with no
  // backfill at all) resume pricing here — same trigger point as iOS's setCurrentWallet.
  startPriceBackfillIfNeeded();
}

export function resetPortfolioForAccount() {
  closeActiveScanner(); // an account switch must never leave a camera running
  loadState();
  ensureDefaultPortfolio();
  render();
  startPriceBackfillIfNeeded();
}

function closeCardMenus(except = null) {
  rootEl.querySelectorAll("[data-portfolio-card-actions]").forEach((el) => {
    if (el.dataset.portfolioCardActions !== except) el.hidden = true;
  });
  const io = rootEl.querySelector("[data-portfolio-io-dropdown]");
  if (io && except !== "io") io.hidden = true;
}

export function initPortfolio(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-portfolio-root]");
  loadState();
  ensureDefaultPortfolio();
  buildModals();
  historyCurrency = currencyCode();
  const initialFiatLabel = modalsEl?.querySelector("[data-portfolio-editor-fiat-label]");
  if (initialFiatLabel) initialFiatLabel.textContent = `Total Value (${historyCurrency.toUpperCase()})`;

  // The converter and the mining estimate write into module state and refresh only the DERIVED
  // figure. Re-rendering the whole screen on each keystroke would take the caret with it.
  rootEl?.addEventListener("input", (event) => {
    const target = event.target;
    if (target.matches("[data-portfolio-conv-kas]") || target.matches("[data-portfolio-conv-fiat]")) {
      const typingKas = target.matches("[data-portfolio-conv-kas]");
      const rate = price?.price;
      const amount = Number(String(target.value).replace(",", "."));
      const other = rootEl.querySelector(typingKas ? "[data-portfolio-conv-fiat]" : "[data-portfolio-conv-kas]");
      if (typingKas) converterKas = target.value; else converterFiat = target.value;
      // Only the field being typed in is authoritative; the other is derived. Writing a rounded
      // value back through the rate is how a converter drifts.
      if (!Number.isFinite(amount) || amount <= 0 || !rate || rate <= 0) {
        if (other) other.value = "";
        if (typingKas) converterFiat = ""; else converterKas = "";
        return;
      }
      const derived = typingKas ? amount * rate : amount / rate;
      const text = typingKas ? derived.toFixed(2) : derived.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
      if (other) other.value = text;
      if (typingKas) converterFiat = text; else converterKas = text;
      return;
    }
    if (target.matches("[data-portfolio-hashrate-input]")) {
      hashrateInput = target.value;
      const stats = peekNetworkStats();
      const daily = estimateDailyKas({
        yourHashrateHs: typedHashrateHs(),
        networkHashrateHs: stats?.currentHashrate,
        blockRewardKas: stats?.blockRewardKas,
      });
      const cellFor = (label) => [...rootEl.querySelectorAll(".portfolio-stat-row")]
        .find((row) => row.querySelector(".portfolio-stat-label")?.textContent === label)
        ?.querySelector(".portfolio-stat-value");
      const dailyCell = cellFor("Estimated daily");
      const fiatCell = cellFor("At today's price");
      if (dailyCell) dailyCell.textContent = daily === null ? "—" : fmtKas(daily);
      if (fiatCell) fiatCell.textContent = daily === null || !price ? "—" : fmtFiat(daily * price.price);
    }
  });

  document.addEventListener("click", (event) => {
    // Any click outside the portfolio pane's menus closes them.
    if (!rootEl || rootEl.contains(event.target)) return;
    closeCardMenus();
  });

  // Settings > Customization > Currency lives in ui/app.js, which fires this after persisting
  // the new choice. A currency switch while Portfolio is open must not merely reformat the
  // existing (wrong-currency) numbers, so every cached curve is dropped and refetched — iOS
  // does exactly this in PortfolioViewModel.handleSettingsChanged.
  document.addEventListener("kachat:currency-changed", () => {
    syncCurrencyState();
    const fiatLabel = modalsEl?.querySelector("[data-portfolio-editor-fiat-label]");
    if (fiatLabel) fiatLabel.textContent = `Total Value (${currencyCode().toUpperCase()})`;
    render();
    refreshData({ force: true });
  });

  rootEl?.addEventListener("click", async (event) => {
    const cardMenu = event.target.closest("[data-portfolio-card-menu]");
    if (cardMenu) {
      cardModalId = cardMenu.dataset.portfolioCardMenu;
      cardModalMode = "menu";
      renderCardModal();
      modalsEl.querySelector("[data-portfolio-card-modal]").hidden = false;
      return;
    }

    if (event.target.closest("[data-portfolio-reorder]")) {
      closeCardMenus();
      reorderDraft = state.portfolios.map((p) => ({ id: p.id, name: p.name }));
      renderReorderModal();
      modalsEl.querySelector("[data-portfolio-reorder-modal]").hidden = false;
      return;
    }
    if (event.target.closest("[data-portfolio-add]")) {
      if (state.portfolios.length >= MAX_PORTFOLIOS) return;
      const name = await namePromptOverlay({
        title: "New Portfolio",
        label: "Name",
        initial: `Portfolio ${state.portfolios.length + 1}`,
      });
      if (name?.trim()) {
        const p = { id: nowId(), name: name.trim(), transactions: [] };
        state.portfolios.push(p);
        state.activeId = p.id;
        saveState(); render();
      }
      return;
    }

    const select = event.target.closest("[data-portfolio-select]");
    if (select) { state.activeId = select.dataset.portfolioSelect; saveState(); render(); return; }

    const openSquare = event.target.closest("[data-portfolio-open]");
    if (openSquare) {
      view = openSquare.dataset.portfolioOpen;
      render();
      // Each screen pulls only what it needs, and repaints when it lands. Both are best-effort:
      // the screen stands without them rather than showing an error for a figure nobody asked for.
      if (view === "hashrate") fetchNetworkStats().then(() => { if (view === "hashrate") render(); }).catch(() => {});
      if (view === "price") {
        fetchKasMarketStats({ currency: deps.currencyCode?.().toLowerCase() || "usd" })
          .then(() => { if (view === "price") render(); }).catch(() => {});
      }
      return;
    }

    if (event.target.closest("[data-portfolio-back]")) { view = "main"; render(); return; }


    const unit = event.target.closest("[data-portfolio-hashrate-unit]");
    if (unit) { hashrateUnit = unit.dataset.portfolioHashrateUnit; render(); return; }

    const range = event.target.closest("[data-portfolio-range]");
    if (range) {
      rangeDays = Number(range.dataset.portfolioRange) || 7;
      render();       // repaints the tapped range from cache right away, even mid-refresh
      refreshData();  // no-op while a refresh is in flight; that one finishes into its own range
      return;
    }

    if (event.target.closest("[data-portfolio-refresh]")) { refreshData({ force: true }); return; }

    if (event.target.closest("[data-portfolio-add-menu]")) {
      actionSheetMode = "add";
      renderPortfolioActionSheet();
      modalsEl.querySelector("[data-portfolio-action-modal]").hidden = false;
      return;
    }

    if (event.target.closest("[data-portfolio-io-menu]")) {
      actionSheetMode = "io";
      renderPortfolioActionSheet();
      modalsEl.querySelector("[data-portfolio-action-modal]").hidden = false;
      return;
    }
    // The header overlays route into the same actions the old dropdown items ran.
    if (event.target.closest("[data-portfolio-action-close]")) {
      modalsEl.querySelector("[data-portfolio-action-modal]").hidden = true;
      return;
    }
    const portfolioAction = event.target.closest("[data-portfolio-action]");
    if (portfolioAction) {
      modalsEl.querySelector("[data-portfolio-action-modal]").hidden = true;
      const which = portfolioAction.dataset.portfolioAction;
      if (which === "tx") openTxEditor(null);
      else if (which === "address") openAddressImport();
      else if (which === "export") exportCsv();
      else if (which === "import") modalsEl.querySelector("[data-portfolio-csv-input]")?.click();
      return;
    }
    if (event.target.closest("[data-portfolio-export-csv]")) { closeCardMenus(); exportCsv(); return; }
    if (event.target.closest("[data-portfolio-import-csv]")) {
      closeCardMenus();
      modalsEl.querySelector("[data-portfolio-csv-input]")?.click();
      return;
    }
    if (event.target.closest("[data-portfolio-io-address]")) {
      closeCardMenus();
      openAddressImport();
      return;
    }
    const txDelete = event.target.closest("[data-portfolio-tx-delete]");
    if (txDelete) {
      if (await confirmOverlay({ title: "Delete transaction?", message: "This removes it from the portfolio. It cannot be undone." })) {
        const portfolio = activePortfolio();
        portfolio.transactions = (portfolio.transactions || []).filter((t) => t.id !== txDelete.dataset.portfolioTxDelete);
        saveState(); render();
      }
      return;
    }

    const txEdit = event.target.closest("[data-portfolio-tx-edit]");
    if (txEdit) { openTxEditor(txEdit.dataset.portfolioTxEdit); return; }

    closeCardMenus();
  });

  render();
}
