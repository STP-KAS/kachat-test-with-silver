// Swaps tab — ChangeNOW-powered KAS swaps, desktop port of the mobile 4.0 swap screen.
// The agreement gate (terms link + required checkbox), estimate, exchange creation, and a
// per-account history with live status refresh + "Add to Portfolio" on finished swaps.
//
// The ChangeNOW API key ships with the build, exactly like the iOS/Android apps: Vite inlines
// `VITE_CHANGENOW_API_KEY` from a gitignored `.env` at build time (mirroring Android's
// local.properties → BuildConfig and iOS's Secrets.xcconfig), so the key never lands in the
// public source but rides in the shipped bundle — same exposure as the store-app binaries.
// So swaps just work with no key to paste. A device-level localStorage override is still honored
// for forks that build without the .env or want their own ChangeNOW key.

import { listPortfolios, addTransactionToPortfolio } from "./portfolio.js";
import { chooseDialog } from "./dialogs.js";

const CN_BASE = "https://api.changenow.io/v1";
const API_KEY_KEY = "kachat-changenow-api-key-v1";           // global (device-level) override
// Build-time key (inlined by Vite). Guarded because `import.meta.env` doesn't exist outside a
// Vite transform (e.g. bare test harnesses) — falls back to empty, then to the localStorage key.
let BUILTIN_KEY = "";
try { BUILTIN_KEY = String(import.meta.env.VITE_CHANGENOW_API_KEY || "").trim(); } catch { BUILTIN_KEY = ""; }
const AGREED_KEY = "kachat-swap-disclaimer-agreed-v1";       // account-scoped
const HISTORY_KEY = "kachat-swap-history-v1";                // account-scoped
const COINS = ["btc", "eth", "sol", "ltc", "doge", "usdttrc20", "usdterc20", "xmr"];

let deps = null;
let rootEl = null;
let history = [];
let agreed = false;
let termsChecked = false;
let kasIsSendSide = true;
let otherCoin = "btc";
let estimate = null;
let estimateError = null;
let creating = false;

function apiKey() {
  // Device-level override wins (a fork's own key); otherwise the key baked into this build.
  return String(localStorage.getItem(API_KEY_KEY) || "").trim() || BUILTIN_KEY;
}

function loadState() {
  agreed = localStorage.getItem(deps.accountScopedKey(AGREED_KEY)) === "1";
  try { history = JSON.parse(localStorage.getItem(deps.accountScopedKey(HISTORY_KEY)) || "[]") || []; }
  catch { history = []; }
}

function saveHistory() {
  localStorage.setItem(deps.accountScopedKey(HISTORY_KEY), JSON.stringify(history));
}

async function cnGet(path) {
  const response = await fetch(`${CN_BASE}${path}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.message || `ChangeNOW request failed (${response.status}).`);
  return json;
}

function pairFor() {
  return kasIsSendSide ? `kas_${otherCoin}` : `${otherCoin}_kas`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (!rootEl) return;

  if (!agreed) {
    rootEl.innerHTML = `
      <div class="kaposts-header"><h1 class="kaposts-title">Swaps</h1></div>
      <div class="profile-card">
        <p class="profile-card-label">Before You Swap</p>
        <p class="swap-disclaimer-text">Swaps are processed by ChangeNOW, a third-party exchange. KaChat only submits your swap request and displays its status; KaChat is not responsible for failed, delayed, or lost swaps. If a swap doesn't go through, contact ChangeNOW support directly.</p>
        <a class="kaposts-view-link" href="https://changenow.io/terms-of-use" target="_blank" rel="noopener">Read ChangeNOW's Terms of Use</a>
        <label class="swap-terms-check">
          <input type="checkbox" data-swap-terms ${termsChecked ? "checked" : ""} />
          <span>I have read and agree to ChangeNOW's Terms of Use</span>
        </label>
        <button class="primary-button" type="button" data-swap-agree ${termsChecked ? "" : "disabled"}>I Agree</button>
      </div>`;
    return;
  }

  if (!apiKey()) {
    rootEl.innerHTML = `
      <div class="kaposts-header"><h1 class="kaposts-title">Swaps</h1></div>
      <div class="profile-card">
        <p class="profile-card-label">ChangeNOW API Key</p>
        <p class="swap-disclaimer-text">Desktop stores your ChangeNOW API key locally on this device (it's never committed to the app). Paste yours to enable swaps — get one free at changenow.io/api.</p>
        <form class="broadcast-join-row" data-swap-key-form>
          <input class="kaposts-reply-input" type="password" data-swap-key-input placeholder="ChangeNOW API key" required />
          <button class="primary-button" type="submit">Save</button>
        </form>
      </div>`;
    return;
  }

  const sendTicker = kasIsSendSide ? "KAS" : otherCoin.toUpperCase();
  const getTicker = kasIsSendSide ? otherCoin.toUpperCase() : "KAS";
  rootEl.innerHTML = `
    <div class="kaposts-header"><h1 class="kaposts-title">Swaps</h1></div>
    <div class="profile-card">
      <p class="profile-card-label">New Swap</p>
      <div class="swap-form">
        <div class="swap-form-row">
          <span>You send</span>
          <input type="number" step="any" min="0" data-swap-amount placeholder="Amount" />
          <strong>${sendTicker}</strong>
        </div>
        <button class="kaposts-icon-button" type="button" data-swap-flip title="Flip direction">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5"/></svg>
        </button>
        <div class="swap-form-row">
          <span>You get (estimated)</span>
          <strong data-swap-estimate>${estimate === null ? "—" : estimate}</strong>
          <select data-swap-coin>
            ${COINS.map((c) => `<option value="${c}" ${c === otherCoin ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}
          </select>
        </div>
        ${estimateError ? `<div class="broadcast-failed">${deps.escapeHtml(estimateError)}</div>` : ""}
        <div class="swap-form-row">
          <span>${kasIsSendSide ? `${getTicker} payout address` : "KAS payout address (defaults to this wallet)"}</span>
          <input type="text" data-swap-payout placeholder="${kasIsSendSide ? `Your ${getTicker} address` : deps.engine.address || "kaspa:…"}" />
        </div>
        <button class="primary-button" type="button" data-swap-create ${creating ? "disabled" : ""}>${creating ? "Creating…" : "Create Swap"}</button>
      </div>
    </div>
    <div class="profile-card">
      <p class="profile-card-label">Swap History</p>
      ${history.length === 0
        ? `<div class="portfolio-chart-empty">No swaps yet.</div>`
        : history.map((swap) => `
            <div class="portfolio-tx-row swap-row" data-swap-row="${swap.id}">
              <span class="portfolio-tx-amount">${swap.fromAmount} ${swap.fromTicker.toUpperCase()} → ${swap.toAmount || "?"} ${swap.toTicker.toUpperCase()}</span>
              <span class="swap-status ${swap.status}">${deps.escapeHtml(swap.status)}</span>
              <button class="kaposts-view-link" type="button" data-swap-refresh="${swap.id}">Refresh</button>
              ${swap.status === "finished" ? `<button class="kaposts-view-link" type="button" data-swap-add-portfolio="${swap.id}">Add to Portfolio</button>` : ""}
              ${swap.payinAddress && swap.status === "waiting" ? `<span class="portfolio-tx-notes">Send ${swap.fromAmount} ${swap.fromTicker.toUpperCase()} to: ${deps.escapeHtml(swap.payinAddress)}</span>` : ""}
            </div>`).join("")}
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let estimateTimer = null;
function scheduleEstimate() {
  if (estimateTimer) clearTimeout(estimateTimer);
  estimateTimer = window.setTimeout(runEstimate, 450);
}

async function runEstimate() {
  const amount = Number(rootEl?.querySelector("[data-swap-amount]")?.value);
  if (!Number.isFinite(amount) || amount <= 0) { estimate = null; estimateError = null; renderEstimateOnly(); return; }
  try {
    const min = await cnGet(`/min-amount/${pairFor()}?api_key=${encodeURIComponent(apiKey())}`);
    if (min?.minAmount && amount < min.minAmount) {
      estimate = null;
      estimateError = `Minimum is ${min.minAmount} ${kasIsSendSide ? "KAS" : otherCoin.toUpperCase()}.`;
      renderEstimateOnly();
      return;
    }
    const json = await cnGet(`/exchange-amount/${amount}/${pairFor()}?api_key=${encodeURIComponent(apiKey())}`);
    estimate = json?.estimatedAmount ? `≈ ${json.estimatedAmount}` : null;
    estimateError = null;
  } catch (error) {
    estimate = null;
    estimateError = error.message;
  }
  renderEstimateOnly();
}

function renderEstimateOnly() {
  const el = rootEl?.querySelector("[data-swap-estimate]");
  if (el) el.textContent = estimate === null ? "—" : estimate;
  // Error line needs a full re-render only when it changes visibility; cheap enough:
  const hasErrorEl = Boolean(rootEl?.querySelector(".swap-form .broadcast-failed"));
  if (Boolean(estimateError) !== hasErrorEl) {
    const amountValue = rootEl?.querySelector("[data-swap-amount]")?.value || "";
    const payoutValue = rootEl?.querySelector("[data-swap-payout]")?.value || "";
    render();
    const amountEl = rootEl?.querySelector("[data-swap-amount]");
    const payoutEl = rootEl?.querySelector("[data-swap-payout]");
    if (amountEl) amountEl.value = amountValue;
    if (payoutEl) payoutEl.value = payoutValue;
  } else if (estimateError) {
    const errEl = rootEl?.querySelector(".swap-form .broadcast-failed");
    if (errEl) errEl.textContent = estimateError;
  }
}

async function createSwap() {
  if (creating) return;
  const amount = Number(rootEl?.querySelector("[data-swap-amount]")?.value);
  let payout = String(rootEl?.querySelector("[data-swap-payout]")?.value || "").trim();
  if (!kasIsSendSide && !payout) payout = deps.engine.address || "";
  if (!Number.isFinite(amount) || amount <= 0) { deps.showToast?.("Enter an amount."); return; }
  if (!payout) { deps.showToast?.("Enter the payout address."); return; }
  creating = true;
  render();
  try {
    const response = await fetch(`${CN_BASE}/transactions/${encodeURIComponent(apiKey())}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ from: kasIsSendSide ? "kas" : otherCoin, to: kasIsSendSide ? otherCoin : "kas", amount, address: payout }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.id) throw new Error(json?.message || `Swap creation failed (${response.status}).`);
    history.unshift({
      id: json.id,
      fromTicker: kasIsSendSide ? "kas" : otherCoin,
      toTicker: kasIsSendSide ? otherCoin : "kas",
      fromAmount: amount,
      toAmount: json.amount || null,
      payinAddress: json.payinAddress || "",
      status: "waiting",
      createdAt: Date.now(),
    });
    saveHistory();
    deps.showToast?.(`Swap created — send ${amount} ${kasIsSendSide ? "KAS" : otherCoin.toUpperCase()} to the deposit address shown in History.`);
  } catch (error) {
    deps.showToast?.(error.message);
  } finally {
    creating = false;
    render();
  }
}

async function refreshSwapStatus(id) {
  try {
    const json = await cnGet(`/transactions/${encodeURIComponent(id)}/${encodeURIComponent(apiKey())}`);
    const swap = history.find((s) => s.id === id);
    if (swap && json?.status) {
      swap.status = json.status;
      if (json.amountReceive) swap.toAmount = json.amountReceive;
      if (json.amountSend) swap.fromAmount = json.amountSend;
      saveHistory();
      render();
    }
  } catch (error) {
    deps.showToast?.(error.message);
  }
}

async function addSwapToPortfolio(swap) {
  const portfolios = listPortfolios();
  let targetId = portfolios[0]?.id;
  if (portfolios.length > 1) {
    // A list to pick from, rather than a numbered menu inside a browser prompt asking someone to
    // type "2". Nobody should have to count rows to answer a question the app can just ask.
    targetId = await chooseDialog({
      kicker: "Swap",
      title: "Add to which portfolio?",
      options: portfolios.map((portfolio) => ({ id: portfolio.id, title: portfolio.name })),
    });
    if (!targetId) return;
  }
  const kasReceived = swap.toTicker === "kas";
  addTransactionToPortfolio(targetId, {
    type: kasReceived ? "buy" : "sell",
    amountKas: kasReceived ? Number(swap.toAmount) || 0 : Number(swap.fromAmount) || 0,
    notes: `ChangeNOW swap ${swap.id}`,
  });
  deps.showToast?.("Added to portfolio");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function refreshSwaps() {
  render();
}

export function resetSwapsForAccount() {
  loadState();
  termsChecked = false;
  render();
}

export function initSwaps(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-swaps-root]");
  loadState();

  rootEl?.addEventListener("change", (event) => {
    if (event.target.closest("[data-swap-terms]")) {
      termsChecked = event.target.checked;
      render();
      return;
    }
    const coin = event.target.closest("[data-swap-coin]");
    if (coin) { otherCoin = coin.value; scheduleEstimate(); }
  });

  rootEl?.addEventListener("input", (event) => {
    if (event.target.closest("[data-swap-amount]")) scheduleEstimate();
  });

  rootEl?.addEventListener("submit", (event) => {
    const keyForm = event.target.closest("[data-swap-key-form]");
    if (keyForm) {
      event.preventDefault();
      const value = String(rootEl.querySelector("[data-swap-key-input]")?.value || "").trim();
      if (value) { localStorage.setItem(API_KEY_KEY, value); render(); }
    }
  });

  rootEl?.addEventListener("click", (event) => {
    if (event.target.closest("[data-swap-agree]")) {
      if (!termsChecked) return;
      agreed = true;
      localStorage.setItem(deps.accountScopedKey(AGREED_KEY), "1");
      render();
      return;
    }
    if (event.target.closest("[data-swap-flip]")) {
      kasIsSendSide = !kasIsSendSide;
      estimate = null;
      render();
      return;
    }
    if (event.target.closest("[data-swap-create]")) { createSwap(); return; }
    const refresh = event.target.closest("[data-swap-refresh]");
    if (refresh) { refreshSwapStatus(refresh.dataset.swapRefresh); return; }
    const addTo = event.target.closest("[data-swap-add-portfolio]");
    if (addTo) {
      const swap = history.find((s) => s.id === addTo.dataset.swapAddPortfolio);
      if (swap) addSwapToPortfolio(swap);
    }
  });

  render();
}
