import { KaspaEngine } from "../engine/index.js";
import { createGroupManager } from "../engine/group-store.js";
import { initKaPosts, refreshKaPostsFeed, resetKaPostsForAccount, openKaPostFromNotification, kaPostsFollowingAddresses } from "./kaposts.js";
import { fetchFollowList, requesterPubkeyFor, kaspaAddressFromPubkey } from "../engine/kaposts.js";
import { initBroadcasts, refreshBroadcasts, resetBroadcastsForAccount, stopBroadcastPolling, openBroadcastChannelFromNotification } from "./broadcasts.js";
import { initPortfolio, refreshPortfolio, resetPortfolioForAccount } from "./portfolio.js";
import { initColdStorage, refreshColdStorage, resetColdStorageForAccount, listColdWatchedAddresses, openColdAccountForAddress } from "./coldstorage.js";
import { scanKaspaAddress } from "./qr-scan.js";
import { initNextcloud, resetNextcloudForAccount, isNextcloudMediaSendActive, uploadNextcloudMedia, isNextcloudConnected, syncNextcloudContacts } from "./nextcloud.js";
import { initSwaps, refreshSwaps, resetSwapsForAccount } from "./swaps.js";
import { sealBackupEnvelope, openBackupEnvelope } from "./backup-crypto.js";
import { calculateMass, calculateFee, fetchQuotedFeeRateSompiPerGram } from "./kspt.js";
import {
  initChildMode, isChildModeEnabled, CHILD_HIDDEN_TABS,
  isUserTypePending, markUserTypePending,
  isOnboardingRunPending, pendingOnboardingRunKind, markOnboardingRunPending, clearOnboardingRunPending,
  renderUserTypeGuideStep, applyUserTypeGuideChoice, renderChildModeSettingsPage,
} from "./childmode.js";
import {
  initChatStorage,
  setChatStorageFlushErrorHandler,
  chatStorageGetSync,
  chatStorageSetSync,
  chatStorageRemoveSync,
  flushChatStorage,
} from "./storage.js";
import {
  MESSAGE_STATUSES,
  createConversation,
  createMessage,
  normalizeMessage as normalizeEngineMessage,
  applyMessagePatch,
  addMessageToConversation,
  lastMessage as engineLastMessage,
  statusLabel as engineStatusLabel,
} from "../engine/conversations.js";
import { KNSProfileLinkBuilder } from "../engine/kns.js";
import { getEndpoint, getEndpointOverride, setEndpoint, resetEndpoints, ENDPOINT_DEFAULTS } from "../engine/endpoints.js";
import * as Chess from "../engine/chess.js";
import { registrationAmounts as knsRegistrationAmounts, PROFILE_FIELD_EDIT_ORDER as KNS_PROFILE_FIELD_EDIT_ORDER } from "../engine/kns-write.js";
// Imported, not written as string paths: Vite only rewrites and emits the assets it can SEE, and
// a path inside a string is invisible to it - so these 404'd on the built site (a broken-image
// icon in the notification and on the KAS mark).
import kaspaLogoUrl from "./assets/kaspa-logo.png";
import kachatLogoUrl from "./assets/kachat-logo.png";
import { confirmText, promptText } from "./dialogs.js";

// Step 25 shell:
// - Keeps KaspaEngine modules intact.
// - Keeps UI behavior visually close to Step 10.
// - Refactors local chat state into Contacts + Conversations so future Kasia/Kaspa wiring
//   can attach txid, DAA score, status, unread state, and conversation metadata cleanly.
// - Messages still do not touch Kaspa/Kasia networking yet.

window.KaspaEngineClass = KaspaEngine;
window.__kaspaEngineStep = "kachat-shell-step-71";

const engine = new KaspaEngine({ log: appendEngineLog });
engine.onConnectionState?.(() => {
  updateServiceSummary();
});
engine.onSubscriptionState?.(() => {
  updateServiceSummary();
});
engine.onWalletActivity?.((event) => {
  if (walletActivityRefreshTimer) window.clearTimeout(walletActivityRefreshTimer);
  walletActivityRefreshTimer = window.setTimeout(async () => {
    appendEngineLog(`Live wallet activity: ${event?.type || "UTXO change"}`);
    await refreshBalanceOnly({ quiet: true });
    await refreshAllConversations({ quiet: true });
    // Own spending/cold addresses are in the tracked set too — diff their
    // balances against the persisted baselines (Address Activity notifications)
    // and keep the payment composer's Available pill fresh.
    scheduleAddressActivityCheck();
    refreshComposerAvailableBalance();
  }, 250);
});
const STORAGE_KEY = "kachat-shell-step25-state";
const MESSAGE_HISTORY_KEY = "kachat-shell-message-history-v1";
const STATE_BACKUP_KEY = "kachat-shell-state-backup-v1";
const STATE_BACKUP_MIN_INTERVAL_MS = 60_000;
let lastStateBackupWriteAt = 0;
const ACCOUNT_DATA_PREFIX = "kachat-account-data-v1";
const SESSION_LOGGED_OUT_KEY = "kachat-session-logged-out-v1";
// Marks that an account is active for THIS browser session (sessionStorage:
// survives reload, cleared when the tab/window closes). Lets "Keep me signed in"
// off still allow a manual sign-in to survive its own reload, while a fresh
// launch lands on the sign-in screen.
const SESSION_ACTIVE_KEY = "kachat-session-active-v1";
function markSessionActive() { try { sessionStorage.setItem(SESSION_ACTIVE_KEY, "1"); } catch {} }
function clearSessionActive() { try { sessionStorage.removeItem(SESSION_ACTIVE_KEY); } catch {} }
function isSessionActive() { try { return sessionStorage.getItem(SESSION_ACTIVE_KEY) === "1"; } catch { return false; } }

// Per-contact preferences (Chat Info): incoming-notification and photo-display
// overrides, keyed by contact address. { [address]: { notify, photos } }.
const CONTACT_PREFS_KEY = "kachat-contact-prefs-v1";
let contactPrefs = (() => { try { return JSON.parse(localStorage.getItem(CONTACT_PREFS_KEY) || "{}") || {}; } catch { return {}; } })();
function saveContactPrefs() { localStorage.setItem(CONTACT_PREFS_KEY, JSON.stringify(contactPrefs)); }
function getContactNotify(address) { return contactPrefs[address]?.notify || "enabled"; } // "enabled" | "muted"
// "auto" (decide from the global photo-approval setting) | "always" (this contact is trusted,
// always render) | "manual" (never auto-render). Mirrors iOS PhotoAutoDisplayMode
// (.automatic / .alwaysShow / .alwaysHide); older installs only ever stored auto/manual.
function getContactPhotos(address) { return contactPrefs[address]?.photos || "auto"; }
function setContactPref(address, key, value) {
  if (!address) return;
  contactPrefs[address] = { ...(contactPrefs[address] || {}), [key]: value };
  saveContactPrefs();
}

// Per-group preferences (Group Info), keyed by group id: { [groupId]: { notify } }.
// Same shape and storage style as contactPrefs above — one global key holding an object
// keyed by a globally unique identity (contact address there, group id here), so no extra
// account scoping is needed: a group id belongs to exactly one group.
const GROUP_PREFS_KEY = "kachat-group-prefs-v1";
let groupPrefs = (() => { try { return JSON.parse(localStorage.getItem(GROUP_PREFS_KEY) || "{}") || {}; } catch { return {}; } })();
function saveGroupPrefs() { try { localStorage.setItem(GROUP_PREFS_KEY, JSON.stringify(groupPrefs)); } catch {} }
// "all" | "mentions" | "muted". Default "all", matching iOS, where a group's
// "Only Notify if I'm Mentioned" toggle starts OFF (GroupChatService.mentionsOnlyNotifications).
const GROUP_NOTIFY_MODES = ["all", "mentions", "muted"];
function getGroupNotify(groupId) {
  const value = groupPrefs[groupId]?.notify;
  return GROUP_NOTIFY_MODES.includes(value) ? value : "all";
}
function setGroupNotify(groupId, value) {
  if (!groupId || !GROUP_NOTIFY_MODES.includes(value)) return;
  groupPrefs[groupId] = { ...(groupPrefs[groupId] || {}), notify: value };
  saveGroupPrefs();
}

// Photos revealed this session when a photo bubble is held back (per-contact "manual",
// or the global approval gate for a contact you have not accepted yet).
const revealedPhotoIds = new Set();
const BALANCE_REFRESH_MS = 15000;
const MESSAGE_REFRESH_MS = 5000;
const INDEXER_URL_KEY = "kachat-shell-step27-indexer-url";
const PERSISTED_WALLET_KEY = "kachat-shell-testing-wallet-v2";
const LEGACY_PERSISTED_WALLET_KEY = "kachat-shell-testing-wallet-private-key";
const HANDSHAKE_SYNC_KEY = "kachat-shell-handshake-sync-v1";
const LEGACY_STORAGE_KEYS = [
  "kachat-shell-step24-state",
  "kachat-shell-step23-state",
  "kachat-shell-step22-state",
  "kachat-shell-step21-state",
  "kachat-shell-step20-state",
  "kachat-shell-step19-state",
  "kachat-shell-step18-state",
  "kachat-shell-step17-state",
  "kachat-shell-step16-state",
  "kachat-shell-step15-state",
  "kachat-shell-step14-state",
  "kachat-shell-step13-state",
  "kachat-shell-step12-state",
  "kachat-shell-step11-state",
  "kachat-shell-step10-conversations",
  "kachat-shell-step9-conversations",
  "kachat-shell-step7-contacts",
];

function accountScopedKey(baseKey, address = engine.address) {
  const clean = String(address || "").trim();
  return clean ? `${ACCOUNT_DATA_PREFIX}:${clean}:${baseKey}` : baseKey;
}

// ---------------------------------------------------------------------------
// Chat state persists in IndexedDB (ui/storage.js): localStorage's ~5MB quota
// cannot hold a large phone-backup import, IndexedDB's device-proportional
// quota can. The top-level await below warms storage.js's synchronous cache
// BEFORE any state read in this module — including the first render at the
// bottom of the file — so every existing restore path (loadStoredState,
// buildFullyRestoredState, reloadStateFromBrowserStorage, account switches via
// activateWalletDataScope, backup imports) stays synchronous and reads the
// already-loaded data. On the first run after this update, chat-state keys
// still in localStorage (all accounts) are migrated into IndexedDB and deleted
// from localStorage, freeing the quota; every OTHER localStorage key
// (settings, dock prefs, caches, nextcloud, portfolio…) stays where it is.
// If IndexedDB is unavailable (e.g. private browsing), storage.js passes
// through to localStorage and the legacy quota-aware persistState() fallback
// below still applies.
// ---------------------------------------------------------------------------
const CHAT_STORAGE_BASE_KEYS = [STORAGE_KEY, STATE_BACKUP_KEY, MESSAGE_HISTORY_KEY];
function isChatStorageKey(key) {
  return CHAT_STORAGE_BASE_KEYS.some(
    (base) => key === base || (key.startsWith(`${ACCOUNT_DATA_PREFIX}:`) && key.endsWith(`:${base}`)),
  );
}
await initChatStorage({
  shouldMigrateKey: isChatStorageKey,
  log: (line) => { try { appendEngineLog(line); } catch { console.log(line); } },
});
setChatStorageFlushErrorHandler((error) => {
  try { handleChatStorageFlushError(error); } catch (fallbackError) { console.error(fallbackError); }
});

let state = loadStoredState();

function subscriptionContactAddresses() {
  return [...new Set((state.contacts || [])
    .map((contact) => String(contact?.address || "").trim())
    .filter((address) => address.startsWith("kaspa:") && address !== engine.address))];
}

// Own non-chatting addresses the wallet wants live UTXO events for: revealed
// spending-chain addresses, cold-storage watch addresses (Address Activity
// notifications), and reserved-and-offered payment-pool addresses (so incoming
// pool payments are noticed promptly). All helpers are defensive — during early
// module init none of the backing state exists yet.
function ownWatchedActivityAddresses() {
  try {
    const set = new Set(spendingWatchedAddressList());
    for (const entry of listColdWatchedAddresses()) set.add(entry.address);
    for (const address of paymentPoolOfferedAddresses()) set.add(address);
    set.delete(engine.address || "");
    return [...set];
  } catch { return []; }
}

function refreshSubscriptionAddresses({ restart = true } = {}) {
  const addresses = [...new Set([...subscriptionContactAddresses(), ...ownWatchedActivityAddresses()])];
  return engine.setSubscriptionAddresses?.(addresses, { restart });
}

refreshSubscriptionAddresses({ restart: false });

function loadHandshakeSyncState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HANDSHAKE_SYNC_KEY) || "{}");
    const parserVersion = Number(parsed?.parserVersion || 0);
    return {
      walletAddress: String(parsed?.walletAddress || ""),
      cursor: parserVersion >= 3 ? Number(parsed?.cursor || 0) : 0,
      parserVersion: 3,
      processedTxids: parserVersion >= 3 && Array.isArray(parsed?.processedTxids) ? [...new Set(parsed.processedTxids.map(String))] : [],
      declinedTxids: parserVersion >= 3 && Array.isArray(parsed?.declinedTxids) ? [...new Set(parsed.declinedTxids.map(String))] : [],
    };
  } catch {
    return { walletAddress: "", cursor: 0, parserVersion: 3, processedTxids: [], declinedTxids: [] };
  }
}

let handshakeSyncState = loadHandshakeSyncState();

function persistHandshakeSyncState() {
  localStorage.setItem(HANDSHAKE_SYNC_KEY, JSON.stringify(handshakeSyncState));
}

let activeConversationId = null;
let currentBalanceKas = "--";
let composerMode = "message";
let availableBalanceHideTimer = null;
let paymentSendInFlight = false;
let handshakeSendInFlight = false;
// All messages are now real on-chain Kaspa transactions, unconditionally —
// there is no preview/simulation mode reachable from the UI anymore. This
// used to be a user-facing Settings toggle defaulting to "preview", which
// meant messages never actually reached the network (and thus never showed
// up on a peer's iOS/Android app) unless the toggle was found and flipped.
const transportMode = "onchain";
let pendingOnchainDraft = null;
let balanceRefreshTimer = null;
let messageRefreshTimer = null;
let balanceRefreshInFlight = false;
let messageRefreshInFlight = false;
// True until the first full message sweep after a wallet is loaded, switched, or a
// backup is restored. That first sweep BACKFILLS existing history from the indexer, so
// its messages are not "new" arrivals: we add them silently and read (no notification,
// no unread badge). Later sweeps are live and notify/mark-unread normally.
let pendingInitialCatchUp = true;
let walletActivityRefreshTimer = null;
let activeMessageActionId = null;
let messageSelectionMode = false;
const selectedMessageIds = new Set();
const ACCOUNT_SHELL_PREFS_KEY = "kachat-account-shell-preferences-v1";
const ACCOUNT_SHELL_META_KEY = "kachat-account-shell-metadata-v1";
const SAVED_ACCOUNTS_KEY = "kachat-saved-accounts-v1";
const ACTIVE_ACCOUNT_KEY = "kachat-active-account-v1";
let accountShellPrefs = loadAccountShellPreferences();
const loggedOutScreen = document.querySelector("[data-logged-out-screen]");
const mainAppShell = document.querySelector("#app");
const savedAccountList = document.querySelector("[data-saved-account-list]");

function loadAccountShellPreferences() {
  try { return JSON.parse(localStorage.getItem(ACCOUNT_SHELL_PREFS_KEY) || "{}"); }
  catch { return {}; }
}

function persistAccountShellPreferences() {
  localStorage.setItem(ACCOUNT_SHELL_PREFS_KEY, JSON.stringify(accountShellPrefs));
}

// --- App password (replaces the mockup "biometrics" toggles). A single password
// is stored as a salted SHA-256 hash, never in plaintext. It gates revealing the
// seed phrase / private key and signing in, when the matching toggle is on. ---
const APP_PASSWORD_KEY = "kachat-app-password-v1";
function loadStoredPassword() {
  try { return JSON.parse(localStorage.getItem(APP_PASSWORD_KEY) || "null"); } catch { return null; }
}
function hasAppPassword() {
  const stored = loadStoredPassword();
  return !!(stored && stored.hash && stored.salt);
}
async function hashPassword(password, saltHex) {
  const data = new TextEncoder().encode(`${saltHex}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function setAppPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = [...saltBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await hashPassword(password, salt);
  localStorage.setItem(APP_PASSWORD_KEY, JSON.stringify({ salt, hash }));
}
async function verifyAppPassword(password) {
  const stored = loadStoredPassword();
  if (!stored) return false;
  return (await hashPassword(password, stored.salt)) === stored.hash;
}

// Promise-based password prompt. mode "verify" asks for the password; mode "set"
// asks for a new password + confirmation. Resolves true on success, false if
// cancelled / dismissed.
const passwordModal = document.querySelector("[data-password-modal]");
const passwordForm = document.querySelector("[data-password-form]");
const passwordInput = document.querySelector("[data-password-input]");
const passwordConfirmInput = document.querySelector("[data-password-confirm]");
const passwordConfirmLabel = document.querySelector("[data-password-confirm-label]");
const passwordTitleEl = document.querySelector("[data-password-title]");
const passwordMessageEl = document.querySelector("[data-password-message]");
const passwordErrorEl = document.querySelector("[data-password-error]");
let passwordResolver = null;
let passwordMode = "verify";

function showPasswordError(message) {
  if (passwordErrorEl) { passwordErrorEl.textContent = message; passwordErrorEl.hidden = false; }
}
function closePasswordModal(result) {
  if (passwordModal) passwordModal.hidden = true;
  if (passwordInput) passwordInput.value = "";
  if (passwordConfirmInput) passwordConfirmInput.value = "";
  const resolve = passwordResolver;
  passwordResolver = null;
  if (resolve) resolve(result);
}
function requestPassword({ mode = "verify", title, message } = {}) {
  return new Promise((resolve) => {
    if (passwordResolver) { const prev = passwordResolver; passwordResolver = null; prev(false); }
    passwordMode = mode;
    passwordResolver = resolve;
    if (passwordTitleEl) passwordTitleEl.textContent = title || (mode === "set" ? "Set Password" : "Enter Password");
    if (passwordMessageEl) { passwordMessageEl.textContent = message || ""; passwordMessageEl.hidden = !message; }
    if (passwordConfirmLabel) passwordConfirmLabel.hidden = mode !== "set";
    if (passwordErrorEl) passwordErrorEl.hidden = true;
    if (passwordInput) passwordInput.value = "";
    if (passwordConfirmInput) passwordConfirmInput.value = "";
    if (passwordModal) passwordModal.hidden = false;
    queueMicrotask(() => passwordInput?.focus());
  });
}
passwordForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pw = String(passwordInput?.value || "");
  if (passwordErrorEl) passwordErrorEl.hidden = true;
  if (passwordMode === "set") {
    if (pw.length < 4) { showPasswordError("Use at least 4 characters."); return; }
    if (pw !== String(passwordConfirmInput?.value || "")) { showPasswordError("Passwords do not match."); return; }
    await setAppPassword(pw);
    closePasswordModal(true);
  } else {
    if (!(await verifyAppPassword(pw))) { showPasswordError("Incorrect password."); return; }
    closePasswordModal(true);
  }
});
document.querySelectorAll("[data-password-cancel]").forEach((b) => b.addEventListener("click", () => closePasswordModal(false)));
passwordModal?.addEventListener("click", (event) => { if (event.target === passwordModal) closePasswordModal(false); });

// Ensures a password exists (prompting to create one if not). Returns true if a
// password is available afterward.
async function ensureAppPassword(message) {
  if (hasAppPassword()) return true;
  return requestPassword({ mode: "set", title: "Set Password", message: message || "Create a password to protect this." });
}

const passwordStatusEl = document.querySelector("[data-password-status]");
function refreshPasswordStatus() {
  if (passwordStatusEl) passwordStatusEl.textContent = hasAppPassword() ? "Password set" : "No password set";
}
function initSecurityToggle(toggle, key) {
  if (!toggle) return;
  toggle.checked = !!accountShellPrefs[key];
  toggle.addEventListener("change", async () => {
    if (toggle.checked) {
      if (!(await ensureAppPassword())) { toggle.checked = false; return; }
      accountShellPrefs[key] = true;
    } else {
      // Require the password to turn a protection off, so it can't be trivially bypassed.
      if (hasAppPassword() && !(await requestPassword({ mode: "verify", title: "Confirm Password", message: "Enter your password to turn this off." }))) {
        toggle.checked = true;
        return;
      }
      accountShellPrefs[key] = false;
    }
    persistAccountShellPreferences();
    refreshPasswordStatus();
  });
}
initSecurityToggle(document.querySelector("[data-pref-password-seed]"), "passwordForSeed");
initSecurityToggle(document.querySelector("[data-pref-password-login]"), "passwordForLogin");
refreshPasswordStatus();
document.querySelector("[data-change-password]")?.addEventListener("click", async () => {
  if (hasAppPassword() && !(await requestPassword({ mode: "verify", title: "Current Password", message: "Enter your current password." }))) return;
  if (await requestPassword({ mode: "set", title: "New Password", message: "Create a new password." })) {
    showCopyToast("Password updated");
    refreshPasswordStatus();
  }
});

// Block explorer used for "view transaction / address" links, matching the URL
// schemes in iOS's KaspaExplorer enum and Android's KaspaExplorer.kt. The user
// picks one in Settings > Kaspa Explorer; the choice persists in shell prefs.
const KASPA_EXPLORERS = {
  kaspaStream: { displayName: "kaspa.stream", tx: "https://kaspa.stream/transactions/", address: "https://kaspa.stream/addresses/" },
  kaspaOrg: { displayName: "explorer.kaspa.org", tx: "https://explorer.kaspa.org/txs/", address: "https://explorer.kaspa.org/addresses/" },
};
const DEFAULT_KASPA_EXPLORER = "kaspaOrg";

function currentExplorer() {
  return KASPA_EXPLORERS[accountShellPrefs.explorer] || KASPA_EXPLORERS[DEFAULT_KASPA_EXPLORER];
}
function explorerTxUrl(txid) { return currentExplorer().tx + txid; }
function explorerAddressUrl(address) { return currentExplorer().address + address; }

function activeAccountMetadata() {
  const address = String(engine.address || "");
  if (!address) return { name: "No Active Account", createdAt: null };
  let all = {};
  try { all = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  if (!all[address]) {
    all[address] = { name: `Account ${address.slice(-6)}`, createdAt: Date.now() };
    localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(all));
  }
  return all[address];
}

function loadSavedAccounts() {
  let accounts = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || "[]");
    if (Array.isArray(parsed)) accounts = parsed;
  } catch {}

  // Migrate the pre-Step-70 single saved wallet into the account registry.
  try {
    const raw = localStorage.getItem(PERSISTED_WALLET_KEY);
    const wallet = raw ? JSON.parse(raw) : null;
    const address = String(wallet?.address || "").trim();
    const privateKeyHex = String(wallet?.privateKeyHex || "").trim();
    if (address && privateKeyHex && !accounts.some((entry) => entry.address === address)) {
      let metadata = {};
      try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
      const meta = metadata[address] || {};
      accounts.push({
        version: 1,
        address,
        privateKeyHex,
        mnemonic: String(wallet?.mnemonic || ""),
        passphrase: String(wallet?.passphrase || ""),
        derivationPath: String(wallet?.derivationPath || ""),
        wordCount: Number(wallet?.wordCount || 0),
        name: meta.name || `Account ${address.slice(-6)}`,
        createdAt: meta.createdAt || wallet.savedAt || new Date().toISOString(),
        savedAt: wallet.savedAt || new Date().toISOString(),
      });
      localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(accounts));
      if (!localStorage.getItem(ACTIVE_ACCOUNT_KEY)) localStorage.setItem(ACTIVE_ACCOUNT_KEY, address);
    }
  } catch (error) {
    appendEngineLog?.(`Saved-account migration failed: ${error.message}`);
  }
  return accounts;
}

function persistSavedAccounts(accounts) {
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(accounts));
}

function upsertSavedAccount({ address, privateKeyHex, mnemonic = "", passphrase = "", derivationPath = "", wordCount = 0, sourceFamily = "", chattingIndex = null, name, createdAt, savedAt = new Date().toISOString() }) {
  const cleanAddress = String(address || "").trim();
  const cleanKey = String(privateKeyHex || "").trim();
  if (!cleanAddress || !cleanKey) throw new Error("Account address or private key is missing.");
  const accounts = loadSavedAccounts();
  const index = accounts.findIndex((entry) => entry.address === cleanAddress);
  const existing = index >= 0 ? accounts[index] : null;
  const record = {
    version: 1,
    address: cleanAddress,
    privateKeyHex: cleanKey,
    mnemonic: String(mnemonic || existing?.mnemonic || ""),
    // BIP39 passphrase ("25th word"). Needed to re-derive spending addresses that
    // match iOS/Android. Persisted alongside the (already-plaintext) mnemonic; iOS
    // stores both together too (Secure-Enclave-wrapped). "" means no passphrase.
    passphrase: String(passphrase || existing?.passphrase || ""),
    derivationPath: String(derivationPath || existing?.derivationPath || ""),
    wordCount: Number(wordCount || existing?.wordCount || 0),
    // Identity derivation family (import source-wallet chooser) + the chosen
    // chatting-address index within it. Honored on any re-derivation.
    sourceFamily: String(sourceFamily || existing?.sourceFamily || "kaspaStandard"),
    chattingIndex: Number.isInteger(chattingIndex) ? chattingIndex : Number(existing?.chattingIndex || 0),
    name: String(name || existing?.name || `Account ${cleanAddress.slice(-6)}`),
    createdAt: createdAt || existing?.createdAt || new Date().toISOString(),
    savedAt,
  };
  if (index >= 0) accounts[index] = record;
  else accounts.push(record);
  persistSavedAccounts(accounts);
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, cleanAddress);
  return record;
}

function savedAccountSummaries() {
  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  return loadSavedAccounts().map((entry) => ({
    ...entry,
    name: metadata[entry.address]?.name || entry.name || `Account ${entry.address.slice(-6)}`,
    createdAt: metadata[entry.address]?.createdAt || entry.createdAt || entry.savedAt || null,
  }));
}

function activateSavedAccount(address) {
  const account = loadSavedAccounts().find((entry) => entry.address === address);
  if (!account) throw new Error("Saved account was not found.");
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.address);
  localStorage.setItem(PERSISTED_WALLET_KEY, JSON.stringify({
    version: 2,
    privateKeyHex: account.privateKeyHex,
    mnemonic: String(account.mnemonic || ""),
    passphrase: String(account.passphrase || ""),
    derivationPath: String(account.derivationPath || ""),
    wordCount: Number(account.wordCount || 0),
    sourceFamily: String(account.sourceFamily || "kaspaStandard"),
    chattingIndex: Number(account.chattingIndex || 0),
    address: account.address,
    savedAt: account.savedAt || new Date().toISOString(),
  }));
  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
  markSessionActive(); // survives the sign-in reload even if "Keep me signed in" is off
}

let pendingSavedAccountRemoval = null;

function renderSavedAccountsScreen() {
  if (!savedAccountList) return;
  savedAccountList.replaceChildren();
  const accounts = savedAccountSummaries();
  if (!accounts.length) {
    const empty = document.createElement("div");
    empty.className = "saved-account-empty";
    empty.textContent = "Create or import an account to continue.";
    savedAccountList.append(empty);
    return;
  }
  for (const account of accounts) {
    const row = document.createElement("div");
    row.className = "saved-account-card";
    row.dataset.savedAccountAddress = account.address;

    const signInButton = document.createElement("button");
    signInButton.type = "button";
    signInButton.className = "saved-account-signin";
    signInButton.setAttribute("aria-label", `Sign in to ${account.name}`);
    signInButton.innerHTML = `<span class="saved-account-icon" aria-hidden="true">✓</span><span class="saved-account-copy"><strong></strong><small></small></span><span class="saved-account-chevron" aria-hidden="true">›</span>`;
    signInButton.querySelector("strong").textContent = account.name;
    signInButton.querySelector("small").textContent = shortAddress(account.address);
    signInButton.addEventListener("click", async () => {
      try {
        if (accountShellPrefs.passwordForLogin && hasAppPassword()) {
          const ok = await requestPassword({ mode: "verify", title: "Enter Password", message: "Enter your password to sign in." });
          if (!ok) return;
        }
        activateSavedAccount(account.address);
        location.reload();
      } catch (error) {
        showCopyToast(error.message);
      }
    });

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "saved-account-edit";
    editButton.setAttribute("aria-label", `Edit ${account.name}`);
    editButton.setAttribute("aria-haspopup", "menu");
    editButton.setAttribute("aria-expanded", "false");
    editButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
    editButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleAccountActionMenu(editButton, account);
    });

    row.append(signInButton, editButton);
    savedAccountList.append(row);
  }
}

const accountActionMenu = document.querySelector("[data-account-action-menu]");
let accountActionMenuTarget = null;

function closeAccountActionMenu() {
  if (!accountActionMenu || accountActionMenu.hidden) return;
  accountActionMenu.hidden = true;
  accountActionMenuTarget?.button?.setAttribute("aria-expanded", "false");
  accountActionMenuTarget = null;
}

function toggleAccountActionMenu(button, account) {
  if (!accountActionMenu) return;
  const reopeningSame = accountActionMenuTarget?.button === button;
  closeAccountActionMenu();
  if (reopeningSame) return;

  const rect = button.getBoundingClientRect();
  const menuWidth = accountActionMenu.offsetWidth || 168;
  const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
  accountActionMenu.style.top = `${rect.bottom + 6}px`;
  accountActionMenu.style.left = `${left}px`;
  accountActionMenu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  accountActionMenuTarget = { button, account };
}

accountActionMenu?.addEventListener("click", (event) => {
  event.stopPropagation();
  const actionButton = event.target.closest("[data-menu-action]");
  if (!actionButton || !accountActionMenuTarget) return;
  const { account } = accountActionMenuTarget;
  const action = actionButton.dataset.menuAction;
  closeAccountActionMenu();
  if (action === "rename") openSavedAccountRename(account);
  else if (action === "delete") openSavedAccountDelete(account);
});

document.addEventListener("click", () => closeAccountActionMenu());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAccountActionMenu();
});
window.addEventListener("resize", () => closeAccountActionMenu());
window.addEventListener("scroll", () => closeAccountActionMenu(), true);

function showLoggedOutScreen() {
  if (mainAppShell) mainAppShell.hidden = true;
  if (loggedOutScreen) loggedOutScreen.hidden = false;
  document.body.classList.add("session-logged-out");
  try {
    renderSavedAccountsScreen();
  } catch (error) {
    console.error("Saved-account screen render failed", error);
    if (savedAccountList) {
      savedAccountList.replaceChildren();
      const fallback = document.createElement("div");
      fallback.className = "saved-account-empty";
      fallback.textContent = "Saved accounts could not be displayed. Refresh and try again.";
      savedAccountList.append(fallback);
    }
  }
}

function hideLoggedOutScreen() {
  if (loggedOutScreen) loggedOutScreen.hidden = true;
  if (mainAppShell) mainAppShell.hidden = false;
  document.body.classList.remove("session-logged-out");
}

const accountDeleteModal = document.querySelector("[data-account-delete-modal]");
const accountDeleteCopy = document.querySelector("[data-account-delete-copy]");

function openSavedAccountDelete(account) {
  pendingSavedAccountRemoval = account;
  if (accountDeleteCopy) {
    accountDeleteCopy.textContent = `This removes ${account.name} (${shortAddress(account.address)}) and its local data from this device. Make sure you have backed up the private key or recovery phrase.`;
  }
  if (accountDeleteModal) accountDeleteModal.hidden = false;
}

function closeSavedAccountDelete() {
  pendingSavedAccountRemoval = null;
  if (accountDeleteModal) accountDeleteModal.hidden = true;
}

function removeAccountScopedLocalData(address) {
  const cleanAddress = String(address || "").trim();
  if (!cleanAddress) return;
  const prefix = `${ACCOUNT_DATA_PREFIX}:${cleanAddress}:`;
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) localStorage.removeItem(key);
  }

  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  delete metadata[cleanAddress];
  if (Object.keys(metadata).length) localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));
  else localStorage.removeItem(ACCOUNT_SHELL_META_KEY);

  try {
    const persisted = JSON.parse(localStorage.getItem(PERSISTED_WALLET_KEY) || "null");
    if (persisted?.address === cleanAddress) localStorage.removeItem(PERSISTED_WALLET_KEY);
  } catch {}

  try {
    const handshakeState = JSON.parse(localStorage.getItem(HANDSHAKE_SYNC_KEY) || "null");
    if (handshakeState?.walletAddress === cleanAddress) localStorage.removeItem(HANDSHAKE_SYNC_KEY);
  } catch {}

  if (localStorage.getItem(ACTIVE_ACCOUNT_KEY) === cleanAddress) {
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  }
}

function removeSavedAccountFromDevice(account) {
  const address = String(account?.address || "").trim();
  if (!address) throw new Error("Saved account address is missing.");
  const remaining = loadSavedAccounts().filter((entry) => entry.address !== address);
  persistSavedAccounts(remaining);
  removeAccountScopedLocalData(address);
  renderSavedAccountsScreen();
  showCopyToast("Saved account removed");
}

document.querySelector("[data-confirm-account-delete]")?.addEventListener("click", () => {
  const account = pendingSavedAccountRemoval;
  if (!account) return closeSavedAccountDelete();
  try {
    removeSavedAccountFromDevice(account);
    closeSavedAccountDelete();
  } catch (error) {
    appendEngineLog(`Saved-account removal failed: ${error.message}`);
    showCopyToast(error.message);
  }
});

document.querySelector("[data-cancel-account-delete]")?.addEventListener("click", closeSavedAccountDelete);
accountDeleteModal?.addEventListener("click", (event) => {
  if (event.target === accountDeleteModal) closeSavedAccountDelete();
});

let pendingSavedAccountRename = null;
const accountRenameModal = document.querySelector("[data-account-rename-modal]");
const accountRenameForm = document.querySelector("[data-account-rename-form]");
const accountRenameError = document.querySelector("[data-account-rename-error]");

function openSavedAccountRename(account) {
  pendingSavedAccountRename = account;
  if (accountRenameError) { accountRenameError.hidden = true; accountRenameError.textContent = ""; }
  if (accountRenameForm?.elements?.accountName) {
    accountRenameForm.elements.accountName.value = account.name;
  }
  if (accountRenameModal) accountRenameModal.hidden = false;
  queueMicrotask(() => accountRenameForm?.elements?.accountName?.select());
}

function closeSavedAccountRename() {
  pendingSavedAccountRename = null;
  if (accountRenameModal) accountRenameModal.hidden = true;
}

function renameSavedAccount(address, newName) {
  const cleanAddress = String(address || "").trim();
  const cleanName = String(newName || "").trim();
  if (!cleanAddress) throw new Error("Saved account address is missing.");
  if (!cleanName) throw new Error("Enter an account name.");

  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[cleanAddress] = { ...(metadata[cleanAddress] || {}), name: cleanName };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  const accounts = loadSavedAccounts();
  const index = accounts.findIndex((entry) => entry.address === cleanAddress);
  if (index >= 0) {
    accounts[index] = { ...accounts[index], name: cleanName };
    persistSavedAccounts(accounts);
  }

  if (engine.address === cleanAddress) updateWalletUi();
}

accountRenameForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const account = pendingSavedAccountRename;
  if (!account) return closeSavedAccountRename();
  const name = String(accountRenameForm.elements.accountName?.value || "").trim();
  if (!name) {
    if (accountRenameError) { accountRenameError.textContent = "Enter an account name."; accountRenameError.hidden = false; }
    return;
  }
  try {
    renameSavedAccount(account.address, name);
    closeSavedAccountRename();
    renderSavedAccountsScreen();
    showCopyToast("Account name saved");
  } catch (error) {
    if (accountRenameError) { accountRenameError.textContent = error.message; accountRenameError.hidden = false; }
  }
});

document.querySelector("[data-close-account-rename]")?.addEventListener("click", closeSavedAccountRename);
accountRenameModal?.addEventListener("click", (event) => {
  if (event.target === accountRenameModal) closeSavedAccountRename();
});

// --- Rename UTXO modal (Manage Address > UTXOs). Blank name clears the label. ---
let pendingUtxoRename = null;
const utxoRenameModal = document.querySelector("[data-utxo-rename-modal]");
const utxoRenameForm = document.querySelector("[data-utxo-rename-form]");
const utxoRenameOutpoint = document.querySelector("[data-utxo-rename-outpoint]");

function openUtxoRename(address, outpointKey, currentLabel) {
  pendingUtxoRename = { address, outpointKey };
  if (utxoRenameForm?.elements?.utxoName) utxoRenameForm.elements.utxoName.value = currentLabel || "";
  if (utxoRenameOutpoint) utxoRenameOutpoint.textContent = outpointKey;
  if (utxoRenameModal) utxoRenameModal.hidden = false;
  queueMicrotask(() => utxoRenameForm?.elements?.utxoName?.select());
}
function closeUtxoRename() {
  pendingUtxoRename = null;
  if (utxoRenameModal) utxoRenameModal.hidden = true;
}
utxoRenameForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const pending = pendingUtxoRename;
  if (!pending) return closeUtxoRename();
  const name = String(utxoRenameForm.elements.utxoName?.value || "").trim();
  setUtxoLabel(pending.address, pending.outpointKey, name);
  closeUtxoRename();
  renderManageAddressUtxos();
  showCopyToast(name ? "UTXO name saved" : "UTXO name removed");
});
document.querySelectorAll("[data-close-utxo-rename]").forEach((el) => el.addEventListener("click", closeUtxoRename));
utxoRenameModal?.addEventListener("click", (event) => {
  if (event.target === utxoRenameModal) closeUtxoRename();
});

const searchWrap = document.querySelector("[data-search-wrap]");
const serviceHealthButton = document.querySelector("[data-service-health-button]");
const serviceHealthLed = document.querySelector("[data-service-health-led]");
let latestServiceStatusText = "Starting services";
const toolbarBalance = document.querySelector("[data-toolbar-balance]");
const toolbarBalanceValue = document.querySelector("[data-toolbar-balance-value]");
const profileAddress = document.querySelector("[data-profile-address]");
const profileBalance = document.querySelector("[data-profile-balance]");
const profileInitial = document.querySelector("[data-profile-initial]");
const profileKnsEmptyCta = document.querySelector("[data-profile-kns-empty-cta]");
const profileKnsOwned = document.querySelector("[data-profile-kns-owned]");
const profileKnsDomain = document.querySelector("[data-profile-kns-domain]");
const profileKnsBio = document.querySelector("[data-profile-kns-bio]");
const profileKnsLinks = document.querySelector("[data-profile-kns-links]");
const profileQr = document.querySelector("[data-profile-qr]");
const profileQrCard = document.querySelector("[data-profile-qr-card]");
const profileQrOverlay = document.querySelector("[data-profile-qr-overlay]");
const photoPreviewOverlay = document.querySelector("[data-photo-preview-overlay]");
const photoPreviewImage = document.querySelector("[data-photo-preview-image]");

function openPhotoPreview(dataUrl) {
  if (!photoPreviewOverlay || !photoPreviewImage) return;
  photoPreviewImage.src = dataUrl;
  photoPreviewOverlay.hidden = false;
}

photoPreviewOverlay?.addEventListener("click", () => { photoPreviewOverlay.hidden = true; });

// --- Message link previews -----------------------------------------------------
// Linkifies URLs in message text and, for previewable links, appends a media
// card. Nextcloud public shares are privacy-gated: nothing is fetched from the
// sender's server until the recipient taps "view" (the share URL alone doesn't
// say image vs video, so the tap runs a progressive probe — try <video>, fall
// back to <img>, else an "Open in Nextcloud" link).

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/g;

/** `https://host/s/TOKEN` (or `/index.php/s/TOKEN`) -> its raw-file endpoints, else null. */
function nextcloudShareDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(\/index\.php)?\/s\/([A-Za-z0-9_-]{10,})\/?$/);
    if (!match) return null;
    const base = `${parsed.origin}${match[1] || ""}/s/${match[2]}`;
    return { downloadUrl: `${base}/download`, previewUrl: `${base}/preview` };
  } catch { return null; }
}

function isDirectImageUrl(url) {
  return /\.(png|jpe?g|gif|webp|avif)(\?[^#]*)?$/i.test(url);
}

// Any http(s) link is a preview candidate now (matches iOS, which previews the first link of a
// message): direct images and YouTube render CORS-free, Nextcloud stays privacy-gated, and every
// other URL gets an Open-Graph card scraped through the same-origin dev proxy.
function isPreviewableUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

// YouTube video id from watch/youtu.be/shorts/embed URLs, else null.
function youtubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split(/[/?]/)[0] || null;
    if (host === "youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|embed|v|live)\/([^/?]+)/);
      if (m) return m[2];
    }
    return null;
  } catch { return null; }
}

// --- Open-Graph link previews (proxied HTML scrape, cached) ------------------
const linkPreviewCache = new Map();
const linkPreviewFailCounts = new Map(); // url -> failed attempts this session   // url -> {title,description,image,site} | null (resolved)
const linkPreviewPending = new Map(); // url -> Promise, so concurrent renders don't refetch
let linkPreviewRerenderTimer = null;

// Fetch a page through the same-origin /nc-proxy dev middleware (browsers can't read cross-origin
// HTML directly). `x-preview: 1` asks the proxy to use a crawler UA so more sites emit og:image.
async function proxiedFetchHtml(url) {
  let dev = false;
  try { dev = Boolean(import.meta.env.DEV); } catch { dev = false; }
  if (!dev) return null; // no proxy outside the dev server
  const parsed = new URL(url);
  const proxied = `${import.meta.env.BASE_URL}nc-proxy/${encodeURIComponent(parsed.origin)}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  const res = await fetch(proxied, { headers: { Accept: "text/html,application/xhtml+xml", "x-preview": "1" } });
  if (!res.ok) return null;
  const type = res.headers.get("content-type") || "";
  if (!/text\/html|xml/i.test(type)) return null;
  return (await res.text()).slice(0, 400_000); // <head> metadata lives up top; cap the read
}

function metaContent(html, prop) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  return (html.match(a)?.[1] || html.match(b)?.[1] || "").trim();
}

async function fetchOpenGraph(url) {
  const html = await proxiedFetchHtml(url);
  if (!html) return null;
  const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'");
  const title = decode(metaContent(html, "og:title") || metaContent(html, "twitter:title") || (html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] || "").trim());
  const description = decode(metaContent(html, "og:description") || metaContent(html, "twitter:description") || metaContent(html, "description"));
  let image = metaContent(html, "og:image") || metaContent(html, "og:image:url") || metaContent(html, "twitter:image");
  if (image) { try { image = new URL(decode(image), url).href; } catch { image = ""; } }
  let site = decode(metaContent(html, "og:site_name"));
  if (!site) { try { site = new URL(url).hostname.replace(/^www\./, ""); } catch { site = ""; } }
  if (!title && !image) return null;
  return { title, description, image, site };
}

// YouTube: use the oEmbed JSON API for the real video title (matches iOS). oEmbed needs no
// crawler UA and is far more reliable than scraping the consent-walled watch page. The
// thumbnail is derived directly from the video id (CORS-free).
async function fetchYouTubeMeta(url, id) {
  const image = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  let title = "";
  let dev = false;
  try { dev = Boolean(import.meta.env.DEV); } catch { dev = false; }
  if (dev) {
    try {
      const oe = new URL(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      const proxied = `${import.meta.env.BASE_URL}nc-proxy/${encodeURIComponent(oe.origin)}${oe.pathname}${oe.search}`;
      const res = await fetch(proxied, { headers: { Accept: "application/json" } });
      if (res.ok) { const d = await res.json(); title = String(d.title || ""); }
    } catch { /* oEmbed unreachable — keep the thumbnail-only card */ }
  }
  return { title, description: "", image, site: "YouTube" };
}

function resolveLinkPreview(url) {
  if (linkPreviewCache.has(url)) return Promise.resolve(linkPreviewCache.get(url));
  if (linkPreviewPending.has(url)) return linkPreviewPending.get(url);
  const ytId = youtubeVideoId(url);
  const fetcher = ytId ? fetchYouTubeMeta(url, ytId) : fetchOpenGraph(url);
  const p = fetcher.catch(() => null).then((data) => {
    linkPreviewCache.set(url, data || null);
    linkPreviewPending.delete(url);
    // A failed scrape is NOT cached forever: a transient proxy/network hiccup right
    // when a link is SENT would otherwise permanently kill its preview card while
    // the same link received later (fresh fetch) shows one. Expire the negative
    // entry so a later render retries.
    if (!data) {
      const attempts = (linkPreviewFailCounts.get(url) || 0) + 1;
      linkPreviewFailCounts.set(url, attempts);
      // Retry a transient failure a few times, then give up for the session — a permanently
      // dead link used to re-fetch (and rebuild the whole thread) every 30 seconds forever.
      if (attempts < 3) {
        window.setTimeout(() => {
          if (linkPreviewCache.get(url) === null) linkPreviewCache.delete(url);
        }, 30000);
      }
    }
    return data || null;
  });
  linkPreviewPending.set(url, p);
  return p;
}

// Re-render the open thread once a preview resolves (debounced) so the card appears in place.
function scheduleActiveThreadRerender() {
  if (linkPreviewRerenderTimer) return;
  linkPreviewRerenderTimer = window.setTimeout(() => {
    linkPreviewRerenderTimer = null;
    try {
      if (activeGroupId) renderGroupMessages();
      else if (activeConversationId) {
        const ce = state.conversations.find((e) => e.id === activeConversationId);
        if (ce) renderMessages(ce);
      }
    } catch { /* thread closed mid-fetch */ }
  }, 80);
}

// Rich card: thumbnail (optional) + site + title + description, linking out.
function buildRichLinkCard(url, data) {
  const card = document.createElement("a");
  card.className = "message-link-card";
  card.href = url; card.target = "_blank"; card.rel = "noopener noreferrer";
  card.addEventListener("click", (event) => event.stopPropagation());
  if (data.image) {
    const thumb = document.createElement("div");
    thumb.className = "message-link-card-thumb";
    const img = document.createElement("img");
    img.loading = "lazy"; img.alt = "";
    img.addEventListener("error", () => thumb.remove(), { once: true });
    img.src = data.image;
    thumb.append(img);
    if (data.site === "YouTube") { const play = document.createElement("span"); play.className = "message-link-play"; play.textContent = "▶"; thumb.append(play); }
    card.append(thumb);
  }
  const meta = document.createElement("div");
  meta.className = "message-link-card-meta";
  if (data.site) { const s = document.createElement("small"); s.className = "message-link-card-site"; s.textContent = data.site; meta.append(s); }
  const titleEl = document.createElement("strong");
  titleEl.className = "message-link-card-title";
  titleEl.textContent = data.title || data.site || url;
  meta.append(titleEl);
  if (data.description) { const d = document.createElement("span"); d.className = "message-link-card-desc"; d.textContent = data.description; meta.append(d); }
  card.append(meta);
  return card;
}

/** Renders `text` into `container` with URLs as clickable links; returns the URLs found. */
function renderTextWithLinks(container, text) {
  const source = String(text ?? "");
  const urls = [];
  let last = 0;
  for (const match of source.matchAll(URL_IN_TEXT_RE)) {
    let url = match[0];
    const trailing = url.match(/[),.;:!?\]]+$/); // sentence punctuation isn't part of the URL
    if (trailing) url = url.slice(0, -trailing[0].length);
    if (!url) continue;
    if (match.index > last) container.append(source.slice(last, match.index));
    const anchor = document.createElement("a");
    anchor.className = "message-link";
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = url;
    anchor.addEventListener("click", (event) => event.stopPropagation());
    container.append(anchor);
    urls.push(url);
    last = match.index + url.length;
  }
  if (last < source.length) container.append(source.slice(last));
  return urls;
}

// An on-chain @mention token: `@<kaspa address>`, optionally brace-wrapped (legacy desktop form).
// iOS/Android encode without braces, so we accept both for cross-platform interop.
const CHAT_MENTION_TOKEN_RE = /@\{?(kaspa(?:test)?:[a-z0-9]{20,})\}?/gi;

// Display label for a mention: the person's KNS domain when known (what the user asked to see),
// otherwise their contact name / short address. Read from the synchronous KNS cache.
function mentionDisplayLabel(address) {
  const info = engine.peekKnsAddressInfo?.(address);
  const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
  if (domain) return domain; // includes the .kas suffix
  if (address === engine.address) return "You";
  const contact = (state.contacts || []).find((c) => c.address === address);
  if (contact) return displayNameForAddress(contact);
  return shortAddress(address);
}

// Render message text that may contain @mention tokens AND URLs into `container`. Each mention
// becomes a clickable span showing the KNS domain (a delegated handler opens a 1:1 chat with that
// address); non-mention runs fall through to the URL linkifier. Returns the aggregated URL list so
// link-preview cards keep working. Mirrors KaPosts' clickable mentions, but opens a chat, not a profile.
function renderTextWithMentions(container, rawText) {
  const source = String(rawText ?? "");
  CHAT_MENTION_TOKEN_RE.lastIndex = 0;
  const urls = [];
  const warm = [];
  let last = 0;
  for (const match of source.matchAll(CHAT_MENTION_TOKEN_RE)) {
    const address = match[1];
    if (match.index > last) urls.push(...renderTextWithLinks(container, source.slice(last, match.index)));
    const span = document.createElement("span");
    span.className = "chat-mention";
    span.dataset.chatMention = address;
    span.textContent = `@${mentionDisplayLabel(address)}`;
    if (address !== engine.address) {
      span.setAttribute("role", "button");
      span.addEventListener("click", (event) => {
        event.stopPropagation();
        openOrCreateOneToOne(address); // straight to a 1:1 chat with the mentioned person
      });
    }
    container.append(span);
    warm.push(address);
    last = match.index + match[0].length;
  }
  if (last < source.length) urls.push(...renderTextWithLinks(container, source.slice(last)));
  // Warm the KNS cache for any unresolved addresses so the domain fills in on the next render.
  if (warm.length) { try { engine.refreshKnsIfNeeded?.(warm); } catch {} }
  return urls;
}

/** Preview card for the first link in a message, or null. */
function buildLinkPreviewCard(url) {
  const nextcloud = nextcloudShareDownloadUrl(url);
  if (nextcloud) return buildNextcloudRevealCard(url, nextcloud.downloadUrl);
  if (isDirectImageUrl(url)) {
    const img = document.createElement("img");
    img.className = "message-link-image";
    img.loading = "lazy";
    img.alt = "Image preview";
    img.addEventListener("error", () => img.remove(), { once: true });
    img.addEventListener("click", (event) => { event.stopPropagation(); openPhotoPreview(url); });
    img.src = url;
    return img;
  }
  // YouTube: the thumbnail is derivable from the id (no fetch/CORS); enrich the title from the
  // page's og:title in the background if the proxy can reach it.
  const ytId = youtubeVideoId(url);
  if (ytId) {
    const cached = linkPreviewCache.get(url);
    const card = buildRichLinkCard(url, {
      image: `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`,
      site: "YouTube",
      title: cached?.title || "",
      description: cached?.description || "",
    });
    if (!linkPreviewCache.has(url)) resolveLinkPreview(url).then(() => scheduleActiveThreadRerender());
    return card;
  }
  // Any other link: render from cached Open-Graph data, or fetch it and re-render when ready.
  if (linkPreviewCache.has(url)) {
    const data = linkPreviewCache.get(url);
    return (data && (data.image || data.title)) ? buildRichLinkCard(url, data) : null;
  }
  resolveLinkPreview(url).then(() => scheduleActiveThreadRerender());
  return null;
}

function buildNextcloudRevealCard(shareUrl, downloadUrl) {
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "message-photo-hidden message-nextcloud-reveal";
  reveal.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 18.5h-11a4 4 0 0 1-.6-7.96 5.5 5.5 0 0 1 10.7-1.4 4.5 4.5 0 0 1 .9 9.36Z"/></svg><span>Tap to view Nextcloud media</span>';
  reveal.addEventListener("click", (event) => {
    event.stopPropagation();
    probeNextcloudMedia(reveal, shareUrl, downloadUrl);
  });
  return reveal;
}

/** Progressive type probe (cross-origin headers are unreadable without CORS, but media
 *  element `src` loads need none): <video> that reports a finite duration wins; on error
 *  retry as <img>; if both fail, an "Open in Nextcloud" link. */
function probeNextcloudMedia(placeholder, shareUrl, downloadUrl) {
  placeholder.disabled = true;
  const label = placeholder.querySelector("span");
  if (label) label.textContent = "Loading…";
  let settled = false;
  const settle = (el) => {
    if (settled) return;
    settled = true;
    placeholder.replaceWith(el);
  };

  // Probe order: video -> audio (a media element that has duration but no video track is an
  // mp3/m4a) -> image -> attachment card. Office docs and other unrenderable types land on the
  // card, whose link opens Nextcloud's own web viewer — the only thing that can show them.
  const attachmentFallback = () => {
    const card = document.createElement("a");
    card.className = "message-attachment-card";
    card.href = shareUrl;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg><span><strong>File on Nextcloud</strong><small>Open in Nextcloud</small></span>';
    card.addEventListener("click", (event) => event.stopPropagation());
    settle(card);
  };

  const settleAudio = () => {
    if (settled) return;
    const audio = document.createElement("audio");
    audio.className = "message-link-audio";
    audio.controls = true;
    audio.preload = "metadata";
    audio.addEventListener("click", (event) => event.stopPropagation());
    audio.src = downloadUrl;
    settle(audio);
  };

  const tryImage = () => {
    if (settled) return;
    const img = document.createElement("img");
    img.className = "message-link-image";
    img.alt = "Nextcloud media";
    img.addEventListener("load", () => settle(img), { once: true });
    img.addEventListener("error", attachmentFallback, { once: true });
    img.addEventListener("click", (event) => { event.stopPropagation(); openPhotoPreview(downloadUrl); });
    img.src = downloadUrl;
  };

  const video = document.createElement("video");
  video.className = "message-link-video";
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0) settle(video);
    else if (Number.isFinite(video.duration) && video.duration > 0) settleAudio(); // audio-only stream
    else tryImage(); // metadata but no playable track (e.g. the file is an image)
  }, { once: true });
  video.addEventListener("error", tryImage, { once: true });
  video.addEventListener("click", (event) => event.stopPropagation());
  video.src = downloadUrl;
}

// --- Reply-to-message (matches iOS's ChatService.replyingTo/cancelReply) ---

let replyingToMessageId = null;
const replyBanner = document.querySelector("[data-reply-banner]");
const replyBannerPreview = document.querySelector("[data-reply-banner-preview]");

function cancelReply() {
  replyingToMessageId = null;
  if (replyBanner) replyBanner.hidden = true;
}

function startReplyTo(messageId) {
  if (!activeConversationId) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!message) return;
  replyingToMessageId = messageId;
  if (replyBannerPreview) replyBannerPreview.textContent = replyPreviewTextFor(message);
  if (replyBanner) replyBanner.hidden = false;
  composer.elements.message?.focus();
}

document.querySelector("[data-cancel-reply]")?.addEventListener("click", cancelReply);

// Scrolls to and briefly highlights the message a reply-quote points at,
// within the currently open conversation only (matches iOS's
// pendingJumpToTxId scroll-and-highlight behavior).
function jumpToMessageByTxid(txid) {
  if (!txid || !activeConversationId) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const target = conversationEntry?.messages.find((entry) => entry.txid === txid || entry.id === txid);
  if (!target) { showCopyToast("Original message not found."); return; }
  const el = messageArea.querySelector(`[data-message-id="${CSS.escape(target.id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("message-highlight");
  window.setTimeout(() => el.classList.remove("message-highlight"), 1200);
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && photoPreviewOverlay && !photoPreviewOverlay.hidden) photoPreviewOverlay.hidden = true;
});
const profileQrOverlayCanvas = document.querySelector("[data-profile-qr-overlay-canvas]");
const chattingAddressScreen = document.querySelector("[data-chatting-address-screen]");
// The chatting-address screen is REUSED for the spending Receive view, so its copy
// button must copy whatever address is on screen - it used to always copy the chatting
// address, handing users the wrong one from the spending QR.
let chattingAddressScreenAddress = null;
const chattingAddressQr = document.querySelector("[data-chatting-address-qr]");
const chattingAddressValue = document.querySelector("[data-chatting-address-value]");
const chattingAddressBalance = document.querySelector("[data-chatting-address-balance]");
const profileAccountName = document.querySelector("[data-profile-account-name]");
const profileSessionState = document.querySelector("[data-profile-session-state]");
const profileCreated = document.querySelector("[data-profile-created]");
const settingsAccountName = document.querySelector("[data-settings-account-name]");
const settingsAccountAddress = document.querySelector("[data-settings-account-address]");
const accountModalName = null;
const accountModalAddress = null;
const accountModalInitial = null;
const engineLog = document.querySelector("[data-engine-log]");
const privateKeyInput = document.querySelector("[data-private-key-input]");
const messageDetailsModal = document.querySelector("[data-message-details-modal]");
const messageDetailsBody = document.querySelector("[data-message-details-body]");
const messageActionSheet = document.querySelector("[data-message-action-sheet]");
const copyToast = document.querySelector("[data-copy-toast]");
const copyToastText = document.querySelector("[data-copy-toast-text]");
let copyToastTimer = null;
const exportChoiceModal = document.querySelector("[data-export-choice-modal]");
const selectionToolbar = document.querySelector("[data-selection-toolbar]");
const selectionCount = document.querySelector("[data-selection-count]");
const deleteConfirmModal = document.querySelector("[data-delete-confirm-modal]");
const deleteConfirmCopy = document.querySelector("[data-delete-confirm-copy]");
const readinessList = document.querySelector("[data-readiness-list]");
const indexerUrlInput = document.querySelector("[data-indexer-url]");
const testIndexerButton = document.querySelector("[data-test-indexer]");
const onchainConfirmModal = document.querySelector("[data-onchain-confirm-modal]");
const onchainSummary = document.querySelector("[data-onchain-summary]");
const importPayloadModal = document.querySelector("[data-import-payload-modal]");
const importPayloadForm = document.querySelector("[data-import-payload-form]");
const importPayloadInput = document.querySelector("[data-import-payload-input]");
const runtimeStatus = document.querySelector("[data-runtime-status]");
const runtimeIndicator = document.querySelector("[data-runtime-indicator]");
const walletStatus = document.querySelector("[data-wallet-status]");
const walletIndicator = document.querySelector("[data-wallet-indicator]");
const networkStatus = document.querySelector("[data-network-status]");
const standbyStatus = document.querySelector("[data-standby-status]");
const networkBadge = document.querySelector("[data-network-badge]");
const messagingBadge = document.querySelector("[data-messaging-badge]");
const nodePoolStatus = document.querySelector("[data-node-pool-status]");
const lastGoodNodeStatus = document.querySelector("[data-last-good-node]");
const nodePoolHistoryStatus = document.querySelector("[data-node-pool-history]");
const syncServiceStatus = document.querySelector("[data-sync-service-status]");
const subscriptionIndicator = document.querySelector("[data-subscription-indicator]");
const storageStatus = document.querySelector("[data-storage-status]");
const networkIndicator = document.querySelector("[data-network-indicator]");
const standbyIndicator = document.querySelector("[data-standby-indicator]");
const messagingStatus = document.querySelector("[data-messaging-status]");
const messagingIndicator = document.querySelector("[data-messaging-indicator]");

const appBody = document.querySelector("[data-app-body]");
const appSidebar = document.querySelector("[data-app-sidebar]");
const newChatFab = document.querySelector("[data-new-chat-fab]");
const appDetail = document.querySelector("[data-app-detail]");
const detailEmptyState = document.querySelector("[data-detail-empty]");
const emptyState = document.querySelector("[data-empty-state]");
const chatList = document.querySelector("[data-chat-list]");
const groupChatsPlaceholder = document.querySelector("[data-group-chats-placeholder]");
const chatsListTabButtons = document.querySelectorAll("[data-chats-list-tab]");
const chatsTabBadge = document.querySelector("[data-chats-tab-badge]");
const groupsTabBadge = document.querySelector("[data-groups-tab-badge]");
const chatSelectToggle = document.querySelector("[data-chat-select-toggle]");
const chatSelectAll = document.querySelector("[data-chat-select-all]");
const chatSelectionBar = document.querySelector("[data-chat-selection-bar]");
let activeChatsListTab = "chats";
let chatSelectionModeActive = false;
const selectedChatConversationIds = new Set();
// Group-thread multi-select (Group Chats tab) — mirrors selectedChatConversationIds but
// keyed by groupId. Selection mode (chatSelectionModeActive) is shared across both tabs;
// each tab acts on its own set based on the active list tab.
const selectedGroupIds = new Set();
// Group-chat manager state. Declared here (not in the group module at the end of the
// file) because the boot-time renderChats path reaches getGroupManager before the tail
// of the module has evaluated, and a `let` in the tail would be in its temporal dead zone.
let groupManager = null;
let groupManagerForAddress = null;
const conversation = document.querySelector("[data-conversation]");
const conversationName = document.querySelector("[data-conversation-name]");
const conversationAddress = document.querySelector("[data-conversation-address]");
const conversationAvatar = document.querySelector("[data-conversation-avatar]");
const conversationAvatarInitials = document.querySelector("[data-conversation-avatar-initials]");
const conversationAvatarImage = document.querySelector("[data-conversation-avatar-image]");
const conversationBio = document.querySelector("[data-conversation-bio]");

// Shows the contact's KNS primary-domain bio under the name in the open chat.
function updateConversationBio(contact) {
  if (!conversationBio) return;
  const bio = engine.peekKnsAddressProfile?.(contact?.address)?.profile?.bio;
  if (bio) { conversationBio.textContent = bio; conversationBio.hidden = false; }
  else { conversationBio.textContent = ""; conversationBio.hidden = true; }
}

// Shared by the conversation header and (via avatarHtmlFor) the sidebar row
// template: shows the contact's KNS avatarUrl when the profile cache already
// has one, otherwise falls back to initials. Synchronous/cache-only — callers
// that need to react to a KNS fetch landing later re-invoke this themselves.
// Same cache-only avatar logic as updateAvatarElement, but as an HTML string
// for the sidebar row template (which re-renders via innerHTML, not live DOM
// nodes it can update in place).
function avatarHtmlFor(contact, className = "chat-avatar") {
  // A user-assigned photo wins over the live KNS avatar, which wins over initials.
  if (contact?.photo) return `<span class="${className}"><img src="${escapeHtml(contact.photo)}" alt="" /></span>`;
  const avatarUrl = engine.peekKnsAddressProfile?.(contact.address)?.profile?.avatarUrl;
  if (avatarUrl) return `<span class="${className}"><img src="${escapeHtml(avatarUrl)}" alt="" /></span>`;
  return `<span class="${className}">${escapeHtml(initialsFor(contact.name))}</span>`;
}

// Same idea as avatarHtmlFor, but for the active wallet's own messages —
// shows your own KNS avatar if you've set one, otherwise your account name's
// initials. There's always something to show, even with no KNS profile at all.
function selfAvatarHtml(className = "chat-avatar") {
  if (!engine.address) return `<span class="${className}">?</span>`;
  const avatarUrl = engine.peekKnsAddressProfile?.(engine.address)?.profile?.avatarUrl;
  if (avatarUrl) return `<span class="${className}"><img src="${escapeHtml(avatarUrl)}" alt="" /></span>`;
  const name = activeAccountMetadata()?.name || shortAddress(engine.address);
  return `<span class="${className}">${escapeHtml(initialsFor(name))}</span>`;
}

function updateAvatarElement(initialsEl, imageEl, contact) {
  if (initialsEl) initialsEl.textContent = initialsFor(contact.name);
  if (!imageEl) return;
  // User-assigned photo takes priority over the live KNS avatar.
  const src = contact?.photo || engine.peekKnsAddressProfile?.(contact.address)?.profile?.avatarUrl;
  if (src) {
    imageEl.src = src;
    imageEl.hidden = false;
  } else {
    imageEl.hidden = true;
    imageEl.src = "";
  }
}
const chatInfoOverlay = document.querySelector("[data-chat-info-overlay]");
const chatInfoAvatar = document.querySelector("[data-chat-info-avatar]");
const chatInfoPhotoPick = document.querySelector("[data-chat-info-photo-pick]");
const chatInfoPhotoInput = document.querySelector("[data-chat-info-photo-input]");
const chatInfoRemovePhoto = document.querySelector("[data-chat-info-remove-photo]");
const chatInfoAvatarInitials = document.querySelector("[data-chat-info-avatar-initials]");
const chatInfoAvatarImage = document.querySelector("[data-chat-info-avatar-image]");
const chatInfoNameInput = document.querySelector("[data-chat-info-name-input]");
const chatInfoAddressCaption = document.querySelector("[data-chat-info-address-caption]");
const chatInfoQr = document.querySelector("[data-chat-info-qr]");
const chatInfoAddressMono = document.querySelector("[data-chat-info-address-mono]");
const chatInfoAdded = document.querySelector("[data-chat-info-added]");
const chatInfoLastMessage = document.querySelector("[data-chat-info-last-message]");
const chatInfoChessRow = document.querySelector("[data-chat-info-chess-row]");
const chatInfoChess = document.querySelector("[data-chat-info-chess]");
const chatInfoSent = document.querySelector("[data-chat-info-sent]");
const chatInfoReceived = document.querySelector("[data-chat-info-received]");
const chatInfoTotal = document.querySelector("[data-chat-info-total]");
const chatInfoProfileSection = document.querySelector("[data-chat-info-profile-section]");
const chatInfoBio = document.querySelector("[data-chat-info-bio]");
const chatInfoSocialLinks = document.querySelector("[data-chat-info-social-links]");
let chatInfoRequestToken = 0;
let chatInfoContactId = null;
let chatInfoContactAddress = null;
const chatInfoNotifyToggle = document.querySelector("[data-chat-info-notify]");
const chatInfoPhotosToggle = document.querySelector("[data-chat-info-photos]");

// --- Chat Info "Aliases" block: this conversation's deterministic pair aliases
// (ECDH + HKDF, 12 hex chars, engine/kasia-cipher.js). Direction semantics are
// verified against the sync pipeline: myAlias = RECEIVING (the alias messages
// FROM this contact carry — engine/sync.js queries by-sender with it),
// theirAlias = SENDING (the alias OUR messages to them carry —
// createEncryptedMessageEnvelope tags with it). Hidden behind dots until the
// eye is clicked; keys are only touched on demand. Clicking a revealed value
// copies it. Matches iOS ChatInfoView's Aliases section.
const ALIAS_HIDDEN_DOTS = "••••••••••••";
const chatInfoAliasReceiving = document.querySelector("[data-chat-info-alias-receiving]");
const chatInfoAliasSending = document.querySelector("[data-chat-info-alias-sending]");
const chatInfoAliasReceivingEye = document.querySelector("[data-chat-info-alias-receiving-eye]");
const chatInfoAliasSendingEye = document.querySelector("[data-chat-info-alias-sending-eye]");
let chatInfoRevealedAliases = null;

function resetChatInfoAliases() {
  chatInfoRevealedAliases = null;
  if (chatInfoAliasReceiving) { chatInfoAliasReceiving.textContent = ALIAS_HIDDEN_DOTS; chatInfoAliasReceiving.classList.remove("revealed"); }
  if (chatInfoAliasSending) { chatInfoAliasSending.textContent = ALIAS_HIDDEN_DOTS; chatInfoAliasSending.classList.remove("revealed"); }
}

async function revealChatInfoAlias(which) {
  if (!chatInfoContactAddress) return;
  try {
    if (!chatInfoRevealedAliases) {
      chatInfoRevealedAliases = await engine.deriveConversationAliases(chatInfoContactAddress);
    }
  } catch (error) {
    showCopyToast(`Could not derive aliases: ${error.message}`);
    return;
  }
  const el = which === "receiving" ? chatInfoAliasReceiving : chatInfoAliasSending;
  const value = which === "receiving" ? chatInfoRevealedAliases.myAlias : chatInfoRevealedAliases.theirAlias;
  if (el && value) { el.textContent = value; el.classList.add("revealed"); }
}

chatInfoAliasReceivingEye?.addEventListener("click", () => revealChatInfoAlias("receiving"));
chatInfoAliasSendingEye?.addEventListener("click", () => revealChatInfoAlias("sending"));
chatInfoAliasReceiving?.addEventListener("click", async () => {
  if (!chatInfoAliasReceiving.classList.contains("revealed")) { revealChatInfoAlias("receiving"); return; }
  try { await copyTextToClipboard(chatInfoAliasReceiving.textContent); showCopyToast("Receiving alias copied."); } catch {}
});
chatInfoAliasSending?.addEventListener("click", async () => {
  if (!chatInfoAliasSending.classList.contains("revealed")) { revealChatInfoAlias("sending"); return; }
  try { await copyTextToClipboard(chatInfoAliasSending.textContent); showCopyToast("Sending alias copied."); } catch {}
});

function refreshChatInfoContactControls() {
  if (chatInfoNotifyToggle) chatInfoNotifyToggle.checked = getContactNotify(chatInfoContactAddress) !== "muted";
  // Shows the EFFECTIVE state: a contact left on "auto" reads as off while the global
  // photo-approval setting is holding their photos back, so the toggle never claims photos
  // are showing when they are not.
  if (chatInfoPhotosToggle) {
    const contact = (state.contacts || []).find((entry) => entry.address === chatInfoContactAddress);
    chatInfoPhotosToggle.checked = shouldAutoDisplayPhotosFrom(contact || { address: chatInfoContactAddress });
  }
}
chatInfoNotifyToggle?.addEventListener("change", async () => {
  if (!chatInfoContactAddress) return;
  setContactPref(chatInfoContactAddress, "notify", chatInfoNotifyToggle.checked ? "enabled" : "muted");
  if (chatInfoNotifyToggle.checked) {
    const granted = await ensureNotificationPermission();
    if (!granted) showCopyToast("Allow notifications in your browser to receive them.");
  }
});
chatInfoPhotosToggle?.addEventListener("change", () => {
  if (!chatInfoContactAddress) return;
  // Turning it ON is an explicit "I trust this contact's photos" ("always"), which also
  // overrides the global approval gate for them — the same role iOS's .alwaysShow override
  // plays. Turning it OFF is "never auto-render" ("manual"), as before.
  setContactPref(chatInfoContactAddress, "photos", chatInfoPhotosToggle.checked ? "always" : "manual");
  const conv = state.conversations.find((entry) => entry.id === activeConversationId);
  if (conv && contactForConversation(conv)?.address === chatInfoContactAddress) renderMessages(conv);
});
// Best-effort permission request at load (browsers that require a gesture will
// no-op; the Chat Info toggle also requests it on demand).
ensureNotificationPermission();

// Browser notifications for incoming messages. Best-effort: requests permission on
// a user gesture; fires only when the message's chat isn't the focused active one.
/// Ask for browser notification permission once per account load, when a notification feature is
/// switched on and the browser has not been asked yet.
///
/// Both notification prefs default to ON, and permission was only ever requested when a toggle was
/// FLIPPED - so a reader who leaves the defaults alone was never asked at all. The feature then
/// looks broken rather than off: `postDesktopNotification` falls back to an in-app toast, which
/// on a window you are not looking at is the same as nothing. That is the shape of "desktop does
/// not notify me when cold storage receives Kaspa".
///
/// `default` only. A reader who has already said no is not asked again.
function requestNotificationPermissionIfNeeded() {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  const wantsNotifications = (accountShellPrefs.chatNotifications ?? true) !== false
    || (accountShellPrefs.addressActivityNotifications ?? true) !== false;
  if (!wantsNotifications) return;
  ensureNotificationPermission().catch(() => { /* asking is best-effort */ });
}

async function ensureNotificationPermission() {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try { return (await Notification.requestPermission()) === "granted"; } catch { return false; }
}
function maybeNotifyIncoming(conversationEntry, contact, message) {
  if (!message || message.direction !== "incoming") return;
  // Settings > Notifications > Chats master toggle (default ON).
  if ((accountShellPrefs.chatNotifications ?? true) === false) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (getContactNotify(contact?.address) === "muted") return;
  if (parseReactionEnvelope(message.text)) return; // reactions aren't standalone messages
  if (parsePaymentPoolEnvelope(message.text)) return; // fresh-address pool control envelopes are silent (matches iOS)
  // Don't notify for the conversation you're already looking at in a focused window.
  if (activeConversationId === conversationEntry.id && !document.hidden) return;
  const title = displayNameForAddress(contact) || contact?.name || shortAddress(contact?.address || "");
  try {
    const note = new Notification(title, {
      body: displayTextForMessage(message) || "New message",
      tag: `kachat-${conversationEntry.id}`,
      icon: kachatLogoUrl,
      silent: (accountShellPrefs.notificationSound ?? true) === false,
    });
    note.onclick = () => { try { window.focus(); } catch {} setActiveAppTab("chats"); openConversation(conversationEntry.id); note.close(); };
  } catch { /* notification construction can throw in some contexts */ }
}

// Generic desktop notification helper for non-chat pings (wallet address
// activity, KaPosts). Honors the Play sound preference; falls back to the
// in-app toast when browser notifications are unavailable/denied.
function postDesktopNotification({ title, body, tag, onClick } = {}) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    showCopyToast(body ? `${title} — ${body}` : title);
    return;
  }
  try {
    const note = new Notification(title || "KaChat", {
      body: body || "",
      tag: tag || undefined,
      icon: kachatLogoUrl,
      silent: (accountShellPrefs.notificationSound ?? true) === false,
    });
    note.onclick = () => {
      try { window.focus(); } catch {}
      try { onClick?.(); } catch {}
      note.close();
    };
  } catch {
    showCopyToast(body ? `${title} — ${body}` : title);
  }
}

// Per-event-type gate for KaPosts notification pings (iOS
// AppSettings.shouldNotifyKaPostsAction): contentType "vote" (voteType
// "upvote"/"downvote"), "reply", "quote" (K's repost mechanism —
// quotes-with-text included), or "follow". Unknown kinds always notify rather
// than silently vanishing behind a toggle that doesn't name them.
function shouldNotifyKaPostsAction(contentType, voteType) {
  switch (contentType) {
    case "vote": return voteType === "downvote"
      ? (accountShellPrefs.kaPostsNotifyDislikes ?? true)
      : (accountShellPrefs.kaPostsNotifyLikes ?? true);
    case "reply": return accountShellPrefs.kaPostsNotifyComments ?? true;
    case "quote": return accountShellPrefs.kaPostsNotifyReposts ?? true;
    case "follow": return accountShellPrefs.kaPostsNotifyFollows ?? true;
    // Being @mentioned always pings — deliberate, not the unknown-kind fallback.
    case "mention": return true;
    default: return true;
  }
}
const copyContactAddressButtons = document.querySelectorAll("[data-copy-contact-address]");
const clearChatButton = document.querySelector("[data-clear-chat]");
const simulateIncomingButton = document.querySelector("[data-simulate-incoming]");
const syncPreviewButton = document.querySelector("[data-sync-preview]");
const importPayloadButton = document.querySelector("[data-open-import-payload]");
const syncStatus = document.querySelector("[data-sync-status]");
const messageArea = document.querySelector("[data-message-area]");
const messageEmpty = document.querySelector("[data-message-empty]");
const composer = document.querySelector("[data-composer]");
const composerPlusButton = document.querySelector("[data-composer-plus]");
const composerPlusMenu = document.querySelector("[data-composer-plus-menu]");
const photoFileInput = document.querySelector("[data-photo-file-input]");
const pendingPhotoPreview = document.querySelector("[data-pending-photo-preview]");
const pendingPhotoThumb = document.querySelector("[data-pending-photo-thumb]");
const pendingPhotoMeta = document.querySelector("[data-pending-photo-meta]");
const pendingPhotoRemove = document.querySelector("[data-pending-photo-remove]");
let pendingPhotoAttachment = null;
const composerModeButtons = Array.from(document.querySelectorAll("[data-composer-mode]"));
const availableBalanceBanner = document.querySelector("[data-available-balance-banner]");
const feeEstimateBanner = document.querySelector("[data-fee-estimate-banner]");
const handshakeWarningBanner = document.querySelector("[data-handshake-warning-banner]");
let feeEstimateDebounceTimer = null;
let feeEstimateRequestToken = 0;
const kasPaymentAlert = document.querySelector("[data-kas-payment-alert]");
const kasPaymentAlertTitle = document.querySelector("[data-kas-payment-alert-title]");
const kasPaymentAlertMessage = document.querySelector("[data-kas-payment-alert-message]");
const kasPaymentAlertPrimary = document.querySelector("[data-kas-payment-alert-primary]");
const kasPaymentAlertCancel = document.querySelector("[data-kas-payment-alert-cancel]");
const contactModal = document.querySelector("[data-contact-modal]");
const contactForm = document.querySelector("[data-contact-form]");
const contactAddressInput = contactForm?.elements?.address;
const contactNameInput = contactForm?.elements?.name;
const createChatAddButton = document.querySelector("[data-create-chat-add]");
const createChatError = document.querySelector("[data-create-chat-error]");
const contactImportButton = document.querySelector("[data-contact-import]");
const contactImportFile = document.querySelector("[data-contact-import-file]");
const contactPasteButton = document.querySelector("[data-contact-paste]");
const contactScanButton = document.querySelector("[data-contact-scan]");
const searchInput = document.querySelector(".search-input");

// Step 101 — full-window desktop layout. Sidebar + detail pane are both
// visible at once at wide widths (matching styles.css's 860px breakpoint);
// below that, only one pane shows at a time via the .conversation-open class.
const wideLayoutMedia = window.matchMedia("(min-width: 860px)");
let isWideLayout = wideLayoutMedia.matches;
wideLayoutMedia.addEventListener("change", (event) => {
  isWideLayout = event.matches;
});

// Step 102 — which of the 5 bottom-left tabs is currently selected. Drives
// updateDetailActiveClass() below alongside conversation state.
let currentAppTab = "chats";

// The group thread and the 1:1 conversation share the right-side detail pane and are
// mutually exclusive. Declared here (hoisted above its group-module usage) so the shared
// layout helpers below can reference it during boot without a TDZ error.
let activeGroupId = null;

// `.detail-active` covers both "a conversation is open" and "a non-Chats tab
// is selected" — either one means the detail pane, not the sidebar's chat
// list, should take over the full width in narrow mode (see the media query
// in ui/styles.css). `.conversation-open` stays narrower (conversation only)
// since it's also used there to hide the tab bar during that specific
// drill-down, which placeholder tabs should NOT do.
function updateDetailActiveClass() {
  appBody?.classList.toggle("detail-active", Boolean(activeConversationId) || Boolean(activeGroupId) || currentAppTab !== "chats");
}

// Toggle the `.active` highlight on the currently-open chat / group row directly, without a
// full list re-render. Needed because openConversation() renders the list before the active
// id is set, so the highlight would otherwise never land on the clicked row.
function updateActiveRowHighlight() {
  document.querySelectorAll("[data-conversation-id]").forEach((row) => {
    row.classList.toggle("active", Boolean(activeConversationId) && row.dataset.conversationId === activeConversationId);
  });
  document.querySelectorAll("[data-group-open]").forEach((row) => {
    row.classList.toggle("active", Boolean(activeGroupId) && row.dataset.groupOpen === activeGroupId);
  });
}

function setActiveConversationId(id) {
  activeConversationId = id;
  // A 1:1 thread and a group thread can't share the detail pane — opening a real 1:1
  // dismisses any open group. Torn down inline (not via closeGroupChat) so we don't
  // re-enter this function and clobber the id we just set.
  if (id && activeGroupId) {
    activeGroupId = null;
    if (groupChatScreen) groupChatScreen.hidden = true;
    try { renderGroupList(); } catch { /* group module not ready */ }
  }
  try { updateChatFundingGate(); } catch { /* gate section not evaluated yet */ }
  const isOpen = Boolean(id);
  const onChatsTab = currentAppTab === "chats";
  // A group owning the detail pane counts as "open" for the collapse-to-detail layout, and
  // its pane must survive the background setActiveConversationId(null) refreshes.
  const groupOwnsDetail = !id && Boolean(activeGroupId) && onChatsTab;
  appBody?.classList.toggle("conversation-open", isOpen || groupOwnsDetail);
  // The conversation pane and its "Select a conversation" empty state belong to the CHATS
  // tab only - background refreshes call this with null while another tab (KaPosts etc.)
  // is showing, and unconditionally unhiding the empty state stacked it on top of that
  // tab's screen.
  if (conversation) conversation.hidden = !isOpen || !onChatsTab;
  if (detailEmptyState) detailEmptyState.hidden = isOpen || groupOwnsDetail || !onChatsTab;
  if (groupOwnsDetail && groupChatScreen) groupChatScreen.hidden = false;
  updateDetailActiveClass();
  updateActiveRowHighlight();
  // Opening a 1:1 thread is enough to raise the handshake warning (no typing
  // needed); leaving one drops it.
  try { updateHandshakeWarningBanner(); } catch { /* banner section not evaluated yet */ }
}

function nowId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stringToHex(value) {
  return Array.from(new TextEncoder().encode(String(value || "")))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeImportedPayload(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutPrefix = raw.replace(/^0x/i, "").replace(/\s+/g, "");
  if (/^[0-9a-fA-F]+$/.test(withoutPrefix) && withoutPrefix.length % 2 === 0) {
    return withoutPrefix.toLowerCase();
  }
  return stringToHex(raw);
}

function initialsFor(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

// Copy-toast form of an address, matching iOS exactly: the "kaspa:"/"kaspatest:" prefix, then
// the first 4 payload characters, 4 from the exact middle, and the last 4, joined with "...".
// Three visible segments make a lookalike-address swap much harder to miss than a single
// head-and-tail ellipsis. Short or unusual values are shown as-is.
function addressCopiedToastText(address) {
  const trimmed = String(address || "").trim();
  const colon = trimmed.indexOf(":");
  const prefix = colon === -1 ? "" : trimmed.slice(0, colon + 1);
  const payload = colon === -1 ? trimmed : trimmed.slice(colon + 1);
  if (payload.length < 24) return `Address ${trimmed} copied`;
  const first = payload.slice(0, 4);
  const midStart = Math.floor(payload.length / 2) - 2;
  const middle = payload.slice(midStart, midStart + 4);
  const last = payload.slice(-4);
  return `Address ${prefix}${first}...${middle}...${last} copied`;
}

function shortAddress(address) {
  if (!address) return "";
  if (address.length <= 20) return address;
  return `${address.slice(0, 14)}…${address.slice(-8)}`;
}

// Matches iOS/Android's KNS alias behavior: shows the address's resolved KNS
// primary domain when one is cached, falling back to the shortened address —
// unlike an arbitrary hand-typed name, a verified on-chain domain is treated
// as trustworthy enough to replace the raw address in the chat list/header.
// Reads the cache synchronously (no network wait); refreshKnsIfNeeded keeps
// it populated in the background.
// Contacts must show the domain the address actually set as its on-chain
// primary — not just whichever domain it owns most recently, which is what
// primaryDomain falls back to when no explicit primary is set (matches
// iOS's own-profile fallback behavior, but that fallback would misrepresent
// which domain a contact actually chose to identify themselves with).
//
// A name the user explicitly typed (at Add Contact time, or via Chat Info's
// rename field) always wins over anything KNS-derived — auto-naming only
// fills in contact.name itself (see applyKnsPrimaryDomainToContact) when no
// custom name has been set, so this just reads contact.name normally.
function displayNameForAddress(contact) {
  if (!contact) return "";
  if (contact.nameIsCustom) return contact.name || shortAddress(contact.address);
  const knsInfo = engine.peekKnsAddressInfo?.(contact.address);
  return knsInfo?.explicitPrimaryDomain || contact.name || shortAddress(contact.address);
}

// Called after any KNS info refresh: if this contact has no user-set custom
// name and its address has an explicit on-chain primary domain, adopt it as
// contact.name so it becomes the single source of truth everywhere (sidebar,
// header, Chat Info) instead of being recomputed separately in each place.
function applyKnsPrimaryDomainToContact(contact) {
  if (!contact || contact.nameIsCustom) return false;
  const knsInfo = engine.peekKnsAddressInfo?.(contact.address);
  const domain = knsInfo?.explicitPrimaryDomain || null;
  if (domain && contact.name !== domain) {
    contact.name = domain;
    contact.updatedAt = Date.now();
    return true;
  }
  return false;
}

function validateContactAddress(value) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error("Enter a Kaspa address.");
  if (!engine.kaspa) throw new Error("Kaspa validation is still loading. Try again in a moment.");
  if (!clean.startsWith("kaspa:")) throw new Error("Contact address must be a mainnet kaspa: address.");

  try {
    const parsed = new engine.kaspa.Address(clean);
    const normalized = parsed.toString();
    if (!normalized.startsWith("kaspa:")) throw new Error("Not a mainnet address.");
    return normalized;
  } catch {
    throw new Error("That Kaspa address is not valid.");
  }
}

function getStoredTestingWalletHex() {
  try {
    const activeAddress = String(localStorage.getItem(ACTIVE_ACCOUNT_KEY) || "").trim();
    if (activeAddress) {
      const account = loadSavedAccounts().find((entry) => entry.address === activeAddress);
      if (account?.privateKeyHex) return String(account.privateKeyHex).trim();
    }
    const raw = localStorage.getItem(PERSISTED_WALLET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.privateKeyHex) return String(parsed.privateKeyHex).trim();
    }
    const legacy = localStorage.getItem(LEGACY_PERSISTED_WALLET_KEY);
    if (legacy) return String(legacy).trim();
  } catch (error) {
    appendEngineLog(`Wallet storage read failed: ${error.message}`);
  }
  return "";
}

function persistTestingWallet({ mnemonic = "", passphrase = "", derivationPath = "", wordCount = 0, sourceFamily = "", chattingIndex = null } = {}) {
  const privateKeyHex = String(engine.privateKeyHex || "").trim();
  if (!privateKeyHex) throw new Error("Wallet private key was unavailable for browser storage.");
  const address = String(engine.address || "").trim();
  // "Save account on this device" off → session-only: keep the wallet in engine
  // memory but write nothing, so it won't appear in Saved Accounts or auto-restore.
  if (accountShellPrefs.saveAccount === false) {
    appendEngineLog(`Account kept in memory only (Save account is off): ${address}`);
    return true;
  }
  const meta = activeAccountMetadata();
  const existingAccount = loadSavedAccounts().find((entry) => entry.address === address);
  const payload = {
    version: 3,
    privateKeyHex,
    mnemonic: String(mnemonic || existingAccount?.mnemonic || ""),
    passphrase: String(passphrase || existingAccount?.passphrase || ""),
    derivationPath: String(derivationPath || existingAccount?.derivationPath || ""),
    wordCount: Number(wordCount || existingAccount?.wordCount || 0),
    // Identity derivation family + chatting index (iOS WalletSourceFamily):
    // honored whenever the identity is re-derived from the mnemonic (the
    // chatting-address picker/scanner) — restores use privateKeyHex directly.
    sourceFamily: String(sourceFamily || existingAccount?.sourceFamily || "kaspaStandard"),
    chattingIndex: Number.isInteger(chattingIndex) ? chattingIndex : Number(existingAccount?.chattingIndex || 0),
    address,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(PERSISTED_WALLET_KEY, JSON.stringify(payload));
  localStorage.removeItem(LEGACY_PERSISTED_WALLET_KEY);
  upsertSavedAccount({
    address,
    privateKeyHex,
    mnemonic: payload.mnemonic,
    passphrase: payload.passphrase,
    derivationPath: payload.derivationPath,
    wordCount: payload.wordCount,
    sourceFamily: payload.sourceFamily,
    chattingIndex: payload.chattingIndex,
    name: meta?.name,
    createdAt: meta?.createdAt,
    savedAt: payload.savedAt,
  });
  const verified = getStoredTestingWalletHex();
  if (verified !== privateKeyHex) throw new Error("Browser storage verification failed.");
  appendEngineLog(`Account saved in browser storage: ${engine.address}`);
  return true;
}

function clearPersistedTestingWallet() {
  localStorage.removeItem(PERSISTED_WALLET_KEY);
  localStorage.removeItem(LEGACY_PERSISTED_WALLET_KEY);
}

function restorePersistedTestingWallet() {
  if (!engine.kaspa) return false;
  if (localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true") {
    appendEngineLog("Stored account remains on device, but the session is logged out.");
    return false;
  }
  // "Keep me signed in" off → don't auto-enter on a fresh launch; the saved
  // account stays on device so it can be picked from the sign-in screen. A manual
  // sign-in (which marks the session active) still survives its own reload.
  if ((accountShellPrefs.keepSignedIn ?? true) === false && !isSessionActive()) {
    appendEngineLog("Keep me signed in is off — showing the sign-in screen.");
    return false;
  }
  const privateKeyHex = getStoredTestingWalletHex();
  if (!privateKeyHex) {
    appendEngineLog("No persistent testing wallet was found in this browser origin.");
    return false;
  }

  try {
    const wallet = engine.importPrivateKey(privateKeyHex);
    persistTestingWallet();
    markSessionActive();
    appendEngineLog(`Restored persistent testing wallet: ${wallet.address}`);
    activateWalletDataScope(wallet.address);
    return true;
  } catch (error) {
    clearPersistedTestingWallet();
    appendEngineLog(`Stored testing wallet could not be restored: ${error.message}`);
    return false;
  }
}

function normalizeContact(contact) {
  const name = String(contact?.name || contact?.displayName || "Unnamed").trim() || "Unnamed";
  const createdAt = Number(contact?.createdAt || Date.now());
  return {
    id: String(contact?.id || nowId()),
    name,
    nameIsCustom: Boolean(contact?.nameIsCustom),
    address: String(contact?.address || contact?.kaspaAddress || "").trim(),
    avatar: String(contact?.avatar || initialsFor(name)),
    // A user-assigned photo (compressed data URL) for contacts without a KNS avatar.
    // Lives on the contact, so it rides along in the desktopState backup automatically.
    photo: String(contact?.photo || ""),
    createdAt,
    updatedAt: Number(contact?.updatedAt || createdAt),
    relationshipState: String(contact?.relationshipState || "legacy-manual"),
    handshakeTxid: String(contact?.handshakeTxid || ""),
    incomingHandshakeTxid: String(contact?.incomingHandshakeTxid || ""),
    peerConversationId: String(contact?.peerConversationId || ""),
  };
}

function normalizeMessage(message, conversationId) {
  return normalizeEngineMessage(message, conversationId);
}

function contactForConversation(conversationEntry) {
  return state.contacts.find((contact) => contact.id === conversationEntry?.contactId) || null;
}

/** The accepted/established-contact predicate behind the stranger-gating features, mirroring
 *  iOS ContactsManager.isAcceptedContact: true for contacts you added yourself and for anyone
 *  you have ever sent a message to (accepting a communication request IS an outgoing message,
 *  and it also flips the relationship to "established"). The only contacts desktop ever
 *  auto-adds without your say-so are the ones an incoming handshake created, so those are the
 *  "new contacts" the photo-approval setting is about. */
function isAcceptedContact(contact, conversationEntry = null) {
  if (!contact) return false;
  const relationship = String(contact.relationshipState || "");
  if (relationship !== "incoming-request" && relationship !== "declined") return true;
  const entry = conversationEntry || (state.conversations || []).find((e) => e.contactId === contact.id);
  return (entry?.messages || []).some((message) => message?.direction === "outgoing" && message?.messageType !== "handshake");
}

/** Whether an incoming photo from this contact renders inline or waits behind a "Tap to view
 *  photo" placeholder. Mirrors iOS ContactsManager.shouldAutoDisplayPhotos: the per-contact
 *  Chat Info override wins outright, and otherwise Settings > Chats > "Require approval for
 *  photos from new contacts" (default ON) holds back photos from contacts you have not
 *  accepted yet. Revealing one is per session (revealedPhotoIds), never persisted. */
function shouldAutoDisplayPhotosFrom(contact, conversationEntry = null) {
  const override = getContactPhotos(contact?.address);
  if (override === "manual") return false;
  if (override === "always") return true;
  if ((accountShellPrefs.photoApprovalForNewContacts ?? true) === false) return true;
  return isAcceptedContact(contact, conversationEntry);
}

function promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist = true } = {}) {
  if (!contact || !conversationEntry) return false;
  if (contact.relationshipState !== "outgoing-request" && contact.relationshipState !== "legacy-manual") return false;

  const messages = conversationEntry.messages || [];
  const reciprocalMessage = messages.find((message) =>
    message?.direction === "incoming" &&
    message?.messageType !== "handshake" &&
    String(message?.sender || "") === String(contact.address || "") &&
    String(message?.text || "").trim().length > 0
  );
  if (!reciprocalMessage) return false;

  // A manually-added contact has no handshake to confirm acceptance —
  // only silence the no-handshake warning once there's real evidence both
  // sides have actually exchanged messages, not just one unprompted incoming
  // message.
  if (contact.relationshipState === "legacy-manual") {
    const hasOutgoing = messages.some((message) =>
      message?.direction === "outgoing" &&
      message?.messageType !== "handshake" &&
      String(message?.text || "").trim().length > 0
    );
    if (!hasOutgoing) return false;
  }

  contact.relationshipState = "established";
  contact.updatedAt = Date.now();
  conversationEntry.updatedAt = Date.now();
  conversationEntry.lastActivityAt = Math.max(
    Number(conversationEntry.lastActivityAt || 0),
    Number(reciprocalMessage.createdAt || Date.now()),
  );

  for (const message of conversationEntry.messages || []) {
    if (message?.messageType === "handshake" && message?.direction === "outgoing" && message?.status !== MESSAGE_STATUSES.FAILED) {
      applyMessagePatch(message, {
        status: MESSAGE_STATUSES.CONFIRMED,
        note: "Communication request accepted",
        confirmations: Math.max(1, Number(message.confirmations || 0)),
      });
    }
  }

  refreshSubscriptionAddresses({ restart: true });
  if (persist) persistState();
  appendEngineLog(`Handshake accepted for ${contact.address}: reciprocal encrypted message received.`);
  return true;
}

function reconcileEstablishedRelationships({ persist = true } = {}) {
  let changed = false;
  for (const conversationEntry of state.conversations || []) {
    const contact = contactForConversation(conversationEntry);
    if (promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist: false })) changed = true;
  }
  if (changed && persist) persistState();
  if (changed) updateHandshakeWarningBanner();
  return changed;
}

function normalizeConversation(conversationEntry) {
  const id = String(conversationEntry?.id || nowId());
  const createdAt = Number(conversationEntry?.createdAt || Date.now());
  const messages = Array.isArray(conversationEntry?.messages)
    ? conversationEntry.messages.map((message) => normalizeMessage(message, id)).filter((message) => message.text)
    : [];
  const lastMessage = messages.at(-1);
  const lastActivityAt = Number(conversationEntry?.lastActivityAt || conversationEntry?.updatedAt || lastMessage?.createdAt || createdAt);

  return {
    id,
    type: String(conversationEntry?.type || "direct"),
    contactId: String(conversationEntry?.contactId || ""),
    createdAt,
    updatedAt: Number(conversationEntry?.updatedAt || lastActivityAt),
    lastActivityAt,
    unreadCount: Number(conversationEntry?.unreadCount || 0),
    pinned: Boolean(conversationEntry?.pinned),
    muted: Boolean(conversationEntry?.muted),
    archived: Boolean(conversationEntry?.archived),
    hiddenMessageKeys: Array.isArray(conversationEntry?.hiddenMessageKeys) ? [...new Set(conversationEntry.hiddenMessageKeys.map(String))] : [],
    reactionsByTxId: (conversationEntry?.reactionsByTxId && typeof conversationEntry.reactionsByTxId === "object") ? conversationEntry.reactionsByTxId : {},
    sync: {
      lastSyncAt: Number(conversationEntry?.sync?.lastSyncAt || 0),
      lastFound: Number(conversationEntry?.sync?.lastFound || 0),
      runs: Number(conversationEntry?.sync?.runs || 0),
      cursor: Number(conversationEntry?.sync?.cursor || 0),
      lastNote: String(conversationEntry?.sync?.lastNote || ""),
    },
    messages,
  };
}

function migrateLegacyContacts(legacyContacts) {
  const contacts = [];
  const conversations = [];

  for (const rawContact of legacyContacts) {
    if (!rawContact?.name || !rawContact?.address) continue;
    const contact = normalizeContact(rawContact);
    const conversationId = nowId();
    const messages = Array.isArray(rawContact.messages)
      ? rawContact.messages.map((message) => ({
          ...normalizeMessage(message, conversationId),
          contactId: contact.id,
        })).filter((message) => message.text)
      : [];
    const lastMessage = messages.at(-1);

    contacts.push(contact);
    conversations.push({
      id: conversationId,
      type: "direct",
      contactId: contact.id,
      createdAt: Number(rawContact.createdAt || Date.now()),
      updatedAt: Number(rawContact.updatedAt || lastMessage?.updatedAt || Date.now()),
      lastActivityAt: Number(rawContact.updatedAt || lastMessage?.createdAt || rawContact.createdAt || Date.now()),
      unreadCount: Number(rawContact.unreadCount || 0),
      pinned: false,
      muted: false,
      archived: false,
      messages,
    });
  }

  return { contacts, conversations };
}

function loadStoredState() {
  try {
    const raw = chatStorageGetSync(accountScopedKey(STORAGE_KEY));
    if (raw) {
      const parsed = JSON.parse(raw);
      const contacts = Array.isArray(parsed?.contacts) ? parsed.contacts.map(normalizeContact).filter((contact) => contact.address) : [];
      const conversations = Array.isArray(parsed?.conversations)
        ? parsed.conversations.map(normalizeConversation).filter((entry) => entry.contactId && contacts.some((contact) => contact.id === entry.contactId))
        : [];
      return { contacts, conversations };
    }
  } catch {
    // Try legacy storage below.
  }

  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      const migrated = migrateLegacyContacts(parsed);
      if (migrated.contacts.length > 0) {
        chatStorageSetSync(accountScopedKey(STORAGE_KEY), JSON.stringify(migrated));
        return migrated;
      }
    } catch {
      // Try the next legacy key.
    }
  }

  return { contacts: [], conversations: [] };
}

function loadStoredMessageHistory() {
  try {
    const parsed = JSON.parse(chatStorageGetSync(accountScopedKey(MESSAGE_HISTORY_KEY)) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function mergeStoredMessageHistory(targetState) {
  const history = loadStoredMessageHistory();
  for (const conversationEntry of targetState.conversations || []) {
    const stored = Array.isArray(history[conversationEntry.id]) ? history[conversationEntry.id] : [];
    const current = Array.isArray(conversationEntry.messages) ? conversationEntry.messages : [];
    const byId = new Map();
    for (const raw of [...stored, ...current]) {
      const message = normalizeMessage(raw, conversationEntry.id);
      if (message.text) byId.set(message.id, message);
    }
    conversationEntry.messages = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    const last = conversationEntry.messages.at(-1);
    if (last) conversationEntry.lastActivityAt = Math.max(Number(conversationEntry.lastActivityAt || 0), last.createdAt);
  }
  return targetState;
}

state = buildFullyRestoredState();


function hydrateConversationMessages(conversationEntry) {
  if (!conversationEntry) return conversationEntry;
  // Hydration merges the persisted history/backup into the live entry — needed ONCE per
  // conversation per session, not on every render. renderMessages re-runs constantly
  // (sync polls, reactions, link previews resolving), and each hydration re-parsed the
  // ENTIRE message history plus the full state backup out of storage synchronously —
  // multi-MB JSON.parse passes per render on photo-heavy accounts, the single worst
  // open-a-chat / background-rerender cost in the app.
  if (conversationEntry.__hydrated) return conversationEntry;
  conversationEntry.__hydrated = true;

  const candidates = [];
  const current = Array.isArray(conversationEntry.messages) ? conversationEntry.messages : [];
  candidates.push(...current);

  const history = loadStoredMessageHistory();
  if (Array.isArray(history[conversationEntry.id])) candidates.push(...history[conversationEntry.id]);

  try {
    const backup = JSON.parse(chatStorageGetSync(accountScopedKey(STATE_BACKUP_KEY)) || "null");
    const backupConversation = Array.isArray(backup?.conversations)
      ? backup.conversations.find((entry) => String(entry?.id) === String(conversationEntry.id))
      : null;
    if (Array.isArray(backupConversation?.messages)) candidates.push(...backupConversation.messages);
  } catch {
    // Ignore a malformed backup and continue with current/history state.
  }

  const hidden = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
  const byId = new Map();
  for (const raw of candidates) {
    const message = normalizeMessage(raw, conversationEntry.id);
    if (!message.text) continue;
    if (hidden.has(String(message.id)) || (message.txid && hidden.has(String(message.txid)))) continue;
    const key = String(message.id || message.txid || `${message.createdAt}:${message.direction}:${message.text}`);
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, message);
      continue;
    }

    // Keep the newest canonical copy of a message. Older history/backup copies
    // must never downgrade a live confirmed payment back to pending.
    const existingUpdatedAt = Number(existing.updatedAt || existing.createdAt || 0);
    const messageUpdatedAt = Number(message.updatedAt || message.createdAt || 0);
    const statusRank = (status) => ({ failed: 0, pending: 1, building: 1, draft: 1, confirmed: 2 }[String(status || "pending")] ?? 1);
    const newer = messageUpdatedAt >= existingUpdatedAt ? message : existing;
    const older = newer === message ? existing : message;
    const merged = { ...older, ...newer };
    if (statusRank(existing.status) > statusRank(merged.status)) merged.status = existing.status;
    if (statusRank(message.status) > statusRank(merged.status)) merged.status = message.status;
    merged.confirmations = Math.max(Number(existing.confirmations || 0), Number(message.confirmations || 0));
    byId.set(key, merged);
  }

  conversationEntry.messages = [...byId.values()].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const last = conversationEntry.messages.at(-1);
  if (last) {
    conversationEntry.lastActivityAt = Math.max(Number(conversationEntry.lastActivityAt || 0), Number(last.createdAt || 0));
    conversationEntry.updatedAt = Math.max(Number(conversationEntry.updatedAt || 0), Number(last.updatedAt || last.createdAt || 0));
  }
  return conversationEntry;
}


// --- Deleted-chat tombstones -----------------------------------------------
// Deleting a chat records the contact's address here (account-scoped), and every
// restore path (desktop snapshot, phone archive, shared kachat-backup.json merge)
// honors the list so a deleted chat can never resurrect from a backup. Manually
// re-adding the contact clears its tombstone.
const DELETED_CONTACTS_KEY = "kachat-deleted-contacts-v1";

function loadDeletedContactAddresses() {
  try {
    const raw = JSON.parse(localStorage.getItem(accountScopedKey(DELETED_CONTACTS_KEY)) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(String).filter(Boolean) : []);
  } catch { return new Set(); }
}

function recordDeletedContactAddresses(addresses) {
  const set = loadDeletedContactAddresses();
  for (const address of addresses || []) if (address) set.add(String(address));
  try { localStorage.setItem(accountScopedKey(DELETED_CONTACTS_KEY), JSON.stringify([...set])); } catch {}
}

function clearDeletedContactAddress(address) {
  const set = loadDeletedContactAddresses();
  if (!set.delete(String(address || ""))) return;
  try { localStorage.setItem(accountScopedKey(DELETED_CONTACTS_KEY), JSON.stringify([...set])); } catch {}
}

function buildFullyRestoredState() {
  const restored = mergeStoredMessageHistory(loadStoredState());
  // Deletion tombstones win over restored state: a chat deleted on this device must
  // not resurrect from a snapshot restore or a merged backup.
  const tombstones = loadDeletedContactAddresses();
  if (tombstones.size) {
    const deletedContactIds = new Set((restored.contacts || [])
      .filter((contact) => tombstones.has(contact.address)).map((contact) => contact.id));
    restored.contacts = (restored.contacts || []).filter((contact) => !tombstones.has(contact.address));
    restored.conversations = (restored.conversations || []).filter((entry) => !deletedContactIds.has(entry.contactId));
  }
  for (const conversationEntry of restored.conversations || []) {
    hydrateConversationMessages(conversationEntry);
  }
  return restored;
}

function reloadStateFromBrowserStorage() {
  const restored = buildFullyRestoredState();
  const activeId = activeConversationId;
  state = restored;
  if (activeId && !state.conversations.some((entry) => entry.id === activeId)) {
    setActiveConversationId(null);
  }
  return state;
}

function persistStateWrites({ includeBackup = true } = {}) {
  // In IndexedDB mode these set calls update the in-memory cache immediately
  // and flush to disk on a 300ms debounce (coalescing bursts of persistState
  // calls into one write of the latest snapshot). In localStorage-fallback
  // mode they write synchronously and can throw QuotaExceededError, which
  // persistState() below still handles.
  const serialized = JSON.stringify(state);
  chatStorageSetSync(accountScopedKey(STORAGE_KEY), serialized);
  // STATE_BACKUP_KEY holds a byte-identical copy of STORAGE_KEY, purely as a corruption-
  // recovery snapshot (read only by hydration/restore). Writing it on EVERY persist doubled
  // the multi-MB serialization write; throttle it to at most once a minute — a stale-by-<60s
  // backup is exactly as useful for recovery, and the main store is always current.
  if (includeBackup) {
    const now = Date.now();
    if (now - lastStateBackupWriteAt >= STATE_BACKUP_MIN_INTERVAL_MS) {
      chatStorageSetSync(accountScopedKey(STATE_BACKUP_KEY), serialized);
      lastStateBackupWriteAt = now;
    }
  }
  const history = Object.fromEntries((state.conversations || []).map((entry) => [entry.id, entry.messages || []]));
  chatStorageSetSync(accountScopedKey(MESSAGE_HISTORY_KEY), JSON.stringify(history));
  const verified = chatStorageGetSync(accountScopedKey(STORAGE_KEY));
  if (verified !== serialized) throw new Error("Local conversation storage verification failed.");
}

/** Oldest-first trim of messages imported from a phone backup (transport "phone-backup"),
 *  keeping at most `keepPerConversation` per chat — live desktop messages are never dropped. */
function trimPhoneBackupMessages(keepPerConversation) {
  let removed = 0;
  for (const entry of state.conversations || []) {
    const messages = entry.messages || [];
    const phone = messages.filter((m) => m.transport === "phone-backup");
    if (phone.length <= keepPerConversation) continue;
    const drop = new Set(
      phone
        .slice()
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .slice(0, phone.length - keepPerConversation)
        .map((m) => m.id || m.txid),
    );
    entry.messages = messages.filter((m) => !drop.has(m.id || m.txid));
    removed += drop.size;
  }
  return removed;
}

let storageQuotaToastShown = false;

/** In IndexedDB mode persistStateWrites never throws (quota is device-proportional and the
 *  write is async) — the catch blocks below only ever run in the localStorage FALLBACK mode
 *  (IndexedDB unavailable, e.g. private browsing), where a full localStorage right after a
 *  large phone-backup import must never crash a sync. Fallback recovery order: drop the
 *  redundant full-state backup copy (halves the footprint), then trim phone-backup messages
 *  oldest-first in stages, retrying the save after each step. */
function persistState() {
  try {
    persistStateWrites();
    return;
  } catch { /* quota — reclaim space below and retry */ }
  try { chatStorageRemoveSync(accountScopedKey(STATE_BACKUP_KEY)); } catch { /* ignore */ }
  for (const keep of [100, 25, 0]) {
    trimPhoneBackupMessages(keep);
    try {
      persistStateWrites({ includeBackup: false });
      if (!storageQuotaToastShown) {
        storageQuotaToastShown = true;
        try { showCopyToast("Browser storage was full — trimmed the oldest phone-backup messages to keep saving."); } catch { /* early init */ }
      }
      return;
    } catch { /* still full — trim harder */ }
  }
  throw new Error("Local storage is full — could not save conversation state.");
}

let chatStorageFlushErrorNotified = false;

/** Emergency path, registered with setChatStorageFlushErrorHandler at module top: a debounced
 *  IndexedDB write FAILED after in-memory state was already updated. storage.js re-queues the
 *  batch for the next flush; additionally push a copy into localStorage via the legacy
 *  quota-aware trimming path so a crash right now cannot lose everything since the last
 *  successful flush. (trimPhoneBackupMessages only mutates state here, in this failure path —
 *  exactly like the old localStorage-quota behavior.) */
function handleChatStorageFlushError(error) {
  appendEngineLog(`IndexedDB save failed (${error?.message || error}) — writing localStorage fallback copy.`);
  if (!chatStorageFlushErrorNotified) {
    chatStorageFlushErrorNotified = true;
    try { showCopyToast("Saving chats to IndexedDB failed — using localStorage fallback."); } catch { /* early init */ }
  }
  const writeLocal = (includeBackup) => {
    const serialized = JSON.stringify(state);
    localStorage.setItem(accountScopedKey(STORAGE_KEY), serialized);
    if (includeBackup) localStorage.setItem(accountScopedKey(STATE_BACKUP_KEY), serialized);
    const history = Object.fromEntries((state.conversations || []).map((entry) => [entry.id, entry.messages || []]));
    localStorage.setItem(accountScopedKey(MESSAGE_HISTORY_KEY), JSON.stringify(history));
  };
  try { writeLocal(true); return; } catch { /* quota — trim and retry */ }
  for (const keep of [100, 25, 0]) {
    trimPhoneBackupMessages(keep);
    try { writeLocal(false); return; } catch { /* still full — trim harder */ }
  }
  appendEngineLog("localStorage fallback copy also failed — conversation state is only in memory.");
}

function activateWalletDataScope(address, { migrateLegacy = true } = {}) {
  // KaPosts state (follows/mutes/blocks + session posts) is per account too.
  try { resetKaPostsForAccount(); } catch { /* not yet initialized */ }
  try { reloadDockPrefsForAccount(); } catch { /* not yet initialized */ }
  try { resetBroadcastsForAccount(); } catch { /* not yet initialized */ }
  try { resetPortfolioForAccount(); } catch { /* not yet initialized */ }
  try { resetColdStorageForAccount(); } catch { /* not yet initialized */ }
  try { resetNextcloudForAccount(); } catch { /* not yet initialized */ }
  try { resetSwapsForAccount(); } catch { /* not yet initialized */ }
  try { loadNotifCenter(); } catch { /* not yet initialized */ }
  const clean = String(address || "").trim();
  if (!clean) {
    state = { contacts: [], conversations: [] };
    setActiveConversationId(null);
    return state;
  }

  const scopedStateKey = accountScopedKey(STORAGE_KEY, clean);
  if (migrateLegacy && !chatStorageGetSync(scopedStateKey)) {
    const legacy = chatStorageGetSync(STORAGE_KEY);
    if (legacy) {
      chatStorageSetSync(scopedStateKey, legacy);
      const legacyBackup = chatStorageGetSync(STATE_BACKUP_KEY);
      const legacyHistory = chatStorageGetSync(MESSAGE_HISTORY_KEY);
      if (legacyBackup) chatStorageSetSync(accountScopedKey(STATE_BACKUP_KEY, clean), legacyBackup);
      if (legacyHistory) chatStorageSetSync(accountScopedKey(MESSAGE_HISTORY_KEY, clean), legacyHistory);
      appendEngineLog(`Migrated existing chats into wallet scope ${shortAddress(clean)}.`);
    }
  }

  setActiveConversationId(null);
  // A freshly activated wallet re-syncs its whole history from the indexer; treat that
  // next sweep as a silent, already-read backfill rather than a burst of new messages.
  pendingInitialCatchUp = true;
  state = buildFullyRestoredState();
  refreshSubscriptionAddresses({ restart: false });
  // Per-account Chats Payment Privacy: switching accounts applies that
  // account's stored value immediately (Settings toggle included).
  try { refreshChatsPrivacyToggle(); } catch { /* not yet wired during early init */ }
  // Per-account message retention: show this account's window and clean up its stored history
  // (a no-op on the default "Keep forever").
  try { refreshRetentionSelectionUi(); } catch { /* not yet wired during early init */ }
  try { startMessageRetentionSweeps(); } catch { /* not yet wired during early init */ }
  return state;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true, // 12-hour clock (e.g. 3:03 PM), not 24-hour
  }).format(new Date(timestamp));
}


// Day-separator label for message timelines, matching iOS's MessageDaySeparatorFormatter:
// "Today", "Yesterday", weekday + date within the current year ("Friday, Aug 15"), else
// month/day/year ("Aug 15, 2025"). Shared by 1:1 chats, group chats, and broadcasts.
function daySeparatorLabel(ts) {
  const d = new Date(Number(ts) || Date.now());
  const now = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((midnight(now) - midnight(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// Builds one centered "Today"/"Yesterday"/date pill for a message timeline.
function buildDaySeparatorElement(ts) {
  const sep = document.createElement("div");
  sep.className = "message-day-separator";
  const pill = document.createElement("span");
  pill.textContent = daySeparatorLabel(ts);
  sep.append(pill);
  return sep;
}

function formatDateTime(timestamp) {
  if (!timestamp) return "Never synced";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function syncLabel(conversationEntry) {
  const sync = conversationEntry?.sync || {};
  if (!sync.lastSyncAt) return "Not synced yet";
  const found = Number(sync.lastFound || 0);
  const foundLabel = found === 1 ? "1 new payload" : `${found} new payloads`;
  return `Last sync ${formatDateTime(sync.lastSyncAt)} · ${foundLabel} · cursor ${sync.cursor || 0}`;
}

function lastMessageFor(conversationEntry) {
  const messages = conversationEntry.messages || [];
  // The chat list previews the newest REAL message — cross-device placeholders are
  // hidden everywhere (see renderMessages), so they must not claim the preview either.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.text !== "📤 Sent via another device") return messages[i];
  }
  return null;
}

function statusLabel(status) {
  return engineStatusLabel(status);
}

function protocolSummary(message) {
  if (!message) return "No message selected.";
  const rows = [
    ["Status", statusLabel(message.status)],
    ["Direction", message.direction || "outgoing"],
    ["Protocol", `${message.protocol || "kasia"} v${message.protocolVersion || 1}`],
    ["Network", message.network || "mainnet"],
    ["Type", message.messageType || "not created yet"],
    ["Transport", message.transport || "preview"],
    ["Payload bytes", message.payloadBytes ?? "--"],
    ["TXID", message.txid || "--"],
    ["DAA score", message.daaScore || "--"],
    ["Confirmations", message.confirmations ?? 0],
    ["Sender", message.sender || "--"],
    ["Receiver", message.receiver || "--"],
    ["Created", new Date(message.createdAt).toLocaleString()],
  ];

  const meta = rows.map(([label, value]) => `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>`).join("");

  const payload = message.payloadHex
    ? `<div class="payload-box" data-copy-payload title="Click to copy payload hex">${escapeHtml(message.payloadHex)}</div>`
    : `<div class="payload-box muted">Payload will appear after KaspaEngine creates it.</div>`;

  const protocolString = message.protocolString
    ? `<div class="detail-section-title">Kasia protocol string</div><div class="payload-box muted">${escapeHtml(message.protocolString)}</div>`
    : "";

  return `${meta}
    <div class="detail-section-title">Kasia payload hex</div>
    ${payload}
    ${protocolString}`;
}

function closeMessageDetails() {
  activeMessageActionId = null;
  if (messageDetailsModal) messageDetailsModal.hidden = true;
}

function activeMessageRecord() {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === activeMessageActionId);
  return { conversationEntry, message };
}

function rawMessageRecord(message) {
  if (!message) return null;
  return {
    id: message.id,
    status: message.status,
    direction: message.direction,
    protocol: message.protocol,
    protocolVersion: message.protocolVersion,
    network: message.network,
    messageType: message.messageType,
    transport: message.transport,
    payloadBytes: message.payloadBytes,
    txid: message.txid,
    daaScore: message.daaScore,
    confirmations: message.confirmations,
    sender: message.sender,
    receiver: message.receiver,
    createdAt: new Date(message.createdAt).toISOString(),
    updatedAt: new Date(message.updatedAt || message.createdAt).toISOString(),
    text: message.text,
    payloadHex: message.payloadHex,
    protocolString: message.protocolString,
  };
}

function rawMessageText(message) {
  return JSON.stringify(rawMessageRecord(message), null, 2);
}

function downloadBlob(filename, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value) {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function exportMessageCsv(message) {
  const record = rawMessageRecord(message);
  const rows = Object.entries(record || {}).map(([key, value]) => `${csvEscape(key)},${csvEscape(value)}`);
  downloadBlob(`kachat-message-${message.id}.csv`, "text/csv;charset=utf-8", `field,value\n${rows.join("\n")}\n`);
  setStatus("Message raw data exported as CSV");
}

function exportMessagePdf(message) {
  const record = rawMessageRecord(message);
  const popup = window.open("", "_blank");
  if (!popup) throw new Error("Allow pop-ups to export a PDF.");
  const rows = Object.entries(record || {}).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value))}</td></tr>`).join("");
  popup.document.write(`<!doctype html><html><head><title>KaChat Message Raw Data</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;color:#111}h1{font-size:24px;margin:0 0 8px}p{color:#555;margin:0 0 24px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{width:180px;background:#f4f4f4}@media print{body{padding:0}}</style></head><body><h1>KaChat Message Raw Data</h1><p>Use the browser print dialog and choose “Save as PDF”.</p><table>${rows}</table><script>window.onload=()=>setTimeout(()=>window.print(),150)<\/script></body></html>`);
  popup.document.close();
  setStatus("PDF export opened");
}

function openExportChoice() {
  if (!exportChoiceModal) return;
  exportChoiceModal.hidden = false;
}

function closeExportChoice() {
  if (exportChoiceModal) exportChoiceModal.hidden = true;
}

function updateSelectionUi() {
  if (selectionToolbar) selectionToolbar.hidden = !messageSelectionMode;
  if (selectionCount) selectionCount.textContent = `${selectedMessageIds.size} selected`;
  const selectAllButton = document.querySelector("[data-select-all-messages]");
  if (selectAllButton) {
    const total = messageArea?.querySelectorAll("[data-message-id]").length || 0;
    selectAllButton.textContent = total > 0 && selectedMessageIds.size >= total ? "Deselect All" : "Select All";
  }
  messageArea?.classList.toggle("selection-mode", messageSelectionMode);
}

function exitMessageSelection() {
  messageSelectionMode = false;
  selectedMessageIds.clear();
  updateSelectionUi();
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (conversationEntry) renderMessages(conversationEntry);
}

function enterMessageSelection(initialMessageId = null) {
  messageSelectionMode = true;
  selectedMessageIds.clear();
  if (initialMessageId) selectedMessageIds.add(initialMessageId);
  closeMessageDetails();
  updateSelectionUi();
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (conversationEntry) renderMessages(conversationEntry);
}

function toggleSelectedMessage(messageId) {
  if (selectedMessageIds.has(messageId)) selectedMessageIds.delete(messageId);
  else selectedMessageIds.add(messageId);
  updateSelectionUi();
  const bubble = messageArea.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  bubble?.classList.toggle("selected", selectedMessageIds.has(messageId));
  bubble?.closest(".message-row")?.classList.toggle("selected", selectedMessageIds.has(messageId));
  bubble?.setAttribute("aria-checked", selectedMessageIds.has(messageId) ? "true" : "false");
}

function openDeleteSelectedConfirmation() {
  if (!selectedMessageIds.size || !deleteConfirmModal) return;
  const count = selectedMessageIds.size;
  if (deleteConfirmCopy) {
    deleteConfirmCopy.textContent = `${count} message${count === 1 ? "" : "s"} will be hidden from this browser only. They cannot be removed from Kaspa.`;
  }
  deleteConfirmModal.hidden = false;
}

function closeDeleteSelectedConfirmation() {
  if (deleteConfirmModal) deleteConfirmModal.hidden = true;
}

function deleteSelectedMessages() {
  if (!selectedMessageIds.size) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (!conversationEntry) return;
  const count = selectedMessageIds.size;
  const removed = (conversationEntry.messages || []).filter((message) => selectedMessageIds.has(message.id));
  conversationEntry.hiddenMessageKeys = [...new Set([
    ...(conversationEntry.hiddenMessageKeys || []),
    ...removed.flatMap((message) => [message.id, message.txid].filter(Boolean).map(String)),
  ])];
  conversationEntry.messages = (conversationEntry.messages || []).filter((message) => !selectedMessageIds.has(message.id));
  const last = lastMessageFor(conversationEntry);
  conversationEntry.lastActivityAt = last?.createdAt || conversationEntry.createdAt;
  conversationEntry.updatedAt = Date.now();
  persistState();
  closeDeleteSelectedConfirmation();
  exitMessageSelection();
  setStatus(`${count} message${count === 1 ? "" : "s"} deleted locally`);
}

function onchainAmountKas() {
  return "0.2";
}

function closeOnchainConfirm() {
  pendingOnchainDraft = null;
  if (onchainConfirmModal) onchainConfirmModal.hidden = true;
}

function openOnchainConfirm({ conversationId, text }) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact || !onchainConfirmModal || !onchainSummary) return false;
  const envelope = engine.createMessageEnvelope({
    conversationId,
    contactId: contact.id,
    toAddress: contact.address,
    fromAddress: engine.address || null,
    text,
    alias: "KaChat",
    localNonce: nowId(),
    createdAt: Date.now(),
  });
  pendingOnchainDraft = { conversationId, text };
  onchainSummary.innerHTML = `
    <div class="confirm-row"><span>Contact</span><strong>${escapeHtml(contact.name)}</strong></div>
    <div class="confirm-row"><span>To</span><code>${escapeHtml(shortAddress(contact.address, 18))}</code></div>
    <div class="confirm-row"><span>Amount</span><strong>${escapeHtml(onchainAmountKas())} KAS</strong></div>
    <div class="confirm-row"><span>Payload</span><strong>${envelope.payloadBytes} bytes</strong></div>
    <div class="confirm-preview">${escapeHtml(text)}</div>
  `;
  onchainConfirmModal.hidden = false;
  return true;
}

// Full, unwrapped display text for a message — reply envelopes show just
// their own typed text, photo/audio envelopes show a friendly label. Used
// anywhere the raw wire content (JSON envelope) shouldn't leak into the UI.
// Cheap head-window sniff for the cross-platform {type:"file"} media envelope,
// independent of field order, payload size, and "\/" escaping: some senders
// (dictionary-based JSON serializers) put the multi-MB `content` before
// `mimeType` — pushing the mime key far past any sane scan window — and escape
// "/" as "\/". The data: URL right at the front names the mime either way.
// Returns the mime string, "" for a file envelope whose mime can't be pinned
// down, or null when the text isn't a file envelope at all.
function sniffInlineFileMime(text) {
  const head = String(text || "").slice(0, 2048).trimStart();
  if (!head.startsWith("{") || !/"type"\s*:\s*"file"/.test(head)) return null;
  const mime = head.match(/"mimeType"\s*:\s*"([^"]+)"/);
  if (mime) return mime[1].replace(/\\\//g, "/");
  const dataUrl = head.match(/"content"\s*:\s*"data:([^;",]+)/);
  return dataUrl ? dataUrl[1].replace(/\\\//g, "/") : "";
}

function displayTextForMessage(message) {
  if (!message) return "";
  // Per-envelope-kind wording ("♟️ Played e2 → e4", "♟️ Lost on time", …) rather than one
  // generic "Chess" for everything — matches iOS's formatNotificationBody.
  const chessPreview = Chess.chessPreviewText(message.text, message.direction === "outgoing");
  if (chessPreview) return chessPreview;
  const replyEnvelope = parseReplyEnvelope(message.text);
  if (replyEnvelope) return replyEnvelope.text;
  const fileMime = sniffInlineFileMime(message.text);
  if (fileMime != null) {
    if (fileMime.startsWith("image/")) return "📷 Photo";
    if (fileMime.startsWith("audio/")) return "🎤 Audio message";
    if (fileMime.startsWith("video/")) return "🎬 Video";
    return "📎 File";
  }
  return message.text || "";
}

function openMessageDetails(messageId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!message || !messageDetailsModal) return;
  activeMessageActionId = messageId;
  if (messageDetailsBody) messageDetailsBody.textContent = displayTextForMessage(message) || "Message";
  const explorerRow = document.querySelector("[data-message-explorer-row]");
  if (explorerRow) explorerRow.hidden = !message.txid;
  messageDetailsModal.hidden = false;
}

function conversationPreview(conversationEntry) {
  const contact = contactForConversation(conversationEntry);
  const last = lastMessageFor(conversationEntry);
  const reactionEvent = conversationEntry.lastReactionEvent;

  // If the most recent activity was a reaction (newer than the last real
  // message, or there's no message at all yet), the preview describes whose
  // message got reacted to rather than showing stale message text.
  if (reactionEvent && (!last || reactionEvent.timestamp >= last.createdAt)) {
    const targetMessage = conversationEntry.messages.find((entry) => entry.txid === reactionEvent.targetTxId || entry.id === reactionEvent.targetTxId);
    if (targetMessage) {
      return targetMessage.direction === "outgoing" ? "Reacted to your message" : "Reacted to their message";
    }
    return "Reacted to a message";
  }

  if (!last) return shortAddress(contact?.address || "");
  const prefix = last.direction === "outgoing" ? "You: " : "";
  return `${prefix}${displayTextForMessage(last)}`;
}

// Effective recency for chat-list ordering: the newest of the stored lastActivityAt and the
// actual last message's timestamp, so a chat always sorts by its most recent activity even if
// lastActivityAt drifted (e.g. a synced message that never bumped it).
function conversationRecency(conversationEntry) {
  const last = lastMessageFor(conversationEntry);
  return Math.max(
    Number(conversationEntry?.lastActivityAt || 0),
    Number(last?.createdAt || 0),
    Number(conversationEntry?.updatedAt || 0),
    Number(conversationEntry?.createdAt || 0),
  );
}

function sortedConversations() {
  return [...state.conversations]
    .filter((conversationEntry) => !conversationEntry.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || conversationRecency(b) - conversationRecency(a));
}

function appendEngineLog(message) {
  if (!engineLog) return;
  const line = typeof message === "string" ? message : JSON.stringify(message, null, 2);
  engineLog.textContent = `${line}\n${engineLog.textContent}`.trim();
}

async function copyTextToClipboard(value) {
  const text = String(value ?? "");
  if (!text) throw new Error("Nothing to copy");

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access was blocked by the browser");
}

function showCopyToast(message) {
  if (!copyToast || !copyToastText) return;
  copyToastText.textContent = message;
  copyToast.hidden = false;
  requestAnimationFrame(() => copyToast.classList.add("visible"));
  window.clearTimeout(copyToastTimer);
  copyToastTimer = window.setTimeout(() => {
    copyToast.classList.remove("visible");
    window.setTimeout(() => { copyToast.hidden = true; }, 180);
  }, 1800);
}

function updateGlobalHealthIndicator() {
  if (!serviceHealthLed) return;

  const { stateName, latencyMs } = computeConnectionHealth();

  serviceHealthLed.classList.remove("ready", "busy", "error");
  serviceHealthLed.classList.add(stateName);
  if (serviceHealthButton) {
    const stateLabel = stateName === "error"
      ? "Disconnected"
      : stateName === "busy"
        ? `Connected · high latency${latencyMs ? ` (${latencyMs} ms)` : ""}`
        : "Connected";
    serviceHealthButton.setAttribute("aria-label", `${stateLabel}. Open Connection Status`);
    serviceHealthButton.title = stateLabel;
  }
}

function setStatus(text) {
  latestServiceStatusText = String(text || "Service status");
  updateGlobalHealthIndicator();
  renderTransportReadiness();
  if (connectionOverlay && !connectionOverlay.hidden) renderConnectionStatus();
}

function setService(indicator, label, stateName, text) {
  if (indicator) {
    indicator.classList.remove("ready", "busy", "error");
    if (stateName) indicator.classList.add(stateName);
  }
  if (label) label.textContent = text;
  updateGlobalHealthIndicator();
}

function setArchitectureBadge(element, stateName, text) {
  if (!element) return;
  element.classList.remove("ready", "busy", "error");
  if (stateName) element.classList.add(stateName);
  element.textContent = text;
}

function updateArchitectureDetails() {
  const connection = engine.connectionSnapshot?.() || {};
  const networkReady = Boolean(engine.rpc) && connection.primary === "ready";
  const standbyReady = Boolean(engine.standbyRpc) && connection.standby === "ready";
  const cipherReady = engine.isKasiaCipherLoaded?.() === true;
  const registry = engine.nodeRegistrySnapshot?.() || { endpoints: [], endpointCount: 0, totalSuccesses: 0, totalFailures: 0, lastGoodEndpoint: "", successfulFailovers: 0, failedFailovers: 0 };
  const activeEndpoint = engine.rpc?.url || connection.primaryEndpoint || "";
  const standbyEndpoint = engine.standbyRpc?.url || connection.standbyEndpoint || "";
  const lastGoodRecord = (registry.endpoints || []).find((entry) => entry.endpoint === registry.lastGoodEndpoint);

  if (nodePoolStatus) {
    nodePoolStatus.textContent = networkReady
      ? standbyReady
        ? `Primary + warm standby · ${activeEndpoint || "mainnet RPC"}`
        : `Primary active · standby ${connection.standby || "unavailable"}`
      : connection.failover && connection.failover !== "idle"
        ? `Failover ${connection.failover}`
        : registry.lastGoodEndpoint
          ? "Last-good-first · resolver fallback"
          : "Resolver discovery · persistent scoring enabled";
  }
  if (standbyStatus) {
    standbyStatus.textContent = standbyReady
      ? `Ready · ${standbyEndpoint}`
      : connection.standby === "connecting"
        ? "Connecting alternate synced RPC…"
        : connection.standby === "error"
          ? `Unavailable · ${connection.lastError || "connection failed"}`
          : networkReady
            ? "No independent standby available yet"
            : "Waiting for primary RPC";
  }
  if (lastGoodNodeStatus) {
    lastGoodNodeStatus.textContent = registry.lastGoodEndpoint
      ? `${registry.lastGoodEndpoint}${lastGoodRecord?.averageLatencyMs ? ` · ${lastGoodRecord.averageLatencyMs} ms avg` : ""}`
      : "None recorded yet";
  }
  if (nodePoolHistoryStatus) {
    nodePoolHistoryStatus.textContent = registry.endpointCount
      ? `${registry.endpointCount} observed · ${registry.totalSuccesses} successes · ${registry.totalFailures} failures · ${registry.successfulFailovers || 0}/${(registry.successfulFailovers || 0) + (registry.failedFailovers || 0)} failovers`
      : "No connection attempts recorded";
  }
  const subscription = engine.subscriptionSnapshot?.() || { status: "idle" };
  if (syncServiceStatus) syncServiceStatus.textContent = subscription.status === "ready"
    ? `Live wallet + ${Number(subscription.contactCount || 0)} contact subscription${Number(subscription.contactCount || 0) === 1 ? "" : "s"} · 5-second indexer fallback${subscription.lastEventType ? ` · last ${subscription.lastEventType}` : ""}`
    : subscription.status === "connecting"
      ? "Connecting live wallet UTXO subscription…"
      : subscription.status === "error"
        ? `Subscription error · ${subscription.lastError || "retrying on reconnect"}`
        : cipherReady ? "Waiting for wallet and primary RPC" : "Waiting for Kasia cipher";
  if (storageStatus) storageStatus.textContent = engine.address
    ? "Wallet, contacts, messages, node history and failover records persisted locally"
    : "Contacts, messages and node history persisted · wallet not loaded";
}

function updateServiceSummary() {
  const connection = engine.connectionSnapshot?.() || {};
  const runtimeReady = Boolean(engine.kaspa);
  const cipherReady = engine.isKasiaCipherLoaded?.() === true;
  const walletReady = Boolean(engine.address);
  const networkReady = Boolean(engine.rpc) && connection.primary === "ready";
  const standbyReady = Boolean(engine.standbyRpc) && connection.standby === "ready";
  const failoverBusy = connection.failover && connection.failover !== "idle";

  setService(runtimeIndicator, runtimeStatus, runtimeReady ? "ready" : "busy", runtimeReady ? `Rusty Kaspa ${engine.version?.() || "ready"}` : "Starting Rusty Kaspa…");
  setService(walletIndicator, walletStatus, walletReady ? "ready" : "", walletReady ? shortAddress(engine.address) : "Not loaded");
  setService(networkIndicator, networkStatus, networkReady ? "ready" : (connection.primary === "error" ? "error" : (walletReady ? "busy" : "")), networkReady ? `Connected · ${currentBalanceKas} KAS` : (connection.primary === "error" ? "No usable primary RPC" : (walletReady ? "Connecting…" : "Waiting for wallet")));
  setService(standbyIndicator, standbyStatus, standbyReady ? "ready" : (connection.standby === "error" ? "error" : (networkReady ? "busy" : "")), standbyReady ? `Ready · ${engine.standbyRpc?.url || connection.standbyEndpoint || "alternate RPC"}` : (networkReady ? (connection.standby === "connecting" ? "Connecting alternate synced RPC…" : "No independent standby available yet") : "Waiting for primary RPC"));
  setService(messagingIndicator, messagingStatus, cipherReady ? "ready" : "busy", cipherReady ? "Encryption runtime ready" : "Loading encryption runtime…");
  const subscription = engine.subscriptionSnapshot?.() || { status: "idle" };
  const subscriptionText = subscription.status === "ready"
    ? `Live subscription · wallet + ${Number(subscription.contactCount || 0)} contact${Number(subscription.contactCount || 0) === 1 ? "" : "s"}`
    : subscription.status === "connecting"
      ? "Connecting live wallet UTXO subscription…"
      : subscription.status === "error"
        ? `Subscription error · ${subscription.lastError || "unknown error"}`
        : "Waiting for wallet and primary RPC";
  setService(subscriptionIndicator, syncServiceStatus, subscription.status === "ready" ? "ready" : subscription.status === "error" ? "error" : "busy", subscriptionText);
  const networkBadgeState = networkReady && standbyReady && !failoverBusy ? "ready" : (connection.primary === "error" ? "error" : (walletReady ? "busy" : ""));
  const networkBadgeText = networkReady && standbyReady && !failoverBusy ? "Protected" : networkReady ? "Primary only" : connection.primary === "error" ? "Offline" : walletReady ? "Connecting" : "Waiting";
  setArchitectureBadge(networkBadge, networkBadgeState, networkBadgeText);
  setArchitectureBadge(messagingBadge, cipherReady ? "ready" : "busy", cipherReady ? "Ready" : "Starting");
  updateArchitectureDetails();
  updateGlobalHealthIndicator();
}

let lastWasmError = null;
async function ensureRuntimes({ quiet = false } = {}) {
  let failed = false;
  if (!engine.kaspa) {
    try {
      if (!quiet) setStatus("Loading Rusty Kaspa…");
      await engine.loadWasm();
      lastWasmError = null;
      appendEngineLog(`WASM loaded ${engine.version() || ""}`);
    } catch (error) {
      failed = true;
      lastWasmError = error;
      appendEngineLog(`WASM failed: ${error.message}`);
      setService(runtimeIndicator, runtimeStatus, "error", "Rusty Kaspa failed to load");
    }
  }
  if (!engine.isKasiaCipherLoaded?.()) {
    try {
      if (!quiet) setStatus("Loading Kasia cipher…");
      await engine.loadKasiaCipher();
      appendEngineLog("Kasia cipher loaded.");
    } catch (error) {
      failed = true;
      appendEngineLog(`Cipher failed: ${error.message}`);
      setService(messagingIndicator, messagingStatus, "error", "Kasia cipher failed to load");
    }
  }
  updateServiceSummary();
  if (!failed && !quiet) setStatus("KaChat services ready");
  return !failed;
}

async function connectAndRefresh({ quiet = false } = {}) {
  if (!engine.address) {
    updateServiceSummary();
    return;
  }
  try {
    setService(networkIndicator, networkStatus, "busy", "Resolving mainnet RPC…");
    setArchitectureBadge(networkBadge, "busy", "Resolving");
    if (!quiet) setStatus("Resolving Kaspa nodes…");
    await engine.connect();
    setService(networkIndicator, networkStatus, "busy", "Connected · fetching balance…");
    setArchitectureBadge(networkBadge, "busy", "Syncing");
    if (!quiet) setStatus("Fetching wallet balance…");
    const balance = await engine.balance();
    refreshSubscriptionAddresses({ restart: false });
    await engine.startWalletSubscription({ force: false });
    currentBalanceKas = balance.totalKas ?? balance.kas ?? "--";
    updateWalletUi();
    updateServiceSummary();
    if (!quiet) setStatus("Ready");
    appendEngineLog(`Balance: ${currentBalanceKas} KAS / UTXOs: ${balance.entries.length}`);
  } catch (error) {
    setService(networkIndicator, networkStatus, "error", "Connection needs attention");
    if (!quiet) setStatus("Network unavailable");
    appendEngineLog(`Auto-connect failed: ${error.message}`);
  }
}

async function refreshBalanceOnly({ quiet = true } = {}) {
  if (!engine.address || balanceRefreshInFlight) return false;
  balanceRefreshInFlight = true;
  try {
    await engine.connect();
    const balance = await engine.balance();
    currentBalanceKas = balance.totalKas ?? balance.kas ?? "--";
    updateWalletUi();
    updateServiceSummary();
    if (!quiet) setStatus("Balance refreshed");
    return true;
  } catch (error) {
    if (!quiet) setStatus(`Refresh failed: ${error.message}`);
    appendEngineLog(`Balance refresh failed: ${error.message}`);
    return false;
  } finally {
    balanceRefreshInFlight = false;
  }
}

async function syncOneConversation(conversationEntry, { quiet = true, catchUp = false } = {}) {
  const contact = contactForConversation(conversationEntry);
  if (!contact || !engine.address || !engine.isKasiaCipherLoaded?.()) return 0;
  const knownTxids = (conversationEntry.messages || []).map((message) => message.txid).filter(Boolean);
  const indexerUrl = indexerUrlInput?.value?.trim() || getEndpoint("kasiaIndexer");
  // Message retention also raises the IMPORT floor (mirrors iOS ChatService's retention-aware
  // fetch cursor): without it the payment scan below, which re-reads the last 100 transactions
  // from scratch every sweep, would re-add the very payments the last retention pass deleted,
  // over and over. null on the default "Keep forever" — nothing is filtered then.
  const retentionFloor = messageRetentionCutoffMs();
  const olderThanRetention = (incoming) => {
    if (!retentionFloor) return false;
    const createdAt = Number(incoming?.createdAt || 0);
    return Number.isFinite(createdAt) && createdAt > 0 && createdAt < retentionFloor;
  };
  const result = await engine.syncConversationFromIndexer({
    conversationId: conversationEntry.id, contact, knownTxids,
    cursor: conversationEntry.sync?.cursor || 0, indexerUrl,
  });
  let added = 0;
  for (const incoming of result.messages || []) {
    if (olderThanRetention(incoming)) continue;
    const hiddenKeys = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
    if ((incoming.txid && hiddenKeys.has(String(incoming.txid))) || (incoming.id && hiddenKeys.has(String(incoming.id)))) continue;
    if ((conversationEntry.messages || []).some((m) => m.txid && m.txid === incoming.txid)) continue;
    const message = createMessage({ ...incoming, conversationId: conversationEntry.id, contactId: contact.id });
    applyMessagePatch(message, incoming);
    // Only a real, visible bubble notifies and counts as unread. Reactions and the
    // fresh-address payment-pool control envelopes are swallowed (return null).
    const visible = appendIncomingOrReactionMessage(conversationEntry, message);
    if (visible) {
      // Backfill (restore / first sweep) arrives silently; only live messages notify.
      if (!catchUp) maybeNotifyIncoming(conversationEntry, contact, message);
      added += 1;
    }
  }
  // The self-chat does NOT run the incoming-payment sync: payments to your own chatting address
  // are already collected (with a self-send filter) by syncStrangerPaymentsIntoSelfChat. Running
  // it here surfaced every received payment/consolidation as a "Received X KAS" bubble.
  if (contact.address !== engine.address) {
    try {
      const paymentResult = await engine.syncIncomingPayments({
        conversationId: conversationEntry.id,
        contact,
        knownTxids: (conversationEntry.messages || []).map((message) => message.txid).filter(Boolean),
        cursor: 0,
        limit: 100,
      });
      for (const incoming of paymentResult.messages || []) {
        if (olderThanRetention(incoming)) continue;
        if ((conversationEntry.messages || []).some((message) => message.txid && message.txid === incoming.txid)) continue;
        const message = createMessage({ ...incoming, conversationId: conversationEntry.id, contactId: contact.id });
        applyMessagePatch(message, incoming);
        if (appendIncomingOrReactionMessage(conversationEntry, message)) added += 1;
      }
    } catch (error) {
      appendEngineLog(`Payment sync failed for ${contact.name}: ${error.message}`);
    }
  }

  const paymentStatusChanged = await refreshPendingPaymentStatuses(conversationEntry, contact);
  if (paymentStatusChanged) persistState();
  if (added) promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist: false });
  conversationEntry.sync = {
    ...(conversationEntry.sync || {}), lastSyncAt: Date.now(), lastFound: added,
    runs: Number(conversationEntry.sync?.runs || 0) + 1,
    cursor: Number(result.nextCursor || conversationEntry.sync?.cursor || 0),
    lastNote: result.note || "Automatic Kasia sync complete.",
    scannedCount: Number(result.scannedCount || 0), decryptFailures: Number(result.decryptFailures || 0), indexerUrl,
  };
  // Backfill (restore / first sweep) is added as read; only live messages bump unread.
  if (!catchUp && added && activeConversationId !== conversationEntry.id) conversationEntry.unreadCount = Number(conversationEntry.unreadCount || 0) + added;
  if ((added || paymentStatusChanged) && activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
  if (!quiet && added) setStatus(`${added} new message${added === 1 ? "" : "s"}`);
  return added;
}

async function syncIncomingHandshakeRequests({ quiet = true } = {}) {
  if (!engine.address || !engine.isKasiaCipherLoaded?.() || typeof engine.syncIncomingHandshakesFromIndexer !== "function") return 0;
  // Handshake cursors and processed IDs must be scoped to the active wallet.
  // Step 64 reused one global cursor after wallet changes, which could skip a
  // brand-new wallet's incoming requests completely.
  if (handshakeSyncState.walletAddress !== engine.address) {
    handshakeSyncState = { walletAddress: engine.address, cursor: 0, parserVersion: 3, processedTxids: [], declinedTxids: [] };
    persistHandshakeSyncState();
    appendEngineLog(`Handshake scan reset for active wallet ${shortAddress(engine.address)}.`);
  }
  const result = await engine.syncIncomingHandshakesFromIndexer({
    knownTxids: handshakeSyncState.processedTxids,
    cursor: handshakeSyncState.cursor,
    indexerUrl: indexerUrlInput?.value || undefined,
  });
  let added = 0;
  const declined = new Set(handshakeSyncState.declinedTxids);
  for (const request of result.handshakes || []) {
    if (declined.has(request.txid)) continue;
    let contact = state.contacts.find((entry) => entry.address === request.sender);
    let conversationEntry = contact ? state.conversations.find((entry) => entry.contactId === contact.id) : null;
    let wasOutgoingRequest = false;
    // A handshake RESPONSE is the peer accepting a request WE sent — positive on-chain proof
    // the relationship was already mutual. Critical after a seed import (no local history):
    // without this, every restored two-way conversation re-surfaced as a stranger request and
    // its history stayed gated forever.
    const isAcceptance = request.isResponse === true;
    if (!contact) {
      const createdAt = Number(request.createdAt || Date.now());
      const displayName = request.alias || shortAddress(request.sender);
      contact = {
        id: nowId(), name: displayName, nameIsCustom: false, address: request.sender, avatar: initialsFor(displayName),
        createdAt, updatedAt: createdAt, relationshipState: isAcceptance ? "established" : "incoming-request", handshakeTxid: "",
        incomingHandshakeTxid: request.txid, peerConversationId: request.conversationId || "",
      };
      if (isAcceptance) wasOutgoingRequest = true; // render "Handshake completed", not an Accept card
      conversationEntry = createConversation({ contactId: contact.id, createdAt });
      state.contacts.push(contact);
      state.conversations.push(conversationEntry);
    } else {
      wasOutgoingRequest = contact.relationshipState === "outgoing-request" || isAcceptance;
      contact.incomingHandshakeTxid = request.txid;
      contact.peerConversationId = request.conversationId || contact.peerConversationId || "";
      if (wasOutgoingRequest) {
        contact.relationshipState = "established";
        for (const existingMessage of conversationEntry?.messages || []) {
          if (existingMessage.messageType === "handshake" && existingMessage.direction === "outgoing" && existingMessage.status !== MESSAGE_STATUSES.FAILED) {
            applyMessagePatch(existingMessage, { status: MESSAGE_STATUSES.CONFIRMED, note: "Handshake completed", confirmations: Math.max(1, Number(existingMessage.confirmations || 0)) });
          }
        }
      } else if (contact.relationshipState !== "established") {
        // Restored/merged history (e.g. a phone-backup restore) can already prove both sides
        // were talking — the acceptance happened on the other device, so don't resurface
        // accept/decline for a conversation we clearly replied in.
        const alreadyTalking = (conversationEntry?.messages || []).some((m) =>
          m?.direction === "outgoing" && m?.messageType !== "handshake" && String(m?.text || "").trim().length > 0);
        contact.relationshipState = alreadyTalking ? "established" : "incoming-request";
      }
      if (request.alias && (!contact.name || contact.name.startsWith("kaspa:"))) contact.name = request.alias;
      if (!conversationEntry) {
        conversationEntry = createConversation({ contactId: contact.id, createdAt: Number(request.createdAt || Date.now()) });
        state.conversations.push(conversationEntry);
      }
    }
    const exists = (conversationEntry.messages || []).some((message) => message.txid === request.txid);
    if (!exists) {
      const message = createMessage({
        conversationId: conversationEntry.id, contactId: contact.id, direction: "incoming",
        text: wasOutgoingRequest ? "Handshake completed" : "Communication request received",
        sender: request.sender, receiver: engine.address,
        status: MESSAGE_STATUSES.CONFIRMED, transport: "kasia-indexer", createdAt: Number(request.createdAt || Date.now()),
      });
      applyMessagePatch(message, {
        txid: request.txid, messageType: "handshake", protocol: "kasia", protocolVersion: 1,
        payloadHex: request.payloadHex || "", encryptedHex: request.encryptedHex || "",
        daaScore: request.daaScore || null, acceptingBlock: request.acceptingBlock || null, confirmations: 1,
        note: wasOutgoingRequest ? "Handshake completed" : "Incoming communication request",
      });
      appendIncomingOrReactionMessage(conversationEntry, message);
      conversationEntry.unreadCount = Number(conversationEntry.unreadCount || 0) + 1;
      added += 1;
    }
    handshakeSyncState.processedTxids = [...new Set([...handshakeSyncState.processedTxids, request.txid])];
  }
  handshakeSyncState.walletAddress = engine.address;
  handshakeSyncState.cursor = Math.max(Number(handshakeSyncState.cursor || 0), Number(result.nextCursor || 0));
  persistHandshakeSyncState();
  appendEngineLog(`Incoming handshake audit: ${result.indexerScannedCount || 0} indexer row(s), ${result.restScannedCount || 0} REST row(s), ${added} new request(s)${result.errors?.length ? ` · ${result.errors.join(" | ")}` : ""}.`);
  if (added) {
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    if (activeConversationId) {
      const active = state.conversations.find((entry) => entry.id === activeConversationId);
      if (active) renderMessages(active);
    } else renderChats();
    if (!quiet) setStatus(`${added} incoming communication request${added === 1 ? "" : "s"}`);
  }
  return added;
}

// Restore-parity pass (matches iOS): handshakes WE sent — requests we initiated and our
// acceptances of others' requests. After a seed import these are the only on-chain proof a
// conversation was mutual (our own acceptance never appears in handshakes/by-receiver), so
// without this pass those threads re-surfaced as stranger requests. Creates/promotes the peer
// as established with an outgoing "Handshake sent" row (payload is encrypted for the recipient
// — undecryptable by design; existence is the evidence).
async function syncOutgoingHandshakeEvidence({ quiet = true } = {}) {
  if (!engine.address || typeof engine.syncOutgoingHandshakesFromIndexer !== "function") return 0;
  const result = await engine.syncOutgoingHandshakesFromIndexer({
    cursor: handshakeSyncState.outCursor || 0,
    indexerUrl: indexerUrlInput?.value || undefined,
  });
  let added = 0;
  for (const hs of result.handshakes || []) {
    if (hs.receiver === engine.address) continue; // self-stash copies aren't a peer conversation
    let contact = state.contacts.find((c) => c.address === hs.receiver);
    let conversationEntry = contact ? state.conversations.find((c) => c.contactId === contact.id) : null;
    if (!contact) {
      const displayName = shortAddress(hs.receiver);
      contact = {
        id: nowId(), name: displayName, nameIsCustom: false, address: hs.receiver, avatar: initialsFor(displayName),
        createdAt: hs.createdAt, updatedAt: hs.createdAt, relationshipState: "established",
        handshakeTxid: hs.txid, incomingHandshakeTxid: "", peerConversationId: "",
      };
      state.contacts.push(contact);
    } else if (contact.relationshipState !== "established") {
      contact.relationshipState = "established"; // we provably handshook them — never a stranger
      if (!contact.handshakeTxid) contact.handshakeTxid = hs.txid;
    }
    if (!conversationEntry) {
      conversationEntry = createConversation({ contactId: contact.id, createdAt: hs.createdAt });
      state.conversations.push(conversationEntry);
    }
    if (!(conversationEntry.messages || []).some((m) => m.txid === hs.txid)) {
      const message = createMessage({
        conversationId: conversationEntry.id, contactId: contact.id, direction: "outgoing",
        text: "Handshake sent", sender: engine.address, receiver: hs.receiver,
        status: MESSAGE_STATUSES.CONFIRMED, transport: "kasia-indexer", createdAt: hs.createdAt,
      });
      applyMessagePatch(message, {
        txid: hs.txid, messageType: "handshake", protocol: "kasia", protocolVersion: 1,
        payloadHex: hs.payloadHex || "", confirmations: 1, note: "Handshake sent",
      });
      conversationEntry.messages.push(message);
      added += 1;
    }
  }
  if (Number(result.nextCursor || 0) > Number(handshakeSyncState.outCursor || 0)) {
    handshakeSyncState.outCursor = Number(result.nextCursor);
    persistHandshakeSyncState();
  }
  if (added > 0) { persistState(); renderChats(); }
  return added;
}

// ---------------------------------------------------------------------------
// Stranger payments → the SELF-chat. A plain KAS payment from an address we have
// no contact for must NOT open a chat with the stranger: it collects in a single
// conversation with our own chatting address, noting the sender in the bubble.
// Baseline-gated (first run just records "now") so historical payments never
// flood in; internal moves from the own spending chain surface nowhere.
// ---------------------------------------------------------------------------
const STRANGER_PAYMENT_STATE_KEY = "kachat-stranger-payment-state-v1"; // account-scoped: { baselineMs, processedTxids }
const KACHAT_PAYLOAD_HEX_PREFIX = "636970685f6d7367"; // "ciph_msg" — handled by the normal message sync

function loadStrangerPaymentState() {
  try {
    const raw = JSON.parse(localStorage.getItem(accountScopedKey(STRANGER_PAYMENT_STATE_KEY)) || "{}") || {};
    return { baselineMs: Number(raw.baselineMs) || 0, processedTxids: Array.isArray(raw.processedTxids) ? raw.processedTxids : [] };
  } catch { return { baselineMs: 0, processedTxids: [] }; }
}

function saveStrangerPaymentState(store) {
  try { localStorage.setItem(accountScopedKey(STRANGER_PAYMENT_STATE_KEY), JSON.stringify(store)); } catch {}
}

function ensureSelfConversation() {
  let contact = state.contacts.find((entry) => entry.address === engine.address);
  if (!contact) {
    const createdAt = Date.now();
    contact = {
      id: nowId(), name: "My Address", nameIsCustom: true, address: engine.address,
      avatar: initialsFor("My Address"), createdAt, updatedAt: createdAt,
      relationshipState: "legacy-manual", handshakeTxid: "",
    };
    state.contacts.push(contact);
  }
  let conversationEntry = state.conversations.find((entry) => entry.contactId === contact.id);
  if (!conversationEntry) {
    conversationEntry = createConversation({ contactId: contact.id, createdAt: Date.now() });
    state.conversations.push(conversationEntry);
  }
  return { contact, conversationEntry };
}

// Keep a "Note to Self" chat present (unless the user deleted it) so it appears in the list to
// write in, AND so the per-contact COMM sweep runs against your own address — that's what carries
// your notes-to-self across all your devices. Idempotent; respects a prior self-chat deletion.
function ensureSelfChatForSync() {
  const myAddress = engine.address;
  if (!myAddress) return;
  if (loadDeletedContactAddresses().has(myAddress)) return; // respect deletion
  const hasConversation = (state.conversations || []).some((cv) => contactForConversation(cv)?.address === myAddress);
  if (!hasConversation) ensureSelfConversation();
}

async function syncStrangerPaymentsIntoSelfChat({ catchUp = false } = {}) {
  const myAddress = engine.address;
  if (!myAddress) return 0;
  const store = loadStrangerPaymentState();
  if (!store.baselineMs) {
    // First run for this account: record the baseline and start collecting from now.
    store.baselineMs = Date.now();
    saveStrangerPaymentState(store);
    return 0;
  }
  // The user deleted the self-chat — respect it.
  if (loadDeletedContactAddresses().has(myAddress)) return 0;
  let txs = [];
  try {
    const url = `${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(myAddress)}/full-transactions?limit=20&offset=0&resolve_previous_outpoints=light`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return 0;
    txs = await response.json();
  } catch { return 0; }
  if (!Array.isArray(txs)) return 0;

  const processed = new Set(store.processedTxids);
  const contactAddresses = new Set((state.contacts || []).map((entry) => entry.address));
  const ownSpending = new Set(activeAccountMnemonic() ? spendingWatchedAddressList() : []);
  let added = 0;
  for (const tx of txs) {
    const txid = String(tx?.transaction_id || tx?.transactionId || "").trim();
    if (!txid || processed.has(txid)) continue;
    const blockTime = Number(tx?.block_time || tx?.blockTime || 0);
    if (!blockTime || blockTime < store.baselineMs) { processed.add(txid); continue; }
    // KaChat protocol txs (messages/handshakes/payments-with-envelopes) are owned by
    // the normal per-contact sync — only PLAIN payments belong here.
    const payload = String(tx?.payload || "").toLowerCase();
    if (payload.startsWith(KACHAT_PAYLOAD_HEX_PREFIX)) { processed.add(txid); continue; }
    const receivedSompi = (Array.isArray(tx?.outputs) ? tx.outputs : [])
      .filter((output) => (output?.script_public_key_address || output?.scriptPublicKeyAddress) === myAddress)
      .reduce((sum, output) => sum + Number(output?.amount || 0), 0);
    if (!(receivedSompi > 0)) { processed.add(txid); continue; }
    const sender = (Array.isArray(tx?.inputs) ? tx.inputs : [])
      .map((input) => input?.previous_outpoint_address || input?.previousOutpointAddress)
      .find((address) => address && address !== myAddress) || "";
    if (!sender) continue; // input may resolve on a later sweep — retry then
    processed.add(txid);
    if (contactAddresses.has(sender)) continue; // that contact's own sync owns it
    if (ownSpending.has(sender)) continue; // internal move from the own spending chain
    const { contact, conversationEntry } = ensureSelfConversation();
    if ((conversationEntry.messages || []).some((entry) => entry.txid === txid)) continue;
    const amountKas = trimKas8(receivedSompi / 1e8);
    const message = createMessage({
      conversationId: conversationEntry.id,
      contactId: contact.id,
      direction: "incoming",
      text: `Received ${amountKas} KAS\nFrom: ${sender}`,
      sender,
      receiver: myAddress,
      status: MESSAGE_STATUSES.CONFIRMED,
      transport: "kaspa-payment",
      createdAt: blockTime || Date.now(),
    });
    applyMessagePatch(message, { messageType: "payment", paymentAmountKas: String(amountKas), txid });
    appendIncomingOrReactionMessage(conversationEntry, message);
    conversationEntry.updatedAt = Date.now();
    if (!catchUp) {
      const appended = conversationEntry.messages.find((entry) => entry.txid === txid) || message;
      maybeNotifyIncoming(conversationEntry, contact, appended);
      // Received KAS at your chatting address — also list it in the global notifications bell.
      recordGlobalNotification({
        id: `wallet-${txid}`,
        source: "wallet",
        title: `Received ${amountKas} KAS`,
        body: "Your chatting address",
        timestamp: Date.now(),
        targetKind: "wallet",
      });
    }
    if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
    added += 1;
  }
  store.processedTxids = [...processed].slice(-300);
  saveStrangerPaymentState(store);
  if (added > 0) { persistState(); renderChats(); }
  return added;
}

async function refreshAllConversations({ quiet = true } = {}) {
  if (messageRefreshInFlight || !engine.address || !engine.isKasiaCipherLoaded?.()) return 0;
  messageRefreshInFlight = true;
  // The first real sweep after a load/switch/restore is a history backfill, not live
  // traffic — suppress its notifications and unread badges (see pendingInitialCatchUp).
  const catchUp = pendingInitialCatchUp;
  let added = 0;
  try {
    ensureSelfChatForSync();
    try { added += await syncIncomingHandshakeRequests({ quiet }); }
    catch (error) { appendEngineLog(`Incoming handshake sync failed: ${error.message}`); }
    try { added += await syncOutgoingHandshakeEvidence({ quiet }); }
    catch (error) { appendEngineLog(`Outgoing handshake sync failed: ${error.message}`); }
    try { added += await syncStrangerPaymentsIntoSelfChat({ catchUp }); }
    catch (error) { appendEngineLog(`Stranger payment sweep failed: ${error.message}`); }
    // Per-contact sync runs 4 wide instead of strictly sequentially — with many contacts
    // the serial loop was ~2 awaited round trips per contact and the whole sweep barely
    // finished before the next 5s tick was due, starving the later contacts. 4 concurrent
    // keeps the indexer load civilised while cutting wall-clock ~4x.
    const sweepTargets = (state.conversations || []).filter((conversationEntry) => {
      const contact = contactForConversation(conversationEntry);
      // The self-chat IS swept via the per-contact COMM sync now — that's what carries your own
      // notes-to-self across your devices (by-sender(self) + your-key decrypt returns only self→
      // self messages; the cursor keeps the ongoing cost tiny). Stranger PAYMENTS to your chatting
      // address are still handled separately by syncStrangerPaymentsIntoSelfChat above.
      // Match KaChat's relationship boundary: discovering an incoming
      // handshake must not import that unknown sender's historical contextual
      // messages before the user accepts the request.
      if (contact?.relationshipState === "incoming-request" || contact?.relationshipState === "declined") return false;
      return true;
    });
    let sweepNext = 0;
    await Promise.all(Array.from({ length: Math.min(4, sweepTargets.length) }, async () => {
      while (sweepNext < sweepTargets.length) {
        const conversationEntry = sweepTargets[sweepNext++];
        try { added += await syncOneConversation(conversationEntry, { quiet, catchUp }); }
        catch (error) { appendEngineLog(`Automatic message sync failed for ${conversationEntry.id}: ${error.message}`); }
      }
    }));
    try { added += await syncGroupsNow({ catchUp }); }
    catch (error) { appendEngineLog(`Group sync failed: ${error.message}`); }
    // Persist and re-render ONLY when the sweep actually changed something. state holds
    // every inline base64 photo/voice message, so the unconditional persist here was two
    // full multi-MB JSON.stringify passes + a string compare on the main thread every 5
    // seconds forever — the single biggest source of periodic typing/scroll hitches. The
    // chat-list rebuild on every sweep also killed hover/selection for no reason.
    if (added > 0) {
      persistState();
      if (!activeConversationId) renderChats();
    }
    return added;
  } finally {
    messageRefreshInFlight = false;
    // Only the sweep that actually ran as the backfill clears the flag, so a restore
    // that arms it mid-sweep still gets its own silent sweep next time.
    if (catchUp) pendingInitialCatchUp = false;
  }
}

function startAutomaticRefresh() {
  // Hidden-tab polls burn network + CPU for a page nobody is looking at; the
  // visibilitychange handler already forces a full refresh the moment the tab returns.
  if (!balanceRefreshTimer) balanceRefreshTimer = window.setInterval(() => { if (!document.hidden) refreshBalanceOnly({ quiet: true }); }, BALANCE_REFRESH_MS);
  if (!messageRefreshTimer) messageRefreshTimer = window.setInterval(() => { if (!document.hidden) refreshAllConversations({ quiet: true }); }, MESSAGE_REFRESH_MS);
}

function renderTransportReadiness() {
  updateServiceSummary();
  if (!readinessList) return;
  const items = [
    { label: "Engine message facade", ready: typeof engine.createMessageEnvelope === "function" && typeof engine.sendMessagePreview === "function" },
    { label: "Kasia COMM protocol builder", ready: typeof engine.buildCommMessage === "function", note: "matched wire container" },
    { label: "Official Kasia cipher WASM", ready: engine.isKasiaCipherLoaded?.() === true, note: engine.isKasiaCipherLoaded?.() ? "loaded / encrypted direct messages" : "run setup:cipher, then load" },
    { label: "Rusty Kaspa WASM loaded", ready: Boolean(engine.kaspa) },
    { label: "Session wallet loaded", ready: Boolean(engine.address) },
    { label: "Mainnet RPC connected", ready: Boolean(engine.rpc) },
    { label: "Live wallet and contact UTXO subscriptions", ready: engine.subscriptionSnapshot?.().status === "ready", note: `${engine.subscriptionSnapshot?.().contactCount || 0} contacts · ${engine.subscriptionSnapshot?.().status || "idle"}` },
    { label: "Real on-chain payload transport", ready: typeof engine.sendMessageOnchain === "function", note: "enabled / 0.2 KAS default" },
    { label: "Incoming Kasia payload decoder", ready: typeof engine.parseKasiaPayloadHex === "function", note: "preview" },
    { label: "Real Kasia indexer sync", ready: typeof engine.syncConversationFromIndexer === "function", note: getEndpointOverride("kasiaIndexer") || ENDPOINT_DEFAULTS.kasiaIndexer },
    { label: "Manual payload import", ready: typeof engine.parseKasiaPayloadHex === "function", note: "decoder" },
  ];

  readinessList.innerHTML = items.map((item) => `
    <div class="readiness-row ${item.ready ? "ready" : "pending"}">
      <span>${item.ready ? "✓" : "○"}</span>
      <strong>${escapeHtml(item.label)}</strong>
      <em>${escapeHtml(item.note || (item.ready ? "ready" : "not ready"))}</em>
    </div>
  `).join("");
}

// Step 104 — Settings-only overlay (Profile is its own full tab screen now,
// see setActiveAppTab below). Opened via the topbar health button or the
// gear icon on the Profile screen.
const accountOverlay = document.querySelector("[data-account-overlay]");

function openAccountOverlay() {
  accountOverlay.hidden = false;
  renderTransportReadiness();
  updateLocalStorageUsedLabel();
}

function closeAccountOverlay() {
  accountOverlay.hidden = true;
}

document.querySelector("[data-close-account-overlay]").addEventListener("click", closeAccountOverlay);
accountOverlay.addEventListener("click", (event) => {
  if (event.target === accountOverlay) closeAccountOverlay();
});

const connectionOverlay = document.querySelector("[data-connection-overlay]");

function openConnectionOverlay() {
  connectionOverlay.hidden = false;
  selectedNodeMode = null; // re-sync the node-mode cards to the saved setting
  renderConnectionStatus();
}

function closeConnectionOverlay() {
  connectionOverlay.hidden = true;
}

document.querySelector("[data-open-connection-status]")?.addEventListener("click", openConnectionOverlay);
document.querySelector("[data-close-connection-overlay]").addEventListener("click", closeConnectionOverlay);
connectionOverlay.addEventListener("click", (event) => {
  if (event.target === connectionOverlay) closeConnectionOverlay();
});

// --- Global notification center --------------------------------------------
// The bell in the top bar opens ONE feed aggregating KaPosts notifications, group-chat
// @mentions, and broadcast activity. Sources call recordGlobalNotification(); items are
// account-scoped and persist across reloads. Clicking a row routes to the relevant tab.
const NOTIF_CENTER_KEY = "kachat-notif-center-v1";
const NOTIF_CENTER_SEEN_KEY = "kachat-notif-center-seen-v1";
const NOTIF_CENTER_MAX = 100;
// Broadcast messages older than this (the app-load moment) are treated as history, not live
// arrivals, so the backfill on startup doesn't flood the center.
const NOTIF_SESSION_START = Date.now();
const notifOverlay = document.querySelector("[data-notif-overlay]");
let globalNotifications = [];
let notifCenterLastSeenAt = 0;
const NOTIF_SOURCE_LABELS = { kaposts: "KaPosts", group: "Group", broadcast: "Broadcast", wallet: "Wallet" };

function loadNotifCenter() {
  try { globalNotifications = JSON.parse(localStorage.getItem(accountScopedKey(NOTIF_CENTER_KEY)) || "[]"); }
  catch { globalNotifications = []; }
  if (!Array.isArray(globalNotifications)) globalNotifications = [];
  notifCenterLastSeenAt = Number(localStorage.getItem(accountScopedKey(NOTIF_CENTER_SEEN_KEY)) || 0) || 0;
  updateNotifBadge();
  if (notifOverlay && !notifOverlay.hidden) renderNotifCenter();
}
function persistNotifCenter() {
  try { localStorage.setItem(accountScopedKey(NOTIF_CENTER_KEY), JSON.stringify(globalNotifications.slice(0, NOTIF_CENTER_MAX))); } catch {}
}
function recordGlobalNotification(item) {
  const id = String(item?.id || "");
  if (!id || globalNotifications.some((n) => n.id === id)) return;
  globalNotifications.unshift({
    id,
    source: item.source || "kaposts",
    title: String(item.title || ""),
    body: String(item.body || ""),
    timestamp: Number(item.timestamp) || Date.now(),
    targetKind: item.targetKind || item.source || null,
    targetId: item.targetId || null,
  });
  globalNotifications = globalNotifications.slice(0, NOTIF_CENTER_MAX);
  persistNotifCenter();
  updateNotifBadge();
  if (notifOverlay && !notifOverlay.hidden) renderNotifCenter();
}
function unreadNotifCount() {
  return globalNotifications.filter((n) => n.timestamp > notifCenterLastSeenAt).length;
}
function updateNotifBadge() {
  const badge = document.querySelector("[data-notif-badge]");
  if (!badge) return;
  // A plain red dot, not a number — "there is something unread" is the whole signal.
  badge.textContent = "";
  badge.hidden = unreadNotifCount() === 0;
}
function renderNotifCenter() {
  const list = document.querySelector("[data-notif-list]");
  if (!list) return;
  if (!globalNotifications.length) {
    list.innerHTML = `<div class="notif-center-empty">No notifications yet</div>`;
    return;
  }
  list.innerHTML = globalNotifications.map((n) => `
    <button type="button" class="notif-center-row${n.timestamp > notifCenterLastSeenAt ? " unread" : ""}" data-notif-id="${escapeHtml(n.id)}">
      <span class="notif-center-source notif-src-${escapeHtml(n.source)}">${escapeHtml(NOTIF_SOURCE_LABELS[n.source] || "")}</span>
      <span class="notif-center-copy"><strong>${escapeHtml(n.title)}</strong>${n.body ? `<small>${escapeHtml(n.body)}</small>` : ""}</span>
      <span class="notif-center-time">${escapeHtml(formatRelativeTime(n.timestamp))}</span>
    </button>`).join("");
}
function openNotifCenter() {
  if (!notifOverlay) return;
  renderNotifCenter(); // render with current unread styling first
  notifOverlay.hidden = false;
  notifCenterLastSeenAt = Date.now();
  try { localStorage.setItem(accountScopedKey(NOTIF_CENTER_SEEN_KEY), String(notifCenterLastSeenAt)); } catch {}
  updateNotifBadge();
}
function closeNotifCenter() {
  if (notifOverlay) notifOverlay.hidden = true;
  renderNotifCenter(); // clears unread highlight for next open
}
document.querySelector("[data-open-notif-center]")?.addEventListener("click", openNotifCenter);
document.querySelector("[data-close-notif-center]")?.addEventListener("click", closeNotifCenter);
notifOverlay?.addEventListener("click", (event) => { if (event.target === notifOverlay) closeNotifCenter(); });
document.querySelector("[data-notif-clear]")?.addEventListener("click", () => {
  globalNotifications = [];
  persistNotifCenter();
  updateNotifBadge();
  renderNotifCenter();
});
document.querySelector("[data-notif-list]")?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-notif-id]");
  if (!row) return;
  const notif = globalNotifications.find((n) => n.id === row.dataset.notifId);
  closeNotifCenter();
  if (!notif) return;
  if (notif.targetKind === "broadcast") {
    setActiveAppTab("broadcasts");
    // Land in the exact channel the message arrived in, not just the tab.
    if (notif.targetId) { try { openBroadcastChannelFromNotification(notif.targetId); } catch {} }
  } else if (notif.targetKind === "group") {
    setActiveAppTab("chats");
    if (notif.targetId) { try { openGroupChat(notif.targetId); } catch {} }
  } else if (notif.targetKind === "wallet") {
    // Received-Kaspa rows open the Portfolio tab.
    setActiveAppTab("portfolio");
  } else {
    setActiveAppTab("kaposts");
    // KaPosts rows deep-open the exact post/comment when a target txid was recorded.
    if (notif.targetKind === "kaposts" && notif.targetId) {
      try { openKaPostFromNotification(notif.targetId); } catch {}
    }
  }
});
loadNotifCenter();

document.querySelector("[data-connection-reconnect]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await connectAndRefresh(); }
  finally { button.disabled = false; renderConnectionStatus(); }
});

// "Scan for a Better Node": force a fresh primary (re-resolves in Automatic mode) and
// warm a new standby, so the user can manually hop to a fast, healthy node.
document.querySelector("[data-connection-scan]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Scanning…";
  try {
    setStatus("Scanning for a healthy node…");
    if (!engine.kaspa) await engine.loadWasm();
    await engine.connect({ force: true });
    await engine.ensureStandby?.();
    await connectAndRefresh({ quiet: true });
    showCopyToast("Reconnected to a healthy node");
  } catch (error) {
    setStatus("Scan failed");
    showCopyToast(`Scan failed. ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
    renderConnectionStatus();
  }
});

// Node-selection cards: Automatic (resolver) vs Custom (a specific wRPC URL). The
// selection is staged in the UI and only committed to the trustedNode endpoint on Apply.
let selectedNodeMode = null;
function currentSavedNodeMode() {
  return getEndpointOverride("trustedNode").trim() ? "custom" : "auto";
}
function renderNodeModeCards() {
  if (selectedNodeMode == null) selectedNodeMode = currentSavedNodeMode();
  document.querySelectorAll("[data-node-mode]").forEach((card) => {
    card.classList.toggle("selected", card.dataset.nodeMode === selectedNodeMode);
  });
  const input = document.querySelector("[data-custom-node-url]");
  if (input) {
    input.disabled = selectedNodeMode !== "custom";
    if (document.activeElement !== input) input.value = getEndpointOverride("trustedNode") || "";
  }
}

function selectNodeModeCard(card) {
  if (!card) return;
  selectedNodeMode = card.dataset.nodeMode;
  renderNodeModeCards();
  if (selectedNodeMode === "custom") document.querySelector("[data-custom-node-url]")?.focus();
}
document.querySelector("[data-node-mode-cards]")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-custom-node-url]")) return; // let the input handle its own clicks
  selectNodeModeCard(event.target.closest("[data-node-mode]"));
});
document.querySelector("[data-node-mode-cards]")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-node-mode]");
  if (!card || event.target.closest("[data-custom-node-url]")) return;
  event.preventDefault();
  selectNodeModeCard(card);
});

document.querySelector("[data-node-apply]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const errorEl = document.querySelector("[data-node-mode-error]");
  const input = document.querySelector("[data-custom-node-url]");
  const mode = selectedNodeMode || currentSavedNodeMode();
  let url = "";
  if (mode === "custom") {
    url = String(input?.value || "").trim();
    if (!/^wss?:\/\/.+/i.test(url)) {
      if (errorEl) { errorEl.textContent = "Enter a valid wRPC URL that starts with wss:// or ws://"; errorEl.hidden = false; }
      return;
    }
  }
  if (errorEl) errorEl.hidden = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = mode === "custom" ? "Checking your node…" : "Reconnecting…";
  try {
    if (!engine.kaspa) await engine.loadWasm();
    if (mode === "custom") {
      // Strict: confirm the user's node is reachable, synced, and on mainnet BEFORE we
      // switch to it. If it fails we surface the error and leave the current node as-is,
      // never silently falling back to a public one.
      setStatus("Checking your node…");
      await engine.verifyNode(url);
    }
    // Leaving a custom node for Automatic: forget that node entirely, otherwise Automatic would
    // immediately reconnect to it via last-good / the standby pool. The user asked for it to be
    // removed and only auto-discovered nodes used.
    if (mode !== "custom") {
      const previousCustom = getEndpointOverride("trustedNode").trim();
      // Purge both the URL the user typed AND the URL we're actually connected on — the WASM
      // client can normalize the endpoint, so the registry key may differ from the typed value.
      const liveEndpoint = engine.rpc?.url || engine.connectionSnapshot?.().primaryEndpoint || "";
      if (previousCustom) engine.forgetNode?.(previousCustom);
      if (liveEndpoint) engine.forgetNode?.(liveEndpoint);
    }
    setEndpoint("trustedNode", url); // "" clears the override, returning to Automatic
    setStatus(mode === "custom" ? "Connecting to your node…" : "Finding a healthy node…");
    await engine.connect({ force: true });
    await connectAndRefresh({ quiet: true });
    showCopyToast(mode === "custom" ? "Connected to your node" : "Connected automatically");
  } catch (error) {
    if (errorEl) { errorEl.textContent = `Could not connect: ${error.message}`; errorEl.hidden = false; }
    setStatus("Connection failed");
  } finally {
    button.disabled = false;
    button.textContent = label;
    renderConnectionStatus();
  }
});

// Step 102/104 — 5-tab bottom-center navigation. Cold Storage/Portfolio/Swaps
// are placeholder screens for now; Chats is the existing sidebar+detail view;
// Profile is its own full-tab screen (mocked up to match iOS 3.0's design).
const sidebarTabButtons = document.querySelectorAll("[data-app-tab]");
const appTabScreens = document.querySelectorAll("[data-app-tab-screen]");

// Own-account version of the Chat Info Domains/Profile display: shows the
// resolved KNS domain + bio/links for the active wallet's own address when it
// owns one, otherwise shows the "Create KNS Profile" CTA that opens the
// registration wizard. This lookup itself is read-only.
let ownKnsAssetId = null;
let ownKnsProfileFields = null;

function updateProfileHero(info, profileInfo) {
  const bannerEl = document.querySelector("[data-profile-hero-banner]");
  const avatarEl = document.querySelector("[data-profile-hero-avatar]");
  const nameEl = document.querySelector("[data-profile-hero-name]");
  const bioEl = document.querySelector("[data-profile-hero-bio]");
  const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
  const displayName = domain
    ? (domain.toLowerCase().endsWith(".kas") ? domain.slice(0, -4) : domain)
    : (activeAccountMetadata().name || "Account");
  if (nameEl) nameEl.textContent = displayName;
  const bio = profileInfo?.profile?.bio || "";
  if (bioEl) { bioEl.hidden = !bio; bioEl.textContent = bio; }
  const bannerUrl = profileInfo?.profile?.bannerUrl || "";
  if (bannerEl) bannerEl.style.backgroundImage = bannerUrl ? `url("${bannerUrl}")` : "";
  const avatarUrl = profileInfo?.profile?.avatarUrl || "";
  if (avatarEl) {
    avatarEl.innerHTML = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" />`
      : `<svg viewBox="0 0 24 24"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.118a7.5 7.5 0 0 1 15 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.5-1.632Z"/></svg>`;
  }
}

async function refreshOwnKnsProfile() {
  if (!engine.address || !profileKnsOwned || !profileKnsEmptyCta) return;
  const address = engine.address;
  const [info, profileInfo] = await Promise.all([
    engine.fetchKnsAddressInfo(address).catch(() => null),
    engine.fetchKnsAddressProfile(address).catch(() => null),
  ]);
  if (engine.address !== address) return; // account switched mid-fetch
  updateProfileHero(info, profileInfo);

  if (!info?.primaryDomain) {
    profileKnsEmptyCta.hidden = false;
    profileKnsOwned.hidden = true;
    ownKnsAssetId = null;
    ownKnsProfileFields = null;
    return;
  }

  profileKnsEmptyCta.hidden = true;
  profileKnsOwned.hidden = false;
  if (profileKnsDomain) profileKnsDomain.textContent = info.primaryDomain;
  ownKnsAssetId = info.primaryInscriptionId || null;
  ownKnsProfileFields = profileInfo?.profile || null;

  const profile = profileInfo?.profile;
  if (profileKnsBio) {
    if (profile?.bio) { profileKnsBio.textContent = profile.bio; profileKnsBio.hidden = false; }
    else profileKnsBio.hidden = true;
  }
  if (profileKnsLinks) {
    profileKnsLinks.replaceChildren();
    const linkDefs = [
      ["website", "Website", KNSProfileLinkBuilder.websiteUrl],
      ["x", "X", KNSProfileLinkBuilder.xUrl],
      ["telegram", "Telegram", KNSProfileLinkBuilder.telegramUrl],
      ["discord", "Discord", KNSProfileLinkBuilder.discordUrl],
      ["github", "GitHub", KNSProfileLinkBuilder.githubUrl],
      ["contactEmail", "Email", KNSProfileLinkBuilder.emailUrl],
    ];
    for (const [field, label, builder] of linkDefs) {
      const raw = profile?.[field];
      if (!raw) continue;
      const href = builder(raw);
      if (!href) continue;
      const link = document.createElement("a");
      link.className = "chat-info-social-link";
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = label;
      profileKnsLinks.appendChild(link);
    }
  }
}

// The KNS indexer can lag a few seconds behind a freshly revealed domain, so a
// single refresh right after registration may still report "no domain" and
// leave the row reading "Create KNS Profile". Re-check a handful of times (with
// the cache cleared each round) so the row flips to the edit variant on its own,
// no reload needed. A newer call, or an account switch, cancels the poll.
let ownKnsProfileRefreshToken = 0;
async function refreshOwnKnsProfileUntilResolved({ attempts = 6, delayMs = 5000 } = {}) {
  const token = ++ownKnsProfileRefreshToken;
  const address = engine.address;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      if (token !== ownKnsProfileRefreshToken || engine.address !== address) return;
      engine.clearKnsCache?.(address);
    }
    await refreshOwnKnsProfile();
    if (token !== ownKnsProfileRefreshToken || engine.address !== address) return;
    if (profileKnsOwned && !profileKnsOwned.hidden) return; // domain is live: row now reads "Edit KNS Profile"
  }
}

// --- Spending addresses (m/44'/111111'/1'/0/N). A second BIP44 account branch
// off the same seed, derived live from the recovery phrase + passphrase so the
// exact addresses restore identically on iOS/Android/desktop. Only the index
// bounds, hidden set, and labels are persisted (per wallet address), mirroring
// iOS's WalletManager+SpendingAddresses UserDefaults model. ---
const SPENDING_STATE_KEY = "kachat-spending-state-v1";
const spendingBalanceEl = document.querySelector("[data-spending-balance]");
const spendingManageScreen = document.querySelector("[data-spending-manage-screen]");
const spendingListEl = document.querySelector("[data-spending-address-list]");
const spendingGenerateBtn = document.querySelector("[data-spending-generate]");
const spendingScanBtn = document.querySelector("[data-spending-scan]");
const spendingConsolidateBtn = document.querySelector("[data-spending-consolidate]");
const spendingActionsToggle = document.querySelector("[data-spending-actions-toggle]");
const spendingActionsMenu = document.querySelector("[data-spending-actions-menu]");
// Address Visibility screen (iOS parity: SpendingAddressVisibilityView) — compact paged
// checklist of every address so dozens can be hidden/revealed in one sitting.
const spendingVisibilityScreen = document.querySelector("[data-spending-visibility-screen]");
const spendingVisibilityList = document.querySelector("[data-spending-visibility-list]");
const spendingVisibilityOpenBtn = document.querySelector("[data-open-spending-visibility]");
const spendingVisibilityCloseBtn = document.querySelector("[data-close-spending-visibility]");
const spendingVisibilityDoneBtn = document.querySelector("[data-done-spending-visibility]");
const spendingVisPrevBtn = document.querySelector("[data-spending-vis-prev]");
const spendingVisNextBtn = document.querySelector("[data-spending-vis-next]");
const spendingVisRangeEl = document.querySelector("[data-spending-vis-range]");
let activeSpendingAddress = null;
let spendingConsolidating = false;
let spendingListToken = 0;
const SPENDING_GAP_LIMIT = 20;

function activeAccountMnemonic() {
  return activeSavedAccountRecord()?.mnemonic || "";
}

function activeAccountPassphrase() {
  return activeSavedAccountRecord()?.passphrase || "";
}

// Identity derivation family + chatting-chain index chosen at import (iOS
// WalletManager.currentWalletSourceFamily / currentChattingAddressIndex).
// Persisted on the saved-account record, so they survive reloads and are
// honored by every path that re-derives the identity from the seed.
function activeAccountSourceFamily() {
  return String(activeSavedAccountRecord()?.sourceFamily || "kaspaStandard");
}

function activeChattingIndex() {
  return Math.max(0, Math.floor(Number(activeSavedAccountRecord()?.chattingIndex || 0)));
}

function loadAllSpendingState() {
  try { return JSON.parse(localStorage.getItem(SPENDING_STATE_KEY) || "{}") || {}; }
  catch { return {}; }
}

// Per-wallet spending state, sanitized. maxIndex is always ≥ activeIndex so the
// active address can never fall outside the revealed range.
function getSpendingState(address = engine.address) {
  const raw = (loadAllSpendingState() || {})[address] || {};
  const activeIndex = Math.max(0, Math.floor(Number(raw.activeIndex) || 0));
  const maxIndex = Math.max(activeIndex, Math.floor(Number(raw.maxIndex) || 0));
  const hidden = Array.isArray(raw.hidden)
    ? Array.from(new Set(raw.hidden.map(Number).filter((n) => Number.isInteger(n) && n >= 0)))
    : [];
  const labels = raw.labels && typeof raw.labels === "object" ? { ...raw.labels } : {};
  return { activeIndex, maxIndex, hidden, labels };
}

function saveSpendingState(patch, address = engine.address) {
  if (!address) return getSpendingState(address);
  const all = loadAllSpendingState();
  const next = { ...getSpendingState(address), ...patch };
  next.activeIndex = Math.max(0, Math.floor(Number(next.activeIndex) || 0));
  next.maxIndex = Math.max(next.activeIndex, Math.floor(Number(next.maxIndex) || 0));
  all[address] = next;
  localStorage.setItem(SPENDING_STATE_KEY, JSON.stringify(all));
  return next;
}

function getActiveSpendingIndex() {
  return getSpendingState().activeIndex;
}

// Memoized per (account, index): every derivation re-runs BIP39 seeding
// (PBKDF2), so looped callers (address list, watched-set builders, payment
// pool reservations) would otherwise pay that cost per call.
const spendingAddressMemo = new Map();

function deriveSpendingAddressAt(index) {
  const mnemonic = activeAccountMnemonic();
  if (!mnemonic || !engine.kaspa) return null;
  const memoKey = `${engine.address || ""}:${index}`;
  const cached = spendingAddressMemo.get(memoKey);
  if (cached) return cached;
  try {
    const address = engine.deriveSpendingWallet(mnemonic, index, activeAccountPassphrase()).address;
    if (address) spendingAddressMemo.set(memoKey, address);
    return address;
  }
  catch (error) { appendEngineLog(`Spending derive #${index} failed: ${error.message}`); return null; }
}

function spendingLabelFor(state, index) {
  const custom = state.labels?.[index] ?? state.labels?.[String(index)];
  const trimmed = custom != null ? String(custom).trim() : "";
  if (trimmed) return trimmed;
  return index === 0 ? "Primary spending" : `Spending #${index}`;
}

// ---------------------------------------------------------------------------
// Address Activity notifications (iOS AddressActivityNotifier port).
//
// Alerts when any own NON-chatting address — revealed spending-chain addresses
// or cold-storage watch addresses — receives Kaspa from an external source.
// Wallet events only, never chat: no conversation, no bubble, just the app's
// standard desktop notification.
//
// Detection is the balance-diff catch-up model (iOS's runCatchUpIfNeeded):
// per-account persisted baselines are diffed against live balances (one
// batched getUtxosByAddresses), increases are attributed via each address's
// recent REST transactions with a self-send filter (any own address among the
// tx inputs = our own change/consolidation/withdrawal, suppressed silently),
// falling back to a neutral "Balance increased" notification when attribution
// fails. First run per account seeds the baseline silently so enabling the
// feature or importing a wallet never blasts notifications for old funds.
// Triggered from the live UTXO-subscription bridge (own watched addresses are
// in the tracked set via ownWatchedActivityAddresses), on startup, and on a
// slow safety interval. Deduped per txId (persisted, capped).
//
// Gated by Settings > Notifications > Wallet > "Address Activity" (default
// ON). Deliberately NOT gated by Child Mode — these are wallet notifications.
// ---------------------------------------------------------------------------

const ADDR_ACTIVITY_BASELINES_KEY = "kachat-addr-activity-baselines-v1"; // account-scoped { address: sompi string }
const ADDR_ACTIVITY_HANDLED_KEY = "kachat-addr-activity-handled-txids-v1"; // account-scoped [txid]
const ADDR_ACTIVITY_HANDLED_CAP = 500;
let addressActivityRunning = false;
let addressActivityCheckTimer = 0;

function addressActivityFeatureEnabled() {
  return (accountShellPrefs.addressActivityNotifications ?? true) !== false;
}

function loadAddrActivityBaselines() {
  try { return JSON.parse(localStorage.getItem(accountScopedKey(ADDR_ACTIVITY_BASELINES_KEY)) || "{}") || {}; }
  catch { return {}; }
}

function saveAddrActivityBaselines(baselines) {
  try { localStorage.setItem(accountScopedKey(ADDR_ACTIVITY_BASELINES_KEY), JSON.stringify(baselines)); } catch {}
}

function loadAddrActivityHandled() {
  try {
    const parsed = JSON.parse(localStorage.getItem(accountScopedKey(ADDR_ACTIVITY_HANDLED_KEY)) || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function saveAddrActivityHandled(list) {
  try {
    localStorage.setItem(accountScopedKey(ADDR_ACTIVITY_HANDLED_KEY), JSON.stringify(list.slice(-ADDR_ACTIVITY_HANDLED_CAP)));
  } catch {}
}

// Claims a txId for a path that already told the user about it (a chat payment
// bubble from a payment_notice), so the balance sweep doesn't announce the same
// money a second time as a wallet notification.
// A pool receipt is announced twice by two independent paths: this wallet-activity
// watcher (which exists so funds are never silent, even if the payer's notice never
// arrives) and the payer's `payment_notice`, which raises the real chat bubble and claims
// the txId. In the common ordering the funds land seconds BEFORE the notice, so notifying
// immediately would double-announce every private payment. Hold the wallet notification
// for a grace window instead: if the notice claims the txId in the meantime the chat
// bubble has already told the user, and if it never comes they still get told.
const POOL_RECEIPT_NOTIFY_GRACE_MS = 90_000;
const pendingPoolReceiptNotifications = new Set();

function schedulePoolReceiptNotification({ txid, address, amountSompi, kind }) {
  if (pendingPoolReceiptNotifications.has(txid)) return;
  pendingPoolReceiptNotifications.add(txid);
  window.setTimeout(() => {
    pendingPoolReceiptNotifications.delete(txid);
    // Claimed by the payment_notice while we waited: the chat bubble covered it.
    if (loadAddrActivityHandled().includes(txid)) return;
    markAddressActivityTxHandled(txid);
    const title = `Received ${formatSompiForNotification(amountSompi)} KAS`;
    const body = describeActivityAddress(kind, address);
    postDesktopNotification({ title, body, tag: `kachat-addr-activity-${txid}`, onClick: () => {} });
    recordGlobalNotification({
      id: `wallet-${txid}`,
      source: "wallet",
      title,
      body,
      timestamp: Date.now(),
      targetKind: "wallet",
    });
    appendEngineLog(`Address activity: pool receive ${txid.slice(0, 12)}… had no payment notice`);
  }, POOL_RECEIPT_NOTIFY_GRACE_MS);
}

function markAddressActivityTxHandled(txid) {
  const clean = String(txid || "").trim();
  if (!clean) return;
  const handled = loadAddrActivityHandled();
  if (handled.includes(clean)) return;
  handled.push(clean);
  saveAddrActivityHandled(handled);
}

// Every revealed spending-chain address (0...maxIndex) for the active account.
function spendingWatchedAddressList() {
  if (!engine.address || !activeAccountMnemonic() || !engine.kaspa) return [];
  const spendingState = getSpendingState();
  const list = [];
  for (let index = 0; index <= spendingState.maxIndex; index += 1) {
    const address = deriveSpendingAddressAt(index);
    if (address) list.push(address);
  }
  return list;
}

// Addresses whose receives should NOTIFY, mapped to a wording kind: watched
// spending + cold addresses, minus the chatting address (its receives are chat
// classified). Payment-pool reservation addresses STAY in the map, re-tagged so
// the notification names them for what they are: a payment into one of them is
// only ever announced by the payer's payment_notice, and that envelope can fail
// to arrive (payer's send failed, older client, raced a revoke) — dropping these
// from the watch too would leave funds nobody ever hears about.
function addressActivityWatchedMap() {
  const map = new Map();
  for (const address of spendingWatchedAddressList()) map.set(address, "spending");
  for (const entry of listColdWatchedAddresses()) {
    if (!map.has(entry.address)) map.set(entry.address, `cold:${entry.label}`);
  }
  map.delete(engine.address || "");
  for (const offered of paymentPoolOfferedAddresses()) {
    if (offered && offered !== engine.address) map.set(offered, "pool");
  }
  return map;
}

// Addresses that count as "ours" when they appear among a tx's INPUTS —
// superset of the notifiable set: chatting + all spending (reserved pool
// addresses are spending-chain indices, so covered) + all cold storage.
function ownInputAddressSet() {
  const set = new Set(spendingWatchedAddressList());
  for (const entry of listColdWatchedAddresses()) set.add(entry.address);
  if (engine.address) set.add(engine.address);
  return set;
}

function describeActivityAddress(kind, address) {
  const shortA = shortAddress(address);
  if (String(kind || "").startsWith("cold:")) return `Cold storage (${String(kind).slice(5)}) ${shortA}`;
  if (kind === "pool") return `Chat privacy address ${shortA}`;
  return `Spending address ${shortA}`;
}

function formatSompiForNotification(sompi) {
  let text = (Number(sompi) / 1e8).toFixed(8);
  text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text || "0";
}

async function fetchRecentFullTransactionsFor(address, limit = 10) {
  if (!String(address || "").trim()) return []; // empty address would 404 as /addresses//…
  const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
  const url = `${base}/addresses/${encodeURIComponent(address)}/full-transactions?limit=${limit}&offset=0&resolve_previous_outpoints=light`;
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) return [];
  const txs = await response.json();
  return Array.isArray(txs) ? txs : [];
}

function txInputAddresses(tx) {
  const inputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
  return inputs
    .map((input) => String(
      input?.previous_outpoint_address || input?.previousOutpointAddress ||
      input?.previous_outpoint_resolved?.script_public_key_address ||
      input?.previousOutpointResolved?.scriptPublicKeyAddress || "",
    ).trim())
    .filter(Boolean);
}

function scheduleAddressActivityCheck(delayMs = 1200) {
  if (addressActivityCheckTimer) window.clearTimeout(addressActivityCheckTimer);
  addressActivityCheckTimer = window.setTimeout(() => {
    addressActivityCheckTimer = 0;
    runAddressActivityCheck().catch((error) => appendEngineLog(`Address activity check failed: ${error.message}`));
  }, delayMs);
}

async function runAddressActivityCheck() {
  if (addressActivityRunning) return;
  if (!engine.address || !engine.kaspa) return;
  addressActivityRunning = true;
  const walletAtStart = engine.address;
  try {
    const watched = addressActivityWatchedMap();
    if (!watched.size) return;
    const addresses = [...watched.keys()];

    // One batched balance fetch for the whole set (mirrors iOS's single
    // getUtxosByAddresses call). A network failure leaves baselines untouched
    // so nothing is silently marked as seen.
    await engine.connect();
    const response = await engine.withRpc(
      (rpc) => rpc.getUtxosByAddresses(addresses),
      { retries: 1, label: "Address activity balances" },
    );
    if (engine.address !== walletAtStart) return; // account switched mid-flight
    const balances = new Map(addresses.map((address) => [address, 0n]));
    for (const entry of response?.entries || []) {
      const address = String(entry.address ?? entry.entry?.address ?? "");
      if (!balances.has(address)) continue;
      balances.set(address, balances.get(address) + BigInt(entry.amount ?? entry.entry?.amount ?? 0));
    }

    const baselines = loadAddrActivityBaselines();
    const isFirstRun = Object.keys(baselines).length === 0;
    let changed = false;
    const increases = [];
    // Funded-reservation detection (iOS handlePoolReservationUtxoAdditions, which
    // rides the utxosChanged stream — this batched balance read is the desktop
    // equivalent). Deliberately absolute (balance > 0) rather than baseline-diffed
    // and deliberately outside the notification feature flag: a reservation holding
    // money is funded whether or not a diff caught the moment it arrived, whether or
    // not the payer's payment_notice ever lands, and whether or not Address Activity
    // notifications are switched on.
    const offeredPoolAddresses = new Set(paymentPoolOfferedAddresses());
    const fundedPoolAddresses = [];
    for (const [address, balance] of balances) {
      const balanceText = balance.toString();
      if (balance > 0n && offeredPoolAddresses.has(address)) fundedPoolAddresses.push(address);
      const previous = baselines[address];
      if (previous === undefined) {
        // Never-tracked address (feature install, newly revealed slot, fresh
        // cold import): seed silently — its history predates our tracking.
        baselines[address] = balanceText;
        changed = true;
        continue;
      }
      if (previous !== balanceText) changed = true;
      let previousSompi = 0n;
      try { previousSompi = BigInt(previous); } catch {}
      if (!isFirstRun && balance > previousSompi && addressActivityFeatureEnabled()) {
        increases.push({ address, delta: balance - previousSompi, kind: watched.get(address) });
      }
      baselines[address] = balanceText;
    }
    if (changed) saveAddrActivityBaselines(baselines);
    for (const address of fundedPoolAddresses) notePoolReservationFundedOnChain(address);
    if (increases.length) await attributeAndNotifyAddressActivity(increases);
  } finally {
    addressActivityRunning = false;
  }
}

async function attributeAndNotifyAddressActivity(increases) {
  const own = ownInputAddressSet();
  const handled = loadAddrActivityHandled();
  const handledSet = new Set(handled);
  for (const { address, delta, kind } of increases) {
    let attributed = false;
    let recentTxs = [];
    try { recentTxs = await fetchRecentFullTransactionsFor(address, 10); } catch {}
    for (const tx of recentTxs) {
      const txid = String(tx?.transaction_id || tx?.transactionId || "").trim();
      if (!txid) continue;
      let toAddress = 0n;
      for (const output of (Array.isArray(tx?.outputs) ? tx.outputs : [])) {
        if (kaspaOutputAddress(output) === address) toAddress += kaspaOutputAmount(output);
      }
      if (toAddress <= 0n) continue;
      if (handledSet.has(txid)) { attributed = true; continue; }
      attributed = true;
      handledSet.add(txid);
      handled.push(txid);
      const inputAddresses = txInputAddresses(tx);
      const isSelfSend = inputAddresses.length > 0 && inputAddresses.some((input) => own.has(input));
      if (!isSelfSend && kind === "pool") {
        // Deferred so the payer's notice can claim it first - see
        // schedulePoolReceiptNotification. Deliberately NOT added to the handled list here;
        // the grace timer decides who announces this txId.
        handledSet.delete(txid);
        const pendingIdx = handled.lastIndexOf(txid);
        if (pendingIdx !== -1) handled.splice(pendingIdx, 1);
        schedulePoolReceiptNotification({ txid, address, amountSompi: toAddress, kind });
        appendEngineLog(`Address activity: pool receive ${txid.slice(0, 12)}… awaiting payment notice`);
      } else if (!isSelfSend) {
        postDesktopNotification({
          title: `Received ${formatSompiForNotification(toAddress)} KAS`,
          body: describeActivityAddress(kind, address),
          tag: `kachat-addr-activity-${txid}`,
          // Clicking used to focus the window and stop there, which tells you a payment arrived
          // and then makes you go and find it. It now opens the place the money landed: the Cold
          // Storage account that owns the address, or Manage Addresses for a spending one.
          onClick: () => {
            try {
              if (String(kind || "").startsWith("cold:")) {
                setActiveAppTab("cold-storage");
                openColdAccountForAddress(address);
              } else {
                setActiveAppTab("profile");
              }
            } catch { /* the focus alone is still better than nothing */ }
          },
        });
        // Also record it in the global notifications bell (Profile), alongside KaPosts/mentions.
        recordGlobalNotification({
          id: `wallet-${txid}`,
          source: "wallet",
          title: `Received ${formatSompiForNotification(toAddress)} KAS`,
          body: describeActivityAddress(kind, address),
          timestamp: Date.now(),
          targetKind: "wallet",
        });
        appendEngineLog(`Address activity: external receive ${txid.slice(0, 12)}… on ${shortAddress(address)}`);
      } else {
        appendEngineLog(`Address activity: suppressed self-send ${txid.slice(0, 12)}…`);
      }
    }
    if (!attributed) {
      // Balance grew but no fetched recent tx pays this address (deep history
      // page or indexer lag) — neutral fallback rather than staying silent.
      postDesktopNotification({
        title: `Balance increased by ${formatSompiForNotification(delta)} KAS`,
        body: describeActivityAddress(kind, address),
        tag: `kachat-addr-activity-bal-${address.slice(-12)}-${Date.now()}`,
        onClick: () => {},
      });
      recordGlobalNotification({
        id: `wallet-bal-${address.slice(-12)}-${Date.now()}`,
        source: "wallet",
        title: `Balance increased by ${formatSompiForNotification(delta)} KAS`,
        body: describeActivityAddress(kind, address),
        timestamp: Date.now(),
        targetKind: "wallet",
      });
    }
  }
  saveAddrActivityHandled(handled);
}

// Slow safety interval: the live subscription covers the common case, this
// picks up anything a dropped event or REST hiccup missed.
window.setInterval(() => scheduleAddressActivityCheck(0), 180_000);

// ---------------------------------------------------------------------------
// Fresh-address payment pools (MESSAGING.md "Fresh-Address Payment Pools";
// iOS PaymentPoolStore + ChatService+PaymentPools port).
//
// Contacts exchange batches of fresh, never-used spending-chain receive
// addresses through the normal encrypted contextual channel (`addr_pool`,
// plain JSON in the plaintext exactly like reactions), Send KAS pays one of
// those instead of the contact's chatting address, and a `payment_notice`
// envelope keeps the recipient's chat showing a payment bubble. All three
// envelope types are invisible — intercepted in appendIncomingOrReactionMessage
// before they could ever render. State is device-local, per account
// (accountScopedKey), NOT backed up — a restore simply re-exchanges pools.
// ---------------------------------------------------------------------------

const PAYMENT_POOL_STATE_KEY = "kachat-payment-pool-state-v1";
const CHATS_PRIVACY_KEY = "kachat-chats-privacy-v1"; // per-account: "1"/"0", default ON
// How many fresh addresses each addr_pool offer carries — also the target the
// auto-replenish keeps live per contact (iOS PaymentPoolStore.offerBatchSize).
// Deliberately small: every reservation burns an index against the 50-per-contact
// lifetime cap.
const POOL_OFFER_BATCH_SIZE = 2;
// Ask for more once the unused remainder of a contact's pool drops to this or
// lower. With a pool of 2 the request is a backstop for a lost replenish top-up,
// so it fires only after a consumption actually leaves a single unused address.
const POOL_LOW_WATER_MARK = 1;
const POOL_MAX_STORED = 20;
const POOL_MAX_HANDLED_TXIDS = 500;
const POOL_REQUEST_THROTTLE_MS = 10 * 60 * 1000;
// Inbound abuse limits — part of the protocol contract (MESSAGING.md).
const POOL_SERVE_THROTTLE_MS = 10 * 60 * 1000;
const POOL_TOGGLE_TRANSITION_GAP_MS = 60 * 1000;
const POOL_MAX_LIFETIME_RESERVATIONS = 50;
const POOL_MAX_OUTSTANDING_UNFUNDED = 15;

function loadPoolState() {
  try {
    const raw = JSON.parse(localStorage.getItem(accountScopedKey(PAYMENT_POOL_STATE_KEY)) || "{}") || {};
    return {
      // contactAddress -> [{ address, index, offered, funded, activeOffer }] — MY reserved
      // spending addresses offered to that contact. CRITICAL INVARIANT: an
      // address reserved for contact X is never offered to any other contact
      // and never re-offered; reserveFreshSpendingAddresses only hands out
      // indices past the all-time max.
      myReservations: raw.myReservations && typeof raw.myReservations === "object" ? raw.myReservations : {},
      // contactAddress -> [{ address, used }] — THAT contact's fresh addresses I can pay them at.
      theirPools: raw.theirPools && typeof raw.theirPools === "object" ? raw.theirPools : {},
      offeredContacts: Array.isArray(raw.offeredContacts) ? raw.offeredContacts.map(String) : [],
      handledEnvelopeTxIds: Array.isArray(raw.handledEnvelopeTxIds) ? raw.handledEnvelopeTxIds.map(String) : [],
      lastPoolRequestAt: raw.lastPoolRequestAt && typeof raw.lastPoolRequestAt === "object" ? raw.lastPoolRequestAt : {},
      lastPoolServeAt: raw.lastPoolServeAt && typeof raw.lastPoolServeAt === "object" ? raw.lastPoolServeAt : {},
      revokedContacts: Array.isArray(raw.revokedContacts) ? raw.revokedContacts.map(String) : [],
      // Contacts who revoked OUR pool at THEM (incoming empty replace:true — their
      // Chats Privacy went off). While set we never proactively offer or replenish:
      // their active count is 0 by revocation, not by consumption. Cleared when they
      // show renewed interest (addr_pool_request, a non-empty pool of theirs, or any
      // successful offer of ours).
      contactsRevokedAtUs: Array.isArray(raw.contactsRevokedAtUs) ? raw.contactsRevokedAtUs.map(String) : [],
    };
  } catch {
    return { myReservations: {}, theirPools: {}, offeredContacts: [], handledEnvelopeTxIds: [], lastPoolRequestAt: {}, lastPoolServeAt: {}, revokedContacts: [], contactsRevokedAtUs: [] };
  }
}

function savePoolState(poolState) {
  try { localStorage.setItem(accountScopedKey(PAYMENT_POOL_STATE_KEY), JSON.stringify(poolState)); } catch {}
}

// Per-ACCOUNT "Chats Payment Privacy" toggle (Settings > Chats), default ON.
// Gates the send side only: OFF pays/funds via the chatting address, offers
// nothing and requests nothing; inbound notices/pools stay handled regardless.
function chatsPrivacyEnabled() {
  try { return localStorage.getItem(accountScopedKey(CHATS_PRIVACY_KEY)) !== "0"; } catch { return true; }
}

function setChatsPrivacyEnabled(enabled) {
  try { localStorage.setItem(accountScopedKey(CHATS_PRIVACY_KEY), enabled ? "1" : "0"); } catch {}
}

// Every reserved-and-offered address across all contacts — these belong in the
// UTXO subscription watched set, and are excluded from Address Activity
// notifications (their receives render as chat payment bubbles instead).
function paymentPoolOfferedAddresses() {
  try {
    const poolState = loadPoolState();
    const list = [];
    for (const entries of Object.values(poolState.myReservations || {})) {
      for (const entry of entries || []) if (entry.offered) list.push(entry.address);
    }
    return list;
  } catch { return []; }
}

function isReservedPoolAddress(poolState, address) {
  for (const entries of Object.values(poolState.myReservations || {})) {
    if ((entries || []).some((entry) => entry.address === address)) return true;
  }
  return false;
}

// ACTIVE (as opposed to the HISTORICAL `offered` flag above): the reservation is
// part of a contact's CURRENT live pool. That narrower set drives the Address
// Visibility lock and the row-menu Hide refusal — an address a contact may pay
// into at any moment must stay visible to its owner. An entry leaves the set when
// we revoke (Chats Privacy off), the contact revokes at us, a replace:true
// re-offer supersedes it, or it gets funded; the row is an ordinary address again
// from then on. `activeOffer` is optional for state written before this split:
// nil means offered && never funded && contact not revoked by us, which is exactly
// what "active" meant then (iOS PaymentPoolStore.activeOfferedReservationAddresses).
function isActivePoolReservation(entry, contactAddress, poolState) {
  if (entry?.activeOffer === true) return true;
  if (entry?.activeOffer === false) return false;
  return entry?.offered === true
    && entry?.funded !== true
    && !(poolState.revokedContacts || []).includes(contactAddress);
}

// [{ address, index, contactAddress }] for every reservation currently in a live pool.
function activePoolReservationEntries() {
  try {
    const poolState = loadPoolState();
    const list = [];
    for (const [contactAddress, entries] of Object.entries(poolState.myReservations || {})) {
      for (const entry of entries || []) {
        if (isActivePoolReservation(entry, contactAddress, poolState)) {
          list.push({ address: entry.address, index: entry.index, contactAddress });
        }
      }
    }
    return list;
  } catch { return []; }
}

function activePoolReservationAddressSet() {
  return new Set(activePoolReservationEntries().map((entry) => entry.address));
}

function activePoolReservationIndexSet() {
  return new Set(activePoolReservationEntries()
    .map((entry) => entry.index)
    .filter((index) => Number.isInteger(index)));
}

// The contact a reservation belongs to, by address — routes a reservation funded
// through the UTXO/balance watch back to the contact whose pool it came from.
function poolReservationOwnerContact(address) {
  const poolState = loadPoolState();
  for (const [contactAddress, entries] of Object.entries(poolState.myReservations || {})) {
    if ((entries || []).some((entry) => entry.address === address)) return contactAddress;
  }
  return null;
}

// Repair for reservations recorded under the old born-hidden design (and for any
// index a user hid before it was offered): an address in an ACTIVE live pool can
// never be hidden, so it leaves the hidden set. Scoped to the active set on
// purpose — a reverted reservation (revoked, superseded, funded) is a normal
// address again and stays however the user left it. Cheap; safe to call on every
// address-screen render and after every offer.
function unhideActivePoolReservations() {
  try {
    const active = activePoolReservationIndexSet();
    if (!active.size) return false;
    const spendingState = getSpendingState();
    const hiddenSet = new Set(spendingState.hidden);
    let unhidden = 0;
    for (const index of active) if (hiddenSet.delete(index)) unhidden += 1;
    if (!unhidden) return false;
    saveSpendingState({ hidden: [...hiddenSet] });
    appendEngineLog(`Un-hid ${unhidden} actively offered payment-pool address(es).`);
    return true;
  } catch { return false; }
}

// Wire parser for the three pool envelope types (PaymentPoolCodec.parse).
// Unknown `type` values fall through to the normal message pipeline; unknown
// extra fields inside these envelopes are ignored.
function parsePaymentPoolEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.length > 100_000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.type === "addr_pool") {
      if (!Array.isArray(parsed.addresses)) return null;
      return { kind: "pool", addresses: parsed.addresses.map((a) => String(a || "")), replace: parsed.replace === true };
    }
    if (parsed.type === "addr_pool_request") return { kind: "request" };
    if (parsed.type === "payment_notice") {
      const txId = String(parsed.txId || "").trim().toLowerCase();
      const amountSompi = Number(parsed.amountSompi);
      const address = String(parsed.address || "").trim();
      if (!txId || !Number.isFinite(amountSompi) || amountSompi <= 0 || !address) return null;
      return { kind: "notice", txId, amountSompi: Math.floor(amountSompi), address };
    }
    return null;
  } catch { return null; }
}

// Established = both directions have spoken (>=1 incoming AND >=1 outgoing) —
// the bar both for offering our pool and for accepting a contact's.
function isPoolEstablishedConversation(conversationEntry) {
  const messages = conversationEntry?.messages || [];
  return messages.some((m) => m.direction === "incoming") && messages.some((m) => m.direction === "outgoing");
}

function isValidKaspaAddressString(address) {
  try { return engine.kaspa?.Address?.validate ? engine.kaspa.Address.validate(address) === true : address.startsWith("kaspa:"); }
  catch { return false; }
}

function isWithinPoolServeGap(poolState, contactAddress, toggleTransition) {
  const last = Number(poolState.lastPoolServeAt?.[contactAddress] || 0);
  if (!last) return false;
  const gap = toggleTransition ? POOL_TOGGLE_TRANSITION_GAP_MS : POOL_SERVE_THROTTLE_MS;
  return Date.now() - last < gap;
}

// Gate for EVERY addr_pool send (initial offer, reciprocity, request-driven
// top-ups): one send per contact per 10 minutes (60s transition gap for
// genuine toggle flips), nothing once the lifetime reservation cap or the
// outstanding-unfunded-offers cap is hit. Suppressions are silent (log only).
function canServePoolOffer(contactAddress, { toggleTransition = false } = {}) {
  const poolState = loadPoolState();
  if (isWithinPoolServeGap(poolState, contactAddress, toggleTransition)) return false;
  const reservations = poolState.myReservations[contactAddress] || [];
  if (reservations.length >= POOL_MAX_LIFETIME_RESERVATIONS) return false;
  const outstandingUnfunded = reservations.filter((r) => r.offered && r.funded !== true).length;
  if (outstandingUnfunded >= POOL_MAX_OUTSTANDING_UNFUNDED) return false;
  return true;
}

// Reveals `count` fresh spending-chain slots strictly past the all-time max
// index (bumping the persisted maxIndex, so they show in Manage Addresses like
// any revealed address and future generates/reservations can never collide).
function reserveFreshSpendingAddresses(count) {
  if (!engine.address || !activeAccountMnemonic() || !engine.kaspa) return [];
  const spendingState = getSpendingState();
  const base = spendingState.maxIndex + 1;
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const index = base + i;
    const address = deriveSpendingAddressAt(index);
    if (!address) break;
    results.push({ index, address });
  }
  if (results.length) saveSpendingState({ maxIndex: results[results.length - 1].index });
  return results;
}

// Sends an invisible pool envelope through the normal encrypted
// contextual-message pipeline (identical to sendReaction's construction) —
// never a bubble, no pending bookkeeping. Returns the submitted txid ("" if
// unknown), which is remembered in the replay guard so the indexer re-fetch of
// our own envelope is dropped without re-entering handler logic.
async function sendInvisiblePoolEnvelope(contact, payload) {
  if (!engine.address) throw new Error("No wallet loaded.");
  const conversationEntry = state.conversations.find((entry) => entry.contactId === contact.id);
  const envelope = await engine.createEncryptedMessageEnvelope({
    conversationId: conversationEntry?.id || nowId(),
    contactId: contact.id,
    toAddress: contact.address,
    fromAddress: engine.address,
    text: payload,
    localNonce: nowId(),
    createdAt: Date.now(),
  });
  const result = await engine.sendMessageOnchain({ envelope, amountKas: onchainAmountKas(), feeKas: "0", onStatus: () => {} });
  const txid = String(result?.txid || "").trim();
  if (txid) {
    const poolState = loadPoolState();
    if (!poolState.handledEnvelopeTxIds.includes(txid)) {
      poolState.handledEnvelopeTxIds.push(txid);
      if (poolState.handledEnvelopeTxIds.length > POOL_MAX_HANDLED_TXIDS) {
        poolState.handledEnvelopeTxIds.splice(0, poolState.handledEnvelopeTxIds.length - POOL_MAX_HANDLED_TXIDS);
      }
      savePoolState(poolState);
    }
  }
  return txid;
}

// Serializes pool-envelope sends: the engine already queues per source
// address, but the marker/throttle re-checks inside reserveAndSendAddressPool
// must run after any queued predecessor finished (several envelope handlers
// can queue offers for the same contact before the first flips the marker).
let poolSendChain = Promise.resolve();
function enqueuePoolOperation(operation) {
  const next = poolSendChain.then(operation, operation);
  poolSendChain = next.catch(() => {});
  return next;
}

// Reserves fresh spending-chain addresses for `contact` and sends them as an
// addr_pool envelope. Re-uses reservations whose send previously failed
// (offered=false) before revealing new indices; replace:true offers may re-send
// previously offered but never-funded reservations (post-revoke re-offer —
// the recipient discarded them, re-sending creates no reuse and doesn't burn
// a fresh batch of indices per toggle cycle). All gates re-checked here, inside
// the serialized operation, not just at call sites.
//
// `replenish: true` marks an automatic top-up triggered by a reservation getting
// funded: it shares the toggle broadcasts' throttle exemption (60s gap instead of
// the 10-minute throttle, reservation caps in full) and sends only the SHORTFALL
// back up to POOL_OFFER_BATCH_SIZE fresh active addresses, recomputed here inside
// the serialized operation so stacked triggers for the same funding collapse into
// one send (or none).
async function reserveAndSendAddressPool(contact, { replace, toggleTransition = false, replenish = false } = {}) {
  if (!engine.address || !contact?.address) return;
  if (!chatsPrivacyEnabled()) return;
  const contactAddress = contact.address;
  let poolState = loadPoolState();
  // No offer of any kind to a contact who revoked our pool at them until they
  // re-engage. The re-engagement lanes (their addr_pool_request, a non-empty pool
  // of theirs) clear the marker before enqueueing, so they pass; everything else —
  // lazy offers, toggle-on re-offers, replenishes — is blocked, including a revoke
  // of theirs that lands between enqueue and execution.
  if ((poolState.contactsRevokedAtUs || []).includes(contactAddress)) return;
  if (replace && poolState.offeredContacts.includes(contactAddress)) return;
  if (!canServePoolOffer(contactAddress, { toggleTransition: toggleTransition || replenish })) {
    appendEngineLog(`Pool offer to ${shortAddress(contactAddress)} suppressed by serve throttle/caps.`);
    return;
  }

  // Replenish sends only the shortfall; everything else sends a full batch.
  let batchLimit = POOL_OFFER_BATCH_SIZE;
  if (replenish) {
    batchLimit = POOL_OFFER_BATCH_SIZE - activeFreshReservationCount(contactAddress);
    if (batchLimit <= 0) return;
  }

  const reservations = poolState.myReservations[contactAddress] || [];
  let pending = replace
    ? reservations.filter((r) => r.funded !== true)
    : reservations.filter((r) => !r.offered);
  if (pending.length > batchLimit) pending = pending.slice(0, batchLimit);

  const lifetimeHeadroom = POOL_MAX_LIFETIME_RESERVATIONS - reservations.length;
  const missing = Math.min(batchLimit - pending.length, lifetimeHeadroom);
  if (missing > 0) {
    const fresh = reserveFreshSpendingAddresses(missing);
    if (!fresh.length && !pending.length) {
      appendEngineLog("Pool offer aborted — could not reserve fresh spending addresses.");
      return;
    }
    if (fresh.length) {
      // Pool reservations are born VISIBLE: they appear in Manage Addresses right
      // away so the user can see exactly which of their addresses are held ready for
      // a contact to pay into. Hiding them (the old design) meant a payment whose
      // payment_notice never arrived landed on an address the user could not see
      // anywhere. Fresh indices are past the revealed bound, so they are never in
      // the hidden set to begin with; reservations recorded under the old design
      // are repaired by unhideActivePoolReservations() once the send succeeds.
      const entries = fresh.map(({ address, index }) => ({ address, index, offered: false, funded: false, activeOffer: false }));
      poolState = loadPoolState();
      const list = poolState.myReservations[contactAddress] || [];
      const known = new Set(list.map((r) => r.address));
      for (const entry of entries) if (!known.has(entry.address)) list.push(entry);
      poolState.myReservations[contactAddress] = list;
      savePoolState(poolState);
      pending = pending.concat(entries);
    }
  }
  if (!pending.length) return;

  // Wire format (MESSAGING.md): {"type":"addr_pool","addresses":[...],"replace":bool}
  const payload = JSON.stringify({ type: "addr_pool", addresses: pending.map((r) => r.address), replace: replace === true });
  await sendInvisiblePoolEnvelope(contact, payload);

  poolState = loadPoolState();
  const list = poolState.myReservations[contactAddress] || [];
  const offeredNow = new Set(pending.map((r) => r.address));
  for (const entry of list) {
    if (offeredNow.has(entry.address)) {
      entry.offered = true;   // HISTORICAL, never cleared: stays watched and notice-renderable.
      entry.activeOffer = true;
    } else if (replace) {
      // A replace batch IS the contact's whole live pool now — any other reservation
      // still flagged active is superseded and reverts to an ordinary address row.
      entry.activeOffer = false;
    }
  }
  poolState.myReservations[contactAddress] = list;
  if (!poolState.offeredContacts.includes(contactAddress)) poolState.offeredContacts.push(contactAddress);
  poolState.lastPoolServeAt[contactAddress] = Date.now();
  poolState.revokedContacts = poolState.revokedContacts.filter((a) => a !== contactAddress);
  // A successful offer supersedes a standing revoked-at-us marker: the contact holds
  // live addresses of ours again, so replenishes are meaningful again.
  poolState.contactsRevokedAtUs = (poolState.contactsRevokedAtUs || []).filter((a) => a !== contactAddress);
  savePoolState(poolState);
  // Actively offered addresses are always visible in Manage Addresses.
  unhideActivePoolReservations();
  appendEngineLog(`Offered ${pending.length} fresh pool addresses to ${shortAddress(contactAddress)} (replace=${replace === true}, replenish=${replenish === true}).`);

  // The just-offered reserved addresses join the UTXO watched set.
  refreshSubscriptionAddresses({ restart: true });
}

// Lazily offers this wallet's fresh receive addresses once per contact
// (persisted marker) — called on conversation open and reciprocally from an
// incoming addr_pool. Established conversations only.
function offerAddressPoolIfNeeded(contact, conversationEntry) {
  if (!engine.address || !contact?.address) return;
  if (!chatsPrivacyEnabled()) return;
  const poolState = loadPoolState();
  if (poolState.offeredContacts.includes(contact.address)) return;
  // A contact who revoked our pool at them gets no unsolicited offers until they
  // re-engage (the re-engagement lanes clear the marker before routing here).
  if ((poolState.contactsRevokedAtUs || []).includes(contact.address)) return;
  if (!canServePoolOffer(contact.address)) return;
  if (!isPoolEstablishedConversation(conversationEntry)) return;
  enqueuePoolOperation(() => reserveAndSendAddressPool(contact, { replace: true }))
    .catch((error) => appendEngineLog(`Pool offer failed: ${error.message}`));
}

// How many of our reservations for `contactAddress` are currently live-and-fresh:
// part of the contact's ACTIVE pool and never funded. This is the count the
// auto-replenish compares against POOL_OFFER_BATCH_SIZE — the contact should
// always hold that many fresh addresses to pay us at.
function activeFreshReservationCount(contactAddress) {
  const poolState = loadPoolState();
  return (poolState.myReservations[contactAddress] || [])
    .filter((entry) => entry.funded !== true && isActivePoolReservation(entry, contactAddress, poolState))
    .length;
}

// Keeps a contact who holds a live pool of ours topped up to POOL_OFFER_BATCH_SIZE
// fresh addresses (iOS replenishPoolIfNeeded). Fired whenever one of their
// reservations is detected funded — a payment_notice naming it, or the balance
// watch seeing funds arrive on it — and re-checked on every conversation open, so
// a top-up whose send failed earlier gets retried. Sends an ADDITIVE addr_pool
// (replace:false) carrying only the shortfall.
function replenishPoolIfNeeded(contactAddress) {
  if (!engine.address || !contactAddress) return;
  if (!chatsPrivacyEnabled()) return;
  const poolState = loadPoolState();
  // Only contacts currently holding a live pool of ours get proactive top-ups — a
  // never-offered contact goes through the normal initial offer, a revoked one
  // through the toggle-on re-offer.
  if (!poolState.offeredContacts.includes(contactAddress)) return;
  if ((poolState.revokedContacts || []).includes(contactAddress)) return;
  // A contact who revoked at us zeroed their active count deliberately — that's
  // disinterest, not consumption; never replenish until they re-engage.
  if ((poolState.contactsRevokedAtUs || []).includes(contactAddress)) return;
  if (activeFreshReservationCount(contactAddress) >= POOL_OFFER_BATCH_SIZE) return;
  const conversationEntry = (state.conversations || [])
    .find((entry) => contactForConversation(entry)?.address === contactAddress);
  if (!isPoolEstablishedConversation(conversationEntry)) return;
  const contact = contactForConversation(conversationEntry);
  if (!contact) return;
  enqueuePoolOperation(() => reserveAndSendAddressPool(contact, { replace: false, replenish: true }))
    .catch((error) => appendEngineLog(`Pool replenish failed: ${error.message}`));
}

// Sends addr_pool_request when the stored pool for `contact` has run low
// (<= POOL_LOW_WATER_MARK unused), throttled per contact. Never when Chats
// Payment Privacy is OFF (we aren't consuming pool addresses then).
function maybeRequestMorePoolAddresses(contact) {
  if (!engine.address || !contact?.address) return;
  if (!chatsPrivacyEnabled()) return;
  const poolState = loadPoolState();
  const pool = poolState.theirPools[contact.address] || [];
  if (!pool.length) return;
  if (pool.filter((entry) => !entry.used).length > POOL_LOW_WATER_MARK) return;
  const last = Number(poolState.lastPoolRequestAt[contact.address] || 0);
  if (last && Date.now() - last < POOL_REQUEST_THROTTLE_MS) return;
  enqueuePoolOperation(async () => {
    await sendInvisiblePoolEnvelope(contact, JSON.stringify({ type: "addr_pool_request" }));
    const current = loadPoolState();
    current.lastPoolRequestAt[contact.address] = Date.now();
    savePoolState(current);
    appendEngineLog(`Requested fresh pool addresses from ${shortAddress(contact.address)}.`);
  }).catch((error) => appendEngineLog(`addr_pool_request send failed: ${error.message}`));
}

// Front door for the three envelope types, called from the interception in
// appendIncomingOrReactionMessage — these never become bubbles (except the
// payment bubble a payment_notice deliberately creates). Replay-guarded by
// envelope txid: history re-fetch replays the same envelopes and must not
// re-trigger reservation sends or pool merges.
function handlePaymentPoolEnvelope(envelope, conversationEntry, message) {
  if (!engine.address) return;
  const contact = contactForConversation(conversationEntry);
  const contactAddress = contact?.address || "";
  if (!contactAddress) return;

  const txid = String(message.txid || "").trim();
  if (txid) {
    const poolState = loadPoolState();
    if (poolState.handledEnvelopeTxIds.includes(txid)) return;
    poolState.handledEnvelopeTxIds.push(txid);
    if (poolState.handledEnvelopeTxIds.length > POOL_MAX_HANDLED_TXIDS) {
      poolState.handledEnvelopeTxIds.splice(0, poolState.handledEnvelopeTxIds.length - POOL_MAX_HANDLED_TXIDS);
    }
    savePoolState(poolState);
  }

  const outgoing = message.direction === "outgoing";
  if (envelope.kind === "pool") {
    // Our own outgoing addr_pool re-fetched: nothing to do.
    if (outgoing) return;
    if (!isPoolEstablishedConversation(conversationEntry)) {
      appendEngineLog(`Ignoring addr_pool from non-established conversation ${shortAddress(contactAddress)}.`);
      return;
    }
    acceptIncomingAddressPool(envelope, contact, conversationEntry);
  } else if (envelope.kind === "request") {
    if (outgoing) return;
    // Chats Privacy OFF: silently ignore (same no-error semantics as the rate limits).
    if (!chatsPrivacyEnabled()) return;
    if (!isPoolEstablishedConversation(conversationEntry)) return;
    // An explicit request is renewed interest — a standing revoked-at-us marker
    // (they once revoked our pool) no longer applies, so offers/replenishes resume.
    clearContactRevokedAtUs(contactAddress);
    if (!canServePoolOffer(contactAddress)) {
      appendEngineLog(`Ignoring addr_pool_request from ${shortAddress(contactAddress)} — serve throttle/caps.`);
      return;
    }
    enqueuePoolOperation(() => reserveAndSendAddressPool(contact, { replace: false }))
      .catch((error) => appendEngineLog(`Pool top-up failed: ${error.message}`));
  } else if (envelope.kind === "notice") {
    // The payer's own notice re-fetched: swallow — the payer's bubble was
    // created by the send flow.
    if (outgoing) return;
    createPaymentBubbleFromNotice(envelope, conversationEntry, contact, message);
  }
}

// Validates and stores a received addr_pool as "addresses I can pay this
// contact at". Per-address validation: bech32-valid, kaspa: prefix, not our
// chatting address, not one we reserved, not our own spending-chain address.
// Honors the revocation primitive: replace:true + empty-after-validation
// clears the stored pool entirely. Reciprocity offers our pool if the contact
// hasn't gotten it yet.
function acceptIncomingAddressPool(envelope, contact, conversationEntry) {
  const contactAddress = contact.address;
  const poolState = loadPoolState();
  const ownSpending = new Set(spendingWatchedAddressList());
  const accepted = [];
  for (const raw of envelope.addresses.slice(0, POOL_MAX_STORED)) {
    const address = String(raw || "").trim();
    if (!address.startsWith("kaspa:") ||
        !isValidKaspaAddressString(address) ||
        address === engine.address ||
        isReservedPoolAddress(poolState, address) ||
        ownSpending.has(address)) {
      appendEngineLog(`Rejected pool address from ${shortAddress(contactAddress)}: …${address.slice(-14)}`);
      continue;
    }
    accepted.push(address);
  }

  // REVOCATION PRIMITIVE: a replace:true pool that is empty after validation
  // clears this contact's stored pool entirely — our next payment falls back
  // to their chatting address, and the fresh-address indicator goes false
  // immediately. No reciprocity on a revoke.
  if (envelope.replace && accepted.length === 0) {
    poolState.theirPools[contactAddress] = [];
    // The contact signalled pool disinterest (Chats Privacy off on their side): our
    // offers to them leave the ACTIVE set too — their Manage Addresses rows revert to
    // normal, hideable addresses. Protocol state (offered marker, watch set,
    // payment_notice rendering) is untouched: a payment racing this revoke, or a
    // straggler send into the old pool, still lands and renders. The marker also keeps
    // the auto-replenish from reading the zeroed active count as a shortfall and
    // pushing fresh addresses at someone who just signalled disinterest.
    if (!(poolState.contactsRevokedAtUs || []).includes(contactAddress)) {
      poolState.contactsRevokedAtUs = [...(poolState.contactsRevokedAtUs || []), contactAddress];
    }
    for (const entry of poolState.myReservations[contactAddress] || []) entry.activeOffer = false;
    savePoolState(poolState);
    appendEngineLog(`Pool REVOKED by ${shortAddress(contactAddress)} — cleared stored pool.`);
    refreshComposerAvailableBalance();
    return;
  }
  if (!accepted.length) return;

  const existing = poolState.theirPools[contactAddress] || [];
  const usedByAddress = new Map(existing.map((entry) => [entry.address, entry.used === true]));
  let merged = envelope.replace ? [] : existing.slice();
  const seen = new Set(merged.map((entry) => entry.address));
  for (const address of accepted) {
    if (seen.has(address)) continue;
    seen.add(address);
    // used flags carry over on replace — a replayed/overlapping replace can
    // never resurrect an already-spent address.
    merged.push({ address, used: usedByAddress.get(address) === true });
  }
  if (merged.length > POOL_MAX_STORED) merged = merged.slice(0, POOL_MAX_STORED);
  poolState.theirPools[contactAddress] = merged;
  // A non-empty pool offer means the contact participates in the feature again —
  // any standing revoked-at-us marker from an earlier revoke of theirs is stale.
  poolState.contactsRevokedAtUs = (poolState.contactsRevokedAtUs || []).filter((a) => a !== contactAddress);
  savePoolState(poolState);
  appendEngineLog(`Stored ${accepted.length} pool addresses for ${shortAddress(contactAddress)} (replace=${envelope.replace}).`);
  refreshComposerAvailableBalance();

  // Reciprocity: they shared theirs — if they've never gotten ours, offer now.
  if (!loadPoolState().offeredContacts.includes(contactAddress)) {
    offerAddressPoolIfNeeded(contact, conversationEntry);
  }
}

// Marks one of our reservations funded — a payment_notice from the contact named
// it as the payment destination, or the balance watch saw funds land on it.
// Feeds the outstanding-unfunded cap. Returns true ONLY when this call actually
// transitioned the reservation, so repeated notifications for the same funding
// never queue duplicate replenishes.
function markReservationFunded(address, contactAddress) {
  const poolState = loadPoolState();
  const entries = poolState.myReservations[contactAddress];
  if (!entries) return false;
  const entry = entries.find((r) => r.address === address);
  if (!entry || entry.funded === true) return false;
  entry.funded = true;
  // Consumed: the address leaves the ACTIVE offered set — from here its row is
  // governed by the funded rule (kept visible by its balance, no longer locked as
  // a live offer).
  entry.activeOffer = false;
  savePoolState(poolState);
  // The reserved address now holds money — funded addresses are always visible.
  // Reservations are born visible now, so this normally no-ops; it still repairs
  // state left hidden by the old born-hidden design.
  if (Number.isInteger(entry.index)) {
    const spendingState = getSpendingState();
    const hiddenSet = new Set(spendingState.hidden);
    if (hiddenSet.delete(entry.index)) saveSpendingState({ hidden: [...hiddenSet] });
  }
  return true;
}

// Funded detection that does NOT depend on the payer's payment_notice: the offered
// reservation addresses are in the UTXO watched set and in the Address Activity
// balance sweep, so money landing on one is observed directly (iOS does the same
// from its utxosChanged stream in handlePoolReservationUtxoAdditions). Marks the
// reservation funded, keeps its row visible, and tops the contact's pool back up.
function notePoolReservationFundedOnChain(address) {
  try {
    const contactAddress = poolReservationOwnerContact(address);
    if (!contactAddress) return;
    if (!markReservationFunded(address, contactAddress)) return;
    appendEngineLog(`Pool reservation ${shortAddress(address)} funded (observed on chain) for ${shortAddress(contactAddress)} — replenishing.`);
    replenishPoolIfNeeded(contactAddress);
  } catch (error) {
    appendEngineLog(`Pool reservation funding check failed: ${error.message}`);
  }
}

function clearContactRevokedAtUs(contactAddress) {
  const poolState = loadPoolState();
  if (!(poolState.contactsRevokedAtUs || []).includes(contactAddress)) return;
  poolState.contactsRevokedAtUs = poolState.contactsRevokedAtUs.filter((a) => a !== contactAddress);
  savePoolState(poolState);
}

// Renders a received payment_notice as a normal incoming payment bubble,
// deduped by the payment's txId. Rendering is NOT blocked on chain
// verification (the notice arrived over the sender-authenticated encrypted
// channel); a background REST check corrects the amount if the chain
// disagrees and downgrades the bubble if the tx pays nothing to the claimed
// address.
function createPaymentBubbleFromNotice(envelope, conversationEntry, contact, sourceMessage) {
  // An actual funded transition tops the contact back up to a full fresh pool.
  if (markReservationFunded(envelope.address, contact.address)) {
    replenishPoolIfNeeded(contact.address);
  }

  const txId = envelope.txId;
  // The chat bubble below is this payment's notification — claim the txId so the
  // Address Activity balance sweep (pool addresses are watched there now) doesn't
  // announce the same receive again as a wallet notification.
  markAddressActivityTxHandled(txId);
  const exists = (conversationEntry.messages || []).some((m) => String(m.txid || "").toLowerCase() === txId);
  if (exists) return;

  const amountKas = formatSompiForNotification(envelope.amountSompi);
  const createdAt = Number(sourceMessage.createdAt || Date.now());
  const bubble = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "incoming",
    text: `Received ${amountKas} KAS`,
    sender: contact.address,
    receiver: envelope.address,
    status: MESSAGE_STATUSES.CONFIRMED,
    transport: "kaspa-payment",
    createdAt,
  });
  bubble.txid = txId;
  bubble.messageType = "payment";
  bubble.paymentAmountKas = amountKas;
  bubble.confirmations = 1;
  addMessageToConversation(conversationEntry, bubble);
  conversationEntry.messages.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  conversationEntry.lastActivityAt = Math.max(Number(conversationEntry.lastActivityAt || 0), createdAt);
  conversationEntry.updatedAt = Date.now();
  persistState();
  if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
  renderChats();
  maybeNotifyIncoming(conversationEntry, contact, bubble);
  appendEngineLog(`Created payment bubble from payment_notice ${txId.slice(0, 12)}…`);
  verifyPaymentNoticeAgainstChain(conversationEntry, bubble, envelope);
}

// Best-effort background verification of a payment_notice against the
// on-chain tx. Silent on network failure; the chain is authoritative for the
// amount; a tx with no output to the claimed address flags the bubble.
async function verifyPaymentNoticeAgainstChain(conversationEntry, bubble, envelope) {
  let tx = null;
  try {
    const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
    const response = await fetch(`${base}/transactions/${encodeURIComponent(envelope.txId)}?resolve_previous_outpoints=no`, {
      headers: { Accept: "application/json" }, cache: "no-store",
    });
    if (!response.ok) return;
    tx = await response.json();
  } catch { return; }
  let paidToClaimed = 0n;
  for (const output of (Array.isArray(tx?.outputs) ? tx.outputs : [])) {
    if (kaspaOutputAddress(output) === envelope.address) paidToClaimed += kaspaOutputAmount(output);
  }
  const live = (conversationEntry.messages || []).find((m) => m.id === bubble.id) || bubble;
  if (paidToClaimed === 0n) {
    appendEngineLog(`payment_notice ${envelope.txId.slice(0, 12)}… FAILED verification — no output to claimed address.`);
    applyMessagePatch(live, { status: MESSAGE_STATUSES.BROADCAST, note: "Unverified: the referenced transaction pays nothing to the claimed address." });
  } else if (paidToClaimed !== BigInt(envelope.amountSompi)) {
    const corrected = formatSompiForNotification(paidToClaimed);
    applyMessagePatch(live, { text: `Received ${corrected} KAS`, paymentAmountKas: corrected, note: "Amount corrected from chain data." });
  } else {
    return;
  }
  persistState();
  if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
}

// Consumes a pool address immediately and persistently — burning an address is
// safe, reusing one is not, so this is written before the payment is even built.
function markPoolAddressUsed(address, contactAddress) {
  const poolState = loadPoolState();
  const pool = poolState.theirPools[contactAddress] || [];
  const entry = pool.find((item) => item.address === address);
  if (!entry || entry.used === true) return false;
  entry.used = true;
  savePoolState(poolState);
  return true;
}

// The destination for a Send KAS to `contact`: an unused address from their
// stored pool, else the chatting address — exact pre-pool behavior.
// Deliberately NOT gated on the sender's privacy toggle: the RECIPIENT'S
// privacy governs the destination — if they shared fresh addresses, money
// arrives on one no matter the sender's setting. The sender's toggle only
// governs the funding side.
//
// CROSS-DEVICE DOUBLE-PAY PROTECTION: the `used` flags are device-local, so with
// the same seed on two clients a payment sent from one never marks the address
// used on the other — the second payment would land on the very address the pool
// exists to keep fresh, linking both payments on chain. Before consuming a
// candidate this probes its on-chain history (uncached, deliberately bypassing
// spendingUsageCache / the batched balance reader — both can be stale or absent
// exactly when it matters); an address with ANY history is marked used locally
// (the skip persists) and the walk moves on. A probe that cannot answer (network
// error) consumes the candidate anyway: a rare reuse beats failing the payment or
// silently leaking it to the chatting address. The walk is bounded by the stored
// pool (at most POOL_MAX_STORED entries), each probe a one-row body with a
// timeout. If every pool address turns out used, the payment falls back to the
// chatting address and the low-water addr_pool_request asks for more.
async function consumePoolPaymentDestination(contact) {
  let skippedUsedElsewhere = 0;
  try {
    // Each iteration either consumes the head unused address (returns) or marks it
    // used (persisted) and re-reads, so the loop is bounded by the stored pool size.
    for (;;) {
      const pool = loadPoolState().theirPools[contact.address] || [];
      const next = pool.find((entry) => !entry.used);
      if (!next) return contact.address;
      if (!isValidKaspaAddressString(next.address)) return contact.address;
      if (await spendingAddressHasHistory(next.address, { timeoutMs: 8000 })) {
        // Another device (or a straggler payment) already used this one — burn it
        // locally so no future send here picks it either, and walk on. A consume
        // that somehow didn't stick would loop forever, so bail to the chatting
        // address instead.
        if (!markPoolAddressUsed(next.address, contact.address)) return contact.address;
        skippedUsedElsewhere += 1;
        appendEngineLog(`Pool address …${next.address.slice(-10)} for ${shortAddress(contact.address)} already has chain history (used by another device?) — skipping.`);
        continue;
      }
      markPoolAddressUsed(next.address, contact.address);
      appendEngineLog(`Payment to ${shortAddress(contact.address)} will use fresh pool address …${next.address.slice(-10)}.`);
      return next.address;
    }
  } finally {
    // Addresses another device already paid: the pool may have silently run low, and
    // the normal post-send request never fires for a chatting-address fallback.
    if (skippedUsedElsewhere > 0) maybeRequestMorePoolAddresses(contact);
  }
}

// True when the NEXT payment to this contact would go to a fresh pool address —
// drives the subtle fresh-address indicator in the payment composer. Matches
// consumePoolPaymentDestination: recipient-governed, independent of the
// sender's privacy toggle.
function willPayViaFreshPoolAddress(contactAddress) {
  if (!engine.address) return false;
  const pool = loadPoolState().theirPools[contactAddress] || [];
  return pool.some((entry) => !entry.used);
}

// Sends the payment_notice envelope after a pool-address payment was accepted
// (fire-and-forget), then checks the low-water mark. No-op for
// chatting-address payments — existing detection covers those.
function handlePoolPaymentSubmitted(contact, txid, amountSompi, destinationAddress) {
  if (!contact || destinationAddress === contact.address) return;
  const payload = JSON.stringify({ type: "payment_notice", txId: String(txid).toLowerCase(), amountSompi, address: destinationAddress });
  enqueuePoolOperation(async () => {
    await sendInvisiblePoolEnvelope(contact, payload);
    appendEngineLog(`Sent payment_notice for ${String(txid).slice(0, 12)}…`);
  }).catch((error) => {
    // The payment itself succeeded; a lost notice only means the recipient's
    // bubble waits for their own discovery. Not retried automatically.
    appendEngineLog(`payment_notice send failed for ${String(txid).slice(0, 12)}…: ${error.message}`);
  }).finally(() => {
    maybeRequestMorePoolAddresses(contact);
  });
}

// Chats Payment Privacy toggle propagation — both directions are PROACTIVE
// (the toggle is the switch, not conversation-opening): OFF revokes our pool
// at every contact holding one (empty replace:true), ON clears revocation
// markers and immediately re-offers to every established contact not holding
// a live pool. Toggle broadcasts honor the 60s per-contact transition gap.
function handleChatsPrivacyToggleChanged(enabled) {
  if (!engine.address) return;
  if (enabled) {
    const poolState = loadPoolState();
    poolState.revokedContacts = [];
    savePoolState(poolState);
    reofferPoolsForChatsPrivacyOn();
  } else {
    revokeOfferedPoolsForChatsPrivacyOff();
  }
  refreshComposerAvailableBalance();
}

// Toggle-ON targets are the union of two lanes:
//
// - POOL HISTORY (persisted state): every contact who previously HELD a live pool
//   of ours — at least one reservation historically flagged offered — and doesn't
//   hold one now (offered marker unset: our revoke landed). This lane reaches
//   contacts whose CONVERSATION was deleted since the offer, which the
//   conversation-derived lane below cannot see. They proved establishment when
//   first offered, so no conversation re-check.
// - NEVER-OFFERED ESTABLISHED CONVERSATIONS: the toggle is the switch, so contacts
//   the lazy offer hasn't reached yet get theirs now instead of on next open.
//
// Both lanes skip contacts currently holding a live pool (nothing to resend) and
// contacts who revoked our pool at them (nothing until they re-engage). A contact
// whose row no longer exists in the address book is skipped — an offer needs a
// contact to route to, unlike a revoke.
function reofferPoolCandidateContacts(poolState) {
  const revokedAtUs = poolState.contactsRevokedAtUs || [];
  return Object.entries(poolState.myReservations || {})
    .filter(([contactAddress, entries]) => !poolState.offeredContacts.includes(contactAddress)
      && !revokedAtUs.includes(contactAddress)
      && (entries || []).some((r) => r.offered))
    .map(([contactAddress]) => contactAddress)
    .sort();
}

function reofferPoolsForChatsPrivacyOn() {
  const poolState = loadPoolState();
  const revokedAtUs = poolState.contactsRevokedAtUs || [];
  const conversationTargets = (state.conversations || [])
    .map((entry) => ({ entry, contact: contactForConversation(entry) }))
    .filter(({ entry, contact }) => contact?.address
      && isPoolEstablishedConversation(entry)
      && !poolState.offeredContacts.includes(contact.address)
      && !revokedAtUs.includes(contact.address))
    .map(({ contact }) => contact.address);
  const seen = new Set();
  const targets = [...reofferPoolCandidateContacts(poolState), ...conversationTargets]
    .filter((address) => !seen.has(address) && seen.add(address));
  if (!targets.length) return;
  appendEngineLog(`Chats Payment Privacy on — re-offering pools to ${targets.length} contact(s).`);
  enqueuePoolOperation(async () => {
    for (const contactAddress of targets) {
      if (!chatsPrivacyEnabled()) return; // flipped back OFF mid-broadcast
      const contact = state.contacts.find((entry) => entry.address === contactAddress);
      if (!contact) continue; // deleted contact: nothing to offer to
      try {
        await reserveAndSendAddressPool(contact, { replace: true, toggleTransition: true });
      } catch (error) {
        appendEngineLog(`Toggle-on pool offer to ${shortAddress(contactAddress)} failed (lazy offer remains): ${error.message}`);
      }
    }
  });
}

// Contacts currently holding a live pool of OUR addresses — the target list for
// the toggle-off revoke broadcast. Derived from PERSISTED state two ways and
// unioned, so a contact can never dodge a revoke through marker drift: the
// offered-marker set AND every contact with at least one reservation actually
// flagged offered. Minus already-revoked contacts.
function contactsHoldingOurPool(poolState = loadPoolState()) {
  const holders = new Set(poolState.offeredContacts);
  for (const [contactAddress, entries] of Object.entries(poolState.myReservations || {})) {
    if ((entries || []).some((r) => r.offered)) holders.add(contactAddress);
  }
  return [...holders].filter((address) => !(poolState.revokedContacts || []).includes(address)).sort();
}

// How many follow-up sweeps a single toggle-off runs to reach gap-deferred or
// send-failed contacts before giving up until the next toggle-off.
const POOL_MAX_REVOKE_RETRY_PASSES = 3;

// One revoke per contact currently holding our pool, per PERSISTED state.
// Revokes bypass the reservation caps (a revoke must always be allowed out) but
// honor the 60s transition gap. A contact DELETED from the address book still
// gets its revoke — it may well still believe our pool is live, and the envelope
// only needs the address, so a placeholder contact stands in. A pass that leaves
// stragglers (gap-deferred, or whose send failed) schedules itself again once the
// gap has certainly expired, up to POOL_MAX_REVOKE_RETRY_PASSES passes, so a
// single toggle-off converges to "no contact holds a live pool" without the user
// flipping again. Contacts still unreached after the last pass keep their markers,
// stay eligible on the next toggle-off, and drain their residual pool meanwhile.
function revokeOfferedPoolsForChatsPrivacyOff(retryPass = 0) {
  const walletAtStart = engine.address;
  const targets = contactsHoldingOurPool();
  if (!targets.length) return;
  appendEngineLog(`Chats Payment Privacy off — revoking offered pools at ${targets.length} contact(s) (pass ${retryPass}).`);
  enqueuePoolOperation(async () => {
    for (const contactAddress of targets) {
      if (chatsPrivacyEnabled()) return; // flipped back ON mid-broadcast
      if (engine.address !== walletAtStart) return; // account switched mid-broadcast
      const current = loadPoolState();
      if (current.revokedContacts.includes(contactAddress)) continue;
      if (isWithinPoolServeGap(current, contactAddress, true)) {
        appendEngineLog(`Revoke to ${shortAddress(contactAddress)} deferred by transition gap.`);
        continue;
      }
      // A deleted contact still holds our pool — the revoke must reach them too.
      const contact = state.contacts.find((entry) => entry.address === contactAddress)
        || { id: `pool-revoke-${contactAddress}`, address: contactAddress };
      try {
        await sendInvisiblePoolEnvelope(contact, JSON.stringify({ type: "addr_pool", addresses: [], replace: true }));
        const after = loadPoolState();
        if (!after.revokedContacts.includes(contactAddress)) after.revokedContacts.push(contactAddress);
        after.offeredContacts = after.offeredContacts.filter((a) => a !== contactAddress);
        after.lastPoolServeAt[contactAddress] = Date.now();
        // The reservations stay recorded and historically offered (still reserved for
        // this contact alone, still watched — a payment racing the revoke must land and
        // render), but they leave the ACTIVE set: their rows revert to normal,
        // hideable addresses until a re-offer reactivates them.
        for (const entry of after.myReservations[contactAddress] || []) entry.activeOffer = false;
        savePoolState(after);
        appendEngineLog(`Revoked pool at ${shortAddress(contactAddress)}.`);
      } catch (error) {
        appendEngineLog(`Pool revoke to ${shortAddress(contactAddress)} failed (non-fatal, residual drain applies): ${error.message}`);
      }
    }

    // Convergence pass: anyone still holding (gap-deferred or send-failed) gets
    // another sweep once the transition gap has certainly expired. Bounded so a
    // permanently unreachable contact can't keep the chain alive forever.
    if (retryPass >= POOL_MAX_REVOKE_RETRY_PASSES) return;
    if (!contactsHoldingOurPool().length) return;
    if (chatsPrivacyEnabled() || engine.address !== walletAtStart) return;
    window.setTimeout(() => {
      // Still the same account, still off? (An account switch invalidates the pass —
      // the next toggle-off for that account starts its own chain.)
      if (engine.address !== walletAtStart || chatsPrivacyEnabled()) return;
      revokeOfferedPoolsForChatsPrivacyOff(retryPass + 1);
    }, POOL_TOGGLE_TRANSITION_GAP_MS + 5000);
  });
}

// Settings > Chats toggle wiring (per-account, applied on account switches too).
const chatsPrivacyToggleEl = document.querySelector("[data-chats-privacy-toggle]");
function refreshChatsPrivacyToggle() {
  if (chatsPrivacyToggleEl) chatsPrivacyToggleEl.checked = chatsPrivacyEnabled();
}
chatsPrivacyToggleEl?.addEventListener("change", () => {
  setChatsPrivacyEnabled(chatsPrivacyToggleEl.checked);
  handleChatsPrivacyToggleChanged(chatsPrivacyToggleEl.checked);
});
refreshChatsPrivacyToggle();

// --- Profile card summary (active spending address + live balance) ---
// Last-known spending balances/used-state, persisted per account — stale-while-revalidate:
// the dropdown and Manage Addresses paint the cached numbers instantly while the live batched
// refresh runs behind them (the same pattern cold storage uses for its account cache).
const SPENDING_BAL_CACHE_KEY = "kachat-spending-balcache-v1"; // { [address]: { kas, used } }
function loadSpendingBalCache() {
  try { return JSON.parse(localStorage.getItem(accountScopedKey(SPENDING_BAL_CACHE_KEY)) || "{}") || {}; }
  catch { return {}; }
}
function saveSpendingBalCacheEntries(updates) {
  try {
    const map = loadSpendingBalCache();
    for (const [address, entry] of Object.entries(updates)) map[address] = entry;
    localStorage.setItem(accountScopedKey(SPENDING_BAL_CACHE_KEY), JSON.stringify(map));
  } catch { /* cache is best-effort */ }
}

async function refreshSpendingSummary() {
  const mnemonic = activeAccountMnemonic();
  if (!mnemonic || !engine.kaspa) {
    activeSpendingAddress = null;
    if (spendingBalanceEl) spendingBalanceEl.textContent = "-- KAS";
    return;
  }
  const address = deriveSpendingAddressAt(getActiveSpendingIndex());
  if (!address) {
    activeSpendingAddress = null;
    if (spendingBalanceEl) spendingBalanceEl.textContent = "-- KAS";
    return;
  }
  activeSpendingAddress = address;
  // Paint the last-known balance immediately; the live number replaces it when it lands.
  const cached = loadSpendingBalCache()[address];
  if (spendingBalanceEl) spendingBalanceEl.textContent = cached?.kas != null ? `${cached.kas} KAS` : "…";
  try {
    const bal = await engine.balanceForAddress(address);
    saveSpendingBalCacheEntries({ [address]: { ...(cached || {}), kas: String(bal.totalKas) } });
    // Guard against a stale response if the active address changed meanwhile.
    if (activeSpendingAddress === address && spendingBalanceEl) {
      spendingBalanceEl.textContent = `${bal.totalKas} KAS`;
    }
  } catch (error) {
    if (activeSpendingAddress === address && spendingBalanceEl && cached?.kas == null) {
      spendingBalanceEl.textContent = "-- KAS";
    }
  }
}

// --- Manage Spending Addresses screen ---
const STAR_PATH = "m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3 1.1-6.5L2.6 9.8l6.5-.9Z";
// Each row: tap the body to open the address's detail (transactions + send/
// receive); the ⋯ button opens a menu (Rename / Copy / Show QR / Set as Primary),
// matching iOS's ManageAddressesView.
function spendingRowHtml(index, address, state, balanceText, used, hasDomain = false, reserved = false) {
  const isActive = index === state.activeIndex;
  const label = spendingLabelFor(state, index);
  const usageBadge = used === true
    ? '<span class="spending-address-usage used">Used</span>'
    : used === false
      ? '<span class="spending-address-usage unused">Unused</span>'
      : "";
  const domainBadge = hasDomain ? '<span class="spending-address-domain-tag">Contains domain</span>' : "";
  // Actively offered to a contact as a chat-payment-privacy address: tagged so the
  // user knows what the row is, and not hideable while the offer stands.
  const privacyBadge = reserved ? '<span class="spending-address-domain-tag">Chat privacy</span>' : "";
  const menuItems = [
    `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="rename" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>Rename Address</button>`,
    `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="copy" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>Copy Address</button>`,
    `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="receive" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/></svg>Show QR Code</button>`,
    isActive ? "" : `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="activate" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>Set as Primary Address</button>`,
    // Hide straight from the row (iOS parity) — same flag the Address Visibility checklist
    // edits, with the same guards (never the primary, never a funded address, never an
    // actively offered pool address) enforced on tap.
    isActive || reserved ? "" : `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="hide" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/></svg>Hide Address</button>`,
  ].filter(Boolean).join("");
  return `
    <div class="spending-address-row${isActive ? " active" : ""}" data-spending-row="${index}">
      <button type="button" class="spending-address-row-main" data-spending-open="${index}" aria-label="Open spending address #${index}">
        <div class="spending-address-row-head">
          <span class="spending-address-index">#${index}</span>
          <span class="spending-address-label">${escapeHtml(label)}</span>
          ${isActive ? `<span class="spending-address-active-badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>Primary</span>` : ""}
          ${usageBadge}
          ${domainBadge}
          ${privacyBadge}
        </div>
        <span class="spending-address-value">${escapeHtml(shortAddress(address))}</span>
        <span class="spending-address-balance" data-spending-balance-cell="${index}">${escapeHtml(balanceText)}</span>
        <span class="spending-address-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
      </button>
      <div class="spending-address-row-menu-wrap">
        <button type="button" class="spending-row-menu-btn" data-spending-menu-toggle="${index}" aria-haspopup="true" aria-expanded="false" aria-label="Address actions for #${index}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
        </button>
        <div class="spending-row-menu" data-spending-menu="${index}" role="menu" hidden>${menuItems}</div>
      </div>
    </div>`;
}

// An address counts as "used" if it holds a balance now or has any on-chain
// transaction history — mirrors iOS's everUsed || balance>0. Deliberately
// uncached (`cache: "no-store"`, no memo): the pool-payment probe needs the live
// answer, and a stale "unused" there means a double-pay. `timeoutMs` bounds that
// probe so a hung REST endpoint can't stall a send; other callers keep the
// previous unbounded behavior.
async function spendingAddressHasHistory(address, { timeoutMs = 0 } = {}) {
  if (!String(address || "").trim()) return false; // empty address would 404 as /addresses//…
  try {
    const url = `${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(address)}/full-transactions?limit=1&offset=0&resolve_previous_outpoints=no`;
    const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal });
    if (!response.ok) return false;
    const txs = await response.json();
    return Array.isArray(txs) && txs.length > 0;
  } catch { return false; }
}

async function renderSpendingList() {
  if (!spendingListEl) return;
  if (!activeAccountMnemonic()) {
    spendingListEl.innerHTML = '<p class="spending-address-empty">This account has no recovery phrase, so spending addresses aren\'t available.</p>';
    return;
  }
  // Repair first: an actively offered pool address can never be hidden, so a row
  // left hidden by the old born-hidden design comes back into the list here.
  unhideActivePoolReservations();
  const state = getSpendingState();
  const primaryIndex = state.activeIndex;
  const token = ++spendingListToken;
  const hiddenSet = new Set(state.hidden);
  const reservedAddresses = activePoolReservationAddressSet();
  const items = [];
  for (let i = 0; i <= state.maxIndex; i++) {
    // Hidden addresses (Address Visibility screen) stay off the main list; the
    // primary can never be hidden.
    if (hiddenSet.has(i) && i !== primaryIndex) continue;
    const address = deriveSpendingAddressAt(i);
    if (address) items.push({ index: i, address });
  }
  if (!items.length) {
    spendingListEl.innerHTML = '<p class="spending-address-empty">No spending addresses yet.</p>';
    return;
  }
  // Provisional render with LAST-KNOWN balances/used-state (index order) so the list appears
  // instantly with real numbers instead of a wall of "…" — the live refresh replaces it below.
  const balCache = loadSpendingBalCache();
  spendingListEl.innerHTML = items
    .map((it) => spendingRowHtml(it.index, it.address, state, balCache[it.address]?.kas != null ? `${balCache[it.address].kas} KAS` : "…", balCache[it.address]?.used ?? null, false, reservedAddresses.has(it.address)))
    .join("");
  // Enrich with live balance + used-state, then order: primary first → funded → rest.
  // Balances arrive in ONE batched node call (the per-address loop this replaces fired one
  // round trip per row); history checks run only for zero-balance rows, 4 at a time, so a
  // long list can't burst the REST rate limiter into 429s.
  let batched = null;
  try { batched = await spendingBalancesBatchSompi(items.map((it) => it.address)); }
  catch { batched = null; /* node pool unreachable — fall back below */ }
  if (token !== spendingListToken) return;
  const enriched = items.map((it) => {
    let kas = 0, totalKas = null;
    if (batched) {
      const sompi = batched.get(it.address) || 0;
      kas = Number(sompi) / 1e8;
      totalKas = trimKas8(kas);
    } else if (balCache[it.address]?.kas != null) {
      totalKas = balCache[it.address].kas;
      kas = Number(totalKas) || 0;
    }
    return { ...it, kas, totalKas, used: kas > 0 ? true : (balCache[it.address]?.used ?? null) };
  });
  const pendingUsed = enriched.filter((e) => e.kas === 0 && e.used == null);
  for (let base = 0; base < pendingUsed.length; base += 4) {
    await Promise.all(pendingUsed.slice(base, base + 4).map(async (e) => {
      e.used = await spendingAddressHasHistory(e.address);
    }));
    if (token !== spendingListToken) return;
  }
  const cacheUpdates = {};
  for (const e of enriched) {
    if (e.totalKas != null) cacheUpdates[e.address] = { kas: e.totalKas, used: e.used === true ? true : (balCache[e.address]?.used ?? e.used) };
  }
  saveSpendingBalCacheEntries(cacheUpdates);
  if (token !== spendingListToken) return;
  // Batched, cached KNS assets-by-owner lookups drive the "Contains domain"
  // tag and promote those rows into the funded group (iOS parity). The
  // refresh is debounced/backed-off inside engine/kns.js, so reopening the
  // screen is normally cache-only.
  let domainOwning = new Set();
  try {
    await engine.refreshKnsIfNeeded?.(enriched.map((e) => e.address));
  } catch { /* tags fall back to whatever is cached */ }
  for (const e of enriched) {
    const info = engine.peekKnsAddressInfo?.(e.address);
    if (info?.allDomains?.length) domainOwning.add(e.address);
  }
  if (token !== spendingListToken) return;
  // Primary first → addresses with a balance OR a KNS domain (stable within
  // the group) → fresh/unused last.
  const rank = (e) => (e.index === primaryIndex ? 0 : (e.kas > 0 || domainOwning.has(e.address)) ? 1 : 2);
  enriched.sort((a, b) => rank(a) - rank(b) || a.index - b.index);
  spendingListEl.innerHTML = enriched
    .map((e) => spendingRowHtml(e.index, e.address, state, e.totalKas != null ? `${e.totalKas} KAS` : "-- KAS", e.used, domainOwning.has(e.address), reservedAddresses.has(e.address)))
    .join("");
}

function openSpendingManageScreen() {
  if (!spendingManageScreen) return;
  if (!activeAccountMnemonic()) {
    showCopyToast("This account has no recovery phrase, so spending addresses aren't available.");
    return;
  }
  spendingManageScreen.hidden = false;
  renderSpendingList();
}

function closeSpendingManageScreen() {
  closeAllSpendingMenus();
  if (spendingManageScreen) spendingManageScreen.hidden = true;
}

function closeAllSpendingMenus() {
  spendingListEl?.querySelectorAll("[data-spending-menu]").forEach((m) => { m.hidden = true; });
  spendingListEl?.querySelectorAll("[data-spending-menu-toggle]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

// ---------------------------------------------------------------------------
// Address Visibility (iOS parity: SpendingAddressVisibilityView). Paged 50 at a
// time; the right arrow never runs out — future pages derive addresses beyond
// the revealed bound on the fly, and toggling one on raises the bound while
// keeping the intermediate indices hidden so they don't flood the main list.
// ---------------------------------------------------------------------------

const SPENDING_VIS_PAGE_SIZE = 50;
let spendingVisibilityPage = 0;
let spendingVisibilityToken = 0;
// Session cache (address → { kas, used }) so paging back and forth is instant.
const spendingUsageCache = new Map();

async function spendingUsageFor(address) {
  if (spendingUsageCache.has(address)) return spendingUsageCache.get(address);
  let kas = 0;
  try { kas = Number((await engine.balanceForAddress(address)).totalKas) || 0; } catch { /* unknown, treat as 0 */ }
  // "Used" is monotonic (a used address can never become unused), so a persisted used=true
  // from the Manage-list cache answers without the history round-trip — only never-used
  // addresses still need the live probe (they can become used at any moment). Balances above
  // are always live; this only skips the redundant history REST call.
  const cachedEntry = loadSpendingBalCache()[address];
  const cachedUsed = cachedEntry?.used === true;
  const used = kas > 0 || cachedUsed ? true : await spendingAddressHasHistory(address);
  if (used && !cachedUsed) saveSpendingBalCacheEntries({ [address]: { ...cachedEntry, used: true } });
  const result = { kas, used };
  spendingUsageCache.set(address, result);
  return result;
}

// `reserved` = the address is actively offered to a contact as a Chats Payment
// Privacy pool address (iOS SpendingAddressVisibilityView): the row shows CHECKED
// and inert, labeled so the user knows why. A contact may pay into it at any
// moment, so its owner must always be able to see it; once the offer is no longer
// active the row becomes an ordinary, hideable row again.
function spendingVisibilityRowHtml(index, address, state, visible, reserved = false) {
  const isPrimary = index === state.activeIndex;
  const locked = isPrimary || reserved;
  const customLabel = (state.labels?.[index] ?? state.labels?.[String(index)] ?? "").toString().trim();
  const checkSvg = visible
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path class="spending-vis-check" d="m7.5 12.5 3 3 6-6.5"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/></svg>';
  return `
    <div class="spending-visibility-row${visible ? "" : " off"}" data-vis-row="${index}">
      <button type="button" class="spending-visibility-toggle${visible ? " on" : ""}" data-spending-vis-toggle="${index}" aria-pressed="${visible}"${locked ? ' aria-disabled="true" style="opacity:.45"' : ""} aria-label="Toggle visibility of spending address #${index}">${checkSvg}</button>
      <div class="spending-visibility-info">
        <div class="spending-visibility-head">
          <span class="spending-address-index">#${index}</span>
          ${isPrimary ? `<span class="spending-address-active-badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>Primary</span>` : ""}
          ${reserved ? '<span class="spending-visibility-label">Chat privacy address</span>' : ""}
          ${customLabel ? `<span class="spending-visibility-label">${escapeHtml(customLabel)}</span>` : ""}
          <span class="spending-address-usage spending-visibility-usage" data-vis-usage="${index}">…</span>
        </div>
        <span class="spending-address-value">${address ? escapeHtml(shortAddress(address)) : "deriving…"}</span>
      </div>
    </div>`;
}

async function renderSpendingVisibilityPage() {
  if (!spendingVisibilityList) return;
  // Repair first: an actively offered pool address can never be hidden.
  unhideActivePoolReservations();
  const state = getSpendingState();
  const hiddenSet = new Set(state.hidden);
  const reservedAddresses = activePoolReservationAddressSet();
  const start = spendingVisibilityPage * SPENDING_VIS_PAGE_SIZE;
  const end = start + SPENDING_VIS_PAGE_SIZE - 1;
  if (spendingVisRangeEl) spendingVisRangeEl.textContent = `#${start} - #${end}`;
  if (spendingVisPrevBtn) spendingVisPrevBtn.disabled = spendingVisibilityPage === 0;
  const token = ++spendingVisibilityToken;
  const rows = [];
  for (let i = start; i <= end; i++) {
    const address = deriveSpendingAddressAt(i);
    const reserved = Boolean(address) && reservedAddresses.has(address);
    const visible = (i <= state.maxIndex && !hiddenSet.has(i)) || reserved;
    rows.push({ index: i, address, visible, reserved });
  }
  spendingVisibilityList.innerHTML = rows
    .map((r) => spendingVisibilityRowHtml(r.index, r.address, state, r.visible, r.reserved))
    .join("");
  // Usage fill: funded rows show their balance, the rest Used/Unused. Chunked
  // like the discovery scan so a page can't burst the REST rate limiter.
  for (let base = 0; base < rows.length; base += 5) {
    await Promise.all(rows.slice(base, base + 5).map(async (r) => {
      if (!r.address) return;
      const usage = await spendingUsageFor(r.address);
      if (token !== spendingVisibilityToken) return;
      const cell = spendingVisibilityList.querySelector(`[data-vis-usage="${r.index}"]`);
      if (!cell) return;
      if (usage.kas > 0) {
        cell.textContent = `${usage.kas.toFixed(4)} KAS`;
        cell.classList.add("used");
      } else {
        cell.textContent = usage.used ? "Used" : "Unused";
        cell.classList.add(usage.used ? "used" : "unused");
      }
    }));
    if (token !== spendingVisibilityToken) return;
  }
}

function openSpendingVisibilityScreen() {
  if (!spendingVisibilityScreen) return;
  if (!activeAccountMnemonic()) {
    showCopyToast("This account has no recovery phrase, so spending addresses aren't available.");
    return;
  }
  spendingVisibilityPage = 0;
  // Every open starts from live data: any action since the last visit (generate, a payment
  // landing, consolidate) may have changed balances/usage, and this cache never expired.
  spendingUsageCache.clear();
  spendingVisibilityScreen.hidden = false;
  renderSpendingVisibilityPage();
}

function closeSpendingVisibilityScreen() {
  if (spendingVisibilityScreen) spendingVisibilityScreen.hidden = true;
  // Instant sync: the main list reflects the visibility edits the moment this closes.
  renderSpendingList();
}

spendingVisibilityOpenBtn?.addEventListener("click", openSpendingVisibilityScreen);
spendingVisibilityCloseBtn?.addEventListener("click", closeSpendingVisibilityScreen);
spendingVisibilityDoneBtn?.addEventListener("click", closeSpendingVisibilityScreen);
spendingVisPrevBtn?.addEventListener("click", () => {
  if (spendingVisibilityPage === 0) return;
  spendingVisibilityPage -= 1;
  renderSpendingVisibilityPage();
});
spendingVisNextBtn?.addEventListener("click", () => {
  spendingVisibilityPage += 1;
  renderSpendingVisibilityPage();
});

spendingVisibilityList?.addEventListener("click", async (event) => {
  // The WHOLE row toggles, not just the checkmark.
  const row = event.target.closest("[data-vis-row]");
  if (!row) return;
  const index = Number(row.dataset.visRow);
  if (!Number.isInteger(index) || index < 0) return;
  const state = getSpendingState();
  if (index === state.activeIndex) {
    showCopyToast("The primary address is always visible.");
    return;
  }
  const hiddenSet = new Set(state.hidden);
  const address = deriveSpendingAddressAt(index);
  // Actively offered payment-pool addresses are inert here: a contact may pay into
  // one at any moment, so it stays visible until the offer is no longer active.
  if (address && activePoolReservationAddressSet().has(address)) {
    showCopyToast("This address is offered to a contact for chat payment privacy, so it stays visible.");
    return;
  }
  const visible = index <= state.maxIndex && !hiddenSet.has(index);
  if (visible) {
    // Funded addresses stay visible — same rule iOS enforces store-side.
    const usage = address ? await spendingUsageFor(address) : { kas: 0 };
    if (usage.kas > 0) {
      showCopyToast("Addresses holding a balance stay visible.");
      return;
    }
    hiddenSet.add(index);
    saveSpendingState({ hidden: Array.from(hiddenSet) });
  } else if (index <= state.maxIndex) {
    hiddenSet.delete(index);
    saveSpendingState({ hidden: Array.from(hiddenSet) });
  } else {
    // Revealing an index beyond the current bound: raise the bound but keep the
    // intermediate indices hidden so they don't flood the main list (iOS parity:
    // WalletManager.revealSpendingAddress).
    for (let i = state.maxIndex + 1; i < index; i++) hiddenSet.add(i);
    hiddenSet.delete(index);
    saveSpendingState({ maxIndex: index, hidden: Array.from(hiddenSet) });
  }
  renderSpendingVisibilityPage();
});

spendingListEl?.addEventListener("click", async (event) => {
  // ⋯ menu toggle — open this row's menu, close any other.
  const toggle = event.target.closest("[data-spending-menu-toggle]");
  if (toggle) {
    const idx = toggle.dataset.spendingMenuToggle;
    const menu = spendingListEl.querySelector(`[data-spending-menu="${idx}"]`);
    const willOpen = menu && menu.hidden;
    closeAllSpendingMenus();
    if (menu && willOpen) { menu.hidden = false; toggle.setAttribute("aria-expanded", "true"); }
    return;
  }

  const btn = event.target.closest("[data-spending-action]");
  if (btn) {
    closeAllSpendingMenus();
    const index = Math.max(0, Math.floor(Number(btn.dataset.index) || 0));
    const action = btn.dataset.spendingAction;
    const state = getSpendingState();
    if (action === "activate") {
      saveSpendingState({ activeIndex: index });
      renderSpendingList();
      refreshSpendingSummary();
      showCopyToast(`Spending address #${index} is now the primary address.`);
    } else if (action === "copy") {
      const addr = deriveSpendingAddressAt(index);
      if (!addr) { showCopyToast("Address is not ready yet."); return; }
      try { await copyTextToClipboard(addr); showCopyToast("Spending address copied to clipboard."); }
      catch (error) { appendEngineLog(error.message); }
    } else if (action === "receive") {
      const addr = deriveSpendingAddressAt(index);
      if (!addr) { showCopyToast("Address is not ready yet."); return; }
      const cell = spendingListEl.querySelector(`[data-spending-balance-cell="${index}"]`);
      openChattingAddressScreen({ address: addr, balanceText: cell?.textContent || "", subtitle: null });
    } else if (action === "rename") {
      const current = spendingLabelFor(state, index);
      const next = await promptText("Label for this spending address", current);
      if (next == null) return;
      const labels = { ...state.labels };
      const trimmed = String(next).trim();
      if (trimmed) labels[index] = trimmed; else { delete labels[index]; delete labels[String(index)]; }
      saveSpendingState({ labels });
      renderSpendingList();
    } else if (action === "hide") {
      // Same guards as the Address Visibility checklist toggle: never the primary (the menu
      // already omits it there), never an address holding a balance — checked live.
      if (index === state.activeIndex) { showCopyToast("The primary address is always visible."); return; }
      const addr = deriveSpendingAddressAt(index);
      if (!addr) { showCopyToast("Address is not ready yet."); return; }
      if (activePoolReservationAddressSet().has(addr)) {
        showCopyToast("This address is offered to a contact for chat payment privacy, so it stays visible.");
        return;
      }
      let balanceSompi = 0;
      try { balanceSompi = (await spendingBalancesBatchSompi([addr])).get(addr) || 0; } catch { balanceSompi = 0; }
      if (balanceSompi > 0) { showCopyToast("Addresses holding a balance stay visible."); return; }
      const hiddenSet = new Set(state.hidden || []);
      hiddenSet.add(index);
      saveSpendingState({ hidden: Array.from(hiddenSet) });
      renderSpendingList();
      showCopyToast("Address hidden. Re-enable it in Address Visibility.");
    }
    return;
  }

  // Tapping the row body (not a control) opens the address detail screen.
  const open = event.target.closest("[data-spending-open]");
  if (open) {
    closeAllSpendingMenus();
    openSpendingDetailScreen(Math.max(0, Math.floor(Number(open.dataset.spendingOpen) || 0)));
  }
});

// Click anywhere outside an open row menu closes it.
document.addEventListener("click", (event) => {
  if (!event.target.closest(".spending-address-row-menu-wrap")) closeAllSpendingMenus();
});

// --- Spending address detail (balance + Transaction History / UTXOs + Receive /
// Send), mirrors iOS's SpendingAddressTransactionHistoryView. Reuses the
// address-parameterized transaction loader; UTXOs come from balanceForAddress. ---
const spendingDetailScreen = document.querySelector("[data-spending-detail-screen]");
const spendingDetailTitle = document.querySelector("[data-spending-detail-title]");
const spendingDetailBalanceEl = document.querySelector("[data-spending-detail-balance]");
const spendingDetailAddressEl = document.querySelector("[data-spending-detail-address]");
const spendingDetailExplorer = document.querySelector("[data-spending-detail-explorer]");
const spendingDetailTxList = document.querySelector("[data-spending-detail-transactions]");
const spendingDetailUtxoList = document.querySelector("[data-spending-detail-utxos]");
const spendingDetailKnsList = document.querySelector("[data-spending-detail-kns]");
let spendingDetailIndex = 0;
let spendingDetailAddress = null;

function setSpendingDetailTabCount(tab, count) {
  const button = document.querySelector(`[data-spending-detail-tab="${tab}"]`);
  if (!button) return;
  const base = tab === "utxos" ? "UTXOs" : tab === "kns" ? "KNS Domains" : "History";
  button.textContent = count == null ? base : `${base} (${count})`;
}

// KNS domains owned by this specific spending address (assets-by-owner
// lookup, engine-cached). Cards match the address-detail domain rows; tapping
// one opens the transfer modal scoped to THIS address's derivation index —
// the domain transfer is then owned/funded/signed by that derived key.
async function loadSpendingDetailKnsDomains(address) {
  if (!spendingDetailKnsList) return;
  spendingDetailKnsList.innerHTML = '<div class="manage-address-empty">Loading…</div>';
  setSpendingDetailTabCount("kns", null);
  const index = spendingDetailIndex;
  let info = null;
  try { info = await engine.fetchKnsAddressInfo(address); } catch { info = engine.peekKnsAddressInfo?.(address) || null; }
  if (spendingDetailAddress !== address) return;
  const domains = info?.allDomains || [];
  setSpendingDetailTabCount("kns", domains.length);
  if (!domains.length) {
    spendingDetailKnsList.innerHTML = '<div class="manage-address-empty">No KNS domains on this address.</div>';
    return;
  }
  spendingDetailKnsList.replaceChildren();
  for (const domain of domains) {
    const status = String(domain.status || "default").trim().toLowerCase();
    const transferable = Boolean(domain.inscriptionId) && status !== "listed";
    const card = document.createElement("button");
    card.type = "button";
    card.className = "kns-domain-card";
    card.disabled = !transferable;
    const name = document.createElement("strong");
    name.textContent = domain.fullName;
    card.append(name);
    const hint = document.createElement("small");
    hint.textContent = transferable ? "Tap to send this domain" : "This domain is listed and can't be sent right now.";
    card.append(hint);
    card.addEventListener("click", () => {
      if (!transferable) return;
      openKnsTransferModal({ domain: domain.fullName, assetId: domain.inscriptionId, spendingIndex: index });
    });
    spendingDetailKnsList.appendChild(card);
  }
}

// --- Send KNS Domain modal (spending-address transfers) ---
const knsTransferModal = document.querySelector("[data-kns-transfer-modal]");
const knsTransferDomainEl = document.querySelector("[data-kns-transfer-domain]");
const knsTransferRecipientInput = document.querySelector("[data-kns-transfer-recipient]");
const knsTransferErrorEl = document.querySelector("[data-kns-transfer-error]");
const knsTransferStatusEl = document.querySelector("[data-kns-transfer-status]");
const knsTransferSendBtn = document.querySelector("[data-kns-transfer-send]");
let knsTransferContext = null;
let knsTransferInFlight = false;

function openKnsTransferModal({ domain, assetId, spendingIndex = null }) {
  if (!knsTransferModal) return;
  knsTransferContext = { domain, assetId, spendingIndex };
  if (knsTransferDomainEl) knsTransferDomainEl.textContent = domain;
  if (knsTransferRecipientInput) knsTransferRecipientInput.value = "";
  if (knsTransferErrorEl) knsTransferErrorEl.hidden = true;
  if (knsTransferStatusEl) knsTransferStatusEl.hidden = true;
  if (knsTransferSendBtn) knsTransferSendBtn.disabled = false;
  knsTransferModal.hidden = false;
  knsTransferRecipientInput?.focus();
}

function closeKnsTransferModal() {
  if (knsTransferInFlight) return; // don't abandon a running inscription mid-flight
  if (knsTransferModal) knsTransferModal.hidden = true;
  knsTransferContext = null;
}

const KNS_TRANSFER_STATUS_LABELS = {
  "resolving-recipient": "Resolving recipient domain…",
  "verifying-ownership": "Verifying domain ownership…",
  "committing": "Broadcasting commit transaction…",
  "committed": "Commit accepted…",
  "revealing": "Broadcasting reveal inscription…",
  "revealed": "Reveal accepted…",
  "verifying": "Waiting for the KNS indexer…",
};

async function submitKnsTransfer() {
  if (!knsTransferContext || knsTransferInFlight) return;
  const recipient = String(knsTransferRecipientInput?.value || "").trim();
  if (!recipient) {
    if (knsTransferErrorEl) { knsTransferErrorEl.textContent = "Enter a recipient address or .kas domain."; knsTransferErrorEl.hidden = false; }
    return;
  }
  knsTransferInFlight = true;
  if (knsTransferSendBtn) knsTransferSendBtn.disabled = true;
  if (knsTransferErrorEl) knsTransferErrorEl.hidden = true;
  const { domain, assetId, spendingIndex } = knsTransferContext;
  try {
    const result = await engine.transferKnsDomain({
      domain,
      assetId,
      toAddress: recipient,
      mnemonic: spendingIndex != null ? activeAccountMnemonic() : null,
      spendingIndex,
      passphrase: spendingIndex != null ? activeAccountPassphrase() : "",
      onStatus: (patch) => {
        const label = KNS_TRANSFER_STATUS_LABELS[patch?.status];
        if (label && knsTransferStatusEl) { knsTransferStatusEl.textContent = label; knsTransferStatusEl.hidden = false; }
      },
    });
    knsTransferInFlight = false;
    closeKnsTransferModal();
    showCopyToast(result.verified
      ? `${domain} sent to ${shortAddress(result.recipientAddress)}.`
      : `${domain} transfer broadcast — the indexer may take a moment to reflect it.`);
    if (spendingDetailAddress) loadSpendingDetailKnsDomains(spendingDetailAddress);
  } catch (error) {
    knsTransferInFlight = false;
    if (knsTransferSendBtn) knsTransferSendBtn.disabled = false;
    if (knsTransferStatusEl) knsTransferStatusEl.hidden = true;
    if (knsTransferErrorEl) { knsTransferErrorEl.textContent = error.message; knsTransferErrorEl.hidden = false; }
  }
}

knsTransferSendBtn?.addEventListener("click", submitKnsTransfer);
document.querySelector("[data-kns-transfer-close]")?.addEventListener("click", closeKnsTransferModal);
document.querySelector("[data-kns-transfer-cancel]")?.addEventListener("click", closeKnsTransferModal);

function renderSpendingDetailUtxos(address, utxos) {
  if (!spendingDetailUtxoList) return;
  if (!utxos.length) { spendingDetailUtxoList.innerHTML = '<div class="manage-address-empty">No UTXOs at this address.</div>'; return; }
  const labels = getUtxoLabels(address);
  spendingDetailUtxoList.replaceChildren();
  // Compound UTXOs (matches iOS): only meaningful with more than one UTXO. Merges them into one
  // by sending the balance back to this same address, so future sends need fewer inputs.
  if (utxos.length > 1) {
    const consolidate = document.createElement("button");
    consolidate.type = "button";
    consolidate.className = "manage-address-consolidate-btn";
    consolidate.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7 3 12l5 5"/><path d="M16 7l5 5-5 5"/><path d="M3 12h18"/></svg><span>Compound UTXOs</span>';
    consolidate.addEventListener("click", () => openSendKaspaModal({ compound: true, spendingIndex: spendingDetailIndex }));
    spendingDetailUtxoList.appendChild(consolidate);
  }
  for (const entry of utxos) {
    const outpointKey = utxoOutpointKey(entry.outpoint || {});
    const label = labels[outpointKey];
    const row = document.createElement("div");
    row.className = "manage-address-utxo-row";
    const meta = document.createElement("div"); meta.className = "manage-address-utxo-meta";
    if (label) { const l = document.createElement("span"); l.className = "manage-address-utxo-label"; l.textContent = label; meta.appendChild(l); }
    const op = document.createElement("span"); op.className = "manage-address-utxo-outpoint"; op.textContent = outpointKey; meta.appendChild(op);
    const amt = document.createElement("span"); amt.className = "manage-address-utxo-amount"; amt.textContent = `${sompiToKasDisplay(BigInt(entry.amount || 0))} KAS`;
    row.append(meta, amt);
    spendingDetailUtxoList.appendChild(row);
  }
}

async function loadSpendingDetailUtxos(address) {
  if (!spendingDetailUtxoList) return;
  spendingDetailUtxoList.innerHTML = '<div class="manage-address-empty">Loading…</div>';
  try {
    const balance = await engine.balanceForAddress(address);
    if (spendingDetailAddress !== address) return; // user navigated away
    renderSpendingDetailUtxos(address, balance.entries || []);
    setSpendingDetailTabCount("utxos", (balance.entries || []).length);
    if (spendingDetailBalanceEl) spendingDetailBalanceEl.textContent = `${balance.totalKas} KAS`;
  } catch (error) {
    if (spendingDetailAddress !== address) return;
    spendingDetailUtxoList.innerHTML = `<div class="manage-address-empty">Could not load UTXOs: ${escapeHtml(error.message)}</div>`;
  }
}

// Compound/consolidate every UTXO at the spending-detail address into one, by sending the balance
// back to itself (matches iOS's WithdrawKaspaView isCompoundMode). Confirm first, then broadcast.
let spendingConsolidateInFlight = false;
async function consolidateSpendingDetailUtxos() {
  const address = spendingDetailAddress;
  const index = spendingDetailIndex;
  if (!address || spendingConsolidateInFlight) return;
  if (!activeAccountMnemonic()) { showCopyToast("This account has no recovery phrase, so consolidation isn't available."); return; }
  let balance;
  try { balance = await engine.balanceForAddress(address); } catch (error) { showCopyToast(`Could not load balance: ${error.message}`); return; }
  const entries = balance.entries || [];
  if (entries.length < 2) { showCopyToast("Nothing to consolidate — this address has a single UTXO."); return; }
  const maxKas = Number(balance.totalKas) - 0.001; // headroom for the network fee (many inputs)
  if (!(maxKas > 0)) { showCopyToast("Balance too low to consolidate."); return; }
  if (!await confirmText(`Combine ${entries.length} UTXOs at this address into one? This sends the balance back to this same address and pays a small network fee.`)) return;
  spendingConsolidateInFlight = true;
  showCopyToast("Consolidating UTXOs…");
  try {
    await engine.sendFromSpending({
      mnemonic: activeAccountMnemonic(),
      index,
      passphrase: activeAccountPassphrase(),
      destinationAddress: address, // self-send merges the inputs into one output
      amountKas: trimKas8(maxKas),
      feeKas: "0",
      selectedOutpoints: null,
    });
    showCopyToast("UTXOs consolidated.");
    if (spendingDetailAddress === address) loadSpendingDetailUtxos(address);
    refreshSpendingSummary?.();
  } catch (error) {
    showCopyToast(`Consolidation failed: ${error.message}`);
  } finally {
    spendingConsolidateInFlight = false;
  }
}

function setSpendingDetailTab(tab) {
  document.querySelectorAll("[data-spending-detail-tab]").forEach((b) => b.classList.toggle("active", b.dataset.spendingDetailTab === tab));
  document.querySelectorAll("[data-spending-detail-panel]").forEach((p) => { p.hidden = p.dataset.spendingDetailPanel !== tab; });
}

async function openSpendingDetailScreen(index) {
  if (!spendingDetailScreen) return;
  const address = deriveSpendingAddressAt(index);
  if (!address) { showCopyToast("Address is not ready yet."); return; }
  spendingDetailIndex = index;
  spendingDetailAddress = address;
  const state = getSpendingState();
  if (spendingDetailTitle) spendingDetailTitle.textContent = spendingLabelFor(state, index);
  if (spendingDetailAddressEl) spendingDetailAddressEl.textContent = shortAddress(address);
  if (spendingDetailBalanceEl) spendingDetailBalanceEl.textContent = "…";
  if (spendingDetailExplorer) spendingDetailExplorer.href = explorerAddressUrl(address);
  setSpendingDetailTab("transactions");
  setSpendingDetailTabCount("utxos", null);
  setSpendingDetailTabCount("kns", null);
  spendingDetailScreen.hidden = false;
  loadManageAddressTransactions(address, spendingDetailTxList);
  loadSpendingDetailUtxos(address);
  loadSpendingDetailKnsDomains(address);
}

function closeSpendingDetailScreen() {
  if (spendingDetailScreen) spendingDetailScreen.hidden = true;
  spendingDetailAddress = null;
}

function refreshSpendingDetailIfOpen() {
  if (spendingDetailScreen && !spendingDetailScreen.hidden && spendingDetailAddress) {
    loadManageAddressTransactions(spendingDetailAddress, spendingDetailTxList);
    loadSpendingDetailUtxos(spendingDetailAddress);
    loadSpendingDetailKnsDomains(spendingDetailAddress);
  }
}

document.querySelectorAll("[data-spending-detail-tab]").forEach((b) => b.addEventListener("click", () => setSpendingDetailTab(b.dataset.spendingDetailTab)));
document.querySelector("[data-close-spending-detail]")?.addEventListener("click", closeSpendingDetailScreen);
document.querySelector("[data-spending-detail-receive]")?.addEventListener("click", () => {
  if (!spendingDetailAddress) return;
  openChattingAddressScreen({ address: spendingDetailAddress, balanceText: spendingDetailBalanceEl?.textContent || "", subtitle: null });
});
document.querySelector("[data-spending-detail-send]")?.addEventListener("click", () => openSendKaspaModal({ spendingIndex: spendingDetailIndex }));

// "Address Actions" footer menu (Generate / Discover / Send All to Primary),
// matching iOS's toolbar Menu. Opens upward above the button.
function closeSpendingActionsMenu() {
  if (spendingActionsMenu) spendingActionsMenu.hidden = true;
  spendingActionsToggle?.setAttribute("aria-expanded", "false");
}
spendingActionsToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!spendingActionsMenu) return;
  const willOpen = spendingActionsMenu.hidden;
  spendingActionsMenu.hidden = !willOpen;
  spendingActionsToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".spending-actions-wrap")) closeSpendingActionsMenu();
});

// Generate recycles the LOWEST truly-unused index (iOS parity:
// lowestUnusedSpendingAddress): skips the primary, anything holding a balance
// or with on-chain history, and any payment-pool reservation (those are
// promised to a contact and must never be re-offered). Falls back to
// revealing maxIndex+1 when every revealed index is spoken for.

// Every revealed address's balance in ONE gRPC round trip — the per-address loop this
// replaces could fail a low index's lookup mid-scan and skip it "to be safe", which on a
// big wallet made Generate land on a higher number than the actual lowest unused one.
async function spendingBalancesBatchSompi(addresses) {
  await engine.connect();
  const response = await engine.withRpc(
    (rpc) => rpc.getUtxosByAddresses(addresses),
    { retries: 1, label: "Spending balances" }
  );
  const byAddress = new Map(addresses.map((a) => [a, 0]));
  for (const entry of response?.entries || []) {
    const address = String(entry.address ?? entry.entry?.address ?? "");
    if (!byAddress.has(address)) continue;
    byAddress.set(address, byAddress.get(address) + Number(entry.amount ?? entry.entry?.amount ?? 0));
  }
  return byAddress;
}

let spendingGenerateBusy = false;
spendingGenerateBtn?.addEventListener("click", async () => {
  closeSpendingActionsMenu();
  if (!activeAccountMnemonic()) { showCopyToast("This account has no recovery phrase."); return; }
  if (spendingGenerateBusy) return;
  spendingGenerateBusy = true;
  try {
    const state = getSpendingState();
    const poolState = loadPoolState();
    const addressByIndex = new Map();
    for (let i = 0; i <= state.maxIndex; i++) {
      const address = deriveSpendingAddressAt(i);
      if (address) addressByIndex.set(i, address);
    }
    let balances = null;
    try { balances = await spendingBalancesBatchSompi([...addressByIndex.values()]); }
    catch { balances = null; } // node pool unreachable — fall back to per-address lookups
    let pick = null;
    const alreadyHidden = new Set(state.hidden.map(Number));
    for (const [i, address] of addressByIndex) {
      // The pick has to be HIDDEN as well as unused, which is what makes press N+1 different
      // from press N. Without it the lowest unused index, once revealed, satisfies every test
      // again on the next press, un-hiding an index that is already visible does nothing, and
      // Generate reports the same row as "ready" forever. iOS and Android both require it; this
      // port had dropped it.
      if (!alreadyHidden.has(i)) continue;
      if (i === state.activeIndex) continue;
      if (isReservedPoolAddress(poolState, address)) continue;
      if (balances) {
        if ((balances.get(address) || 0) > 0) continue;
      } else {
        let kas = 0;
        try { kas = Number((await engine.balanceForAddress(address)).totalKas) || 0; }
        catch { continue; } // balance unknown — skip rather than risk recycling a funded address
        if (kas > 0) continue;
      }
      if (await spendingAddressHasHistory(address)) continue;
      pick = i;
      break;
    }
    const hiddenSet = new Set(state.hidden);
    let readyIndex;
    if (pick != null) {
      hiddenSet.delete(pick);
      saveSpendingState({ hidden: Array.from(hiddenSet) });
      readyIndex = pick;
    } else {
      readyIndex = state.maxIndex + 1;
      hiddenSet.delete(readyIndex);
      saveSpendingState({ maxIndex: readyIndex, hidden: Array.from(hiddenSet) });
    }
    renderSpendingList();
    showCopyToast(`Spending address #${readyIndex} is ready.`);
  } finally {
    spendingGenerateBusy = false;
  }
});

// Send All Kaspa to the primary spending address: sweep every non-primary
// spending address that holds a balance into the primary one (matches iOS's
// consolidateToPrimary). Money-moving — confirmed first, fires one tx per source.
spendingConsolidateBtn?.addEventListener("click", async () => {
  closeSpendingActionsMenu();
  if (spendingConsolidating) return;
  if (!activeAccountMnemonic()) { showCopyToast("This account has no recovery phrase."); return; }
  const state = getSpendingState();
  const primaryIndex = state.activeIndex;
  const primaryAddress = deriveSpendingAddressAt(primaryIndex);
  if (!primaryAddress) { showCopyToast("Primary spending address is not ready yet."); return; }

  spendingConsolidating = true;
  const label = spendingConsolidateBtn.querySelector("span");
  const original = label?.textContent;
  try {
    // Find every non-primary funded address.
    const sources = [];
    for (let i = 0; i <= state.maxIndex; i++) {
      if (i === primaryIndex) continue;
      const addr = deriveSpendingAddressAt(i);
      if (!addr) continue;
      try {
        const bal = await engine.balanceForAddress(addr);
        const kas = Number(bal?.totalKas) || 0;
        if (kas > 0) sources.push({ index: i, kas });
      } catch { /* skip on lookup failure */ }
    }
    if (!sources.length) { showCopyToast("No non-primary spending addresses hold a balance."); return; }

    const total = sources.reduce((sum, s) => sum + s.kas, 0);
    const ok = await confirmText(
      `Send all Kaspa from ${sources.length} spending address${sources.length > 1 ? "es" : ""} (~${total} KAS) to your primary spending address #${primaryIndex}?\n\nThis broadcasts ${sources.length} transaction${sources.length > 1 ? "s" : ""}.`
    );
    if (!ok) return;

    if (label) label.textContent = "Sending…";
    // 0.0001 KAS headroom over the network fee — same buffer the Max button uses.
    const FEE_BUFFER = 0.0001;
    let sent = 0;
    for (const src of sources) {
      const amountKas = src.kas - FEE_BUFFER;
      if (amountKas <= 0) continue;
      try {
        await engine.sendFromSpending({
          mnemonic: activeAccountMnemonic(),
          index: src.index,
          passphrase: activeAccountPassphrase(),
          destinationAddress: primaryAddress,
          amountKas: String(amountKas),
          feeKas: "0",
          selectedOutpoints: null,
        });
        sent += 1;
      } catch (error) {
        appendEngineLog(`Consolidate #${src.index} failed: ${error.message}`);
      }
    }
    showCopyToast(sent ? `Swept ${sent} address${sent > 1 ? "es" : ""} to your primary address.` : "Nothing could be swept.");
    renderSpendingList();
    refreshSpendingSummary();
    refreshSpendingDetailIfOpen();
  } finally {
    spendingConsolidating = false;
    if (label && original != null) label.textContent = original;
  }
});

// Discovery scan: reveal any derived address that already holds a BALANCE or owns a KNS
// DOMAIN. The old gap-only loop started at maxIndex+1 and quit after 20 consecutive empties,
// so a funded address far out (e.g. #97 on a fresh install) was unreachable. Now a guaranteed
// window (at least the first SPENDING_SCAN_MIN_INDEX indices) is always swept - balances in
// parallel chunks, KNS through the batched/cached/429-paced engine lookup - and a classic
// gap-limit tail extends past the window while hits keep landing near its end.
const SPENDING_SCAN_MIN_INDEX = 120;
spendingScanBtn?.addEventListener("click", async () => {
  closeSpendingActionsMenu();
  if (!activeAccountMnemonic()) { showCopyToast("This account has no recovery phrase."); return; }
  const label = spendingScanBtn.querySelector("span");
  const original = label?.textContent;
  spendingScanBtn.disabled = true;
  if (label) label.textContent = "Scanning…";
  try {
    const state = getSpendingState();
    let highestHit = state.maxIndex;
    const scanEnd = Math.max(state.maxIndex + SPENDING_GAP_LIMIT, SPENDING_SCAN_MIN_INDEX);

    const windowEntries = [];
    for (let i = state.maxIndex + 1; i <= scanEnd; i++) {
      const address = deriveSpendingAddressAt(i);
      if (address) windowEntries.push({ index: i, address });
    }

    // Balance sweep in small paced chunks — a hard parallel burst trips api.kaspa.org's rate
    // limiter, whose error responses carry no CORS headers and flood the console red.
    const hits = new Set();
    for (let start = 0; start < windowEntries.length; start += 5) {
      const chunk = windowEntries.slice(start, start + 5);
      if (label) label.textContent = `Scanning… #${chunk[0].index}`;
      await Promise.all(chunk.map(async (entry) => {
        try {
          const bal = await engine.balanceForAddress(entry.address);
          if ((Number(bal?.totalKas) || 0) > 0) hits.add(entry.index);
        } catch { /* lookup failed: skip this index */ }
      }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // KNS domains count as "in use" too - the engine batches, caches, and paces these.
    if (label) label.textContent = "Checking KNS…";
    try { await engine.refreshKnsIfNeeded?.(windowEntries.map((entry) => entry.address)); }
    catch { /* fall back to whatever is cached */ }
    for (const entry of windowEntries) {
      const info = engine.peekKnsAddressInfo?.(entry.address);
      if (info?.allDomains?.length) hits.add(entry.index);
    }
    for (const index of hits) highestHit = Math.max(highestHit, index);

    // Gap-limit tail past the guaranteed window: keeps extending while recent hits keep the
    // gap alive (seeded with the distance from the last hit to the window's end).
    let index = scanEnd + 1;
    let consecutiveEmpty = Math.max(0, scanEnd - highestHit);
    while (consecutiveEmpty < SPENDING_GAP_LIMIT) {
      const address = deriveSpendingAddressAt(index);
      if (!address) break;
      if (label) label.textContent = `Scanning… #${index}`;
      let held = 0;
      try { const bal = await engine.balanceForAddress(address); held = Number(bal?.totalKas) || 0; }
      catch { break; }
      if (held > 0) { highestHit = index; consecutiveEmpty = 0; }
      else consecutiveEmpty += 1;
      index += 1;
    }

    if (highestHit > state.maxIndex) {
      saveSpendingState({ maxIndex: highestHit });
      renderSpendingList();
      showCopyToast(`Found addresses in use up to #${highestHit}.`);
    } else {
      showCopyToast("No additional spending addresses with a balance or KNS domain found.");
    }
  } finally {
    spendingScanBtn.disabled = false;
    if (label && original != null) label.textContent = original;
  }
});

document.querySelector("[data-copy-spending-address]")?.addEventListener("click", async () => {
  if (!activeSpendingAddress) { showCopyToast("Spending address is not ready yet."); return; }
  try { await copyTextToClipboard(activeSpendingAddress); showCopyToast("Spending address copied to clipboard."); }
  catch (error) { appendEngineLog(error.message); }
});
document.querySelector("[data-open-spending-receive]")?.addEventListener("click", () => {
  if (!activeSpendingAddress) { showCopyToast("Spending address is not ready yet."); return; }
  openChattingAddressScreen({ address: activeSpendingAddress, balanceText: spendingBalanceEl?.textContent || "", subtitle: null });
});
document.querySelector("[data-open-spending-send]")?.addEventListener("click", () => openSendKaspaModal({ spendingIndex: getActiveSpendingIndex() }));
document.querySelector("[data-open-spending-manage]")?.addEventListener("click", openSpendingManageScreen);
document.querySelector("[data-close-spending-manage]")?.addEventListener("click", closeSpendingManageScreen);

// --- Send from a spending address (Stage C). Reuses makeSendController with a
// spending-scoped sendFn (engine.sendFromSpending) + balance source, so recipient
// resolution / amount validation / progress behave exactly like the chatting send. ---
const spendingSendModal = document.querySelector("[data-spending-send-modal]");
const spendingSendSourceEl = document.querySelector("[data-spending-send-source]");
const spendingSendFeeButtons = document.querySelectorAll("[data-spending-send-fee]");
const spendingSendFeeCustom = document.querySelector("[data-spending-send-fee-custom]");
const spendingSendFeeSummary = document.querySelector("[data-spending-send-fee-summary]");
let spendingSendIndex = 0;
let spendingSendFeeTier = "0";

function spendingSendGetFeeKas() {
  const v = Number(spendingSendFeeCustom?.value);
  return isFinite(v) && v > 0 ? String(v) : "0";
}
function updateSpendingSendFeeSummary() {
  if (!spendingSendFeeSummary) return;
  const labels = { "0": "Normal", "0.00002": "Priority", custom: "Custom" };
  spendingSendFeeSummary.textContent = `${labels[spendingSendFeeTier] || "Normal"} · ${spendingSendGetFeeKas()} KAS`;
}
function selectSpendingSendFeeTier(tier) {
  spendingSendFeeTier = tier;
  spendingSendFeeButtons.forEach((b) => b.classList.toggle("active", b.dataset.spendingSendFee === tier));
  if (spendingSendFeeCustom) {
    if (tier === "custom") { spendingSendFeeCustom.readOnly = false; spendingSendFeeCustom.value = ""; spendingSendFeeCustom.focus(); }
    else { spendingSendFeeCustom.readOnly = true; spendingSendFeeCustom.value = tier; }
  }
  updateSpendingSendFeeSummary();
}
spendingSendFeeButtons.forEach((b) => b.addEventListener("click", () => selectSpendingSendFeeTier(b.dataset.spendingSendFee)));
spendingSendFeeCustom?.addEventListener("input", updateSpendingSendFeeSummary);

function closeSpendingSendModal() { if (spendingSendModal) spendingSendModal.hidden = true; }

const spendingSendController = makeSendController({
  recipient: document.querySelector("[data-spending-send-recipient]"),
  resolvedHint: document.querySelector("[data-spending-send-resolved]"),
  amount: document.querySelector("[data-spending-send-amount]"),
  balanceHint: document.querySelector("[data-spending-send-balance]"),
  error: document.querySelector("[data-spending-send-error]"),
  progress: document.querySelector("[data-spending-send-progress]"),
  submit: document.querySelector("[data-spending-send-submit]"),
}, {
  onOpen: () => { if (spendingSendModal) spendingSendModal.hidden = false; },
  onClose: () => { closeSpendingSendModal(); if (spendingManageScreen && !spendingManageScreen.hidden) renderSpendingList(); refreshSpendingDetailIfOpen(); refreshSpendingSummary(); },
  getFeeKas: spendingSendGetFeeKas,
  getBalance: () => engine.balanceForAddress(deriveSpendingAddressAt(spendingSendIndex)),
  sendFn: ({ destination, amountKas, feeKas, selectedOutpoints }) => engine.sendFromSpending({
    mnemonic: activeAccountMnemonic(),
    index: spendingSendIndex,
    passphrase: activeAccountPassphrase(),
    destinationAddress: destination,
    amountKas,
    feeKas,
    selectedOutpoints: selectedOutpoints && selectedOutpoints.length ? selectedOutpoints : null,
  }),
});

function openSpendingSendModal(index) {
  if (!activeAccountMnemonic()) {
    showCopyToast("This account has no recovery phrase, so spending sends aren't available.");
    return;
  }
  spendingSendIndex = Math.max(0, Math.floor(Number(index) || 0));
  const addr = deriveSpendingAddressAt(spendingSendIndex);
  if (!addr) { showCopyToast("Spending address is not ready yet."); return; }
  if (spendingSendSourceEl) spendingSendSourceEl.textContent = `From spending #${spendingSendIndex} · ${shortAddress(addr)}`;
  selectSpendingSendFeeTier("0");
  spendingSendController.open();
}

document.querySelectorAll("[data-close-spending-send]").forEach((b) => b.addEventListener("click", closeSpendingSendModal));

// Refresh keeps your place: the active tab persists and is re-applied at boot (the
// screens themselves refetch their data, so the restored spot is fresh, not a snapshot).
const UI_SPOT_TAB_KEY = "kachat-ui-spot-tab-v1";

function restoreLastAppTab() {
  try {
    const tab = localStorage.getItem(UI_SPOT_TAB_KEY);
    if (tab && tab !== "chats" && document.querySelector(`.sidebar-tab[data-app-tab="${tab}"]`)) {
      setActiveAppTab(tab);
      applyDockLayout(); // falls back to chats if this account hides that tab
    }
  } catch { /* restoring the spot is best-effort */ }
}

/// The Hub section on screen, or null for the Hub's own grid.
///
/// A section opened from the Hub owns the whole screen and looks exactly as it does from its own
/// dock slot - that is the point of placement, that where a feature LIVES does not change what it
/// IS. So the screen shown and the dock item highlighted come apart here: the dock still shows
/// Kaspa Hub as selected, and clicking Kaspa Hub again is the way back out, the same button that
/// got you in (iOS EcosystemRouter).
let hubSection = null;

function setActiveAppTab(tab) {
  // Child Mode choke point: every tab switch (dock click, restore, deep link,
  // programmatic) funnels through here, so gated tabs simply become Chats.
  if (isChildModeEnabled() && CHILD_HIDDEN_TABS.includes(tab)) tab = "chats";
  // A tab that lives in the Hub is REACHED through the Hub, so asking for it directly - a deep
  // link, a notification tap, the restored spot - opens it there rather than failing.
  if (tab !== "hub" && !dockPrefs.dock.includes(tab) && dockPrefs.hub.includes(tab)) {
    hubSection = tab;
    tab = "hub";
  } else if (tab !== "hub") {
    hubSection = null;
  }
  const screenTab = tab === "hub" && hubSection ? hubSection : tab;
  try { localStorage.setItem(UI_SPOT_TAB_KEY, screenTab); } catch { /* best-effort */ }
  sidebarTabButtons.forEach((button) => {
    const active = button.dataset.appTab === tab;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  currentAppTab = tab;
  const isChats = screenTab === "chats";
  if (appSidebar) appSidebar.hidden = !isChats;
  if (newChatFab) newChatFab.hidden = !isChats;
  appTabScreens.forEach((screen) => {
    screen.hidden = screen.dataset.appTabScreen !== screenTab;
  });
  if (!isChats) {
    if (conversation) conversation.hidden = true;
    if (detailEmptyState) detailEmptyState.hidden = true;
    if (groupChatScreen) groupChatScreen.hidden = true;
  } else {
    // Back on Chats: a group thread owns the pane if one is open, else the 1:1 does.
    const groupOpen = Boolean(activeGroupId);
    if (groupChatScreen) groupChatScreen.hidden = !groupOpen;
    if (conversation) conversation.hidden = groupOpen || !activeConversationId;
    if (detailEmptyState) detailEmptyState.hidden = groupOpen || Boolean(activeConversationId);
  }
  updateDetailActiveClass();
  if (screenTab === "profile") { refreshOwnKnsProfile(); refreshSpendingSummary(); }
  if (screenTab === "kaposts") refreshKaPostsFeed();
  if (screenTab === "broadcasts") refreshBroadcasts();
  else stopBroadcastPolling();
  if (screenTab === "portfolio") refreshPortfolio();
  if (screenTab === "cold-storage") refreshColdStorage();
  if (screenTab === "swaps") refreshSwaps();
}

sidebarTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.appTab;
    // Kaspa Hub is its own way back: clicking it while a section is open closes the section and
    // returns to the grid, so the button that opened a section is the one that leaves it.
    if (tab === "hub" && currentAppTab === "hub" && hubSection) hubSection = null;
    setActiveAppTab(tab);
    applyDockLayout();
  });
});

// ---------------------------------------------------------------------------
// 4.1 dock: iOS's dock, on the desktop.
//
// 4.0 hid this behind a right-edge handle that you hovered to peek and clicked to pin. Nothing
// else in the app works that way and nothing on the phones does either - the dock there is simply
// on screen, on every tab, always. So the handle, the hover peek, the pin and the auto-hide timer
// are all gone: the dock is a permanent bar and the only thing left to decide is what is in it.
//
// Placement, not visibility (iOS AppTab). Every assignable tab is either IN THE DOCK or IN THE
// HUB, and always in exactly one of them, so a feature can never end up nowhere. The dock holds
// five items at most - the phones' hard cap, kept here so an arrangement made on one device
// describes the same dock on the other - and Kaspa Hub and Profile are pinned into it: the Hub
// because it is what holds everything not in the dock, Profile because it is the way to Settings
// and the account list.
// ---------------------------------------------------------------------------

const DOCK_PREFS_KEY = "kachat-dock-prefs-v1"; // account-scoped: { dock, hub }
const DOCK_MAX_ITEMS = 5;
const DOCK_PINNED = ["hub", "profile"];
/** Tabs the user can place. Excludes the pinned two. */
const DOCK_ASSIGNABLE = ["chats", "portfolio", "cold-storage", "swaps", "kaposts", "broadcasts", "apps"];
const DOCK_DEFAULT_ORDER = ["cold-storage", "portfolio", "chats", "hub", "profile", "kaposts", "broadcasts", "swaps", "apps"];
const DOCK_DEFAULT = ["cold-storage", "portfolio", "chats", "hub", "profile"];
const HUB_DEFAULT = ["kaposts", "broadcasts", "swaps", "apps"];
/** Full names, used in the Hub grid and Customize Dock where a dock label is too short. */
const TAB_FULL_NAMES = { apps: "Kaspa Websites", swaps: "ChangeNOW Swap" };

function tabFullName(tab) {
  if (TAB_FULL_NAMES[tab]) return TAB_FULL_NAMES[tab];
  const btn = document.querySelector(`.sidebar-tab[data-app-tab="${tab}"] > span:last-child`);
  return btn?.textContent?.trim() || tab;
}

/** The tab's dock glyph, cloned out of its dock button so the two can never drift apart. */
function tabIconMarkup(tab) {
  const icon = document.querySelector(`.sidebar-tab[data-app-tab="${tab}"] .sidebar-tab-icon`);
  return icon ? icon.innerHTML : "";
}

function loadDockPrefs() {
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem(accountScopedKey(DOCK_PREFS_KEY)) || "null"); }
    catch { return null; }
  })();

  // 4.0 blobs were { hiddenTabs, order } against a dock with no cap. Read them into placement:
  // the order's first entries fill the dock up to the cap and everything else - including what
  // used to be "hidden", since there is no off state any more - lands in the Hub.
  if (stored && Array.isArray(stored.hiddenTabs) && !Array.isArray(stored.dock)) {
    const order = (Array.isArray(stored.order) ? stored.order : DOCK_DEFAULT_ORDER)
      .filter((t) => DOCK_ASSIGNABLE.includes(t) && !stored.hiddenTabs.includes(t));
    const dock = [];
    for (const tab of order) {
      if (dock.length >= DOCK_MAX_ITEMS - DOCK_PINNED.length) break;
      dock.push(tab);
    }
    return normalizeDockPrefs({ dock, hub: [] });
  }

  if (stored && Array.isArray(stored.dock)) return normalizeDockPrefs(stored);
  return normalizeDockPrefs({ dock: [...DOCK_DEFAULT], hub: [...HUB_DEFAULT] });
}

/** Resolves any stored pair into a legal arrangement: pinned present, cap respected, every
 *  assignable tab in exactly one list. Anything a stored list has never heard of (a tab added by
 *  an update) is appended in default order rather than lost. */
function normalizeDockPrefs(prefs) {
  const seen = new Set();
  const dock = [];
  for (const tab of Array.isArray(prefs.dock) ? prefs.dock : []) {
    if (!DOCK_ASSIGNABLE.includes(tab) && !DOCK_PINNED.includes(tab)) continue;
    if (seen.has(tab) || dock.length >= DOCK_MAX_ITEMS) continue;
    seen.add(tab); dock.push(tab);
  }
  // Reinserted whatever the stored list says, so no saved arrangement can leave the app without
  // the Hub that holds everything else, or without Profile.
  for (const pinned of DOCK_PINNED) {
    if (seen.has(pinned)) continue;
    if (dock.length >= DOCK_MAX_ITEMS) dock.pop();
    const at = Math.min(DOCK_DEFAULT.indexOf(pinned), dock.length);
    dock.splice(at < 0 ? dock.length : at, 0, pinned);
    seen.add(pinned);
  }
  const hub = [];
  for (const tab of Array.isArray(prefs.hub) ? prefs.hub : []) {
    if (!DOCK_ASSIGNABLE.includes(tab) || seen.has(tab)) continue;
    seen.add(tab); hub.push(tab);
  }
  for (const tab of DOCK_DEFAULT_ORDER) {
    if (!DOCK_ASSIGNABLE.includes(tab) || seen.has(tab)) continue;
    seen.add(tab); hub.push(tab);
  }
  return { dock, hub };
}

let dockPrefs = loadDockPrefs();

function persistDockPrefs() {
  localStorage.setItem(accountScopedKey(DOCK_PREFS_KEY), JSON.stringify(dockPrefs));
}

function reloadDockPrefsForAccount() {
  dockPrefs = loadDockPrefs();
  hubSection = null;
  applyDockLayout();
}

/** Child Mode is applied at RENDER time and never written into the stored arrangement - saving
 *  while it is on would bake those tabs out permanently, so turning it off restores the user's
 *  own layout untouched. This is the single choke point, so a gated tab reaches neither the dock
 *  nor the Hub grid. */
function tabAllowed(tab) {
  return !(isChildModeEnabled() && CHILD_HIDDEN_TABS.includes(tab));
}

/** What the dock actually renders, in order. */
function dockVisibleTabs() {
  return dockPrefs.dock.filter(tabAllowed);
}

/** What the Kaspa Hub grid shows: everything assignable that is not in the dock. */
function hubVisibleTabs() {
  return dockPrefs.hub.filter(tabAllowed);
}

/// Publishes the dock's real width so the chats pane can stand beside it rather than under it.
///
/// The dock is a centred pill whose width depends on how many tabs you keep in it (Customize Dock
/// allows up to five), so a hardcoded figure would either let the pane overlap a wide dock or
/// waste space next to a narrow one. Measured instead, and re-measured whenever the dock changes
/// or the window does.
function publishDockWidth() {
  const tabbar = document.querySelector(".sidebar-tabbar");
  if (!tabbar) return;
  const width = Math.round(tabbar.getBoundingClientRect().width);
  if (width > 0) document.documentElement.style.setProperty("--dock-width", `${width}px`);
}

window.addEventListener("resize", publishDockWidth);
if (typeof ResizeObserver === "function") {
  const dockEl = document.querySelector(".sidebar-tabbar");
  if (dockEl) new ResizeObserver(publishDockWidth).observe(dockEl);
}

function applyDockLayout() {
  const tabbar = document.querySelector(".sidebar-tabbar");
  if (!tabbar) return;
  const visible = dockVisibleTabs();

  // Each button is appended ONCE, visible ones first in the user's order and the rest trailing
  // behind hidden. Without the guard the second list re-appended every visible tab, so the live
  // dock always came out in DEFAULT order and reordering in Customize Dock did nothing to it.
  const placed = new Set();
  for (const tab of [...visible, ...DOCK_DEFAULT_ORDER]) {
    if (placed.has(tab)) continue;
    placed.add(tab);
    const btn = tabbar.querySelector(`.sidebar-tab[data-app-tab="${tab}"]`);
    if (!btn) continue;
    tabbar.appendChild(btn);
    btn.hidden = !visible.includes(tab);
  }

  renderHubGrid();
  renderDockEditor();
  publishDockWidth();

  // Apps lives in either the dock OR the Profile view, never both. Once it holds a dock slot,
  // drop the redundant "Apps" row from Profile; bring it back when it moves into the Hub.
  const profileAppsRow = document.querySelector("[data-open-apps-screen]");
  if (profileAppsRow) profileAppsRow.hidden = visible.includes("apps");

  // A tab that just left the dock must not stay on screen with nothing selected, and a Hub
  // section that just moved INTO the dock must not render inside the Hub as well.
  if (hubSection && !hubVisibleTabs().includes(hubSection)) {
    hubSection = null;
    if (currentAppTab === "hub") setActiveAppTab("hub");
  }
  // The tab on screen just left the dock. It has not been switched OFF - it moved to the Hub - so
  // it reopens there rather than throwing the user back to Chats; setActiveAppTab does that
  // routing itself. Only a tab that is in neither place (Child Mode turned it off) falls back.
  if (!visible.includes(currentAppTab)) {
    setActiveAppTab(hubVisibleTabs().includes(currentAppTab)
      ? currentAppTab
      : (visible.includes("chats") ? "chats" : "hub"));
  }
}

// --- Kaspa Hub grid ---------------------------------------------------------

const hubGrid = document.querySelector("[data-hub-grid]");
const hubEmpty = document.querySelector("[data-hub-empty]");

function hubTileMarkup(tab) {
  return `<button class="hub-tile" type="button" data-hub-tile="${tab}">
    <span class="hub-tile-icon" aria-hidden="true">${tabIconMarkup(tab)}</span>
    <span class="hub-tile-label">${escapeHtml(tabFullName(tab))}</span>
  </button>`;
}

function renderHubGrid() {
  if (!hubGrid) return;
  const tabs = hubVisibleTabs();
  hubGrid.innerHTML = tabs.map(hubTileMarkup).join("");
  hubGrid.hidden = tabs.length === 0;
  if (hubEmpty) hubEmpty.hidden = tabs.length > 0;
}

hubGrid?.addEventListener("click", (event) => {
  const tile = event.target.closest("[data-hub-tile]");
  if (!tile) return;
  hubSection = tile.dataset.hubTile;
  setActiveAppTab("hub");
});

// Straight to the one screen that decides what is in the dock and what is in here, rather than
// making the user find it three levels into Settings. The row is CLICKED rather than the
// sub-screen opened directly, so the settings screen works out its own parent category and the
// back bar leads where it would have if the user had walked there.
document.querySelector("[data-open-customize-dock]")?.addEventListener("click", () => {
  openAccountOverlay();
  document.querySelector('[data-settings-open-subscreen="dock"]')?.click();
});

// --- Customize Dock ---------------------------------------------------------
//
// The Hub grid up top and the dock bar along the bottom, both drawn the way they actually appear,
// because the screen is about a layout and a list of switches was not one (iOS MenuVisibilityView).
//
// Two gestures, one job each. A CLICK moves a tab between the two. A DRAG only reorders, within
// whichever section the tab is already in - dragging across to a target you cannot see while the
// pointer is over it was the fiddly part, so moving is a click and dragging is left to the one
// thing a click cannot express, which is position.

const dockHubGrid = document.querySelector("[data-dock-hub-grid]");
const dockPreview = document.querySelector("[data-dock-preview]");
const dockCountEl = document.querySelector("[data-dock-count]");
const dockHintEl = document.querySelector("[data-dock-hint]");
const dockRefusalEl = document.querySelector("[data-dock-refusal]");

function refuseDockMove(message) {
  if (!dockRefusalEl) return;
  dockRefusalEl.textContent = message;
  dockRefusalEl.hidden = false;
}

function clearDockRefusal() {
  if (dockRefusalEl) dockRefusalEl.hidden = true;
}

function renderDockEditor() {
  const dock = dockVisibleTabs();
  const hub = hubVisibleTabs();
  const full = dock.length >= DOCK_MAX_ITEMS;

  if (dockHubGrid) {
    dockHubGrid.innerHTML = hub.map((tab) => `<button class="hub-tile" type="button" draggable="true" data-dock-move="hub" data-dock-tab="${tab}">
      <span class="hub-tile-icon" aria-hidden="true">${tabIconMarkup(tab)}</span>
      <span class="hub-tile-label">${escapeHtml(tabFullName(tab))}</span>
    </button>`).join("");
    dockHubGrid.hidden = hub.length === 0;
  }
  const hubEmptyNote = document.querySelector("[data-dock-hub-empty]");
  if (hubEmptyNote) hubEmptyNote.hidden = hub.length > 0;

  if (dockPreview) {
    // No placeholder slots for the unused capacity: the real dock divides its whole width between
    // however many tabs it has, so a four-tab dock is four WIDER items, not four and a gap. The
    // count above the bar is what says how much room is left.
    dockPreview.innerHTML = dock.map((tab) => `<button class="dock-preview-item${DOCK_PINNED.includes(tab) ? " pinned" : ""}" type="button" draggable="true" data-dock-move="dock" data-dock-tab="${tab}">
      <span class="dock-preview-icon" aria-hidden="true">${tabIconMarkup(tab)}</span>
      <span class="dock-preview-label">${escapeHtml(tabFullName(tab))}</span>
    </button>`).join("");
  }
  if (dockCountEl) {
    dockCountEl.textContent = `${dock.length} of ${DOCK_MAX_ITEMS}`;
    dockCountEl.classList.toggle("full", full);
  }
  if (dockHintEl) {
    dockHintEl.textContent = full
      ? "Your dock is full. Click one of these to move it up to Kaspa Hub and free a slot. Kaspa Hub and Profile must stay in the dock."
      : "Click a dock item to move it up to Kaspa Hub, or drag to reorder. Kaspa Hub and Profile must stay in the dock.";
  }

  const childNote = document.querySelector("[data-child-dock-note]");
  if (childNote) childNote.hidden = !isChildModeEnabled();
}

/** Both lists are written together, so a tab can never be missing from both or in both. */
function commitDockPrefs(dock, hub) {
  dockPrefs = normalizeDockPrefs({ dock, hub });
  persistDockPrefs();
  applyDockLayout();
}

/** Click in the Hub: join the dock, at the end, where the empty slot already is. */
function moveTabToDock(tab) {
  if (dockVisibleTabs().length >= DOCK_MAX_ITEMS) {
    refuseDockMove("Your dock is full. Click something in the dock to move it up here first.");
    return;
  }
  clearDockRefusal();
  commitDockPrefs([...dockPrefs.dock.filter((t) => t !== tab), tab], dockPrefs.hub.filter((t) => t !== tab));
}

/** Click in the dock: back to the Hub, at the end of the grid. */
function moveTabToHub(tab) {
  if (DOCK_PINNED.includes(tab)) {
    refuseDockMove(`${tabFullName(tab)} has to stay in your dock.`);
    return;
  }
  clearDockRefusal();
  commitDockPrefs(dockPrefs.dock.filter((t) => t !== tab), [...dockPrefs.hub.filter((t) => t !== tab), tab]);
}

document.querySelectorAll("[data-dock-hub-grid], [data-dock-preview]").forEach((container) => {
  container.addEventListener("click", (event) => {
    if (dockEditorDragged) return; // a drag ends in a click on the item; reordering must not also move it
    const item = event.target.closest("[data-dock-move]");
    if (!item) return;
    if (item.dataset.dockMove === "hub") moveTabToDock(item.dataset.dockTab);
    else moveTabToHub(item.dataset.dockTab);
  });
});

// Drag reorders and nothing else, enforced by MEMBERSHIP rather than at the drag source: a tab
// dragged out of the dock and dropped on a Hub tile is simply refused, instead of moving by a
// gesture the screen says is for ordering. That is also what lets the pinned two drag freely - a
// reorder cannot evict anything by construction.
let dockEditorDragged = null;

function reorderDockList(list, tab, target) {
  const next = list.filter((t) => t !== tab);
  const index = next.indexOf(target);
  if (index < 0) return list;
  // Read AFTER the removal. Taking the target's index from the ORIGINAL list overshoots by one
  // whenever the tab moves forwards, which is what lands a rightward drag a slot too far.
  next.splice(index, 0, tab);
  return next;
}

document.querySelectorAll("[data-dock-hub-grid], [data-dock-preview]").forEach((container) => {
  container.addEventListener("dragstart", (event) => {
    const item = event.target.closest("[data-dock-move]");
    if (!item) return;
    dockEditorDragged = { tab: item.dataset.dockTab, from: item.dataset.dockMove };
    item.classList.add("dragging");
    try { event.dataTransfer.setData("text/plain", item.dataset.dockTab); event.dataTransfer.effectAllowed = "move"; } catch { /* optional */ }
  });
  container.addEventListener("dragover", (event) => {
    if (!dockEditorDragged) return;
    const item = event.target.closest("[data-dock-move]");
    if (!item || item.dataset.dockMove !== dockEditorDragged.from) return;
    event.preventDefault();
  });
  container.addEventListener("drop", (event) => {
    const item = event.target.closest("[data-dock-move]");
    if (!dockEditorDragged || !item) return;
    event.preventDefault();
    const { tab, from } = dockEditorDragged;
    const target = item.dataset.dockTab;
    if (item.dataset.dockMove !== from || target === tab) return;
    if (from === "dock") commitDockPrefs(reorderDockList(dockPrefs.dock, tab, target), dockPrefs.hub);
    else commitDockPrefs(dockPrefs.dock, reorderDockList(dockPrefs.hub, tab, target));
  });
  container.addEventListener("dragend", () => {
    container.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    // Cleared on the next frame so the click the drag ends with still sees it and is swallowed.
    window.requestAnimationFrame(() => { dockEditorDragged = null; });
  });
});

applyDockLayout();

// --- What's-new wizard (once per install) ---------------------------------

const DOCK_WIZARD_DISMISSED_KEY = "kachat-dock-wizard-dismissed-v1";
const DOCK_WIZARD_PAGES = [
  { title: "Meet KaPosts", body: "A social feed built on Kaspa — post, follow, and discover, fully on-chain. It lives in your dock now." },
  { title: "Meet Kaspa Hub", body: "Your dock holds five items. Everything else lives one click away in Kaspa Hub, which is always in the dock." },
  { title: "Make it yours", body: "Move features between your dock and Kaspa Hub from Settings → Customization → Customize Dock. Each account keeps its own layout." },
];
let dockWizardPage = 0;

function renderDockWizard() {
  const backdrop = document.querySelector("[data-dock-wizard]");
  const pageEl = document.querySelector("[data-dock-wizard-page]");
  const dotsEl = document.querySelector("[data-dock-wizard-dots]");
  const nextBtn = document.querySelector("[data-dock-wizard-next]");
  if (!backdrop || !pageEl) return;
  const page = DOCK_WIZARD_PAGES[dockWizardPage];
  pageEl.innerHTML = `<h3>${page.title}</h3><p>${page.body}</p>`;
  if (dotsEl) {
    dotsEl.innerHTML = DOCK_WIZARD_PAGES
      .map((_, i) => `<span class="${i === dockWizardPage ? "active" : ""}"></span>`).join("");
  }
  if (nextBtn) nextBtn.textContent = dockWizardPage === DOCK_WIZARD_PAGES.length - 1 ? "Get Started" : "Next";
}

function dismissDockWizard() {
  localStorage.setItem(DOCK_WIZARD_DISMISSED_KEY, "1");
  const backdrop = document.querySelector("[data-dock-wizard]");
  if (backdrop) backdrop.hidden = true;
}

function maybeShowDockWizard() {
  if (localStorage.getItem(DOCK_WIZARD_DISMISSED_KEY)) return;
  if (!engine.address) return;
  // Child Mode skips the what's-new wizard - it opens with KaPosts, which Child Mode hides.
  if (isChildModeEnabled()) return;
  dockWizardPage = 0;
  renderDockWizard();
  const backdrop = document.querySelector("[data-dock-wizard]");
  if (backdrop) backdrop.hidden = false;
}

document.querySelector("[data-dock-wizard-skip]")?.addEventListener("click", dismissDockWizard);
document.querySelector("[data-dock-wizard-next]")?.addEventListener("click", () => {
  if (dockWizardPage >= DOCK_WIZARD_PAGES.length - 1) { dismissDockWizard(); return; }
  dockWizardPage += 1;
  renderDockWizard();
});

// Step 104 — Profile screen mockup wiring. QR buttons reveal the existing
// real QR card; address dropdowns expand/collapse. The list of unimplemented
// stubs this comment used to carry is long gone: KNS, spending addresses,
// withdraw, transaction history and Manage Addresses are all built. The gift
// program stays mobile-only by design.
// "Receive Kaspa" opens the same full-screen QR view as Chatting Address (and the
// spending-address Receive), just without the chat-fee note — the old inline
// profile-qr-card toggle looked nothing like it.
document.querySelectorAll("[data-profile-qr-trigger]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!engine.address) return;
    openChattingAddressScreen({ subtitle: null });
  });
});

async function openChattingAddressScreen(options = {}) {
  if (!chattingAddressScreen) return;
  const address = options.address || engine.address;
  if (!address) return;
  const balanceText = options.balanceText != null ? options.balanceText : `${currentBalanceKas} KAS`;
  chattingAddressScreen.hidden = false;
  // Subtitle: default chat-fee note for the chatting address; callers pass their
  // own text (or null to hide it) — spending receive hides the chat-fee note.
  const subtitleEl = document.querySelector("[data-chatting-address-subtitle]");
  if (subtitleEl) {
    if (options.subtitle === undefined) {
      subtitleEl.hidden = false;
      subtitleEl.textContent = "Just send 5-10 KAS at a time, that's plenty to cover chat fees for a while (about 500 messages per KAS).";
    } else if (options.subtitle) {
      subtitleEl.hidden = false;
      subtitleEl.textContent = options.subtitle;
    } else {
      subtitleEl.hidden = true;
    }
  }
  chattingAddressScreenAddress = address;
  if (chattingAddressValue) chattingAddressValue.textContent = address;
  if (chattingAddressBalance) chattingAddressBalance.textContent = balanceText;
  if (chattingAddressQr) {
    const ctx = chattingAddressQr.getContext("2d");
    ctx.clearRect(0, 0, chattingAddressQr.width, chattingAddressQr.height);
    try { await engine.drawQrFor(chattingAddressQr, address, { dark: "#06110f", light: "#ffffff" }); }
    catch (error) { appendEngineLog(`QR failed: ${error.message}`); }
  }
}

function closeChattingAddressScreen() {
  if (chattingAddressScreen) chattingAddressScreen.hidden = true;
}

document.querySelector("[data-open-chatting-address]")?.addEventListener("click", openChattingAddressScreen);
document.querySelector("[data-close-chatting-address]")?.addEventListener("click", closeChattingAddressScreen);

// Tap anywhere on the chatting-address card to copy it (iOS ChattingAddressQRView). The whole
// screen is the target, not just the Copy button - the QR and the address text are what a reader
// is looking at, so those are what they will reach for. The back button and the copy button keep
// their own behaviour.
document.querySelector("[data-chatting-address-screen] .chatting-address-body")?.addEventListener("click", async (event) => {
  if (event.target.closest("[data-copy-engine-address]")) return; // its own handler copies
  const target = chattingAddressScreenAddress || engine.address;
  if (!target) return;
  try {
    await copyTextToClipboard(target);
    showCopyToast(addressCopiedToastText(target));
  } catch (error) { appendEngineLog(`Copy failed: ${error.message}`); }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && chattingAddressScreen && !chattingAddressScreen.hidden) closeChattingAddressScreen();
});

// --- Profile > Apps and Help screens (iOS ProfileAppsView / ProfileHelpView).
// Both follow the full-screen overlay pattern of the address screens: back
// button and Escape close them. The Help rows launch the existing guides
// (setup guide modals sit below the 1500 z-band, so close Help first).
const appsScreenEl = document.querySelector("[data-apps-screen]");
const helpScreenEl = document.querySelector("[data-help-screen]");

document.querySelector("[data-open-apps-screen]")?.addEventListener("click", () => {
  if (appsScreenEl) appsScreenEl.hidden = false;
});
document.querySelector("[data-close-apps-screen]")?.addEventListener("click", () => {
  if (appsScreenEl) appsScreenEl.hidden = true;
});
document.querySelector("[data-open-help-screen]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = false;
});
document.querySelector("[data-close-help-screen]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (appsScreenEl && !appsScreenEl.hidden) appsScreenEl.hidden = true;
  else if (helpScreenEl && !helpScreenEl.hidden) helpScreenEl.hidden = true;
});

document.querySelector("[data-help-welcome]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = true;
  openSetupGuide();
});
document.querySelector("[data-help-kns]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = true;
  document.querySelector("[data-open-kns-register]")?.click();
});
document.querySelector("[data-help-dock]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = true;
  dockWizardPage = 0;
  renderDockWizard();
  const backdrop = document.querySelector("[data-dock-wizard]");
  if (backdrop) backdrop.hidden = false;
});

// --- Profile > About: Version and Donate (iOS aboutSection). Donate resolves
// kachat.kas and jumps straight into that chat in payment mode.
const APP_VERSION = "4.1";
const profileVersionEl = document.querySelector("[data-profile-version]");
if (profileVersionEl) profileVersionEl.textContent = APP_VERSION;

const DONATE_DOMAIN = "kachat.kas";
let donateResolving = false;

document.querySelector("[data-profile-donate]")?.addEventListener("click", async () => {
  if (donateResolving) return;
  donateResolving = true;
  const labelEl = document.querySelector("[data-profile-donate-label]");
  if (labelEl) labelEl.textContent = "Resolving…";
  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet first.");
    const resolution = await engine.resolveKnsDomain(DONATE_DOMAIN);
    if (!resolution) throw new Error(`Couldn't resolve ${DONATE_DOMAIN}. Please try again later.`);
    const address = validateContactAddress(resolution.ownerAddress);
    let contact = state.contacts.find((entry) => entry.address === address);
    if (!contact) {
      const createdAt = Date.now();
      contact = {
        id: nowId(), name: resolution.domain || DONATE_DOMAIN, nameIsCustom: false, address,
        avatar: initialsFor(resolution.domain || DONATE_DOMAIN), createdAt, updatedAt: createdAt,
        relationshipState: "legacy-manual", handshakeTxid: "",
      };
      state.contacts.push(contact);
    }
    let conversationEntry = state.conversations.find((entry) => entry.contactId === contact.id);
    if (!conversationEntry) {
      conversationEntry = createConversation({ contactId: contact.id, createdAt: Date.now() });
      state.conversations.push(conversationEntry);
      refreshSubscriptionAddresses({ restart: true });
      persistState();
    }
    setActiveAppTab("chats");
    openConversation(conversationEntry.id);
    await activateComposerMode("kas");
  } catch (error) {
    showCopyToast(error?.message || `Couldn't resolve ${DONATE_DOMAIN}.`);
  } finally {
    donateResolving = false;
    if (labelEl) labelEl.textContent = DONATE_DOMAIN;
  }
});

// --- Send Kaspa modal (matches iOS's WithdrawKaspaView for this pass: real
// recipient + amount + send; fee tiers/QR-scan/coin-control are follow-ups) ---

// Send-Kaspa flow, factored into a reusable controller so the same logic
// (balance check, KNS/address resolution, validation, broadcast) drives both
// the standalone modal (profile > Send Kaspa) and the in-card Send screen
// inside the Manage Address popup. `els` is a set of field elements; `onOpen`/
// `onClose` show/hide whichever container hosts them.
// `sendFn`/`getBalance` let a caller retarget the same controller at a different
// source wallet (e.g. a spending address via engine.sendFromSpending); when
// omitted it drives the chatting/identity address through engine.send/balance.
// iOS parity: a withdrawal from the CHATTING address surfaces as a chat with the
// destination (find-or-create), holding the outgoing payment bubble. Spending-chain
// sends deliberately do not create chats.
function recordOutgoingPaymentChat({ destination, amountKas, txid }) {
  const clean = String(destination || "").trim();
  if (!clean || clean === engine.address) return;
  let contact = state.contacts.find((entry) => entry.address === clean);
  if (!contact) {
    const createdAt = Date.now();
    contact = {
      id: nowId(), name: "", nameIsCustom: false, address: clean,
      avatar: initialsFor(shortAddress(clean)), createdAt, updatedAt: createdAt,
      relationshipState: "legacy-manual", handshakeTxid: "",
    };
    clearDeletedContactAddress(clean);
    state.contacts.push(contact);
  }
  let conversationEntry = state.conversations.find((entry) => entry.contactId === contact.id);
  if (!conversationEntry) {
    conversationEntry = createConversation({ contactId: contact.id, createdAt: Date.now() });
    state.conversations.push(conversationEntry);
    refreshSubscriptionAddresses({ restart: true });
  }
  const cleanTxid = String(txid || "").trim();
  if (cleanTxid && (conversationEntry.messages || []).some((entry) => entry.txid === cleanTxid)) return;
  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "outgoing",
    text: `Sent ${amountKas} KAS`,
    sender: engine.address || null,
    receiver: clean,
    status: MESSAGE_STATUSES.CONFIRMED,
    transport: "kaspa-payment",
    createdAt: Date.now(),
  });
  applyMessagePatch(message, { messageType: "payment", paymentAmountKas: String(amountKas), ...(cleanTxid ? { txid: cleanTxid } : {}) });
  appendIncomingOrReactionMessage(conversationEntry, message);
  conversationEntry.updatedAt = Date.now();
  persistState();
  renderChats();
  if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
}

function makeSendController(els, { onOpen, onClose, getSelection, resolveAmountKas, getFeeKas, sendFn, getBalance, onSent } = {}) {
  let resolvedAddress = null;
  let resolveToken = 0;

  // iOS WithdrawalSuccessCard parity: after a successful send the modal STAYS OPEN and flips
  // to a checkmark + "Sent" + the clickable transaction id (explorer link) until Done/close.
  function successHost() {
    return els.submit?.closest(".contact-modal") || null;
  }
  function clearSendSuccess() {
    const host = successHost();
    if (!host) return;
    host.classList.remove("send-success-active");
    const card = host.querySelector("[data-send-success]");
    if (card) card.hidden = true;
  }
  function showSendSuccess(txid, amountKas) {
    const host = successHost();
    if (!host) { onClose?.(); return; }
    let card = host.querySelector("[data-send-success]");
    if (!card) {
      card = document.createElement("div");
      card.className = "send-success-card";
      card.dataset.sendSuccess = "";
      host.appendChild(card);
    }
    card.innerHTML = `
      <span class="send-success-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>
      <strong>Sent ${escapeHtml(String(amountKas))} KAS</strong>
      ${txid
        ? `<span class="send-success-label">Transaction ID</span>
           <a class="send-success-txid" href="${escapeHtml(explorerTxUrl(txid))}" target="_blank" rel="noopener noreferrer">${escapeHtml(txid)}</a>`
        : `<span class="send-success-label">Transaction broadcast to the network.</span>`}
      <button class="primary-button full" type="button" data-send-success-done>Done</button>`;
    card.hidden = false;
    host.classList.add("send-success-active");
    card.querySelector("[data-send-success-done]")?.addEventListener("click", () => {
      clearSendSuccess();
      onClose?.();
    });
  }

  async function open() {
    if (!engine.address) return;
    clearSendSuccess();
    if (els.recipient) els.recipient.value = "";
    if (els.amount) els.amount.value = "";
    resolvedAddress = null;
    if (els.resolvedHint) els.resolvedHint.hidden = true;
    if (els.error) els.error.hidden = true;
    if (els.progress) els.progress.hidden = true;
    if (els.submit) els.submit.disabled = true;
    onOpen?.();
    if (els.balanceHint) els.balanceHint.textContent = "Checking balance…";
    try {
      await ensureRuntimes({ quiet: true });
      const balance = getBalance ? await getBalance() : await engine.balance();
      if (els.balanceHint) els.balanceHint.textContent = `Available: ${balance.totalKas} KAS`;
    } catch {
      if (els.balanceHint) els.balanceHint.textContent = "";
    }
  }

  async function updateValidity() {
    const token = ++resolveToken;
    const raw = String(els.recipient?.value || "").trim();
    const amountValid = Number(els.amount?.value) > 0;
    resolvedAddress = null;
    if (els.resolvedHint) els.resolvedHint.hidden = true;
    if (els.checkEl) els.checkEl.hidden = true;
    if (els.error) els.error.hidden = true;

    if (!raw) { if (els.submit) els.submit.disabled = true; return; }

    if (raw.startsWith("kaspa:")) {
      let valid = true;
      try { validateContactAddress(raw); } catch { valid = false; }
      if (els.checkEl) els.checkEl.hidden = !valid; // green check once it's a valid address
      if (els.submit) els.submit.disabled = !amountValid || !valid;
      return;
    }

    if (engine.knsLooksLikeDomain(raw)) {
      if (els.submit) els.submit.disabled = true;
      try {
        const resolution = await engine.resolveKnsDomain(raw);
        if (token !== resolveToken) return; // a newer keystroke superseded this lookup
        if (resolution) {
          resolvedAddress = resolution.ownerAddress;
          if (els.resolvedHint) {
            // Show the domain AND the full resolved address below it, matching iOS's WithdrawKaspaView.
            els.resolvedHint.innerHTML = `Resolved: ${escapeHtml(resolution.domain)}<br><span class="send-resolved-address">${escapeHtml(resolution.ownerAddress || "")}</span>`;
            els.resolvedHint.hidden = false;
          }
          if (els.checkEl) els.checkEl.hidden = false; // resolved -> green check
          if (els.submit) els.submit.disabled = !amountValid;
        }
      } catch {
        // leave disabled; submit surfaces a clearer error if attempted anyway
      }
      return;
    }

    if (els.submit) els.submit.disabled = true;
  }

  async function submit() {
    if (els.error) els.error.hidden = true;
    const raw = String(els.recipient?.value || "").trim();
    const destination = resolvedAddress || raw;
    let amountKas;
    try {
      amountKas = normalizeKasAmount(resolveAmountKas ? resolveAmountKas() : els.amount?.value);
      validateContactAddress(destination);
    } catch (error) {
      if (els.error) { els.error.textContent = error.message; els.error.hidden = false; }
      return;
    }

    const selectedOutpoints = getSelection?.() || [];
    const feeKas = getFeeKas ? getFeeKas() : "0";
    if (els.submit) els.submit.disabled = true;
    if (els.progress) { els.progress.hidden = false; els.progress.textContent = "Broadcasting transaction…"; }
    try {
      const result = sendFn
        ? await sendFn({ destination, amountKas, feeKas, selectedOutpoints })
        : await engine.send(destination, amountKas, feeKas, selectedOutpoints.length ? { selectedOutpoints } : {});
      const submittedTxids = (result?.txids || []).map((value) => String(value || "").trim()).filter(Boolean);
      const txid = submittedTxids.at(-1) || submittedTxids[0] || null;
      if (els.progress) els.progress.hidden = true;
      // Keep the modal open and flip to the success card (checkmark + clickable txid).
      showSendSuccess(txid, amountKas);
      try { onSent?.({ txid, destination, amountKas }); } catch { /* chat bookkeeping must never break the send UI */ }
      refreshBalanceOnly({ quiet: true }).catch(() => {});
    } catch (error) {
      // WASM helpers sometimes throw plain strings — surface those too, never a bare
      // "Send failed." when the SDK actually said why.
      const message = String(error?.message || error || "").trim() || "Send failed.";
      if (els.error) { els.error.textContent = message; els.error.hidden = false; }
      appendEngineLog(`Send failed: ${message}`);
      if (els.progress) els.progress.hidden = true;
    } finally {
      if (els.submit) els.submit.disabled = false;
    }
  }

  els.recipient?.addEventListener("input", updateValidity);
  els.amount?.addEventListener("input", updateValidity);
  els.submit?.addEventListener("click", submit);

  return { open };
}

// Standalone Send Kaspa modal (opened from profile > Chatting Address > Send Kaspa).
// Matches iOS WithdrawKaspaView: KNS resolution + Paste, fiat/KAS toggle + conversion,
// Max, Network Fee tiers (Normal/Priority/Custom), and Coin Control (UTXO selection).
const sendKaspaModal = document.querySelector("[data-send-kaspa-modal]");
function closeSendKaspaModal() { if (sendKaspaModal) sendKaspaModal.hidden = true; }

const sendKaspaAmountInput = document.querySelector("[data-send-kaspa-amount]");
const sendKaspaAmountLabel = document.querySelector("[data-send-kaspa-amount-label]");
const sendKaspaUnitButton = document.querySelector("[data-send-kaspa-unit]");
const sendKaspaUnitCode = document.querySelector("[data-send-kaspa-unit-code]");
const sendKaspaLogo = document.querySelector("[data-send-kaspa-logo]");
const sendKaspaFiatSymbol = document.querySelector("[data-send-kaspa-fiat-symbol]");
const sendKaspaMaxButton = document.querySelector("[data-send-kaspa-max]");
const sendKaspaFiatHint = document.querySelector("[data-send-kaspa-fiat]");
const sendKaspaPasteButton = document.querySelector("[data-send-kaspa-paste]");
const sendKaspaFeeButtons = document.querySelectorAll("[data-send-kaspa-fee]");
const sendKaspaFeeCustom = document.querySelector("[data-send-kaspa-fee-custom]");
const sendKaspaFeeSummary = document.querySelector("[data-send-kaspa-fee-summary]");
const sendKaspaCoinToggle = document.querySelector("[data-send-kaspa-coin-toggle]");
const sendKaspaCoinList = document.querySelector("[data-send-kaspa-coin-list]");
const sendKaspaCoinSummary = document.querySelector("[data-send-kaspa-coin-summary]");

let sendKaspaUnit = "kas";        // "kas" | "fiat"
let sendKaspaPrice = null;        // live KAS price in selectedCurrency
let sendKaspaAvailableKas = null; // available balance for the Max button
// True while the amount field holds an untouched Max fill — the send then goes through the
// exact-fee single-output max path instead of the normal amount+change build.
let sendKaspaMaxMode = false;
let sendKaspaFeeTier = "normal";
let sendKaspaUtxos = [];           // UTXO entries at the source address, for coin control
const sendKaspaSelected = new Set();
// Which address the modal sends FROM: null = the chatting/identity address (engine.address);
// a number = that spending-address index. Lets one rich modal serve both (spending send/compound
// looks identical to the chatting one).
let sendKaspaSourceIndex = null;

function sendKaspaSourceAddress() {
  return sendKaspaSourceIndex == null ? engine.address : deriveSpendingAddressAt(sendKaspaSourceIndex);
}
function sendKaspaLoadBalance() {
  return sendKaspaSourceIndex == null ? engine.balance() : engine.balanceForAddress(sendKaspaSourceAddress());
}
function sendKaspaEstimateFee(amountKas, selectedOutpoints) {
  return sendKaspaSourceIndex == null
    ? engine.estimateSendFee(amountKas, selectedOutpoints)
    : engine.estimateSendFeeForAddress(sendKaspaSourceAddress(), amountKas, selectedOutpoints);
}

function sendKaspaCurrencyCode() { return selectedCurrency.toUpperCase(); }

// KAS has 8 decimals (1 sompi). Floating-point math (Max = balance − fee, fiat ÷ price) can yield
// values like 38.251282509999996, which the "up to 8 decimals" validator rejects. Floor to 8
// decimals (never round up past the balance) and trim trailing zeros.
function trimKas8(n) {
  const v = Number(n);
  if (!isFinite(v)) return "0";
  return (Math.floor(v * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, "");
}

// Amount to actually send, always KAS (converts from fiat when in fiat mode).
function sendKaspaResolveAmountKas() {
  const raw = Number(sendKaspaAmountInput?.value);
  if (!isFinite(raw) || raw <= 0) return sendKaspaAmountInput?.value || "";
  if (sendKaspaUnit === "fiat") {
    if (!sendKaspaPrice) throw new Error("KAS price unavailable — switch back to KAS to send.");
    return trimKas8(raw / sendKaspaPrice);
  }
  return sendKaspaAmountInput?.value || "";
}

function updateSendKaspaFiatHint() {
  if (!sendKaspaFiatHint) return;
  const raw = Number(sendKaspaAmountInput?.value);
  if (!isFinite(raw) || raw <= 0 || !sendKaspaPrice) { sendKaspaFiatHint.hidden = true; return; }
  if (sendKaspaUnit === "kas") {
    sendKaspaFiatHint.textContent = `≈ ${formatFiatValue(raw, sendKaspaPrice)}`;
  } else {
    sendKaspaFiatHint.textContent = `≈ ${(raw / sendKaspaPrice).toLocaleString(undefined, { maximumFractionDigits: 8 })} KAS`;
  }
  sendKaspaFiatHint.hidden = false;
}

function applySendKaspaUnit() {
  const isKas = sendKaspaUnit === "kas";
  if (sendKaspaUnitCode) sendKaspaUnitCode.textContent = isKas ? "KAS" : sendKaspaCurrencyCode();
  if (sendKaspaLogo) sendKaspaLogo.hidden = !isKas;
  if (sendKaspaFiatSymbol) { sendKaspaFiatSymbol.hidden = isKas; sendKaspaFiatSymbol.textContent = currencyMeta().symbol.trim(); }
  const amountWord = t("send.amount");
  if (sendKaspaAmountLabel) sendKaspaAmountLabel.textContent = isKas ? `${amountWord} (KAS)` : `${amountWord} (${sendKaspaCurrencyCode()})`;
  if (sendKaspaAmountInput) sendKaspaAmountInput.placeholder = isKas ? "0.00000000" : "0.00";
  updateSendKaspaFiatHint();
}

sendKaspaUnitButton?.addEventListener("click", () => {
  if (!sendKaspaPrice) { showCopyToast("KAS price unavailable right now."); return; }
  const raw = Number(sendKaspaAmountInput?.value);
  if (isFinite(raw) && raw > 0) {
    sendKaspaAmountInput.value = sendKaspaUnit === "kas"
      ? (raw * sendKaspaPrice).toFixed(selectedCurrency === "btc" ? 8 : 2)
      : trimKas8(raw / sendKaspaPrice);
  }
  sendKaspaUnit = sendKaspaUnit === "kas" ? "fiat" : "kas";
  applySendKaspaUnit();
});
sendKaspaAmountInput?.addEventListener("input", () => { updateSendKaspaFiatHint(); scheduleSendKaspaFeeEstimate(); });

// Network fee — matches iOS WithdrawKaspaView: an estimated base (Normal) fee scaled by the tier
// multiplier (Normal 1x, Fast 2x, Priority 5x), shown as a real KAS amount, editable for a custom
// fee. engine.send() takes the PRIORITY tip on top of the SDK's automatic base fee, so we pass
// (displayed total − base).
const SEND_FEE_MULTIPLIERS = { normal: 1, fast: 2, priority: 5 };
const SEND_FEE_LABELS = { normal: "Normal", fast: "Fast", priority: "Priority" };
let sendKaspaBaseFeeKas = null;         // policy base fee (Normal tier), matches iOS (mass * 100/gram)
let sendKaspaSdkBaseKas = 0;            // the SDK's automatic base fee engine.send already applies
let sendKaspaFeeCustomOverride = false; // true once the user types a custom fee

function formatFeeKas(kas) {
  return Number(kas || 0).toLocaleString(undefined, { maximumFractionDigits: 8 });
}
function sendKaspaTotalFeeKas() {
  if (sendKaspaFeeCustomOverride) {
    const v = Number(sendKaspaFeeCustom?.value);
    return isFinite(v) && v >= 0 ? v : 0;
  }
  return (sendKaspaBaseFeeKas ?? 0) * (SEND_FEE_MULTIPLIERS[sendKaspaFeeTier] || 1);
}
// engine.send() auto-applies the SDK base fee; we pass the priority tip that lifts the total up to
// the displayed policy fee (mass * 100/gram), so what's shown is what's actually paid (iOS parity).
function sendKaspaGetFeeKas() {
  const tip = sendKaspaTotalFeeKas() - (sendKaspaSdkBaseKas ?? 0);
  return tip > 0 ? trimKas8(tip) : "0";
}
function updateSendKaspaFeeSummary() {
  if (!sendKaspaFeeSummary) return;
  const label = sendKaspaFeeCustomOverride ? "Custom" : (SEND_FEE_LABELS[sendKaspaFeeTier] || "Normal");
  sendKaspaFeeSummary.textContent = `${label} · ${formatFeeKas(sendKaspaTotalFeeKas())} KAS`;
}
// Reflect the current total into the (editable) fee field, unless the user is typing a custom fee.
function applySendKaspaFeeField() {
  if (sendKaspaFeeCustom && !sendKaspaFeeCustomOverride) {
    sendKaspaFeeCustom.value = sendKaspaBaseFeeKas == null ? "" : formatFeeKas(sendKaspaTotalFeeKas());
  }
  updateSendKaspaFeeSummary();
}
function selectSendKaspaFeeTier(tier) {
  sendKaspaFeeTier = tier;
  sendKaspaFeeCustomOverride = false;
  sendKaspaFeeButtons.forEach((b) => b.classList.toggle("active", b.dataset.sendKaspaFee === tier));
  applySendKaspaFeeField();
}
sendKaspaFeeButtons.forEach((button) => button.addEventListener("click", () => selectSendKaspaFeeTier(button.dataset.sendKaspaFee)));
sendKaspaFeeCustom?.addEventListener("input", () => {
  sendKaspaFeeCustomOverride = true;
  sendKaspaFeeButtons.forEach((b) => b.classList.remove("active"));
  updateSendKaspaFeeSummary();
});

// Estimate the base (Normal) network fee for the CURRENT amount so it reflects the UTXOs the send
// would actually spend (matches iOS). Debounced, since it runs on every amount keystroke.
let sendKaspaFeeEstimateTimer = null;
async function estimateSendKaspaBaseFee() {
  try {
    let amountKas = Number(sendKaspaResolveAmountKas());
    if (!isFinite(amountKas) || amountKas <= 0) amountKas = 0.2;
    // Never estimate a send larger than the balance (that throws "insufficient") — cap just under it.
    if (sendKaspaAvailableKas != null && amountKas > sendKaspaAvailableKas) {
      amountKas = Math.max(0.0001, sendKaspaAvailableKas - 0.001);
    }
    const selection = sendKaspaGetSelection();
    const detail = await sendKaspaEstimateFee(String(amountKas), selection.length ? selection : null);
    const policy = Number(detail?.policyFeeKas);
    if (isFinite(policy) && policy > 0) {
      sendKaspaBaseFeeKas = policy;
      sendKaspaSdkBaseKas = Number(detail?.sdkFeeKas) || 0;
    } else if (sendKaspaBaseFeeKas == null) {
      // No previous estimate to keep — fall back to the 1-input placeholder. A FAILED
      // estimate must never clobber a good earlier one (Max sets the all-input fee, and
      // resetting it to 0.002 here made the subsequent send underpay and fail).
      sendKaspaBaseFeeKas = 0.002; sendKaspaSdkBaseKas = 0.00002;
    }
  } catch {
    if (sendKaspaBaseFeeKas == null) { sendKaspaBaseFeeKas = 0.002; sendKaspaSdkBaseKas = 0.00002; }
  }
  applySendKaspaFeeField();
}
function scheduleSendKaspaFeeEstimate() {
  if (sendKaspaFeeEstimateTimer) clearTimeout(sendKaspaFeeEstimateTimer);
  sendKaspaFeeEstimateTimer = window.setTimeout(estimateSendKaspaBaseFee, 400);
}

// Coin control (UTXO selection).
function sendKaspaGetSelection() { return [...sendKaspaSelected]; }
function updateSendKaspaCoinSummary() {
  if (!sendKaspaCoinSummary) return;
  if (!sendKaspaSelected.size) { sendKaspaCoinSummary.textContent = "Automatic"; return; }
  let totalSompi = 0n;
  for (const entry of sendKaspaUtxos) {
    if (sendKaspaSelected.has(utxoOutpointKey(entry.outpoint || {}))) totalSompi += BigInt(entry.amount || 0);
  }
  sendKaspaCoinSummary.textContent = `${sendKaspaSelected.size} · ${sompiToKasDisplay(totalSompi)} KAS`;
}
function renderSendKaspaCoinControl() {
  sendKaspaSelected.clear();
  updateSendKaspaCoinSummary();
  if (sendKaspaCoinList) sendKaspaCoinList.hidden = true;
  if (sendKaspaCoinToggle) sendKaspaCoinToggle.setAttribute("aria-expanded", "false");
  if (!sendKaspaCoinList) return;
  sendKaspaCoinList.replaceChildren();
  if (!sendKaspaUtxos.length) { sendKaspaCoinList.innerHTML = '<div class="manage-address-empty">No UTXOs to select.</div>'; return; }
  const labels = getUtxoLabels(sendKaspaSourceAddress());
  for (const entry of sendKaspaUtxos) {
    const outpointKey = utxoOutpointKey(entry.outpoint || {});
    const row = document.createElement("label");
    row.className = "manage-send-coin-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "manage-send-coin-check";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) sendKaspaSelected.add(outpointKey); else sendKaspaSelected.delete(outpointKey);
      sendKaspaMaxMode = false; // a changed input set invalidates a filled Max — re-click Max
      updateSendKaspaCoinSummary();
      scheduleSendKaspaFeeEstimate();
    });
    const meta = document.createElement("span");
    meta.className = "manage-send-coin-meta";
    if (labels[outpointKey]) {
      const labelEl = document.createElement("span");
      labelEl.className = "manage-send-coin-label";
      labelEl.textContent = labels[outpointKey];
      meta.appendChild(labelEl);
    }
    const outpointEl = document.createElement("span");
    outpointEl.className = "manage-send-coin-outpoint";
    outpointEl.textContent = outpointKey;
    meta.appendChild(outpointEl);
    const amountEl = document.createElement("span");
    amountEl.className = "manage-send-coin-amount";
    amountEl.textContent = `${sompiToKasDisplay(BigInt(entry.amount || 0))} KAS`;
    row.append(checkbox, meta, amountEl);
    sendKaspaCoinList.appendChild(row);
  }
}
sendKaspaCoinToggle?.addEventListener("click", () => {
  if (!sendKaspaCoinList) return;
  const willShow = sendKaspaCoinList.hidden;
  sendKaspaCoinList.hidden = !willShow;
  sendKaspaCoinToggle.setAttribute("aria-expanded", String(willShow));
});

// Sompi total of the coins Max would spend: the coin-control selection, else the whole address.
function sendKaspaSpendableKas() {
  if (sendKaspaSelected.size) {
    let sompi = 0n;
    for (const entry of sendKaspaUtxos) {
      if (sendKaspaSelected.has(utxoOutpointKey(entry.outpoint || {}))) sompi += BigInt(entry.amount || 0);
    }
    return Number(sompi) / 1e8;
  }
  return sendKaspaAvailableKas;
}

// Max / compound: reserve the fee for spending EVERY input Max uses (all UTXOs, or the selected
// subset) - not the 1-input base fee. Estimating against those exact outpoints makes the mass (and
// thus the policy fee = mass * 100/gram) reflect the real input count, matching iOS. Then
// amount = spendable - fee, so amount + fee = balance and the send doesn't fail on "insufficient".
async function fillMaxAmount() {
  if (sendKaspaAvailableKas == null) {
    try {
      const b = await sendKaspaLoadBalance();
      sendKaspaAvailableKas = Number(b.totalKas);
      if (!sendKaspaUtxos.length) { sendKaspaUtxos = b.entries || []; renderSendKaspaCoinControl(); }
    } catch { /* handled below */ }
  }
  const spendable = sendKaspaSpendableKas();
  if (spendable == null || !isFinite(spendable)) { showCopyToast("Balance unavailable right now."); return; }

  const selection = sendKaspaGetSelection();
  // iOS-parity Max fee (WalletManager/kspt estimateMaxAmount): compute the fee directly from
  // the MASS of spending every input Max will use, at the live quoted rate with the 100
  // sompi/gram policy floor. The old approach asked the WASM generator to build a tx of
  // spendable-0.01 — on addresses with many UTXOs the true all-input fee exceeds that 0.01
  // headroom, the generator throws, the error was swallowed, and the fee silently stayed at
  // the 0.002 placeholder, so Max always produced a send that failed.
  const inputCount = selection.length || (sendKaspaUtxos || []).length || 1;
  try {
    const feeRate = await fetchQuotedFeeRateSompiPerGram();
    const mass = calculateMass(inputCount, [34, 34], 0);
    const policyKas = Number(calculateFee(mass, feeRate)) / 1e8;
    if (isFinite(policyKas) && policyKas > 0) {
      sendKaspaBaseFeeKas = policyKas;
      // The SDK's own automatic base fee is ~1 sompi/gram of the same mass; the send path
      // passes total - sdkBase as the priority tip, so this keeps paid == displayed.
      sendKaspaSdkBaseKas = Number(mass) / 1e8;
      sendKaspaFeeCustomOverride = false;
      applySendKaspaFeeField();
    }
  } catch { /* keep whatever base fee we have */ }

  const totalFeeKas = sendKaspaTotalFeeKas();
  // Exact, no slack: the max send path spends (balance - fee) precisely so the generator
  // emits a single output. Leaving even a sompi-sized remainder used to create a dust
  // change output that Kaspa's KIP-9 storage-mass rule rejected — "Send failed." every time.
  const maxKas = spendable - totalFeeKas;
  if (!(maxKas > 0)) { showCopyToast("Balance too low after network fees."); return; }
  sendKaspaAmountInput.value = (sendKaspaUnit === "fiat" && sendKaspaPrice)
    ? (maxKas * sendKaspaPrice).toFixed(selectedCurrency === "btc" ? 8 : 2)
    : trimKas8(maxKas);
  updateSendKaspaFiatHint();
  // Re-run send validity (enables Send). The re-estimate this triggers uses the same near-full
  // amount, so it lands on the same all-input fee and doesn't disturb the reserved Max.
  sendKaspaAmountInput.dispatchEvent(new Event("input"));
  // Route the actual send through the exact-fee max path (set AFTER the dispatch above —
  // the amount listener clears this flag on every USER edit).
  sendKaspaMaxMode = true;
}
sendKaspaMaxButton?.addEventListener("click", () => { fillMaxAmount(); });
// Any USER edit of the amount leaves max mode (the programmatic fill from fillMaxAmount
// dispatches an untrusted Event, so it never clears its own flag).
sendKaspaAmountInput?.addEventListener("input", (event) => { if (event.isTrusted) sendKaspaMaxMode = false; });

sendKaspaPasteButton?.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    const recipient = document.querySelector("[data-send-kaspa-recipient]");
    if (recipient && text) { recipient.value = text.trim(); recipient.dispatchEvent(new Event("input")); }
  } catch { showCopyToast("Clipboard unavailable — paste manually."); }
});

const sendKaspaScanButton = document.querySelector("[data-send-kaspa-scan]");
sendKaspaScanButton?.addEventListener("click", async () => {
  const scanned = await scanKaspaAddress({
    title: "Scan a recipient code",
    hint: "Point the camera at the address QR code you want to send to.",
  });
  const recipient = document.querySelector("[data-send-kaspa-recipient]");
  if (!scanned || !recipient) return;
  // Same event the paste path fires, so the address check and fee preview both update.
  recipient.value = scanned;
  recipient.dispatchEvent(new Event("input"));
});

// Reset the extra controls and (re)load price + balance/UTXOs each time the modal opens.
function resetSendKaspaExtras() {
  sendKaspaUnit = "kas";
  sendKaspaMaxMode = false;
  applySendKaspaUnit();
  // Clear any stale "valid address" check from a previous open (e.g. a compound self-send) - the
  // recipient starts empty, so the check stays hidden until a valid address is entered.
  const chk = document.querySelector("[data-send-kaspa-check]");
  if (chk) chk.hidden = true;
  // Show a sensible base fee immediately (a fee estimate over a slow/contended RPC can take a
  // moment; the field should never sit blank), then refine it with the real estimate.
  sendKaspaBaseFeeKas = 0.002;
  sendKaspaSdkBaseKas = 0.00002;
  sendKaspaFeeCustomOverride = false;
  selectSendKaspaFeeTier("normal");
  estimateSendKaspaBaseFee();
  if (sendKaspaFiatHint) sendKaspaFiatHint.hidden = true;
  sendKaspaPrice = null;
  sendKaspaAvailableKas = null;
  sendKaspaUtxos = [];
  renderSendKaspaCoinControl();
  fetchKasPrice(selectedCurrency).then((price) => { sendKaspaPrice = price; updateSendKaspaFiatHint(); }).catch(() => {});
  sendKaspaLoadBalance().then((b) => {
    sendKaspaAvailableKas = Number(b.totalKas);
    sendKaspaUtxos = b.entries || [];
    renderSendKaspaCoinControl();
    if (sendKaspaCompound) applySendKaspaCompoundPrefill();
  }).catch(() => {});
}

// Compound UTXOs mode (matches iOS's WithdrawKaspaView isCompoundMode): the Send Kaspa screen with
// the recipient locked to this address (a self-send) and the amount pre-filled to Max, so sending
// merges every UTXO into one.
let sendKaspaCompound = false;
function applySendKaspaCompoundUi() {
  const titleEl = document.querySelector("[data-send-kaspa-title]");
  const kickerEl = document.querySelector("[data-send-kaspa-kicker]");
  const recipientLabel = document.querySelector("[data-send-kaspa-recipient-label]");
  const recipient = document.querySelector("[data-send-kaspa-recipient]");
  const note = document.querySelector("[data-send-kaspa-compound-note]");
  const spending = sendKaspaSourceIndex != null;
  if (titleEl) titleEl.textContent = sendKaspaCompound ? "Compound UTXOs" : "Send Kaspa";
  if (kickerEl) kickerEl.textContent = sendKaspaCompound
    ? "Consolidating this address"
    : (spending ? `Spending #${sendKaspaSourceIndex} · ${shortAddress(sendKaspaSourceAddress())}` : "Real Kaspa transaction");
  if (recipientLabel) recipientLabel.textContent = sendKaspaCompound ? "Consolidating This Address" : "Recipient";
  if (recipient) recipient.readOnly = sendKaspaCompound;
  if (note) note.hidden = !sendKaspaCompound;
  if (sendKaspaPasteButton) sendKaspaPasteButton.hidden = sendKaspaCompound;
}
function applySendKaspaCompoundPrefill() {
  const recipient = document.querySelector("[data-send-kaspa-recipient]");
  const selfAddr = sendKaspaSourceAddress();
  if (recipient && selfAddr) { recipient.value = selfAddr; recipient.dispatchEvent(new Event("input")); }
  fillMaxAmount(); // reserves the fee for spending every UTXO (see fillMaxAmount)
}

const sendKaspaController = makeSendController({
  recipient: document.querySelector("[data-send-kaspa-recipient]"),
  resolvedHint: document.querySelector("[data-send-kaspa-resolved]"),
  checkEl: document.querySelector("[data-send-kaspa-check]"),
  amount: sendKaspaAmountInput,
  balanceHint: document.querySelector("[data-send-kaspa-balance]"),
  error: document.querySelector("[data-send-kaspa-error]"),
  progress: document.querySelector("[data-send-kaspa-progress]"),
  submit: document.querySelector("[data-send-kaspa-submit]"),
}, {
  onOpen: () => { if (sendKaspaModal) sendKaspaModal.hidden = false; },
  onClose: closeSendKaspaModal,
  getBalance: sendKaspaLoadBalance,
  resolveAmountKas: sendKaspaResolveAmountKas,
  getFeeKas: sendKaspaGetFeeKas,
  getSelection: sendKaspaGetSelection,
  // Routes by source (chatting vs a spending index) and mode (compound = no-change sweep,
  // untouched Max fill = exact-fee single-output max send).
  sendFn: ({ destination, amountKas, feeKas, selectedOutpoints }) => {
    const outpoints = selectedOutpoints && selectedOutpoints.length ? selectedOutpoints : null;
    if (sendKaspaCompound) {
      return sendKaspaSourceIndex == null
        ? engine.compoundUtxos()
        : engine.compoundSpending({ mnemonic: activeAccountMnemonic(), index: sendKaspaSourceIndex, passphrase: activeAccountPassphrase() });
    }
    if (sendKaspaMaxMode) {
      const totalFeeKas = trimKas8(sendKaspaTotalFeeKas());
      return sendKaspaSourceIndex == null
        ? engine.sendMax(destination, totalFeeKas, outpoints)
        : engine.sendMaxFromSpending({
          mnemonic: activeAccountMnemonic(), index: sendKaspaSourceIndex, passphrase: activeAccountPassphrase(),
          destinationAddress: destination, totalFeeKas, selectedOutpoints: outpoints,
        });
    }
    if (sendKaspaSourceIndex != null) {
      return engine.sendFromSpending({
        mnemonic: activeAccountMnemonic(), index: sendKaspaSourceIndex, passphrase: activeAccountPassphrase(),
        destinationAddress: destination, amountKas, feeKas,
        selectedOutpoints: outpoints,
      });
    }
    return engine.send(destination, amountKas, feeKas, outpoints ? { selectedOutpoints: outpoints } : {});
  },
  // iOS parity: a send from the CHATTING address (not a spending index, not a
  // compound) surfaces as a chat with the destination holding the payment bubble.
  onSent: ({ txid, destination, amountKas }) => {
    if (sendKaspaCompound || sendKaspaSourceIndex != null) return;
    recordOutgoingPaymentChat({ destination, amountKas, txid });
  },
});
function openSendKaspaModal(options = {}) {
  const spendingIndex = Number.isInteger(options?.spendingIndex) ? options.spendingIndex : null;
  if (spendingIndex != null && !activeAccountMnemonic()) {
    showCopyToast("This account has no recovery phrase, so spending sends aren't available.");
    return;
  }
  sendKaspaCompound = Boolean(options?.compound);
  sendKaspaSourceIndex = spendingIndex;
  applySendKaspaCompoundUi();
  resetSendKaspaExtras();
  return sendKaspaController.open();
}

document.querySelectorAll("[data-close-send-kaspa]").forEach((button) => button.addEventListener("click", closeSendKaspaModal));
document.querySelector("[data-open-send-kaspa]")?.addEventListener("click", openSendKaspaModal);

// --- Manage Address screen (matches iOS's ChattingAddressManageView for this
// pass: real transaction history + real UTXOs + Receive/Send/Explorer/Private
// key; UTXO labeling and Compound UTXOs are follow-ups) ---

const manageAddressScreen = document.querySelector("[data-manage-address-screen]");
const manageAddressBalanceEl = document.querySelector("[data-manage-address-balance]");
const manageAddressExplorerLink = document.querySelector("[data-manage-address-explorer-link]");
const manageAddressTransactionsList = document.querySelector("[data-manage-address-transactions]");
const manageAddressUtxosList = document.querySelector("[data-manage-address-utxos]");

function closeManageAddressScreen() {
  if (manageAddressScreen) manageAddressScreen.hidden = true;
}

function manageAddressTxDirection(tx, address) {
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

async function loadManageAddressTransactions(address, listEl = manageAddressTransactionsList) {
  if (!listEl) return;
  if (!String(address || "").trim()) { // empty address would 404 as /addresses//…
    listEl.innerHTML = '<div class="manage-address-empty">No transactions yet.</div>';
    return;
  }
  listEl.innerHTML = '<div class="manage-address-empty">Loading…</div>';
  try {
    const url = `${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(address)}/full-transactions?limit=50&offset=0&resolve_previous_outpoints=light`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Kaspa API returned ${response.status}`);
    const transactions = await response.json();
    if (!Array.isArray(transactions) || !transactions.length) {
      listEl.innerHTML = '<div class="manage-address-empty">No transactions yet.</div>';
      return;
    }
    listEl.replaceChildren();
    for (const tx of transactions) {
      const info = manageAddressTxDirection(tx, address);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "manage-address-row";
      const icon = document.createElement("span");
      icon.className = `manage-address-row-icon ${info?.isOutgoing ? "outgoing" : "incoming"}`;
      icon.textContent = info?.isOutgoing ? "↑" : "↓";
      const meta = document.createElement("span");
      meta.className = "manage-address-row-meta";
      const label = document.createElement("strong");
      label.textContent = info == null ? "Transaction" : info.isOutgoing ? "Sent" : "Received";
      const txidEl = document.createElement("span");
      txidEl.className = "manage-address-row-txid";
      txidEl.textContent = tx.transaction_id || "";
      meta.append(label, txidEl);
      if (tx.block_time) {
        const timeEl = document.createElement("span");
        timeEl.className = "manage-address-row-time";
        timeEl.textContent = new Date(Number(tx.block_time)).toLocaleString();
        meta.append(timeEl);
      }
      row.append(icon, meta);
      if (info) {
        const amountEl = document.createElement("span");
        amountEl.className = `manage-address-row-amount ${info.isOutgoing ? "outgoing" : "incoming"}`;
        amountEl.textContent = `${info.isOutgoing ? "-" : "+"}${sompiToKasDisplay(info.amountSompi)} KAS`;
        row.append(amountEl);
      }
      row.addEventListener("click", () => {
        if (tx.transaction_id) window.open(explorerTxUrl(tx.transaction_id), "_blank", "noopener,noreferrer");
      });
      listEl.appendChild(row);
    }
  } catch (error) {
    listEl.innerHTML = `<div class="manage-address-empty">Could not load transaction history: ${escapeHtml(error.message)}</div>`;
  }
}

function sompiToKasDisplay(sompi) {
  const value = typeof sompi === "bigint" ? sompi : BigInt(Math.round(Number(sompi) || 0));
  const s = value.toString().padStart(9, "0");
  return `${s.slice(0, -8) || "0"}.${s.slice(-8).replace(/0+$/, "") || "0"}`;
}

// Per-UTXO labels, keyed by "txid:index" and scoped per address — mirrors the
// UTXO labeling in iOS's ManageAddressesView / ColdStorageManager and Android's
// KaspaExplorer counterparts. A blank name removes the label. Stored as
// { [address]: { [outpointKey]: label } } in localStorage.
const UTXO_LABELS_KEY = "kachat-utxo-labels-v1";

function loadUtxoLabelsMap() {
  try { return JSON.parse(localStorage.getItem(UTXO_LABELS_KEY) || "{}") || {}; }
  catch { return {}; }
}
function getUtxoLabels(address) {
  return loadUtxoLabelsMap()[address] || {};
}
function setUtxoLabel(address, outpointKey, label) {
  const map = loadUtxoLabelsMap();
  const forAddress = { ...(map[address] || {}) };
  const clean = String(label || "").trim();
  if (clean) forAddress[outpointKey] = clean;
  else delete forAddress[outpointKey];
  if (Object.keys(forAddress).length) map[address] = forAddress;
  else delete map[address];
  localStorage.setItem(UTXO_LABELS_KEY, JSON.stringify(map));
}
function utxoOutpointKey(outpoint) {
  return `${outpoint.transactionId || ""}:${outpoint.index ?? ""}`;
}

// Cache the last-loaded UTXO entries so a rename can re-render instantly without
// re-hitting the node for balance.
let lastManageAddressUtxos = [];

// Compound/consolidate every UTXO at the chatting (identity) address into one, by sending the
// balance back to itself (matches iOS's Compound UTXOs). Confirm first, then broadcast.
let manageConsolidateInFlight = false;
async function consolidateManageAddressUtxos() {
  if (manageConsolidateInFlight) return;
  const address = engine.address;
  if (!address) return;
  let balance;
  try { balance = await engine.balance(); } catch (error) { showCopyToast(`Could not load balance: ${error.message}`); return; }
  const entries = balance.entries || [];
  if (entries.length < 2) { showCopyToast("Nothing to consolidate — this address has a single UTXO."); return; }
  const maxKas = Number(balance.totalKas) - 0.001; // headroom for the network fee (many inputs)
  if (!(maxKas > 0)) { showCopyToast("Balance too low to consolidate."); return; }
  if (!await confirmText(`Combine ${entries.length} UTXOs at this address into one? This sends the balance back to this same address and pays a small network fee.`)) return;
  manageConsolidateInFlight = true;
  showCopyToast("Consolidating UTXOs…");
  try {
    await engine.send(address, trimKas8(maxKas), "0", {}); // self-send merges the inputs
    showCopyToast("UTXOs consolidated.");
    loadManageAddressUtxos();
    refreshBalanceOnly?.({ quiet: true });
  } catch (error) {
    showCopyToast(`Consolidation failed: ${error.message}`);
  } finally {
    manageConsolidateInFlight = false;
  }
}

function renderManageAddressUtxos() {
  if (!manageAddressUtxosList) return;
  const address = engine.address;
  if (!lastManageAddressUtxos.length) {
    manageAddressUtxosList.innerHTML = '<div class="manage-address-empty">No UTXOs at this address.</div>';
    return;
  }
  const labels = getUtxoLabels(address);
  manageAddressUtxosList.replaceChildren();
  // Compound UTXOs (matches iOS): shown only with more than one UTXO. Merges them by sending the
  // balance back to this same address, so future sends need fewer inputs.
  if (lastManageAddressUtxos.length > 1) {
    const consolidate = document.createElement("button");
    consolidate.type = "button";
    consolidate.className = "manage-address-consolidate-btn";
    consolidate.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7 3 12l5 5"/><path d="M16 7l5 5-5 5"/><path d="M3 12h18"/></svg><span>Compound UTXOs</span>';
    // Opens the Send screen in compound mode (recipient locked to this address, amount = Max),
    // matching iOS's WithdrawKaspaView isCompoundMode.
    consolidate.addEventListener("click", () => openSendKaspaModal({ compound: true }));
    manageAddressUtxosList.appendChild(consolidate);
  }
  for (const entry of lastManageAddressUtxos) {
    const outpoint = entry.outpoint || {};
    const outpointKey = utxoOutpointKey(outpoint);
    const label = labels[outpointKey];

    const row = document.createElement("div");
    row.className = "manage-address-utxo-row";

    const meta = document.createElement("div");
    meta.className = "manage-address-utxo-meta";
    if (label) {
      const labelEl = document.createElement("span");
      labelEl.className = "manage-address-utxo-label";
      labelEl.textContent = label;
      meta.appendChild(labelEl);
    }
    const outpointEl = document.createElement("span");
    outpointEl.className = "manage-address-utxo-outpoint";
    outpointEl.textContent = outpointKey;
    meta.appendChild(outpointEl);

    const amountEl = document.createElement("span");
    amountEl.className = "manage-address-utxo-amount";
    amountEl.textContent = `${sompiToKasDisplay(BigInt(entry.amount || 0))} KAS`;

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "manage-address-utxo-rename";
    renameBtn.setAttribute("aria-label", label ? "Rename UTXO" : "Name UTXO");
    renameBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>';
    renameBtn.addEventListener("click", () => openUtxoRename(address, outpointKey, label || ""));

    row.append(meta, amountEl, renameBtn);
    manageAddressUtxosList.appendChild(row);
  }
}

async function loadManageAddressUtxos() {
  if (!manageAddressUtxosList) return;
  manageAddressUtxosList.innerHTML = '<div class="manage-address-empty">Loading…</div>';
  try {
    const balance = await engine.balance();
    lastManageAddressUtxos = balance.entries || [];
    renderManageAddressUtxos();
  } catch (error) {
    lastManageAddressUtxos = [];
    manageAddressUtxosList.innerHTML = `<div class="manage-address-empty">Could not load UTXOs: ${escapeHtml(error.message)}</div>`;
  }
}

async function openManageAddressScreen() {
  if (!manageAddressScreen || !engine.address) return;
  manageAddressScreen.hidden = false;
  showManageView("list");
  if (manageAddressBalanceEl) manageAddressBalanceEl.textContent = `${currentBalanceKas} KAS`;
  if (manageAddressExplorerLink) manageAddressExplorerLink.href = explorerAddressUrl(engine.address);
  await Promise.all([
    loadManageAddressTransactions(engine.address),
    loadManageAddressUtxos(),
  ]);
}

document.querySelector("[data-open-manage-address]")?.addEventListener("click", openManageAddressScreen);
document.querySelector("[data-close-manage-address]")?.addEventListener("click", closeManageAddressScreen);
document.querySelector("[data-manage-address-receive]")?.addEventListener("click", () => {
  closeManageAddressScreen();
  openChattingAddressScreen();
});

// In-card Send screen — clicking Send swaps the card's list view for a Send
// screen (matching iOS's send flow) instead of stacking a separate modal; the
// back arrow returns to the list.
function showManageView(view) {
  document.querySelectorAll("[data-manage-view]").forEach((el) => {
    el.hidden = el.dataset.manageView !== view;
  });
}
// Coin control (matches iOS's manualUtxos): the user optionally picks which
// UTXOs fund the send. No selection = automatic coin selection (spend all/auto).
const manageSendCoinToggle = document.querySelector("[data-manage-send-coin-toggle]");
const manageSendCoinList = document.querySelector("[data-manage-send-coin-list]");
const manageSendCoinSummary = document.querySelector("[data-manage-send-coin-summary]");
const selectedSendOutpoints = new Set();

function getSelectedSendOutpoints() {
  return [...selectedSendOutpoints];
}

function updateSendCoinSummary() {
  if (!manageSendCoinSummary) return;
  if (!selectedSendOutpoints.size) { manageSendCoinSummary.textContent = "Automatic"; return; }
  let totalSompi = 0n;
  for (const entry of lastManageAddressUtxos) {
    if (selectedSendOutpoints.has(utxoOutpointKey(entry.outpoint || {}))) totalSompi += BigInt(entry.amount || 0);
  }
  manageSendCoinSummary.textContent = `${selectedSendOutpoints.size} · ${sompiToKasDisplay(totalSompi)} KAS`;
}

function renderSendCoinControl() {
  selectedSendOutpoints.clear();
  updateSendCoinSummary();
  if (manageSendCoinList) manageSendCoinList.hidden = true;
  if (manageSendCoinToggle) manageSendCoinToggle.setAttribute("aria-expanded", "false");
  if (!manageSendCoinList) return;
  manageSendCoinList.replaceChildren();
  if (!lastManageAddressUtxos.length) {
    manageSendCoinList.innerHTML = '<div class="manage-address-empty">No UTXOs to select.</div>';
    return;
  }
  const labels = getUtxoLabels(engine.address);
  for (const entry of lastManageAddressUtxos) {
    const outpointKey = utxoOutpointKey(entry.outpoint || {});
    const row = document.createElement("label");
    row.className = "manage-send-coin-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "manage-send-coin-check";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedSendOutpoints.add(outpointKey);
      else selectedSendOutpoints.delete(outpointKey);
      updateSendCoinSummary();
    });

    const meta = document.createElement("span");
    meta.className = "manage-send-coin-meta";
    if (labels[outpointKey]) {
      const labelEl = document.createElement("span");
      labelEl.className = "manage-send-coin-label";
      labelEl.textContent = labels[outpointKey];
      meta.appendChild(labelEl);
    }
    const outpointEl = document.createElement("span");
    outpointEl.className = "manage-send-coin-outpoint";
    outpointEl.textContent = outpointKey;
    meta.appendChild(outpointEl);

    const amountEl = document.createElement("span");
    amountEl.className = "manage-send-coin-amount";
    amountEl.textContent = `${sompiToKasDisplay(BigInt(entry.amount || 0))} KAS`;

    row.append(checkbox, meta, amountEl);
    manageSendCoinList.appendChild(row);
  }
}

manageSendCoinToggle?.addEventListener("click", () => {
  if (!manageSendCoinList) return;
  const willShow = manageSendCoinList.hidden;
  manageSendCoinList.hidden = !willShow;
  manageSendCoinToggle.setAttribute("aria-expanded", String(willShow));
});

// Send amount fiat toggle: tapping the Kaspa logo flips the amount field between
// KAS and the selected fiat currency, converting the current value via live price.
const manageSendAmountInput = document.querySelector("[data-manage-send-amount]");
const manageSendAmountLabel = document.querySelector("[data-manage-send-amount-label]");
const manageSendUnitButton = document.querySelector("[data-manage-send-unit]");
const manageSendUnitCode = document.querySelector("[data-manage-send-unit-code]");
const manageSendLogo = document.querySelector("[data-manage-send-logo]");
const manageSendFiatSymbol = document.querySelector("[data-manage-send-fiat-symbol]");
const manageSendMaxButton = document.querySelector("[data-manage-send-max]");
const manageSendFiatHint = document.querySelector("[data-manage-send-fiat]");
let manageSendUnit = "kas";        // "kas" | "fiat"
let manageSendPrice = null;        // live KAS price in selectedCurrency
let manageSendAvailableKas = null; // available balance for the Max button

function manageSendCurrencyCode() { return selectedCurrency.toUpperCase(); }

// Returns the amount to actually send, always in KAS, converting from fiat if needed.
function manageSendResolveAmountKas() {
  const raw = Number(manageSendAmountInput?.value);
  if (!isFinite(raw) || raw <= 0) return manageSendAmountInput?.value || "";
  if (manageSendUnit === "fiat") {
    if (!manageSendPrice) throw new Error("KAS price unavailable — switch back to KAS to send.");
    return String(raw / manageSendPrice);
  }
  return manageSendAmountInput?.value || "";
}

function updateManageSendFiatHint() {
  if (!manageSendFiatHint) return;
  const raw = Number(manageSendAmountInput?.value);
  if (!isFinite(raw) || raw <= 0 || !manageSendPrice) { manageSendFiatHint.hidden = true; return; }
  if (manageSendUnit === "kas") {
    manageSendFiatHint.textContent = `≈ ${formatFiatValue(raw, manageSendPrice)}`;
  } else {
    const kas = raw / manageSendPrice;
    manageSendFiatHint.textContent = `≈ ${kas.toLocaleString(undefined, { maximumFractionDigits: 8 })} KAS`;
  }
  manageSendFiatHint.hidden = false;
}

function applyManageSendUnit() {
  const isKas = manageSendUnit === "kas";
  if (manageSendUnitCode) manageSendUnitCode.textContent = isKas ? "KAS" : manageSendCurrencyCode();
  // Kaspa logo in KAS mode; fiat symbol in fiat mode.
  if (manageSendLogo) manageSendLogo.hidden = !isKas;
  if (manageSendFiatSymbol) {
    manageSendFiatSymbol.hidden = isKas;
    manageSendFiatSymbol.textContent = currencyMeta().symbol.trim();
  }
  const amountWord = t("send.amount");
  if (manageSendAmountLabel) manageSendAmountLabel.textContent = isKas ? `${amountWord} (KAS)` : `${amountWord} (${manageSendCurrencyCode()})`;
  if (manageSendAmountInput) manageSendAmountInput.placeholder = isKas ? "0.00000000" : "0.00";
  updateManageSendFiatHint();
}

manageSendUnitButton?.addEventListener("click", () => {
  if (!manageSendPrice) { showCopyToast("KAS price unavailable right now."); return; }
  const raw = Number(manageSendAmountInput?.value);
  // Convert the currently-typed value into the new unit so it stays equivalent.
  if (isFinite(raw) && raw > 0) {
    manageSendAmountInput.value = manageSendUnit === "kas"
      ? (raw * manageSendPrice).toFixed(selectedCurrency === "btc" ? 8 : 2)
      : String(raw / manageSendPrice);
  }
  manageSendUnit = manageSendUnit === "kas" ? "fiat" : "kas";
  applyManageSendUnit();
});
manageSendAmountInput?.addEventListener("input", updateManageSendFiatHint);

// Network fee tiers → priorityFee passed to engine.send.
const manageSendFeeButtons = document.querySelectorAll("[data-manage-send-fee]");
const manageSendFeeCustom = document.querySelector("[data-manage-send-fee-custom]");
const manageSendFeeSummary = document.querySelector("[data-manage-send-fee-summary]");
let manageSendFeeTier = "0";
const FEE_TIER_LABELS = { "0": "Normal", "0.00002": "Priority", custom: "Custom" };

// The fee input always shows the actual fee amount — read-only for the Normal /
// Priority presets, editable for Custom.
function manageSendGetFeeKas() {
  const v = Number(manageSendFeeCustom?.value);
  return isFinite(v) && v > 0 ? String(v) : "0";
}
function updateManageSendFeeSummary() {
  if (!manageSendFeeSummary) return;
  manageSendFeeSummary.textContent = `${FEE_TIER_LABELS[manageSendFeeTier] || "Normal"} · ${manageSendGetFeeKas()} KAS`;
}
function selectManageSendFeeTier(tier) {
  manageSendFeeTier = tier;
  manageSendFeeButtons.forEach((b) => b.classList.toggle("active", b.dataset.manageSendFee === tier));
  if (manageSendFeeCustom) {
    if (tier === "custom") {
      manageSendFeeCustom.readOnly = false;
      manageSendFeeCustom.value = "";
      manageSendFeeCustom.focus();
    } else {
      manageSendFeeCustom.readOnly = true;
      manageSendFeeCustom.value = tier; // "0" or "0.00002"
    }
  }
  updateManageSendFeeSummary();
}
manageSendFeeButtons.forEach((button) => {
  button.addEventListener("click", () => selectManageSendFeeTier(button.dataset.manageSendFee));
});
manageSendFeeCustom?.addEventListener("input", updateManageSendFeeSummary);

// Max: fill the amount with the full sendable balance (selected UTXOs if coin
// control is on, otherwise the whole address), minus the fee. Approximate — the
// exact network fee is only known once the tx is built.
function computeMaxSendKas() {
  let availableKas = manageSendAvailableKas;
  const selected = getSelectedSendOutpoints();
  if (selected.length) {
    let sompi = 0n;
    for (const entry of lastManageAddressUtxos) {
      if (selectedSendOutpoints.has(utxoOutpointKey(entry.outpoint || {}))) sompi += BigInt(entry.amount || 0);
    }
    availableKas = Number(sompi) / 1e8;
  }
  if (availableKas == null || !isFinite(availableKas)) return null;
  const feeBuffer = Number(manageSendGetFeeKas()) + 0.0001; // priority fee + base-fee headroom
  const max = availableKas - feeBuffer;
  return max > 0 ? max : 0;
}
manageSendMaxButton?.addEventListener("click", () => {
  const maxKas = computeMaxSendKas();
  if (maxKas == null) { showCopyToast("Balance unavailable right now."); return; }
  if (manageSendUnit === "fiat" && manageSendPrice) {
    manageSendAmountInput.value = (maxKas * manageSendPrice).toFixed(selectedCurrency === "btc" ? 8 : 2);
  } else {
    manageSendAmountInput.value = String(maxKas);
  }
  updateManageSendFiatHint();
  manageSendAmountInput.dispatchEvent(new Event("input")); // re-run send validity
});

function resetManageSendExtras() {
  manageSendUnit = "kas";
  applyManageSendUnit();
  selectManageSendFeeTier("0");
  if (manageSendFiatHint) manageSendFiatHint.hidden = true;
  manageSendPrice = null;
  manageSendAvailableKas = null;
  fetchKasPrice(selectedCurrency).then((price) => { manageSendPrice = price; updateManageSendFiatHint(); });
  engine.balance().then((b) => { manageSendAvailableKas = Number(b.totalKas); }).catch(() => {});
}

const manageSendController = makeSendController({
  recipient: document.querySelector("[data-manage-send-recipient]"),
  resolvedHint: document.querySelector("[data-manage-send-resolved]"),
  amount: manageSendAmountInput,
  balanceHint: document.querySelector("[data-manage-send-balance]"),
  error: document.querySelector("[data-manage-send-error]"),
  progress: document.querySelector("[data-manage-send-progress]"),
  submit: document.querySelector("[data-manage-send-submit]"),
}, {
  onOpen: () => showManageView("send"),
  onClose: () => showManageView("list"),
  getSelection: getSelectedSendOutpoints,
  resolveAmountKas: manageSendResolveAmountKas,
  getFeeKas: manageSendGetFeeKas,
});
// Use the same rich Send Kaspa modal the profile dropdown opens (chatting address), so the two
// entry points are identical instead of the older in-card send screen.
document.querySelector("[data-manage-address-send]")?.addEventListener("click", () => openSendKaspaModal());
document.querySelector("[data-manage-send-back]")?.addEventListener("click", () => showManageView("list"));

document.querySelectorAll("[data-manage-address-tab]").forEach((tabButton) => {
  tabButton.addEventListener("click", () => {
    document.querySelectorAll("[data-manage-address-tab]").forEach((btn) => btn.classList.toggle("active", btn === tabButton));
    const target = tabButton.dataset.manageAddressTab;
    document.querySelectorAll("[data-manage-address-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.manageAddressPanel !== target;
    });
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (manageAddressScreen && !manageAddressScreen.hidden) closeManageAddressScreen();
  if (sendKaspaModal && !sendKaspaModal.hidden) closeSendKaspaModal();
  if (spendingSendModal && !spendingSendModal.hidden) closeSpendingSendModal();
  else if (spendingDetailScreen && !spendingDetailScreen.hidden) closeSpendingDetailScreen();
  else if (spendingVisibilityScreen && !spendingVisibilityScreen.hidden) closeSpendingVisibilityScreen();
  else if (spendingManageScreen && !spendingManageScreen.hidden) closeSpendingManageScreen();
});

// --- Private key reveal (chatting address) — same hold-to-reveal UX as the
// existing seed-phrase modal, kept as a separate small implementation rather
// than refactoring that working code. ---

const privatekeyModal = document.querySelector("[data-privatekey-modal]");
const revealPrivatekeyButton = document.querySelector("[data-reveal-privatekey]");
const privatekeyProgressFill = document.querySelector("[data-privatekey-progress]");
const privatekeyValueBox = document.querySelector("[data-privatekey-value]");
const copyPrivatekeyButton = document.querySelector("[data-copy-privatekey]");
const PRIVATEKEY_HOLD_MS = 5000;
let privatekeyHoldStartedAt = 0;
let privatekeyHoldFrame = 0;
let privatekeyHoldPointerId = null;

function resetPrivatekeyHold() {
  if (privatekeyHoldFrame) cancelAnimationFrame(privatekeyHoldFrame);
  privatekeyHoldFrame = 0;
  privatekeyHoldStartedAt = 0;
  privatekeyHoldPointerId = null;
  revealPrivatekeyButton?.classList.remove("is-holding");
  if (privatekeyProgressFill) privatekeyProgressFill.style.width = "0%";
}

// When set, the modal reveals THIS key (a spending address's) instead of the chatting key.
let privatekeyRevealValue = null;
function revealPrivatekeyAfterHold() {
  const value = privatekeyRevealValue || engine.privateKeyHex;
  if (!value || !privatekeyValueBox) { resetPrivatekeyHold(); return; }
  privatekeyValueBox.textContent = value;
  privatekeyValueBox.hidden = false;
  if (revealPrivatekeyButton) revealPrivatekeyButton.hidden = true;
  if (copyPrivatekeyButton) copyPrivatekeyButton.hidden = false;
  resetPrivatekeyHold();
}

function updatePrivatekeyHold(now) {
  if (!privatekeyHoldStartedAt) return;
  const elapsed = Math.max(0, now - privatekeyHoldStartedAt);
  const progress = Math.min(1, elapsed / PRIVATEKEY_HOLD_MS);
  if (privatekeyProgressFill) privatekeyProgressFill.style.width = `${progress * 100}%`;
  if (progress >= 1) { revealPrivatekeyAfterHold(); return; }
  privatekeyHoldFrame = requestAnimationFrame(updatePrivatekeyHold);
}

function beginPrivatekeyHold(event) {
  if (!revealPrivatekeyButton || revealPrivatekeyButton.hidden || privatekeyHoldStartedAt) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  privatekeyHoldPointerId = event.pointerId;
  try { revealPrivatekeyButton.setPointerCapture(event.pointerId); } catch {}
  revealPrivatekeyButton.classList.add("is-holding");
  privatekeyHoldStartedAt = performance.now();
  privatekeyHoldFrame = requestAnimationFrame(updatePrivatekeyHold);
}

function cancelPrivatekeyHold(event) {
  if (event && privatekeyHoldPointerId !== null && event.pointerId !== privatekeyHoldPointerId) return;
  resetPrivatekeyHold();
}

function closePrivatekeyModal() {
  resetPrivatekeyHold();
  privatekeyRevealValue = null;
  if (privatekeyModal) privatekeyModal.hidden = true;
  if (privatekeyValueBox) { privatekeyValueBox.hidden = true; privatekeyValueBox.textContent = ""; }
  if (copyPrivatekeyButton) copyPrivatekeyButton.hidden = true;
  if (revealPrivatekeyButton) revealPrivatekeyButton.hidden = false;
}

const privatekeyHintEl = document.querySelector("[data-privatekey-hint]");
const DEFAULT_PRIVATEKEY_HINT = privatekeyHintEl?.textContent || "";
function openPrivatekeyModal(overrideKey = null, hintText = null) {
  privatekeyRevealValue = (typeof overrideKey === "string" && overrideKey) ? overrideKey : null;
  if (!privatekeyRevealValue && !engine.privateKeyHex) { showCopyToast("No wallet loaded."); return; }
  if (privatekeyHintEl) privatekeyHintEl.textContent = hintText || DEFAULT_PRIVATEKEY_HINT;
  resetPrivatekeyHold();
  if (privatekeyValueBox) { privatekeyValueBox.hidden = true; privatekeyValueBox.textContent = ""; }
  if (copyPrivatekeyButton) copyPrivatekeyButton.hidden = true;
  if (revealPrivatekeyButton) revealPrivatekeyButton.hidden = false;
  if (privatekeyModal) privatekeyModal.hidden = false;
}

document.querySelector("[data-open-privatekey]")?.addEventListener("click", () => openPrivatekeyModal());

// Export a specific spending address's private key (derived from the account phrase at its index).
document.querySelector("[data-spending-detail-privatekey]")?.addEventListener("click", () => {
  const mnemonic = activeAccountMnemonic();
  if (!mnemonic) { showCopyToast("This account has no recovery phrase, so private keys aren't available."); return; }
  try {
    const spending = engine.deriveSpendingWallet(mnemonic, spendingDetailIndex, activeAccountPassphrase());
    const key = String(spending?.privateKeyHex || "").trim();
    if (!key) { showCopyToast("Could not derive this address's private key."); return; }
    openPrivatekeyModal(key, `This is the private key for spending address #${spendingDetailIndex}. Anyone with it can spend from this address — never share it.`);
  } catch (error) {
    showCopyToast(`Could not derive private key: ${error.message}`);
  }
});
document.querySelectorAll("[data-close-privatekey]").forEach((button) => button.addEventListener("click", closePrivatekeyModal));
privatekeyModal?.addEventListener("click", (event) => { if (event.target === privatekeyModal) closePrivatekeyModal(); });
// Click-to-view (no longer hold): password-gated when the seed-phrase protection
// is on, since the value is now protected by the password.
revealPrivatekeyButton?.addEventListener("click", async () => {
  if (accountShellPrefs.passwordForSeed && hasAppPassword()) {
    const ok = await requestPassword({ mode: "verify", title: "Enter Password", message: "Enter your password to view the private key." });
    if (!ok) return;
  }
  revealPrivatekeyAfterHold();
});
copyPrivatekeyButton?.addEventListener("click", async () => {
  if (!engine.privateKeyHex) return;
  await copyTextToClipboard(engine.privateKeyHex);
  showCopyToast("Private key copied");
});

document.querySelectorAll("[data-profile-dropdown], [data-settings-dropdown]").forEach((dropdown) => {
  const toggle = dropdown.querySelector("[data-dropdown-toggle]");
  const body = dropdown.querySelector(".profile-dropdown-body, .settings-dropdown-body");
  toggle?.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    if (body) body.hidden = expanded;
  });
});


// Kaspa Explorer selector (Settings > Connectivity). Persists the chosen
// explorer, reflects it in the dropdown's current-value label + checkmark, and
// updates the Manage Address explorer link if that screen is open.
const explorerCurrentLabel = document.querySelector("[data-explorer-current]");
const explorerOptionButtons = document.querySelectorAll("[data-explorer-option]");
function refreshExplorerSelectionUi() {
  const key = KASPA_EXPLORERS[accountShellPrefs.explorer] ? accountShellPrefs.explorer : DEFAULT_KASPA_EXPLORER;
  if (explorerCurrentLabel) explorerCurrentLabel.textContent = KASPA_EXPLORERS[key].displayName;
  explorerOptionButtons.forEach((button) => {
    button.classList.toggle("selected", button.dataset.explorerOption === key);
  });
}
explorerOptionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.explorerOption;
    if (!KASPA_EXPLORERS[key]) return;
    accountShellPrefs.explorer = key;
    persistAccountShellPreferences();
    refreshExplorerSelectionUi();
    if (manageAddressExplorerLink && engine.address) manageAddressExplorerLink.href = explorerAddressUrl(engine.address);
    const dropdownBody = button.closest(".settings-dropdown-body");
    const dropdownToggle = button.closest(".settings-dropdown")?.querySelector("[data-dropdown-toggle]");
    if (dropdownBody) dropdownBody.hidden = true;
    if (dropdownToggle) dropdownToggle.setAttribute("aria-expanded", "false");
    showCopyToast(`Explorer set to ${KASPA_EXPLORERS[key].displayName}`);
  });
});
refreshExplorerSelectionUi();

// ---------------------------------------------------------------------------
// Message retention (Settings > Storage > Message retention) — port of iOS
// AppSettings.messageRetention + MessageStore.applyRetention. The window is stored PER
// ACCOUNT (accountScopedKey), because it governs that account's stored chat history.
// "Keep forever" is the default and the only value an installation can have without the
// user choosing it, and it prunes nothing at all.
//
// What pruning deletes: one-to-one chat messages older than the window, for the signed-in
// account only. Deliberately never deleted:
//   - handshake messages (protocol-critical; iOS excludes them from its batch delete too),
//   - messages still in flight (draft/building/signing/broadcasting/pending),
//   - messages with no usable timestamp (unknown age is not old age),
//   - group chats (iOS's retention covers the 1:1 message store only; group history is a
//     separate store on both platforms).
// This is local cleanup: nothing is removed from the chain, from a Nextcloud backup, or
// from any other device.
// ---------------------------------------------------------------------------
const MESSAGE_RETENTION_KEY = "kachat-message-retention-v1";
const MESSAGE_RETENTION_OPTIONS = [
  { key: "forever", days: null, label: "Keep forever" },
  { key: "days30", days: 30, label: "30 days" },
  { key: "days90", days: 90, label: "90 days" },
  { key: "year1", days: 365, label: "1 year" },
];
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // periodic pass, on top of the one at load
let retentionSweepTimer = null;

function messageRetentionKeyValue() {
  try {
    const stored = String(localStorage.getItem(accountScopedKey(MESSAGE_RETENTION_KEY)) || "");
    return MESSAGE_RETENTION_OPTIONS.some((option) => option.key === stored) ? stored : "forever";
  } catch { return "forever"; }
}
function messageRetentionOption() {
  const key = messageRetentionKeyValue();
  return MESSAGE_RETENTION_OPTIONS.find((option) => option.key === key) || MESSAGE_RETENTION_OPTIONS[0];
}
/** Oldest timestamp that survives, or null for "Keep forever" (no cutoff, no pruning). */
function messageRetentionCutoffMs() {
  const days = messageRetentionOption().days;
  return days ? Date.now() - days * 86400000 : null;
}

function isMessageRetentionExpired(message, cutoff) {
  if (!message || !cutoff) return false;
  if (message.messageType === "handshake") return false;
  const status = String(message.status || "");
  if (status === MESSAGE_STATUSES.DRAFT || status === MESSAGE_STATUSES.BUILDING
    || status === MESSAGE_STATUSES.SIGNING || status === MESSAGE_STATUSES.BROADCASTING
    || status === MESSAGE_STATUSES.PENDING) return false;
  const createdAt = Number(message.createdAt || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  return createdAt < cutoff;
}

/** Counts what the current window would delete right now, without touching anything. */
function countMessagesOutsideRetention(cutoff) {
  if (!cutoff) return 0;
  let total = 0;
  for (const entry of state.conversations || []) {
    for (const message of entry.messages || []) if (isMessageRetentionExpired(message, cutoff)) total += 1;
  }
  return total;
}

/** Deletes everything outside the window from this browser and returns how many went. */
function applyMessageRetention() {
  if (!engine.address) return 0;
  const cutoff = messageRetentionCutoffMs();
  if (!cutoff) return 0;
  let removed = 0;
  for (const entry of state.conversations || []) {
    const messages = entry.messages || [];
    if (!messages.length) continue;
    const kept = messages.filter((message) => !isMessageRetentionExpired(message, cutoff));
    if (kept.length === messages.length) continue;
    removed += messages.length - kept.length;
    entry.messages = kept;
    const last = lastMessageFor(entry);
    entry.lastActivityAt = last?.createdAt || entry.lastActivityAt || entry.createdAt;
    entry.updatedAt = Date.now();
  }
  if (!removed) return 0;
  // Force the corruption-recovery snapshot to be rewritten in the same pass: it is normally
  // throttled to once a minute, and hydration merges it back into a conversation — a stale
  // copy would resurrect the messages just deleted on the next reload.
  lastStateBackupWriteAt = 0;
  persistState();
  const open = (state.conversations || []).find((entry) => entry.id === activeConversationId);
  if (open) renderMessages(open);
  renderChats();
  appendEngineLog(`Message retention (${messageRetentionOption().label}) removed ${removed} stored message${removed === 1 ? "" : "s"}.`);
  return removed;
}

/** Load-time + periodic pass. Safe to call whenever; a no-op on "Keep forever". */
function startMessageRetentionSweeps() {
  try { applyMessageRetention(); } catch (error) { appendEngineLog(`Message retention pass failed: ${error.message}`); }
  if (retentionSweepTimer) return;
  retentionSweepTimer = window.setInterval(() => {
    try { applyMessageRetention(); } catch { /* next sweep retries */ }
  }, RETENTION_SWEEP_INTERVAL_MS);
}

const retentionLabelEl = document.querySelector("[data-retention-label]");
const retentionOptionButtons = document.querySelectorAll("[data-retention-option]");
function refreshRetentionSelectionUi() {
  const current = messageRetentionKeyValue();
  if (retentionLabelEl) retentionLabelEl.textContent = messageRetentionOption().label;
  retentionOptionButtons.forEach((button) => {
    button.classList.toggle("selected", button.dataset.retentionOption === current);
  });
}
retentionOptionButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const key = button.dataset.retentionOption;
    const option = MESSAGE_RETENTION_OPTIONS.find((entry) => entry.key === key);
    if (!option || key === messageRetentionKeyValue()) return;
    if (!engine.address) { showCopyToast("Sign in to change message retention."); return; }
    // Shortening the window deletes history, so say exactly how much before doing it.
    if (option.days) {
      const doomed = countMessagesOutsideRetention(Date.now() - option.days * 86400000);
      if (doomed > 0 && !await confirmText(`Keep only the last ${option.label.toLowerCase()} of messages?\n\n${doomed} older message${doomed === 1 ? "" : "s"} will be deleted from this browser. This cannot be undone here, and they will not be downloaded again.`)) return;
    }
    try { localStorage.setItem(accountScopedKey(MESSAGE_RETENTION_KEY), key); } catch {}
    refreshRetentionSelectionUi();
    const removed = applyMessageRetention();
    showCopyToast(option.days
      ? `Keeping the last ${option.label.toLowerCase()}${removed ? `. Removed ${removed} older message${removed === 1 ? "" : "s"}` : ""}.`
      : "Keeping messages forever.");
  });
});
refreshRetentionSelectionUi();

document.querySelectorAll(".settings-segmented-option:not([data-theme-option])").forEach((option) => {
  option.addEventListener("click", () => {
    const group = option.closest(".settings-segmented");
    group?.querySelectorAll(".settings-segmented-option").forEach((sibling) => sibling.classList.toggle("active", sibling === option));
  });
});

const THEME_PREF_KEY = "kachat-theme-preference-v1";
const systemThemeMedia = window.matchMedia("(prefers-color-scheme: light)");
let themePreference = "dark";

// The stored preference is one of system/light/dark; the *effective* theme
// (what actually paints) is light or dark. "System" follows the OS and updates
// live via the media-query listener below.
function effectiveTheme(preference) {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemThemeMedia.matches ? "light" : "dark";
}

function applyThemePreference(preference) {
  themePreference = preference === "light" || preference === "system" ? preference : "dark";
  localStorage.setItem(THEME_PREF_KEY, themePreference);
  const effective = effectiveTheme(themePreference);
  document.documentElement.setAttribute("data-theme", effective);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute("content", effective === "light" ? "#eef1f4" : "#070a0d");
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    // Highlight the chosen preference (System/Light/Dark), not the resolved theme.
    button.classList.toggle("active", button.getAttribute("data-theme-option") === themePreference);
  });
}

document.querySelectorAll("[data-theme-option]").forEach((button) => {
  button.addEventListener("click", () => applyThemePreference(button.getAttribute("data-theme-option")));
});

systemThemeMedia.addEventListener("change", () => {
  if (themePreference === "system") applyThemePreference("system");
});

applyThemePreference(localStorage.getItem(THEME_PREF_KEY) || "dark");

// --- Currency + live KAS price (matches iOS AppCurrency; codes are CoinGecko
// vs_currency values, so no mapping table). Drives fiat conversion in the send
// screen and anywhere KAS value is shown. ---
const CURRENCY_PREF_KEY = "kachat-currency-v1";
const CURRENCIES = {
  usd: { name: "US Dollar (USD)", symbol: "$" },
  eur: { name: "Euro (EUR)", symbol: "€" },
  gbp: { name: "British Pound (GBP)", symbol: "£" },
  jpy: { name: "Japanese Yen (JPY)", symbol: "¥" },
  cny: { name: "Chinese Yuan (CNY)", symbol: "CN¥" },
  aud: { name: "Australian Dollar (AUD)", symbol: "A$" },
  cad: { name: "Canadian Dollar (CAD)", symbol: "C$" },
  chf: { name: "Swiss Franc (CHF)", symbol: "CHF " },
  hkd: { name: "Hong Kong Dollar (HKD)", symbol: "HK$" },
  inr: { name: "Indian Rupee (INR)", symbol: "₹" },
  krw: { name: "South Korean Won (KRW)", symbol: "₩" },
  sgd: { name: "Singapore Dollar (SGD)", symbol: "S$" },
  nzd: { name: "New Zealand Dollar (NZD)", symbol: "NZ$" },
  mxn: { name: "Mexican Peso (MXN)", symbol: "MX$" },
  brl: { name: "Brazilian Real (BRL)", symbol: "R$" },
  rub: { name: "Russian Ruble (RUB)", symbol: "₽" },
  try: { name: "Turkish Lira (TRY)", symbol: "₺" },
  zar: { name: "South African Rand (ZAR)", symbol: "R" },
  idr: { name: "Indonesian Rupiah (IDR)", symbol: "Rp" },
  btc: { name: "Bitcoin (BTC)", symbol: "₿" },
};
const DEFAULT_CURRENCY = "usd";
let selectedCurrency = localStorage.getItem(CURRENCY_PREF_KEY) || DEFAULT_CURRENCY;
if (!CURRENCIES[selectedCurrency]) selectedCurrency = DEFAULT_CURRENCY;
const kasPriceCache = new Map();

function currencyMeta() { return CURRENCIES[selectedCurrency] || CURRENCIES[DEFAULT_CURRENCY]; }

async function fetchKasPrice(currency) {
  const cached = kasPriceCache.get(currency);
  if (cached && Date.now() - cached.at < 60000) return cached.price;
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=kaspa&vs_currencies=${encodeURIComponent(currency)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`price ${res.status}`);
    const data = await res.json();
    const price = data?.kaspa?.[currency];
    if (typeof price === "number") { kasPriceCache.set(currency, { price, at: Date.now() }); return price; }
  } catch { /* offline / rate-limited — fiat features degrade gracefully */ }
  return null;
}

function formatFiatValue(kasAmount, price) {
  const value = Number(kasAmount) * price;
  if (!isFinite(value)) return "";
  const digits = selectedCurrency === "btc" ? 8 : value >= 1 ? 2 : 4;
  return `${currencyMeta().symbol}${value.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

const currencyCurrentLabel = document.querySelector("[data-currency-current]");
const currencyOptionButtons = document.querySelectorAll("[data-currency-option]");
function refreshCurrencyUi() {
  if (currencyCurrentLabel) currencyCurrentLabel.textContent = currencyMeta().name;
  currencyOptionButtons.forEach((b) => b.classList.toggle("selected", b.dataset.currencyOption === selectedCurrency));
}
currencyOptionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.currencyOption;
    if (!CURRENCIES[key]) return;
    selectedCurrency = key;
    localStorage.setItem(CURRENCY_PREF_KEY, key);
    refreshCurrencyUi();
    const body = button.closest(".settings-dropdown-body");
    const toggle = button.closest(".settings-dropdown")?.querySelector("[data-dropdown-toggle]");
    if (body) body.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    document.dispatchEvent(new CustomEvent("kachat:currency-changed"));
    showCopyToast(`Currency set to ${currencyMeta().name}`);
  });
});
refreshCurrencyUi();

// --- Language (matches iOS AppLanguage). Persists the choice, sets the document
// lang + text direction (RTL for Arabic/Persian/Hebrew). NOTE: switching the
// actual UI strings needs a translation layer that isn't built yet, so today
// this drives lang/dir and the picker state; see summary. ---
const LANGUAGE_PREF_KEY = "kachat-language-v1";
const LANGUAGES = {
  system: "System", en: "English", es: "Español", de: "Deutsch", fr: "Français",
  it: "Italiano", pt: "Português", ru: "Русский", tr: "Türkçe", ar: "العربية",
  "ar-EG": "العربية (مصر)", fa: "فارسی", he: "עברית", hi: "हिन्दी", bn: "বাংলা",
  ja: "日本語", ko: "한국어", vi: "Tiếng Việt", id: "Bahasa Indonesia", "zh-Hans": "简体中文",
};
const RTL_LANG_PREFIXES = ["ar", "fa", "he"];
let selectedLanguage = localStorage.getItem(LANGUAGE_PREF_KEY) || "system";
if (!LANGUAGES[selectedLanguage]) selectedLanguage = "system";

function effectiveLanguageCode() {
  return selectedLanguage === "system" ? navigator.language || "en" : selectedLanguage;
}

// --- i18n. Static UI text carrying a data-i18n key is translated on load and
// whenever the language changes (mirrors how iOS re-resolves every Text() when
// the app language changes). English is the fallback for any missing key/lang,
// so screens are wired incrementally and untranslated strings stay readable. ---
const I18N = {
  en: { appearance: "Appearance", language: "Language", currency: "Currency", "theme.system": "System", "theme.light": "Light", "theme.dark": "Dark", "send.recipient": "Recipient", "send.amount": "Amount", "send.networkFee": "Network Fee", "fee.normal": "Normal", "fee.priority": "Priority", "fee.custom": "Custom", "send.coinControl": "Coin Control", "send.title": "Send Kaspa", "action.send": "Send", "action.receive": "Receive", "action.copyAddress": "Copy Address" },
  es: { appearance: "Apariencia", language: "Idioma", currency: "Moneda", "theme.system": "Sistema", "theme.light": "Claro", "theme.dark": "Oscuro", "send.recipient": "Destinatario", "send.amount": "Cantidad", "send.networkFee": "Comisión de red", "fee.normal": "Normal", "fee.priority": "Prioritaria", "fee.custom": "Personalizada", "send.coinControl": "Control de monedas", "send.title": "Enviar Kaspa", "action.send": "Enviar", "action.receive": "Recibir", "action.copyAddress": "Copiar dirección" },
  fr: { appearance: "Apparence", language: "Langue", currency: "Devise", "theme.system": "Système", "theme.light": "Clair", "theme.dark": "Sombre", "send.recipient": "Destinataire", "send.amount": "Montant", "send.networkFee": "Frais de réseau", "fee.normal": "Normal", "fee.priority": "Prioritaire", "fee.custom": "Personnalisé", "send.coinControl": "Contrôle des pièces", "send.title": "Envoyer du Kaspa", "action.send": "Envoyer", "action.receive": "Recevoir", "action.copyAddress": "Copier l'adresse" },
  de: { appearance: "Darstellung", language: "Sprache", currency: "Währung", "theme.system": "System", "theme.light": "Hell", "theme.dark": "Dunkel", "send.recipient": "Empfänger", "send.amount": "Betrag", "send.networkFee": "Netzwerkgebühr", "fee.normal": "Normal", "fee.priority": "Priorität", "fee.custom": "Benutzerdefiniert", "send.coinControl": "Coin-Auswahl", "send.title": "Kaspa senden", "action.send": "Senden", "action.receive": "Empfangen", "action.copyAddress": "Adresse kopieren" },
  pt: { appearance: "Aparência", language: "Idioma", currency: "Moeda", "theme.system": "Sistema", "theme.light": "Claro", "theme.dark": "Escuro", "send.recipient": "Destinatário", "send.amount": "Quantia", "send.networkFee": "Taxa de rede", "fee.normal": "Normal", "fee.priority": "Prioritária", "fee.custom": "Personalizada", "send.coinControl": "Controle de moedas", "send.title": "Enviar Kaspa", "action.send": "Enviar", "action.receive": "Receber", "action.copyAddress": "Copiar endereço" },
};
function i18nActiveLang() {
  const base = effectiveLanguageCode().toLowerCase().split("-")[0];
  return I18N[base] ? base : "en";
}
function t(key) {
  const lang = i18nActiveLang();
  return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
}
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const translated = t(key);
    if (translated) el.textContent = translated;
  });
}

function applyLanguage() {
  const code = effectiveLanguageCode();
  document.documentElement.setAttribute("lang", code);
  const base = code.toLowerCase().split("-")[0];
  document.documentElement.setAttribute("dir", RTL_LANG_PREFIXES.includes(base) ? "rtl" : "ltr");
  applyI18n();
}
const languageCurrentLabel = document.querySelector("[data-language-current]");
const languageOptionButtons = document.querySelectorAll("[data-language-option]");
function refreshLanguageUi() {
  if (languageCurrentLabel) languageCurrentLabel.textContent = LANGUAGES[selectedLanguage] || "System";
  languageOptionButtons.forEach((b) => b.classList.toggle("selected", b.dataset.languageOption === selectedLanguage));
}
languageOptionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.languageOption;
    if (!LANGUAGES[key]) return;
    selectedLanguage = key;
    localStorage.setItem(LANGUAGE_PREF_KEY, key);
    applyLanguage();
    refreshLanguageUi();
    const body = button.closest(".settings-dropdown-body");
    const toggle = button.closest(".settings-dropdown")?.querySelector("[data-dropdown-toggle]");
    if (body) body.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  });
});
applyLanguage();
refreshLanguageUi();

// Contacts > "Sync Contacts from Nextcloud": pull the connected account's address book over
// CardDAV and import any card carrying a Kaspa address. Read-only against the server.
const contactsNextcloudSyncButton = document.querySelector("[data-contacts-nextcloud-sync]");
contactsNextcloudSyncButton?.addEventListener("click", async () => {
  const status = document.querySelector("[data-contacts-nextcloud-status]");
  const setStatusText = (text) => { if (status) status.textContent = text; };
  if (!isNextcloudConnected()) {
    showCopyToast("Connect Nextcloud in Settings → Storage first.");
    setStatusText("Not connected. Connect a server in Settings → Storage → Nextcloud, then sync.");
    return;
  }
  if (contactsNextcloudSyncButton.disabled) return;
  contactsNextcloudSyncButton.disabled = true;
  setStatusText("Syncing…");
  try {
    const result = await syncNextcloudContacts();
    const parts = [];
    if (result.added) parts.push(`${result.added} added`);
    if (result.updated) parts.push(`${result.updated} updated`);
    const detail = parts.length ? parts.join(", ") : "no new contacts";
    setStatusText(`Synced ${result.found} card${result.found === 1 ? "" : "s"} with a Kaspa address — ${detail}.`);
    showCopyToast(`Nextcloud contacts synced — ${detail}.`);
  } catch (error) {
    setStatusText("Sync failed. Check your Nextcloud connection and try again.");
    showCopyToast(error?.message || "Nextcloud contacts sync failed.");
  } finally {
    contactsNextcloudSyncButton.disabled = false;
  }
});

// Connectivity endpoint fields (Kaspa REST API, KNS API, Push Indexer, Trusted
// Node) persist through the endpoint registry. Blank = default; Trusted Node
// blank = auto-search resolver. Takes effect on the next request/reconnect.
function loadEndpointInputs() {
  document.querySelectorAll("[data-endpoint]").forEach((input) => {
    const key = input.dataset.endpoint;
    input.value = getEndpointOverride(key) || ENDPOINT_DEFAULTS[key] || "";
  });
}
document.querySelectorAll("[data-endpoint]").forEach((input) => {
  input.addEventListener("change", () => {
    setEndpoint(input.dataset.endpoint, input.value.trim());
    loadEndpointInputs();
    showCopyToast("Connection setting saved");
  });
});
loadEndpointInputs();

document.querySelector("[data-reset-connection-defaults]")?.addEventListener("click", () => {
  resetEndpoints();
  loadEndpointInputs();
  if (indexerUrlInput) { indexerUrlInput.value = ENDPOINT_DEFAULTS.kasiaIndexer; localStorage.setItem(INDEXER_URL_KEY, indexerUrlInput.value); }
  showCopyToast("Connection settings reset to defaults");
});

// IP Address Book: a user-managed list of saved Kaspa node addresses (label + address),
// mirroring iOS's Connection Settings "IP Address Book". Save your own nodes here, then
// "Use" one to fill the Trusted Node field above, or copy the raw address.
const SAVED_NODES_KEY = "kachat-saved-nodes-v1";
function loadSavedNodes() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_NODES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e) => e && typeof e === "object" && typeof e.address === "string")
      .map((e) => ({ label: String(e.label || "").trim(), address: String(e.address).trim() }))
      .filter((e) => e.address);
  } catch { return []; }
}
function persistSavedNodes(list) {
  try { localStorage.setItem(SAVED_NODES_KEY, JSON.stringify(list)); } catch {}
}
function setSavedNodeError(message) {
  const el = document.querySelector("[data-saved-node-error]");
  if (!el) return;
  if (message) { el.textContent = message; el.hidden = false; }
  else { el.textContent = ""; el.hidden = true; }
}
function renderSavedNodes() {
  const list = document.querySelector("[data-saved-nodes-list]");
  if (!list) return;
  const entries = loadSavedNodes();
  list.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "saved-node-empty";
    empty.textContent = "No saved addresses";
    list.appendChild(empty);
    return;
  }
  entries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "saved-node-row";

    const copy = document.createElement("div");
    copy.className = "saved-node-copy";
    if (entry.label) {
      const label = document.createElement("strong");
      label.textContent = entry.label;
      const addr = document.createElement("small");
      addr.textContent = entry.address;
      copy.append(label, addr);
    } else {
      const addr = document.createElement("strong");
      addr.className = "mono";
      addr.textContent = entry.address;
      copy.append(addr);
    }

    const actions = document.createElement("div");
    actions.className = "saved-node-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "saved-node-btn";
    useBtn.textContent = "Use";
    useBtn.addEventListener("click", () => {
      setEndpoint("trustedNode", entry.address);
      loadEndpointInputs();
      showCopyToast("Trusted Node set");
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "saved-node-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(entry.address); showCopyToast(addressCopiedToastText(entry.address)); }
      catch { showCopyToast("Copy failed"); }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "saved-node-btn danger";
    deleteBtn.setAttribute("aria-label", "Delete saved address");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      const next = loadSavedNodes();
      next.splice(index, 1);
      persistSavedNodes(next);
      renderSavedNodes();
    });

    actions.append(useBtn, copyBtn, deleteBtn);
    row.append(copy, actions);
    list.appendChild(row);
  });
}
function addSavedNodeFromInputs() {
  const labelInput = document.querySelector("[data-saved-node-label]");
  const addressInput = document.querySelector("[data-saved-node-address]");
  if (!addressInput) return;
  const address = addressInput.value.trim();
  if (!address) { setSavedNodeError("Enter a node address."); return; }
  const label = labelInput ? labelInput.value.trim() : "";
  const next = loadSavedNodes();
  if (next.some((e) => e.address.toLowerCase() === address.toLowerCase())) {
    setSavedNodeError("That address is already saved.");
    return;
  }
  next.push({ label, address });
  persistSavedNodes(next);
  setSavedNodeError("");
  if (labelInput) labelInput.value = "";
  addressInput.value = "";
  renderSavedNodes();
}
document.querySelector("[data-add-saved-node]")?.addEventListener("click", addSavedNodeFromInputs);
document.querySelector("[data-saved-node-address]")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addSavedNodeFromInputs(); }
});
document.querySelector("[data-saved-node-address]")?.addEventListener("input", () => setSavedNodeError(""));
renderSavedNodes();

function updateLocalStorageUsedLabel() {
  const label = document.querySelector("[data-local-storage-used]");
  if (!label) return;
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("kachat-")) continue;
    bytes += key.length + (localStorage.getItem(key) || "").length;
  }
  const kb = bytes / 1024;
  label.textContent = kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`;
}

// Single source of truth for every green/orange/red connection dot in the
// app: green whenever the primary RPC is connected, orange only once latency
// on that connection reaches 500ms, red only when disconnected. Deliberately
// ignores standby/wallet/cipher/subscription readiness — those used to also
// gate the topbar dot, which made it show orange far more than "connected or
// not" actually warranted.
// Red is reserved for SUSTAINED disconnection. "Not ready" is also what the primary reads
// at startup before the first connect and in the gaps between reconnect attempts, and
// flashing red there tells the user they are offline when they aren't - those windows show
// orange until the state has persisted past the grace window (iOS parity).
const DISCONNECT_GRACE_MS = 8000;
let disconnectedSinceMs = null;
let disconnectGraceTimer = null;

function computeConnectionHealth() {
  const connection = engine.connectionSnapshot?.() || {};
  const registry = engine.nodeRegistrySnapshot?.() || { endpoints: [], lastGoodEndpoint: "" };
  const primaryReady = Boolean(engine.rpc) && connection.primary === "ready";
  if (!primaryReady) {
    if (disconnectedSinceMs == null) disconnectedSinceMs = Date.now();
    const downMs = Date.now() - disconnectedSinceMs;
    if (downMs < DISCONNECT_GRACE_MS) {
      // Nothing repaints the dot on a timer (it only redraws on status events), so schedule
      // the single repaint that turns orange into red once the grace expires. Without this a
      // silent drop would sit on orange forever.
      if (disconnectGraceTimer == null) {
        disconnectGraceTimer = window.setTimeout(() => {
          disconnectGraceTimer = null;
          updateGlobalHealthIndicator();
          if (connectionOverlay && !connectionOverlay.hidden) renderConnectionStatus();
        }, DISCONNECT_GRACE_MS - downMs + 50);
      }
      return { stateName: "busy", latencyMs: null };
    }
    return { stateName: "error", latencyMs: null };
  }
  disconnectedSinceMs = null;
  if (disconnectGraceTimer != null) {
    window.clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
  }

  const activeEndpoint = engine.rpc?.url || connection.primaryEndpoint || "";
  const record = (registry.endpoints || []).find((entry) => entry.endpoint === activeEndpoint)
    || (registry.endpoints || []).find((entry) => entry.endpoint === registry.lastGoodEndpoint);
  const latencyMs = record?.averageLatencyMs || record?.lastLatencyMs || null;
  const stateName = latencyMs && latencyMs >= 500 ? "busy" : "ready";
  return { stateName, latencyMs };
}

function connectionLatencyColor(ms) {
  if (!ms) return "";
  if (ms < 100) return "good";
  if (ms < 200) return "";
  if (ms < 500) return "warn";
  return "bad";
}

function formatRelativeTime(ts) {
  if (!ts) return "Never";
  const diffMs = Date.now() - ts;
  if (diffMs < 5000) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function hostFromEndpoint(endpoint) {
  if (!endpoint) return "";
  try {
    return new URL(endpoint.includes("://") ? endpoint : `wss://${endpoint}`).host || endpoint;
  } catch {
    return endpoint;
  }
}

function renderConnectionStatus() {
  const connection = engine.connectionSnapshot?.() || {};
  const registry = engine.nodeRegistrySnapshot?.() || { endpoints: [], endpointCount: 0, failovers: [], successfulFailovers: 0, failedFailovers: 0, lastGoodEndpoint: "" };
  const subscription = engine.subscriptionSnapshot?.() || {};
  const primaryReady = connection.primary === "ready";
  const standbyReady = connection.standby === "ready";

  const statusDot = document.querySelector("[data-connection-status-dot]");
  const statusText = document.querySelector("[data-connection-status-text]");
  const health = computeConnectionHealth();
  const stateText = health.stateName === "error"
    ? "Disconnected"
    : health.stateName === "busy"
      ? `Connected · high latency (${health.latencyMs} ms)`
      : "Connected";
  if (statusDot) { statusDot.classList.remove("ready", "busy", "error"); statusDot.classList.add(health.stateName); }
  if (statusText) statusText.textContent = stateText;

  const primaryEl = document.querySelector("[data-connection-primary-endpoint]");
  if (primaryEl) primaryEl.textContent = connection.primaryEndpoint ? hostFromEndpoint(connection.primaryEndpoint) : (connection.primary === "connecting" ? "Connecting…" : "Not connected");

  const standbyEl = document.querySelector("[data-connection-standby-endpoint]");
  if (standbyEl) {
    const customConfigured = Boolean(getEndpointOverride("trustedNode").trim());
    standbyEl.textContent = connection.standbyEndpoint
      ? hostFromEndpoint(connection.standbyEndpoint)
      : customConfigured
        ? "Not used with a custom node"
        : (connection.standby === "connecting" ? "Preparing…" : "Not ready");
  }

  const lastGoodRecord = (registry.endpoints || []).find((entry) => entry.endpoint === (connection.primaryEndpoint || registry.lastGoodEndpoint));
  const latencyEl = document.querySelector("[data-connection-latency]");
  if (latencyEl) {
    latencyEl.classList.remove("good", "warn", "bad");
    const ms = lastGoodRecord?.averageLatencyMs;
    latencyEl.textContent = ms ? `${ms} ms` : "--";
    const color = connectionLatencyColor(ms);
    if (color) latencyEl.classList.add(color);
  }

  const lastSyncEl = document.querySelector("[data-connection-last-sync]");
  if (lastSyncEl) lastSyncEl.textContent = subscription.status === "connecting" ? "In progress" : formatRelativeTime(subscription.updatedAt);

  // Warm-standby readiness badge (the standby is what makes a drop recover instantly).
  const standbyBadge = document.querySelector("[data-connection-standby-badge]");
  if (standbyBadge) standbyBadge.hidden = !standbyReady;

  // Node-selection cards reflect the saved trustedNode override ("" = Automatic).
  renderNodeModeCards();

  const failoversCountEl = document.querySelector("[data-connection-failovers-count]");
  if (failoversCountEl) failoversCountEl.textContent = String(registry.failovers?.length || 0);

  const failoversList = document.querySelector("[data-connection-failovers-list]");
  if (failoversList) {
    failoversList.replaceChildren();
    if (!registry.failovers?.length) {
      const empty = document.createElement("div");
      empty.className = "settings-list-row settings-info-row";
      const copy = document.createElement("span");
      copy.className = "settings-row-copy";
      const small = document.createElement("small");
      small.textContent = "No automatic reconnects yet.";
      copy.appendChild(small);
      empty.appendChild(copy);
      failoversList.appendChild(empty);
    } else {
      registry.failovers.slice(0, 10).forEach((event) => {
        const row = document.createElement("div");
        row.className = "settings-list-row settings-info-row";
        const copy = document.createElement("span");
        copy.className = "settings-row-copy";
        const strong = document.createElement("strong");
        strong.textContent = `${event.success ? "✓" : "✗"} ${hostFromEndpoint(event.from) || "auto"} → ${hostFromEndpoint(event.to) || "none"}`;
        const small = document.createElement("small");
        small.textContent = event.error ? `${formatRelativeTime(event.at)} · ${event.error}` : formatRelativeTime(event.at);
        copy.appendChild(strong);
        copy.appendChild(small);
        row.appendChild(copy);
        failoversList.appendChild(row);
      });
    }
  }
}

const photoQualityModal = document.querySelector("[data-photo-quality-modal]");
const photoQualitySlider = document.querySelector("[data-photo-quality-slider]");
const photoQualitySummaryEl = document.querySelector("[data-photo-quality-summary]");
// Draft index while the sheet is open; only committed to storage on Save (matches iOS).
function renderPhotoQualityDraft(index) {
  const clamped = Math.min(Math.max(index, 0), PHOTO_QUALITY_PRESETS.length - 1);
  const preset = PHOTO_QUALITY_PRESETS[clamped];
  if (photoQualitySlider) photoQualitySlider.value = String(clamped);
  if (photoQualitySummaryEl) photoQualitySummaryEl.textContent = photoQualitySummary(preset);
}
document.querySelector("[data-open-photo-quality]")?.addEventListener("click", () => {
  const currentIndex = PHOTO_QUALITY_PRESETS.findIndex((p) => p.id === getPhotoQualityPresetId());
  renderPhotoQualityDraft(currentIndex < 0 ? 1 : currentIndex);
  if (photoQualityModal) photoQualityModal.hidden = false;
});
photoQualitySlider?.addEventListener("input", () => {
  renderPhotoQualityDraft(Number(photoQualitySlider.value));
});
document.querySelectorAll("[data-close-photo-quality]").forEach((button) => {
  button.addEventListener("click", () => {
    if (photoQualityModal) photoQualityModal.hidden = true;
  });
});
document.querySelector("[data-save-photo-quality]")?.addEventListener("click", () => {
  const index = photoQualitySlider ? Number(photoQualitySlider.value) : 1;
  const preset = PHOTO_QUALITY_PRESETS[Math.min(Math.max(index, 0), PHOTO_QUALITY_PRESETS.length - 1)];
  setPhotoQualityPresetId(preset.id);
  if (photoQualityModal) photoQualityModal.hidden = true;
  showCopyToast(`Photo quality set to ${preset.name}`);
});

// --- KNS registration wizard --------------------------------------------------
// Real, on-chain domain registration (commit+reveal) followed by an optional
// profile-details save. Every step here spends real KAS once "Register
// Domain" or "Save Profile" is pressed — see engine/kns-write.js.

const knsRegisterModal = document.querySelector("[data-kns-register-modal]");
const knsWizardSteps = {
  funding: document.querySelector('[data-kns-step="funding"]'),
  domain: document.querySelector('[data-kns-step="domain"]'),
  details: document.querySelector('[data-kns-step="details"]'),
  done: document.querySelector('[data-kns-step="done"]'),
};
let knsWizardState = { assetId: null, domain: null, availability: null };

function showKnsWizardStep(name) {
  for (const [key, el] of Object.entries(knsWizardSteps)) if (el) el.hidden = key !== name;
}

function closeKnsRegisterModal() {
  if (knsRegisterModal) knsRegisterModal.hidden = true;
}

function knsStatusMessage(status) {
  return {
    "checking-availability": "Checking availability…",
    "fetching-fees": "Fetching current fee rates…",
    committing: "Broadcasting commit transaction…",
    committed: "Commit confirmed. Preparing reveal…",
    revealing: "Broadcasting reveal transaction…",
    revealed: "Reveal broadcast. Verifying…",
    verifying: "Verifying on the KNS indexer…",
    confirmed: "Confirmed!",
    "pending-confirmation": "Broadcast, but not showing on the indexer yet. It may still land shortly.",
  }[status] || status;
}

document.querySelector("[data-open-kns-register]")?.addEventListener("click", async () => {
  if (!knsRegisterModal) return;
  knsWizardState = { assetId: null, domain: null, availability: null };
  const errorEl = document.querySelector("[data-kns-funding-error]");
  const balanceEl = document.querySelector("[data-kns-current-balance]");
  const continueBtn = document.querySelector("[data-kns-funding-continue]");
  const minBalanceEl = document.querySelector("[data-kns-min-balance]");
  if (minBalanceEl) minBalanceEl.textContent = String(engine.knsEconomics().minRegistrationBalanceKas);
  if (errorEl) errorEl.hidden = true;
  if (balanceEl) balanceEl.textContent = "Checking…";
  if (continueBtn) continueBtn.disabled = true;
  document.querySelector("[data-kns-domain-label]").value = "";
  document.querySelector("[data-kns-domain-quote]").hidden = true;
  document.querySelector("[data-kns-register-submit]").disabled = true;
  document.querySelectorAll('[data-kns-step="details"] [data-kns-field]').forEach((el) => { el.value = ""; });
  showKnsWizardStep("funding");
  knsRegisterModal.hidden = false;

  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet first.");
    const balance = await engine.balance();
    if (balanceEl) balanceEl.textContent = `${balance.totalKas} KAS`;
    const minBalance = engine.knsEconomics().minRegistrationBalanceKas;
    const kas = Number(balance.totalKas);
    if (Number.isFinite(kas) && kas < minBalance) {
      if (errorEl) { errorEl.textContent = `You need at least ${minBalance} KAS to safely complete registration.`; errorEl.hidden = false; }
    } else if (continueBtn) {
      continueBtn.disabled = false;
    }
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Could not check your balance."; errorEl.hidden = false; }
  }
});

document.querySelectorAll("[data-close-kns-register]").forEach((button) => {
  button.addEventListener("click", async () => {
    closeKnsRegisterModal();
    await refreshOwnKnsProfileUntilResolved();
  });
});

document.querySelector("[data-kns-funding-continue]")?.addEventListener("click", () => {
  showKnsWizardStep("domain");
});

document.querySelector("[data-kns-check-availability]")?.addEventListener("click", async () => {
  const input = document.querySelector("[data-kns-domain-label]");
  const quoteEl = document.querySelector("[data-kns-domain-quote]");
  const errorEl = document.querySelector("[data-kns-domain-error]");
  const submitBtn = document.querySelector("[data-kns-register-submit]");
  if (errorEl) errorEl.hidden = true;
  if (quoteEl) quoteEl.hidden = true;
  if (submitBtn) submitBtn.disabled = true;
  const rawLabel = input?.value || "";
  if (!rawLabel.trim()) {
    if (errorEl) { errorEl.textContent = "Enter a domain name."; errorEl.hidden = false; }
    return;
  }
  try {
    const availability = await engine.checkKnsDomainAvailability(rawLabel);
    if (!availability.available) {
      if (errorEl) { errorEl.textContent = `${availability.domain} is already taken.`; errorEl.hidden = false; }
      return;
    }
    const feeTiers = await engine.fetchKnsFeeTiers();
    const label = availability.domain.replace(/\.kas$/, "");
    const { commitAmountKas, revealAmountKas } = knsRegistrationAmounts(label, feeTiers, { isReservedDomain: availability.isReservedDomain });
    knsWizardState.availability = availability;
    if (quoteEl) {
      quoteEl.hidden = false;
      quoteEl.innerHTML = `<strong>${availability.domain}</strong> is available.<br>Estimated cost: ~${commitAmountKas} KAS (registration fee ~${revealAmountKas} KAS + network fees).`;
    }
    if (submitBtn) submitBtn.disabled = false;
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Could not check availability."; errorEl.hidden = false; }
  }
});

document.querySelector("[data-kns-register-submit]")?.addEventListener("click", async () => {
  const input = document.querySelector("[data-kns-domain-label]");
  const errorEl = document.querySelector("[data-kns-domain-error]");
  const progressEl = document.querySelector("[data-kns-register-progress]");
  const submitBtn = document.querySelector("[data-kns-register-submit]");
  const checkBtn = document.querySelector("[data-kns-check-availability]");
  if (errorEl) errorEl.hidden = true;
  if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Starting…"; }
  if (submitBtn) submitBtn.disabled = true;
  if (checkBtn) checkBtn.disabled = true;
  try {
    const result = await engine.inscribeKnsDomain(input?.value || "", {
      onStatus: (event) => { if (progressEl) progressEl.textContent = knsStatusMessage(event.status); },
    });
    knsWizardState.assetId = result.assetId;
    knsWizardState.domain = result.domain;
    document.querySelector("[data-kns-registered-domain]").textContent = result.domain;
    engine.clearKnsCache(engine.address);
    showKnsWizardStep("details");
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Registration failed."; errorEl.hidden = false; }
    if (progressEl) progressEl.hidden = true;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (checkBtn) checkBtn.disabled = false;
  }
});

document.querySelector("[data-kns-details-skip]")?.addEventListener("click", async () => {
  closeKnsRegisterModal();
  await refreshOwnKnsProfileUntilResolved();
});

// --- KNS profile editor (for an already-registered domain) -------------------

const knsEditorModal = document.querySelector("[data-kns-editor-modal]");

document.querySelector("[data-open-kns-editor]")?.addEventListener("click", () => {
  if (!knsEditorModal || !ownKnsAssetId) {
    showCopyToast("Your domain isn't confirmed yet. Try again shortly.");
    return;
  }
  document.querySelector("[data-kns-editor-error]").hidden = true;
  document.querySelector("[data-kns-editor-progress]").hidden = true;
  document.querySelectorAll("[data-kns-editor-field]").forEach((el) => {
    el.value = ownKnsProfileFields?.[el.dataset.knsEditorField] || "";
  });
  knsEditorModal.hidden = false;
});

document.querySelectorAll("[data-close-kns-editor]").forEach((button) => {
  button.addEventListener("click", () => { if (knsEditorModal) knsEditorModal.hidden = true; });
});

// iOS-style "setup guide" — an in-app walkthrough opened from the editor (stacks on top of it).
const knsGuideModal = document.querySelector("[data-kns-guide-modal]");
document.querySelector("[data-open-kns-guide]")?.addEventListener("click", () => {
  if (knsGuideModal) knsGuideModal.hidden = false;
});
document.querySelectorAll("[data-close-kns-guide]").forEach((button) => {
  button.addEventListener("click", () => { if (knsGuideModal) knsGuideModal.hidden = true; });
});

document.querySelector("[data-kns-editor-save]")?.addEventListener("click", async () => {
  const errorEl = document.querySelector("[data-kns-editor-error]");
  const progressEl = document.querySelector("[data-kns-editor-progress]");
  const saveBtn = document.querySelector("[data-kns-editor-save]");
  if (errorEl) errorEl.hidden = true;
  if (!ownKnsAssetId) {
    if (errorEl) { errorEl.textContent = "Your domain isn't confirmed yet."; errorEl.hidden = false; }
    return;
  }

  const fields = {};
  document.querySelectorAll("[data-kns-editor-field]").forEach((el) => {
    const key = el.dataset.knsEditorField;
    const current = ownKnsProfileFields?.[key] || "";
    if (el.value.trim() !== current.trim()) fields[key] = el.value;
  });
  if (!Object.keys(fields).length) {
    if (knsEditorModal) knsEditorModal.hidden = true;
    return;
  }

  let validated;
  try {
    validated = engine.validateKnsProfileFields(fields);
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message; errorEl.hidden = false; }
    return;
  }

  if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Starting…"; }
  if (saveBtn) saveBtn.disabled = true;
  try {
    const results = await engine.submitKnsProfileFields(ownKnsAssetId, validated, {
      onStatus: (event) => {
        if (!progressEl) return;
        const label = KNS_PROFILE_FIELD_EDIT_ORDER.includes(event.key) ? event.key : "";
        progressEl.textContent = `${label ? `${label}: ` : ""}${knsStatusMessage(event.status) || event.status}`;
      },
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length && errorEl) {
      errorEl.textContent = `Some fields failed: ${failed.map((f) => f.key).join(", ")}. Try again shortly.`;
      errorEl.hidden = false;
    } else if (knsEditorModal) {
      knsEditorModal.hidden = true;
    }
    engine.clearKnsCache(engine.address);
    await refreshOwnKnsProfile();
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Saving profile changes failed."; errorEl.hidden = false; }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (progressEl) progressEl.hidden = true;
  }
});

document.querySelector("[data-kns-details-save]")?.addEventListener("click", async () => {
  const errorEl = document.querySelector("[data-kns-details-error]");
  const progressEl = document.querySelector("[data-kns-details-progress]");
  const saveBtn = document.querySelector("[data-kns-details-save]");
  if (errorEl) errorEl.hidden = true;
  if (!knsWizardState.assetId) {
    if (errorEl) { errorEl.textContent = "Domain isn't confirmed yet. Try again from your Profile screen shortly."; errorEl.hidden = false; }
    return;
  }
  const fields = {};
  document.querySelectorAll('[data-kns-step="details"] [data-kns-field]').forEach((el) => {
    fields[el.dataset.knsField] = el.value;
  });
  let validated;
  try {
    validated = engine.validateKnsProfileFields(fields);
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message; errorEl.hidden = false; }
    return;
  }
  const changed = Object.fromEntries(Object.entries(validated).filter(([, v]) => v));
  if (!Object.keys(changed).length) {
    showKnsWizardStep("done");
    return;
  }

  if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Starting…"; }
  if (saveBtn) saveBtn.disabled = true;
  try {
    const results = await engine.submitKnsProfileFields(knsWizardState.assetId, changed, {
      onStatus: (event) => {
        if (!progressEl) return;
        const label = KNS_PROFILE_FIELD_EDIT_ORDER.includes(event.key) ? event.key : "";
        progressEl.textContent = `${label ? `${label}: ` : ""}${knsStatusMessage(event.status) || event.status}`;
      },
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length && errorEl) {
      errorEl.textContent = `Some fields failed: ${failed.map((f) => f.key).join(", ")}. You can retry from your Profile screen.`;
      errorEl.hidden = false;
    }
    engine.clearKnsCache(engine.address);
    showKnsWizardStep("done");
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Saving profile details failed."; errorEl.hidden = false; }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (progressEl) progressEl.hidden = true;
  }
});

// Rebuilds contacts purely from on-chain self-stash data plus the active
// wallet's seed/private key — no local backup file required. See
// stashHandshakeForRecovery() for what gets written, and
// engine.syncSelfStashFromChain for the scan/decrypt side.
async function recoverConversationsFromBlockchain() {
  await ensureRuntimes({ quiet: true });
  if (!engine.address) throw new Error("Generate or import a wallet first.");
  const result = await engine.syncSelfStashFromChain({});
  let recovered = 0;
  for (const stash of result.stashes || []) {
    if (!stash.partnerAddress || stash.partnerAddress === engine.address) continue;
    if (state.contacts.some((entry) => entry.address === stash.partnerAddress)) continue;
    const createdAt = Number(stash.timestamp || stash.blockTime || Date.now());
    const displayName = shortAddress(stash.partnerAddress);
    const contact = {
      id: nowId(), name: displayName, nameIsCustom: false, address: stash.partnerAddress, avatar: initialsFor(displayName),
      createdAt, updatedAt: createdAt, relationshipState: "legacy-manual", handshakeTxid: "",
    };
    const conversationEntry = createConversation({ contactId: contact.id, createdAt });
    state.contacts.push(contact);
    state.conversations.push(conversationEntry);
    recovered += 1;
  }
  if (recovered > 0) {
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    renderChats();
  }
  return { recovered, scanned: result.scannedCount || 0, errors: result.errors || [] };
}

document.querySelector("[data-recover-conversations]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const { recovered, scanned, errors } = await recoverConversationsFromBlockchain();
    if (errors.length) appendEngineLog(`Recovery scan warnings: ${errors.join(" | ")}`);
    appendEngineLog(`Recovery scan complete: ${scanned} self-stash record(s) found, ${recovered} new conversation(s) recovered.`);
    showCopyToast(recovered > 0 ? `Recovered ${recovered} conversation${recovered === 1 ? "" : "s"}` : "No new conversations found");
  } catch (error) {
    showCopyToast(`Recovery failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

function saveProfileAccountName() {
  if (!profileAccountName || !engine.address) return;
  const cleanName = String(profileAccountName.value || "").trim();
  const current = activeAccountMetadata();
  if (!cleanName) {
    profileAccountName.value = current?.name || "Current Account";
    return;
  }
  if (cleanName === current?.name) return;

  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[engine.address] = {
    ...(metadata[engine.address] || {}),
    name: cleanName,
    createdAt: metadata[engine.address]?.createdAt || current?.createdAt || new Date().toISOString(),
  };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  const accounts = loadSavedAccounts();
  const index = accounts.findIndex((entry) => entry.address === engine.address);
  if (index >= 0) {
    accounts[index] = { ...accounts[index], name: cleanName };
    persistSavedAccounts(accounts);
  }

  updateWalletUi();
  renderSavedAccountsScreen();
  showCopyToast("Account name saved");
}

profileAccountName?.addEventListener("blur", saveProfileAccountName);
profileAccountName?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    profileAccountName.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    profileAccountName.value = activeAccountMetadata()?.name || "Current Account";
    profileAccountName.blur();
  }
});

// Zero-balance chat gate: with a confirmed 0 KAS chatting balance, composing is disabled
// and a funding card (QR + address + copy) shows above the composer. "--"/unknown never
// gates — only a real zero does. Clears itself the moment the balance refresh finds funds.
let fundingGateQrDrawnFor = null;

/// True only for a CONFIRMED zero chatting balance ("--"/unknown never gates).
function isChattingBalanceZero() {
  const kas = Number(currentBalanceKas);
  return Boolean(engine.address) && Number.isFinite(kas) && kas === 0;
}

// Modal variant of the funding gate, for flows without an inline composer to gate
// (broadcast rooms, KaPosts new-post/reply). Built once, on demand.
let fundingGateModalEl = null;

function showFundingGateModal() {
  if (!fundingGateModalEl) {
    fundingGateModalEl = document.createElement("div");
    fundingGateModalEl.className = "modal-backdrop funding-gate-backdrop";
    fundingGateModalEl.innerHTML = `
      <div class="contact-modal funding-gate-modal" role="dialog" aria-modal="true" aria-label="Fund your chatting address">
        <div class="modal-header">
          <div><p class="modal-kicker">Balance needed</p><h2>Fund your chatting address to start chatting</h2></div>
          <button class="modal-close" type="button" data-funding-modal-close aria-label="Close">×</button>
        </div>
        <div class="chat-funding-gate funding-gate-modal-body">
          <canvas width="360" height="360" data-funding-modal-qr></canvas>
          <button type="button" class="chat-funding-gate-address" data-funding-modal-address title="Copy address"></button>
          <button type="button" class="secondary-button" data-funding-modal-copy>Copy Address</button>
        </div>
      </div>`;
    document.body.appendChild(fundingGateModalEl);
    fundingGateModalEl.addEventListener("click", async (event) => {
      if (event.target === fundingGateModalEl || event.target.closest("[data-funding-modal-close]")) {
        fundingGateModalEl.hidden = true;
        return;
      }
      if (event.target.closest("[data-funding-modal-address]") || event.target.closest("[data-funding-modal-copy]")) {
        if (!engine.address) return;
        try { await copyTextToClipboard(engine.address); showCopyToast("Address copied to clipboard."); }
        catch (error) { appendEngineLog(error.message); }
      }
    });
  }
  const addressEl = fundingGateModalEl.querySelector("[data-funding-modal-address]");
  if (addressEl) addressEl.textContent = engine.address || "";
  const canvas = fundingGateModalEl.querySelector("[data-funding-modal-qr]");
  if (canvas && engine.address) {
    engine.drawQrFor(canvas, engine.address, { dark: "#06110f", light: "#ffffff" })
      .then(() => { canvas.style.width = "180px"; canvas.style.height = "180px"; })
      .catch(() => {});
  }
  fundingGateModalEl.hidden = false;
}

function updateChatFundingGate() {
  // Looked up per call (not a module const): this runs from setActiveConversationId too,
  // which can fire before module evaluation reaches this section.
  const fundingGateEl = document.querySelector("[data-funding-gate]");
  if (!fundingGateEl) return;
  const kas = Number(currentBalanceKas);
  const shouldGate = Boolean(activeConversationId) && Boolean(engine.address)
    && Number.isFinite(kas) && kas === 0;
  fundingGateEl.hidden = !shouldGate;
  composer?.classList.toggle("composer-gated", shouldGate);
  const input = composer?.elements?.message;
  if (input) input.disabled = shouldGate;
  if (!shouldGate) return;

  const addressEl = fundingGateEl.querySelector("[data-funding-gate-address]");
  if (addressEl) addressEl.textContent = engine.address;
  const canvas = fundingGateEl.querySelector("[data-funding-gate-qr]");
  if (canvas && fundingGateQrDrawnFor !== engine.address) {
    fundingGateQrDrawnFor = engine.address;
    engine.drawQrFor(canvas, engine.address, { dark: "#06110f", light: "#ffffff" })
      .then(() => { canvas.style.width = "180px"; canvas.style.height = "180px"; })
      .catch(() => { fundingGateQrDrawnFor = null; });
  }
}

document.querySelector("[data-funding-gate]")?.addEventListener("click", async (event) => {
  if (event.target.closest("[data-funding-gate-address]") || event.target.closest("[data-funding-gate-copy]")) {
    if (!engine.address) return;
    try { await copyTextToClipboard(engine.address); showCopyToast("Address copied to clipboard."); }
    catch (error) { appendEngineLog(error.message); }
  }
});

function updateWalletUi() {
  updateChatFundingGate();
  const address = engine.address;
  const meta = activeAccountMetadata();
  const accountName = meta?.name || (address ? "Current Account" : "No Active Account");
  if (toolbarBalanceValue) toolbarBalanceValue.textContent = `${currentBalanceKas} KAS`;
  else toolbarBalance.textContent = `${currentBalanceKas} KAS`;
  if (profileBalance) profileBalance.textContent = `${currentBalanceKas} KAS`;
  if (chattingAddressBalance) chattingAddressBalance.textContent = `${currentBalanceKas} KAS`;
  if (profileAddress) profileAddress.textContent = address || "No wallet loaded";
  if (profileInitial) profileInitial.textContent = address ? accountName.trim().charAt(0).toUpperCase() || "K" : "◎";
  if (profileAccountName && document.activeElement !== profileAccountName) profileAccountName.value = accountName;
  if (profileSessionState) profileSessionState.textContent = "";
  if (profileCreated) profileCreated.textContent = meta?.createdAt ? new Date(meta.createdAt).toLocaleString() : "—";
  if (settingsAccountName) settingsAccountName.textContent = accountName;
  if (settingsAccountAddress) settingsAccountAddress.textContent = address ? shortAddress(address) : "No wallet loaded";
  if (accountModalName) accountModalName.textContent = accountName;
  if (accountModalAddress) accountModalAddress.textContent = address ? shortAddress(address) : "No wallet loaded";
  if (accountModalInitial) accountModalInitial.textContent = address ? accountName.trim().charAt(0).toUpperCase() || "K" : "◎";
  if (profileQrCard && !address) profileQrCard.hidden = true;
  drawProfileQr();
}

async function drawProfileQr() {
  if (!profileQr) return; // inline profile QR card removed — Receive Kaspa uses the full-screen view
  const ctx = profileQr.getContext("2d");
  ctx.clearRect(0, 0, profileQr.width, profileQr.height);

  if (!engine.address) return;

  try {
    await engine.drawQr(profileQr);
  } catch (error) {
    appendEngineLog(`QR failed: ${error.message}`);
  }
}

function setCreateChatError(message = "") {
  if (!createChatError) return;
  createChatError.textContent = String(message || "");
  createChatError.hidden = !message;
}

// Live validity feedback under the Create Chat address field, matching iOS's
// "Valid address" / "Resolved: name.kas" / "Invalid address format" states.
let createChatResolveToken = 0;

function renderCreateChatStatus(html) {
  const statusEl = document.querySelector("[data-create-chat-status]");
  if (!statusEl) return;
  statusEl.innerHTML = html || "";
  statusEl.hidden = !html;
}

function updateCreateChatAddState() {
  if (!createChatAddButton || !contactAddressInput) return;
  const raw = String(contactAddressInput.value || "").trim();
  const token = ++createChatResolveToken;

  if (!raw) {
    renderCreateChatStatus("");
    createChatAddButton.disabled = true;
    createChatResolvedAddress = "";
    renderCreateChatPreview();
    renderCreateChatPicker();
    return;
  }

  if (raw.startsWith("kaspa:") || raw.startsWith("kaspatest:")) {
    let valid = false;
    if (engine.kaspa) {
      try { validateContactAddress(raw); valid = true; } catch { /* invalid */ }
    } else {
      valid = raw.length > 20;
    }
    renderCreateChatStatus(valid
      ? '<span class="create-chat-status-good">✓ Valid address</span>'
      : '<span class="create-chat-status-bad">✕ Invalid address format</span>');
    createChatAddButton.disabled = !valid;
    createChatResolvedAddress = valid ? raw : "";
    renderCreateChatPreview();
    renderCreateChatPicker();
    return;
  }

  if (engine.knsLooksLikeDomain(raw)) {
    // Matches both "name.kas" and a bare "name" — resolution normalizes either
    // form by appending .kas if it's missing (see resolveKnsDomain). Debounced
    // live resolution so Add only enables for a domain that actually exists.
    renderCreateChatStatus('<span class="create-chat-status-muted">Resolving KNS domain…</span>');
    createChatAddButton.disabled = true;
    createChatResolvedAddress = "";
    renderCreateChatPreview();
    renderCreateChatPicker();
    window.setTimeout(async () => {
      if (token !== createChatResolveToken) return;
      try {
        const resolution = await engine.resolveKnsDomain(raw);
        if (token !== createChatResolveToken) return;
        if (resolution?.ownerAddress) {
          renderCreateChatStatus(
            `<span class="create-chat-status-good">✓ Resolved: ${escapeHtml(resolution.domain || raw)}</span>`
            + `<span class="create-chat-status-mono">${escapeHtml(resolution.ownerAddress)}</span>`
          );
          createChatAddButton.disabled = false;
          createChatResolvedAddress = resolution.ownerAddress;
          renderCreateChatPreview();
          renderCreateChatPicker();
        } else {
          renderCreateChatStatus('<span class="create-chat-status-bad">✕ KNS domain not found</span>');
        }
      } catch {
        if (token !== createChatResolveToken) return;
        renderCreateChatStatus('<span class="create-chat-status-bad">✕ KNS domain not found</span>');
      }
    }, 300);
    return;
  }

  renderCreateChatStatus('<span class="create-chat-status-bad">✕ Invalid address format</span>');
  createChatAddButton.disabled = true;
  createChatResolvedAddress = "";
  renderCreateChatPreview();
  renderCreateChatPicker();
}

// ---------------------------------------------------------------------------
// Create Chat: who you are about to add, and who you could pick instead
// ---------------------------------------------------------------------------

// The address the modal will actually use: a KNS domain's resolved owner, or the typed address
// once it validates. Empty until one of those is true, so nothing downstream ever renders a
// half-typed address as though it were a person.
let createChatResolvedAddress = "";
let createChatPickerRows = [];
let createChatPickerLoaded = false;
let createChatPickerLoading = false;
let createChatPickerSearching = false;
let createChatPickerQuery = "";
let createChatPreviewToken = 0;

function createChatEffectiveAddress() {
  return createChatResolvedAddress || "";
}

/// Who you are about to add, as they will appear once added.
///
/// A raw address tells you nothing about whether you typed the right one; a face and a domain do.
/// Only ever shown for an address the app is confident about - a card flickering through wrong
/// faces while you type would be worse than no card at all.
function renderCreateChatPreview() {
  const card = document.querySelector("[data-create-chat-preview]");
  if (!card) return;
  const address = createChatEffectiveAddress();
  if (!address) {
    card.hidden = true;
    card.innerHTML = "";
    return;
  }

  const profile = engine.peekKnsAddressProfile?.(address);
  const info = engine.peekKnsAddressInfo?.(address);
  const domain = info?.explicitPrimaryDomain || profile?.domainName || null;
  const avatarUrl = profile?.profile?.avatarUrl || "";
  const known = (state.contacts || []).find((contact) => contact.address === address);
  // The domain the resolver already found beats waiting on a profile fetch: if you typed one,
  // that IS the name.
  const name = (known && known.nameIsCustom ? known.name : null) || domain;
  const looking = !profile && !info;

  card.hidden = false;
  card.innerHTML = `
    <span class="create-chat-preview-avatar">${avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" />`
      : escapeHtml(initialsFor(name || address))}</span>
    <span class="create-chat-preview-copy">
      <span class="create-chat-preview-name${name ? "" : " muted"}">${escapeHtml(name || (looking ? "Looking up…" : "No KNS domain"))}</span>
      <span class="create-chat-preview-address">${escapeHtml(address)}</span>
    </span>
    ${known ? `<span class="create-chat-preview-tag">Already a chat</span>` : ""}`;

  if (looking) {
    const token = ++createChatPreviewToken;
    Promise.allSettled([
      engine.getKnsAddressProfile?.(address),
      engine.getKnsAddressInfo?.(address),
    ]).then(() => {
      if (token !== createChatPreviewToken) return;
      if (createChatEffectiveAddress() !== address) return;
      renderCreateChatPreview();
    });
  }
}

/// The rows actually shown: everything, or what the search box matches by name or address.
function filteredCreateChatPickerRows() {
  const query = createChatPickerQuery.trim().toLowerCase();
  if (!createChatPickerSearching || !query) return createChatPickerRows;
  return createChatPickerRows.filter((row) =>
    row.name.toLowerCase().includes(query) || row.address.toLowerCase().includes(query));
}

/// Second line of a row: the follow relationship when there is one, since that is the thing you
/// would not otherwise know; the short address for someone you simply have a chat with, where the
/// name above it is already the useful part.
function createChatPickerSubtitle(row) {
  if (row.youFollow && row.followsYou) return "You follow each other";
  if (row.youFollow) return "You follow them";
  if (row.followsYou) return "Follows you";
  return shortAddress(row.address);
}

function renderCreateChatPicker() {
  const section = document.querySelector("[data-create-chat-picker-section]");
  const list = document.querySelector("[data-create-chat-picker-list]");
  const toggle = document.querySelector("[data-create-chat-picker-search-toggle]");
  const search = document.querySelector("[data-create-chat-picker-search]");
  if (!section || !list) return;

  // Nothing to offer and nothing on the way: the section stays out of the way entirely rather
  // than sitting there as an empty heading.
  if (!createChatPickerLoading && createChatPickerRows.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (toggle) toggle.hidden = createChatPickerRows.length === 0;
  if (search) search.hidden = !createChatPickerSearching;

  if (createChatPickerLoading && createChatPickerRows.length === 0) {
    list.innerHTML = `<p class="create-chat-picker-empty">Loading contacts…</p>`;
    return;
  }

  const rows = filteredCreateChatPickerRows();
  if (rows.length === 0) {
    list.innerHTML = `<p class="create-chat-picker-empty">No matches</p>`;
    return;
  }

  const chosen = createChatEffectiveAddress();
  list.innerHTML = rows.map((row) => {
    const avatarUrl = engine.peekKnsAddressProfile?.(row.address)?.profile?.avatarUrl || "";
    return `
      <button type="button" class="create-chat-picker-row${row.address === chosen ? " picked" : ""}" data-create-chat-pick="${escapeHtml(row.address)}">
        <span class="create-chat-picker-avatar">${avatarUrl
          ? `<img src="${escapeHtml(avatarUrl)}" alt="" />`
          : escapeHtml(initialsFor(row.name))}</span>
        <span class="create-chat-picker-copy">
          <span class="create-chat-picker-name">${escapeHtml(row.name)}</span>
          <span class="create-chat-picker-sub">${escapeHtml(createChatPickerSubtitle(row))}</span>
        </span>
        ${row.address === chosen ? `<span class="create-chat-picker-check" aria-hidden="true">✓</span>` : ""}
      </button>`;
  }).join("");
}

function buildCreateChatPickerRows(addresses, { known, youFollow, followsYou }) {
  const mine = engine.address || "";
  return [...addresses]
    .filter((address) => address && address !== mine)
    .map((address) => {
      const contact = (state.contacts || []).find((entry) => entry.address === address);
      return {
        address,
        name: contact ? displayNameForAddress(contact)
          : (engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || shortAddress(address)),
        isContact: known.has(address),
        youFollow: youFollow.has(address),
        followsYou: followsYou.has(address),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/// Everyone you could plausibly want to message: your existing chats plus both directions of your
/// KaPosts follow graph. A chat you had months ago is buried far down the chat list, so it belongs
/// here next to the people you follow.
///
/// The address book renders first so the list is useful immediately, then the follow lists merge
/// in when the indexer answers - the network is never on the critical path to a usable picker.
async function loadCreateChatPicker() {
  if (createChatPickerLoaded) { renderCreateChatPicker(); return; }
  createChatPickerLoaded = true;
  createChatPickerLoading = true;

  const mine = engine.address || "";
  const known = new Set((state.contacts || []).map((contact) => contact.address).filter((a) => a && a !== mine));
  const youFollow = new Set(kaPostsFollowingAddresses().filter((a) => a && a !== mine));
  const followsYou = new Set();

  createChatPickerRows = buildCreateChatPickerRows(new Set([...known, ...youFollow]), { known, youFollow, followsYou });
  renderCreateChatPicker();

  try {
    const pubkey = requesterPubkeyFor(engine);
    if (pubkey) {
      for (const wantFollowers of [false, true]) {
        const raw = await fetchFollowList({ engine, pubkey, followers: wantFollowers, limit: 500 });
        for (const item of raw || []) {
          const rowPubkey = item?.userPublicKey || item?.publicKey || item?.pubkey
            || item?.followedPubkey || item?.followerPubkey || item?.user || "";
          const address = item?.address || kaspaAddressFromPubkey(engine, rowPubkey) || "";
          if (!address || address === mine) continue;
          (wantFollowers ? followsYou : youFollow).add(address);
        }
      }
    }
  } catch {
    // An unreachable indexer costs the follow rows, not the picker: the address book already
    // rendered, and there is nothing useful to say about a list nobody asked for out loud.
  }

  const all = new Set([...known, ...youFollow, ...followsYou]);
  createChatPickerRows = buildCreateChatPickerRows(all, { known, youFollow, followsYou });
  createChatPickerLoading = false;
  renderCreateChatPicker();

  if (all.size === 0) return;
  // Names and avatars land after the rows do; repaint once they have, so the list ends up sorted
  // and labelled by domain rather than by truncated address.
  try {
    await engine.refreshKnsIfNeeded?.([...all]);
    if (!contactModal || contactModal.hidden) return;
    createChatPickerRows = buildCreateChatPickerRows(all, { known, youFollow, followsYou });
    renderCreateChatPicker();
  } catch { /* cached names are fine */ }
}

function resetCreateChatPicker() {
  createChatPickerLoaded = false;
  createChatPickerLoading = false;
  createChatPickerRows = [];
  createChatPickerSearching = false;
  createChatPickerQuery = "";
  createChatResolvedAddress = "";
  const query = document.querySelector("[data-create-chat-picker-query]");
  if (query) query.value = "";
}

function setContactAddressValue(value) {
  if (!contactAddressInput) return;
  contactAddressInput.value = String(value || "").trim();
  setCreateChatError("");
  updateCreateChatAddState();
  contactAddressInput.focus();
}

function showContactModal() {
  contactModal.hidden = false;
  setCreateChatError("");
  resetCreateChatPicker();
  updateCreateChatAddState();
  loadCreateChatPicker();
  window.setTimeout(() => contactAddressInput?.focus(), 0);
}

function closeContactModal() {
  contactModal.hidden = true;
  contactForm.reset();
  setCreateChatError("");
  resetCreateChatPicker();
  updateCreateChatAddState();
}

function showImportPayloadModal() {
  if (!activeConversationId || !importPayloadModal) return;
  importPayloadModal.hidden = false;
  window.setTimeout(() => importPayloadInput?.focus(), 0);
}

function closeImportPayloadModal() {
  if (!importPayloadModal) return;
  importPayloadModal.hidden = true;
  importPayloadForm?.reset();
}

function importPayloadIntoConversation(payloadValue) {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;

  const payloadHex = normalizeImportedPayload(payloadValue);
  const parsed = engine.parseKasiaPayloadHex(payloadHex);
  if (!parsed) throw new Error("Payload did not match the Kasia preview format.");

  const createdAt = Date.now();
  const bodyText = parsed.bodyText || "Imported Kasia payload";
  const txid = `manual-import-${String(payloadHex).slice(-8)}`;
  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "incoming",
    text: bodyText,
    sender: contact.address,
    receiver: engine.address || null,
    status: MESSAGE_STATUSES.CONFIRMED,
    transport: "manual-import",
    createdAt,
  });

  applyMessagePatch(message, {
    txid,
    daaScore: String(Math.floor(createdAt / 1000)),
    confirmations: 1,
    network: "mainnet",
    payloadHex,
    payloadBytes: Math.ceil(payloadHex.length / 2),
    messageType: parsed.type || "comm",
    protocol: parsed.protocol || "kasia",
    protocolVersion: parsed.version || 1,
    checksum: parsed.checksum || null,
    protocolString: parsed.protocolString || String(payloadValue || "").trim(),
  });

  appendIncomingOrReactionMessage(conversationEntry, message);
  conversationEntry.sync = {
    ...(conversationEntry.sync || {}),
    lastSyncAt: Date.now(),
    lastFound: 1,
    runs: Number(conversationEntry.sync?.runs || 0) + 1,
    cursor: Number(conversationEntry.sync?.cursor || 0),
    lastNote: "Manual Kasia payload import decoded.",
  };

  persistState();
  renderMessages(conversationEntry);
  if (syncStatus) syncStatus.textContent = syncLabel(conversationEntry);
  setStatus("Kasia payload imported");
}

function updateChatsListTabBadges() {
  const totalUnread = state.conversations.reduce((sum, entry) => sum + Number(entry.unreadCount || 0), 0);
  if (chatsTabBadge) {
    chatsTabBadge.textContent = totalUnread > 99 ? "99+" : String(totalUnread);
    chatsTabBadge.hidden = totalUnread <= 0;
  }
  // Group Chats badge reflects unread decoded group messages (see the group module).
  if (groupsTabBadge) {
    const groupUnread = typeof totalGroupUnread === "function" ? totalGroupUnread() : 0;
    groupsTabBadge.textContent = groupUnread > 99 ? "99+" : String(groupUnread);
    groupsTabBadge.hidden = groupUnread <= 0;
  }
}

// The conversations currently shown in the chat list, honoring the active tab and
// the search filter. Shared by renderChats and the Select All action so both agree.
function visibleChatConversations() {
  if (activeChatsListTab === "groups") return [];
  const query = searchInput.value.trim().toLowerCase();
  return sortedConversations().filter((conversationEntry) => {
    const contact = contactForConversation(conversationEntry);
    if (!contact) return false;
    const preview = conversationPreview(conversationEntry);
    return (
      contact.name.toLowerCase().includes(query) ||
      contact.address.toLowerCase().includes(query) ||
      preview.toLowerCase().includes(query)
    );
  });
}

function renderChats() {
  // Keep one stable in-memory state object during the session. Browser storage is
  // for startup/recovery only; reloading it here used to replace live conversation
  // references and make message history disappear until another mutation rerendered it.
  if (!isWideLayout) setActiveConversationId(null);
  updateChatsListTabBadges();

  if (activeChatsListTab === "groups") {
    if (emptyState) emptyState.hidden = true;
    chatList.hidden = true;
    chatList.innerHTML = "";
    setChatToolRowsForGroupsTab(true);
    renderGroupList();
    return;
  }
  if (groupChatsPlaceholder) groupChatsPlaceholder.hidden = true;
  setChatToolRowsForGroupsTab(false);

  const visibleConversations = visibleChatConversations();

  if (state.conversations.length === 0) {
    emptyState.hidden = false;
    chatList.hidden = true;
    chatList.innerHTML = "";
    return;
  }

  emptyState.hidden = true;
  chatList.hidden = false;

  if (visibleConversations.length === 0) {
    chatList.innerHTML = `
      <div class="no-results-card">
        <strong>No matching chats</strong>
        <span>Try a different name, address, or message.</span>
      </div>
    `;
    return;
  }

  chatList.innerHTML = visibleConversations
    .map((conversationEntry) => {
      const contact = contactForConversation(conversationEntry);
      const last = lastMessageFor(conversationEntry);
      const preview = conversationPreview(conversationEntry);
      const time = last ? formatTime(last.createdAt) : formatTime(conversationEntry.createdAt);
      const selected = selectedChatConversationIds.has(conversationEntry.id);
      return `
        <button class="chat-row${chatSelectionModeActive ? " selecting" : ""}${selected ? " selected" : ""}${conversationEntry.id === activeConversationId ? " active" : ""}" type="button" data-conversation-id="${escapeHtml(conversationEntry.id)}">
          ${chatSelectionModeActive ? `<span class="chat-row-select" aria-hidden="true"><span class="chat-row-checkbox${selected ? " checked" : ""}"></span></span>` : ``}
          <span class="chat-row-time">${escapeHtml(time)}</span>
          ${avatarHtmlFor(contact)}
          <span class="chat-meta">
            <strong>${escapeHtml(displayNameForAddress(contact))}</strong>
            <span>${escapeHtml(preview)}</span>
          </span>
          ${conversationEntry.unreadCount > 0 ? `<b class="unread-badge">${conversationEntry.unreadCount > 99 ? "99+" : conversationEntry.unreadCount}</b>` : ``}
        </button>
      `;
    })
    .join("");

  refreshVisibleKnsNames(visibleConversations);
}

// Background KNS refresh for the chat list: peek-rendered synchronously above
// (possibly stale/absent), then quietly re-fetch and re-render once real data
// lands. refreshKnsIfNeeded's own debounce/backoff keeps this cheap even
// though renderChats() runs often.
let knsChatListRefreshInFlight = false;
async function refreshVisibleKnsNames(visibleConversations) {
  if (knsChatListRefreshInFlight || !engine.address) return;
  const contacts = visibleConversations
    .map((entry) => contactForConversation(entry))
    .filter((contact) => contact?.address);
  if (!contacts.length) return;
  knsChatListRefreshInFlight = true;
  try {
    const attempted = await engine.refreshKnsIfNeeded(contacts.map((contact) => contact.address));
    let changed = false;
    for (const contact of contacts) {
      if (applyKnsPrimaryDomainToContact(contact)) changed = true;
    }
    if (changed) persistState();
    if (attempted > 0 || changed) {
      renderChats();
      if (activeConversationId) {
        const activeEntry = state.conversations.find((entry) => entry.id === activeConversationId);
        const activeContact = activeEntry ? contactForConversation(activeEntry) : null;
        if (activeContact) {
          conversationName.textContent = displayNameForAddress(activeContact);
          updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, activeContact);
          updateConversationBio(activeContact);
          renderMessages(activeEntry);
        }
      }
    }
  } catch {
    // best-effort background refresh; failures just leave the peeked cache as-is
  } finally {
    knsChatListRefreshInFlight = false;
  }
}

function createDeliveryStatusIcon(message) {
  if (message.direction !== "outgoing") return null;

  const status = String(message.status || MESSAGE_STATUSES.PENDING);
  const icon = document.createElement("span");
  icon.className = "message-delivery-icon";

  if (status === MESSAGE_STATUSES.FAILED) {
    icon.classList.add("failed");
    icon.setAttribute("aria-label", "Message not delivered");
    icon.title = "Not delivered";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6.8v7.1"/><circle class="status-dot-mark" cx="12" cy="17.3" r="1.15"/></svg>';
    return icon;
  }

  if (status === MESSAGE_STATUSES.CONFIRMED) {
    icon.classList.add("confirmed");
    icon.setAttribute("aria-label", "Message delivered");
    icon.title = "Delivered";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="status-fill" cx="12" cy="12" r="10"/><path class="status-check" d="m7.4 12.3 3 3.1 6.4-7"/></svg>';
    return icon;
  }

  icon.classList.add("pending");
  icon.setAttribute("aria-label", "Message pending");
  icon.title = "Pending";
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="M12 6.8v5.6l3.7 2.1"/></svg>';
  return icon;
}

function renderMessages(conversationEntry) {
  hydrateConversationMessages(conversationEntry);
  // Cross-device placeholders never render: they carry no readable content (an outgoing tx
  // from another device whose text never synced into an archive this device has seen).
  const messages = (conversationEntry.messages || [])
    .filter((m) => m?.text !== "📤 Sent via another device")
    // Invisible control envelopes (reactions, fresh-address pool markers) are applied at ingest,
    // never shown as bubbles. Filter them at render too, so any that slipped into storage before
    // interception existed — or via a history restore that didn't intercept — don't leak as raw JSON.
    .filter((m) => !parseReactionEnvelope(m?.text) && !parsePaymentPoolEnvelope(m?.text));
  // The thread re-renders constantly (sync polls, link previews resolving,
  // reactions). Capture the scroll state BEFORE the rebuild so a user reading
  // older history isn't yanked back to the bottom by every background render:
  // stick-to-bottom only when they were already near it, or on a chat switch.
  const isThreadSwitch = messageArea.dataset.renderedConversationId !== String(conversationEntry.id);
  const wasNearBottom = messageArea.scrollHeight - messageArea.scrollTop - messageArea.clientHeight < 120;
  const previousScrollTop = messageArea.scrollTop;
  messageArea.innerHTML = "";

  const requestContact = contactForConversation(conversationEntry);
  // Every path that changes the relationship (incoming sync, accept/decline, our
  // own send) re-renders the thread, so this is where the handshake warning
  // learns that the relationship just became mutual — it hides mid-conversation
  // the moment a reciprocal message lands, with no reload.
  if (conversationEntry.id === activeConversationId) updateHandshakeWarningBanner();
  if (requestContact?.relationshipState === "incoming-request") {
    const card = document.createElement("section");
    card.className = "handshake-request-card";
    card.innerHTML = `
      <strong>Communication request</strong>
      <span>${escapeHtml(requestContact.name || shortAddress(requestContact.address))} wants to start an encrypted KaChat conversation.</span>
      <div class="handshake-request-actions">
        <button type="button" class="secondary-button" data-decline-handshake>Decline</button>
        <button type="button" class="primary-button" data-accept-handshake>Accept</button>
      </div>`;
    messageArea.appendChild(card);
  }

  if (messages.length === 0) {
    messageArea.appendChild(messageEmpty);
    messageEmpty.hidden = false;
    return;
  }

  messageEmpty.hidden = true;

  // Latest chess timestamp per game, computed ONCE per render — the per-message version
  // re-scanned and re-parsed the whole conversation for every chess bubble (O(n²)).
  const latestChessByGame = new Map();
  for (const m of messages) {
    const env = Chess.parseChessEnvelope(Chess.unwrapReplyText(m.text));
    if (env) {
      const at = m.createdAt || 0;
      if (at > (latestChessByGame.get(env.gameId) ?? -1)) latestChessByGame.set(env.gameId, at);
    }
  }

  let lastDayKey = "";
  messages.forEach((message, index) => {
    // "Today"/"Yesterday"/date pill whenever the calendar day changes (iOS parity).
    const dayKey = new Date(Number(message.createdAt) || Date.now()).toDateString();
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      messageArea.appendChild(buildDaySeparatorElement(message.createdAt));
    }

    const row = document.createElement("div");
    row.className = `message-row ${message.direction === "incoming" ? "incoming" : "local"}`;

    const selector = document.createElement("span");
    selector.className = "message-selector";
    selector.setAttribute("aria-hidden", "true");
    selector.innerHTML = '<svg viewBox="0 0 20 20"><path d="m5.1 10.1 3.1 3.1 6.7-7"/></svg>';

    // Incoming messages match iMessage's grouping: an avatar sits next to
    // the last bubble of a consecutive run, not every single one. Your own
    // messages always get one, on every message, per request.
    const avatarSlot = document.createElement("span");
    avatarSlot.className = "message-avatar-slot";
    if (message.direction === "incoming") {
      const nextMessage = messages[index + 1];
      const isLastInGroup = !nextMessage || nextMessage.direction !== message.direction;
      if (isLastInGroup && requestContact) avatarSlot.innerHTML = avatarHtmlFor(requestContact, "message-avatar");
    } else {
      avatarSlot.innerHTML = selfAvatarHtml("message-avatar");
    }

    const bubble = document.createElement("div");
    bubble.className = `message-bubble ${message.direction === "incoming" ? "incoming" : "local"}`;
    bubble.dataset.messageId = message.id;
    // Set when a caption+link message builds a preview card: rendered below the bubble.
    let detachedLinkCard = null;

    // Broadcast-room style card header: sender name + send time at the top of every
    // bubble. Photo-only and link-only bubbles hide it via CSS and keep their overlay
    // timestamp instead.
    {
      const cardHead = document.createElement("div");
      cardHead.className = "message-card-head";
      const cardSender = document.createElement("strong");
      cardSender.textContent = message.direction === "incoming"
        ? (displayNameForAddress(requestContact) || shortAddress(requestContact?.address || ""))
        : "You";
      cardHead.append(cardSender);
      if (message.createdAt) {
        const cardTime = document.createElement("span");
        cardTime.textContent = formatTime(message.createdAt);
        cardHead.append(cardTime);
      }
      bubble.append(cardHead);
    }
    bubble.title = messageSelectionMode ? "Select message" : "Open message actions";
    bubble.tabIndex = 0;
    bubble.setAttribute("role", messageSelectionMode ? "checkbox" : "button");
    bubble.setAttribute("aria-checked", selectedMessageIds.has(message.id) ? "true" : "false");
    if (messageSelectionMode) bubble.classList.add("selectable");
    if (selectedMessageIds.has(message.id)) {
      bubble.classList.add("selected");
      row.classList.add("selected");
    }

    const chessEnv = Chess.parseChessEnvelope(Chess.unwrapReplyText(message.text));
    if (chessEnv) {
      // The latest chess message of a game renders as a live board thumbnail with
      // status (so on your turn you see the position); earlier ones stay compact.
      const isLatestChess = (message.createdAt || 0) >= (latestChessByGame.get(chessEnv.gameId) ?? 0);
      const contactAddr = requestContact?.address;
      const summary = (isLatestChess && contactAddr && engine.address)
        ? Chess.summarizeChessGame(chessEnv.gameId, (conversationEntry.messages || []).map((m) => ({ text: m.text, outgoing: m.direction === "outgoing", txid: m.txid || m.id, at: m.createdAt || 0 })), engine.address, contactAddr)
        : null;
      if (summary) {
        bubble.append(buildChessThumb(summary, chessEnv.gameId));
      } else {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "message-chess";
        const icon = document.createElement("span");
        icon.className = "message-chess-icon";
        icon.textContent = "♟";
        const label = document.createElement("span");
        label.className = "message-chess-label";
        label.textContent = Chess.chessEnvelopeLabel(message.text) || "Chess";
        card.append(icon, label);
        card.addEventListener("click", (event) => { event.stopPropagation(); openChessGame(chessEnv.gameId); });
        bubble.append(card);
      }
    } else {
    // Payments render as an Apple-Pay-style card (matches iOS's paymentCardBubble):
    // Kaspa logo in a circle — solid white on the sent/teal side for contrast —
    // bold amount, a Sent/Received line, optional note. Unparseable/legacy payment
    // content falls through to the classic text rendering below. Covers both
    // detected payments and pool payment_notice bubbles (same text template).
    const paymentParts = parsePaymentCardParts(message);
    if (paymentParts) {
      bubble.classList.add("has-payment-card");
      bubble.append(buildPaymentCard(paymentParts, message.direction !== "incoming"));
    } else {
    const imageEnvelope = parseImageEnvelope(message.text);
    const audioEnvelope = imageEnvelope ? null : parseAudioEnvelope(message.text);
    const replyEnvelope = (imageEnvelope || audioEnvelope) ? null : parseReplyEnvelope(message.text);
    if (replyEnvelope) {
      const quote = document.createElement("div");
      quote.className = "message-reply-quote";
      const label = document.createElement("strong");
      label.textContent = "Reply";
      const preview = document.createElement("span");
      preview.textContent = replyEnvelope.replyToPreview || "Message";
      quote.append(label, preview);
      quote.addEventListener("click", (event) => {
        event.stopPropagation();
        jumpToMessageByTxid(replyEnvelope.replyToId);
      });
      bubble.append(quote);
    }

    if (imageEnvelope) {
      const heldBackPhoto = message.direction === "incoming"
        && !shouldAutoDisplayPhotosFrom(requestContact, conversationEntry)
        && !revealedPhotoIds.has(message.id);
      if (heldBackPhoto) {
        const reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "message-photo-hidden";
        reveal.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m5 17 4.5-4.5 3.2 3.2 2.3-2.3L19 17"/></svg><span>Tap to view photo</span>';
        reveal.addEventListener("click", (event) => { event.stopPropagation(); revealedPhotoIds.add(message.id); renderMessages(conversationEntry); });
        bubble.append(reveal);
      } else {
        // Photo-only bubble: no chat-bubble background, just the image (timestamp overlays it).
        bubble.classList.add("photo-bubble");
        const img = document.createElement("img");
        img.className = "message-photo";
        img.src = imageEnvelope.content;
        img.alt = imageEnvelope.name || "Photo";
        img.addEventListener("click", () => openPhotoPreview(imageEnvelope.content));
        bubble.append(img);
      }
    } else if (audioEnvelope) {
      const audioWrap = document.createElement("div");
      audioWrap.className = "message-audio-bubble";
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "metadata";
      player.src = audioEnvelope.content;
      player.addEventListener("click", (event) => event.stopPropagation());
      audioWrap.append(player);
      bubble.append(audioWrap);
    } else {
      const text = document.createElement("span");
      text.className = "message-text";
      const bodyText = replyEnvelope ? replyEnvelope.text : message.text;
      const linkUrls = renderTextWithMentions(text, bodyText);
      const previewable = linkUrls.find(isPreviewableUrl);
      const card = previewable ? buildLinkPreviewCard(previewable) : null;
      // A link-only message renders as just the preview card (no chat bubble, timestamp below),
      // matching iOS. With a caption or other text, show the text bubble + card beneath it.
      const linkOnly = card && !replyEnvelope && linkUrls.length === 1 && String(bodyText).trim() === linkUrls[0];
      if (linkOnly) {
        bubble.classList.add("link-card-bubble");
        bubble.append(card);
      } else {
        bubble.append(text);
        // iOS parity: with a caption the card is its OWN block BELOW the bubble,
        // not inside it — stashed here and stacked at row-append time.
        if (card) detachedLinkCard = card;
      }
    }
    }
    }
    // Reactions and all message actions live on the right-click menu now (Telegram-style),
    // wired below via the bubble's "contextmenu" handler.

    const reactions = conversationEntry.reactionsByTxId?.[message.txid || message.id] || [];
    if (reactions.length) {
      const pill = document.createElement("div");
      pill.className = "message-reaction-pill";
      const counts = new Map();
      for (const entry of reactions) counts.set(entry.emoji, (counts.get(entry.emoji) || 0) + 1);
      for (const [emoji, count] of counts) {
        const entryEl = document.createElement("span");
        entryEl.className = "message-reaction-pill-entry";
        entryEl.textContent = emoji;
        if (count > 1) {
          const countEl = document.createElement("span");
          countEl.className = "message-reaction-pill-count";
          countEl.textContent = String(count);
          entryEl.append(countEl);
        }
        // Delivery indicator on YOUR just-sent reaction: ✓ once on-chain, red ! to retry.
        const statusEl = reactionStatusIndicator(`dm|${message.txid || message.id}|${emoji}`);
        if (statusEl) entryEl.append(statusEl);
        pill.append(entryEl);
      }
      pill.addEventListener("click", (event) => event.stopPropagation());
      bubble.append(pill);
    }

    // 12-hour send time in the corner of every bubble.
    if (message.createdAt) {
      const timeEl = document.createElement("span");
      timeEl.className = "message-time";
      timeEl.textContent = formatTime(message.createdAt);
      bubble.append(timeEl);
    }

    // Right-click opens the Telegram-style actions menu (reactions + reply/copy/select/etc.).
    bubble.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (messageSelectionMode) return;
      openOneToOneMessageMenu(message.id, event.clientX, event.clientY);
    });

    const deliveryIcon = createDeliveryStatusIcon(message);
    if (detachedLinkCard) {
      const stack = document.createElement("div");
      stack.className = "message-bubble-stack";
      stack.append(bubble, detachedLinkCard);
      row.append(selector, avatarSlot, stack);
    } else {
      row.append(selector, avatarSlot, bubble);
    }
    if (deliveryIcon) row.append(deliveryIcon);
    if (message.direction === "outgoing" && message.status === MESSAGE_STATUSES.FAILED) {
      const retryLink = document.createElement("button");
      retryLink.type = "button";
      retryLink.className = "message-retry-link";
      retryLink.textContent = "Not Delivered · Retry";
      retryLink.addEventListener("click", (event) => {
        event.stopPropagation();
        runEngineSendPipeline(conversationEntry.id, message.id);
      });
      row.append(retryLink);
    }
    messageArea.appendChild(row);
  });

  messageArea.dataset.renderedConversationId = String(conversationEntry.id);
  // Sending your own message always snaps down, even from deep in history.
  const lastMessage = messages[messages.length - 1];
  // "Sent from THIS device just now", not "recent": an optimistic local send is the only row
  // that is outgoing, still PENDING and has no txid yet. The old 2.5s window also matched an
  // own message mirrored in from another device (it arrives with a real txid and a recent
  // createdAt), which yanked the viewport away from someone reading history. Matches iOS,
  // which keys on its provisional pending_ txId for the same reason.
  // No txid yet is the discriminator: a local send has none until it reaches the chain
  // (it passes through draft/building/signing/broadcasting/pending on the way), while a
  // message mirrored in from another device always arrives carrying its real txid.
  const justSentOwn = Boolean(lastMessage)
    && lastMessage.direction !== "incoming"
    && lastMessage.status !== MESSAGE_STATUSES.CONFIRMED
    && !String(lastMessage.txid || "").trim();
  if (isThreadSwitch || wasNearBottom || justSentOwn) {
    messageArea.scrollTop = messageArea.scrollHeight;
  } else {
    // Content above the viewport is unchanged (sync only appends at the end),
    // so restoring the old offset keeps the reader exactly where they were.
    messageArea.scrollTop = previousScrollTop;
  }
  // Keep an open chess board in sync with newly-arrived moves/invites/resigns.
  refreshChessOverlay();
}

function openConversation(conversationId) {
  messageSelectionMode = false;
  selectedMessageIds.clear();
  updateSelectionUi();

  // The detail pane may still hold a Settings/Profile scroll offset. Reset it
  // before the thread switches to its own internal message scroller.
  if (appDetail) appDetail.scrollTop = 0;

  // Use the existing canonical in-memory state. Replacing state from localStorage
  // during navigation invalidated live conversation references and caused blank chats.
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) {
    setActiveConversationId(null);
    renderChats();
    return;
  }

  hydrateConversationMessages(conversationEntry);
  conversationEntry.unreadCount = 0;
  // Catches a manually-added contact who's since actually exchanged messages
  // both ways — the no-handshake warning shouldn't keep showing once that's
  // true, even if this is the first time re-opening the conversation since.
  promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist: false });
  persistState();

  // Keep the sidebar list in sync (new/updated conversation row, unread badge)
  // now that it stays visible alongside the open conversation at wide widths.
  renderChats();
  setActiveConversationId(conversationId);
  if (applyKnsPrimaryDomainToContact(contact)) { persistState(); renderChats(); }
  conversationName.textContent = displayNameForAddress(contact);
  updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, contact);
  updateConversationBio(contact);
  if (conversationAddress) conversationAddress.textContent = contact.address;
  if (syncStatus) syncStatus.textContent = syncLabel(conversationEntry);
  renderMessages(conversationEntry);
  activateComposerMode("message");
  window.setTimeout(() => composer.elements.message?.focus(), 0);

  // Fresh-address payment pools: the lazy once-per-contact offer, the pool-of-2
  // replenish re-check (retries a top-up whose send failed when a reservation got
  // funded), and the low-water top-up request. All no-ops unless due.
  offerAddressPoolIfNeeded(contact, conversationEntry);
  replenishPoolIfNeeded(contact.address);
  maybeRequestMorePoolAddresses(contact);

  // The header name above is a synchronous cache-peek and may render before
  // KNS data has ever been fetched for this address — refresh in the
  // background and update it once real data lands, same idea as the chat
  // list's own background refresh.
  if (!engine.peekKnsAddressInfo(contact.address)) {
    engine.fetchKnsAddressInfo(contact.address).then(() => {
      const nameChanged = applyKnsPrimaryDomainToContact(contact);
      if (nameChanged) { persistState(); renderChats(); }
      if (activeConversationId === conversationId) conversationName.textContent = displayNameForAddress(contact);
    }).catch(() => {});
  }
  if (!engine.peekKnsAddressProfile(contact.address)) {
    engine.fetchKnsAddressProfile(contact.address).then(() => {
      if (activeConversationId === conversationId) {
        updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, contact);
        updateConversationBio(contact);
        renderMessages(conversationEntry);
      }
      renderChats();
    }).catch(() => {});
  }
}

// Matches iOS's ChatInfoView: opened from the conversation header (desktop
// binds this to the avatar/name button, where iOS uses a separate info.circle
// toolbar button instead — a deliberate desktop-specific choice). Presented
// as a sheet-style overlay with Cancel/Save, an editable local nickname, the
// contact's own address as a QR + monospaced string, and real Added/Last
// Message/Sent/Received/Total stats computed from this conversation's actual
// messages. Notifications/Photos rows are mockups, matching iOS's pickers
// structurally but with no functioning backend yet (same convention as the
// rest of Settings).
function openChatInfo() {
  if (!activeConversationId) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact || !chatInfoOverlay) return;

  chatInfoContactId = contact.id;
  chatInfoContactAddress = contact.address;
  resetChatInfoAliases();
  refreshChatInfoContactControls();
  if (chatInfoAvatarInitials) chatInfoAvatarInitials.textContent = initialsFor(contact.name);
  if (contact.photo) {
    if (chatInfoAvatarImage) { chatInfoAvatarImage.src = contact.photo; chatInfoAvatarImage.hidden = false; }
    if (chatInfoAvatarInitials) chatInfoAvatarInitials.hidden = true;
  } else {
    if (chatInfoAvatarInitials) chatInfoAvatarInitials.hidden = false;
    if (chatInfoAvatarImage) { chatInfoAvatarImage.hidden = true; chatInfoAvatarImage.src = ""; }
  }
  if (chatInfoRemovePhoto) chatInfoRemovePhoto.hidden = !contact.photo;
  if (chatInfoNameInput) chatInfoNameInput.value = contact.name || "";
  if (chatInfoAddressCaption) chatInfoAddressCaption.textContent = shortAddress(contact.address);
  if (chatInfoAddressMono) chatInfoAddressMono.textContent = contact.address;
  if (chatInfoAdded) chatInfoAdded.textContent = contact.createdAt ? new Date(contact.createdAt).toLocaleDateString() : "—";

  const messages = conversationEntry.messages || [];
  const sent = messages.filter((message) => message.direction === "outgoing").length;
  const received = messages.filter((message) => message.direction === "incoming").length;
  if (chatInfoSent) chatInfoSent.textContent = String(sent);
  if (chatInfoReceived) chatInfoReceived.textContent = String(received);
  if (chatInfoTotal) chatInfoTotal.textContent = String(messages.length);
  const last = lastMessageFor(conversationEntry);
  if (chatInfoLastMessage) chatInfoLastMessage.textContent = last ? formatRelativeTime(last.createdAt) : "—";

  // Chess record — only shown once this contact has actually played (matches iOS).
  if (chatInfoChessRow) {
    const chessMsgs = messages.map((m) => ({ text: m.text, outgoing: m.direction === "outgoing", txid: m.txid || m.id, at: m.createdAt || 0 }));
    const hasChessHistory = engine.address && chessMsgs.some((m) => { const e = Chess.parseChessEnvelope(Chess.unwrapReplyText(m.text)); return e && e.kind === "invite"; });
    if (hasChessHistory) {
      const rec = Chess.chessRecord(chessMsgs, engine.address, contact.address);
      if (chatInfoChess) chatInfoChess.textContent = `${rec.wins}W · ${rec.losses}L`;
      chatInfoChessRow.hidden = false;
    } else {
      chatInfoChessRow.hidden = true;
    }
  }

  if (chatInfoQr) {
    const ctx = chatInfoQr.getContext("2d");
    ctx.clearRect(0, 0, chatInfoQr.width, chatInfoQr.height);
    import("../engine/qr.js").then(({ drawKaspaQr }) => {
      drawKaspaQr(chatInfoQr, contact.address, { dark: "#06110f", light: "#ffffff" }).catch(() => {});
    });
  }

  if (chatInfoProfileSection) chatInfoProfileSection.hidden = true;
  refreshChatInfoKnsSections(contact);

  chatInfoOverlay.hidden = false;
}

// Chat Info always force-refreshes KNS info/profile on open (bypassing the
// passive debounce the chat list uses) so domain selection is anchored to the
// latest primary-domain metadata — matches iOS's ChatInfoView.task.
async function refreshChatInfoKnsSections(contact) {
  const token = ++chatInfoRequestToken;
  const [info, profileInfo] = await Promise.all([
    engine.fetchKnsAddressInfo(contact.address).catch(() => null),
    engine.fetchKnsAddressProfile(contact.address).catch(() => null),
  ]);
  if (token !== chatInfoRequestToken || chatInfoContactId !== contact.id) return;

  const profile = profileInfo?.profile;
  // A user-assigned photo overrides KNS, so never let a late KNS fetch replace it.
  if (chatInfoAvatarImage && chatInfoAvatarInitials && !contact.photo) {
    if (profile?.avatarUrl) {
      chatInfoAvatarImage.src = profile.avatarUrl;
      chatInfoAvatarImage.hidden = false;
      chatInfoAvatarInitials.hidden = true;
    } else {
      chatInfoAvatarImage.hidden = true;
      chatInfoAvatarImage.src = "";
      chatInfoAvatarInitials.hidden = false;
    }
  }
  if (chatInfoProfileSection && profile) {
    const hasDetail = ["bio", "x", "website", "telegram", "discord", "contactEmail", "github", "redirectUrl"]
      .some((key) => Boolean(profile[key]));
    if (hasDetail) {
      if (chatInfoBio) {
        if (profile.bio) { chatInfoBio.textContent = profile.bio; chatInfoBio.hidden = false; }
        else chatInfoBio.hidden = true;
      }
      if (chatInfoSocialLinks) {
        chatInfoSocialLinks.replaceChildren();
        const linkDefs = [
          ["website", "Website", KNSProfileLinkBuilder.websiteUrl],
          ["x", "X", KNSProfileLinkBuilder.xUrl],
          ["telegram", "Telegram", KNSProfileLinkBuilder.telegramUrl],
          ["discord", "Discord", KNSProfileLinkBuilder.discordUrl],
          ["github", "GitHub", KNSProfileLinkBuilder.githubUrl],
          ["contactEmail", "Email", KNSProfileLinkBuilder.emailUrl],
          ["redirectUrl", "Redirect", KNSProfileLinkBuilder.websiteUrl],
        ];
        for (const [field, label, builder] of linkDefs) {
          const raw = profile[field];
          if (!raw) continue;
          const href = builder(raw);
          if (!href) continue;
          const link = document.createElement("a");
          link.className = "chat-info-social-link";
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = label;
          chatInfoSocialLinks.appendChild(link);
        }
      }
      chatInfoProfileSection.hidden = false;
    }
  }
}

function closeChatInfo() {
  if (chatInfoOverlay) chatInfoOverlay.hidden = true;
  chatInfoContactId = null;
}

function saveChatInfo() {
  const contact = state.contacts.find((entry) => entry.id === chatInfoContactId);
  if (contact) {
    const trimmed = String(chatInfoNameInput?.value || "").trim();
    // A non-empty typed value is always a deliberate override; clearing the
    // field back to nothing reverts to auto-naming (KNS primary domain, or
    // the shortened address if none is set).
    contact.nameIsCustom = Boolean(trimmed);
    contact.name = trimmed || shortAddress(contact.address);
    if (!contact.nameIsCustom) applyKnsPrimaryDomainToContact(contact);
    contact.updatedAt = Date.now();
    persistState();
    if (activeConversationId) {
      const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
      if (conversationEntry) {
        updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, contact);
        conversationName.textContent = displayNameForAddress(contact);
      }
    }
    renderChats();
  }
  closeChatInfo();
}

document.querySelector("[data-open-chat-info]")?.addEventListener("click", openChatInfo);
document.querySelector("[data-chat-info-cancel]")?.addEventListener("click", closeChatInfo);
document.querySelector("[data-chat-info-save]")?.addEventListener("click", saveChatInfo);

// Re-render the open chat info avatar + every avatar of this contact across the app.
function refreshContactAvatars(contact) {
  if (chatInfoRemovePhoto) chatInfoRemovePhoto.hidden = !contact.photo;
  if (contact.photo) {
    if (chatInfoAvatarImage) { chatInfoAvatarImage.src = contact.photo; chatInfoAvatarImage.hidden = false; }
    if (chatInfoAvatarInitials) chatInfoAvatarInitials.hidden = true;
  } else {
    if (chatInfoAvatarInitials) chatInfoAvatarInitials.hidden = false;
    if (chatInfoAvatarImage) { chatInfoAvatarImage.hidden = true; chatInfoAvatarImage.src = ""; }
  }
  if (activeConversationId) {
    const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
    if (conversationEntry && conversationEntry.contactId === contact.id) {
      updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, contact);
    }
  }
  renderChats();
}

chatInfoPhotoPick?.addEventListener("click", () => chatInfoPhotoInput?.click());
chatInfoPhotoInput?.addEventListener("change", async () => {
  const file = chatInfoPhotoInput.files?.[0];
  chatInfoPhotoInput.value = "";
  if (!file) return;
  const contact = state.contacts.find((entry) => entry.id === chatInfoContactId);
  if (!contact) return;
  try {
    setStatus("Preparing photo…");
    // A small square thumbnail keeps the backup/state light (avatars don't need the
    // full message-photo budget).
    const compressed = await compressImageBlob(file, { targetBytes: 48 * 1024, maxDimension: 256 });
    contact.photo = compressed.dataUrl;
    contact.updatedAt = Date.now();
    persistState();
    refreshContactAvatars(contact);
    setStatus("Contact photo updated");
  } catch (error) {
    setStatus(`Could not set photo: ${error.message}`);
    showCopyToast(`Could not set photo. ${error.message}`);
  }
});
chatInfoRemovePhoto?.addEventListener("click", () => {
  const contact = state.contacts.find((entry) => entry.id === chatInfoContactId);
  if (!contact || !contact.photo) return;
  contact.photo = "";
  contact.updatedAt = Date.now();
  persistState();
  refreshContactAvatars(contact);
  setStatus("Contact photo removed");
});
chatInfoOverlay?.addEventListener("click", (event) => {
  if (event.target === chatInfoOverlay) closeChatInfo();
});
document.querySelector("[data-chat-info-copy-address]")?.addEventListener("click", async () => {
  const contact = state.contacts.find((entry) => entry.id === chatInfoContactId);
  if (!contact) return;
  try {
    await copyTextToClipboard(contact.address);
    showCopyToast(addressCopiedToastText(contact.address));
  } catch (error) {
    showCopyToast("Copy failed");
  }
});

function addContact({ name, address, relationshipState = "legacy-manual" }) {
  const createdAt = Date.now();
  const contact = {
    id: nowId(),
    name: name.trim(),
    nameIsCustom: Boolean(name.trim()),
    address: address.trim(),
    avatar: initialsFor(name.trim()),
    createdAt,
    updatedAt: createdAt,
    relationshipState,
    handshakeTxid: "",
  };
  const conversationEntry = createConversation({ contactId: contact.id, createdAt });

  state.contacts.push(contact);
  state.conversations.push(conversationEntry);
  refreshSubscriptionAddresses({ restart: true });
  persistState();
  renderChats();
  openConversation(conversationEntry.id);
}

// Batch import of {address, name} pairs pulled from a Nextcloud address book (see
// nextcloud.js syncContactsFromNextcloud). Adds a contact + conversation for each new,
// valid Kaspa address without opening any of them; fills in a name for an existing contact
// that has none. One persist/render at the end. Returns a per-outcome tally.
function importNextcloudContacts(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of list) {
    const address = String(raw?.address || "").trim();
    const name = String(raw?.name || "").trim();
    if (!isValidKaspaAddressString(address)) { skipped += 1; continue; }
    const existing = state.contacts.find((entry) => entry.address === address);
    if (existing) {
      if (name && !existing.nameIsCustom) {
        existing.name = name;
        existing.nameIsCustom = true;
        existing.avatar = initialsFor(name);
        existing.updatedAt = Date.now();
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    const createdAt = Date.now();
    const contact = {
      id: nowId(),
      name,
      nameIsCustom: Boolean(name),
      address,
      avatar: initialsFor(name),
      createdAt,
      updatedAt: createdAt,
      relationshipState: "legacy-manual",
      handshakeTxid: "",
    };
    const conversationEntry = createConversation({ contactId: contact.id, createdAt });
    state.contacts.push(contact);
    state.conversations.push(conversationEntry);
    added += 1;
  }
  if (added || updated) {
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    renderChats();
  }
  return { added, updated, skipped };
}

// Open (or create) the 1:1 chat with an arbitrary Kaspa address and drop the composer straight
// into KAS-send mode. Powers the KaPosts "Tip" button — tip a poster without leaving for the
// wallet screen. No-op with a toast if the address is missing/invalid or is your own.
async function openChatWithAddressForKaspa({ address, name } = {}) {
  const clean = String(address || "").trim();
  if (!clean || !isValidKaspaAddressString(clean)) { showCopyToast("This poster has no valid Kaspa address."); return; }
  if (clean === engine.address) { showCopyToast("That's your own address."); return; }
  let contact = state.contacts.find((entry) => entry.address === clean);
  if (!contact) {
    const createdAt = Date.now();
    const displayName = String(name || "").trim();
    contact = {
      id: nowId(), name: displayName, nameIsCustom: Boolean(displayName), address: clean,
      avatar: initialsFor(displayName || clean), createdAt, updatedAt: createdAt,
      relationshipState: "legacy-manual", handshakeTxid: "",
    };
    state.contacts.push(contact);
  }
  let conversationEntry = state.conversations.find((entry) => entry.contactId === contact.id);
  if (!conversationEntry) {
    conversationEntry = createConversation({ contactId: contact.id, createdAt: Date.now() });
    state.conversations.push(conversationEntry);
    refreshSubscriptionAddresses({ restart: true });
  }
  persistState();
  renderChats();
  setActiveAppTab("chats");
  openConversation(conversationEntry.id);
  await activateComposerMode("kas");
}

// --- KaPosts quick tip modal ------------------------------------------------
// Send-Kaspa-style tip, matching iOS's KaPostTipSheet: fixed recipient + pool-destination
// indicator, amount with Max + the FUNDING SOURCE's real balance (primary spending address
// when Payment Privacy is on, chatting address when off), Normal/Fast/Priority fee tiers.
// The send routes through the exact chat-payment rules (consumePoolPaymentDestination +
// privacy-gated funding) and drops the payment bubble into the 1:1 conversation.
const TIP_FEE_MULTIPLIERS = { normal: 1, fast: 2, priority: 5 };
const tipModal = document.querySelector("[data-tip-modal]");
let tipState = null;
let tipFeeEstimateToken = 0;

function tipQ(selector) { return tipModal ? tipModal.querySelector(selector) : null; }

function tipSetError(message) {
  const el = tipQ("[data-tip-error]");
  if (!el) return;
  if (message) { el.textContent = message; el.hidden = false; }
  else { el.textContent = ""; el.hidden = true; }
}

function tipTotalFeeKas() {
  if (!tipState?.policyFeeKas) return null;
  return trimKas8(Number(tipState.policyFeeKas) * (TIP_FEE_MULTIPLIERS[tipState.tier] || 1));
}

// The priority tip handed to engine.send/sendFromSpending: displayed total minus the SDK's own
// base fee (same model as the Send Kaspa modal's sendKaspaGetFeeKas).
function tipExtraFeeKas() {
  const total = Number(tipTotalFeeKas() || 0);
  const sdkBase = Number(tipState?.sdkFeeKas || 0);
  return total > sdkBase ? trimKas8(total - sdkBase) : "0";
}

function tipRenderFee() {
  const el = tipQ("[data-tip-fee]");
  if (!el) return;
  const total = tipTotalFeeKas();
  el.textContent = total ? `Network fee: ${total} KAS` : "Network fee: --";
}

function tipUpdateSendEnabled() {
  const send = tipQ("[data-tip-send]");
  if (!send) return;
  const amount = Number(tipQ("[data-tip-amount]")?.value || 0);
  send.disabled = !tipState || tipState.sending || !(amount > 0);
}

async function tipEstimateFee() {
  const state = tipState;
  if (!state) return;
  const amountKas = Number(tipQ("[data-tip-amount]")?.value || 0);
  if (!(amountKas > 0)) { state.policyFeeKas = null; state.sdkFeeKas = null; tipRenderFee(); return; }
  const token = ++tipFeeEstimateToken;
  try {
    const detail = state.fundingAddress
      ? await engine.estimateSendFeeForAddress(state.fundingAddress, String(amountKas))
      : await engine.estimateSendFee(String(amountKas));
    if (token !== tipFeeEstimateToken || tipState !== state) return;
    state.policyFeeKas = detail.policyFeeKas;
    state.sdkFeeKas = detail.sdkFeeKas;
  } catch {
    if (token !== tipFeeEstimateToken || tipState !== state) return;
    state.policyFeeKas = null;
    state.sdkFeeKas = null;
  }
  tipRenderFee();
}

async function openTipModal({ address, name } = {}) {
  const clean = String(address || "").trim();
  if (!clean || !isValidKaspaAddressString(clean)) { showCopyToast("This poster has no valid Kaspa address."); return; }
  if (clean === engine.address) { showCopyToast("That's your own address."); return; }
  if (!tipModal) return;

  // Look up an existing contact/conversation but deliberately create NOTHING yet:
  // opening the tip sheet and cancelling must leave no trace in the Chats list.
  // The contact + conversation are created in sendTipNow, on an actual send.
  const displayName = String(name || "").trim();
  const contact = state.contacts.find((entry) => entry.address === clean) || null;
  const conversationEntry = contact
    ? (state.conversations.find((entry) => entry.contactId === contact.id) || null)
    : null;

  const privacyOn = chatsPrivacyEnabled();
  const fundingIndex = getActiveSpendingIndex();
  const fundingAddress = privacyOn && activeAccountMnemonic() ? deriveSpendingAddressAt(fundingIndex) : null;
  tipState = {
    contact, conversationEntry, address: clean, displayName, fundingIndex, fundingAddress,
    spendingFunded: Boolean(fundingAddress),
    availableKas: null, policyFeeKas: null, sdkFeeKas: null,
    tier: "normal", sending: false,
  };

  const shownName = (contact?.name || displayName).trim() || shortAddress(clean);
  const nameEl = tipQ("[data-tip-name]");
  if (nameEl) nameEl.textContent = shownName;
  const addressEl = tipQ("[data-tip-address]");
  if (addressEl) addressEl.textContent = shortAddress(clean);
  const titleEl = tipQ("[data-tip-title]");
  if (titleEl) titleEl.textContent = `Tip ${shownName}`;
  // Which privacy scenario this tip will hit (same signal as the chat composer).
  const destEl = tipQ("[data-tip-destination]");
  if (destEl) {
    const viaPool = willPayViaFreshPoolAddress(clean);
    destEl.textContent = viaPool
      ? "Goes to a fresh private address they shared"
      : "Goes to their public chatting address";
    destEl.classList.toggle("tip-dest-private", viaPool);
  }
  const amountEl = tipQ("[data-tip-amount]");
  if (amountEl) amountEl.value = "";
  tipSetError("");
  tipModal.querySelectorAll("[data-tip-fee-tier]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tipFeeTier === "normal");
  });
  tipRenderFee();
  tipUpdateSendEnabled();
  const availableEl = tipQ("[data-tip-available]");
  if (availableEl) availableEl.textContent = "Available: …";
  const sendBtn = tipQ("[data-tip-send]");
  if (sendBtn) sendBtn.textContent = "Send Tip";
  tipModal.hidden = false;

  try {
    await ensureRuntimes({ quiet: true });
    const balance = fundingAddress ? await engine.balanceForAddress(fundingAddress) : await engine.balance();
    if (tipState?.address !== clean) return; // modal switched targets meanwhile
    tipState.availableKas = Number(balance.totalKas);
    if (availableEl) {
      availableEl.textContent = `Available: ${balance.totalKas} KAS from your ${tipState.spendingFunded ? "primary spending address" : "chatting address"}`;
    }
  } catch {
    if (availableEl) availableEl.textContent = "Available: unavailable";
  }
}

function closeTipModal() {
  if (tipModal) tipModal.hidden = true;
  tipState = null;
}

async function sendTipNow() {
  const tip = tipState;
  if (!tip || tip.sending) return;
  const amountKas = trimKas8(Number(tipQ("[data-tip-amount]")?.value || 0));
  if (!(Number(amountKas) > 0)) { tipSetError("Enter an amount."); return; }
  if (tip.availableKas != null && Number(amountKas) > tip.availableKas) {
    tipSetError("Amount exceeds the available balance.");
    return;
  }
  tip.sending = true;
  tipSetError("");
  const sendBtn = tipQ("[data-tip-send]");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "Sending…"; }

  // The chat with the poster is created HERE, on an actual send — not when the
  // modal opened — so a cancelled tip never leaves an orphan conversation.
  let { contact, conversationEntry } = tip;
  if (!contact) {
    const createdAt = Date.now();
    contact = {
      id: nowId(), name: tip.displayName, nameIsCustom: Boolean(tip.displayName), address: tip.address,
      avatar: initialsFor(tip.displayName || tip.address), createdAt, updatedAt: createdAt,
      relationshipState: "legacy-manual", handshakeTxid: "",
    };
    clearDeletedContactAddress(tip.address);
    state.contacts.push(contact);
  }
  if (!conversationEntry) {
    conversationEntry = createConversation({ contactId: contact.id, createdAt: Date.now() });
    state.conversations.push(conversationEntry);
    refreshSubscriptionAddresses({ restart: true });
  }
  tip.contact = contact;
  tip.conversationEntry = conversationEntry;
  persistState();
  renderChats();

  // Recipient-governed destination: their fresh pool address when they shared one.
  const destinationAddress = await consumePoolPaymentDestination(contact);
  const createdAt = Date.now();
  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "outgoing",
    text: `Sent ${amountKas} KAS`,
    sender: engine.address || null,
    receiver: destinationAddress,
    status: MESSAGE_STATUSES.PENDING,
    transport: "kaspa-payment",
    createdAt,
  });
  applyMessagePatch(message, { messageType: "payment", paymentAmountKas: amountKas });
  appendIncomingOrReactionMessage(conversationEntry, message);
  persistState();
  if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
  const liveMessage = conversationEntry.messages.find((entry) => entry.id === message.id) || message;
  const requestedSompi = BigInt(Math.round(Number(amountKas) * 1e8));
  const feeKas = tipExtraFeeKas();

  try {
    await ensureRuntimes({ quiet: true });
    const result = tip.fundingAddress
      ? await engine.sendFromSpending({
          mnemonic: activeAccountMnemonic(),
          index: tip.fundingIndex,
          passphrase: activeAccountPassphrase(),
          destinationAddress,
          amountKas,
          feeKas,
        })
      : await engine.send(destinationAddress, amountKas, feeKas);
    const submittedTxids = (result?.txids || []).map((value) => String(value || "").trim()).filter(Boolean);
    const txid = submittedTxids.at(-1) || submittedTxids[0] || null;
    if (!txid) throw new Error("Kaspa node accepted the send request but did not return a transaction ID.");
    const verifiedTxid = await verifyKasPaymentBroadcast(submittedTxids, destinationAddress, amountKas);
    applyMessagePatch(liveMessage, {
      status: MESSAGE_STATUSES.CONFIRMED,
      txid: verifiedTxid || txid,
      confirmations: verifiedTxid ? 1 : 0,
      network: "mainnet",
      note: verifiedTxid
        ? "Kaspa payment verified at recipient output."
        : "Kaspa node accepted and broadcast the payment transaction.",
    });
    handlePoolPaymentSubmitted(contact, verifiedTxid || txid, Number(requestedSompi), destinationAddress);
    await refreshBalanceOnly({ quiet: true });
    showCopyToast(`Tip sent · ${(verifiedTxid || txid).slice(0, 10)}…`);
    conversationEntry.updatedAt = Date.now();
    persistState();
    if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
    closeTipModal();
  } catch (error) {
    applyMessagePatch(liveMessage, { status: MESSAGE_STATUSES.FAILED, note: error.message });
    conversationEntry.updatedAt = Date.now();
    persistState();
    if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
    tip.sending = false;
    tipSetError(error?.message || "Tip failed.");
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = "Send Tip"; }
  }
}

tipModal?.querySelectorAll("[data-close-tip]").forEach((button) => button.addEventListener("click", closeTipModal));
tipModal?.addEventListener("click", (event) => { if (event.target === tipModal) closeTipModal(); });
tipQ("[data-tip-send]")?.addEventListener("click", sendTipNow);
tipQ("[data-tip-amount]")?.addEventListener("input", () => {
  tipSetError("");
  tipUpdateSendEnabled();
  window.clearTimeout(openTipModal.feeTimer);
  openTipModal.feeTimer = window.setTimeout(tipEstimateFee, 400);
});
tipModal?.querySelectorAll("[data-tip-fee-tier]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!tipState) return;
    tipState.tier = button.dataset.tipFeeTier || "normal";
    tipModal.querySelectorAll("[data-tip-fee-tier]").forEach((other) => other.classList.toggle("active", other === button));
    tipRenderFee();
  });
});
tipQ("[data-tip-max]")?.addEventListener("click", async () => {
  const state = tipState;
  if (!state || state.availableKas == null) return;
  await tipEstimateFee();
  const total = Number(tipTotalFeeKas() || 0);
  const max = Math.max(0, state.availableKas - total - 0.00001);
  const amountEl = tipQ("[data-tip-amount]");
  if (amountEl && max > 0) {
    amountEl.value = trimKas8(max);
    tipUpdateSendEnabled();
    tipEstimateFee();
  }
});

async function sendOutgoingHandshake(contact, conversationEntry, { accepting = false } = {}) {
  const createdAt = Date.now();
  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "outgoing",
    text: accepting ? "Communication request accepted" : "Handshake sent",
    sender: engine.address,
    receiver: contact.address,
    status: MESSAGE_STATUSES.PENDING,
    transport: "onchain",
    createdAt,
  });
  applyMessagePatch(message, { messageType: "handshake", protocol: "kasia", transport: "onchain" });
  appendIncomingOrReactionMessage(conversationEntry, message);
  persistState();
  renderMessages(conversationEntry);
  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet before starting a new conversation.");
    const envelope = await engine.createEncryptedHandshakeEnvelope({
      conversationId: conversationEntry.id,
      contactId: contact.id,
      toAddress: contact.address,
      fromAddress: engine.address,
      isResponse: accepting,
      createdAt,
    });
    updateMessageStatus(conversationEntry.id, message.id, { status: MESSAGE_STATUSES.SIGNING, protocolString: envelope.protocolString, payloadHex: envelope.payloadHex, payloadBytes: envelope.payloadBytes });
    const result = await engine.sendHandshakeOnchain({
      envelope,
      // iOS and Android both use a fixed 0.2 KAS carrier amount for every
      // handshake transaction, fresh or response (KaChatTransactionBuilder.swift's
      // `handshakeAmount` / WalletService.kt's `HANDSHAKE_AMOUNT_SOMPI`, both
      // 20_000_000 sompi) — not the user's configurable message amount, and
      // not a reduced amount for responses.
      amountKas: "0.2",
      feeKas: "0",
      onStatus: (patch) => updateMessageStatus(conversationEntry.id, message.id, patch),
    });
    contact.handshakeTxid = result.txid || "";
    contact.relationshipState = accepting ? "established" : "outgoing-request";
    updateMessageStatus(conversationEntry.id, message.id, {
      status: MESSAGE_STATUSES.CONFIRMED,
      txid: result.txid || message.txid || "",
      confirmations: Math.max(1, Number(message.confirmations || 0)),
      note: "Communication request confirmed on-chain",
      messageType: "handshake",
      transport: "onchain",
    });
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    setStatus(accepting ? "Communication request accepted" : "Communication request sent");
    stashHandshakeForRecovery(contact, { isResponse: accepting, createdAt });
    return true;
  } catch (error) {
    updateMessageStatus(conversationEntry.id, message.id, { status: MESSAGE_STATUSES.FAILED });
    // Preserve an incoming request on response failure so Accept can be retried
    // and incoming evidence can still establish the relationship.
    contact.relationshipState = accepting ? "incoming-request" : "request-failed";
    persistState();
    setStatus(`Communication request failed: ${error.message}`);
    return false;
  }
}

// Best-effort, fire-and-forget: mirrors iOS's sendOrQueueSelfStash, sending a
// second self-payment transaction whose payload is this conversation's
// alias/partner metadata encrypted to our own address. This lets conversations
// be recovered from chain history alone (seed phrase + "Recover Conversations
// from Blockchain" in Settings) with no local backup file. A failure here
// must never surface as a handshake failure to the user — the handshake
// itself already succeeded.
async function stashHandshakeForRecovery(contact, { isResponse = false, createdAt = Date.now() } = {}) {
  try {
    const aliases = await engine.deriveConversationAliases(contact.address);
    const envelope = await engine.createSelfStashEnvelope({
      ourAlias: aliases.myAlias,
      theirAlias: aliases.theirAlias,
      partnerAddress: contact.address,
      isResponse,
      createdAt,
    });
    const result = await engine.sendSelfStashOnchain({ envelope });
    appendEngineLog(`Conversation recovery data stashed on-chain: ${result.txid || ""}`);
  } catch (error) {
    appendEngineLog(`Self-stash skipped (non-fatal): ${error.message}`);
  }
}

async function sendHandshakeFromComposer() {
  if (handshakeSendInFlight || !activeConversationId) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;
  handshakeSendInFlight = true;
  // The warning banner's own Send Handshake button is the usual entry point, so
  // it carries the busy state for both it and the composer-menu equivalent.
  setHandshakeWarningButtonBusy(true);
  try {
    await sendOutgoingHandshake(contact, conversationEntry);
  } finally {
    handshakeSendInFlight = false;
    setHandshakeWarningButtonBusy(false);
    // Sending a handshake doesn't make the relationship mutual (they still have
    // to answer), so re-evaluate rather than assume the warning can go.
    updateHandshakeWarningBanner();
  }
}

document.querySelectorAll(".js-open-contact").forEach((button) => {
  button.addEventListener("click", showContactModal);
});

document.querySelectorAll("[data-close-contact]").forEach((button) => {
  button.addEventListener("click", closeContactModal);
});

document.querySelectorAll("[data-open-account-view]").forEach((button) => {
  button.addEventListener("click", () => {
    setSettingsAppOnlyMode(false);
    openAccountOverlay();
    showSettingsCategory(null); // always land on the hub, matching iOS
  });
});

// ---------------------------------------------------------------------------
// 4.0 settings HUB (matches iOS/Android): the settings screen opens as a flat
// list of category rows; picking one shows just that category's group with a
// back affordance. The existing group markup is untouched — only gated.
// ---------------------------------------------------------------------------

const settingsScreenEl = document.querySelector('[data-screen="settings"]');
const settingsGroupsEls = settingsScreenEl
  ? [...settingsScreenEl.querySelectorAll(":scope > .settings-group")]
  : [];
// The engineering diagnostics <details> rides along with the Diagnostics page only.
const settingsDiagnosticsDetailsEl = settingsScreenEl?.querySelector(":scope > .diagnostics-panel") || null;
const settingsDiagnosticsIndex = settingsGroupsEls.findIndex(
  (group) => group.querySelector(".settings-group-label")?.textContent?.trim() === "Diagnostics"
);

// iOS SettingsView category icons (SF-symbol equivalents as inline SVGs), keyed by
// the .settings-group-label text.
const SETTINGS_HUB_ICONS = {
  "Customization": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 4 6 6-8.5 8.5L6 20l1.5-5.5z"/><path d="m12.5 5.5 6 6"/></svg>',
  "Security": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 2.8v5.4c0 4.5-3 8.2-7 9.8-4-1.6-7-5.3-7-9.8V5.8z"/><circle cx="12" cy="10.6" r="1.6"/><path d="M12 12.2v2.8"/></svg>',
  "Connection": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="1.8"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>',
  "Chats": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.3 4.5h9.1a3.8 3.8 0 0 1 3.8 3.8v2.7a3.8 3.8 0 0 1-3.8 3.8H8.7l-4.45 3.05.02-3.44A3.78 3.78 0 0 1 .5 10.65V8.3a3.8 3.8 0 0 1 3.8-3.8Z"/><path d="M9.65 8.15h6.1a3.75 3.75 0 0 1 3.75 3.75v1.95a3.75 3.75 0 0 1-3.75 3.75h-2.7L9.5 20.1v-2.5"/></svg>',
  "Notifications": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a5.5 5.5 0 0 1 5.5 5.5c0 3.2.8 5 1.8 6.2.4.5.05 1.3-.6 1.3H5.3c-.65 0-1-.8-.6-1.3 1-1.2 1.8-3 1.8-6.2A5.5 5.5 0 0 1 12 4Z"/><path d="M10 19.5a2 2 0 0 0 4 0"/><path d="M12 4V2.8"/></svg>',
  "Contacts": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.9-3 2.9-4.5 5.5-4.5s4.6 1.5 5.5 4.5"/><path d="M15.2 5.9a2.9 2.9 0 1 1 1.3 5.5M17.3 14.7c1.7.7 2.8 2 3.2 4.3"/></svg>',
  "Storage": '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="8" rx="2.2"/><path d="M6.5 12h.01M10 12h.01"/><circle cx="17.4" cy="12" r=".4"/></svg>',
  "Chat History": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M12 7.5V12l3 1.8"/></svg>',
  "Diagnostics": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2.5-6 4 12L16 12h5"/></svg>',
  "Danger Zone": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 21 19.5H3z"/><path d="M12 10v4.2"/><circle cx="12" cy="16.6" r=".3"/></svg>',
};

const settingsHubEl = (() => {
  if (!settingsScreenEl || settingsGroupsEls.length === 0) return null;
  const hub = document.createElement("section");
  hub.className = "settings-group settings-hub";
  const chevron = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>`;
  const rows = [];
  settingsGroupsEls.forEach((group, index) => {
    if (group.dataset.settingsSubscreen) return; // sub-screens open from their parent page, not the hub
    const label = group.querySelector(".settings-group-label")?.textContent?.trim() || `Section ${index + 1}`;
    const danger = group.classList.contains("danger-zone-group");
    if (danger) {
      // View Seed Phrase: a direct action right above Danger Zone, not a sub-page (matches iOS).
      rows.push(`<button class="settings-list-row settings-hub-row seed" type="button" data-settings-hub-seed>
        <span class="settings-hub-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"/></svg></span>
        <span class="settings-hub-label">View Seed Phrase</span>
        ${chevron}
      </button>`);
    }
    rows.push(`<button class="settings-list-row settings-hub-row${danger ? " danger" : ""}" type="button" data-settings-hub-row="${index}">
      <span class="settings-hub-icon" aria-hidden="true">${SETTINGS_HUB_ICONS[label] || ""}</span>
      <span class="settings-hub-label">${label}</span>
      ${chevron}
    </button>`);
  });
  hub.innerHTML = `<div class="settings-list-card">${rows.join("")}</div>`;
  settingsScreenEl.prepend(hub);

  const backBar = document.createElement("button");
  backBar.type = "button";
  backBar.className = "settings-hub-back";
  backBar.dataset.settingsHubBack = "";
  backBar.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg><span data-settings-hub-back-label>Settings</span>`;
  backBar.hidden = true;
  settingsScreenEl.prepend(backBar);
  return hub;
})();

// When a sub-screen (e.g. Storage > Nextcloud) is showing, back returns to its
// parent category instead of the hub.
let settingsSubscreenParentIndex = null;

function setSettingsBackBar(visible, label) {
  const backBar = settingsScreenEl?.querySelector("[data-settings-hub-back]");
  if (!backBar) return;
  backBar.hidden = !visible;
  const labelEl = backBar.querySelector("[data-settings-hub-back-label]");
  if (labelEl) labelEl.textContent = label || "Settings";
}

function showSettingsCategory(index) {
  if (!settingsScreenEl || !settingsHubEl) return;
  const inCategory = Number.isInteger(index);
  settingsSubscreenParentIndex = null;
  settingsHubEl.hidden = inCategory;
  setSettingsBackBar(inCategory, "Settings");
  settingsGroupsEls.forEach((group, i) => { group.hidden = !inCategory || i !== index; });
  if (settingsDiagnosticsDetailsEl) settingsDiagnosticsDetailsEl.hidden = !inCategory || index !== settingsDiagnosticsIndex;
  settingsScreenEl.scrollTop = 0;
}

function showSettingsSubscreen(name, parentIndex) {
  if (!settingsScreenEl || !settingsHubEl) return;
  const target = settingsGroupsEls.find((group) => group.dataset.settingsSubscreen === name);
  if (!target) return;
  // The Child Mode page is stateful (set-up vs. manage) — re-render fresh on every visit.
  if (name === "child-mode") renderChildModeSettingsPage();
  // The retention window is per account, so the checkmark is only right once the page opens.
  if (name === "retention") refreshRetentionSelectionUi();
  settingsSubscreenParentIndex = Number.isInteger(parentIndex) && parentIndex >= 0 ? parentIndex : null;
  settingsHubEl.hidden = true;
  settingsGroupsEls.forEach((group) => { group.hidden = group !== target; });
  if (settingsDiagnosticsDetailsEl) settingsDiagnosticsDetailsEl.hidden = true;
  const parentLabel = settingsSubscreenParentIndex != null
    ? settingsGroupsEls[settingsSubscreenParentIndex]?.querySelector(".settings-group-label")?.textContent?.trim()
    : null;
  setSettingsBackBar(true, parentLabel || "Settings");
  settingsScreenEl.scrollTop = 0;
}

settingsScreenEl?.addEventListener("click", (event) => {
  const sub = event.target.closest("[data-settings-open-subscreen]");
  if (sub) {
    showSettingsSubscreen(sub.dataset.settingsOpenSubscreen, settingsGroupsEls.indexOf(sub.closest(".settings-group")));
    return;
  }
  const row = event.target.closest("[data-settings-hub-row]");
  if (row) { showSettingsCategory(Number(row.dataset.settingsHubRow)); return; }
  if (event.target.closest("[data-settings-hub-back]")) {
    showSettingsCategory(settingsSubscreenParentIndex != null ? settingsSubscreenParentIndex : null);
    return;
  }
  if (event.target.closest("[data-settings-hub-seed]")) {
    openRecoveryModal();
  }
});
showSettingsCategory(null);

// ---------------------------------------------------------------------------
// App-wide settings from the signed-out landing screen (iOS: the accounts
// screen's App Settings cog). Same overlay, limited to the app-wide categories
// — Customization (minus the per-account dock page), Security (incl. Child
// Mode), Connection and Diagnostics. The overlay normally sits below the
// logged-out screen (z 1500 vs 2000), so app-only mode also bumps it above.
// ---------------------------------------------------------------------------

const SETTINGS_APP_ONLY_CATEGORIES = new Set(["Customization", "Security", "Connection", "Diagnostics"]);

function setSettingsAppOnlyMode(appOnly) {
  settingsScreenEl?.classList.toggle("app-only", appOnly);
  accountOverlay?.classList.toggle("over-logged-out", appOnly);
  settingsHubEl?.querySelectorAll("[data-settings-hub-row]").forEach((row) => {
    const label = row.querySelector(".settings-hub-label")?.textContent?.trim();
    row.hidden = appOnly && !SETTINGS_APP_ONLY_CATEGORIES.has(label);
  });
  const seedRow = settingsHubEl?.querySelector("[data-settings-hub-seed]");
  if (seedRow) seedRow.hidden = appOnly;
}

document.querySelector("[data-logged-out-settings]")?.addEventListener("click", () => {
  setSettingsAppOnlyMode(true);
  openAccountOverlay();
  showSettingsCategory(null);
});

contactModal.addEventListener("click", (event) => {
  if (event.target === contactModal) { closeContactModal(); return; }

  const pick = event.target.closest("[data-create-chat-pick]");
  if (pick) {
    // Same as typing it: the row is a shortcut into the field, not a second way to add, so the
    // preview, the status line and the Add button all come from the one code path.
    setContactAddressValue(pick.dataset.createChatPick);
    return;
  }
  if (event.target.closest("[data-create-chat-picker-search-toggle]")) {
    createChatPickerSearching = !createChatPickerSearching;
    if (!createChatPickerSearching) createChatPickerQuery = "";
    renderCreateChatPicker();
    if (createChatPickerSearching) {
      window.setTimeout(() => document.querySelector("[data-create-chat-picker-query]")?.focus(), 0);
    }
  }
});

document.querySelector("[data-create-chat-picker-query]")?.addEventListener("input", (event) => {
  createChatPickerQuery = String(event.target.value || "");
  renderCreateChatPicker();
});

contactAddressInput?.addEventListener("input", () => {
  setCreateChatError("");
  updateCreateChatAddState();
});

contactPasteButton?.addEventListener("click", async () => {
  setCreateChatError("");

  try {
    if (!navigator.clipboard?.readText) return;

    // Clipboard access must be requested directly inside this user click.
    // Safari does not reliably support querying clipboard-read permission first;
    // the prior permission check caused every paste attempt to return early.
    const pasted = String(await navigator.clipboard.readText() || "").trim();
    if (!pasted) return;

    setContactAddressValue(pasted);
  } catch {
    // Permission denied, unavailable clipboard, or empty clipboard:
    // leave the form unchanged and do not show an error.
  }
});

contactImportButton?.addEventListener("click", async () => {
  setCreateChatError("");
  try {
    if (navigator.contacts?.select) {
      const selected = await navigator.contacts.select(["name", "address", "email", "tel"], { multiple: false });
      const entry = selected?.[0];
      if (!entry) return;
      const serialized = JSON.stringify(entry);
      const addressMatch = serialized.match(/kaspa:[a-z0-9]+/i);
      if (!addressMatch) throw new Error("The selected contact does not contain a Kaspa address.");
      setContactAddressValue(addressMatch[0]);
      const selectedName = Array.isArray(entry.name) ? entry.name[0] : entry.name;
      if (selectedName && contactNameInput && !contactNameInput.value.trim()) contactNameInput.value = selectedName;
      return;
    }
    contactImportFile?.click();
  } catch (error) {
    setCreateChatError(error?.message || "Contact import was not available.");
  }
});

contactImportFile?.addEventListener("change", async () => {
  const file = contactImportFile.files?.[0];
  contactImportFile.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const addressMatch = text.match(/kaspa:[a-z0-9]+/i);
    if (!addressMatch) throw new Error("That contact file does not contain a Kaspa address.");
    setContactAddressValue(addressMatch[0]);
    const nameMatch = text.match(/^FN(?:;[^:]*)?:(.+)$/im);
    if (nameMatch?.[1] && contactNameInput && !contactNameInput.value.trim()) {
      contactNameInput.value = nameMatch[1].trim();
    }
  } catch (error) {
    setCreateChatError(error?.message || "The contact file could not be imported.");
  }
});

contactScanButton?.addEventListener("click", async () => {
  const scanned = await scanKaspaAddress({
    title: "Scan a contact code",
    hint: "Point the camera at a KaChat address QR code.",
  });
  if (!scanned || !contactAddressInput) return;
  contactAddressInput.value = scanned;
  // Same path typing takes, so KNS resolution and validation still run.
  contactAddressInput.dispatchEvent(new Event("input", { bubbles: true }));
  contactAddressInput.focus();
});

contactForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(contactForm);
  const name = String(formData.get("name") || "").trim();
  const addressInput = contactForm.elements.address;
  const rawAddress = String(formData.get("address") || "").trim();

  addressInput?.setCustomValidity("");
  setCreateChatError("");
  if (!rawAddress) {
    updateCreateChatAddState();
    return;
  }

  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet before starting a new conversation.");

    let address;
    let resolvedDomain = null;
    if (engine.knsLooksLikeDomain(rawAddress) && !rawAddress.startsWith("kaspa:")) {
      setCreateChatError("Resolving KNS domain…");
      const resolution = await engine.resolveKnsDomain(rawAddress);
      if (!resolution) throw new Error(`Could not resolve ${engine.knsNormalizeDomainName(rawAddress) || rawAddress}. Check the domain name and try again.`);
      address = validateContactAddress(resolution.ownerAddress);
      resolvedDomain = resolution.domain;
      setCreateChatError("");
    } else {
      address = validateContactAddress(rawAddress);
    }

    const displayName = name || resolvedDomain || shortAddress(address);
    const existing = state.contacts.find((contact) => contact.address === address);
    if (existing) {
      const existingConversation = state.conversations.find((entry) => entry.contactId === existing.id);
      closeContactModal();
      if (existingConversation) openConversation(existingConversation.id);
      return;
    }
    const createdAt = Date.now();
    const contact = {
      id: nowId(), name: displayName, nameIsCustom: Boolean(name), address, avatar: initialsFor(displayName), createdAt, updatedAt: createdAt,
      relationshipState: "legacy-manual", handshakeTxid: "",
    };
    // Deliberate re-add wins over an old deletion — future restores may include it again.
    clearDeletedContactAddress(address);
    const conversationEntry = createConversation({ contactId: contact.id, createdAt });
    state.contacts.push(contact);
    state.conversations.push(conversationEntry);
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    closeContactModal();
    openConversation(conversationEntry.id);
  } catch (error) {
    const message = error?.message || "Invalid Kaspa address.";
    setCreateChatError(message);
    addressInput?.setCustomValidity(message);
    addressInput?.reportValidity();
    updateCreateChatAddState();
  }
});

chatList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-conversation-id]");
  if (!row) return;
  const conversationId = row.dataset.conversationId;
  if (chatSelectionModeActive) {
    if (selectedChatConversationIds.has(conversationId)) selectedChatConversationIds.delete(conversationId);
    else selectedChatConversationIds.add(conversationId);
    renderChats();
    updateChatSelectionBar();
    return;
  }
  // Clicking the already-open chat again closes it (clears the detail pane).
  if (conversationId === activeConversationId) {
    setActiveConversationId(null);
    renderChats();
    return;
  }
  openConversation(conversationId);
});

// The list of groups the Group Chats tab currently shows (order matches renderGroupList).
function visibleGroups() {
  const mgr = getGroupManager();
  return mgr ? mgr.listGroups() : [];
}

// Selection is per-tab: the Group Chats tab acts on selectedGroupIds, everything else on
// selectedChatConversationIds.
function selectionIsGroups() { return activeChatsListTab === "groups"; }
function activeSelectionCount() {
  return selectionIsGroups() ? selectedGroupIds.size : selectedChatConversationIds.size;
}

function updateChatSelectionBar() {
  if (chatSelectionBar) chatSelectionBar.hidden = !chatSelectionModeActive;
  const markRead = document.querySelector("[data-chat-mark-read]");
  const markUnread = document.querySelector("[data-chat-mark-unread]");
  const deleteButton = document.querySelector("[data-chat-delete-selected]");
  const disabled = activeSelectionCount() === 0;
  if (markRead) markRead.disabled = disabled;
  if (markUnread) markUnread.disabled = disabled;
  if (deleteButton) deleteButton.disabled = disabled;
  if (chatSelectAll) {
    if (selectionIsGroups()) {
      const visible = visibleGroups();
      const allSelected = visible.length > 0 && visible.every((g) => selectedGroupIds.has(g.groupId));
      chatSelectAll.textContent = allSelected ? "Deselect All" : "Select All";
      chatSelectAll.disabled = visible.length === 0;
    } else {
      const visible = visibleChatConversations();
      const allSelected = visible.length > 0 && visible.every((entry) => selectedChatConversationIds.has(entry.id));
      chatSelectAll.textContent = allSelected ? "Deselect All" : "Select All";
      chatSelectAll.disabled = visible.length === 0;
    }
  }
}

function setChatSelectionMode(active) {
  chatSelectionModeActive = active;
  if (!active) { selectedChatConversationIds.clear(); selectedGroupIds.clear(); }
  if (chatSelectToggle) chatSelectToggle.textContent = active ? "Cancel" : "Select";
  if (chatSelectAll) chatSelectAll.hidden = !active;
  if (appSidebar) appSidebar.classList.toggle("selecting-chats", active);
  updateChatSelectionBar();
  renderChats();
  renderGroupList();
}

chatSelectToggle?.addEventListener("click", () => setChatSelectionMode(!chatSelectionModeActive));

chatSelectAll?.addEventListener("click", () => {
  if (!chatSelectionModeActive) return;
  if (selectionIsGroups()) {
    const visible = visibleGroups();
    const allSelected = visible.length > 0 && visible.every((g) => selectedGroupIds.has(g.groupId));
    for (const g of visible) {
      if (allSelected) selectedGroupIds.delete(g.groupId);
      else selectedGroupIds.add(g.groupId);
    }
    renderGroupList();
    updateChatSelectionBar();
    return;
  }
  const visible = visibleChatConversations();
  const allSelected = visible.length > 0 && visible.every((entry) => selectedChatConversationIds.has(entry.id));
  for (const entry of visible) {
    if (allSelected) selectedChatConversationIds.delete(entry.id);
    else selectedChatConversationIds.add(entry.id);
  }
  renderChats();
  updateChatSelectionBar();
});

chatsListTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.chatsListTab;
    if (tab === activeChatsListTab) return;
    activeChatsListTab = tab;
    chatsListTabButtons.forEach((entry) => entry.classList.toggle("active", entry === button));
    // Switching tabs is like moving to a new screen: clear whatever chat or group was
    // open so the new tab starts fresh with only its own items viewable.
    setActiveConversationId(null);
    closeGroupChat();
    if (chatSelectionModeActive) setChatSelectionMode(false);
    else renderChats();
  });
});

document.querySelector("[data-chat-mark-read]")?.addEventListener("click", () => {
  if (selectionIsGroups()) {
    for (const id of selectedGroupIds) setGroupUnread(id, 0);
    setChatSelectionMode(false);
    renderGroupList();
    showCopyToast("Marked as read");
    return;
  }
  for (const conversationEntry of state.conversations) {
    if (selectedChatConversationIds.has(conversationEntry.id)) conversationEntry.unreadCount = 0;
  }
  persistState();
  setChatSelectionMode(false);
  showCopyToast("Marked as read");
});

document.querySelector("[data-chat-mark-unread]")?.addEventListener("click", () => {
  if (selectionIsGroups()) {
    for (const id of selectedGroupIds) {
      if (Number(groupUnreadFor(id) || 0) === 0) setGroupUnread(id, 1);
    }
    setChatSelectionMode(false);
    renderGroupList();
    showCopyToast("Marked as unread");
    return;
  }
  for (const conversationEntry of state.conversations) {
    if (selectedChatConversationIds.has(conversationEntry.id) && Number(conversationEntry.unreadCount || 0) === 0) {
      conversationEntry.unreadCount = 1;
    }
  }
  persistState();
  setChatSelectionMode(false);
  showCopyToast("Marked as unread");
});

document.querySelector("[data-chat-delete-selected]")?.addEventListener("click", async () => {
  if (selectionIsGroups()) {
    const count = selectedGroupIds.size;
    if (!count) return;
    if (!await confirmText(`Delete ${count} group${count === 1 ? "" : "s"} from this device? Members you invited keep their copy. This cannot be undone.`)) return;
    const mgr = getGroupManager();
    const ids = new Set(selectedGroupIds);
    if (activeGroupId && ids.has(activeGroupId)) closeGroupChat();
    if (mgr) for (const id of ids) { try { mgr.deleteGroup(id); } catch { /* already gone */ } }
    setChatSelectionMode(false);
    renderGroupList();
    showCopyToast(`Deleted ${count} group${count === 1 ? "" : "s"}`);
    return;
  }
  const count = selectedChatConversationIds.size;
  if (!count) return;
  if (!await confirmText(`Delete ${count} chat${count === 1 ? "" : "s"}? This removes the conversation and contact locally. This cannot be undone.`)) return;
  const idsToDelete = new Set(selectedChatConversationIds);
  const contactIdsToDelete = new Set(
    state.conversations.filter((entry) => idsToDelete.has(entry.id)).map((entry) => entry.contactId),
  );
  // Tombstone the addresses so no backup restore (snapshot, phone archive, shared
  // kachat-backup.json) can resurrect these chats.
  recordDeletedContactAddresses(
    state.contacts.filter((contact) => contactIdsToDelete.has(contact.id)).map((contact) => contact.address),
  );
  state.conversations = state.conversations.filter((entry) => !idsToDelete.has(entry.id));
  state.contacts = state.contacts.filter((contact) => !contactIdsToDelete.has(contact.id));
  if (activeConversationId && idsToDelete.has(activeConversationId)) setActiveConversationId(null);
  refreshSubscriptionAddresses({ restart: true });
  persistState();
  setChatSelectionMode(false);
  showCopyToast(`Deleted ${count} chat${count === 1 ? "" : "s"}`);
});

document.querySelector("[data-back-to-chats]").addEventListener("click", () => {
  if (isWideLayout) setActiveConversationId(null);
  else renderChats();
});

copyContactAddressButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
    const contact = contactForConversation(conversationEntry);
    const contactAddress = String(contact?.address || "").trim();
    if (!contactAddress) return;

    try {
      await copyTextToClipboard(contactAddress);
      showCopyToast("Kaspa address copied");
    } catch (error) {
      appendEngineLog(error?.message || "Could not copy contact address");
    }
  });
});

messageArea.addEventListener("click", async (event) => {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;
  if (event.target.closest("[data-accept-handshake]")) {
    if (contact.relationshipState !== "incoming-request") return;
    const button = event.target.closest("[data-accept-handshake]");
    button.disabled = true;
    setStatus("Accepting communication request…");
    const ok = await sendOutgoingHandshake(contact, conversationEntry, { accepting: true });
    if (ok) {
      contact.relationshipState = "established";
      contact.updatedAt = Date.now();
      persistState();
      refreshSubscriptionAddresses({ restart: true });
      renderMessages(conversationEntry);
      setStatus("Communication request accepted");
    } else {
      button.disabled = false;
    }
    return;
  }
  if (event.target.closest("[data-decline-handshake]")) {
    const txid = contact.incomingHandshakeTxid || "";
    contact.relationshipState = "declined";
    contact.updatedAt = Date.now();
    if (txid) handshakeSyncState.declinedTxids = [...new Set([...handshakeSyncState.declinedTxids, txid])];
    persistHandshakeSyncState();
    persistState();
    renderMessages(conversationEntry);
    setStatus("Communication request declined locally");
  }
});

clearChatButton.addEventListener("click", () => {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (!conversationEntry) return;
  conversationEntry.messages = [];
  conversationEntry.updatedAt = Date.now();
  conversationEntry.lastActivityAt = conversationEntry.updatedAt;
  persistState();
  renderMessages(conversationEntry);
  setStatus("Local chat cleared");
});

function queueIncomingPreview(conversationId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;

  const createdAt = Date.now();
  const incomingText = `Preview reply from ${contact.name}`;
  const envelope = engine.createMessageEnvelope({
    conversationId,
    contactId: contact.id,
    toAddress: engine.address || contact.address,
    fromAddress: contact.address,
    text: incomingText,
    alias: contact.name,
    localNonce: nowId(),
    createdAt,
  });
  const parsed = engine.parseKasiaPayloadHex(envelope.payloadHex);

  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "incoming",
    text: parsed?.bodyText || incomingText,
    sender: contact.address,
    receiver: engine.address || contact.address,
    status: MESSAGE_STATUSES.CONFIRMED,
    transport: "incoming-preview",
    createdAt,
  });
  applyMessagePatch(message, {
    txid: `preview-inbound-${String(envelope.localNonce || nowId()).slice(-8)}`,
    daaScore: String(Math.floor(createdAt / 1000)),
    payloadHex: envelope.payloadHex,
    payloadBytes: envelope.payloadBytes,
    messageType: envelope.messageType,
    protocolString: envelope.protocolString,
    confirmations: 1,
  });

  appendIncomingOrReactionMessage(conversationEntry, message);
  persistState();
  renderMessages(conversationEntry);
  setStatus("Incoming Kasia preview decoded");
}

simulateIncomingButton?.addEventListener("click", () => {
  if (!activeConversationId) return;
  queueIncomingPreview(activeConversationId);
});

async function runSyncPreview(conversationId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;

  try {
    syncPreviewButton.disabled = true;
    setStatus("Querying Kasia indexer and decrypting messages…");
    const knownTxids = conversationEntry.messages.map((message) => message.txid).filter(Boolean);
    const indexerUrl = indexerUrlInput?.value?.trim() || getEndpoint("kasiaIndexer");
    const result = await engine.syncConversationFromIndexer({
      conversationId,
      contact,
      knownTxids,
      cursor: conversationEntry.sync?.cursor || 0,
      indexerUrl,
    });

    for (const incoming of result.messages) {
      const hiddenKeys = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
      if ((incoming.txid && hiddenKeys.has(String(incoming.txid))) || (incoming.id && hiddenKeys.has(String(incoming.id)))) continue;
      const message = createMessage({
        ...incoming,
        conversationId: conversationEntry.id,
        contactId: contact.id,
      });
      applyMessagePatch(message, incoming);
      appendIncomingOrReactionMessage(conversationEntry, message);
    }
    promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist: false });

    conversationEntry.sync = {
      ...(conversationEntry.sync || {}),
      lastSyncAt: Date.now(),
      lastFound: Number(result.found || 0),
      runs: Number(conversationEntry.sync?.runs || 0) + 1,
      cursor: Number(result.nextCursor || conversationEntry.sync?.cursor || 0),
      lastNote: result.note || "Real Kasia sync complete.",
      scannedCount: Number(result.scannedCount || 0),
      decryptFailures: Number(result.decryptFailures || 0),
      indexerUrl,
    };

    persistState();
    renderMessages(conversationEntry);
    if (syncStatus) syncStatus.textContent = syncLabel(conversationEntry);
    setStatus(result.note || `Real sync complete: ${result.found || 0} new`);
    appendEngineLog(`${result.note} Scanned ${result.scannedCount || 0}; filtered ${result.decryptFailures || 0}.`);
  } catch (error) {
    setStatus(`Real sync failed: ${error.message}`);
    appendEngineLog(`Real sync failed: ${error.message}`);
  } finally {
    syncPreviewButton.disabled = false;
  }
}

syncPreviewButton?.addEventListener("click", () => {
  if (!activeConversationId) return;
  runSyncPreview(activeConversationId);
});

importPayloadButton?.addEventListener("click", showImportPayloadModal);

document.querySelectorAll("[data-close-import-payload]").forEach((button) => {
  button.addEventListener("click", closeImportPayloadModal);
});

importPayloadModal?.addEventListener("click", (event) => {
  if (event.target === importPayloadModal) closeImportPayloadModal();
});

importPayloadForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    importPayloadIntoConversation(importPayloadInput?.value || "");
    closeImportPayloadModal();
  } catch (error) {
    setStatus(`Payload import failed: ${error.message}`);
  }
});


// Debounced: each keystroke previously rebuilt the entire chat list synchronously
// (innerHTML + per-row preview derivation), which was visible typing lag with many chats.
let chatSearchDebounce = null;
searchInput.addEventListener("input", () => {
  if (chatSearchDebounce) clearTimeout(chatSearchDebounce);
  chatSearchDebounce = window.setTimeout(() => { chatSearchDebounce = null; renderChats(); }, 120);
});

messageArea.addEventListener("click", (event) => {
  const bubble = event.target.closest("[data-message-id]");
  if (!bubble) return;
  // In selection mode a left-click toggles the checkbox. Otherwise message actions live on
  // the right-click (context) menu now, Telegram-style, so a normal left-click does nothing.
  if (messageSelectionMode) toggleSelectedMessage(bubble.dataset.messageId);
});

messageArea.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const bubble = event.target.closest("[data-message-id]");
  if (!bubble) return;
  event.preventDefault();
  // Keyboard parity with right-click: Enter/Space toggles selection, or opens the actions
  // menu (anchored to the bubble) in normal mode.
  if (messageSelectionMode) {
    toggleSelectedMessage(bubble.dataset.messageId);
  } else {
    const rect = bubble.getBoundingClientRect();
    openOneToOneMessageMenu(bubble.dataset.messageId, rect.left, rect.bottom);
  }
});

document.querySelectorAll("[data-close-message-details]").forEach((button) => {
  button.addEventListener("click", closeMessageDetails);
});

messageDetailsModal?.addEventListener("click", async (event) => {
  if (event.target === messageDetailsModal) {
    closeMessageDetails();
    return;
  }
  const action = event.target.closest("[data-message-action]")?.dataset.messageAction;
  if (!action) return;
  const { message } = activeMessageRecord();
  if (!message) return;
  try {
    if (action === "copy-message") {
      await copyTextToClipboard(displayTextForMessage(message));
      closeMessageDetails();
      showCopyToast("Message copied");
    } else if (action === "reply") {
      closeMessageDetails();
      startReplyTo(message.id);
    } else if (action === "view-explorer") {
      if (message.txid) window.open(explorerTxUrl(message.txid), "_blank", "noopener,noreferrer");
      closeMessageDetails();
    } else if (action === "select") {
      enterMessageSelection(message.id);
    }
  } catch (error) {
    setStatus(`Message action failed: ${error.message}`);
  }
});

document.querySelectorAll("[data-close-export-choice]").forEach((button) => button.addEventListener("click", closeExportChoice));
exportChoiceModal?.addEventListener("click", (event) => {
  if (event.target === exportChoiceModal) closeExportChoice();
});
document.querySelectorAll("[data-export-format]").forEach((button) => {
  button.addEventListener("click", () => {
    const { message } = activeMessageRecord();
    if (!message) return;
    try {
      if (button.dataset.exportFormat === "csv") exportMessageCsv(message);
      else exportMessagePdf(message);
      closeExportChoice();
    } catch (error) {
      setStatus(`Export failed: ${error.message}`);
    }
  });
});

document.querySelector("[data-cancel-selection]")?.addEventListener("click", exitMessageSelection);
document.querySelector("[data-select-all-messages]")?.addEventListener("click", () => {
  if (!messageSelectionMode) return;
  // Toggle: everything already selected -> deselect all (matches iOS's Select All/Deselect All).
  const allIds = Array.from(messageArea?.querySelectorAll("[data-message-id]") || [])
    .map((el) => String(el.dataset.messageId))
    .filter(Boolean);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedMessageIds.has(id));
  selectedMessageIds.clear();
  if (!allSelected) for (const id of allIds) selectedMessageIds.add(id);
  updateSelectionUi();
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (conversationEntry) renderMessages(conversationEntry);
});
document.querySelector("[data-delete-selected]")?.addEventListener("click", openDeleteSelectedConfirmation);
document.querySelector("[data-cancel-delete-selected]")?.addEventListener("click", closeDeleteSelectedConfirmation);
document.querySelector("[data-confirm-delete-selected]")?.addEventListener("click", deleteSelectedMessages);
deleteConfirmModal?.addEventListener("click", (event) => {
  if (event.target === deleteConfirmModal) closeDeleteSelectedConfirmation();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !contactModal.hidden) closeContactModal();
  if (event.key === "Escape" && messageDetailsModal && !messageDetailsModal.hidden) closeMessageDetails();
  if (event.key === "Escape" && exportChoiceModal && !exportChoiceModal.hidden) closeExportChoice();
  if (event.key === "Escape" && messageSelectionMode) exitMessageSelection();
  if (event.key === "Escape" && onchainConfirmModal && !onchainConfirmModal.hidden) closeOnchainConfirm();
  if (event.key === "Escape" && importPayloadModal && !importPayloadModal.hidden) closeImportPayloadModal();
});

function updateMessageStatus(conversationId, messageId, patch) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!conversationEntry || !message) return;
  applyMessagePatch(message, patch);
  conversationEntry.updatedAt = Date.now();
  conversationEntry.lastActivityAt = Math.max(conversationEntry.lastActivityAt, message.updatedAt);
  persistState();
  if (activeConversationId === conversationId) renderMessages(conversationEntry);
  if (activeConversationId !== conversationId) renderChats();
}

async function runEngineSendPipeline(conversationId, messageId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!conversationEntry || !contact || !message) return;

  try {
    updateMessageStatus(conversationId, messageId, { status: MESSAGE_STATUSES.BUILDING });
    const envelopeDetails = {
      conversationId,
      contactId: contact.id,
      toAddress: contact.address,
      fromAddress: engine.address || null,
      text: message.text,
      localNonce: message.localNonce,
      createdAt: message.createdAt,
    };
    const envelope = await engine.createEncryptedMessageEnvelope(envelopeDetails);

    updateMessageStatus(conversationId, messageId, { status: MESSAGE_STATUSES.SIGNING });
    await engine.sendMessageOnchain({
      envelope,
      amountKas: onchainAmountKas(),
      feeKas: "0",
      onStatus: (patch) => {
        updateMessageStatus(conversationId, messageId, patch);
        if (patch.protocolString) updateMessageStatus(conversationId, messageId, { protocolString: patch.protocolString });
        if (patch.transport) updateMessageStatus(conversationId, messageId, { transport: patch.transport });
        if (patch.note) setStatus(patch.note);
      },
    });
  } catch (error) {
    updateMessageStatus(conversationId, messageId, { status: MESSAGE_STATUSES.FAILED });
    setStatus(`Message failed: ${error.message}`);
  }
}

function queueConversationMessage(conversationId, text) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  if (!conversationEntry) return;

  const createdAt = Date.now();
  const contact = contactForConversation(conversationEntry);
  promoteRelationshipFromIncomingEvidence(contact, conversationEntry);
  if (["outgoing-request", "incoming-request", "declined", "request-failed"].includes(contact?.relationshipState)) {
    setStatus(contact.relationshipState === "incoming-request" ? "Accept the communication request before replying" : contact.relationshipState === "declined" ? "Communication request declined" : contact.relationshipState === "outgoing-request" ? "Waiting for communication request acceptance" : "Communication request failed");
    return;
  }
  let finalText = text;
  if (replyingToMessageId) {
    const replyTarget = conversationEntry.messages.find((entry) => entry.id === replyingToMessageId);
    if (replyTarget) {
      finalText = JSON.stringify({
        type: "reply",
        replyToId: replyTarget.txid || replyTarget.id,
        replyToSender: replyTarget.direction === "outgoing" ? (engine.address || "") : (contact?.address || ""),
        replyToPreview: replyPreviewTextFor(replyTarget),
        text,
      });
    }
    cancelReply();
  }

  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: conversationEntry.contactId,
    direction: "outgoing",
    text: finalText,
    sender: engine.address || null,
    receiver: contact?.address || null,
    status: MESSAGE_STATUSES.PENDING,
    transport: transportMode,
    createdAt,
  });
  appendIncomingOrReactionMessage(conversationEntry, message);

  // Paint the bubble immediately, then do the heavy work. persistState does two full JSON
  // serializations of the whole chat state, AND runEngineSendPipeline runs the synchronous
  // ECIES message encryption at its start — both block the browser paint if run inline, which
  // is what made a sent 1:1 message feel slow to appear. Defer both to the next task so the
  // new bubble paints first (matching the snappier group-chat send).
  renderMessages(conversationEntry);
  setStatus("Queued for real Kaspa payload transaction");
  window.setTimeout(() => runEngineSendPipeline(conversationEntry.id, message.id), 0);
  window.setTimeout(persistState, 0);
}


function closeComposerMenu() {
  if (composerPlusMenu) composerPlusMenu.hidden = true;
  // The chess time-control menu is a second step of the same plus menu, anchored the same way.
  const tcMenu = document.querySelector("[data-chess-tc-menu]");
  if (tcMenu) tcMenu.hidden = true;
}

function setComposerHint(message) {
  const input = composer?.elements?.message;
  if (!input) return;
  input.placeholder = message;
  input.focus();
}

function hideAvailableBalanceBanner() {
  if (availableBalanceHideTimer) window.clearTimeout(availableBalanceHideTimer);
  availableBalanceHideTimer = null;
  if (availableBalanceBanner) availableBalanceBanner.hidden = true;
}

// Payment-mode "Available" pill (iOS availableBalanceBubble port). Stays
// visible for the whole KAS mode (it IS the funding-source display, not a
// toast). Privacy ON: shows the PRIMARY SPENDING address balance — the actual
// funding source — underlined and clickable, opening Manage Spending
// Addresses; refreshed when that balance changes (wallet-activity bridge) and
// after sends. Privacy OFF: the plain chatting balance, not clickable. A
// small accent arrow marks that the next send pays a fresh pool address.
let composerBalanceToken = 0;

function renderAvailableBalanceBanner(balanceText, clickable, contact) {
  if (!availableBalanceBanner) return;
  availableBalanceBanner.replaceChildren();
  const value = document.createElement("span");
  value.className = `available-balance-value${clickable ? " clickable" : ""}`;
  value.textContent = `Available ${balanceText} KAS`;
  availableBalanceBanner.append(value);
  if (contact && willPayViaFreshPoolAddress(contact.address)) {
    const arrow = document.createElement("span");
    arrow.className = "available-balance-fresh";
    arrow.textContent = "→";
    arrow.title = "Payment goes to a fresh address this contact shared, so it cannot be linked to their chat address on-chain";
    availableBalanceBanner.append(arrow);
  }
  availableBalanceBanner.classList.toggle("clickable", clickable);
  availableBalanceBanner.hidden = false;
}

async function refreshComposerAvailableBalance() {
  if (!availableBalanceBanner || composerMode !== "kas") return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  const spendingFunded = chatsPrivacyEnabled() && Boolean(activeAccountMnemonic());
  const token = ++composerBalanceToken;
  renderAvailableBalanceBanner("…", spendingFunded, contact);
  try {
    let balanceKas;
    if (spendingFunded) {
      const address = deriveSpendingAddressAt(getActiveSpendingIndex());
      if (!address) throw new Error("No spending address");
      balanceKas = (await engine.balanceForAddress(address)).totalKas;
    } else {
      const balance = await engine.balance();
      currentBalanceKas = balance.totalKas;
      balanceKas = balance.totalKas;
    }
    if (token !== composerBalanceToken || composerMode !== "kas") return;
    renderAvailableBalanceBanner(balanceKas, spendingFunded, contact);
  } catch {
    if (token !== composerBalanceToken || composerMode !== "kas") return;
    renderAvailableBalanceBanner("--", spendingFunded, contact);
  }
}

availableBalanceBanner?.addEventListener("click", () => {
  if (composerMode !== "kas") return;
  if (!chatsPrivacyEnabled() || !activeAccountMnemonic()) return; // OFF: not tappable
  openSpendingManageScreen();
});

async function activateComposerMode(mode) {
  const input = composer?.elements?.message;
  if (!input) return;
  composerMode = mode === "kas" ? "kas" : "message";
  composer.classList.toggle("payment-mode", composerMode === "kas");
  input.value = "";
  input.inputMode = composerMode === "kas" ? "decimal" : "text";
  input.setAttribute("aria-label", composerMode === "kas" ? "KAS amount" : "Message");
  setComposerHint(composerMode === "kas" ? "Amount (KAS)" : "Message");
  hideFeeEstimateBanner();
  // Message mode re-shows the handshake warning if the relationship still needs
  // it; payment mode hides it so it can't crowd the Available/fee pills.
  updateHandshakeWarningBanner();
  if (composerMode === "kas") clearPendingPhoto();
  if (composerMode !== "kas") {
    hideAvailableBalanceBanner();
    setStatus("Text message mode");
    return;
  }
  setStatus("KAS payment mode selected");
  await refreshComposerAvailableBalance();
}


function showKasPaymentAlert({ title, message, primaryLabel = "OK", cancelLabel = "", allowCancel = false } = {}) {
  return new Promise((resolve) => {
    if (!kasPaymentAlert) return resolve(true);
    kasPaymentAlertTitle.textContent = title || "Payment Alert";
    kasPaymentAlertMessage.textContent = message || "";
    kasPaymentAlertPrimary.textContent = primaryLabel;
    kasPaymentAlertCancel.textContent = cancelLabel || "Cancel";
    kasPaymentAlertCancel.hidden = !allowCancel;
    kasPaymentAlert.hidden = false;
    const finish = (value) => {
      kasPaymentAlert.hidden = true;
      kasPaymentAlertPrimary.onclick = null;
      kasPaymentAlertCancel.onclick = null;
      resolve(value);
    };
    kasPaymentAlertPrimary.onclick = () => finish(true);
    kasPaymentAlertCancel.onclick = () => finish(false);
  });
}

function normalizeKaspaTransactions(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.transactions)) return body.transactions;
  if (Array.isArray(body?.result)) return body.result;
  return body && typeof body === "object" ? [body] : [];
}

function kaspaOutputAddress(output) {
  return String(
    output?.script_public_key_address || output?.scriptPublicKeyAddress || output?.address ||
    output?.verbose_data?.script_public_key_address || output?.verboseData?.scriptPublicKeyAddress ||
    output?.script_public_key?.address || output?.scriptPublicKey?.address ||
    output?.script_public_key?.verbose_data?.script_public_key_address ||
    output?.scriptPublicKey?.verboseData?.scriptPublicKeyAddress || "",
  ).trim();
}

function kaspaOutputAmount(output) {
  try { return BigInt(output?.amount ?? output?.value ?? output?.sompi ?? 0); }
  catch { return 0n; }
}

async function transactionPaysRecipient(txid, recipientAddress, amountKas) {
  if (!String(txid || "").trim() || !String(recipientAddress || "").trim()) return false;
  const expected = BigInt(Math.round(Number(amountKas) * 1e8));
  const urls = [
    `${getEndpoint("kaspaApi")}/transactions/${encodeURIComponent(txid)}?resolve_previous_outpoints=light`,
    `${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(recipientAddress)}/full-transactions?limit=100&offset=0&resolve_previous_outpoints=light`,
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const transactions = normalizeKaspaTransactions(await response.json());
      for (const tx of transactions) {
        const candidateTxid = String(tx?.transaction_id || tx?.transactionId || tx?.hash || tx?.id || "").trim();
        if (candidateTxid && candidateTxid !== txid) continue;
        let received = 0n;
        for (const output of (Array.isArray(tx?.outputs) ? tx.outputs : [])) {
          if (kaspaOutputAddress(output) === recipientAddress) received += kaspaOutputAmount(output);
        }
        if (received >= expected) return true;
      }
    } catch {}
  }
  return false;
}

async function verifyKasPaymentBroadcast(txids, recipientAddress, amountKas) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    for (const txid of (txids || [])) {
      if (await transactionPaysRecipient(txid, recipientAddress, amountKas)) return txid;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  return null;
}

function paymentAmountForMessage(message) {
  const stored = String(message?.paymentAmountKas || "").trim();
  if (stored && Number.isFinite(Number(stored)) && Number(stored) > 0) return stored;
  const match = String(message?.text || "").match(/^Sent\s+([0-9]+(?:\.[0-9]{1,8})?)\s+KAS$/i);
  return match ? match[1] : "";
}

// Amount + optional note pulled out of a payment message's display text
// ("Sent 0.2 KAS", "Received 0.2 KAS — thanks!"). Mirrors iOS's
// paymentCardParts: null when the content doesn't look like a standard payment
// phrase (foreign/legacy data) — the bubble then falls back to plain text.
function parsePaymentCardParts(message) {
  if (message?.messageType !== "payment" && message?.transport !== "kaspa-payment" && message?.transport !== "kaspa-payment-rest") return null;
  const content = String(message?.text || "");
  if (!content || content.length > 512) return null;
  const pieces = content.split(" — ");
  const head = pieces[0];
  const noteRaw = pieces.length > 1 ? pieces.slice(1).join(" — ") : null;
  const amountToken = head
    .split(/\s+/)
    .find((token) => token && Number.isFinite(Number(token.replace(",", "."))));
  if (!amountToken) return null;
  const note = noteRaw ? noteRaw.trim() : "";
  return { amountText: amountToken, note: note || null };
}

// Builds the payment card element. All content is set via textContent (never
// innerHTML), so no escaping concerns.
function buildPaymentCard(parts, outgoing) {
  const card = document.createElement("div");
  card.className = `message-payment-card ${outgoing ? "outgoing" : "incoming"}`;
  const logoWrap = document.createElement("span");
  logoWrap.className = "payment-card-logo";
  logoWrap.setAttribute("aria-hidden", "true");
  const logo = document.createElement("img");
  logo.src = kaspaLogoUrl;
  logo.alt = "";
  logoWrap.append(logo);
  const body = document.createElement("div");
  body.className = "payment-card-body";
  const label = document.createElement("span");
  label.className = "payment-card-label";
  label.textContent = outgoing ? "Sent" : "Received";
  const amount = document.createElement("strong");
  amount.className = "payment-card-amount";
  amount.textContent = `${parts.amountText} KAS`;
  body.append(label, amount);
  if (parts.note) {
    const note = document.createElement("span");
    note.className = "payment-card-note";
    note.textContent = parts.note;
    body.append(note);
  }
  card.append(logoWrap, body);
  return card;
}

async function refreshPendingPaymentStatuses(conversationEntry, contact) {
  let changed = false;
  const pendingPayments = (conversationEntry.messages || []).filter((message) =>
    message.direction === "outgoing" && message.messageType === "payment" && message.txid &&
    message.status !== MESSAGE_STATUSES.CONFIRMED && message.status !== MESSAGE_STATUSES.FAILED
  );
  for (const message of pendingPayments) {
    const amountKas = paymentAmountForMessage(message);
    let recipientVerified = false;
    if (amountKas) {
      try {
        recipientVerified = await transactionPaysRecipient(message.txid, contact.address, amountKas);
      } catch (error) {
        appendEngineLog(`Payment verification failed for ${message.txid}: ${error.message}`);
      }
    }

    // A txid is assigned only after pending.submit(rpc) resolves successfully.
    // Therefore an existing outgoing payment with a txid has been accepted by a
    // Kaspa node even if the public REST index has not exposed the transaction yet.
    applyMessagePatch(message, {
      status: MESSAGE_STATUSES.CONFIRMED,
      confirmations: recipientVerified ? 1 : Math.max(1, Number(message.confirmations || 0)),
      paymentAmountKas: amountKas || message.paymentAmountKas || null,
      note: recipientVerified
        ? "Kaspa payment verified at recipient output."
        : "Kaspa node accepted and broadcast the payment transaction.",
    });
    changed = true;
  }
  return changed;
}

function normalizeKasAmount(value) {
  const cleaned = String(value || "").trim().replace(",", ".");
  if (!/^\d*(?:\.\d{0,8})?$/.test(cleaned)) throw new Error("Enter a valid KAS amount with up to 8 decimals.");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than 0.");
  return cleaned;
}

async function sendKasPayment(conversationId, rawAmount) {
  if (paymentSendInFlight) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) throw new Error("Conversation contact was unavailable.");
  const amountKas = normalizeKasAmount(rawAmount);
  paymentSendInFlight = true;
  const input = composer.elements.message;
  const submitButton = composer.querySelector(".composer-send");
  if (submitButton) submitButton.disabled = true;
  try {
    // Funding source follows the per-account Chats Payment Privacy toggle
    // (iOS paymentFundingSourceAddress): ON funds from the PRIMARY SPENDING
    // address (falling back to the chatting address only if this account has
    // no stored mnemonic to derive from), OFF is chatting-to-chatting end to
    // end. The balance guard checks the same source the send will use.
    const privacyOn = chatsPrivacyEnabled();
    const fundingIndex = getActiveSpendingIndex();
    const fundingAddress = privacyOn && activeAccountMnemonic() ? deriveSpendingAddressAt(fundingIndex) : null;
    const spendingFunded = Boolean(fundingAddress);
    const balance = spendingFunded ? await engine.balanceForAddress(fundingAddress) : await engine.balance();
    if (!spendingFunded) currentBalanceKas = balance.totalKas;
    const requestedSompi = BigInt(Math.round(Number(amountKas) * 1e8));
    const feeReserveSompi = 10000n;
    if (requestedSompi + feeReserveSompi > balance.totalSompi) {
      await showKasPaymentAlert({
        title: "Not Enough KAS",
        message: `Planned spend ${amountKas} KAS, but available balance ${balance.totalKas} KAS is less than required after the network fee.`,
        primaryLabel: "OK",
      });
      return;
    }
    if (Number(amountKas) < 0.1) {
      const proceed = await showKasPaymentAlert({
        title: "Small Amount",
        message: "Sending less than 0.1 KAS may fail due to the network dust protection limit.",
        primaryLabel: "Send Anyway", cancelLabel: "Cancel", allowCancel: true,
      });
      if (!proceed) return;
    }
    // Fresh-address payment pools: consume the contact's next unused pool
    // address (persisted immediately — a consumed address is never offered to
    // a payment again, even if this payment ultimately fails), chatting
    // address fallback. Recipient-governed: their shared fresh addresses are
    // used no matter the sender's privacy toggle.
    const destinationAddress = await consumePoolPaymentDestination(contact);
    const createdAt = Date.now();
    const message = createMessage({
      conversationId: conversationEntry.id,
      contactId: contact.id,
      direction: "outgoing",
      text: `Sent ${amountKas} KAS`,
      sender: engine.address || null,
      receiver: destinationAddress,
      status: MESSAGE_STATUSES.PENDING,
      transport: "kaspa-payment",
      createdAt,
    });
    applyMessagePatch(message, { messageType: "payment", paymentAmountKas: amountKas });
    appendIncomingOrReactionMessage(conversationEntry, message);
    persistState();
    renderMessages(conversationEntry);
    // renderMessages hydrates and replaces message objects. Keep working with
    // the canonical object now stored in the conversation, not the stale local
    // reference created above.
    const liveMessage = conversationEntry.messages.find((entry) => entry.id === message.id) || message;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setStatus(`Sending ${amountKas} KAS…`);

    try {
      const result = spendingFunded
        ? await engine.sendFromSpending({
            mnemonic: activeAccountMnemonic(),
            index: fundingIndex,
            passphrase: activeAccountPassphrase(),
            destinationAddress,
            amountKas,
            feeKas: "0",
          })
        : await engine.send(destinationAddress, amountKas, "0");
      const submittedTxids = (result?.txids || []).map((value) => String(value || "").trim()).filter(Boolean);
      const txid = submittedTxids.at(-1) || submittedTxids[0] || null;
      if (!txid) throw new Error("Kaspa node accepted the send request but did not return a transaction ID.");
      const verifiedTxid = await verifyKasPaymentBroadcast(submittedTxids, destinationAddress, amountKas);
      applyMessagePatch(liveMessage, {
        status: MESSAGE_STATUSES.CONFIRMED,
        txid: verifiedTxid || txid,
        confirmations: verifiedTxid ? 1 : 0,
        network: "mainnet",
        note: verifiedTxid
          ? "Kaspa payment verified at recipient output."
          : "Kaspa node accepted and broadcast the payment transaction.",
      });
      setStatus(`Payment sent · ${(verifiedTxid || txid).slice(0, 12)}…`);
      // Pool payments never touch the recipient's chatting address — send the
      // payment_notice so their chat still shows the bubble, then top up our
      // stored pool if it ran low. No-op for chatting-address payments.
      handlePoolPaymentSubmitted(contact, verifiedTxid || txid, Number(requestedSompi), destinationAddress);
      await refreshBalanceOnly({ quiet: true });
      refreshComposerAvailableBalance();
    } catch (error) {
      applyMessagePatch(liveMessage, { status: MESSAGE_STATUSES.FAILED, note: error.message });
      setStatus(`Payment failed: ${error.message}`);
    }
    conversationEntry.updatedAt = Date.now();
    persistState();
    renderMessages(conversationEntry);
  } finally {
    paymentSendInFlight = false;
    if (submitButton) submitButton.disabled = false;
    input?.focus();
  }
}

if (composerPlusButton && composerPlusMenu) {
  composerPlusButton.addEventListener("click", () => {
    const tcMenu = document.querySelector("[data-chess-tc-menu]");
    // The plus button always returns to step one of the menu, never leaves the chess
    // time-control step stranded behind it.
    if (tcMenu && !tcMenu.hidden) { tcMenu.hidden = true; composerPlusMenu.hidden = true; return; }
    composerPlusMenu.hidden = !composerPlusMenu.hidden;
  });
}

// --- Chess over chat (Stage 3): game state is re-derived from the conversation's
// chess-envelope messages via engine/chess.js; moves/invite/response/resign are
// sent as ordinary encrypted messages. ---
const chessOverlay = document.querySelector("[data-chess-overlay]");
const chessBoardEl = document.querySelector("[data-chess-board]");
const chessFilesTop = document.querySelector("[data-chess-files-top]");
const chessFilesBottom = document.querySelector("[data-chess-files-bottom]");
const chessRanksLeft = document.querySelector("[data-chess-ranks-left]");
const chessRanksRight = document.querySelector("[data-chess-ranks-right]");
const chessWaitingEl = document.querySelector("[data-chess-waiting]");
const chessWaitingTextEl = document.querySelector("[data-chess-waiting-text]");
let chessWaitingTimer = 0;
let chessWaitingDots = 1;
function updateChessWaiting() {
  if (!chessWaitingEl) return;
  const s = chessState?.summary;
  const waiting = !!s && s.status.kind === "inProgress" && s.viewerColor && s.board.sideToMove !== s.viewerColor;
  if (waiting) {
    chessWaitingEl.hidden = false;
    if (!chessWaitingTimer) {
      chessWaitingDots = 1;
      if (chessWaitingTextEl) chessWaitingTextEl.textContent = "Waiting on opponent" + ".".repeat(chessWaitingDots);
      // Cycle 1→2→3 dots like a typing indicator so it doesn't look frozen.
      chessWaitingTimer = window.setInterval(() => {
        chessWaitingDots = (chessWaitingDots % 3) + 1;
        if (chessWaitingTextEl) chessWaitingTextEl.textContent = "Waiting on opponent" + ".".repeat(chessWaitingDots);
      }, 500);
    }
  } else {
    chessWaitingEl.hidden = true;
    if (chessWaitingTimer) { clearInterval(chessWaitingTimer); chessWaitingTimer = 0; }
  }
}
const chessStatusEl = document.querySelector("[data-chess-status]");
const chessCapturedTop = document.querySelector("[data-chess-captured-top]");
const chessCapturedBottom = document.querySelector("[data-chess-captured-bottom]");
const chessResignBtn = document.querySelector("[data-chess-resign]");
const chessPromoEl = document.querySelector("[data-chess-promo]");
const chessPromoOptions = document.querySelector("[data-chess-promo-options]");
const chessActionsEl = document.querySelector("[data-chess-actions]");
const chessRecordEl = document.querySelector("[data-chess-record]");
const chessChatEl = document.querySelector("[data-chess-chat]");
const chessChatForm = document.querySelector("[data-chess-composer]");
const chessChatInput = document.querySelector("[data-chess-chat-input]");
const chessClockThemEl = document.querySelector("[data-chess-clock-them]");
const chessClockThemValue = document.querySelector("[data-chess-clock-them-value]");
const chessClockMeEl = document.querySelector("[data-chess-clock-me]");
const chessClockMeValue = document.querySelector("[data-chess-clock-me-value]");
const chessTcMenu = document.querySelector("[data-chess-tc-menu]");
// { gameId, summary, selected, legalDests, pendingPromo, turnMoveCount, turnElapsedMs,
//   lastTick, timeoutSent }
let chessState = null;

// --- Timed games: local clock bookkeeping (port of iOS ChessClockStore + ChessGameView) ---
//
// Timed chess here is deliberately casual: a side's clock runs ONLY while the board is open on
// their device AND it is their turn AND the game is in progress — the opponent may be offline
// for hours, so the clock measures thinking time at the board, not wall time. The opponent's
// clock is never ticked speculatively; it just shows the clockMs they last reported on a move.
//
// This persists the local player's accumulated thinking time for their CURRENT turn, keyed to
// the move count it applies to, so a reload mid-think doesn't hand the time back. The moment
// either side's move lands the stored move count no longer matches and the elapsed time reads
// back as 0 — which is exactly the reset-on-new-turn behaviour the clock needs.
const CHESS_CLOCK_KEY = "kachat-chess-clocks-v1";
let chessClocks = (() => { try { return JSON.parse(localStorage.getItem(CHESS_CLOCK_KEY) || "{}") || {}; } catch { return {}; } })();
function saveChessClocks() { try { localStorage.setItem(CHESS_CLOCK_KEY, JSON.stringify(chessClocks)); } catch {} }
function chessClockElapsedMs(gameId, moveCount) {
  const record = chessClocks[gameId];
  if (!record || record.moveCount !== moveCount) return 0;
  return Math.max(Number(record.elapsedMs) || 0, 0);
}
function setChessClockElapsedMs(gameId, moveCount, elapsedMs) {
  chessClocks[gameId] = { moveCount, elapsedMs: Math.max(Math.round(elapsedMs), 0) };
  saveChessClocks();
}
// Finished games leave nothing behind.
function clearChessClock(gameId) {
  if (!(gameId in chessClocks)) return;
  delete chessClocks[gameId];
  saveChessClocks();
}

let chessClockTimer = 0;
const CHESS_CLOCK_TICK_MS = 200;

function chessMyBaseClockMs() {
  const s = chessState?.summary;
  if (!s?.timeControl || !s.viewerColor) return null;
  return s.viewerColor === "white" ? s.whiteClockMs : s.blackClockMs;
}
function chessOpponentClockMs() {
  const s = chessState?.summary;
  if (!s?.timeControl) return null;
  return opposite2(s.viewerColor || "white") === "white" ? s.whiteClockMs : s.blackClockMs;
}
// My chip: authoritative base (clockMs from my own last move, else the initial allotment) minus
// the open-board thinking time accumulated this turn.
function chessMyDisplayClockMs() {
  const base = chessMyBaseClockMs();
  if (base == null) return null;
  return Math.max(base - (chessState?.turnElapsedMs || 0), 0);
}
function chessMyClockRunning() {
  const s = chessState?.summary;
  if (!s?.timeControl || chessState.timeoutSent) return false;
  return s.status.kind === "inProgress" && !!s.viewerColor && s.board.sideToMove === s.viewerColor;
}

// (Re)binds the turn's elapsed-time counter whenever the move count changes — on open, on a
// reload (reads the persisted record back) and after either side moves (reads back 0).
function syncChessTurnElapsed() {
  const s = chessState?.summary;
  if (!s) return;
  if (!s.timeControl) { chessState.turnMoveCount = -1; chessState.turnElapsedMs = 0; chessState.lastTick = 0; return; }
  if (Chess.isChessGameOver(s.status)) {
    clearChessClock(chessState.gameId);
    chessState.turnMoveCount = -1;
    chessState.turnElapsedMs = 0;
    chessState.lastTick = 0;
    return;
  }
  const moveCount = s.moveHistory.length;
  if (chessState.turnMoveCount === moveCount) return;
  chessState.turnMoveCount = moveCount;
  chessState.turnElapsedMs = chessClockElapsedMs(chessState.gameId, moveCount);
  chessState.lastTick = 0;
}

function tickChessClock() {
  const s = chessState?.summary;
  if (!s?.timeControl || Chess.isChessGameOver(s.status)) { if (chessState) chessState.lastTick = 0; return; }
  if (!chessMyClockRunning()) { chessState.lastTick = 0; return; }
  const now = Date.now();
  if (chessState.lastTick) {
    const delta = now - chessState.lastTick;
    // A delta far beyond the tick cadence means the page was frozen (tab backgrounded, machine
    // asleep) — that gap is away-from-the-board time and must NOT count as thinking time.
    if (delta > 0 && delta < 2000) {
      chessState.turnElapsedMs += delta;
      setChessClockElapsedMs(chessState.gameId, s.moveHistory.length, chessState.turnElapsedMs);
    }
  }
  chessState.lastTick = now;
  renderChessClocks();
  if ((chessMyDisplayClockMs() ?? 1) <= 0) sendChessTimeoutResign();
}

function startChessClockTimer() {
  if (chessClockTimer) return;
  chessClockTimer = window.setInterval(tickChessClock, CHESS_CLOCK_TICK_MS);
}
function stopChessClockTimer() {
  if (!chessClockTimer) return;
  clearInterval(chessClockTimer);
  chessClockTimer = 0;
}

// Flagging: my clock hit zero on my turn. Sends exactly one resign carrying reason "timeout";
// the result then renders through the normal derived-state pipeline ("You lost on time").
function sendChessTimeoutResign() {
  if (!chessState || chessState.timeoutSent) return;
  chessState.timeoutSent = true;
  chessState.selected = null;
  chessState.legalDests = [];
  chessSendEnvelope(Chess.chessResign(chessState.gameId, "timeout"));
  clearChessClock(chessState.gameId);
  refreshChessOverlay();
}

function renderChessClocks() {
  const s = chessState?.summary;
  const tc = s?.timeControl || null;
  const paint = (wrap, valueEl, ms, isActive) => {
    if (!wrap) return;
    if (!tc) { wrap.style.display = "none"; return; }
    wrap.style.display = "flex";
    wrap.style.opacity = isActive ? "1" : ".55";
    wrap.style.borderColor = isActive ? "var(--kaspa-ink)" : "var(--line)";
    if (valueEl) valueEl.textContent = Chess.formatChessClock(ms || 0);
  };
  const inProgress = !!s && s.status.kind === "inProgress";
  const myTurn = inProgress && !!s.viewerColor && s.board.sideToMove === s.viewerColor;
  paint(chessClockThemEl, chessClockThemValue, chessOpponentClockMs(), inProgress && !myTurn);
  paint(chessClockMeEl, chessClockMeValue, chessMyDisplayClockMs(), inProgress && myTurn);
}

// Recent conversation messages (chess envelopes excluded) shown inside the board
// so you can keep chatting while playing.
function renderChessChat() {
  if (!chessChatEl) return;
  const conv = state.conversations.find((entry) => entry.id === activeConversationId);
  chessChatEl.replaceChildren();
  if (!conv) return;
  const recent = (conv.messages || [])
    .filter((m) => m.text && !Chess.isChessEnvelope(Chess.unwrapReplyText(m.text)))
    .slice(-40);
  for (const m of recent) {
    const row = document.createElement("div");
    row.className = `chess-chat-msg ${m.direction === "outgoing" ? "outgoing" : "incoming"}`;
    row.textContent = displayTextForMessage(m);
    chessChatEl.appendChild(row);
  }
  chessChatEl.scrollTop = chessChatEl.scrollHeight;
}
chessChatForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = String(chessChatInput?.value || "").trim();
  if (!text || !activeConversationId) return;
  chessChatInput.value = "";
  queueConversationMessage(activeConversationId, text);
  renderChessChat();
});

function renderChessRecord() {
  if (!chessRecordEl) return;
  const { contact, messages } = chessConversationContext();
  if (!contact || !engine.address) { chessRecordEl.hidden = true; return; }
  const rec = Chess.chessRecord(messages, engine.address, contact.address);
  chessRecordEl.textContent = `W ${rec.wins} · L ${rec.losses}`;
  chessRecordEl.hidden = false;
}

function chessConversationContext() {
  const conv = state.conversations.find((entry) => entry.id === activeConversationId);
  if (!conv) return { conv: null, contact: null, messages: [] };
  const contact = contactForConversation(conv);
  const messages = (conv.messages || []).map((m) => ({
    text: m.text, outgoing: m.direction === "outgoing", txid: m.txid || m.id, at: m.createdAt || 0,
  }));
  return { conv, contact, messages };
}
function chessSendEnvelope(content) {
  if (!activeConversationId || !content) return;
  queueConversationMessage(activeConversationId, content);
}

// `timeControl` is { minutes, incSeconds } for a timed invite, or null for a casual untimed one
// (which sends the exact legacy envelope). It only applies when this call actually creates the
// invite; opening an existing game keeps whatever time control that game was started with.
function openChessGame(preferGameId = null, timeControl = null) {
  const { contact, messages } = chessConversationContext();
  if (!contact?.address || !engine.address) { showCopyToast("Open a 1:1 chat to play chess."); return; }
  let summary = preferGameId
    ? Chess.summarizeChessGame(preferGameId, messages, engine.address, contact.address)
    : Chess.activeChessGame(messages, engine.address, contact.address);
  if (!summary && !preferGameId) {
    // No active game — invite the contact (random color), then open the pending board.
    const gameId = Chess.newGameId();
    chessSendEnvelope(Chess.chessInvite(
      gameId,
      Math.random() < 0.5 ? "white" : "black",
      timeControl?.minutes ?? null,
      timeControl?.incSeconds ?? null,
    ));
    const after = chessConversationContext();
    summary = Chess.summarizeChessGame(gameId, after.messages, engine.address, contact.address);
  }
  if (!summary) { showCopyToast("Could not open the chess game."); return; }
  chessState = {
    gameId: summary.gameId, summary, selected: null, legalDests: [], pendingPromo: null,
    turnMoveCount: null, turnElapsedMs: 0, lastTick: 0, timeoutSent: false,
  };
  syncChessTurnElapsed();
  if (chessPromoEl) chessPromoEl.hidden = true;
  renderChess();
  if (chessOverlay) chessOverlay.hidden = false;
  startChessClockTimer();
}
function closeChess() {
  if (chessOverlay) chessOverlay.hidden = true;
  chessState = null;
  stopChessClockTimer();
  if (chessWaitingTimer) { clearInterval(chessWaitingTimer); chessWaitingTimer = 0; }
  if (chessWaitingEl) chessWaitingEl.hidden = true;
}

// Small live board thumbnail for the latest chess message in the chat.
function buildChessThumb(summary, gameId) {
  const wrap = document.createElement("button");
  wrap.type = "button";
  wrap.className = "chess-thumb";
  const boardEl = document.createElement("div");
  boardEl.className = "chess-thumb-board";
  const orient = summary.viewerColor || "white";
  const ranks = orient === "white" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = orient === "white" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  for (const rank of ranks) {
    for (const file of files) {
      const cell = document.createElement("div");
      cell.className = `chess-thumb-sq ${(file + rank) % 2 !== 0 ? "light" : "dark"}`;
      const piece = summary.board.squares[rank][file];
      if (piece) {
        const span = document.createElement("span");
        span.className = `chess-piece ${piece.color}`;
        span.textContent = Chess.PIECE_GLYPHS[piece.type];
        cell.appendChild(span);
      }
      boardEl.appendChild(cell);
    }
  }
  const status = document.createElement("span");
  status.className = "chess-thumb-status";
  // "3 | 2" chip alongside the status while a timed game is still live (the iOS invite bubble
  // shows the same label); once it is over the time control is no longer news.
  const tcLabel = Chess.isChessGameOver(summary.status) ? null : Chess.chessTimeControlLabel(summary.timeControl);
  status.textContent = tcLabel
    ? `${Chess.chessSummaryStatusText(summary)} - ${tcLabel}`
    : Chess.chessSummaryStatusText(summary);
  if (summary.status.kind === "inProgress" && summary.viewerColor && summary.board.sideToMove === summary.viewerColor) status.classList.add("you");
  wrap.append(boardEl, status);
  wrap.addEventListener("click", (event) => { event.stopPropagation(); openChessGame(gameId); });
  return wrap;
}

function chessInteractive() {
  const s = chessState?.summary;
  if (!s || s.status.kind !== "inProgress" || !s.viewerColor || s.board.sideToMove !== s.viewerColor) return false;
  // Flagged: input is blocked from the moment my clock hits zero until the timeout resign lands.
  if (chessState.timeoutSent) return false;
  const remaining = chessMyDisplayClockMs();
  return remaining == null || remaining > 0;
}
function chessOrientation() { return chessState?.summary?.viewerColor || "white"; }

function renderChessStatus() {
  const s = chessState.summary;
  const over = Chess.isChessGameOver(s.status);
  if (chessStatusEl) {
    chessStatusEl.textContent = Chess.chessSummaryStatusText(s);
    chessStatusEl.classList.toggle("over", over);
    chessStatusEl.classList.toggle("check", !over && s.status.kind === "inProgress" && Chess.isKingInCheck(s.board, s.board.sideToMove));
  }
  // Available for the whole life of the game, not just once play has begun — the inviter must
  // be able to close a game the opponent has not answered (matches iOS ChessGameView, which
  // labels the same control "Cancel game" while the invite is still pending).
  if (chessResignBtn) {
    chessResignBtn.disabled = over;
    chessResignBtn.textContent = s.status.kind === "pendingResponse" ? "Cancel game" : "Resign";
  }
  // Accept/Decline only when an incoming invite awaits my response.
  const awaitingMyResponse = s.status.kind === "pendingResponse" && !s.iAmInviter;
  if (chessActionsEl) chessActionsEl.hidden = !awaitingMyResponse;
}
function renderChessBoard() {
  if (!chessBoardEl) return;
  chessBoardEl.replaceChildren();
  const b = chessState.summary.board;
  const orient = chessOrientation();
  const ranks = orient === "white" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = orient === "white" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  // Coordinate labels around the board (a–h top & bottom, 1–8 left & right), in
  // the current orientation's order — matches iOS's board frame.
  const fillLabels = (el, values, toLabel) => {
    if (!el) return;
    el.replaceChildren();
    for (const v of values) { const span = document.createElement("span"); span.textContent = toLabel(v); el.appendChild(span); }
  };
  fillLabels(chessFilesTop, files, (f) => String.fromCharCode(97 + f));
  fillLabels(chessFilesBottom, files, (f) => String.fromCharCode(97 + f));
  fillLabels(chessRanksLeft, ranks, (r) => String(r + 1));
  fillLabels(chessRanksRight, ranks, (r) => String(r + 1));
  const legalKeys = new Set(chessState.legalDests.map((sqr) => `${sqr.file},${sqr.rank}`));
  const last = chessState.summary.moveHistory.at(-1);
  const sel = chessState.selected;
  for (const rank of ranks) {
    for (const file of files) {
      const cell = document.createElement("div");
      cell.className = `chess-sq ${(file + rank) % 2 !== 0 ? "light" : "dark"}`;
      if (sel && sel.file === file && sel.rank === rank) cell.classList.add("selected");
      if (last && ((last.from.file === file && last.from.rank === rank) || (last.to.file === file && last.to.rank === rank))) cell.classList.add("last");
      const piece = b.squares[rank][file];
      if (piece) {
        const span = document.createElement("span");
        span.className = `chess-piece ${piece.color}`;
        span.textContent = Chess.PIECE_GLYPHS[piece.type];
        cell.appendChild(span);
      }
      if (legalKeys.has(`${file},${rank}`)) {
        const dot = document.createElement("span");
        dot.className = "chess-dot" + (piece ? " capture" : "");
        cell.appendChild(dot);
      }
      const square = { file, rank };
      cell.addEventListener("click", () => handleChessTap(square));
      chessBoardEl.appendChild(cell);
    }
  }
}
function renderChessCaptured() {
  const s = chessState.summary;
  const viewer = s.viewerColor || "white";
  const takenFromMe = viewer === "white" ? s.capturedByBlack : s.capturedByWhite;
  const takenByMe = viewer === "white" ? s.capturedByWhite : s.capturedByBlack;
  const fill = (el, pieces, color) => {
    if (!el) return;
    el.replaceChildren();
    for (const t of pieces) { const span = document.createElement("span"); span.className = `cap-piece ${color}`; span.textContent = Chess.PIECE_GLYPHS[t]; el.appendChild(span); }
  };
  fill(chessCapturedTop, takenFromMe, opposite2(viewer));   // opponent's captures (my lost pieces)
  fill(chessCapturedBottom, takenByMe, viewer);
}
function opposite2(c) { return c === "white" ? "black" : "white"; }
function renderChess() { renderChessStatus(); renderChessRecord(); renderChessCaptured(); renderChessClocks(); renderChessBoard(); updateChessWaiting(); renderChessChat(); }

function selectChessSquare(square) {
  chessState.selected = square;
  chessState.legalDests = Chess.legalMovesFrom(chessState.summary.board, square).map((m) => m.to);
  renderChessBoard();
}
function doChessMove(move) {
  const from = Chess.algebraic(move.from);
  const to = Chess.algebraic(move.to);
  const promo = move.promotion ? Chess.promotionLetter(move.promotion) : null;
  chessState.selected = null;
  chessState.legalDests = [];
  // Timed games: stamp the move with my remaining clock AFTER the move, increment already added
  // — the opponent reads their view of my clock straight off this field. Untimed games send no
  // clockMs at all, which is exactly the legacy envelope shape.
  const tc = chessState.summary?.timeControl || null;
  const remaining = chessMyDisplayClockMs();
  const clockMs = tc && remaining != null ? remaining + tc.incSeconds * 1000 : null;
  chessState.lastTick = 0;
  chessSendEnvelope(Chess.chessMove(chessState.gameId, from, to, promo, clockMs));
  refreshChessOverlay();
}
function showChessPromo(color) {
  if (!chessPromoOptions || !chessPromoEl) return;
  chessPromoOptions.replaceChildren();
  for (const t of ["queen", "rook", "bishop", "knight"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = color;
    btn.textContent = Chess.PIECE_GLYPHS[t];
    btn.addEventListener("click", () => {
      const move = { ...chessState.pendingPromo, promotion: t };
      chessState.pendingPromo = null;
      chessPromoEl.hidden = true;
      doChessMove(move);
    });
    chessPromoOptions.appendChild(btn);
  }
  chessPromoEl.hidden = false;
}
function handleChessTap(square) {
  if (!chessState || chessState.pendingPromo || !chessInteractive()) return;
  const b = chessState.summary.board;
  const legalKeys = new Set(chessState.legalDests.map((sqr) => `${sqr.file},${sqr.rank}`));
  if (chessState.selected) {
    if (legalKeys.has(`${square.file},${square.rank}`)) {
      const piece = Chess.pieceAt(b, chessState.selected);
      const backRank = piece.color === "white" ? 7 : 0;
      const candidate = { from: chessState.selected, to: square, promotion: null };
      if (piece.type === "pawn" && square.rank === backRank) {
        chessState.pendingPromo = candidate;
        chessState.selected = null; chessState.legalDests = [];
        renderChessBoard();
        showChessPromo(piece.color);
        return;
      }
      doChessMove(candidate);
      return;
    }
    const piece = Chess.pieceAt(b, square);
    if (piece && piece.color === b.sideToMove) selectChessSquare(square);
    else { chessState.selected = null; chessState.legalDests = []; renderChessBoard(); }
    return;
  }
  const piece = Chess.pieceAt(b, square);
  if (piece && piece.color === b.sideToMove) selectChessSquare(square);
}
function resignChess() {
  if (!chessState) return;
  const s = chessState.summary;
  // A pending invite is resignable too — that is how the inviter cancels it.
  if (Chess.isChessGameOver(s.status)) return;
  chessSendEnvelope(Chess.chessResign(chessState.gameId));
  clearChessClock(chessState.gameId);
  refreshChessOverlay();
}
// Re-derive the bound game from the latest conversation messages and re-render.
function refreshChessOverlay() {
  if (!chessState || !chessOverlay || chessOverlay.hidden) return;
  const { contact, messages } = chessConversationContext();
  if (!contact) return;
  const summary = Chess.summarizeChessGame(chessState.gameId, messages, engine.address, contact.address);
  if (summary) { chessState.summary = summary; syncChessTurnElapsed(); renderChess(); }
}

// "Play Chess" opens a second menu to pick a time control first (matching iOS's second
// confirmation dialog). The blitz presets put tcMinutes/tcIncSeconds on the invite; "Casual"
// omits them entirely, which is the exact legacy wire shape.
document.querySelectorAll("[data-chess-open]").forEach((btn) => btn.addEventListener("click", () => {
  if (composerPlusMenu) composerPlusMenu.hidden = true;
  if (chessTcMenu) chessTcMenu.hidden = false;
  else openChessGame();
}));
chessTcMenu?.querySelectorAll("[data-chess-tc]").forEach((btn) => btn.addEventListener("click", () => {
  chessTcMenu.hidden = true;
  const raw = String(btn.dataset.chessTc || "").trim();
  if (!raw || raw === "casual") { openChessGame(null, null); return; }
  const [minutes, inc] = raw.split("|").map((part) => Number(part.trim()));
  openChessGame(null, Number.isFinite(minutes) && minutes > 0
    ? { minutes, incSeconds: Number.isFinite(inc) ? inc : 0 }
    : null);
}));
document.querySelector("[data-chess-close]")?.addEventListener("click", closeChess);
chessResignBtn?.addEventListener("click", resignChess);
document.querySelector("[data-chess-accept]")?.addEventListener("click", () => {
  if (chessState) { chessSendEnvelope(Chess.chessResponse(chessState.gameId, true)); refreshChessOverlay(); }
});
document.querySelector("[data-chess-decline]")?.addEventListener("click", () => {
  if (chessState) { chessSendEnvelope(Chess.chessResponse(chessState.gameId, false)); refreshChessOverlay(); }
});
chessOverlay?.addEventListener("click", (event) => { if (event.target === chessOverlay) closeChess(); });

// Photos ride the ordinary ciph_msg:1:comm: COMM payload as a JSON envelope
// (see buildImageEnvelopeJson below) — there is no separate wire type, and
// this compression pipeline matches iOS/Android's ImagePrep exactly: JPEG
// only (WebP/AVIF were deliberately rejected upstream for cross-platform
// decode reliability), longest edge capped at 1280px, quality binary-searched
// down to a byte budget, and if even the lowest quality still overshoots,
// the longest edge is shrunk by 0.7x (up to 4 times) and retried. Unlike text
// messages there is no rejection path — the lowest-quality result is sent
// even if it's still over budget, matching iOS's explicit "never reject" design.
const PHOTO_MAX_DIMENSION = 1280;
const PHOTO_DEFAULT_TARGET_BYTES = 15000;
const PHOTO_MAX_SHRINK_ATTEMPTS = 4;
const PHOTO_SHRINK_FACTOR = 0.7;

// Chats > Photo Quality: user-selectable send compression budget, mirroring iOS's
// ChatPhotoQualityPreset (Data Saver / Balanced / High / Best with the same target
// byte budgets). Only affects photos you SEND; received photos are untouched.
const PHOTO_QUALITY_KEY = "kachat-photo-quality-preset";
const PHOTO_QUALITY_PRESETS = [
  { id: "dataSaver", name: "Data Saver", bytes: 10000 },
  { id: "balanced", name: "Balanced", bytes: 15000 },
  { id: "high", name: "High", bytes: 31000 },
  { id: "best", name: "Best", bytes: 50000 },
];
const PHOTO_QUALITY_DEFAULT_ID = "balanced";
function photoQualityPresetById(id) {
  return PHOTO_QUALITY_PRESETS.find((p) => p.id === id) || PHOTO_QUALITY_PRESETS[1];
}
function getPhotoQualityPresetId() {
  try {
    const stored = localStorage.getItem(PHOTO_QUALITY_KEY);
    if (stored && PHOTO_QUALITY_PRESETS.some((p) => p.id === stored)) return stored;
  } catch {}
  return PHOTO_QUALITY_DEFAULT_ID;
}
function setPhotoQualityPresetId(id) {
  if (!PHOTO_QUALITY_PRESETS.some((p) => p.id === id)) return;
  try { localStorage.setItem(PHOTO_QUALITY_KEY, id); } catch {}
}
function photoQualityTargetBytes() {
  return photoQualityPresetById(getPhotoQualityPresetId()).bytes;
}
function photoQualitySummary(preset) {
  return `${preset.name} · ~${Math.round(preset.bytes / 1000)} KB`;
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
    img.src = url;
  });
}

function dataUrlByteLength(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.ceil(base64.length * 3 / 4);
}

function drawScaledCanvas(image, longestEdge) {
  const scale = Math.min(1, longestEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  return { canvas, width, height };
}

// Binary-searches JPEG quality in [0.05, 0.95] over 8 iterations for the
// highest quality that still fits targetBytes. Returns the best-effort
// result (possibly still over budget) rather than null, since the caller
// always needs something to shrink-and-retry or send as a last resort.
function compressCanvasToBudget(canvas, targetBytes) {
  let low = 0.05;
  let high = 0.95;
  let best = { dataUrl: canvas.toDataURL("image/jpeg", low), quality: low };
  best.bytes = dataUrlByteLength(best.dataUrl);
  if (best.bytes > targetBytes) return best;
  for (let i = 0; i < 8; i += 1) {
    const mid = (low + high) / 2;
    const dataUrl = canvas.toDataURL("image/jpeg", mid);
    const bytes = dataUrlByteLength(dataUrl);
    if (bytes <= targetBytes) { best = { dataUrl, bytes, quality: mid }; low = mid; }
    else high = mid;
  }
  return best;
}

async function compressImageBlob(blob, { targetBytes = photoQualityTargetBytes(), maxDimension = PHOTO_MAX_DIMENSION } = {}) {
  const image = await loadImageFromBlob(blob);
  let dimension = maxDimension;
  let result = null;

  for (let attempt = 0; attempt <= PHOTO_MAX_SHRINK_ATTEMPTS; attempt += 1) {
    const { canvas, width, height } = drawScaledCanvas(image, dimension);
    const compressed = compressCanvasToBudget(canvas, targetBytes);
    result = { dataUrl: compressed.dataUrl, bytes: compressed.bytes, width, height };
    if (compressed.bytes <= targetBytes || attempt === PHOTO_MAX_SHRINK_ATTEMPTS) break;
    dimension = Math.round(dimension * PHOTO_SHRINK_FACTOR);
  }
  return result;
}

function clearPendingPhoto() {
  pendingPhotoAttachment = null;
  if (pendingPhotoPreview) pendingPhotoPreview.hidden = true;
  if (pendingPhotoThumb) pendingPhotoThumb.src = "";
  if (photoFileInput) photoFileInput.value = "";
}

function setPendingPhoto(attachment) {
  pendingPhotoAttachment = attachment;
  if (pendingPhotoThumb) pendingPhotoThumb.src = attachment.dataUrl;
  const overBudget = attachment.bytes > photoQualityTargetBytes();
  if (pendingPhotoMeta) {
    pendingPhotoMeta.textContent = `Photo · ${attachment.width}×${attachment.height} · ${(attachment.bytes / 1024).toFixed(1)} KB${overBudget ? " · larger fee" : ""}`;
  }
  if (pendingPhotoPreview) pendingPhotoPreview.hidden = false;
  composer.elements.message?.focus();
}

async function attachPhotoBlob(blob) {
  setStatus("Compressing photo…");
  try {
    const attachment = await compressImageBlob(blob);
    // Kept alongside the compressed envelope version so "Send Media via Nextcloud" can
    // upload the ORIGINAL full-quality file instead of the payload-sized recompression.
    attachment.originalBlob = blob;
    attachment.originalName = blob.name || "photo.jpg";
    setPendingPhoto(attachment);
    setStatus(`Photo ready · ${(attachment.bytes / 1024).toFixed(1)} KB`);
  } catch (error) {
    showCopyToast(error.message || "Could not attach that photo.");
  }
}

// Matches iOS's ChatService+Conversations.sendImage / Android's ImageMessage
// exactly: photos are NOT a distinct wire type. This JSON string is sent as
// the plaintext of an ordinary ciph_msg:1:comm: COMM message, the same way a
// text message is — only the JSON shape signals "this is a photo" to the
// receiving client. `type` must be the literal string "file".
function buildImageEnvelopeJson(attachment, fileName = "photo.jpg") {
  return JSON.stringify({
    type: "file",
    name: fileName,
    size: attachment.bytes,
    mimeType: "image/jpeg",
    content: attachment.dataUrl,
  });
}

// --- Voice messages ----------------------------------------------------
// Matches iOS's sendAudio exactly: reuses the same {type:"file",...} JSON
// envelope as photos — the mimeType prefix ("audio/" vs "image/") is the
// only thing that distinguishes a voice message, there is no separate wire
// type. Recording uses the browser's native MediaRecorder producing real
// audio/webm;codecs=opus, which iOS's own custom WebM/Opus muxer can decode
// and play — the formats are wire-compatible even though this side doesn't
// need a hand-rolled encoder to produce them.

const VOICE_MAX_DURATION_SECONDS = 10; // on-chain payload cap
// Nextcloud-uploaded voice notes aren't payload-bound — the server carries them.
const VOICE_MAX_DURATION_NEXTCLOUD_SECONDS = 600;
function voiceMaxDurationSeconds() {
  return isNextcloudMediaSendActive() ? VOICE_MAX_DURATION_NEXTCLOUD_SECONDS : VOICE_MAX_DURATION_SECONDS;
}
const VOICE_AUDIO_BITS_PER_SECOND = 8000;

const voiceRecordingPanel = document.querySelector("[data-voice-recording-panel]");
const voiceRecordingTimeEl = document.querySelector("[data-voice-recording-time]");

function formatRecordingTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pickVoiceMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const candidate of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(candidate)) return candidate;
  }
  return "";
}

// Generic MediaRecorder wrapper shared by the 1:1 composer and the broadcast
// composer (handed to initBroadcasts via deps). Owns the stream, chunk
// collection, the elapsed timer and the max-duration auto-stop; presentation
// (panel visibility, timer text) and what happens to the finished blob stay
// with the caller.
function createVoiceRecorder({ maxDurationSeconds, onElapsed, onFinish }) {
  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;
  let timer = null;
  let cancelled = false;

  function clearTimer() {
    if (timer) { window.clearInterval(timer); timer = null; }
  }

  function handleStopped() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    clearTimer();
    const mimeType = recorder?.mimeType || "audio/webm";
    const recorded = chunks;
    recorder = null;
    chunks = [];
    const blob = recorded.length ? new Blob(recorded, { type: mimeType }) : null;
    onFinish?.({ blob, mimeType, cancelled });
  }

  /** Starts recording. Returns an error string for the caller to toast, or null on success. */
  async function start() {
    if (recorder) return null;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return "Voice recording isn't supported in this browser.";
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return "Microphone access was denied.";
    }
    const mimeType = pickVoiceMimeType();
    chunks = [];
    cancelled = false;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND } : undefined);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return "Could not start voice recording.";
    }
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", handleStopped);
    recorder.start();
    startedAt = Date.now();
    onElapsed?.(0);
    timer = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      onElapsed?.(elapsed);
      if (elapsed >= maxDurationSeconds()) stop(false);
    }, 200);
    return null;
  }

  function stop(cancel) {
    cancelled = Boolean(cancel);
    clearTimer();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else handleStopped();
  }

  return { start, stop, isRecording: () => recorder != null };
}

const chatVoiceRecorder = createVoiceRecorder({
  maxDurationSeconds: voiceMaxDurationSeconds,
  onElapsed: (elapsed) => {
    if (voiceRecordingTimeEl) voiceRecordingTimeEl.textContent = formatRecordingTime(elapsed);
  },
  onFinish: handleChatVoiceRecordingFinished,
});

async function startVoiceRecording() {
  if (chatVoiceRecorder.isRecording()) return;
  const error = await chatVoiceRecorder.start();
  if (error) {
    showCopyToast(error);
    return;
  }
  if (voiceRecordingTimeEl) voiceRecordingTimeEl.textContent = "0:00";
  if (voiceRecordingPanel) voiceRecordingPanel.hidden = false;
}

function stopVoiceRecording(cancelled) {
  chatVoiceRecorder.stop(cancelled);
}

async function handleChatVoiceRecordingFinished({ blob, mimeType, cancelled }) {
  if (voiceRecordingPanel) voiceRecordingPanel.hidden = true;
  if (cancelled || !blob || !activeConversationId) return;

  // "Send Media via Nextcloud": upload the recording and send its share link (renders as an
  // audio card + player on the recipient's side). Failure falls back to the on-chain envelope.
  if (isNextcloudMediaSendActive()) {
    const conversationId = activeConversationId;
    setStatus("Uploading voice note to Nextcloud…");
    try {
      const url = await uploadNextcloudMedia(blob, `voice_${Date.now()}.webm`, mimeType);
      queueConversationMessage(conversationId, url);
      setStatus("Voice note sent via Nextcloud.");
      return;
    } catch (error) {
      showCopyToast(`Nextcloud upload failed — sending on-chain instead. (${error.message})`);
    }
  }

  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  }).catch(() => null);
  if (!dataUrl) { showCopyToast("Could not process the recording."); return; }

  const envelope = JSON.stringify({
    type: "file",
    name: "voice-message.webm",
    size: blob.size,
    mimeType,
    content: dataUrl,
  });
  queueConversationMessage(activeConversationId, envelope);
}

document.querySelector("[data-voice-recording-stop]")?.addEventListener("click", () => stopVoiceRecording(false));
document.querySelector("[data-voice-recording-cancel]")?.addEventListener("click", () => stopVoiceRecording(true));

// Envelope parses are memoized by content string: the thread re-renders constantly (sync
// ticks, reactions, link previews) and re-parsing every photo/voice envelope each time was
// pure waste — a photo envelope can be 8 MB of JSON. V8 caches a string's hash after first
// use, so Map lookups keyed by the (already-retained) message text are cheap. Caches clear
// wholesale past a bound so an enormous history can't grow them forever.
const envelopeParseMemos = { image: new Map(), audio: new Map(), reply: new Map() };
function memoizedEnvelopeParse(kind, text, parser) {
  if (typeof text !== "string") return parser(text);
  const memo = envelopeParseMemos[kind];
  if (memo.has(text)) return memo.get(text);
  const result = parser(text);
  if (memo.size > 2000) memo.clear();
  memo.set(text, result);
  return result;
}
function parseImageEnvelope(text) { return memoizedEnvelopeParse("image", text, parseImageEnvelopeUncached); }
function parseAudioEnvelope(text) { return memoizedEnvelopeParse("audio", text, parseAudioEnvelopeUncached); }
function parseReplyEnvelope(text) { return memoizedEnvelopeParse("reply", text, parseReplyEnvelopeUncached); }

// Receivers (including our own render path) detect an image purely by
// sniffing decrypted content, exactly as iOS/Android do — there is no
// wire-level flag. Guards against parsing arbitrary long text as JSON.
function parseImageEnvelopeUncached(text) {
  const trimmed = String(text || "").trim();
  // 8MB cap: group/Nextcloud photos can far exceed the on-chain payload sizes the
  // old 200k cap assumed, and a too-small cap made big photos render as raw JSON.
  if (!trimmed.startsWith("{") || trimmed.length > 8_000_000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "file") return null;
    const mimeType = String(parsed.mimeType || "");
    if (!mimeType.startsWith("image/")) return null;
    const content = String(parsed.content || "");
    if (!content.startsWith("data:")) return null;
    return { name: String(parsed.name || "photo.jpg"), size: Number(parsed.size || 0), mimeType, content };
  } catch {
    return null;
  }
}

// Matches iOS's MediaFile: photo and voice messages share this exact
// envelope shape — only the mimeType prefix ("image/" vs "audio/")
// distinguishes them, there's no separate wire type for audio.
function parseAudioEnvelopeUncached(text) {
  const trimmed = String(text || "").trim();
  // Same 8MB cap rationale as parseImageEnvelope: long voice notes exceed 200k.
  if (!trimmed.startsWith("{") || trimmed.length > 8_000_000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "file") return null;
    const mimeType = String(parsed.mimeType || "");
    if (!mimeType.startsWith("audio/")) return null;
    const content = String(parsed.content || "");
    if (!content.startsWith("data:")) return null;
    return { name: String(parsed.name || "audio.webm"), size: Number(parsed.size || 0), mimeType, content, duration: Number(parsed.duration || 0) };
  } catch {
    return null;
  }
}

// Matches iOS's MessageReplyContent (Models.swift): a reply is the entire
// message content becoming this JSON envelope, not a field bolted onto a
// normal message — the actual typed reply text lives in .text.
function parseReplyEnvelopeUncached(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.length > 200000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "reply") return null;
    return {
      replyToId: String(parsed.replyToId || ""),
      replyToSender: String(parsed.replyToSender || ""),
      replyToPreview: String(parsed.replyToPreview || ""),
      text: String(parsed.text ?? ""),
    };
  } catch {
    return null;
  }
}

const REPLY_PREVIEW_MAX_LENGTH = 80;

// Builds the short quoted-preview text for a reply, unwrapping exactly one
// level of nesting (a reply-to-a-reply quotes the original reply's own typed
// text, not raw JSON) and substituting friendly placeholders for media —
// matches iOS's MessageReplyCodec.previewText.
function replyPreviewTextFor(message) {
  if (!message) return "";
  // Chess envelopes are JSON in the message text — without this branch, replying to a chess
  // message quoted the raw envelope JSON straight into the composer preview and onto the wire.
  const chessPreview = Chess.chessPreviewText(message.text, message.direction === "outgoing");
  if (chessPreview) return chessPreview.slice(0, REPLY_PREVIEW_MAX_LENGTH);
  const asReply = parseReplyEnvelope(message.text);
  if (asReply) return asReply.text.slice(0, REPLY_PREVIEW_MAX_LENGTH);
  const fileMime = sniffInlineFileMime(message.text);
  if (fileMime != null) {
    if (fileMime.startsWith("image/")) return "📷 Photo";
    if (fileMime.startsWith("audio/")) return "🎤 Audio message";
    if (fileMime.startsWith("video/")) return "🎬 Video";
    return "📎 File";
  }
  return String(message.text || "").slice(0, REPLY_PREVIEW_MAX_LENGTH);
}

// Matches iOS's MessageReactionContent: reactions are sent as a normal
// message but intercepted before ever being appended to the conversation —
// they only ever update the reactions store, never render as their own bubble.
function parseReactionEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.length > 200000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "reaction") return null;
    const targetTxId = String(parsed.targetTxId || "");
    const emoji = String(parsed.emoji || "");
    if (!targetTxId || !emoji) return null;
    return { targetTxId, emoji, action: parsed.action === "remove" ? "remove" : "add" };
  } catch {
    return null;
  }
}

// Fixed 6-emoji tapback set, byte-for-byte the same as iOS/Android — not a
// full emoji keyboard, keeps reactions identical across every client.
// --- Quick Reactions editor (Settings > Chats) — iOS parity: 6 slots + reset ---
const quickReactionsModal = document.querySelector("[data-quick-reactions-modal]");

/** First grapheme cluster of the input — one emoji, however many code points it takes. */
function firstGrapheme(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...seg.segment(s)][0]?.segment || s;
  } catch {
    return [...s].slice(0, 2).join(""); // surrogate-pair-safe fallback
  }
}

function renderQuickReactionSlots() {
  const wrap = document.querySelector("[data-quick-reactions-slots]");
  if (!wrap) return;
  wrap.innerHTML = quickReactionEmojis()
    .map((emoji, index) => `<input class="quick-reaction-slot" data-quick-slot="${index}" type="text" value="${escapeHtml(emoji)}" aria-label="Reaction ${index + 1}">`)
    .join("");
}

function updateQuickReactionsPreview() {
  const el = document.querySelector("[data-quick-reactions-preview]");
  if (el) el.textContent = quickReactionEmojis().join(" ");
}

document.querySelector("[data-open-quick-reactions]")?.addEventListener("click", () => {
  if (!quickReactionsModal) return;
  renderQuickReactionSlots();
  quickReactionsModal.hidden = false;
});
function closeQuickReactionsModal() { if (quickReactionsModal) quickReactionsModal.hidden = true; }
document.querySelector("[data-close-quick-reactions]")?.addEventListener("click", closeQuickReactionsModal);
quickReactionsModal?.addEventListener("click", (event) => { if (event.target === quickReactionsModal) closeQuickReactionsModal(); });
document.querySelector("[data-quick-reactions-reset]")?.addEventListener("click", () => {
  localStorage.removeItem(QUICK_REACTIONS_KEY);
  renderQuickReactionSlots();
  updateQuickReactionsPreview();
  showCopyToast("Quick reactions reset to default");
});
document.querySelector("[data-quick-reactions-save]")?.addEventListener("click", () => {
  const inputs = [...document.querySelectorAll("[data-quick-slot]")];
  const emojis = inputs.map((input) => firstGrapheme(input.value));
  if (emojis.some((e) => !e)) { showCopyToast("Every slot needs an emoji."); return; }
  localStorage.setItem(QUICK_REACTIONS_KEY, JSON.stringify(emojis));
  updateQuickReactionsPreview();
  closeQuickReactionsModal();
  showCopyToast("Quick reactions saved");
});

const DEFAULT_QUICK_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
// User-customizable via Settings > Chats > Quick Reactions (iOS parity: exactly 6
// slots, global — not per-account — and defensive against malformed stored data).
const QUICK_REACTIONS_KEY = "kachat-quick-reactions-v1";
function quickReactionEmojis() {
  try {
    const raw = JSON.parse(localStorage.getItem(QUICK_REACTIONS_KEY) || "null");
    if (Array.isArray(raw) && raw.length === 6 && raw.every((e) => typeof e === "string" && e.trim())) {
      return raw;
    }
  } catch { /* fall through to default */ }
  return DEFAULT_QUICK_REACTION_EMOJIS;
}
// Seed the Settings > Chats row preview once everything above is initialized.
updateQuickReactionsPreview();

function applyLocalReaction(conversationEntry, targetTxId, reactorAddress, emoji) {
  if (!conversationEntry.reactionsByTxId) conversationEntry.reactionsByTxId = {};
  const list = conversationEntry.reactionsByTxId[targetTxId] || [];
  const filtered = list.filter((entry) => entry.reactorAddress !== reactorAddress);
  filtered.push({ reactorAddress, emoji });
  conversationEntry.reactionsByTxId[targetTxId] = filtered;

  // Reactions count as real conversation activity — bumps the chat to the
  // top of the sidebar and drives its preview text, same as a new message.
  const timestamp = Date.now();
  conversationEntry.lastReactionEvent = { targetTxId, reactorAddress, emoji, timestamp };
  conversationEntry.lastActivityAt = Math.max(Number(conversationEntry.lastActivityAt || 0), timestamp);
  conversationEntry.updatedAt = timestamp;
}

function removeLocalReaction(conversationEntry, targetTxId, reactorAddress) {
  if (!conversationEntry.reactionsByTxId) return;
  const list = conversationEntry.reactionsByTxId[targetTxId];
  if (!list) return;
  conversationEntry.reactionsByTxId[targetTxId] = list.filter((entry) => entry.reactorAddress !== reactorAddress);
  // Don't let the sidebar keep advertising a reaction that was just undone.
  if (conversationEntry.lastReactionEvent?.targetTxId === targetTxId && conversationEntry.lastReactionEvent?.reactorAddress === reactorAddress) {
    conversationEntry.lastReactionEvent = null;
  }
}

// Matches iOS's ChatService+Fetching interception: a reaction is delivered
// as a normal message but is checked for *before* any normal conversation
// append — it only ever updates the reactions store, never becomes its own
// chat bubble. Every real addMessageToConversation call in this file goes
// through this wrapper instead, so reactions arriving via any path (real
// sync, preview simulation, self-stash recovery, etc.) are always caught.
// Returns the added message ONLY when a real, visible chat bubble was created.
// Intercepted control envelopes (reactions, fresh-address payment-pool messages)
// return null so callers know not to notify or count them as unread — matching iOS,
// where these are processed silently and never surface as messages.
function appendIncomingOrReactionMessage(conversationEntry, message) {
  const reaction = parseReactionEnvelope(message.text);
  if (reaction) {
    const reactorAddress = message.direction === "outgoing" ? (engine.address || "") : (message.sender || "");
    if (reaction.action === "add") applyLocalReaction(conversationEntry, reaction.targetTxId, reactorAddress, reaction.emoji);
    else removeLocalReaction(conversationEntry, reaction.targetTxId, reactorAddress);
    persistState();
    if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
    renderChats();
    return null;
  }
  // Fresh-address payment pool envelopes ride the same encrypted pipeline and
  // are intercepted the same way reactions are — they never render as bubbles
  // (a payment_notice *produces* a payment bubble, but the envelope itself is
  // swallowed here). Unknown {type:...} values fall through to the normal
  // pipeline per the wire contract.
  const poolEnvelope = parsePaymentPoolEnvelope(message.text);
  if (poolEnvelope) {
    try { handlePaymentPoolEnvelope(poolEnvelope, conversationEntry, message); }
    catch (error) { appendEngineLog(`Pool envelope handling failed: ${error.message}`); }
    // Swallowed control message: no bubble, so the caller must not notify or count it.
    // (A payment_notice produces its own payment bubble + notification inside
    // handlePaymentPoolEnvelope, so it is handled there, not here.)
    return null;
  }
  return addMessageToConversation(conversationEntry, message);
}

// ---------------------------------------------------------------------------
// Phone (iOS/Android) chat-history archive import — used by the Nextcloud
// restore flow. The phone apps back up `kachat-backup.json` in the shared
// ChatHistoryArchive schema ({schemaVersion, exportedAt, walletAddress,
// conversations: [{contactAddress, contactAlias, unreadCount, messages}]}),
// which is NOT the desktop backup format. Unlike importBackupPayload (which
// REPLACES local state), this MERGES into the existing desktop conversations:
// find-or-create per contact address, dedupe by txid, reactions go through the
// same reactionsByTxId store as live messages, and base64 voice bodies become
// small placeholders (desktop can't play the iOS Opus envelopes anyway). With
// chat state in IndexedDB the oversize threshold is generous — it only guards
// against pathological single messages, not the archive's total size.
// ---------------------------------------------------------------------------

const PHONE_ARCHIVE_MAX_CONTENT_CHARS = 1_000_000;

// iOS deliveryStatus -> desktop MESSAGE_STATUSES. "warning" is iOS's
// "broadcast but unverified", which is exactly the desktop BROADCAST state.
const PHONE_ARCHIVE_STATUSES = {
  pending: MESSAGE_STATUSES.PENDING,
  sent: MESSAGE_STATUSES.CONFIRMED,
  failed: MESSAGE_STATUSES.FAILED,
  warning: MESSAGE_STATUSES.BROADCAST,
};

// The archive's timestamps are ISO8601 strings when exported normally, but a
// numeric epoch can appear when a message was encoded without the iso strategy:
// ms since 1970, seconds since 1970, or Swift's seconds-since-2001 reference
// date. blockTime (ms) wins when it looks like a plausible epoch.
function phoneArchiveTimestampMs(archiveMessage) {
  const blockTime = Number(archiveMessage?.blockTime || 0);
  if (Number.isFinite(blockTime) && blockTime > 1e12) return blockTime;
  const raw = archiveMessage?.timestamp;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric >= 1e12) return numeric;              // already ms since 1970
    if (numeric >= 1e9) return numeric * 1000;        // seconds since 1970
    return (numeric + 978307200) * 1000;              // Swift reference date (2001)
  }
  return Number.isFinite(blockTime) && blockTime > 0 ? blockTime : Date.now();
}

function phoneArchiveMessageText(archiveMessage, rawContent) {
  const messageType = String(archiveMessage?.messageType || "");
  // Voice notes carry the whole base64 Opus envelope as content — desktop
  // can't decode the iOS envelope, so store a placeholder; same for any
  // pathologically oversized payload.
  if (messageType === "audio") return "🎤 Voice message (from phone backup)";
  if (rawContent.length > PHONE_ARCHIVE_MAX_CONTENT_CHARS) return "📎 Media message (from phone backup)";
  if (rawContent.trim()) return rawContent; // payments arrive as "Sent/Received X KAS" text already
  if (messageType === "handshake") return "Communication request";
  if (messageType === "payment") return "[Payment]";
  return "";
}

function importPhoneChatArchive(json) {
  const archive = JSON.parse(json);
  if (!archive || !Array.isArray(archive.conversations)) {
    throw new Error("That file is not a KaChat phone chat backup.");
  }
  // Merging a backup is a backfill: keep the next sync sweep silent and its messages
  // read (see pendingInitialCatchUp).
  pendingInitialCatchUp = true;
  const archiveWallet = String(archive.walletAddress || "").trim();
  if (archiveWallet && engine.address && archiveWallet !== engine.address) {
    throw new Error(`That phone backup belongs to a different wallet (${shortAddress(archiveWallet)}).`);
  }

  // Merge against what is actually persisted right now (the desktop restore may
  // have just replaced storage).
  reloadStateFromBrowserStorage();

  const addedMessageIds = new Set();
  const touchedConversationIds = new Set();

  // Never resurrect a deleted chat: honor this device's tombstones AND the ones the
  // archive itself carries (covers restoring onto a fresh install).
  const localTombstones = loadDeletedContactAddresses();
  const archivedTombstones = new Set(
    (Array.isArray(archive.deletedContactAddresses) ? archive.deletedContactAddresses : []).map(String),
  );
  for (const archived of archive.conversations) {
    const contactAddress = String(archived?.contactAddress || "").trim();
    if (!contactAddress) continue;
    if (localTombstones.has(contactAddress) || archivedTombstones.has(contactAddress)) continue;
    const archivedMessages = Array.isArray(archived?.messages) ? archived.messages : [];
    if (!archivedMessages.length) continue;

    const alias = String(archived?.contactAlias || "").trim();
    const archivePhoto = archivePhotoToDataUrl(archived?.contactPhoto);
    let contact = state.contacts.find((entry) => entry.address === contactAddress);
    let conversationEntry = contact ? state.conversations.find((entry) => entry.contactId === contact.id) : null;
    if (!contact) {
      const createdAt = phoneArchiveTimestampMs(archivedMessages[0]);
      const displayName = alias || shortAddress(contactAddress);
      contact = {
        id: nowId(), name: displayName, nameIsCustom: false, address: contactAddress,
        avatar: initialsFor(displayName), photo: archivePhoto || "", createdAt, updatedAt: createdAt,
        relationshipState: "legacy-manual", handshakeTxid: "", incomingHandshakeTxid: "", peerConversationId: "",
      };
      state.contacts.push(contact);
    } else if (alias && !contact.nameIsCustom) {
      // Only fill in a name the desktop side never chose — placeholder names
      // derived from the raw address; a custom alias is never overwritten.
      const isPlaceholderName = !contact.name || contact.name === "Unnamed"
        || contact.name === shortAddress(contact.address) || contact.name.startsWith("kaspa");
      if (isPlaceholderName) {
        contact.name = alias;
        contact.avatar = initialsFor(alias);
      }
    }
    // Adopt a backed-up photo only when this device has none of its own (never
    // overwrite a photo the user picked here).
    if (archivePhoto && !contact.photo) contact.photo = archivePhoto;
    if (!conversationEntry) {
      conversationEntry = createConversation({ contactId: contact.id, createdAt: Number(contact.createdAt || Date.now()) });
      state.conversations.push(conversationEntry);
    }

    const hidden = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
    const knownTxids = new Set((conversationEntry.messages || []).map((m) => m.txid).filter(Boolean).map(String));
    const knownIds = new Set((conversationEntry.messages || []).map((m) => String(m.id)));
    const preLastActivityAt = Number(conversationEntry.lastActivityAt || 0);
    const preUpdatedAt = Number(conversationEntry.updatedAt || 0);
    const preReactionEvent = conversationEntry.lastReactionEvent ?? null;
    let changed = false;

    for (const archiveMessage of archivedMessages) {
      // Never materialize a phantom row: it never reached the chain, so it would render as
      // an eternal "waiting" message that no delivery can ever resolve.
      if (isPhantomArchiveMessage(archiveMessage)) continue;
      const txid = String(archiveMessage?.txId || "").trim();
      const id = String(archiveMessage?.id || "").trim() || nowId();
      if (txid && (knownTxids.has(txid) || hidden.has(txid))) continue;
      if (knownIds.has(id) || hidden.has(id)) continue;

      const rawContent = String(archiveMessage?.content || "");
      // Pool envelopes in a phone archive are historical bookkeeping — never
      // rendered, and their side effects must not replay from a backup.
      if (parsePaymentPoolEnvelope(rawContent)) {
        if (txid) knownTxids.add(txid);
        continue;
      }
      const reaction = parseReactionEnvelope(rawContent);
      if (reaction) {
        // Same interception as live sync: a reaction only ever updates the
        // reactions store — it never becomes a visible chat row.
        const reactor = String(archiveMessage?.senderAddress || (archiveMessage?.isOutgoing ? engine.address || "" : contactAddress));
        if (reaction.action === "add") applyLocalReaction(conversationEntry, reaction.targetTxId, reactor, reaction.emoji);
        else removeLocalReaction(conversationEntry, reaction.targetTxId, reactor);
        if (txid) knownTxids.add(txid);
        changed = true;
        continue;
      }

      const text = phoneArchiveMessageText(archiveMessage, rawContent);
      if (!text) continue;
      const createdAt = phoneArchiveTimestampMs(archiveMessage);
      const message = createMessage({
        conversationId: conversationEntry.id,
        contactId: contact.id,
        direction: archiveMessage?.isOutgoing ? "outgoing" : "incoming",
        text,
        sender: String(archiveMessage?.senderAddress || "") || null,
        receiver: String(archiveMessage?.receiverAddress || "") || null,
        status: PHONE_ARCHIVE_STATUSES[String(archiveMessage?.deliveryStatus || "")] || MESSAGE_STATUSES.CONFIRMED,
        transport: "phone-backup",
        createdAt,
      });
      message.id = id;
      message.txid = txid || null;
      message.messageType = String(archiveMessage?.messageType || "") || null;
      message.note = "Imported from phone backup";
      if (message.status === MESSAGE_STATUSES.CONFIRMED) message.confirmations = Math.max(1, Number(message.confirmations || 0));
      if (message.messageType === "payment") {
        const amount = rawContent.match(/^(?:Sent|Received)\s+([0-9][0-9.,]*)\s+KAS/i);
        if (amount) message.paymentAmountKas = amount[1].replaceAll(",", "");
      }
      conversationEntry.messages.push(message);
      knownIds.add(id);
      if (txid) knownTxids.add(txid);
      addedMessageIds.add(id);
      changed = true;
    }

    if (!changed) continue;
    touchedConversationIds.add(conversationEntry.id);
    conversationEntry.messages.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    const last = conversationEntry.messages.at(-1);
    // Historical import, not a live reaction event — don't let it fake sidebar
    // activity or advertise a years-old tapback as "new".
    conversationEntry.lastReactionEvent = preReactionEvent;
    conversationEntry.lastActivityAt = Math.max(preLastActivityAt, Number(last?.createdAt || 0));
    conversationEntry.updatedAt = Math.max(preUpdatedAt, Number(last?.updatedAt || last?.createdAt || 0));
    // Restored two-way history means the relationship was already accepted on the phone —
    // mark it established here so later handshake sync can't resurface accept/decline.
    if (contact.relationshipState !== "established") {
      const merged = conversationEntry.messages;
      const hasOutgoing = merged.some((m) => m.direction === "outgoing" && m.messageType !== "handshake" && String(m.text || "").trim().length > 0);
      const hasIncoming = merged.some((m) => m.direction === "incoming" && m.messageType !== "handshake" && String(m.text || "").trim().length > 0);
      if (hasOutgoing && hasIncoming) {
        contact.relationshipState = "established";
        contact.updatedAt = Date.now();
      }
    }
  }

  // Persist with a quota guard. In IndexedDB mode persistState never throws
  // (device-proportional quota) so this whole catch is dormant; it only fires
  // in the localStorage FALLBACK mode, where even a placeholder-reduced
  // archive can exceed the quota. There, trim only the messages imported THIS
  // run (oldest first, per conversation) until the state fits — pre-existing
  // desktop messages are never dropped.
  const isQuotaError = (error) =>
    error?.name === "QuotaExceededError" || error?.code === 22 || /quota/i.test(String(error?.message || ""));
  let quotaTrimmed = false;
  try {
    persistState();
  } catch (error) {
    if (!isQuotaError(error)) { reloadStateFromBrowserStorage(); throw error; }
    let persisted = false;
    for (const keepPerConversation of [200, 50, 10, 0]) {
      for (const conversationEntry of state.conversations || []) {
        const importedHere = (conversationEntry.messages || []).filter((m) => addedMessageIds.has(String(m.id)));
        if (importedHere.length <= keepPerConversation) continue;
        const keepIds = new Set(importedHere.slice(-keepPerConversation).map((m) => String(m.id)));
        conversationEntry.messages = conversationEntry.messages.filter(
          (m) => !addedMessageIds.has(String(m.id)) || keepIds.has(String(m.id)),
        );
      }
      try { persistState(); persisted = true; break; }
      catch (retryError) { if (!isQuotaError(retryError)) { reloadStateFromBrowserStorage(); throw retryError; } }
    }
    if (!persisted) {
      reloadStateFromBrowserStorage();
      throw new Error("Backup too large to store — not enough local storage space to merge the phone backup.");
    }
    quotaTrimmed = true;
  }

  // Count what actually survived persistence (quota trimming may have dropped some).
  let mergedMessages = 0;
  for (const conversationEntry of state.conversations || []) {
    for (const message of conversationEntry.messages || []) {
      if (addedMessageIds.has(String(message.id))) mergedMessages += 1;
    }
  }

  // Groups (cross-platform recovery): the archive may carry full group key material so a
  // second device of the same account recovers groups it CREATED (admin - no on-chain invite
  // is addressed to us) as well as member ones. Import them into the per-wallet group store.
  let importedGroups = 0;
  if (Array.isArray(archive.groups) && archive.groups.length) {
    const mgr = getGroupManager();
    if (mgr) {
      for (const g of archive.groups) {
        try {
          // importGroupRecord refuses a tombstoned (deleted) group, so a restore never
          // resurrects one you deleted — and we then skip its messages too.
          if (!mgr.importGroupRecord(g)) continue;
          importedGroups += 1;
          // Restore decrypted message history so it survives even if the indexer pruned it.
          for (const m of Array.isArray(g.messages) ? g.messages : []) {
            const content = String(m?.content ?? m?.text ?? "");  // accept legacy `text` too
            if (parseReactionEnvelope(content)) continue; // reactions are pills, not stored bubbles
            const blockTime = Number(m?.blockTime ?? m?.createdAt ?? 0) || Date.now();
            appendGroupMessage(g.groupId, {
              id: nowId(),
              senderAddress: m?.senderAddress || "",
              direction: (typeof m?.isOutgoing === "boolean")
                ? (m.isOutgoing ? "local" : "incoming")
                : ((m?.senderAddress && m.senderAddress === engine.address) ? "local" : "incoming"),
              text: content,
              createdAt: blockTime,
              txId: m?.txId || null,
              msgIdHex: m?.msgIdHex || null,
              senderIsAdmin: Boolean(m?.senderIsAdmin),
            });
          }
        } catch { /* skip a malformed group */ }
      }
    }
  }

  reloadStateFromBrowserStorage();
  renderChats();
  if (importedGroups) { try { renderGroupList(); } catch { /* group UI not ready */ } }
  if (quotaTrimmed) showCopyToast("Backup too large to store fully — imported what fit.");
  return { conversations: touchedConversationIds.size, messages: mergedMessages, groups: importedGroups };
}

// ---------------------------------------------------------------------------
// Shared chat-history archive EXPORT — the exact inverse of the import above.
//
// Desktop, iOS and Android all back up to the SAME file (`kachat-backup.json`)
// in the SAME schema, so any device can restore any other device's backup:
//
//   { schemaVersion: 1, exportedAt, walletAddress,
//     conversations: [{ conversationId, contactAddress, contactAlias,
//                       unreadCount, messages: [ChatMessage…] }],
//     desktopState: {…}   // additive, ignored by both phones
//   }
//
// Wire constraints that are NOT negotiable (verified against the real decoders):
//   * iOS decodes `id` as `UUID` and `conversationId` as `UUID?` — a non-UUID
//     string throws and takes the WHOLE archive down. Desktop ids are only
//     UUIDs when crypto.randomUUID() exists, so every id is passed through
//     archiveUuid() first.
//   * iOS's JSONDecoder uses .iso8601, i.e. ISO8601DateFormatter with
//     [.withInternetDateTime] and NO fractional seconds — "…T12:34:56.789Z"
//     fails to parse. Timestamps are therefore emitted whole-second.
//   * iOS decodes `messageType` as a strict String enum: exactly one of
//     handshake | contextual | payment | audio, or the archive throws.
//   * iOS requires schemaVersion == 1; Android requires it too (and, unlike
//     Swift, Gson leaves a missing Int at 0, which fails that same check).
//   * `acceptingBlock` is omitted rather than null — both phones' encoders drop
//     nil optionals, and neither reads it back.
// ---------------------------------------------------------------------------

const CHAT_ARCHIVE_SCHEMA_VERSION = 1;
const SHARED_BACKUP_KIND = "kachat-desktop-backup";

// Desktop status -> archive deliveryStatus. Inverse of PHONE_ARCHIVE_STATUSES;
// the pre-broadcast working states all collapse to "pending" (the phones have
// no equivalent for "building"/"signing").
const ARCHIVE_STATUS_BY_DESKTOP_STATUS = {
  [MESSAGE_STATUSES.DRAFT]: "pending",
  [MESSAGE_STATUSES.BUILDING]: "pending",
  [MESSAGE_STATUSES.SIGNING]: "pending",
  [MESSAGE_STATUSES.BROADCASTING]: "pending",
  [MESSAGE_STATUSES.PENDING]: "pending",
  [MESSAGE_STATUSES.BROADCAST]: "warning",
  [MESSAGE_STATUSES.CONFIRMED]: "sent",
  [MESSAGE_STATUSES.FAILED]: "failed",
};

// iOS's DeliveryStatus.priority — used when the same txId turns up on both
// sides of a merge with different statuses.
const ARCHIVE_STATUS_PRIORITY = { pending: 0, warning: 1, failed: 2, sent: 3 };

const ARCHIVE_MESSAGE_TYPES = new Set(["handshake", "contextual", "payment", "audio"]);
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Deterministic 128-bit UUID from an arbitrary string (xmur3 seed -> 4 words),
 *  so re-exporting the same desktop message always produces the same id and the
 *  phones' id-keyed dedupe keeps working across backups. */
function derivedArchiveUuid(seed) {
  const text = String(seed || "");
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const nextWord = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  const nibbles = [nextWord(), nextWord(), nextWord(), nextWord()].join("").split("");
  nibbles[12] = "4";                                             // RFC 4122 version
  nibbles[16] = "89ab"[parseInt(nibbles[16], 16) & 3];           // RFC 4122 variant
  const flat = nibbles.join("");
  return `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20, 32)}`;
}

function archiveUuid(value, seed) {
  const raw = String(value || "").trim();
  if (UUID_PATTERN.test(raw)) return raw.toLowerCase();
  return derivedArchiveUuid(raw || seed);
}

/** Whole-second ISO8601 — Swift's .iso8601 decoding strategy rejects fractional
 *  seconds, so `new Date().toISOString()` on its own is NOT safe here. */
function archiveIsoTimestamp(ms) {
  const value = Number(ms);
  const date = new Date(Number.isFinite(value) && value > 0 ? value : Date.now());
  return `${date.toISOString().slice(0, 19)}Z`;
}

function archiveMessageType(message) {
  const raw = String(message?.messageType || "").trim().toLowerCase();
  if (ARCHIVE_MESSAGE_TYPES.has(raw)) return raw;
  if (raw === "comm") return "contextual";           // Android's internal spelling
  if (raw === "pay") return "payment";
  if (parseAudioEnvelope(message?.text)) return "audio";
  if (message?.paymentAmountKas != null) return "payment";
  return "contextual";
}

/** Only a name the desktop user (or a real handshake) actually chose travels as
 *  contactAlias — the same placeholder test importPhoneChatArchive applies in
 *  reverse, so a "kaspa:qz…" stand-in never overwrites a real alias on a phone. */
function archiveContactAlias(contact) {
  const name = String(contact?.name || "").trim();
  if (!name) return null;
  if (contact?.nameIsCustom) return name;
  const isPlaceholder = name === "Unnamed" || name === shortAddress(contact?.address) || name.startsWith("kaspa");
  return isPlaceholder ? null : name;
}

// Cross-platform contact photo codec for the shared archive. On the wire it is RAW
// base64 JPEG (no data: prefix) so iOS/Android can decode it directly; desktop stores
// it locally as a full data URL, so strip/re-add the prefix at the boundary.
function contactPhotoToArchive(photo) {
  const s = String(photo || "");
  if (!s) return null;
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma >= 0 ? s.slice(comma + 1) : s;
}
function archivePhotoToDataUrl(base64) {
  const s = String(base64 || "").trim();
  if (!s) return "";
  return s.startsWith("data:") ? s : `data:image/jpeg;base64,${s}`;
}

// A phantom archive row: one whose txId is blank or still a provisional `pending_` id, and
// which never made it onto the chain. The shared archive spec forbids exporting these
// (MESSAGING.md), and all three platforms scrub them on the way in as well, so one client's
// pollution heals everywhere rather than being re-published on the next upload.
function isPhantomArchiveMessage(message) {
  const txId = String(message?.txId || "").trim();
  const status = String(message?.deliveryStatus || "");
  if (txId.startsWith("pending_")) return true;
  if (!txId) return status === "pending" || status === "failed";
  return false;
}

function archiveMessageKey(archiveMessage) {
  const txId = String(archiveMessage?.txId || "").trim();
  return txId ? `tx:${txId}` : `id:${String(archiveMessage?.id || "")}`;
}

function isArchivePlaceholderContent(content) {
  const text = String(content || "");
  return !text || text === "📤 Sent via another device" || text === "[Encrypted message]";
}

/** Mirrors iOS's ChatService.preferMessage: a real body beats a placeholder,
 *  then the further-along delivery status wins, then the later blockTime. */
function preferArchiveMessage(existing, candidate) {
  const existingPlaceholder = isArchivePlaceholderContent(existing?.content);
  const candidatePlaceholder = isArchivePlaceholderContent(candidate?.content);
  if (existingPlaceholder !== candidatePlaceholder) return candidatePlaceholder ? existing : candidate;

  const existingPriority = ARCHIVE_STATUS_PRIORITY[String(existing?.deliveryStatus)] ?? 3;
  const candidatePriority = ARCHIVE_STATUS_PRIORITY[String(candidate?.deliveryStatus)] ?? 3;
  if (existingPriority !== candidatePriority) return candidatePriority > existingPriority ? candidate : existing;

  return Number(candidate?.blockTime || 0) > Number(existing?.blockTime || 0) ? candidate : existing;
}

/**
 * Coerces any archive message — including one another device wrote — into the
 * strictest shape every decoder accepts, without touching what it says.
 *
 * This matters because Android currently writes `id` = the 64-hex txId and
 * `timestamp` via ISO_INSTANT (fractional seconds), BOTH of which iOS's
 * JSONDecoder rejects outright (`UUID` / `.iso8601`), taking the whole archive
 * down with them. Since desktop rewrites the shared file on every backup, it
 * heals those messages on the way out; Android keys its rows by `txId` and
 * ignores `id`/`timestamp` on import, so nothing is lost on that side.
 */
function normalizeArchiveMessage(message) {
  const txId = String(message?.txId || "").trim();
  const rawId = String(message?.id || "").trim();
  const blockTime = Math.max(0, Math.round(Number(message?.blockTime) || 0));
  const timestampMs = blockTime > 0 ? blockTime : (Date.parse(String(message?.timestamp || "")) || Date.now());
  const rawType = String(message?.messageType || "").trim().toLowerCase();
  const rawStatus = String(message?.deliveryStatus || "").trim().toLowerCase();

  const normalized = {
    id: archiveUuid(rawId, `${txId}:${rawId}`),
    txId,
    senderAddress: String(message?.senderAddress || ""),
    receiverAddress: String(message?.receiverAddress || ""),
    content: String(message?.content || ""),
    timestamp: archiveIsoTimestamp(timestampMs),
    blockTime,
    isOutgoing: Boolean(message?.isOutgoing),
    messageType: archiveMessageType({ messageType: rawType, text: message?.content }),
    deliveryStatus: ARCHIVE_STATUS_PRIORITY[rawStatus] === undefined ? "sent" : rawStatus,
  };
  const acceptingBlock = String(message?.acceptingBlock || "").trim();
  if (acceptingBlock) normalized.acceptingBlock = acceptingBlock;
  return normalized;
}

function sortArchiveMessages(messages) {
  return messages.sort((a, b) => {
    const delta = Number(a?.blockTime || 0) - Number(b?.blockTime || 0);
    return delta !== 0 ? delta : String(a?.txId || a?.id || "").localeCompare(String(b?.txId || b?.id || ""));
  });
}

/** This device's live conversations rendered into the shared archive schema. */
function buildLocalChatArchive() {
  const myAddress = String(engine.address || "");
  const conversations = [];
  // Deleted chats are excluded from the export AND their tombstones travel with the
  // archive (same deletedContactAddresses field as iOS/Android), so restoring
  // anywhere never brings them back.
  const tombstones = loadDeletedContactAddresses();

  for (const conversationEntry of state.conversations || []) {
    const contact = contactForConversation(conversationEntry);
    const contactAddress = String(contact?.address || "").trim();
    if (!contactAddress) continue;
    if (tombstones.has(contactAddress)) continue;

    // A message the user deleted on this device stays deleted in what THIS
    // device contributes; the merge below still preserves any copy another
    // device already published.
    const hidden = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
    const messages = [];
    for (const message of conversationEntry.messages || []) {
      const id = String(message?.id || "");
      const txid = String(message?.txid || "").trim();
      if (hidden.has(id) || (txid && hidden.has(txid))) continue;
      const text = String(message?.text || "");
      if (!text) continue;
      // Never-broadcast drafts stay out of the SHARED half: iOS drops empty-txId
      // messages on import anyway, and Android keys its message rows BY txId, so
      // several of them would collapse into one junk row there. They still ride
      // along losslessly in `desktopState`.
      if (!txid) continue;

      const isOutgoing = message?.direction !== "incoming";
      const createdAt = Number(message?.createdAt || 0) || Date.now();
      messages.push({
        id: archiveUuid(id, `${contactAddress}:${txid || id}`),
        txId: txid,
        senderAddress: String(message?.sender || "") || (isOutgoing ? myAddress : contactAddress),
        receiverAddress: String(message?.receiver || "") || (isOutgoing ? contactAddress : myAddress),
        content: text,
        timestamp: archiveIsoTimestamp(createdAt),
        blockTime: Math.max(0, Math.round(createdAt)),
        isOutgoing,
        messageType: archiveMessageType(message),
        deliveryStatus: ARCHIVE_STATUS_BY_DESKTOP_STATUS[String(message?.status || "")] || "sent",
      });
    }

    const entry = {
      conversationId: archiveUuid(conversationEntry.id, `conversation:${contactAddress}`),
      contactAddress,
      contactAlias: archiveContactAlias(contact),
      unreadCount: Math.max(0, Number(conversationEntry.unreadCount || 0)),
      messages: sortArchiveMessages(messages),
    };
    // Only carry a photo when one is set, to keep the shared file lean.
    const archivePhoto = contactPhotoToArchive(contact.photo);
    if (archivePhoto) entry.contactPhoto = archivePhoto;
    conversations.push(entry);
  }

  conversations.sort((a, b) => a.contactAddress.localeCompare(b.contactAddress));
  return {
    schemaVersion: CHAT_ARCHIVE_SCHEMA_VERSION,
    exportedAt: archiveIsoTimestamp(Date.now()),
    walletAddress: myAddress || null,
    conversations,
    // Groups ARE backed up again — now including decrypted message HISTORY, not just keys. The
    // on-chain recovery invite rebuilds a group and re-scans recent messages, but the indexer's
    // retention window can miss old ones; the backup preserves the full decrypted history so it
    // always comes back. Keys still travel too (belt-and-suspenders recovery).
    groups: buildArchiveGroups(),
    ...(tombstones.size ? { deletedContactAddresses: [...tombstones].sort() } : {}),
  };
}

// Full group key material PLUS decrypted message history for the shared backup archive, so a
// second device of the same account recovers every group (including admin groups, whose seed
// exists only on the creating device) with its complete history even if the indexer has pruned
// old messages. deviceId/msgCounter are per-device and deliberately omitted (the importer mints
// its own). Field names match the iOS/Android archive decoders.
function buildArchiveGroups() {
  const mgr = getGroupManager();
  if (!mgr) return [];
  try {
    return mgr.listGroups().map((g) => ({
      groupId: g.groupId,
      name: g.name || "Group",
      isAdmin: Boolean(g.isAdmin),
      adminAddress: g.adminAddress || null,
      adminSigningPub: g.adminSigningPub || null,
      groupSeed: g.groupSeedHex || null,
      groupRootEpoch: g.groupRootEpochHex || null,
      blindingKey: g.blindingKeyHex || null,
      currentEpoch: Number(g.currentEpoch || 0),
      photo: g.photoHex || null,                   // hex of the group photo JPEG (cross-platform)
      members: (g.members || []).map((m) => ({
        address: m.address,
        xOnlyPubKeyHex: m.xOnlyPubKeyHex || null,
        isAdmin: Boolean(m.isAdmin),
      })),
      messages: (groupMessages(g.groupId) || []).filter((msg) => !msg.system).map((msg) => ({
        msgIdHex: msg.msgIdHex || null,
        txId: msg.txId || null,
        senderAddress: msg.senderAddress || "",
        senderIdHex: msg.senderIdHex || null,
        content: String(msg.text || ""),          // decrypted plaintext (cross-platform field)
        blockTime: Number(msg.createdAt || 0),    // ms timestamp
        isOutgoing: msg.direction === "local",
        senderIsAdmin: Boolean(msg.senderIsAdmin),
      })),
    }));
  } catch { return []; }
}

function archiveExportedAtMs(archive) {
  const parsed = Date.parse(String(archive?.exportedAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Validates the archive already sitting on the server. Every failure path
 * THROWS — the caller aborts before uploading, so an unreadable or foreign
 * backup is left exactly as it was rather than being overwritten.
 */
function parseRemoteChatArchive(json) {
  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The backup already on the server is not readable JSON — nothing was uploaded and that file was left untouched. Move it aside (or pick another backup folder) to start a fresh backup.");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.conversations)) {
    throw new Error("The file already on the server is not a KaChat backup — nothing was uploaded and it was left untouched. Pick a different backup folder.");
  }
  if (Number(parsed.schemaVersion) !== CHAT_ARCHIVE_SCHEMA_VERSION) {
    throw new Error(`The backup already on the server uses schema version ${parsed.schemaVersion}, which this version can't merge — nothing was uploaded and it was left untouched.`);
  }
  const remoteWallet = String(parsed.walletAddress || "").trim();
  if (remoteWallet && engine.address && remoteWallet !== engine.address) {
    throw new Error(`The backup already on the server belongs to a different wallet (${shortAddress(remoteWallet)}) — nothing was uploaded. Choose a separate backup folder for this wallet.`);
  }
  return parsed;
}

/**
 * Union of the archive on the server and this device's archive — this is what
 * makes the shared file a sync point rather than last-writer-wins:
 *   * a conversation present on only ONE side is kept whole;
 *   * messages are deduped by txId (falling back to id for never-broadcast
 *     ones), keeping the better copy per iOS's preferMessage ordering;
 *   * conversation metadata (alias / unreadCount) comes from whichever archive
 *     was exported more recently, and an empty value never overwrites a real
 *     one; conversationId keeps the already-published value for stability.
 * A desktop backup can therefore never delete a phone's history, or vice versa.
 */
function mergeChatArchives(remote, local) {
  const remoteIsNewer = archiveExportedAtMs(remote) > archiveExportedAtMs(local);
  const merged = new Map();
  // Deletion tombstones: union of both sides, and tombstoned conversations are
  // dropped from the merge — a chat deleted on one device stays deleted in the
  // shared history instead of resurrecting from the other side's copy.
  const tombstones = new Set([
    ...(Array.isArray(remote?.deletedContactAddresses) ? remote.deletedContactAddresses : []),
    ...(Array.isArray(local?.deletedContactAddresses) ? local.deletedContactAddresses : []),
  ].map(String).filter(Boolean));

  const absorb = (conversation, isRemote) => {
    const contactAddress = String(conversation?.contactAddress || "").trim();
    if (!contactAddress) return;
    if (tombstones.has(contactAddress)) return;
    const metadataWins = isRemote ? remoteIsNewer : !remoteIsNewer;
    const alias = String(conversation?.contactAlias || "").trim();
    const photo = String(conversation?.contactPhoto || "").trim();
    const conversationId = String(conversation?.conversationId || "").trim();
    const unreadCount = Math.max(0, Number(conversation?.unreadCount || 0));

    let entry = merged.get(contactAddress);
    if (!entry) {
      entry = { conversationId: conversationId || null, contactAddress, contactAlias: alias || null, contactPhoto: photo || null, unreadCount, messages: new Map() };
      merged.set(contactAddress, entry);
    } else {
      if (alias && (metadataWins || !entry.contactAlias)) entry.contactAlias = alias;
      // Same rule as alias: the newer export wins, and an empty photo never clears a real one.
      if (photo && (metadataWins || !entry.contactPhoto)) entry.contactPhoto = photo;
      if (conversationId && !entry.conversationId) entry.conversationId = conversationId;
      if (metadataWins) entry.unreadCount = unreadCount;
    }

    for (const message of Array.isArray(conversation?.messages) ? conversation.messages : []) {
      if (!message || typeof message !== "object") continue;
      // Phantom scrub, matching iOS and Android. A row whose txId is blank or still a
      // provisional pending_ id never reached the chain and can never be reconciled with
      // its delivered self, so absorbing it would re-publish rows the phones just scrubbed
      // on this device's next upload, and render them locally as eternal "waiting" rows.
      if (isPhantomArchiveMessage(message)) continue;
      const key = archiveMessageKey(message);
      const existing = entry.messages.get(key);
      entry.messages.set(key, existing ? preferArchiveMessage(existing, message) : message);
    }
  };

  // Remote first so it seeds identity; local second so this device's newer view
  // can win the per-field metadata contest when it is in fact newer.
  for (const conversation of Array.isArray(remote?.conversations) ? remote.conversations : []) absorb(conversation, true);
  for (const conversation of local.conversations) absorb(conversation, false);

  const conversations = [...merged.values()]
    .map((entry) => ({
      // conversationId is normalized too — iOS decodes it as UUID?, so a
      // non-UUID one from another client would throw on its restore.
      conversationId: entry.conversationId ? archiveUuid(entry.conversationId, `conversation:${entry.contactAddress}`) : null,
      contactAddress: entry.contactAddress,
      contactAlias: entry.contactAlias,
      ...(entry.contactPhoto ? { contactPhoto: entry.contactPhoto } : {}),
      unreadCount: entry.unreadCount,
      messages: sortArchiveMessages([...entry.messages.values()].map(normalizeArchiveMessage)),
    }))
    .sort((a, b) => a.contactAddress.localeCompare(b.contactAddress));

  // Groups: union both sides by groupId so the shared cloud file keeps every device's groups
  // and the union of their message history. For a group in both, the higher currentEpoch wins
  // the key material and messages are unioned (deduped by msgIdHex/txId). A group tombstoned
  // (deleted) on THIS device is dropped from the merge so a delete isn't undone by the remote.
  const mgr = getGroupManager();
  const groupsById = new Map();
  const absorbGroup = (g) => {
    const id = String(g?.groupId || "").trim();
    if (!id) return;
    if (mgr?.isGroupTombstoned?.(id)) return;
    const incomingEpoch = Number(g.currentEpoch || 0);
    const existing = groupsById.get(id);
    const msgMap = existing?.__msgMap || new Map();
    for (const m of Array.isArray(g.messages) ? g.messages : []) {
      const key = String(m?.msgIdHex || m?.txId || "");
      if (key && !msgMap.has(key)) msgMap.set(key, m);
    }
    if (!existing || incomingEpoch >= Number(existing.currentEpoch || 0)) {
      groupsById.set(id, { ...g, __msgMap: msgMap });
    } else {
      existing.__msgMap = msgMap;
    }
  };
  for (const g of Array.isArray(remote?.groups) ? remote.groups : []) absorbGroup(g);
  for (const g of Array.isArray(local?.groups) ? local.groups : []) absorbGroup(g);
  const mergedGroups = [...groupsById.values()].map((g) => {
    const { __msgMap, ...rest } = g;
    return { ...rest, messages: [...__msgMap.values()] };
  });

  return {
    schemaVersion: CHAT_ARCHIVE_SCHEMA_VERSION,
    exportedAt: local.exportedAt,
    walletAddress: local.walletAddress || String(remote?.walletAddress || "") || null,
    conversations,
    ...(mergedGroups.length ? { groups: mergedGroups } : {}),
    ...(tombstones.size ? { deletedContactAddresses: [...tombstones].sort() } : {}),
  };
}

/** The desktop-only half of the backup, carried in the additive `desktopState`
 *  key. Both phone decoders skip unknown top-level keys (iOS: synthesized
 *  Codable init; Android: Gson, which has no strict-unknown mode at all), so
 *  this rides along without breaking either restore. */
function buildDesktopStateSnapshot() {
  return {
    kind: SHARED_BACKUP_KIND,
    version: 1,
    savedAt: new Date().toISOString(),
    state: JSON.parse(chatStorageGetSync(accountScopedKey(STORAGE_KEY)) || "null"),
    history: JSON.parse(chatStorageGetSync(accountScopedKey(MESSAGE_HISTORY_KEY)) || "null"),
    // Per-contact prefs (mute + photo-display toggle) live in a separate global key,
    // so they must be carried explicitly or a restore would lose them.
    contactPrefs: (() => { try { return JSON.parse(localStorage.getItem(CONTACT_PREFS_KEY) || "{}") || {}; } catch { return {}; } })(),
    // Per-group notification mode (Group Info > Notifications) lives in its own global key
    // for the same reason, so it rides along too.
    groupPrefs: (() => { try { return JSON.parse(localStorage.getItem(GROUP_PREFS_KEY) || "{}") || {}; } catch { return {}; } })(),
  };
}

/**
 * Full upload body for `kachat-backup.json`. `existingRemoteJson` is whatever
 * the server already holds (null when there is no backup yet); it is merged in
 * so this upload can only ever ADD to the shared history.
 */
function buildSharedBackupPayload(existingRemoteJson = null) {
  const local = buildLocalChatArchive();
  const remote = existingRemoteJson ? parseRemoteChatArchive(existingRemoteJson) : null;
  const archive = remote ? mergeChatArchives(remote, local) : local;
  archive.desktopState = buildDesktopStateSnapshot();
  return JSON.stringify(archive, null, 2);
}

// ---------------------------------------------------------------------------
// Encrypted Backup Envelope (v1) — see ui/backup-crypto.js. The cloud copy of
// `kachat-backup.json` is encrypted at rest with a key derived from the
// identity private key (engine.privateKeyHex, the m/44'/111111'/0'/0/0 key),
// so every device on the same seed reads/writes the same file and nothing else
// can. The plaintext INSIDE the envelope is the unchanged ChatHistoryArchive,
// desktopState included.
// ---------------------------------------------------------------------------

/** Writer half: encrypts a plaintext archive JSON string into the envelope. */
async function sealSharedBackupJson(plaintextJson) {
  const identityKeyHex = String(engine.privateKeyHex || "").trim();
  if (!identityKeyHex) throw new Error("The wallet key is unavailable, so the backup could not be encrypted. Nothing was uploaded.");
  return sealBackupEnvelope(plaintextJson, identityKeyHex, String(engine.address || ""));
}

/** Reader half: envelope in, plaintext archive out; legacy plaintext passes
 *  through unchanged. Throws on a foreign walletHint or a failed decrypt, so
 *  callers abort before uploading or importing anything. */
async function openSharedBackupJson(json) {
  if (json == null) return json;
  return openBackupEnvelope(json, String(engine.privateKeyHex || "").trim(), String(engine.address || ""));
}

/** Write-through of a desktop state snapshot (from `desktopState`, or from a
 *  legacy kachat-backup-desktop.json body) into the live storage. */
function applyDesktopStateSnapshot(snapshot) {
  // Restoring is a backfill: the next sync sweep must not notify or mark its messages
  // unread (see pendingInitialCatchUp).
  pendingInitialCatchUp = true;
  const serialized = JSON.stringify(snapshot.state);
  chatStorageSetSync(accountScopedKey(STORAGE_KEY), serialized);
  chatStorageSetSync(accountScopedKey(STATE_BACKUP_KEY), serialized);
  if (snapshot.history) {
    chatStorageSetSync(accountScopedKey(MESSAGE_HISTORY_KEY), JSON.stringify(snapshot.history));
  }
  // Restore per-contact prefs by MERGING (never clobber prefs for contacts outside
  // this backup, e.g. another account's contacts sharing the global store).
  if (snapshot.contactPrefs && typeof snapshot.contactPrefs === "object") {
    try {
      const current = JSON.parse(localStorage.getItem(CONTACT_PREFS_KEY) || "{}") || {};
      contactPrefs = { ...current, ...snapshot.contactPrefs };
      localStorage.setItem(CONTACT_PREFS_KEY, JSON.stringify(contactPrefs));
    } catch { /* leave existing prefs untouched on parse failure */ }
  }
  // Same merge rule for the per-group notification modes.
  if (snapshot.groupPrefs && typeof snapshot.groupPrefs === "object") {
    try {
      const current = JSON.parse(localStorage.getItem(GROUP_PREFS_KEY) || "{}") || {};
      groupPrefs = { ...current, ...snapshot.groupPrefs };
      localStorage.setItem(GROUP_PREFS_KEY, JSON.stringify(groupPrefs));
    } catch { /* leave existing prefs untouched on parse failure */ }
  }
  reloadStateFromBrowserStorage();
  renderChats();
}

/** Restores the desktop-only state carried inside a shared archive. Returns
 *  false when the file has none (i.e. it was written by a phone), which is the
 *  cue to fall back to a legacy desktop backup file if one is still there. */
function importDesktopStateFromSharedArchive(json) {
  let parsed = null;
  try { parsed = JSON.parse(json); } catch { return false; }
  const snapshot = parsed?.desktopState;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.state) return false;
  applyDesktopStateSnapshot(snapshot);
  return true;
}

// Sends a reaction as a real on-chain message (same encrypted pipeline as
// text), but — matching iOS — never creates a visible bubble for it: applies
// optimistically to the local reactions store first, then fires the actual
// send in the background through the same serialized send queue every other
// on-chain action uses.
// ---------------------------------------------------------------------------
// Reaction delivery status (iOS parity): a just-sent reaction shows a small
// checkmark once it is on-chain (auto-hides after 60s) or a red "!" that
// retries on click when the send failed. Keyed "surface|targetKey|emoji",
// in-memory only — history never shows stale indicators.
// ---------------------------------------------------------------------------
const reactionSendStatus = new Map();

function setReactionSendStatus(key, status, { retry = null, rerender = null } = {}) {
  reactionSendStatus.set(key, { status, retry });
  if (status === "sent") {
    window.setTimeout(() => {
      if (reactionSendStatus.get(key)?.status === "sent") {
        reactionSendStatus.delete(key);
        try { rerender?.(); } catch {}
      }
    }, 60_000);
  }
  try { rerender?.(); } catch {}
}

/** Tiny status element for a reaction chip, or null when there's nothing to show. */
function reactionStatusIndicator(key) {
  const entry = reactionSendStatus.get(key);
  if (!entry) return null;
  const el = document.createElement("span");
  if (entry.status === "pending") {
    el.className = "reaction-status pending";
    el.textContent = "…";
    el.title = "Sending reaction…";
  } else if (entry.status === "sent") {
    el.className = "reaction-status sent";
    el.textContent = "✓";
    el.title = "Reaction sent";
  } else {
    el.className = "reaction-status failed";
    el.textContent = "!";
    el.title = "Reaction failed to send — click to retry";
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      entry.retry?.();
    });
  }
  return el;
}

async function sendReaction(conversationEntry, targetMessage, emoji) {
  const contact = contactForConversation(conversationEntry);
  if (!contact || !engine.address) return;
  const targetTxId = targetMessage.txid || targetMessage.id;
  const myAddress = engine.address;
  const existing = (conversationEntry.reactionsByTxId?.[targetTxId] || []).find((entry) => entry.reactorAddress === myAddress);
  const action = existing?.emoji === emoji ? "remove" : "add";

  if (action === "add") applyLocalReaction(conversationEntry, targetTxId, myAddress, emoji);
  else removeLocalReaction(conversationEntry, targetTxId, myAddress);
  persistState();
  renderMessages(conversationEntry);
  renderChats();

  const payload = JSON.stringify({ type: "reaction", targetTxId, emoji, action });
  // Delivery indicator only for ADDs — a removal deletes the chip, so there is
  // nothing to badge (matches iOS).
  const statusKey = action === "add" ? `dm|${targetTxId}|${emoji}` : null;
  const rerender = () => { if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry); };
  const attempt = async () => {
    if (statusKey) setReactionSendStatus(statusKey, "pending", { rerender });
    try {
      const envelope = await engine.createEncryptedMessageEnvelope({
        conversationId: conversationEntry.id,
        contactId: contact.id,
        toAddress: contact.address,
        fromAddress: engine.address,
        text: payload,
        localNonce: nowId(),
        createdAt: Date.now(),
      });
      await engine.sendMessageOnchain({ envelope, amountKas: onchainAmountKas(), feeKas: "0", onStatus: () => {} });
      if (statusKey) setReactionSendStatus(statusKey, "sent", { rerender });
    } catch (error) {
      appendEngineLog(`Reaction send failed (local state already applied): ${error.message}`);
      if (statusKey) setReactionSendStatus(statusKey, "failed", { retry: attempt, rerender });
    }
  };
  await attempt();
}

pendingPhotoRemove?.addEventListener("click", clearPendingPhoto);

photoFileInput?.addEventListener("change", async () => {
  const file = photoFileInput.files?.[0];
  if (!file) return;
  await attachPhotoBlob(file);
  photoFileInput.value = "";
});

composer.elements.message?.addEventListener("paste", async (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.type?.startsWith("image/"));
  if (!imageItem) return;
  event.preventDefault();
  if (composerMode === "kas") await activateComposerMode("message");
  const file = imageItem.getAsFile();
  if (file) await attachPhotoBlob(file);
});

composerModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.composerMode;
    closeComposerMenu();
    if (mode === "message") {
      activateComposerMode("message");
    } else if (mode === "kas") {
      activateComposerMode("kas");
    } else if (mode === "photo") {
      activateComposerMode("message");
      photoFileInput?.click();
    } else if (mode === "voice") {
      activateComposerMode("message");
      startVoiceRecording();
    } else if (mode === "handshake") {
      sendHandshakeFromComposer();
    }
  });
});

document.addEventListener("click", (event) => {
  const plusOpen = !!composerPlusMenu && !composerPlusMenu.hidden;
  const tcOpen = !!chessTcMenu && !chessTcMenu.hidden;
  if (!plusOpen && !tcOpen) return;
  if (composerPlusMenu?.contains(event.target) || chessTcMenu?.contains(event.target)) return;
  if (composerPlusButton?.contains(event.target)) return;
  closeComposerMenu();
});

function hideFeeEstimateBanner() {
  if (feeEstimateDebounceTimer) window.clearTimeout(feeEstimateDebounceTimer);
  feeEstimateDebounceTimer = null;
  if (feeEstimateBanner) feeEstimateBanner.hidden = true;
}

function hideHandshakeWarningBanner() {
  if (handshakeWarningBanner) handshakeWarningBanner.hidden = true;
}

// A handshake is a real on-chain transaction that has to be signed and accepted
// by a node, so the banner's button says so instead of looking inert.
const handshakeWarningSendButton = document.querySelector("[data-handshake-warning-send]");
function setHandshakeWarningButtonBusy(busy) {
  if (!handshakeWarningSendButton) return;
  handshakeWarningSendButton.disabled = Boolean(busy);
  handshakeWarningSendButton.textContent = busy ? "Sending…" : "Send Handshake";
}

// Relationship states that still need the "they may never see this" warning:
// nothing proves the other side can decrypt our messages yet. "incoming-request"
// and "declined" are deliberately absent — those conversations already show the
// Accept/Decline request card, and the banner's copy ("until they message you")
// is simply untrue there, since they messaged us first.
const HANDSHAKE_WARNING_STATES = new Set(["legacy-manual", "outgoing-request", "request-failed"]);

// Matches what the phones now do: the warning is up from the moment a 1:1
// conversation is opened — no typing required — and only disappears once the
// relationship is provably mutual. "established" is the single source of truth
// for that: promoteRelationshipFromIncomingEvidence only sets it once there's a
// genuine non-handshake message in both directions (legacy-manual) or a
// reciprocal incoming message answering our request (outgoing-request).
// Only ever applies to 1:1 chats: this banner lives in the direct-conversation
// composer, which group chats (placeholder only), Broadcasts and KaPosts never
// use — they are separate tab screens with their own composers.
function updateHandshakeWarningBanner() {
  if (!handshakeWarningBanner) return;
  // Payment mode stacks the Available/fee pills over the composer; keep the
  // banner out of that crowd, it's a message-mode warning anyway.
  if (composerMode !== "message" || !activeConversationId) {
    hideHandshakeWarningBanner();
    return;
  }
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact || !HANDSHAKE_WARNING_STATES.has(contact.relationshipState)) {
    hideHandshakeWarningBanner();
    return;
  }
  // A handshake FROM them ends the warning immediately (iOS parity). Whether it accepts
  // ours or initiates their own, their side provably has the conversation and can see what
  // we send, so waiting for a genuine reply left this banner up after the handshake had
  // already completed. A handshake we sent and they haven't answered still shows it.
  const theirHandshake = (conversationEntry.messages || []).some((message) =>
    message?.direction === "incoming" && message?.messageType === "handshake"
  );
  if (theirHandshake) {
    hideHandshakeWarningBanner();
    return;
  }
  handshakeWarningBanner.hidden = false;
}

// Approximates the real Kasia COMM payload's byte length for this draft
// (ciph_msg:1:comm:<alias>: prefix + base64 of nonce+pubkey+ciphertext+tag),
// then asks the engine for the real SDK-calculated fee for a payload that
// size — an honest estimate built from the actual send path, not a guess.
function estimateCommPayloadBytes(text) {
  const cipherBytes = 12 + 33 + new TextEncoder().encode(text).length + 16;
  const base64Len = Math.ceil(cipherBytes / 3) * 4;
  const prefixLen = "kchat:1:comm:".length + 12 + 1;
  return prefixLen + base64Len;
}

function scheduleFeeEstimate() {
  if (!feeEstimateBanner || !accountShellPrefs.estimateFees || composerMode !== "message") {
    hideFeeEstimateBanner();
    return;
  }
  const text = String(composer.elements.message?.value || "").trim();
  if (!text || !activeConversationId || !engine.address) {
    hideFeeEstimateBanner();
    return;
  }
  if (feeEstimateDebounceTimer) window.clearTimeout(feeEstimateDebounceTimer);
  const token = ++feeEstimateRequestToken;
  feeEstimateDebounceTimer = window.setTimeout(async () => {
    try {
      const payloadBytes = estimateCommPayloadBytes(text);
      const feeKas = await engine.estimateMessageFee(payloadBytes);
      if (token !== feeEstimateRequestToken || !feeEstimateBanner) return;
      if (feeKas == null) { feeEstimateBanner.hidden = true; return; }
      feeEstimateBanner.textContent = `Estimated fee ${feeKas} KAS`;
      feeEstimateBanner.hidden = false;
    } catch {
      if (token === feeEstimateRequestToken && feeEstimateBanner) feeEstimateBanner.hidden = true;
    }
  }, 450);
}

composer.elements.message?.addEventListener("input", scheduleFeeEstimate);

handshakeWarningSendButton?.addEventListener("click", async () => {
  await sendHandshakeFromComposer();
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeConversationId) return;

  const input = composer.elements.message;
  const text = String(input.value || "").trim();

  if (pendingPhotoAttachment) {
    const attachment = pendingPhotoAttachment;
    input.value = "";
    autoGrowComposer();
    clearPendingPhoto();
    hideFeeEstimateBanner();
    // "Send Media via Nextcloud": upload the full-quality original and send its share link
    // (renders as a media bubble on the recipient's side). Any failure falls back to the
    // on-chain envelope so the message never silently vanishes.
    if (isNextcloudMediaSendActive() && attachment.originalBlob) {
      const conversationId = activeConversationId;
      setStatus("Uploading photo to Nextcloud…");
      try {
        const url = await uploadNextcloudMedia(
          attachment.originalBlob,
          attachment.originalName || "photo.jpg",
          attachment.originalBlob.type || "image/jpeg"
        );
        queueConversationMessage(conversationId, url);
        setStatus("Photo sent via Nextcloud.");
        return;
      } catch (error) {
        showCopyToast(`Nextcloud upload failed — sending on-chain instead. (${error.message})`);
      }
    }
    queueConversationMessage(activeConversationId, buildImageEnvelopeJson(attachment));
    return;
  }

  if (!text) return;

  if (composerMode === "kas") {
    try {
      await sendKasPayment(activeConversationId, text);
    } catch (error) {
      setStatus(`Payment failed: ${error.message}`);
    }
    return;
  }

  input.value = "";
  autoGrowComposer();
  hideFeeEstimateBanner();
  queueConversationMessage(activeConversationId, text);
});

// The composer is a textarea so long messages wrap onto new lines. It grows with the
// content up to its CSS max-height, then scrolls. Enter sends; Shift+Enter adds a newline.
const composerInputField = composer?.elements?.message;
function autoGrowComposer() {
  if (!composerInputField) return;
  composerInputField.style.height = "auto";
  composerInputField.style.height = `${Math.min(composerInputField.scrollHeight, 132)}px`;
}
composerInputField?.addEventListener("input", autoGrowComposer);
composerInputField?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (typeof composer.requestSubmit === "function") composer.requestSubmit();
    else composer.dispatchEvent(new Event("submit", { cancelable: true }));
  }
});


if (indexerUrlInput) {
  indexerUrlInput.value = localStorage.getItem(INDEXER_URL_KEY) || indexerUrlInput.value || getEndpoint("kasiaIndexer");
  indexerUrlInput.addEventListener("change", () => {
    localStorage.setItem(INDEXER_URL_KEY, indexerUrlInput.value.trim());
    renderTransportReadiness();
  });
}

testIndexerButton?.addEventListener("click", async () => {
  try {
    testIndexerButton.disabled = true;
    setStatus("Testing Kasia indexer…");
    const result = await engine.testKasiaIndexer(indexerUrlInput?.value?.trim());
    setStatus("Kasia indexer connected");
    appendEngineLog(`Kasia indexer online: ${result.baseUrl}`);
  } catch (error) {
    setStatus("Kasia indexer test failed");
    appendEngineLog(`Indexer failed: ${error.message}`);
  } finally {
    testIndexerButton.disabled = false;
  }
});

document.querySelectorAll("[data-cancel-onchain-send]").forEach((button) => {
  button.addEventListener("click", closeOnchainConfirm);
});

document.querySelector("[data-confirm-onchain-send]")?.addEventListener("click", () => {
  const draft = pendingOnchainDraft;
  if (!draft) return closeOnchainConfirm();
  if (composer?.elements?.message) composer.elements.message.value = "";
  closeOnchainConfirm();
  queueConversationMessage(draft.conversationId, draft.text);
});

onchainConfirmModal?.addEventListener("click", (event) => {
  if (event.target === onchainConfirmModal) closeOnchainConfirm();
});

document.querySelector("[data-load-wasm]").addEventListener("click", async () => {
  await ensureRuntimes();
});


document.querySelector("[data-load-kasia-cipher]")?.addEventListener("click", async () => {
  await ensureRuntimes();
});

function openSavedAccounts() {
  localStorage.setItem(SESSION_LOGGED_OUT_KEY, "true");
  clearSessionActive();
  showLoggedOutScreen();
}

document.querySelectorAll("[data-open-account-manager]").forEach((button) => {
  const label = button.textContent?.trim().toLowerCase() || "";
  button.addEventListener("click", () => {
    if (label.includes("add") || button.classList.contains("profile-account-add")) openCreateAccountModal();
    else openSavedAccounts();
  });
});

document.querySelector("[data-open-profile-account]")?.addEventListener("click", () => {
  closeAccountOverlay();
  setActiveAppTab("profile");
});

const createAccountModal = document.querySelector("[data-create-account-modal]");
const createAccountError = document.querySelector("[data-create-account-error]");
const createAccountErrorSeed = document.querySelector("[data-create-account-error-seed]");
const createNameInput = document.querySelector("[data-create-name]");
const createPassphraseInput = document.querySelector("[data-create-passphrase]");
const createSeedGrid = document.querySelector("[data-seed-grid]");
const createSeedReveal = document.querySelector("[data-seed-reveal]");
const createSeedConfirm = document.querySelector("[data-seed-confirm]");
const createContinueBtn = document.querySelector("[data-continue-to-passphrase]");
const generateAccountBtn = document.querySelector("[data-generate-account]");
const createPassphraseConfirm = document.querySelector("[data-create-passphrase-confirm]");
const createPassphraseError = document.querySelector("[data-create-passphrase-error]");
const passphraseToggleBtn = document.querySelector("[data-create-passphrase-toggle]");
createPassphraseInput?.addEventListener("input", () => schedulePassphrasePreview("create"));
const continueWithPassphraseBtn = document.querySelector("[data-create-passphrase-submit]");
const skipPassphraseBtn = document.querySelector("[data-create-passphrase-no]");

// --- The passphrase wizard: question, then entry, then explainer (iOS PassphraseOptionView) ---
//
// It used to be one page with the fields already on it and two buttons at the bottom, which asks
// someone to decide before it has told them what they are deciding - and most people meeting this
// screen have never heard of a passphrase. So it opens with the question on its own, with a way to
// go and read about it first. Same three screens, same copy, as iOS.
function showPassphraseScreen(flow, screen) {
  document.querySelectorAll(`[data-${flow}-passphrase-screen]`).forEach((el) => {
    el.hidden = el.dataset[`${flow}PassphraseScreen`] !== screen;
  });
}
const recoveryModal = document.querySelector("[data-recovery-modal]");
const recoveryPhraseBox = document.querySelector("[data-recovery-phrase]");
const revealRecoveryButton = document.querySelector("[data-reveal-recovery]");
const recoveryProgressFill = document.querySelector("[data-recovery-progress]");

// Pending new account carried between the setup step and the seed-confirm step.
let pendingNewAccount = null;

// --- Live chatting-address preview on the passphrase step (create and import) ---
//
// A passphrase does not protect one account, it opens a DIFFERENT one. Watching address #0
// change with every character is what makes that concrete, and on import it is how someone
// confirms they typed the right passphrase before committing to an account that would otherwise
// just look empty. Mirrors iOS's PassphraseOptionView, which shows the same thing for the same
// stated reason.
//
// Debounced because each derivation is a full BIP39 seed (PBKDF2) plus a key derivation - far too
// heavy to run per keystroke.
const passphrasePreviewTokens = { create: 0, import: 0 };

function passphrasePreviewNodes(flow) {
  const root = document.querySelector(`[data-passphrase-preview="${flow}"]`);
  if (!root) return null;
  return {
    root,
    address: root.querySelector("[data-passphrase-preview-address]"),
    note: root.querySelector("[data-passphrase-preview-note]"),
  };
}

/** The seed words the flow is about to commit, or "" when there are none to derive from. */
function passphrasePreviewPhrase(flow) {
  if (flow === "create") return pendingNewAccount?.phrase || "";
  return pendingImport?.recoveryPhrase || "";
}

function passphrasePreviewFamily(flow) {
  if (flow === "create") return "kaspaStandard";
  return pendingImport?.family || "kaspaStandard";
}

let passphrasePreviewTimers = { create: null, import: null };

function schedulePassphrasePreview(flow) {
  const nodes = passphrasePreviewNodes(flow);
  if (!nodes) return;
  const phrase = passphrasePreviewPhrase(flow);
  // Nothing to derive from yet: hide rather than show a permanent "Checking...".
  nodes.root.hidden = !phrase;
  if (!phrase) return;

  const input = flow === "create" ? createPassphraseInput : importPassphraseInput;
  const passphrase = input?.value || "";
  nodes.note.textContent = passphrase
    ? "A different passphrase gives a different address, and a different account."
    : "This is the account your seed phrase opens on its own.";

  if (passphrasePreviewTimers[flow]) clearTimeout(passphrasePreviewTimers[flow]);
  const token = ++passphrasePreviewTokens[flow];
  nodes.address.dataset.pending = "1";
  passphrasePreviewTimers[flow] = setTimeout(async () => {
    try {
      const derived = await engine.deriveIdentityAddressRange(phrase, passphrase, {
        family: passphrasePreviewFamily(flow),
        start: 0,
        count: 1,
      });
      // A later keystroke already asked for a different address - drop this answer.
      if (token !== passphrasePreviewTokens[flow]) return;
      const address = derived?.[0]?.address;
      if (address) {
        nodes.address.textContent = address;
        delete nodes.address.dataset.pending;
      } else {
        nodes.address.textContent = "Could not derive an address from this phrase.";
      }
    } catch (error) {
      if (token !== passphrasePreviewTokens[flow]) return;
      nodes.address.textContent = "Could not derive an address from this phrase.";
      appendEngineLog(`Passphrase address preview failed: ${error.message}`);
    }
  }, 250);
}

function resetPassphrasePreview(flow) {
  const nodes = passphrasePreviewNodes(flow);
  if (!nodes) return;
  passphrasePreviewTokens[flow] += 1;
  if (passphrasePreviewTimers[flow]) clearTimeout(passphrasePreviewTimers[flow]);
  nodes.address.textContent = "Checking...";
  nodes.address.dataset.pending = "1";
}

function showCreateStep(step) {
  document.querySelectorAll("[data-create-step]").forEach((el) => { el.hidden = el.dataset.createStep !== step; });
}
function openCreateAccountModal() {
  pendingNewAccount = null;
  if (createAccountError) { createAccountError.hidden = true; createAccountError.textContent = ""; }
  if (createAccountErrorSeed) createAccountErrorSeed.hidden = true;
  if (createNameInput) createNameInput.value = "My Account";
  if (createPassphraseInput) { createPassphraseInput.value = ""; createPassphraseInput.type = "password"; }
  if (createPassphraseConfirm) createPassphraseConfirm.value = "";
  if (createPassphraseError) createPassphraseError.hidden = true;
  const w24 = document.querySelector('input[name="wordCount"][value="24"]');
  if (w24) w24.checked = true;
  showCreateStep("setup");
  if (createAccountModal) createAccountModal.hidden = false;
  queueMicrotask(() => createNameInput?.focus());
}
function closeCreateAccountModal() {
  if (createAccountModal) createAccountModal.hidden = true;
  pendingNewAccount = null;
  if (!engine.address || localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true") showLoggedOutScreen();
}
document.querySelectorAll("[data-close-create-account]").forEach((button) => button.addEventListener("click", closeCreateAccountModal));
createAccountModal?.addEventListener("click", (event) => { if (event.target === createAccountModal) closeCreateAccountModal(); });

function renderSeedGrid(phrase) {
  if (!createSeedGrid) return;
  createSeedGrid.replaceChildren();
  phrase.split(/\s+/).filter(Boolean).forEach((word, index) => {
    const cell = document.createElement("div");
    cell.className = "seed-grid-cell";
    cell.innerHTML = `<span class="seed-grid-index">${index + 1}.</span><span class="seed-grid-word"></span>`;
    cell.querySelector(".seed-grid-word").textContent = word;
    createSeedGrid.appendChild(cell);
  });
}

// STEP 1 → STEP 2: generate a phrase and show it for backup (no derivation yet).
generateAccountBtn?.addEventListener("click", async () => {
  const name = String(createNameInput?.value || "").trim();
  const wordCount = Number(document.querySelector('input[name="wordCount"]:checked')?.value || 24);
  if (!name) { if (createAccountError) { createAccountError.textContent = "Enter an account name."; createAccountError.hidden = false; } return; }
  if (![12, 24].includes(wordCount)) { if (createAccountError) { createAccountError.textContent = "Choose a 12 or 24 word seed phrase."; createAccountError.hidden = false; } return; }
  generateAccountBtn.disabled = true;
  if (createAccountError) createAccountError.hidden = true;
  try {
    if (!engine.kaspa) await ensureRuntimes();
    // If the WASM genuinely failed to load, show the real reason (e.g. a fetch/HTTP error behind a
    // proxy) instead of the opaque "Load Rusty Kaspa WASM first." from the SDK guard.
    if (!engine.kaspa && lastWasmError) throw new Error(`Kaspa engine failed to load: ${lastWasmError.message}`);
    const phrase = engine.generateMnemonicPhrase(wordCount);
    const words = phrase.split(/\s+/).filter(Boolean);
    if (words.length !== wordCount) throw new Error(`Expected ${wordCount} words but generated ${words.length}.`);
    pendingNewAccount = { name, wordCount, phrase, passphrase: "" };
    renderSeedGrid(phrase);
    // Reset the reveal/confirm gate each time.
    if (createSeedGrid) createSeedGrid.hidden = true;
    if (createSeedReveal) createSeedReveal.hidden = false;
    if (createSeedConfirm) createSeedConfirm.checked = false;
    if (createContinueBtn) createContinueBtn.disabled = true;
    if (createAccountErrorSeed) createAccountErrorSeed.hidden = true;
    showCreateStep("seed");
  } catch (error) {
    if (createAccountError) { createAccountError.textContent = error.message; createAccountError.hidden = false; }
  } finally {
    generateAccountBtn.disabled = false;
  }
});

createSeedReveal?.addEventListener("click", () => {
  if (createSeedGrid) createSeedGrid.hidden = false;
  if (createSeedReveal) createSeedReveal.hidden = true;
});
createSeedConfirm?.addEventListener("change", () => {
  if (createContinueBtn) createContinueBtn.disabled = !createSeedConfirm.checked;
});

// STEP 2 → enter app: derive the wallet (with optional passphrase), persist, and
// launch the setup guide (new accounts only), matching iOS's justCreatedNewWallet.
async function finalizeNewAccount({ name, phrase, passphrase, wordCount }) {
  if (!engine.kaspa) await ensureRuntimes();
  const wallet = engine.importMnemonic(phrase, passphrase);
  if (!wallet?.privateKeyHex || !wallet?.address?.startsWith("kaspa:") || !wallet?.mnemonic) {
    engine.clearSession();
    throw new Error("Wallet generation did not produce a valid mainnet identity.");
  }

  const createdAt = new Date().toISOString();
  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[wallet.address] = { name, createdAt };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  activateWalletDataScope(wallet.address, { migrateLegacy: false });
  state = { contacts: [], conversations: [] };
  persistState();
  persistTestingWallet({ mnemonic: wallet.mnemonic, passphrase, derivationPath: wallet.derivationPath, wordCount });

  if (accountShellPrefs.saveAccount !== false) {
    const saved = loadSavedAccounts().find((entry) => entry.address === wallet.address);
    if (!saved?.privateKeyHex || !saved?.mnemonic || saved?.name !== name) {
      engine.clearSession();
      throw new Error("The new account could not be verified after saving.");
    }
  }

  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
  markSessionActive();
  hideLoggedOutScreen();
  // A brand-new account lands on Chats. The remembered spot is the LAST session's tab, which
  // belongs to a different account entirely - being dropped into Profile (or Cold Storage) on
  // an account that has neither a profile nor any funds yet is nobody's idea of where to start.
  setActiveAppTab("chats");
  requestNotificationPermissionIfNeeded();
  currentBalanceKas = "--";
  updateWalletUi();
  updateServiceSummary();
  refreshSubscriptionAddresses({ restart: false });
  appendEngineLog(`Created ${wordCount}-word account ${name}: ${wallet.address}${wallet.hasPassphrase ? " (passphrase set)" : ""}`);
  renderChats();
  void connectAndRefresh({ quiet: true })
    .then(async () => {
      // Same as the import path: entering the app in-place skips the startup sweep/timer.
      await refreshAllConversations({ quiet: true });
      startAutomaticRefresh();
    })
    .catch((error) => {
      appendEngineLog(`Post-create RPC startup failed: ${error.message}`);
      setStatus(`Account created. Network connection failed: ${error.message}`);
    });
  return wallet;
}

// STEP 2 → STEP 3: after backing up the seed, advance to the optional passphrase
// step (the wallet isn't derived until a passphrase is chosen or skipped).
createContinueBtn?.addEventListener("click", () => {
  if (!pendingNewAccount || !createSeedConfirm?.checked) return;
  if (createPassphraseInput) { createPassphraseInput.value = ""; createPassphraseInput.type = "password"; }
  if (createPassphraseConfirm) createPassphraseConfirm.value = "";
  if (createPassphraseError) createPassphraseError.hidden = true;
  if (passphraseToggleBtn) passphraseToggleBtn.textContent = "Show";
  showCreateStep("passphrase");
  showPassphraseScreen("create", "question");
  queueMicrotask(() => createPassphraseInput?.focus());
});

passphraseToggleBtn?.addEventListener("click", () => {
  if (!createPassphraseInput) return;
  const show = createPassphraseInput.type === "password";
  createPassphraseInput.type = show ? "text" : "password";
  if (createPassphraseConfirm) createPassphraseConfirm.type = show ? "text" : "password";
  passphraseToggleBtn.textContent = show ? "Hide" : "Show";
});

// STEP 3 → enter app: derive with the chosen passphrase ("" when skipped),
// persist, and launch the setup guide.
async function commitPendingAccount(passphrase) {
  if (!pendingNewAccount) return;
  const account = { ...pendingNewAccount, passphrase };
  const buttons = [continueWithPassphraseBtn, skipPassphraseBtn];
  buttons.forEach((b) => { if (b) b.disabled = true; });
  if (createPassphraseError) createPassphraseError.hidden = true;
  try {
    await finalizeNewAccount(account);
    pendingNewAccount = null;
    if (createAccountModal) createAccountModal.hidden = true;
    showCopyToast("Account created");
    // First-run experience begins. Both markers are persisted BEFORE presenting
    // (iOS MainTabView does the same): the in-memory "just created" trigger is
    // lost on a page reload, so without them a reload mid-guide would be a
    // permanent way past a mandatory run. markUserTypePending never downgrades
    // "chosen", which is exactly why the run marker exists alongside it.
    markUserTypePending();
    markOnboardingRunPending("create");
    openSetupGuide({ onboardingRun: true });
  } catch (error) {
    appendEngineLog(`Create account failed: ${error.message}`);
    if (createPassphraseError) { createPassphraseError.textContent = error.message; createPassphraseError.hidden = false; }
  } finally {
    buttons.forEach((b) => { if (b) b.disabled = false; });
  }
}

document.querySelector("[data-create-passphrase-yes]")?.addEventListener("click", () => {
  showPassphraseScreen("create", "entry");
  resetPassphrasePreview("create");
  schedulePassphrasePreview("create");
  createPassphraseInput?.focus();
});
document.querySelector("[data-create-passphrase-explain]")?.addEventListener("click", () => {
  showPassphraseScreen("create", "explainer");
});
document.querySelector("[data-create-passphrase-explain-back]")?.addEventListener("click", () => {
  showPassphraseScreen("create", "question");
});
// Back clears what was typed: returning to the question and answering No must not commit a
// passphrase the user has already walked away from.
document.querySelector("[data-create-passphrase-back]")?.addEventListener("click", () => {
  if (createPassphraseInput) createPassphraseInput.value = "";
  if (createPassphraseConfirm) createPassphraseConfirm.value = "";
  if (createPassphraseError) createPassphraseError.hidden = true;
  showPassphraseScreen("create", "question");
});

continueWithPassphraseBtn?.addEventListener("click", () => {
  const pass = String(createPassphraseInput?.value || "");
  if (!pass) {
    if (createPassphraseError) { createPassphraseError.textContent = "Enter a passphrase, or go Back and choose No to continue without one."; createPassphraseError.hidden = false; }
    return;
  }
  if (pass !== String(createPassphraseConfirm?.value || "")) {
    if (createPassphraseError) { createPassphraseError.textContent = "The passphrases don't match. Please re-enter them."; createPassphraseError.hidden = false; }
    return;
  }
  void commitPendingAccount(pass);
});
skipPassphraseBtn?.addEventListener("click", () => void commitPendingAccount(""));

// --- Setup Guide wizard (iOS WelcomeGuideView). Pops up after creating a new
// account; also reopenable from Profile. 8 forward steps + Skip. ---
const setupGuideModal = document.querySelector("[data-setup-guide-modal]");
const setupIconEl = document.querySelector("[data-setup-icon]");
const setupTitleEl = document.querySelector("[data-setup-title]");
const setupBodyEl = document.querySelector("[data-setup-body]");
const setupExtraEl = document.querySelector("[data-setup-extra]");
const setupNextBtn = document.querySelector("[data-setup-next]");
const setupBackBtn = document.querySelector("[data-setup-back]");
const setupSkipBtn = document.querySelector("[data-setup-skip]");
const setupProgressEl = document.querySelector("[data-setup-progress]");


// Step glyphs, drawn to match the SF Symbols iOS uses on the same steps rather than the emoji
// these were: hand.wave.fill, figure.and.child.holdinghands, globe, dollarsign.circle, network,
// qrcode, server.rack, (none), bubble.left.and.bubble.right.fill, eye.slash.circle. Stroke-only
// at a single weight so they read as one family the way SF Symbols do, and so they take the
// accent colour from CSS like every other icon in the app.
const SETUP_ICONS = {
  wave: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M10 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M13 10.5V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M16 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0"/></svg>',
  family: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="4.5" r="2"/><path d="M7.5 8v6M5.5 21l2-7 2 7"/><circle cx="16.5" cy="7" r="1.7"/><path d="M16.5 10v4M15 21l1.5-5 1.5 5"/><path d="M9.5 12h5.5"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z"/></svg>',
  currency: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 6v12"/><path d="M15 9.2A2.7 2.7 0 0 0 12.4 8h-.8a2.2 2.2 0 0 0 0 4.4h.8a2.2 2.2 0 0 1 0 4.4h-.8A2.7 2.7 0 0 1 9 15.6"/></svg>',
  network: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/></svg>',
  qrcode: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1"/></svg>',
  server: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 6.5A2.5 2.5 0 0 1 5 4h8.5A2.5 2.5 0 0 1 16 6.5v3A2.5 2.5 0 0 1 13.5 12H7.5L4 15v-3.2A2.5 2.5 0 0 1 2.5 9.5Z"/><path fill="var(--accent, #62f4d0)" stroke="none" d="M10.5 11.5A2.5 2.5 0 0 1 13 9h6.5A2.5 2.5 0 0 1 22 11.5v3A2.5 2.5 0 0 1 19.5 17h-3L13 20v-3h0a2.5 2.5 0 0 1-2.5-2.5Z"/></svg>',
  privacy: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M7.2 12.6s2-3.1 4.8-3.1 4.8 3.1 4.8 3.1-2 3.1-4.8 3.1a4.4 4.4 0 0 1-1.7-.34"/><path d="M7 7l10 10"/></svg>',
};

const SETUP_STEPS = [
  { icon: SETUP_ICONS.wave, title: "Welcome to KaChat", body: "Let's walk through the basics so you're ready to send your first message." },
  // Child Mode: the Adult/Child question sits at the start of the first-run
  // experience, before language — and is unskippable until answered (see
  // isUserTypePending gating in renderSetupStep/closeSetupGuide).
  { icon: SETUP_ICONS.family, title: "Who will use KaChat?", body: "", extra: "usertype" },
  { icon: SETUP_ICONS.globe, title: "Choose Your Language", body: "Select the language you'd like to use in KaChat.", extra: "language" },
  { icon: SETUP_ICONS.currency, title: "Choose Your Currency", body: "Select the currency you'd like prices displayed in.", extra: "currency" },
  { icon: SETUP_ICONS.network, title: "How KaChat Uses Kaspa", body: "KaChat lets you send and receive messages on the Kaspa network itself. Kaspa is required to pay fees when sending your messages. The fee you pay goes to miners which secure the network." },
  { icon: SETUP_ICONS.qrcode, qr: true, title: "Fund Your Chatting Address", body: "50 Kaspa is recommended to get started to be able to create a KNS profile and chat for a while. 5 Kaspa is enough for about 2500 messages", extra: "funding" },
  { icon: SETUP_ICONS.server, title: "Connect to a Node", body: "KaChat needs to connect to a node. How would you like to connect?", extra: "node" },
  { icon: null, title: "Chatting vs. Spending Address", body: "", extra: "addresses" },
  { icon: SETUP_ICONS.chat, title: "Starting a Conversation", body: "To chat with someone, press Create Chat and enter their Kaspa address or KNS domain. If you send a message, they will not see it unless you send a handshake first, or you both decide to message each other around the same time - doing the latter increases your privacy." },
  // Per-account Chats Payment Privacy (fresh-address payment pools) — placed
  // directly after the starting-a-conversation step, the guide's final step.
  // Copy matches iOS's WelcomeGuideView paymentPrivacyStep exactly.
  { icon: SETUP_ICONS.privacy, title: "Chat Payment Privacy", body: "How would you like to send and receive payments in chats?", extra: "privacy" },
];
let setupStepIndex = 0;
const SETUP_USER_TYPE_STEP = SETUP_STEPS.findIndex((step) => step.extra === "usertype");

// Presentation context, supplied by the presenter — an ONBOARDING run (create
// or import, fresh or re-presented after a reload) is fully unskippable end
// to end; Help replays stay skippable and never show the import-only
// chatting-address picker.
let setupGuideIsOnboardingRun = false;
let setupGuideIsImportRun = false;

function wizardSetCurrency(key) {
  if (!CURRENCIES[key]) return;
  selectedCurrency = key;
  localStorage.setItem(CURRENCY_PREF_KEY, key);
  refreshCurrencyUi();
  document.dispatchEvent(new CustomEvent("kachat:currency-changed"));
}
function wizardSetLanguage(key) {
  if (!LANGUAGES[key]) return;
  selectedLanguage = key;
  localStorage.setItem(LANGUAGE_PREF_KEY, key);
  applyLanguage();
  refreshLanguageUi();
}

function buildSetupChoiceList(entries, isSelected, onPick) {
  const list = document.createElement("div");
  list.className = "setup-choice-list";
  for (const [key, label] of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "setup-choice-row" + (isSelected(key) ? " selected" : "");
    row.innerHTML = `<span></span><svg class="setup-choice-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-11"/></svg>`;
    row.querySelector("span").textContent = label;
    row.addEventListener("click", () => { onPick(key); renderSetupStep(); });
    list.appendChild(row);
  }
  return list;
}

function renderSetupExtra(kind) {
  if (!setupExtraEl) return;
  setupExtraEl.replaceChildren();
  setupExtraEl.hidden = !kind;
  if (kind === "usertype") {
    renderUserTypeGuideStep(setupExtraEl);
  } else if (kind === "language") {
    setupExtraEl.appendChild(buildSetupChoiceList(Object.entries(LANGUAGES), (k) => k === selectedLanguage, wizardSetLanguage));
  } else if (kind === "currency") {
    setupExtraEl.appendChild(buildSetupChoiceList(Object.entries(CURRENCIES).map(([k, v]) => [k, v.name]), (k) => k === selectedCurrency, wizardSetCurrency));
  } else if (kind === "funding") {
    const addr = engine.address || "No wallet loaded";
    const wrap = document.createElement("div");
    wrap.className = "setup-funding";
    const addrBtn = document.createElement("button");
    addrBtn.type = "button";
    addrBtn.className = "setup-funding-address";
    addrBtn.textContent = addr;
    addrBtn.addEventListener("click", async () => { if (engine.address) { await copyTextToClipboard(engine.address); showCopyToast("Address copied to clipboard."); } });
    const qrBtn = document.createElement("button");
    qrBtn.type = "button";
    qrBtn.className = "secondary-button";
    qrBtn.textContent = "Show QR Code";
    // Don't close the guide — the address screen (z-index 1500) layers above it,
    // so backing out of the QR returns here on the funding step.
    qrBtn.addEventListener("click", () => { openChattingAddressScreen(); });
    // No gift row: desktop deliberately has no free-gift program (mobile-only).
    wrap.append(addrBtn, qrBtn);
    // INITIAL IMPORT ONBOARDING RUNS ONLY, never Help replays: an imported
    // seed may hold its real identity — KNS domains, a funded chatting
    // balance — at a nonzero derivation index. Opens the batched scanner;
    // after a switch this step re-renders with the new address.
    if (setupGuideIsOnboardingRun && setupGuideIsImportRun && activeAccountMnemonic()) {
      const pickerBtn = document.createElement("button");
      pickerBtn.type = "button";
      pickerBtn.className = "secondary-button";
      pickerBtn.textContent = "Change Chatting Address";
      pickerBtn.addEventListener("click", () => openChattingAddressPicker());
      wrap.append(pickerBtn);
    }
    setupExtraEl.appendChild(wrap);
  } else if (kind === "privacy") {
    // Chats Payment Privacy chooser (iOS paymentPrivacyRow port): On
    // preselected + Recommended; the selection writes straight through to the
    // per-account store, so a replay shows and edits the real setting.
    const options = [
      {
        value: true,
        title: "On",
        badge: "Recommended",
        sub: "Anytime you receive Kaspa KaChat will do its best make sure the Kaspa goes to a fresh address not tied to your chatting identity. Sending Kaspa KaChat will always make sure it comes out of your primary spend address which is never associated with your chatting identity.",
      },
      {
        value: false,
        title: "Off",
        badge: null,
        sub: "All Kaspa will flow in and out of your chatting address",
      },
    ];
    const current = chatsPrivacyEnabled();
    const list = document.createElement("div");
    list.className = "setup-choice-list";
    for (const o of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "setup-node-row" + (current === o.value ? " selected" : "");
      row.innerHTML = `<span class="setup-node-dot"></span><span class="setup-node-copy"><strong></strong><small></small></span>${o.badge ? `<span class="setup-node-badge"></span>` : ""}`;
      row.querySelector("strong").textContent = o.title;
      row.querySelector("small").textContent = o.sub;
      if (o.badge) row.querySelector(".setup-node-badge").textContent = o.badge;
      row.addEventListener("click", () => {
        setChatsPrivacyEnabled(o.value);
        refreshChatsPrivacyToggle();
        renderSetupStep();
      });
      list.appendChild(row);
    }
    setupExtraEl.appendChild(list);
  } else if (kind === "node") {
    // Desktop connects via auto-discovery (wRPC resolver) by default; "own node"
    // lets the user paste a trusted endpoint.
    const opts = [
      { key: "auto", title: "Auto Search for Nodes", badge: "Recommended", sub: "Automatically finds and connects to public Kaspa nodes over wRPC. No setup needed." },
      { key: "own", title: "Connect Your Own Node", badge: "Best", sub: "Enter a node address you trust for the most reliable, private connection.", input: true },
    ];
    let current = accountShellPrefs.nodeChoice;
    if (current !== "auto" && current !== "own") current = "auto"; // normalize legacy/default
    const list = document.createElement("div");
    list.className = "setup-choice-list";
    for (const o of opts) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "setup-node-row" + (current === o.key ? " selected" : "");
      row.innerHTML = `<span class="setup-node-dot"></span><span class="setup-node-copy"><strong></strong><small></small></span>${o.badge ? `<span class="setup-node-badge"></span>` : ""}`;
      row.querySelector("strong").textContent = o.title;
      row.querySelector("small").textContent = o.sub;
      if (o.badge) row.querySelector(".setup-node-badge").textContent = o.badge;
      row.addEventListener("click", () => { accountShellPrefs.nodeChoice = o.key; persistAccountShellPreferences(); renderSetupStep(); });
      list.appendChild(row);
      if (o.input && current === o.key) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "field-input setup-node-input";
        input.placeholder = "host:port or grpcs://host";
        input.value = accountShellPrefs.nodeAddress || "";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.addEventListener("input", () => { accountShellPrefs.nodeAddress = input.value.trim(); persistAccountShellPreferences(); });
        list.appendChild(input);
      }
    }
    setupExtraEl.appendChild(list);
  } else if (kind === "addresses") {
    const spendingAddr = deriveSpendingAddressAt(getActiveSpendingIndex());
    const rows = [
      { title: "Chatting Address", value: engine.address || "--", caption: "Your public messaging identity. Fund it with a small amount to pay message fees and KNS profile creation fees - never send money here that you intend to spend." },
      { title: "Spending Address", value: spendingAddr || "Import a recovery phrase to use spending addresses", caption: "Where you send and receive Kaspa you intend to use for everything else." },
    ];
    for (const r of rows) {
      const box = document.createElement("div");
      box.className = "setup-address-row";
      box.innerHTML = `<strong></strong><span class="setup-address-value"></span><small></small>`;
      box.querySelector("strong").textContent = r.title;
      box.querySelector(".setup-address-value").textContent = r.value;
      box.querySelector("small").textContent = r.caption;
      setupExtraEl.appendChild(box);
    }
  }
}

function renderSetupStep() {
  const step = SETUP_STEPS[setupStepIndex];
  if (!step) return;
  if (setupIconEl) {
    if (step.qr && engine.address) {
      // Real QR of the chatting address, rendered in the teal (kaspa) scheme.
      setupIconEl.replaceChildren();
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 320;
      canvas.className = "setup-guide-qr";
      setupIconEl.appendChild(canvas);
      setupIconEl.hidden = false;
      Promise.resolve(engine.drawQr(canvas, { dark: "#62f4d0", light: "#00000000" }))
        .catch(() => { setupIconEl.innerHTML = step.icon; });
    } else if (step.icon) {
      setupIconEl.innerHTML = step.icon;
      setupIconEl.hidden = false;
    } else {
      // The address explainer leads with its title on iOS - no glyph above it.
      setupIconEl.replaceChildren();
      setupIconEl.hidden = true;
    }
  }
  if (setupTitleEl) setupTitleEl.textContent = step.title;
  if (setupBodyEl) { setupBodyEl.textContent = step.body || ""; setupBodyEl.hidden = !step.body; }
  renderSetupExtra(step.extra);
  if (setupNextBtn) setupNextBtn.textContent = setupStepIndex === SETUP_STEPS.length - 1 ? "Finish" : "Next";
  // Previous is available on every step after the first, onboarding runs included -
  // only skipping forward stays forbidden.
  // Disabled and dimmed on the first step rather than hidden, so Next stays in the exact
  // same place on every screen and the guide can be tapped straight through (iOS parity).
  if (setupBackBtn) {
    setupBackBtn.hidden = false;
    setupBackBtn.disabled = setupStepIndex === 0;
  }
  if (setupProgressEl) setupProgressEl.textContent = `${setupStepIndex + 1} / ${SETUP_STEPS.length}`;
  // Skip exists ONLY on replays (Profile > Help). EVERY account-onboarding run
  // — create or import, fresh or re-presented after a page reload — is fully
  // unskippable: every step must be advanced through to Finish. Decided purely
  // by the presenter-supplied context, NEVER by a persisted marker's state: a
  // device that already answered Adult/Child for a prior account would look
  // like a replay to the marker and hand an onboarding run a way out.
  // Backdrop-close no-ops the same way (see closeSetupGuide).
  if (setupSkipBtn) setupSkipBtn.hidden = setupGuideIsOnboardingRun;
}
// `options` may be a click event (listeners below pass one) — only explicit
// presenter calls pass { onboardingRun, importRun, startAtUserType }. The
// context is presenter-supplied, never inferred from persisted markers, so
// Help replays are always skippable.
function openSetupGuide(options = {}) {
  setupGuideIsOnboardingRun = options.onboardingRun === true;
  setupGuideIsImportRun = options.importRun === true;
  setupStepIndex = options.startAtUserType === true && isUserTypePending() && SETUP_USER_TYPE_STEP >= 0
    ? SETUP_USER_TYPE_STEP
    : 0;
  renderSetupStep();
  if (setupGuideModal) {
    // Presented over the signed-out screen (z 2000, same band as .modal-backdrop),
    // DOM order already keeps the guide on top — no z bump needed.
    setupGuideModal.hidden = false;
  }
}
// --- Post-onboarding catch-up (iOS MainTabView.InitialSyncProgressModal) ---
//
// Finish on the last guide step hands over to this rather than straight to the app. A half-synced
// chat list invites taps on chats whose history has not landed yet, so the app waits behind a
// blocking screen that says which part it is on. iOS holds sync for the whole wizard and releases
// it here; desktop starts its sweep as soon as the account exists, so this waits out whatever is
// already running and then runs a real one rather than assuming the background pass finished.
const initialSyncBackdrop = document.querySelector("[data-initial-sync]");
const initialSyncPhaseEl = document.querySelector("[data-initial-sync-phase]");
const initialSyncSkipBtn = document.querySelector("[data-initial-sync-skip]");
let initialSyncSkipTimer = null;

function setInitialSyncState(state) {
  document.querySelectorAll("[data-initial-sync-state]").forEach((el) => {
    el.hidden = el.dataset.initialSyncState !== state;
  });
}

function setInitialSyncPhase(label) {
  if (initialSyncPhaseEl) initialSyncPhaseEl.textContent = label;
}

function closeInitialSync() {
  if (initialSyncSkipTimer) { clearTimeout(initialSyncSkipTimer); initialSyncSkipTimer = null; }
  if (initialSyncBackdrop) initialSyncBackdrop.hidden = true;
}

initialSyncSkipBtn?.addEventListener("click", closeInitialSync);
document.querySelector("[data-initial-sync-done]")?.addEventListener("click", closeInitialSync);

async function runPostOnboardingSync() {
  if (!initialSyncBackdrop) return;
  setInitialSyncState("running");
  setInitialSyncPhase("Starting");
  if (initialSyncSkipBtn) initialSyncSkipBtn.hidden = true;
  initialSyncBackdrop.hidden = false;
  // A modal with no way out would be worse than an incomplete chat list, so the escape appears
  // once this has been running a while. Same 20 seconds iOS waits.
  initialSyncSkipTimer = setTimeout(() => {
    if (initialSyncSkipBtn) initialSyncSkipBtn.hidden = false;
  }, 20_000);

  try {
    setInitialSyncPhase("Connecting for live updates");
    await connectAndRefresh({ quiet: true });
    // refreshAllConversations returns immediately when a sweep is already in flight, so awaiting
    // it while the create/import path's own sweep runs would wait for nothing at all.
    setInitialSyncPhase("Finding your conversations");
    const startedWaiting = Date.now();
    while (messageRefreshInFlight && Date.now() - startedWaiting < 120_000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    setInitialSyncPhase("Downloading message history");
    await refreshAllConversations({ quiet: true });
    startAutomaticRefresh();
  } catch (error) {
    appendEngineLog(`Post-onboarding sync failed: ${error.message}`);
  }
  setInitialSyncState("finished");
  if (initialSyncSkipTimer) { clearTimeout(initialSyncSkipTimer); initialSyncSkipTimer = null; }
}

function closeSetupGuide({ completed = false } = {}) {
  // Onboarding runs only ever end via Finish on the last step: no Skip, no
  // backdrop dismissal, nothing in between. Checked BEFORE the completed
  // branch clears the context so a mid-run backdrop click stays a no-op.
  if (!completed && setupGuideIsOnboardingRun) return;
  const wasOnboardingRun = setupGuideIsOnboardingRun;
  if (completed) {
    // Finish on the last step: the onboarding run is done — a completed run
    // must not re-present on the next load.
    clearOnboardingRunPending();
    setupGuideIsOnboardingRun = false;
    setupGuideIsImportRun = false;
  }
  if (setupGuideModal) setupGuideModal.hidden = true;
  closeChattingAddressPicker();
  // Only a finished ONBOARDING run waits for the catch-up. A Help replay is someone re-reading
  // the guide on an account that has been syncing all along.
  if (completed && wasOnboardingRun) void runPostOnboardingSync();
}
setupNextBtn?.addEventListener("click", async () => {
  if (SETUP_STEPS[setupStepIndex]?.extra === "usertype") {
    setupNextBtn.disabled = true;
    let advance = false;
    try { advance = await applyUserTypeGuideChoice(); } finally { setupNextBtn.disabled = false; }
    if (!advance) return;
  }
  if (setupStepIndex >= SETUP_STEPS.length - 1) { closeSetupGuide({ completed: true }); return; }
  setupStepIndex += 1;
  renderSetupStep();
});
setupBackBtn?.addEventListener("click", () => {
  if (setupStepIndex <= 0) return;
  // Never back INTO the answered Adult/Child step - its choice applies the moment
  // it's made, so the button steps over it back to Welcome.
  const prev = setupStepIndex - 1;
  setupStepIndex = SETUP_STEPS[prev]?.extra === "usertype" ? Math.max(0, prev - 1) : prev;
  renderSetupStep();
});
setupSkipBtn?.addEventListener("click", () => closeSetupGuide());
setupGuideModal?.addEventListener("click", (event) => { if (event.target === setupGuideModal) closeSetupGuide(); });
document.querySelectorAll("[data-open-setup-guide]").forEach((b) => b.addEventListener("click", () => openSetupGuide()));

// --- "Change Chatting Address" picker (iOS ChattingAddressPickerView) --------
//
// Reached only from the setup guide's funding step on IMPORT onboarding runs.
// Scans the identity chain of the account's own source family (standard,
// legacy-972, OneKey) in batches of 50, deriving each batch off a single master
// key, then checking the whole batch for KAS balance (ONE pooled
// getUtxosByAddresses call) and KNS domains (engine/kns.js's cached, paced
// batch helper — never 50 raw requests). Only interesting slots are listed:
// a balance, at least one domain, index 0, or the current index.
const CHATTING_PICKER_BATCH = 50;
const chattingPickerScreen = document.querySelector("[data-chatting-picker-screen]");
const chattingPickerListEl = document.querySelector("[data-chatting-picker-list]");
const chattingPickerFooterEl = document.querySelector("[data-chatting-picker-footer]");
const chattingPickerErrorEl = document.querySelector("[data-chatting-picker-error]");
const chattingPickerDetailScreen = document.querySelector("[data-chatting-picker-detail]");
const chattingPickerDetailBody = document.querySelector("[data-chatting-picker-detail-body]");
const chattingPickerSetBtn = document.querySelector("[data-chatting-picker-set]");
const chattingPickerConfirmModal = document.querySelector("[data-chatting-picker-confirm]");

let chattingPickerCandidates = [];
let chattingPickerScanned = 0;
let chattingPickerScanning = false;
// Bumped on every open/close so a batch still in flight when the screen goes
// away can never write into the next session's list.
let chattingPickerToken = 0;
let chattingPickerDetailIndex = null;
let chattingPickerSwitching = false;

function setChattingPickerError(message) {
  if (!chattingPickerErrorEl) return;
  chattingPickerErrorEl.textContent = message || "";
  chattingPickerErrorEl.hidden = !message;
}

function chattingPickerCandidateAt(index) {
  return chattingPickerCandidates.find((entry) => entry.index === index) || null;
}

function visibleChattingPickerCandidates() {
  const current = activeChattingIndex();
  return chattingPickerCandidates.filter((entry) =>
    entry.balanceSompi > 0n || entry.domains.length > 0 || entry.index === 0 || entry.index === current);
}

function renderChattingPickerFooter() {
  if (!chattingPickerFooterEl) return;
  if (chattingPickerScanning) {
    const from = escapeHtml(String(chattingPickerScanned + 1));
    const to = escapeHtml(String(chattingPickerScanned + CHATTING_PICKER_BATCH));
    chattingPickerFooterEl.innerHTML = `<span>Scanning addresses ${from} to ${to}…</span>`;
    return;
  }
  if (!chattingPickerScanned) { chattingPickerFooterEl.replaceChildren(); return; }
  chattingPickerFooterEl.innerHTML = `<span>Scanned the first ${escapeHtml(String(chattingPickerScanned))} addresses.</span>`
    + `<button type="button" class="chatting-picker-scan-more" data-chatting-picker-scan-more>Scan Further</button>`;
}

function renderChattingPickerList() {
  if (!chattingPickerListEl) return;
  const current = activeChattingIndex();
  const rows = visibleChattingPickerCandidates();
  if (!rows.length) {
    chattingPickerListEl.innerHTML = chattingPickerScanning
      ? ""
      : '<div class="manage-address-empty">No addresses with a balance or domains on this seed yet.</div>';
    renderChattingPickerFooter();
    return;
  }
  chattingPickerListEl.innerHTML = rows.map((entry) => {
    const pillText = entry.domains.length === 1
      ? entry.domains[0].fullName
      : entry.domains.length > 1 ? `${entry.domains.length} domains` : "";
    const pill = pillText ? `<span class="chatting-picker-domain-pill">${escapeHtml(pillText)}</span>` : "";
    const badge = entry.index === current
      ? '<span class="chatting-picker-row-badge is-current">Current</span>'
      : entry.index === 0 ? '<span class="chatting-picker-row-badge">Default</span>' : "";
    return `<button type="button" class="chatting-picker-row${entry.index === current ? " current" : ""}" data-chatting-picker-open="${escapeHtml(String(entry.index))}">`
      + `<span class="chatting-picker-row-index">#${escapeHtml(String(entry.index))}</span>`
      + `<span class="chatting-picker-row-copy">`
      + `<span class="chatting-picker-row-address">${escapeHtml(shortAddress(entry.address))}</span>`
      + `<span class="chatting-picker-row-meta"><span>${escapeHtml(formatSompiForNotification(entry.balanceSompi))} KAS</span>${pill}</span>`
      + `</span>${badge}`
      + `<svg class="chatting-picker-row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>`
      + `</button>`;
  }).join("");
  renderChattingPickerFooter();
}

async function scanChattingAddressBatch() {
  if (chattingPickerScanning) return;
  const mnemonic = activeAccountMnemonic();
  if (!mnemonic) {
    setChattingPickerError("This account has no recovery phrase, so its chatting address can't be changed.");
    return;
  }
  const token = chattingPickerToken;
  const start = chattingPickerScanned;
  const family = activeAccountSourceFamily();
  const passphrase = activeAccountPassphrase();
  chattingPickerScanning = true;
  setChattingPickerError("");
  renderChattingPickerList();
  try {
    let derived = [];
    try {
      derived = await engine.deriveIdentityAddressRange(mnemonic, passphrase, { family, start, count: CHATTING_PICKER_BATCH });
    } catch (error) {
      appendEngineLog(`Chatting address scan failed: ${error.message}`);
    }
    if (token !== chattingPickerToken) return;
    if (!derived.length) {
      setChattingPickerError("Could not derive addresses from this seed. Please try again.");
      return;
    }
    const addresses = derived.map((entry) => entry.address);

    // One batched balance call for the whole batch; a network failure just
    // leaves this batch's balances at zero rather than sinking the scan.
    const balances = new Map();
    try {
      await engine.connect();
      const response = await engine.withRpc(
        (rpc) => rpc.getUtxosByAddresses(addresses),
        { retries: 1, label: "Chatting address scan" },
      );
      for (const entry of response?.entries || []) {
        const address = String(entry.address ?? entry.entry?.address ?? "");
        if (!address) continue;
        balances.set(address, (balances.get(address) || 0n) + BigInt(entry.amount ?? entry.entry?.amount ?? 0));
      }
    } catch { /* balances stay at zero for this batch */ }

    try { await engine.refreshKnsIfNeeded?.(addresses); } catch { /* fall back to whatever is cached */ }
    if (token !== chattingPickerToken) return;

    for (const entry of derived) {
      const info = engine.peekKnsAddressInfo?.(entry.address) || null;
      chattingPickerCandidates.push({
        index: entry.index,
        address: entry.address,
        balanceSompi: balances.get(entry.address) || 0n,
        domains: Array.isArray(info?.allDomains) ? info.allDomains : [],
        primaryDomain: info?.primaryDomain || null,
      });
    }
    chattingPickerScanned = start + CHATTING_PICKER_BATCH;
  } finally {
    if (token === chattingPickerToken) {
      chattingPickerScanning = false;
      renderChattingPickerList();
    }
  }
}

function openChattingAddressPicker() {
  if (!chattingPickerScreen) return;
  if (!activeAccountMnemonic()) {
    showCopyToast("This account has no recovery phrase, so its chatting address can't be changed.");
    return;
  }
  chattingPickerToken += 1;
  chattingPickerCandidates = [];
  chattingPickerScanned = 0;
  chattingPickerScanning = false;
  chattingPickerDetailIndex = null;
  setChattingPickerError("");
  renderChattingPickerList();
  chattingPickerScreen.hidden = false;
  void scanChattingAddressBatch();
}

function closeChattingPickerDetail() {
  chattingPickerDetailIndex = null;
  if (chattingPickerConfirmModal) chattingPickerConfirmModal.hidden = true;
  if (chattingPickerDetailScreen) chattingPickerDetailScreen.hidden = true;
}

function closeChattingAddressPicker() {
  chattingPickerToken += 1;
  chattingPickerScanning = false;
  closeChattingPickerDetail();
  if (chattingPickerScreen) chattingPickerScreen.hidden = true;
}

function renderChattingPickerDetail() {
  if (!chattingPickerDetailBody) return;
  const candidate = chattingPickerCandidateAt(chattingPickerDetailIndex);
  if (!candidate) { chattingPickerDetailBody.replaceChildren(); return; }
  const isCurrent = candidate.index === activeChattingIndex();
  const domains = candidate.domains;
  const domainsHtml = domains.length
    ? `<div class="chatting-picker-detail-domains"><strong>KNS Domains (${escapeHtml(String(domains.length))})</strong>`
      + domains.map((domain) => {
        const isPrimary = candidate.primaryDomain
          && String(domain.fullName).toLowerCase() === String(candidate.primaryDomain).toLowerCase();
        return `<div class="chatting-picker-detail-domain"><span>${escapeHtml(domain.fullName)}</span>${isPrimary ? "<em>Primary</em>" : ""}</div>`;
      }).join("")
      + `</div>`
    : "";
  chattingPickerDetailBody.innerHTML = `
    <p class="chatting-picker-detail-heading">Address #${escapeHtml(String(candidate.index))}</p>
    <button type="button" class="chatting-picker-detail-address" data-chatting-picker-copy>${escapeHtml(candidate.address)}</button>
    <p class="chatting-picker-detail-hint">Click the address to copy it.</p>
    <div class="chatting-picker-detail-stat"><span>Balance</span><span>${escapeHtml(formatSompiForNotification(candidate.balanceSompi))} KAS</span></div>
    ${domainsHtml}`;
  if (chattingPickerSetBtn) {
    chattingPickerSetBtn.disabled = isCurrent || chattingPickerSwitching;
    chattingPickerSetBtn.textContent = chattingPickerSwitching
      ? "Switching…"
      : isCurrent ? "Current Chatting Address" : "Set as Chatting Address";
  }
}

function openChattingPickerDetail(index) {
  if (!chattingPickerDetailScreen || !chattingPickerCandidateAt(index)) return;
  chattingPickerDetailIndex = index;
  renderChattingPickerDetail();
  chattingPickerDetailScreen.hidden = false;
}

// The clean identity switch (iOS WalletManager.setChattingAddress): the same
// seed, re-derived within its own source family at the chosen index, funnelled
// through the ordinary import path so every consumer (data scope, saved
// account record, subscriptions, sync) switches exactly like an account import
// does. Nothing is deleted — the old address's chats stay in their own scope.
async function performChattingAddressSwitch() {
  const candidate = chattingPickerCandidateAt(chattingPickerDetailIndex);
  if (!candidate || chattingPickerSwitching) return;
  if (candidate.index === activeChattingIndex()) return;
  const record = activeSavedAccountRecord();
  const mnemonic = String(record?.mnemonic || "");
  if (!mnemonic) { showCopyToast("This account has no recovery phrase."); return; }
  // Captured BEFORE the import moves engine.address: the index moves WITHIN
  // the account's existing family, and the name/passphrase belong to the seed.
  const family = activeAccountSourceFamily();
  const passphrase = String(record?.passphrase || "");
  const name = String(activeAccountMetadata()?.name || record?.name || "My Account");
  const previousAddress = String(engine.address || "");
  chattingPickerSwitching = true;
  renderChattingPickerDetail();
  try {
    await importAndEnterAccount({
      name,
      recoveryPhrase: mnemonic,
      passphrase,
      family,
      chattingIndex: candidate.index,
      resetState: false,
    });
    // The old identity's saved-account row is stale the moment the switch
    // lands — the account IS this seed, now living at the new address. Its own
    // chat scope is deliberately left in place.
    if (previousAddress && previousAddress !== engine.address) {
      persistSavedAccounts(loadSavedAccounts().filter((entry) => entry.address !== previousAddress));
    }
    chattingPickerSwitching = false;
    closeChattingAddressPicker();
    showCopyToast("Chatting address updated");
    // Back on the funding step, which re-renders with the new address.
    if (setupGuideModal && !setupGuideModal.hidden) renderSetupStep();
  } catch (error) {
    appendEngineLog(`Chatting address switch failed: ${error.message}`);
    showCopyToast(error.message);
    chattingPickerSwitching = false;
    renderChattingPickerDetail();
  }
}

chattingPickerListEl?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-chatting-picker-open]");
  if (!row) return;
  openChattingPickerDetail(Math.max(0, Math.floor(Number(row.dataset.chattingPickerOpen) || 0)));
});
chattingPickerFooterEl?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-chatting-picker-scan-more]")) return;
  void scanChattingAddressBatch();
});
chattingPickerDetailBody?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-chatting-picker-copy]");
  if (!button) return;
  try { await copyTextToClipboard(button.textContent); showCopyToast("Address copied to clipboard."); }
  catch (error) { appendEngineLog(error.message); }
});
document.querySelector("[data-close-chatting-picker]")?.addEventListener("click", () => closeChattingAddressPicker());
document.querySelector("[data-close-chatting-picker-detail]")?.addEventListener("click", () => closeChattingPickerDetail());
chattingPickerSetBtn?.addEventListener("click", () => {
  const candidate = chattingPickerCandidateAt(chattingPickerDetailIndex);
  if (!candidate || chattingPickerSwitching || candidate.index === activeChattingIndex()) return;
  // Existing conversations on the current identity: confirm first. Nothing is
  // deleted either way — the old history simply stays with the old address.
  if (state.conversations.length > 0) {
    if (chattingPickerConfirmModal) chattingPickerConfirmModal.hidden = false;
    return;
  }
  void performChattingAddressSwitch();
});
document.querySelector("[data-chatting-picker-confirm-cancel]")?.addEventListener("click", () => {
  if (chattingPickerConfirmModal) chattingPickerConfirmModal.hidden = true;
});
document.querySelector("[data-chatting-picker-confirm-switch]")?.addEventListener("click", () => {
  if (chattingPickerConfirmModal) chattingPickerConfirmModal.hidden = true;
  void performChattingAddressSwitch();
});

const importAccountModal = document.querySelector("[data-import-account-modal]");
const importNameInput = document.querySelector("[data-import-name]");
const importPhraseInput = document.querySelector("[data-import-phrase]");
const importAccountError = document.querySelector("[data-import-account-error]");
const importContinueBtn = document.querySelector("[data-import-continue]");
const importPassphraseInput = document.querySelector("[data-import-passphrase]");
const importPassphraseToggle = document.querySelector("[data-import-passphrase-toggle]");
const importPassphraseError = document.querySelector("[data-import-passphrase-error]");
importPassphraseInput?.addEventListener("input", () => schedulePassphrasePreview("import"));
const importWithPassphraseBtn = document.querySelector("[data-import-passphrase-submit]");
const importSkipPassphraseBtn = document.querySelector("[data-import-passphrase-no]");

document.querySelector("[data-import-passphrase-yes]")?.addEventListener("click", () => {
  showPassphraseScreen("import", "entry");
  resetPassphrasePreview("import");
  schedulePassphrasePreview("import");
  importPassphraseInput?.focus();
});
document.querySelector("[data-import-passphrase-explain]")?.addEventListener("click", () => {
  showPassphraseScreen("import", "explainer");
});
document.querySelector("[data-import-passphrase-explain-back]")?.addEventListener("click", () => {
  showPassphraseScreen("import", "question");
});
document.querySelector("[data-import-passphrase-back]")?.addEventListener("click", () => {
  if (importPassphraseInput) importPassphraseInput.value = "";
  if (importPassphraseError) importPassphraseError.hidden = true;
  showPassphraseScreen("import", "question");
});
let pendingImport = null;

// Source-wallet chooser (iOS ImportSourceWalletView port): shown FIRST, before
// seed entry. The selection maps a wallet name to its identity derivation-path
// family — KaChat derives the chatting identity where that wallet actually
// kept the user's funds and KNS domains. The spending chain always stays on
// KaChat's own m/44'/111111'/1' branch regardless of this choice.
const IMPORT_SOURCE_WALLETS = [
  { name: "KaChat", family: "kaspaStandard", isDefault: true },
  { name: "KasWare Wallet", family: "kaspaStandard" },
  { name: "Kaspium Wallet", family: "kaspaStandard" },
  // Kastle derives m/44'/111111'/{account}'/0/{index}; account 0 is
  // byte-identical to the standard family.
  { name: "Kastle Wallet", family: "kaspaStandard" },
  { name: "KDX Wallet", family: "kaspaLegacy972" },
  { name: "Core Golang Cli Wallet", family: "kaspaStandard" },
  { name: "OKX Wallet", family: "kaspaStandard" },
  { name: "OneKey Wallet", family: "oneKey" },
  { name: "Ledger Wallet", family: "kaspaStandard" },
];
let importSourceSelection = 0;

function importSourcePathDescription(family) {
  switch (family) {
    case "kaspaLegacy972": return "m/44'/972/0'";
    case "oneKey": return "m/44'/111111'/0' (OneKey)";
    default: return "m/44'/111111'/0'";
  }
}

function renderImportSourceList() {
  const listEl = document.querySelector("[data-import-source-list]");
  if (!listEl) return;
  listEl.replaceChildren();
  IMPORT_SOURCE_WALLETS.forEach((option, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `import-source-row${index === importSourceSelection ? " selected" : ""}`;
    const mark = document.createElement("span");
    mark.className = "import-source-mark";
    mark.textContent = index === importSourceSelection ? "●" : "○";
    const copy = document.createElement("span");
    copy.className = "import-source-copy";
    const title = document.createElement("strong");
    title.textContent = option.name;
    if (option.isDefault) {
      const badge = document.createElement("em");
      badge.className = "import-source-default";
      badge.textContent = "Default";
      title.append(" ", badge);
    }
    const path = document.createElement("small");
    path.textContent = importSourcePathDescription(option.family);
    copy.append(title, path);
    row.append(mark, copy);
    row.addEventListener("click", () => {
      importSourceSelection = index;
      renderImportSourceList();
    });
    listEl.appendChild(row);
  });
}

function selectedImportSourceFamily() {
  return IMPORT_SOURCE_WALLETS[importSourceSelection]?.family || "kaspaStandard";
}

function showImportStep(step) {
  document.querySelectorAll("[data-import-step]").forEach((el) => { el.hidden = el.dataset.importStep !== step; });
}
function showImportError(message) {
  if (importAccountError) { importAccountError.textContent = message; importAccountError.hidden = false; }
}
function openImportAccountModal() {
  pendingImport = null;
  importSourceSelection = 0;
  if (importAccountError) { importAccountError.hidden = true; importAccountError.textContent = ""; }
  if (importPassphraseError) importPassphraseError.hidden = true;
  if (importNameInput) importNameInput.value = "Imported Account";
  if (importPhraseInput) importPhraseInput.value = "";
  if (importPassphraseInput) { importPassphraseInput.value = ""; importPassphraseInput.type = "password"; }
  renderImportSourceList();
  showImportStep("source");
  if (importAccountModal) importAccountModal.hidden = false;
}
function closeImportAccountModal() {
  if (importAccountModal) importAccountModal.hidden = true;
  pendingImport = null;
  if (!engine.address || localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true") showLoggedOutScreen();
}
document.querySelectorAll("[data-close-import-account]").forEach((button) => button.addEventListener("click", closeImportAccountModal));
importAccountModal?.addEventListener("click", (event) => { if (event.target === importAccountModal) closeImportAccountModal(); });

document.querySelector("[data-import-source-continue]")?.addEventListener("click", () => {
  showImportStep("form");
  queueMicrotask(() => importPhraseInput?.focus());
});

// `resetState: false` is used only by the chatting-address switch: that is a
// clean identity SELECTION on a seed the app already holds, not a new import,
// so whatever chats the target address already has in its own storage scope
// stay put (activateWalletDataScope has just restored them).
async function importAndEnterAccount({ name, recoveryPhrase, passphrase = "", family = "kaspaStandard", chattingIndex = 0, resetState = true }) {
  if (!engine.kaspa) await ensureRuntimes();
  const cleanName = String(name || "").trim();
  const cleanPhrase = String(recoveryPhrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleanName) throw new Error("Enter an account name.");
  const words = cleanPhrase.split(" ").filter(Boolean);
  if (![12, 24].includes(words.length)) throw new Error("Recovery phrase must contain exactly 12 or 24 words.");

  let wallet;
  try {
    wallet = await engine.importMnemonicWithFamily(cleanPhrase, passphrase, { family, index: chattingIndex });
  } catch (error) {
    engine.clearSession();
    throw new Error(`Invalid recovery phrase: ${error?.message || "word list or checksum validation failed."}`);
  }
  if (!wallet?.privateKeyHex || !wallet?.address?.startsWith("kaspa:") || !wallet?.mnemonic) {
    engine.clearSession();
    throw new Error("Recovery phrase did not produce a valid Kaspa mainnet account.");
  }

  const createdAt = new Date().toISOString();
  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[wallet.address] = { name: cleanName, createdAt };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  activateWalletDataScope(wallet.address, { migrateLegacy: false });
  if (resetState) {
    state = { contacts: [], conversations: [] };
    persistState();
  }
  persistTestingWallet({
    mnemonic: wallet.mnemonic,
    passphrase,
    derivationPath: wallet.derivationPath,
    wordCount: words.length,
    sourceFamily: wallet.sourceFamily || family,
    chattingIndex: wallet.chattingIndex ?? chattingIndex,
  });

  if (accountShellPrefs.saveAccount !== false) {
    const saved = loadSavedAccounts().find((entry) => entry.address === wallet.address);
    if (!saved?.privateKeyHex || saved?.mnemonic !== cleanPhrase || saved?.name !== cleanName) {
      engine.clearSession();
      throw new Error("Imported account could not be verified after saving.");
    }
  }

  markSessionActive();
  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
  hideLoggedOutScreen();
  // As with create: an imported account starts on its chats, not on the last account's tab.
  setActiveAppTab("chats");
  requestNotificationPermissionIfNeeded();
  currentBalanceKas = "--";
  updateWalletUi();
  updateServiceSummary();
  refreshSubscriptionAddresses({ restart: false });
  appendEngineLog(`Imported ${words.length}-word account ${cleanName}: ${wallet.address}`);
  renderChats();
  void connectAndRefresh({ quiet: true })
    .then(async () => {
      // Import enters the app WITHOUT a page reload, so the startup block that kicks off the
      // first conversation sweep and the 5s refresh timer never ran for this account — without
      // these, nothing synced (no handshakes, no history) until a tab-switch or UTXO event.
      await refreshAllConversations({ quiet: true });
      startAutomaticRefresh();
    })
    .catch((error) => {
      appendEngineLog(`Post-import RPC startup failed: ${error.message}`);
      setStatus(`Account imported. Network connection failed: ${error.message}`);
    });
  return wallet;
}

// STEP 1 → STEP 2: validate the phrase up front (so typos surface before the
// passphrase step), then advance to the optional passphrase screen.
importContinueBtn?.addEventListener("click", async () => {
  const name = String(importNameInput?.value || "").trim();
  const phrase = String(importPhraseInput?.value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const words = phrase.split(" ").filter(Boolean);
  if (importAccountError) importAccountError.hidden = true;
  if (!name) { showImportError("Enter an account name."); return; }
  if (![12, 24].includes(words.length)) { showImportError("Recovery phrase must contain exactly 12 or 24 words."); return; }
  importContinueBtn.disabled = true;
  try {
    if (!engine.kaspa) await ensureRuntimes();
    try { new engine.kaspa.Mnemonic(phrase); }
    catch { showImportError("Invalid recovery phrase — check the words and their order."); return; }
    pendingImport = { name, recoveryPhrase: phrase, family: selectedImportSourceFamily() };
    if (importPassphraseInput) { importPassphraseInput.value = ""; importPassphraseInput.type = "password"; }
    if (importPassphraseError) importPassphraseError.hidden = true;
    if (importPassphraseToggle) importPassphraseToggle.textContent = "Show";
    showImportStep("passphrase");
    showPassphraseScreen("import", "question");
    queueMicrotask(() => importPassphraseInput?.focus());
  } finally {
    importContinueBtn.disabled = false;
  }
});

importPassphraseToggle?.addEventListener("click", () => {
  if (!importPassphraseInput) return;
  const show = importPassphraseInput.type === "password";
  importPassphraseInput.type = show ? "text" : "password";
  importPassphraseToggle.textContent = show ? "Hide" : "Show";
});

// STEP 2 → enter app: import with the chosen passphrase ("" when skipped), then
// run the setup guide exactly like a create does (iOS ImportWalletView also
// sets justCreatedNewWallet) — an unskippable onboarding run, flagged as an
// IMPORT run so the funding step offers "Change Chatting Address".
async function commitImport(passphrase) {
  if (!pendingImport) return;
  const buttons = [importWithPassphraseBtn, importSkipPassphraseBtn];
  buttons.forEach((b) => { if (b) b.disabled = true; });
  if (importPassphraseError) importPassphraseError.hidden = true;
  try {
    await importAndEnterAccount({ ...pendingImport, passphrase });
    pendingImport = null;
    if (importAccountModal) importAccountModal.hidden = true;
    showCopyToast("Account imported");
    markUserTypePending();
    markOnboardingRunPending("import");
    openSetupGuide({ onboardingRun: true, importRun: true });
  } catch (error) {
    appendEngineLog(`Import account failed: ${error.message}`);
    if (importPassphraseError) { importPassphraseError.textContent = error.message; importPassphraseError.hidden = false; }
  } finally {
    buttons.forEach((b) => { if (b) b.disabled = false; });
  }
}
importWithPassphraseBtn?.addEventListener("click", () => {
  const pass = String(importPassphraseInput?.value || "");
  if (!pass) {
    if (importPassphraseError) { importPassphraseError.textContent = "Enter a passphrase, or tap Skip to continue without one."; importPassphraseError.hidden = false; }
    return;
  }
  void commitImport(pass);
});
importSkipPassphraseBtn?.addEventListener("click", () => void commitImport(""));

function activeSavedAccountRecord() {
  const address = String(engine.address || localStorage.getItem(ACTIVE_ACCOUNT_KEY) || "").trim();
  return loadSavedAccounts().find((entry) => entry.address === address) || null;
}
let recoveryHoldStartedAt = 0;
let recoveryHoldFrame = 0;
let recoveryHoldPointerId = null;
const RECOVERY_HOLD_MS = 5000;

function resetRecoveryHold() {
  if (recoveryHoldFrame) cancelAnimationFrame(recoveryHoldFrame);
  recoveryHoldFrame = 0;
  recoveryHoldStartedAt = 0;
  recoveryHoldPointerId = null;
  revealRecoveryButton?.classList.remove("is-holding");
  if (recoveryProgressFill) recoveryProgressFill.style.width = "0%";
}

// iOS shows the seed phrase for a fixed window then re-hides it, so a shoulder-surfer
// can't linger on a left-open screen. Match that: reveal for RECOVERY_VIEW_MS, count down,
// then cover it again and restore the reveal button so the user can view it once more.
const RECOVERY_VIEW_MS = 7000;
let recoveryViewTimer = 0;
let recoveryViewCountdown = 0;

function stopRecoveryViewTimer() {
  if (recoveryViewTimer) { clearInterval(recoveryViewTimer); recoveryViewTimer = 0; }
  recoveryViewCountdown = 0;
  const label = recoveryPhraseBox?.querySelector("[data-recovery-countdown]");
  if (label) label.remove();
}

function hideRevealedRecoveryPhrase() {
  stopRecoveryViewTimer();
  if (recoveryPhraseBox) { recoveryPhraseBox.hidden = true; recoveryPhraseBox.textContent = ""; }
  if (revealRecoveryButton) revealRecoveryButton.hidden = false;
}

function renderRecoveryCountdown() {
  const label = recoveryPhraseBox?.querySelector("[data-recovery-countdown]");
  if (label) label.textContent = `Hiding in ${recoveryViewCountdown}s`;
}

function revealRecoveryPhraseAfterHold() {
  const account = activeSavedAccountRecord();
  if (!account?.mnemonic || !recoveryPhraseBox) {
    resetRecoveryHold();
    return;
  }

  stopRecoveryViewTimer();
  recoveryPhraseBox.textContent = account.mnemonic;
  const countdown = document.createElement("span");
  countdown.className = "recovery-countdown";
  countdown.dataset.recoveryCountdown = "";
  recoveryPhraseBox.appendChild(countdown);
  recoveryPhraseBox.hidden = false;
  if (revealRecoveryButton) revealRecoveryButton.hidden = true;
  resetRecoveryHold();

  recoveryViewCountdown = Math.round(RECOVERY_VIEW_MS / 1000);
  renderRecoveryCountdown();
  recoveryViewTimer = window.setInterval(() => {
    recoveryViewCountdown -= 1;
    if (recoveryViewCountdown <= 0) { hideRevealedRecoveryPhrase(); return; }
    renderRecoveryCountdown();
  }, 1000);
}

function updateRecoveryHold(now) {
  if (!recoveryHoldStartedAt) return;
  const elapsed = Math.max(0, now - recoveryHoldStartedAt);
  const progress = Math.min(1, elapsed / RECOVERY_HOLD_MS);
  if (recoveryProgressFill) recoveryProgressFill.style.width = `${progress * 100}%`;

  if (progress >= 1) {
    revealRecoveryPhraseAfterHold();
    return;
  }

  recoveryHoldFrame = requestAnimationFrame(updateRecoveryHold);
}

function beginRecoveryHold(event) {
  if (!revealRecoveryButton || revealRecoveryButton.hidden || recoveryHoldStartedAt) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  event.preventDefault();
  recoveryHoldPointerId = event.pointerId;
  try { revealRecoveryButton.setPointerCapture(event.pointerId); } catch {}
  revealRecoveryButton.classList.add("is-holding");
  recoveryHoldStartedAt = performance.now();
  recoveryHoldFrame = requestAnimationFrame(updateRecoveryHold);
}

function cancelRecoveryHold(event) {
  if (event && recoveryHoldPointerId !== null && event.pointerId !== recoveryHoldPointerId) return;
  resetRecoveryHold();
}

function closeRecoveryModal() {
  resetRecoveryHold();
  stopRecoveryViewTimer();
  if (recoveryModal) recoveryModal.hidden = true;
  if (recoveryPhraseBox) { recoveryPhraseBox.hidden = true; recoveryPhraseBox.textContent = ""; }
  if (revealRecoveryButton) revealRecoveryButton.hidden = false;
}
function openRecoveryModal() {
  const account = activeSavedAccountRecord();
  if (!account?.mnemonic) { showCopyToast("No recovery phrase stored for this account"); return; }
  resetRecoveryHold();
  stopRecoveryViewTimer();
  if (recoveryPhraseBox) { recoveryPhraseBox.hidden = true; recoveryPhraseBox.textContent = ""; }
  if (revealRecoveryButton) revealRecoveryButton.hidden = false;
  if (recoveryModal) recoveryModal.hidden = false;
}
document.querySelectorAll("[data-close-recovery]").forEach((button) => button.addEventListener("click", closeRecoveryModal));
recoveryModal?.addEventListener("click", (event) => { if (event.target === recoveryModal) closeRecoveryModal(); });

// Click-to-view (no longer hold): password-gated when the seed-phrase
// protection is on.
revealRecoveryButton?.addEventListener("click", async () => {
  if (accountShellPrefs.passwordForSeed && hasAppPassword()) {
    const ok = await requestPassword({ mode: "verify", title: "Enter Password", message: "Enter your password to view the seed phrase." });
    if (!ok) return;
  }
  revealRecoveryPhraseAfterHold();
});

const logoutModal = document.querySelector("[data-logout-modal]");
function openLogoutModal() { if (logoutModal) logoutModal.hidden = false; }
function closeLogoutModal() { if (logoutModal) logoutModal.hidden = true; }

document.querySelectorAll('[data-shell-action="logout"]').forEach((button) => button.addEventListener("click", openLogoutModal));
document.querySelectorAll("[data-close-logout]").forEach((button) => button.addEventListener("click", closeLogoutModal));
logoutModal?.addEventListener("click", (event) => { if (event.target === logoutModal) closeLogoutModal(); });

document.querySelector("[data-confirm-logout]")?.addEventListener("click", async () => {
  try {
    persistState();
    if (engine.privateKeyHex) persistTestingWallet();
    localStorage.setItem(SESSION_LOGGED_OUT_KEY, "true");
    clearSessionActive();
    closeLogoutModal();
    await engine.disconnect?.();
    engine.clearSession();
    setActiveConversationId(null);
    state = { contacts: [], conversations: [] };
    currentBalanceKas = "--";
    updateWalletUi();
    updateServiceSummary();
    renderChats();
    showLoggedOutScreen();
  } catch (error) {
    appendEngineLog(`Logout failed: ${error.message}`);
  }
});

// ---------------------------------------------------------------------------
// Danger Zone (Settings) — real, destructive actions matching iOS's Danger Zone.
// Each is gated by an explicit confirm. Order of destructiveness:
//   resync         → wipe incoming messages, keep account + sent, re-sync from chain
//   remove-account → wipe the CURRENT account (data + messages) from this device, log out
//   wipe-all       → erase EVERY saved account and all local KaChat data, reload fresh
// ---------------------------------------------------------------------------

// iOS: "This removes all incoming messages locally and in iCloud, then re-syncs them from the
// blockchain. Your account info and sent messages are preserved." Desktop has no iCloud; the
// rest maps 1:1 — drop incoming messages, reset each conversation's sync cursor to 0 and the
// handshake scan, then run a silent backfill sweep.
async function dangerWipeAndResyncIncoming() {
  if (!await confirmText("Wipe and re-sync incoming messages?\n\nThis removes all incoming messages on this device, then re-syncs them from the blockchain. Your account info and sent messages are preserved.")) return;
  let removed = 0;
  for (const conversationEntry of state.conversations || []) {
    const before = (conversationEntry.messages || []).length;
    conversationEntry.messages = (conversationEntry.messages || []).filter((message) => message.direction !== "incoming");
    removed += before - conversationEntry.messages.length;
    conversationEntry.unreadCount = 0;
    conversationEntry.sync = { ...(conversationEntry.sync || {}), cursor: 0, lastSyncAt: 0 };
  }
  // Reset the incoming-handshake scan so requests re-sync from the start too.
  handshakeSyncState = { walletAddress: engine.address || "", cursor: 0, parserVersion: 3, processedTxids: [], declinedTxids: [] };
  persistHandshakeSyncState();
  pendingInitialCatchUp = true; // the re-sync is a silent backfill, not live traffic
  persistState();
  renderChats();
  if (activeConversationId) {
    const active = (state.conversations || []).find((entry) => entry.id === activeConversationId);
    if (active) renderMessages(active);
  }
  showCopyToast(`Removed ${removed} incoming message${removed === 1 ? "" : "s"} — re-syncing…`);
  try {
    await ensureRuntimes({ quiet: true });
    await refreshAllConversations({ quiet: true });
    showCopyToast("Re-sync complete");
  } catch (error) {
    appendEngineLog(`Danger Zone re-sync failed: ${error.message}`);
    showCopyToast("Re-sync will continue in the background");
  }
}

// iOS: "This removes local account data and messages." Desktop equivalent: remove the active
// saved account (wallet, contacts, conversations, account-scoped storage) from this device and
// return to the logged-out / accounts screen.
async function dangerWipeCurrentAccount() {
  const account = activeSavedAccountRecord();
  if (!account) { showCopyToast("No active account to wipe."); return; }
  if (!await confirmText(`Wipe account & messages?\n\nThis permanently removes "${account.name}" and all of its messages and data from this device. Make sure you have backed up its recovery phrase or private key first. This cannot be undone.`)) return;
  try {
    localStorage.setItem(SESSION_LOGGED_OUT_KEY, "true");
    clearSessionActive();
    await engine.disconnect?.();
    engine.clearSession();
    // Removes the saved-account record + every account-scoped key for this address.
    removeSavedAccountFromDevice(account);
    setActiveConversationId(null);
    state = { contacts: [], conversations: [] };
    currentBalanceKas = "--";
    updateWalletUi();
    updateServiceSummary();
    renderChats();
    closeAccountOverlay();
    showLoggedOutScreen();
    showCopyToast("Account and messages wiped.");
  } catch (error) {
    appendEngineLog(`Danger Zone account wipe failed: ${error.message}`);
    showCopyToast(error.message);
  }
}

// The desktop's broadest reset (no iOS iCloud analogue): erase every saved account and all
// KaChat-owned local data, then reload to a clean first-run state.
async function dangerWipeEverything() {
  if (!await confirmText("Wipe ALL saved accounts and local data?\n\nThis permanently erases every account, and all messages, contacts, and settings stored in this browser. Make sure you have backed up every recovery phrase. This cannot be undone.")) return;
  try { await engine.disconnect?.(); } catch {}
  try { engine.clearSession?.(); } catch {}
  try {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith("kachat")) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
  try { clearSessionActive(); } catch {}
  // The chat store is IndexedDB-backed when available (see ui/storage.js DB_NAME).
  try { indexedDB.deleteDatabase("kachat-desktop"); } catch {}
  window.location.reload();
}

const DANGER_ZONE_ACTIONS = {
  resync: dangerWipeAndResyncIncoming,
  "remove-account": dangerWipeCurrentAccount,
  "wipe-all": dangerWipeEverything,
};
Object.entries(DANGER_ZONE_ACTIONS).forEach(([action, handler]) => {
  document.querySelectorAll(`[data-shell-action="${action}"]`).forEach((button) => button.addEventListener("click", handler));
});

// Remaining shell-action buttons with no dedicated handler yet show a placeholder toast.
document.querySelectorAll('[data-shell-action]:not([data-shell-action="logout"]):not([data-shell-action="view-recovery"]):not([data-shell-action="resync"]):not([data-shell-action="remove-account"]):not([data-shell-action="wipe-all"])').forEach((button) => button.addEventListener("click", () => {
  const label = button.querySelector("strong")?.textContent?.trim() || "This control";
  showCopyToast(`${label} frame ready`);
}));

document.querySelector("[data-logged-out-create]")?.addEventListener("click", openCreateAccountModal);

document.querySelector("[data-logged-out-import]")?.addEventListener("click", openImportAccountModal);

document.querySelector("[data-copy-balance]")?.addEventListener("click", async () => {
  try { await copyTextToClipboard(String(currentBalanceKas)); showCopyToast("Balance copied to clipboard."); } catch (error) { appendEngineLog(error.message); }
});

document.querySelectorAll('[data-shell-action="view-recovery"]').forEach((button) => button.addEventListener("click", openRecoveryModal));

// The profile "Welcome Guide" row is gated by the Show Setup Guides pref, like
// iOS (walletManager.showSetupGuides).
function refreshSetupGuideRow() {
  const show = accountShellPrefs.showSetupGuides ?? true;
  document.querySelectorAll("[data-setup-guide-row]").forEach((el) => { el.hidden = !show; });
}

const prefBindings = [
  ["[data-pref-save-account]", "saveAccount", true],
  ["[data-pref-keep-signed-in]", "keepSignedIn", true],
  ["[data-pref-estimate-fees]", "estimateFees", false],
  ["[data-pref-hide-payment-chats]", "hidePaymentChats", false],
  ["[data-pref-show-contact-balance]", "showContactBalance", true],
  ["[data-pref-store-messages]", "storeMessages", true],
  ["[data-pref-show-setup-guides]", "showSetupGuides", true],
  // Settings > Chats: hold back inline photos from contacts you haven't accepted yet
  // (iOS AppSettings.requirePhotoApprovalForNewContacts, default ON).
  ["[data-pref-photo-approval]", "photoApprovalForNewContacts", true],
  // Settings > Notifications (iOS NotificationsHubPage port): Chats / Wallet /
  // KaPosts pages, all default ON.
  ["[data-pref-chat-notifications]", "chatNotifications", true],
  ["[data-pref-notification-sound]", "notificationSound", true],
  ["[data-pref-address-activity]", "addressActivityNotifications", true],
  ["[data-pref-kaposts-notify-likes]", "kaPostsNotifyLikes", true],
  ["[data-pref-kaposts-notify-reposts]", "kaPostsNotifyReposts", true],
  ["[data-pref-kaposts-notify-follows]", "kaPostsNotifyFollows", true],
  ["[data-pref-kaposts-notify-dislikes]", "kaPostsNotifyDislikes", true],
  ["[data-pref-kaposts-notify-comments]", "kaPostsNotifyComments", true],
];
prefBindings.forEach(([selector, key, fallback]) => {
  const input = document.querySelector(selector);
  if (!input) return;
  input.checked = accountShellPrefs[key] ?? fallback;
  input.addEventListener("change", () => {
    accountShellPrefs[key] = input.checked;
    persistAccountShellPreferences();
    if (key === "estimateFees") scheduleFeeEstimate();
    if (key === "showSetupGuides") refreshSetupGuideRow();
    if (key === "photoApprovalForNewContacts") {
      // Apply to the open thread immediately, and re-sync the Chat Info toggle that mirrors it.
      const conv = (state.conversations || []).find((entry) => entry.id === activeConversationId);
      if (conv) renderMessages(conv);
      try { refreshChatInfoContactControls(); } catch { /* Chat Info not open */ }
    }
    if ((key === "chatNotifications" || key === "addressActivityNotifications") && input.checked) {
      ensureNotificationPermission().then((granted) => {
        if (!granted) showCopyToast("Allow notifications in your browser to receive them.");
      });
    }
    if (key === "saveAccount") showCopyToast(input.checked ? "New accounts will be saved on this device." : "New accounts will stay in memory only (not saved).");
    if (key === "keepSignedIn") showCopyToast(input.checked ? "You'll stay signed in on next launch." : "You'll be asked to sign in on next launch.");
  });
});
refreshSetupGuideRow();

document.querySelector("[data-generate-wallet]")?.addEventListener("click", openCreateAccountModal);

document.querySelector("[data-import-wallet]")?.addEventListener("click", openImportAccountModal);

document.querySelector("[data-clear-wallet]")?.addEventListener("click", () => {
  engine.clearSession();
  clearPersistedTestingWallet();
  privateKeyInput.value = "";
  currentBalanceKas = "--";
  updateWalletUi();
  updateServiceSummary();
  appendEngineLog("Session cleared.");
});

document.querySelector("[data-connect-rpc]").addEventListener("click", async () => {
  await connectAndRefresh();
});



document.querySelector("[data-refresh-balance]").addEventListener("click", async () => {
  await connectAndRefresh();
});

document.querySelector("[data-export-local-state]")?.addEventListener("click", async () => {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), step: window.__kaspaEngineStep, state }, null, 2);
  await navigator.clipboard.writeText(payload);
  appendEngineLog("Local contacts/conversations JSON copied to clipboard.");
  setStatus("Local data exported");
});

document.querySelector("[data-clear-local-state]")?.addEventListener("click", async () => {
  if (!await confirmText("Clear local contacts and message previews? Wallet/private keys are not saved and will not be affected.")) return;
  state = { contacts: [], conversations: [] };
  persistState();
  renderChats();
  appendEngineLog("Local contacts/conversations cleared.");
  setStatus("Local data cleared");
});

profileQrCard?.addEventListener("click", () => {
  if (!engine.address || !profileQrOverlay || !profileQrOverlayCanvas) return;
  const overlayContext = profileQrOverlayCanvas.getContext("2d");
  overlayContext.clearRect(0, 0, profileQrOverlayCanvas.width, profileQrOverlayCanvas.height);
  overlayContext.drawImage(profileQr, 0, 0, profileQrOverlayCanvas.width, profileQrOverlayCanvas.height);
  profileQrOverlay.hidden = false;
});

profileQrOverlay?.addEventListener("click", async () => {
  const target = chattingAddressScreenAddress || engine.address;
  if (target) {
    try {
      await copyTextToClipboard(target);
      showCopyToast(addressCopiedToastText(target));
    } catch (error) { appendEngineLog(`Copy failed: ${error.message}`); }
  }
  profileQrOverlay.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && profileQrOverlay && !profileQrOverlay.hidden) {
    profileQrOverlay.hidden = true;
  }
});

document.querySelectorAll("[data-copy-engine-address]").forEach((button) => {
  button.addEventListener("click", async () => {
    // Whatever the screen is showing wins; engine.address is only the fallback for the
    // plain chatting view (see chattingAddressScreenAddress).
    const target = chattingAddressScreenAddress || engine.address;
    if (!target) {
      appendEngineLog("Copy failed: no wallet loaded.");
      return;
    }
    try {
      await copyTextToClipboard(target);
      appendEngineLog("Copied address.");
      showCopyToast(addressCopiedToastText(target));
    } catch (error) {
      appendEngineLog(`Copy failed: ${error.message}`);
      showCopyToast("Copy failed");
    }
  });
});

const hasSavedAccounts = loadSavedAccounts().length > 0;
if (localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true" || !hasSavedAccounts) {
  localStorage.setItem(SESSION_LOGGED_OUT_KEY, "true");
  showLoggedOutScreen();
} else {
  hideLoggedOutScreen();
  renderChats();
  restoreLastAppTab();
  // Asked once the account is actually in, so the prompt has context rather than greeting a
  // signed-out landing screen.
  requestNotificationPermissionIfNeeded();
}
updateWalletUi();
updateServiceSummary();
appendEngineLog("Step 75: fixed signed-out account dialog layering; account logic remains Step 73.");
renderTransportReadiness();

window.addEventListener("beforeunload", () => {
  try {
    if (engine.privateKeyHex) persistTestingWallet();
    persistState();
    // Best-effort: start the pending IndexedDB write NOW instead of waiting
    // out the debounce the page is about to tear down.
    flushChatStorage();
  } catch (error) { console.error(error); }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    try {
      if (engine.privateKeyHex) persistTestingWallet();
      persistState();
      flushChatStorage();
    } catch (error) { console.error(error); }
    return;
  }
  refreshBalanceOnly({ quiet: true });
  refreshAllConversations({ quiet: true });
});

// Step 50: start independent services in parallel. Rusty Kaspa gates wallet restore and RPC,
// while the Kasia cipher loads independently so a slow public node cannot hold messaging startup hostage.
queueMicrotask(async () => {
  setStatus("Starting KaChat services…");
  setService(runtimeIndicator, runtimeStatus, "busy", "Loading Rusty Kaspa…");
  setService(messagingIndicator, messagingStatus, "busy", "Loading encryption runtime…");
  setArchitectureBadge(networkBadge, "", "Waiting");
  setArchitectureBadge(messagingBadge, "busy", "Starting");

  const wasmTask = (async () => {
    if (!engine.kaspa) await engine.loadWasm();
    appendEngineLog(`WASM loaded ${engine.version() || ""}`);
    setService(runtimeIndicator, runtimeStatus, "ready", `Rusty Kaspa ${engine.version?.() || "ready"}`);
    return true;
  })();

  const cipherTask = (async () => {
    if (!engine.isKasiaCipherLoaded?.()) await engine.loadKasiaCipher();
    appendEngineLog("Kasia cipher loaded.");
    setService(messagingIndicator, messagingStatus, "ready", "Encryption runtime ready");
    setArchitectureBadge(messagingBadge, "ready", "Ready");
    return true;
  })();

  const [wasmResult, cipherResult] = await Promise.allSettled([wasmTask, cipherTask]);
  const wasmReady = wasmResult.status === "fulfilled";
  const cipherReady = cipherResult.status === "fulfilled";

  if (!wasmReady) {
    appendEngineLog(`WASM failed: ${wasmResult.reason?.message || wasmResult.reason}`);
    setService(runtimeIndicator, runtimeStatus, "error", "Rusty Kaspa failed to load");
  }
  if (!cipherReady) {
    appendEngineLog(`Cipher failed: ${cipherResult.reason?.message || cipherResult.reason}`);
    setService(messagingIndicator, messagingStatus, "error", "Kasia cipher failed to load");
    setArchitectureBadge(messagingBadge, "error", "Error");
  }

  if (wasmReady) {
    const restored = restorePersistedTestingWallet();
    updateWalletUi();
    updateServiceSummary();
    if (restored) {
      await connectAndRefresh({ quiet: true });
    } else if (!engine.address && loggedOutScreen && loggedOutScreen.hidden) {
      // Wallet wasn't restored (e.g. "Keep me signed in" is off) — fall back to
      // the sign-in screen instead of an empty main app.
      showLoggedOutScreen();
    }
  }

  if (wasmReady && engine.address) {
    await refreshBalanceOnly({ quiet: true });
    if (cipherReady) await refreshAllConversations({ quiet: true });
    startAutomaticRefresh();
    // Seed/diff the Address Activity baselines shortly after startup (first
    // run per account seeds silently — no notification blast for old funds).
    scheduleAddressActivityCheck(15_000);
  }

  initKaPosts({
    engine,
    escapeHtml,
    shortAddress,
    accountScopedKey,
    isChattingBalanceZero,
    showFundingGate: showFundingGateModal,
    showToast: showCopyToast,
    appendEngineLog,
    explorerTxUrl,
    // Background activity pings (Settings > Notifications > KaPosts).
    shouldNotifyKaPostsAction,
    postDesktopNotification,
    // OS-notification clicks land on the exact post — the KaPosts tab must be
    // fronted first since the ping can arrive while another tab is active.
    openKaPostsTab: () => setActiveAppTab("kaposts"),
    kaPostsSuppressed: () => isChildModeEnabled(),
    // "Tip" button on a post: quick Send-Kaspa-style modal, direct send through the chat
    // payment rules (matches iOS's KaPostTipSheet).
    tipUser: (address, name) => openTipModal({ address, name }),
    // Feed the global notification center (top-bar bell) from the KaPosts notification stream.
    recordGlobalNotification: (item) => recordGlobalNotification(item),
    // Your saved name for a contact wins over their KNS domain everywhere a poster is named
    // (matches iOS: alias -> domain -> short address).
    contactAliasFor: (address) => {
      const name = ((state.contacts || []).find((c) => c.address === address)?.name || "").trim();
      return name || null;
    },
    // @mention autocomplete source: your 1:1 chat contacts that have a KNS domain. Returns
    // [{ domain (bare, no .kas), address, name }]. Only these people can be @-mentioned.
    getMentionCandidates: () => {
      const out = [];
      const seen = new Set();
      for (const contact of state.contacts || []) {
        const info = engine.peekKnsAddressInfo?.(contact.address);
        const domain = String(info?.explicitPrimaryDomain || info?.primaryDomain || "").trim();
        if (!domain) continue;
        const bare = domain.replace(/\.kas$/i, "").toLowerCase();
        if (!bare || seen.has(bare)) continue;
        // Need the compressed KaPost pubkey to notify them; skip if we can't derive it.
        const pubkey = engine.kapostPubkeyForAddress?.(contact.address);
        if (!pubkey) continue;
        seen.add(bare);
        out.push({ domain: bare, address: contact.address, name: (contact.name || "").trim() || bare, pubkey });
      }
      return out;
    },
  });

  initBroadcasts({
    engine,
    escapeHtml,
    shortAddress,
    accountScopedKey,
    isChattingBalanceZero,
    showFundingGate: showFundingGateModal,
    showToast: showCopyToast,
    appendEngineLog,
    // Link previews: the exact same renderers as 1:1 bubbles (linkify + the
    // progressive Nextcloud video→audio→img→attachment probe).
    renderTextWithLinks,
    buildLinkPreviewCard,
    isPreviewableUrl,
    // Voice notes: same MediaRecorder wrapper + Nextcloud upload as the 1:1 composer.
    createVoiceRecorder,
    formatRecordingTime,
    isNextcloudMediaSendActive,
    uploadNextcloudMedia,
    // Reactions: identical wire parser and fixed tapback set across all clients.
    parseReactionEnvelope,
    // Getter, not a snapshot: the set is user-customizable (Settings > Chats).
    quickReactionEmojis: () => quickReactionEmojis(),
    // Same wire envelopes as 1:1 chats — replies, photos, and voice notes must decode
    // in broadcast rooms too instead of rendering raw JSON.
    parseReplyEnvelope,
    parseImageEnvelope,
    parseAudioEnvelope,
    openPhotoPreview,
    // Right-click context menu (1:1 parity): quick reactions + Reply/Copy/Explorer/Hide.
    // Functions are hoisted; MSG_MENU_ICONS is a const declared later in the module, so
    // it is handed over lazily to dodge the temporal dead zone at init time.
    openMsgContextMenu,
    getMsgMenuIcons: () => MSG_MENU_ICONS,
    copyText: copyTextToClipboard,
    explorerTxUrl,
    // Per-message avatars beside broadcast bubbles (1:1/group parity).
    avatarHtmlForAddress: (address, className = "message-avatar") => {
      if (address === engine.address) return selfAvatarHtml(className);
      const contact = (state.contacts || []).find((c) => c.address === address);
      if (contact) return avatarHtmlFor(contact, className);
      return `<span class="${className}">${escapeHtml(initialsFor(shortAddress(address)))}</span>`;
    },
    // Bell toggle requests OS notification permission on the spot.
    ensureNotificationPermission,
    // "Today"/"Yesterday" day pills, shared with 1:1 and group chats.
    daySeparatorLabel,
    // Per-channel bell: OS pings for live messages in notify-enabled channels.
    postDesktopNotification,
    // Fresh incoming broadcast messages feed the global notification center (gated to LIVE
    // arrivals so the initial history backfill doesn't flood it).
    onIncomingBroadcast: (rows) => {
      for (const row of rows || []) {
        if (Number(row.blockTime || 0) < NOTIF_SESSION_START) continue;
        const contact = (state.contacts || []).find((c) => c.address === row.senderAddress);
        const senderName = (contact?.name || "").trim()
          || engine.peekKnsAddressInfo?.(row.senderAddress)?.primaryDomain
          || shortAddress(row.senderAddress);
        recordGlobalNotification({
          source: "broadcast",
          id: `broadcast-${row.txId}`,
          title: `${senderName} in #${row.channel}`,
          body: `"${displayTextForMessage({ text: row.content }).slice(0, 90)}"`,
          timestamp: Number(row.blockTime) || Date.now(),
          targetKind: "broadcast",
          targetId: row.channel,
        });
      }
    },
  });

  initPortfolio({
    engine, escapeHtml, accountScopedKey, showToast: showCopyToast,
    // Read straight from the live selection so portfolio does not duplicate the
    // currency table (it falls back to the stored key when these are absent).
    currencyCode: () => selectedCurrency.toUpperCase(),
    currencySymbol: () => String(currencyMeta().symbol || "").trim(),
  });
  initColdStorage({
    engine, escapeHtml, shortAddress, accountScopedKey,
    showToast: showCopyToast, appendEngineLog,
    explorerAddressUrl, explorerTxUrl,
    txDirectionForAddress: manageAddressTxDirection,
    // Fiat toggle in the send flow: live KAS price in the user's selected currency,
    // plus the same symbol/format helpers the manage-address send screen uses.
    fetchKasPrice: () => fetchKasPrice(selectedCurrency),
    currencySymbol: () => currencyMeta().symbol.trim(),
    currencyCode: () => selectedCurrency.toUpperCase(),
    formatFiatValue,
  });
  initSwaps({ engine, escapeHtml, accountScopedKey, showToast: showCopyToast, appendEngineLog });
  initNextcloud({
    accountScopedKey, escapeHtml, appendEngineLog,
    showToast: showCopyToast,
    getActiveConversationId: () => activeConversationId,
    // A real re-render for the open thread. Without this the module falls back to
    // dispatching synthetic clicks at the sidebar row, which also clears composer state.
    refreshActiveConversationView: () => {
      if (!activeConversationId) return;
      const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
      if (conversationEntry) renderMessages(conversationEntry);
    },
    queueConversationMessage,
    // "Send from Nextcloud" staging: the picked file's share link lands in the composer for
    // review instead of auto-sending — the user presses send themselves.
    stageComposerText: (text) => {
      activateComposerMode("message");
      const input = composer?.elements?.message;
      if (!input) return;
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    },
    // The backup payload is the CROSS-PLATFORM ChatHistoryArchive (same file name
    // and same schema iOS/Android write), merged with whatever the server already
    // holds so a desktop upload can only ever add to the shared history. The
    // desktop's own persisted state rides along in the additive `desktopState`
    // key, which both phone decoders ignore. Since envelope v1 the upload body is
    // ENCRYPTED: decrypt what the server already has (legacy plaintext passes
    // through), merge, then always seal the union. A failed decrypt throws here,
    // so runBackup aborts before its PUT and the remote file is left untouched.
    exportBackupPayload: async (existingRemoteJson = null) => {
      const remotePlainJson = existingRemoteJson == null ? null : await openSharedBackupJson(existingRemoteJson);
      return sealSharedBackupJson(buildSharedBackupPayload(remotePlainJson));
    },
    // Reader for downloaded backup files: decrypts an envelope, passes legacy
    // plaintext through, throws (aborting the restore) when decryption fails.
    openBackupPayload: openSharedBackupJson,
    // Legacy `kachat-backup-desktop.json` bodies only — kept so a user with an
    // old desktop-only backup can still recover from it.
    importBackupPayload: (json) => {
      const parsed = JSON.parse(json);
      if (parsed?.kind !== "kachat-desktop-backup" || !parsed.state) {
        throw new Error("That file is not a KaChat desktop backup.");
      }
      // Write-through the same storage the live persist path uses (IndexedDB
      // cache when available, localStorage fallback otherwise), then reload
      // synchronously from that cache.
      applyDesktopStateSnapshot(parsed);
    },
    // The desktop-only half of a shared `kachat-backup.json`; false when the
    // file was written by a phone and carries no desktopState.
    importDesktopState: importDesktopStateFromSharedArchive,
    // The shared archive itself (whoever wrote it): merged into the desktop
    // conversations, never a state replace.
    importPhoneArchive: importPhoneChatArchive,
    // CardDAV contacts sync: import {address, name} pairs read from the account's Nextcloud
    // address book into the desktop's contact list (Settings → Contacts).
    importNextcloudContacts,
  });

  initChildMode({
    escapeHtml,
    showToast: showCopyToast,
    // Toggling Child Mode re-renders the dock immediately: gated tabs vanish
    // (or return) and, if the user is sitting on a now-hidden tab, the
    // applyDockLayout snap drops them back to Chats.
    onChildModeChanged: () => applyDockLayout(),
  });

  // Per-account dock prefs may differ from the pre-login defaults rendered at load.
  reloadDockPrefsForAccount();
  window.setTimeout(maybeShowDockWizard, 1200);

  // A page reload mid-setup doesn't dodge an onboarding run. Two persisted
  // markers drive the re-present, and BOTH re-present as an onboarding run
  // (unskippable), because that is what was interrupted:
  //  - Adult/Child still unanswered -> resume straight at that step;
  //  - otherwise a run marker means the run was interrupted after the
  //    Adult/Child question was already settled (e.g. an import on a device
  //    that answered it for a prior account) -> replay from the top.
  // The stored run kind keeps an interrupted IMPORT run's import-only
  // affordances (the funding step's "Change Chatting Address" picker).
  const pendingRunKind = pendingOnboardingRunKind();
  if (isUserTypePending()) {
    openSetupGuide({ onboardingRun: true, importRun: pendingRunKind === "import", startAtUserType: true });
  } else if (isOnboardingRunPending()) {
    openSetupGuide({ onboardingRun: true, importRun: pendingRunKind === "import" });
  }

  reloadStateFromBrowserStorage();
  reconcileEstablishedRelationships();
  if (activeConversationId) {
    const active = state.conversations.find((entry) => entry.id === activeConversationId);
    if (active) renderMessages(active);
  } else {
    renderChats();
  }

  setStatus(wasmReady ? "Services ready" : "Open Diagnostics for setup help");
  updateServiceSummary();
});


/* ============================================================================
   GROUP CHAT (self-contained)
   ---------------------------------------------------------------------------
   Groups never enter state.conversations (that store drops any entry without a
   contactId). Instead the roster/keys live in the GroupManager (engine layer,
   localStorage kachat-groups-v1) and decoded messages live in their own store
   here. The thread/list/manage UI reuses the message-bubble and chat-row CSS
   but has its own render/send paths, so none of the 1:1 systems are touched.
   ============================================================================ */

// activeGroupId is declared up top (near setActiveConversationId) so the shared detail-pane
// layout helpers can read it without a temporal-dead-zone error during boot.
const groupCreateSelected = new Set();
let groupModalMode = "create"; // "create" | "add"
let groupModalTargetId = null;
let groupPickerExclude = []; // addresses excluded from the member picker (existing members in "add" mode)

// Lazily create (or recreate on wallet switch) the GroupManager bound to the engine.
// (groupManager / groupManagerForAddress are declared near the top of the file so the
// boot-time renderChats -> updateChatsListTabBadges path can reach this safely.)
function getGroupManager() {
  if (!engine.address || !engine.privateKeyHex) return null;
  if (!groupManager || groupManagerForAddress !== engine.address) {
    groupManager = createGroupManager(engine);
    groupManagerForAddress = engine.address;
  }
  return groupManager;
}

// --- decoded-message store (per wallet, per group) ---
const GROUP_MSG_KEY = "kachat-group-messages-v1";
const GROUP_UNREAD_KEY = "kachat-group-unread-v1";

function loadGroupMsgAll() { try { return JSON.parse(localStorage.getItem(GROUP_MSG_KEY) || "{}") || {}; } catch { return {}; } }
function saveGroupMsgAll(all) { try { localStorage.setItem(GROUP_MSG_KEY, JSON.stringify(all)); } catch {} }
function groupMessages(groupId) {
  const all = loadGroupMsgAll();
  const list = all?.[engine.address || ""]?.[groupId];
  return Array.isArray(list) ? list : [];
}
function saveGroupMessages(groupId, list) {
  const all = loadGroupMsgAll();
  const wallet = engine.address || "";
  if (!all[wallet]) all[wallet] = {};
  all[wallet][groupId] = list;
  saveGroupMsgAll(all);
}
// Returns true if this was a new message (deduped by msgIdHex, then txId, then id).
// Your own KNS domain names (bare, no .kas), used to detect @mentions of you in group chats.
function myKnsDomainSet() {
  const set = new Set();
  const info = engine.peekKnsAddressInfo?.(engine.address);
  const add = (d) => { const bare = String(d || "").replace(/\.kas$/i, "").toLowerCase().trim(); if (bare) set.add(bare); };
  add(info?.explicitPrimaryDomain);
  add(info?.primaryDomain);
  for (const d of info?.allDomains || []) add(d?.fullName || d);
  return set;
}
const GROUP_MENTION_RE = /(^|[\s([{<"'])@([a-z0-9-]+(?:\.[a-z0-9-]+)*)/gi;

// TWO mention wire forms travel between platforms and both must match, or a mention is
// silently dropped: iOS and desktop compose `@<address>` (optionally brace-wrapped on older
// desktop builds), while Android composes a bare `@domain`. Desktop used to test only the
// address form, so every mention an Android member typed went unnoticed here.
// Domain comparison is case-insensitive with the `.kas` suffix optional, matching iOS.
function textMentionsMe(text) {
  const body = String(text || "");
  if (!body) return false;
  const me = engine.address || "";
  if (me) {
    const escaped = me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`@\\{?${escaped}\\}?`, "i").test(body)) return true;
  }
  const mine = myKnsDomainSet();
  if (!mine.size) return false;
  GROUP_MENTION_RE.lastIndex = 0;
  let match;
  while ((match = GROUP_MENTION_RE.exec(body)) !== null) {
    const handle = String(match[2] || "").replace(/\.kas$/i, "").toLowerCase();
    if (handle && mine.has(handle)) return true;
  }
  return false;
}
// A group message that is personal to you even in a mentions-only group: it @mentions you, or
// it is a reply to one of YOUR messages. Mirrors iOS GroupChatService.isPersonalGroupMessage
// (reply-to-me OR mention). Reactions are not covered here: desktop never notifies for group
// reactions on any path, so there is nothing to gate.
function isReplyToMyGroupMessage(text) {
  const me = engine.address || "";
  if (!me) return false;
  const reply = parseReplyEnvelope(text);
  return Boolean(reply && reply.replyToSender && reply.replyToSender === me);
}

// Shared gate for every OS-level group ping: the Settings > Notifications > Chats master
// toggle (default ON, same check maybeNotifyIncoming makes for 1:1), and never ping for the
// group you are already looking at in a focused window. Child Mode is deliberately NOT a gate
// here: it hides Swaps/KaPosts/Broadcasts only, and chats plus group chats stay fully
// available while it is on, exactly as the existing 1:1 and mention paths behave.
function groupOsPingAllowed(groupId) {
  if ((accountShellPrefs.chatNotifications ?? true) === false) return false;
  if (activeGroupId === groupId && !document.hidden) return false;
  return true;
}

function groupNotificationSenderName(senderAddress) {
  const contact = (state.contacts || []).find((c) => c.address === senderAddress);
  return (contact?.name || "").trim()
    || engine.peekKnsAddressInfo?.(senderAddress)?.primaryDomain
    || shortAddress(senderAddress);
}

// Single entry point for "an incoming group message just landed" — applies this group's
// notification mode (Group Info > Notifications): "all" pings for every message, "mentions"
// only for messages that @mention you or reply to you, "muted" never pings. Mirrors iOS,
// where GroupChatService.maybePostGroupLocalNotification drops non-personal messages in a
// mentions-only group and posts a banner otherwise.
function maybeNotifyGroupIncoming(groupId, senderAddress, text, id, createdAt) {
  const me = engine.address || "";
  if (!me || senderAddress === me) return;
  const mode = getGroupNotify(groupId);
  if (mode === "muted") return;
  // A hidden member's messages are filtered out of the thread; they must not ping either.
  if (isGroupMemberHidden(groupId, senderAddress)) return;
  if (textMentionsMe(text)) { maybeRecordGroupMention(groupId, senderAddress, text, id, createdAt); return; }
  if (mode !== "all" && !isReplyToMyGroupMessage(text)) return;
  if (!groupOsPingAllowed(groupId)) return;
  // Ordinary group traffic is higher volume than a mention, so it uses the same rule as the
  // 1:1 path: a real OS notification or nothing. (postDesktopNotification would otherwise fall
  // back to an in-app toast per message when browser notifications are denied.)
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const group = getGroupManager()?.getGroup(groupId);
  postDesktopNotification({
    title: group?.name || "Group",
    body: `${groupNotificationSenderName(senderAddress)}: ${groupPreviewText(text) || "New message"}`,
    tag: `kachat-group-${groupId}`,
    onClick: () => { setActiveAppTab("chats"); try { openGroupChat(groupId); } catch {} },
  });
}

// When an incoming group message @mentions one of your KNS domains, surface it in the global
// notification center (and an OS ping). Group mentions are purely client-detected — there is no
// server round-trip, unlike KaPosts mentions. Reached through maybeNotifyGroupIncoming, which
// has already applied the group's mode (a muted group never gets here).
function maybeRecordGroupMention(groupId, senderAddress, text, id, createdAt) {
  const me = engine.address || "";
  if (!me) return;
  if (!textMentionsMe(text)) return;
  const group = getGroupManager()?.getGroup(groupId);
  const groupName = group?.name || "a group";
  const senderName = groupNotificationSenderName(senderAddress);
  recordGlobalNotification({
    source: "group",
    id: `group-mention-${id}`,
    title: `${senderName} mentioned you in ${groupName}`,
    body: `"${String(text || "").slice(0, 90)}"`,
    timestamp: createdAt || Date.now(),
    targetKind: "group",
    targetId: groupId,
  });
  if (!groupOsPingAllowed(groupId)) return;
  postDesktopNotification({
    title: "Group mention",
    body: `${senderName} mentioned you in ${groupName}`,
    tag: `kachat-group-mention-${id}`,
    onClick: () => { setActiveAppTab("chats"); try { openGroupChat(groupId); } catch {} },
  });
}

function appendGroupMessage(groupId, message) {
  const list = groupMessages(groupId);
  const key = message.msgIdHex || message.txId || message.id;
  if (key && list.some((m) => (m.msgIdHex || m.txId || m.id) === key)) return false;
  list.push(message);
  list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  saveGroupMessages(groupId, list);
  return true;
}

// Number of OTHER members (excludes self) — the fan-out count for admin control sends.
function groupOtherMemberCount(record) {
  return (record?.members || []).filter((m) => m.address !== engine.address).length;
}
// Estimate the total on-chain network fee for a group control operation and return a short line
// to append to a await confirmText() prompt so the user sees the cost before committing. Best-effort — on
// any failure it falls back to just the transaction count and never blocks the action.
// controlTx = number of small (root/epoch) sends; photoTx = number of (larger) gctl_photo sends.
async function groupOpFeeHint(groupId, { controlTx = 0, photoTx = 0 }) {
  const txCount = controlTx + photoTx;
  const plural = txCount === 1 ? "" : "s";
  try {
    const record = getGroupManager()?.getGroup(groupId);
    if (!record) return "";
    let total = 0;
    if (controlTx > 0) {
      const bytes = 2 * (400 + (record.members?.length || 0) * 70);        // root/epoch payload ≈
      total += parseFloat(await engine.estimateMessageFee(bytes) || "0") * controlTx;
    }
    if (photoTx > 0) {
      const bytes = 2 * (300 + (record.photoHex || "").length);           // gctl_photo payload ≈
      total += parseFloat(await engine.estimateMessageFee(bytes) || "0") * photoTx;
    }
    if (!(total > 0)) return `\n\n(${txCount} network transaction${plural}.)`;
    return `\n\nEstimated network fee ≈ ${total.toFixed(6)} KAS across ${txCount} transaction${plural}.`;
  } catch { return `\n\n(${txCount} network transaction${plural}.)`; }
}

// iMessage-style membership line ("X was added/removed to the group chat"). Stored as a local
// plaintext message flagged {system:true} and rendered centered. `key` is a stable dedup id
// (groupId+epoch+addr) so the same event never duplicates across sync passes or reloads.
function appendGroupSystemMessage(groupId, text, createdAt, key) {
  return appendGroupMessage(groupId, {
    id: key || nowId(),
    msgIdHex: key || null,
    system: true,
    text: String(text || ""),
    direction: "incoming",
    createdAt: createdAt || Date.now(),
  });
}

// Stable per-message reaction/reply target key (prefer the on-chain txId so it matches
// across clients; fall back to msgId/local id before the tx confirms).
function groupMsgKey(message) { return message?.txId || message?.msgIdHex || message?.id || ""; }

// --- group reactions store (per wallet, per group, keyed by target message key) ---
// Reactions ride the SAME {type:"reaction",...} envelope as 1:1 chats — a normal group
// message intercepted before it renders (see syncGroupsNow), so this stays interop-compatible.
const GROUP_REACTIONS_KEY = "kachat-group-reactions-v1";
function loadGroupReactionsAll() { try { return JSON.parse(localStorage.getItem(GROUP_REACTIONS_KEY) || "{}") || {}; } catch { return {}; } }
function saveGroupReactionsAll(all) { try { localStorage.setItem(GROUP_REACTIONS_KEY, JSON.stringify(all)); } catch {} }
function groupReactionsFor(groupId, targetKey) {
  const list = loadGroupReactionsAll()?.[engine.address || ""]?.[groupId]?.[targetKey];
  return Array.isArray(list) ? list : [];
}
// One emoji per reactor per target: add replaces, remove clears.
function applyGroupReaction(groupId, targetKey, reactorAddress, emoji, action) {
  if (!targetKey || !reactorAddress) return;
  const all = loadGroupReactionsAll();
  const wallet = engine.address || "";
  if (!all[wallet]) all[wallet] = {};
  if (!all[wallet][groupId]) all[wallet][groupId] = {};
  const bucket = all[wallet][groupId];
  const list = Array.isArray(bucket[targetKey]) ? bucket[targetKey] : [];
  const without = list.filter((e) => e.reactorAddress !== reactorAddress);
  if (action !== "remove" && emoji) without.push({ reactorAddress, emoji });
  bucket[targetKey] = without;
  saveGroupReactionsAll(all);
}

// Tapback on a group message. Toggles off if you tap your current emoji again.
async function sendGroupReaction(groupId, targetMessage, emoji) {
  const mgr = getGroupManager();
  if (!mgr || !engine.address) return;
  const targetKey = groupMsgKey(targetMessage);
  if (!targetKey) return;
  const mine = groupReactionsFor(groupId, targetKey).find((e) => e.reactorAddress === engine.address);
  const action = mine?.emoji === emoji ? "remove" : "add";
  applyGroupReaction(groupId, targetKey, engine.address, action === "remove" ? null : emoji, action);
  if (activeGroupId === groupId) renderGroupMessages();
  const payload = JSON.stringify({ type: "reaction", targetTxId: targetKey, emoji, action });
  const statusKey = action === "add" ? `grp|${targetKey}|${emoji}` : null;
  const rerender = () => { if (activeGroupId === groupId) renderGroupMessages(); };
  const attempt = async () => {
    if (statusKey) setReactionSendStatus(statusKey, "pending", { rerender });
    try {
      await mgr.sendGroupMessage(groupId, payload);
      if (statusKey) setReactionSendStatus(statusKey, "sent", { rerender });
    } catch (error) {
      appendEngineLog(`Group reaction send failed (local applied): ${error.message}`);
      if (statusKey) setReactionSendStatus(statusKey, "failed", { retry: attempt, rerender });
    }
  };
  await attempt();
}

// --- hidden group members (per wallet, per group): filters a member's messages from view ---
// (iOS also has mute + mentions-only, but those are notification-only and desktop pushes no
// group notifications, so they'd be dead UI here — hide is the one that actually does something.)
const GROUP_HIDDEN_MEMBERS_KEY = "kachat-group-hidden-members-v1";
function loadGroupHiddenAll() { try { return JSON.parse(localStorage.getItem(GROUP_HIDDEN_MEMBERS_KEY) || "{}") || {}; } catch { return {}; } }
function saveGroupHiddenAll(all) { try { localStorage.setItem(GROUP_HIDDEN_MEMBERS_KEY, JSON.stringify(all)); } catch {} }
function groupHiddenMembersFor(groupId) {
  const list = loadGroupHiddenAll()?.[engine.address || ""]?.[groupId];
  return Array.isArray(list) ? list : [];
}
function isGroupMemberHidden(groupId, address) { return groupHiddenMembersFor(groupId).includes(address); }
function setGroupMemberHidden(groupId, address, hidden) {
  const all = loadGroupHiddenAll();
  const wallet = engine.address || "";
  if (!all[wallet]) all[wallet] = {};
  const current = new Set(Array.isArray(all[wallet][groupId]) ? all[wallet][groupId] : []);
  if (hidden) current.add(address); else current.delete(address);
  all[wallet][groupId] = [...current];
  saveGroupHiddenAll(all);
}

// Open (or create) a 1:1 conversation with a group member, and switch to the Chats tab.
function openOrCreateOneToOne(address) {
  const addr = String(address || "").trim();
  if (!addr || addr === engine.address) return;
  let contact = (state.contacts || []).find((c) => c.address === addr);
  let conversationEntry = contact ? state.conversations.find((e) => e.contactId === contact.id) : null;
  if (!contact) {
    const createdAt = Date.now();
    const name = displayNameForAddress({ address: addr }) || shortAddress(addr);
    contact = { id: nowId(), name, nameIsCustom: false, address: addr, avatar: initialsFor(name), createdAt, updatedAt: createdAt, relationshipState: "legacy-manual", handshakeTxid: "" };
    conversationEntry = createConversation({ contactId: contact.id, createdAt });
    state.contacts.push(contact);
    state.conversations.push(conversationEntry);
    refreshSubscriptionAddresses({ restart: true });
    persistState();
  } else if (!conversationEntry) {
    conversationEntry = createConversation({ contactId: contact.id, createdAt: Date.now() });
    state.conversations.push(conversationEntry);
    persistState();
  }
  closeGroupChat();
  if (activeChatsListTab !== "chats") {
    activeChatsListTab = "chats";
    chatsListTabButtons.forEach((b) => b.classList.toggle("active", b.dataset.chatsListTab === "chats"));
  }
  renderChats();
  openConversation(conversationEntry.id);
}

// Per-member menu opened from a message avatar: Message / Copy Address / Hide-or-Unhide.
function openGroupMemberMenu(address, x, y) {
  document.querySelector(".group-msg-menu")?.remove();
  if (!address) return;
  const menu = document.createElement("div");
  menu.className = "group-msg-menu";
  const add = (label, fn, danger = false) => {
    const b = document.createElement("button");
    b.type = "button";
    if (danger) b.className = "danger";
    b.textContent = label;
    b.addEventListener("click", () => { menu.remove(); fn(); });
    menu.append(b);
  };
  if (address !== engine.address) {
    add("Message", () => openOrCreateOneToOne(address));
    add("Copy Address", () => copyTextToClipboard(address).then(() => showCopyToast(addressCopiedToastText(address))).catch(() => {}));
    const hidden = activeGroupId && isGroupMemberHidden(activeGroupId, address);
    add(hidden ? "Unhide messages" : "Hide messages", () => {
      if (!activeGroupId) return;
      setGroupMemberHidden(activeGroupId, address, !hidden);
      renderGroupMessages();
    }, !hidden);
  } else {
    add("Copy Address", () => copyTextToClipboard(address).then(() => showCopyToast(addressCopiedToastText(address))).catch(() => {}));
  }
  document.body.append(menu);
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, vw - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, vh - rect.height - 8)}px`;
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", close, true); } };
  window.setTimeout(() => document.addEventListener("mousedown", close, true), 0);
}

function loadGroupUnreadAll() { try { return JSON.parse(localStorage.getItem(GROUP_UNREAD_KEY) || "{}") || {}; } catch { return {}; } }
function groupUnreadFor(groupId) { const all = loadGroupUnreadAll(); return Number(all?.[engine.address || ""]?.[groupId] || 0); }
function setGroupUnread(groupId, count) {
  const all = loadGroupUnreadAll();
  const wallet = engine.address || "";
  if (!all[wallet]) all[wallet] = {};
  all[wallet][groupId] = Math.max(0, count | 0);
  try { localStorage.setItem(GROUP_UNREAD_KEY, JSON.stringify(all)); } catch {}
}
function totalGroupUnread() {
  const mgr = getGroupManager();
  if (!mgr) return 0;
  return mgr.listGroups().reduce((sum, g) => sum + groupUnreadFor(g.groupId), 0);
}

// --- element refs ---
const groupListEl = document.querySelector("[data-group-list]");
const groupActionsRow = document.querySelector("[data-group-actions-row]");
const chatSelectRow = document.querySelector(".chat-select-row");
const groupCreateModal = document.querySelector("[data-group-create-modal]");
const groupCreateTitle = document.querySelector("[data-group-create-title]");
const groupNameInput = document.querySelector("[data-group-name-input]");
const groupPickerHint = document.querySelector("[data-group-picker-hint]");
const groupMemberSearch = document.querySelector("[data-group-member-search]");
const groupMemberPicker = document.querySelector("[data-group-member-picker]");
// Collapsible New Group sections: "Members (N)" (added-so-far) and "Contacts" (search + list).
const groupMembersToggle = document.querySelector("[data-group-members-toggle]");
const groupMembersBody = document.querySelector("[data-group-members-body]");
const groupMembersList = document.querySelector("[data-group-members-list]");
const groupContactsToggle = document.querySelector("[data-group-contacts-toggle]");
const groupContactsBody = document.querySelector("[data-group-contacts-body]");
const groupAddressInput = document.querySelector("[data-group-address-input]");
const groupAddressStatus = document.querySelector("[data-group-address-status]");
const groupAddressAddButton = document.querySelector("[data-group-address-add]");
const groupAddressImportButton = document.querySelector("[data-group-address-import]");
const groupAddressImportFile = document.querySelector("[data-group-address-import-file]");
const groupAddressPasteButton = document.querySelector("[data-group-address-paste]");
const groupAddressScanButton = document.querySelector("[data-group-address-scan]");
const groupCreateError = document.querySelector("[data-group-create-error]");
const groupCreateSubmit = document.querySelector("[data-group-create-submit]");
let groupAddressResolved = null;
let groupAddressResolveToken = 0;
const groupChatScreen = document.querySelector("[data-group-chat-screen]");
const groupChatName = document.querySelector("[data-group-chat-name]");
const groupChatSub = document.querySelector("[data-group-chat-sub]");
const groupChatAvatar = document.querySelector("[data-group-chat-avatar]");
const groupMessageArea = document.querySelector("[data-group-message-area]");
const groupMessageEmpty = document.querySelector("[data-group-message-empty]");
const groupComposer = document.querySelector("[data-group-composer]");
const groupComposerInput = document.querySelector("[data-group-composer-input]");
const groupReadonlyNote = document.querySelector("[data-group-readonly-note]");
const groupManageScreen = document.querySelector("[data-group-manage-screen]");
const groupManageBody = document.querySelector("[data-group-manage-body]");

function setChatToolRowsForGroupsTab(isGroups) {
  // Queries the DOM directly (rather than the module-tail consts) so this stays safe
  // when renderChats runs during the synchronous boot, before those consts initialize.
  const selectRow = document.querySelector(".chat-select-row");
  const actionsRow = document.querySelector("[data-group-actions-row]");
  const listEl = document.querySelector("[data-group-list]");
  // The Group Chats tab now uses the same Select control as the Chats tab (multi-select
  // groups to mark read / delete). New groups are created with the floating + button, so
  // the old "New Group" header row is retired.
  if (selectRow) selectRow.hidden = false;
  if (actionsRow) actionsRow.hidden = true;
  if (!isGroups && listEl) listEl.hidden = true;
}

const GROUP_AVATAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M2.5 19.5c.6-3.9 3-6.3 6.5-6.3s5.9 2.4 6.5 6.3"/><path d="M16.3 6.2a3.2 3.2 0 1 1 1.9 5.8"/><path d="M15.8 13.3c2.9.4 4.7 2.3 5.2 5.4"/></svg>';
// Group photo is stored/transmitted as hex of a compressed JPEG (see gctl_photo). These convert
// to/from a browser data URL for rendering / from the compressor's output.
function groupPhotoDataUrl(hex) {
  if (!hex) return "";
  try {
    let bin = "";
    for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return "data:image/jpeg;base64," + btoa(bin);
  } catch { return ""; }
}
function groupPhotoHexFromDataUrl(dataUrl) {
  const b64 = String(dataUrl || "").split(",")[1] || "";
  const bin = atob(b64);
  let hex = "";
  for (let i = 0; i < bin.length; i += 1) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}
// Photo when the group has one, else the generic group glyph.
function groupAvatarHtml(photoHex) {
  const url = groupPhotoDataUrl(photoHex);
  if (url) return `<img class="group-avatar-photo" src="${url}" alt="" />`;
  return `<span class="group-avatar-fallback">${GROUP_AVATAR_SVG}</span>`;
}

function groupPreviewText(text) {
  // Same humanizing as the 1:1 chat list: reply envelopes show their text,
  // photos/voice notes show "📷 Photo" / "🎤 Audio message" instead of raw
  // JSON, and mention tokens decode to @names.
  const reaction = parseReactionEnvelope(text);
  const effective = reaction ? `Reacted ${reaction.emoji}` : displayTextForMessage({ text });
  const raw = decodeGroupMentions(String(effective || "")).replace(/\s+/g, " ").trim();
  return raw.length > 42 ? `${raw.slice(0, 41)}…` : raw;
}
function groupSenderLabel(address) {
  if (address === engine.address) return "You";
  const contact = (state.contacts || []).find((c) => c.address === address);
  if (contact) return displayNameForAddress(contact);
  return shortAddress(address);
}
function memberAvatarHtml(address, className = "chat-avatar") {
  const contact = (state.contacts || []).find((c) => c.address === address);
  if (contact) return avatarHtmlFor(contact, className);
  if (address === engine.address) return selfAvatarHtml(className);
  return `<span class="${className}">${escapeHtml(initialsFor(shortAddress(address)))}</span>`;
}

// Most-recent activity for a group: its newest message time, falling back to the group
// record's own timestamps so a brand-new (message-less) group still sorts sensibly.
function groupLastActivityAt(g) {
  const msgs = groupMessages(g.groupId);
  const last = msgs[msgs.length - 1];
  return Number(last?.createdAt || g.updatedAt || g.createdAt || 0);
}

// --- sidebar group list ---
function renderGroupList() {
  const mgr = getGroupManager();
  // Order by the chat with the most recent message (newest first), like the 1:1 list.
  const groups = (mgr ? mgr.listGroups() : []).slice().sort((a, b) => groupLastActivityAt(b) - groupLastActivityAt(a));
  // groups-tab badge (base hides it by default; we drive it from group unread).
  if (groupsTabBadge) {
    const total = totalGroupUnread();
    groupsTabBadge.textContent = total > 99 ? "99+" : String(total);
    groupsTabBadge.hidden = total <= 0;
  }
  if (activeChatsListTab !== "groups") return;
  if (!groups.length) {
    if (groupChatsPlaceholder) groupChatsPlaceholder.hidden = false;
    if (groupListEl) { groupListEl.hidden = true; groupListEl.innerHTML = ""; }
    return;
  }
  if (groupChatsPlaceholder) groupChatsPlaceholder.hidden = true;
  if (!groupListEl) return;
  groupListEl.hidden = false;
  groupListEl.innerHTML = groups.map((g) => {
    const msgs = groupMessages(g.groupId);
    const last = msgs[msgs.length - 1];
    const preview = last
      ? `${last.direction === "local" ? "You: " : ""}${groupPreviewText(last.text)}`
      : `${g.members.length} member${g.members.length === 1 ? "" : "s"}`;
    const time = last ? formatTime(last.createdAt) : "";
    const unread = groupUnreadFor(g.groupId);
    const selected = selectedGroupIds.has(g.groupId);
    return `
      <button class="chat-row group-row${chatSelectionModeActive ? " selecting" : ""}${selected ? " selected" : ""}${g.groupId === activeGroupId ? " active" : ""}" type="button" data-group-open="${escapeHtml(g.groupId)}">
        ${chatSelectionModeActive ? `<span class="chat-row-select" aria-hidden="true"><span class="chat-row-checkbox${selected ? " checked" : ""}"></span></span>` : ``}
        <span class="chat-row-time">${escapeHtml(time)}</span>
        <span class="chat-avatar">${groupAvatarHtml(g.photoHex)}</span>
        <span class="chat-meta">
          <strong>${escapeHtml(g.name || "Group")}</strong>
          <span>${escapeHtml(preview)}</span>
        </span>
        ${unread > 0 ? `<b class="unread-badge">${unread > 99 ? "99+" : unread}</b>` : ``}
      </button>`;
  }).join("");
}

// --- group thread (shares the right-side detail pane with the 1:1 conversation view) ---
function openGroupChat(groupId) {
  const mgr = getGroupManager();
  const g = mgr && mgr.getGroup(groupId);
  if (!g) return;
  // Take over the detail pane: clear any open 1:1 and hide its empty state. Setting
  // activeGroupId first means setActiveConversationId(null) treats the group as the pane
  // owner (keeps conversation-open/detail-active on for the narrow-layout collapse).
  activeGroupId = groupId;
  setActiveConversationId(null);
  setGroupUnread(groupId, 0);
  if (groupChatName) groupChatName.textContent = g.name || "Group";
  if (groupChatSub) groupChatSub.textContent = `${g.members.length} member${g.members.length === 1 ? "" : "s"}`;
  if (groupChatAvatar) groupChatAvatar.innerHTML = groupAvatarHtml(g.photoHex);
  const amMember = g.members.some((m) => m.address === engine.address);
  if (groupReadonlyNote) groupReadonlyNote.hidden = amMember;
  if (groupComposer) groupComposer.hidden = !amMember;
  renderGroupMessages();
  if (detailEmptyState) detailEmptyState.hidden = true;
  if (conversation) conversation.hidden = true;
  if (groupChatScreen) groupChatScreen.hidden = false;
  appBody?.classList.add("conversation-open", "detail-active");
  // Fresh composer state per group open.
  try {
    cancelGroupReply(); groupDraftMentions.clear(); closeGroupMentions(); closeGroupPlusMenu(); clearGroupPendingPhoto();
    if (groupComposerInput) { groupComposerInput.value = ""; autoGrowGroupComposer(); }
  } catch { /* composer wiring not ready during boot */ }
  window.setTimeout(() => groupComposerInput?.focus(), 0);
  renderGroupList();
}
function closeGroupChat() {
  const wasOpen = Boolean(activeGroupId);
  try { cancelGroupVoice(); cancelGroupReply(); closeGroupMentions(); closeGroupPlusMenu(); clearGroupPendingPhoto(); } catch { /* not ready */ }
  activeGroupId = null;
  if (groupChatScreen) groupChatScreen.hidden = true;
  // Restore the detail pane to its empty state (or nothing, off the Chats tab).
  if (wasOpen) setActiveConversationId(null);
  renderGroupList();
}

// Decode @<address> mention tokens (brace-wrapped legacy desktop form OR bare iOS/Android form)
// back to @KNSDomain text — used for plain-text contexts like chat-list previews and reply banners.
// The live bubble renderer uses renderTextWithMentions instead (clickable spans).
function decodeGroupMentions(text) {
  return String(text || "").replace(CHAT_MENTION_TOKEN_RE, (_, addr) => `@${mentionDisplayLabel(addr)}`);
}

// Day-separator label (Today / Yesterday / date) for the group timeline.
// Delegates to the shared daySeparatorLabel so groups, 1:1 chats, and broadcasts
// all format day pills identically (iOS parity: weekday within the current year).
function groupDaySeparatorLabel(ts) {
  return daySeparatorLabel(ts);
}

// Scroll to + briefly highlight a group message by its target key (reply-jump).
function jumpToGroupMessage(targetKey) {
  if (!groupMessageArea || !targetKey) return;
  let row = null;
  try { row = groupMessageArea.querySelector(`[data-group-msg-key="${CSS.escape(targetKey)}"]`); } catch { row = null; }
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("message-row-highlight");
  window.setTimeout(() => row.classList.remove("message-row-highlight"), 1600);
}

// Minimal inline-SVG icons for the message context menu (Telegram-style).
const MSG_MENU_ICONS = {
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  explorer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

// Shared Telegram-style right-click menu for a message. Renders a quick-reaction row at the
// top (tap an emoji to toggle it) followed by the action list. Used by both 1:1 and group
// messages. `reaction` is optional: { current, onPick }. `items` is [{label, icon, danger, onClick}].
function openMsgContextMenu({ x, y, reaction, items }) {
  document.querySelectorAll(".msg-context-menu, .group-msg-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "msg-context-menu";

  if (reaction) {
    const row = document.createElement("div");
    row.className = "msg-context-reactions";
    for (const emoji of quickReactionEmojis()) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = emoji;
      if (emoji === reaction.current) b.classList.add("active");
      b.addEventListener("click", () => { cleanup(); reaction.onPick(emoji); });
      row.append(b);
    }
    menu.append(row);
  }

  const list = document.createElement("div");
  list.className = "msg-context-actions";
  for (const item of items) {
    if (!item) continue;
    const b = document.createElement("button");
    b.type = "button";
    if (item.danger) b.classList.add("danger");
    const ic = document.createElement("span");
    ic.className = "msg-context-icon";
    ic.innerHTML = item.icon || "";
    const lbl = document.createElement("span");
    lbl.className = "msg-context-label";
    lbl.textContent = item.label;
    b.append(ic, lbl);
    b.addEventListener("click", () => { cleanup(); item.onClick(); });
    list.append(b);
  }
  menu.append(list);

  document.body.append(menu);
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, vw - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, vh - rect.height - 8))}px`;

  function cleanup() {
    menu.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", cleanup, true);
    messageArea?.removeEventListener("scroll", cleanup, true);
    groupMessageArea?.removeEventListener("scroll", cleanup, true);
  }
  const onDown = (ev) => { if (!menu.contains(ev.target)) cleanup(); };
  const onKey = (ev) => { if (ev.key === "Escape") cleanup(); };
  window.setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", cleanup, true);
    messageArea?.addEventListener("scroll", cleanup, true);
    groupMessageArea?.addEventListener("scroll", cleanup, true);
  }, 0);
}

// Right-click menu for a 1:1 message: reactions + Reply, Copy, Select, Explorer, Info, Retry, Delete.
function openOneToOneMessageMenu(messageId, x, y) {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const message = conversationEntry?.messages?.find((m) => m.id === messageId);
  if (!conversationEntry || !message) return;
  const targetTxId = message.txid || message.id;
  const isText = !parseImageEnvelope(message.text) && !parseAudioEnvelope(message.text);
  const myAddress = engine.address || "";
  const current = (conversationEntry.reactionsByTxId?.[targetTxId] || []).find((e) => e.reactorAddress === myAddress)?.emoji || null;
  const items = [];
  items.push({ label: "Reply", icon: MSG_MENU_ICONS.reply, onClick: () => startReplyTo(message.id) });
  if (isText) {
    items.push({ label: "Copy", icon: MSG_MENU_ICONS.copy, onClick: () => copyTextToClipboard(displayTextForMessage(message)).then(() => showCopyToast("Message copied")).catch(() => {}) });
  }
  items.push({ label: "Select", icon: MSG_MENU_ICONS.select, onClick: () => enterMessageSelection(message.id) });
  if (message.txid) {
    items.push({ label: "View in Explorer", icon: MSG_MENU_ICONS.explorer, onClick: () => window.open(explorerTxUrl(message.txid), "_blank", "noopener,noreferrer") });
  }
  items.push({ label: "Message info", icon: MSG_MENU_ICONS.info, onClick: () => openMessageDetails(message.id) });
  if (message.direction === "outgoing" && message.status === MESSAGE_STATUSES.FAILED) {
    items.push({ label: "Retry send", icon: MSG_MENU_ICONS.retry, onClick: () => runEngineSendPipeline(conversationEntry.id, message.id) });
  }
  items.push({ label: "Delete for me", icon: MSG_MENU_ICONS.trash, danger: true, onClick: () => deleteOneMessageLocal(conversationEntry, message) });
  // Reactions need a real target (txid or local id) to send against.
  const reaction = targetTxId ? { current, onPick: (emoji) => sendReaction(conversationEntry, message, emoji) } : null;
  openMsgContextMenu({ x, y, reaction, items });
}

// Hide a single 1:1 message from this browser only (mirrors deleteSelectedMessages for one).
function deleteOneMessageLocal(conversationEntry, message) {
  if (!conversationEntry || !message) return;
  conversationEntry.hiddenMessageKeys = [...new Set([
    ...(conversationEntry.hiddenMessageKeys || []),
    ...[message.id, message.txid].filter(Boolean).map(String),
  ])];
  conversationEntry.messages = (conversationEntry.messages || []).filter((m) => m.id !== message.id);
  const last = lastMessageFor(conversationEntry);
  conversationEntry.lastActivityAt = last?.createdAt || conversationEntry.createdAt;
  conversationEntry.updatedAt = Date.now();
  persistState();
  renderMessages(conversationEntry);
  setStatus("Message deleted locally");
}

// Right-click / context menu for a group message: reactions + Reply, Copy, Retry, Delete (local).
function openGroupMessageMenu(message, x, y) {
  const plain = parseReplyEnvelope(message.text)?.text ?? message.text;
  const isText = !parseImageEnvelope(message.text) && !parseAudioEnvelope(message.text);
  const key = groupMsgKey(message);
  const current = key ? (groupReactionsFor(activeGroupId, key).find((e) => e.reactorAddress === engine.address)?.emoji || null) : null;
  const items = [];
  items.push({ label: "Reply", icon: MSG_MENU_ICONS.reply, onClick: () => startGroupReply(message) });
  if (isText) {
    items.push({ label: "Copy", icon: MSG_MENU_ICONS.copy, onClick: () => copyTextToClipboard(decodeGroupMentions(plain)).then(() => showCopyToast("Copied")).catch(() => {}) });
  }
  if (message.direction === "local" && message.status === MESSAGE_STATUSES.FAILED) {
    items.push({ label: "Retry send", icon: MSG_MENU_ICONS.retry, onClick: () => { deleteGroupMessageLocal(message); sendGroupWire(message.text); } });
  }
  items.push({ label: "Delete for me", icon: MSG_MENU_ICONS.trash, danger: true, onClick: () => deleteGroupMessageLocal(message) });
  const reaction = key ? { current, onPick: (emoji) => sendGroupReaction(activeGroupId, message, emoji) } : null;
  openMsgContextMenu({ x, y, reaction, items });
}

// Remove a group message from THIS device only (other members keep their copy; the on-chain
// tx stays) — matches iOS's local group-message delete.
function deleteGroupMessageLocal(message) {
  if (!activeGroupId) return;
  const key = message.msgIdHex || message.txId || message.id;
  const list = groupMessages(activeGroupId).filter((m) => (m.msgIdHex || m.txId || m.id) !== key);
  saveGroupMessages(activeGroupId, list);
  renderGroupMessages();
  renderGroupList();
}

function renderGroupMessages() {
  if (!activeGroupId || !groupMessageArea) return;
  // Hidden members' messages are filtered out of the view (see the avatar menu). Reaction
  // envelopes are applied as pills at ingest, never shown as bubbles — filter any that reached
  // storage (e.g. via a group-history restore that didn't intercept) so they don't leak as raw JSON.
  const msgs = groupMessages(activeGroupId).filter(
    (m) => !(m.direction === "incoming" && isGroupMemberHidden(activeGroupId, m.senderAddress))
      && !parseReactionEnvelope(m?.text),
  );
  // Same stick-to-bottom rule as 1:1 renderMessages: background re-renders must
  // not yank a reader who scrolled up back to the bottom.
  const isThreadSwitch = groupMessageArea.dataset.renderedGroupId !== String(activeGroupId);
  const wasNearBottom = groupMessageArea.scrollHeight - groupMessageArea.scrollTop - groupMessageArea.clientHeight < 120;
  const previousScrollTop = groupMessageArea.scrollTop;
  groupMessageArea.innerHTML = "";
  if (!msgs.length) {
    if (groupMessageEmpty) {
      groupMessageEmpty.hidden = false;
      groupMessageEmpty.textContent = "No messages yet. Say hello to the group.";
      groupMessageArea.appendChild(groupMessageEmpty);
    }
    return;
  }
  let lastDayKey = "";
  msgs.forEach((message, index) => {
    // Day separator when the calendar day changes.
    const dayKey = new Date(Number(message.createdAt) || Date.now()).toDateString();
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      const sep = document.createElement("div");
      sep.className = "message-day-separator";
      const pill = document.createElement("span");
      pill.textContent = groupDaySeparatorLabel(message.createdAt);
      sep.append(pill);
      groupMessageArea.appendChild(sep);
    }

    // iMessage-style membership line — centered, no bubble/avatar.
    if (message.system) {
      const sysRow = document.createElement("div");
      sysRow.className = "group-system-line";
      sysRow.textContent = message.text || "";
      groupMessageArea.appendChild(sysRow);
      return;
    }

    const incoming = message.direction === "incoming";
    const row = document.createElement("div");
    row.className = `message-row ${incoming ? "incoming" : "local"}`;
    row.dataset.groupMsgKey = groupMsgKey(message);

    const selector = document.createElement("span");
    selector.className = "message-selector";
    selector.setAttribute("aria-hidden", "true");

    const avatarSlot = document.createElement("span");
    avatarSlot.className = "message-avatar-slot";

    const bubble = document.createElement("div");
    bubble.className = `message-bubble ${incoming ? "incoming" : "local"}`;
    // Set when a caption+link message builds a preview card: rendered below the bubble.
    let detachedLinkCard = null;

    // Broadcast-room style card header: sender name + send time at the top.
    {
      const cardHead = document.createElement("div");
      cardHead.className = "message-card-head";
      const cardSender = document.createElement("strong");
      cardSender.textContent = incoming ? groupSenderLabel(message.senderAddress) : "You";
      cardHead.append(cardSender);
      if (message.createdAt) {
        const cardTime = document.createElement("span");
        cardTime.textContent = formatTime(message.createdAt);
        cardHead.append(cardTime);
      }
      bubble.append(cardHead);
    }

    if (incoming) {
      // Sender name now lives in the card header on every message (broadcast-room style),
      // so the old first-in-run sender label is gone.
      const next = msgs[index + 1];
      const lastInRun = !next || next.senderAddress !== message.senderAddress || next.direction !== message.direction;
      if (lastInRun) {
        avatarSlot.innerHTML = memberAvatarHtml(message.senderAddress, "message-avatar");
        avatarSlot.classList.add("group-avatar-clickable");
        avatarSlot.addEventListener("click", (event) => { event.stopPropagation(); openGroupMemberMenu(message.senderAddress, event.clientX, event.clientY); });
      }
    } else {
      avatarSlot.innerHTML = selfAvatarHtml("message-avatar");
      avatarSlot.classList.add("group-avatar-clickable");
      avatarSlot.addEventListener("click", (event) => { event.stopPropagation(); openGroupMemberMenu(engine.address, event.clientX, event.clientY); });
    }

    // Rich content — same envelopes (reply / photo / voice) as 1:1, shared with iOS/Android.
    const imageEnvelope = parseImageEnvelope(message.text);
    const audioEnvelope = imageEnvelope ? null : parseAudioEnvelope(message.text);
    const replyEnvelope = (imageEnvelope || audioEnvelope) ? null : parseReplyEnvelope(message.text);
    if (replyEnvelope) {
      const quote = document.createElement("div");
      quote.className = "message-reply-quote";
      const label = document.createElement("strong");
      label.textContent = "Reply";
      const preview = document.createElement("span");
      preview.textContent = decodeGroupMentions(replyEnvelope.replyToPreview) || "Message";
      quote.append(label, preview);
      quote.addEventListener("click", (event) => { event.stopPropagation(); jumpToGroupMessage(replyEnvelope.replyToId); });
      bubble.append(quote);
    }

    if (imageEnvelope) {
      // Photo-only bubble: no chat-bubble background, just the image (timestamp overlays it).
      bubble.classList.add("photo-bubble");
      const img = document.createElement("img");
      img.className = "message-photo";
      img.src = imageEnvelope.content;
      img.alt = imageEnvelope.name || "Photo";
      img.addEventListener("click", () => openPhotoPreview(imageEnvelope.content));
      bubble.append(img);
    } else if (audioEnvelope) {
      const audioWrap = document.createElement("div");
      audioWrap.className = "message-audio-bubble";
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "metadata";
      player.src = audioEnvelope.content;
      player.addEventListener("click", (event) => event.stopPropagation());
      audioWrap.append(player);
      bubble.append(audioWrap);
    } else {
      const text = document.createElement("span");
      text.className = "message-text";
      const bodyText = replyEnvelope ? replyEnvelope.text : message.text;
      const linkUrls = renderTextWithMentions(text, bodyText);
      const previewable = (linkUrls || []).find(isPreviewableUrl);
      const card = previewable ? buildLinkPreviewCard(previewable) : null;
      const linkOnly = card && !replyEnvelope && linkUrls.length === 1 && String(bodyText).trim() === linkUrls[0];
      if (linkOnly) {
        bubble.classList.add("link-card-bubble");
        bubble.appendChild(card);
      } else {
        bubble.appendChild(text);
        // iOS parity: with a caption the card is its OWN block BELOW the bubble.
        if (card) detachedLinkCard = card;
      }
    }

    if (message.createdAt) {
      const timeEl = document.createElement("span");
      timeEl.className = "message-time";
      timeEl.textContent = formatTime(message.createdAt);
      bubble.append(timeEl);
    }


    // Reactions and message actions live on the right-click menu now (Telegram-style),
    // wired below via the bubble's "contextmenu" handler.
    const key = groupMsgKey(message);

    // Reaction pills (counts).
    const reactions = groupReactionsFor(activeGroupId, key);
    if (reactions.length) {
      const pill = document.createElement("div");
      pill.className = "message-reaction-pill";
      const counts = new Map();
      for (const entry of reactions) counts.set(entry.emoji, (counts.get(entry.emoji) || 0) + 1);
      for (const [emoji, count] of counts) {
        const entryEl = document.createElement("span");
        entryEl.className = "message-reaction-pill-entry";
        entryEl.textContent = emoji;
        if (count > 1) {
          const countEl = document.createElement("span");
          countEl.className = "message-reaction-pill-count";
          countEl.textContent = String(count);
          entryEl.append(countEl);
        }
        // Delivery indicator on YOUR just-sent reaction: ✓ once on-chain, red ! to retry.
        const statusEl = reactionStatusIndicator(`grp|${key}|${emoji}`);
        if (statusEl) entryEl.append(statusEl);
        pill.append(entryEl);
      }
      pill.addEventListener("click", (event) => event.stopPropagation());
      bubble.append(pill);
    }

    bubble.addEventListener("contextmenu", (event) => { event.preventDefault(); openGroupMessageMenu(message, event.clientX, event.clientY); });

    if (detachedLinkCard) {
      const stack = document.createElement("div");
      stack.className = "message-bubble-stack";
      stack.append(bubble, detachedLinkCard);
      row.append(selector, avatarSlot, stack);
    } else {
      row.append(selector, avatarSlot, bubble);
    }
    // Delivery status (checkmark / pending / failed) on your own messages — same as 1:1.
    // Group messages use direction "local", so shim it to "outgoing" for the shared icon.
    if (!incoming && message.status) {
      const icon = createDeliveryStatusIcon({ ...message, direction: "outgoing" });
      if (icon) row.append(icon);
      if (message.status === MESSAGE_STATUSES.FAILED) {
        const retryLink = document.createElement("button");
        retryLink.type = "button";
        retryLink.className = "message-retry-link";
        retryLink.textContent = "Not Delivered · Retry";
        retryLink.addEventListener("click", (event) => { event.stopPropagation(); retryGroupMessage(message); });
        row.append(retryLink);
      }
    }
    groupMessageArea.appendChild(row);
  });
  groupMessageArea.dataset.renderedGroupId = String(activeGroupId);
  const lastGroupMessage = msgs[msgs.length - 1];
  // Same rule as 1:1 (see renderMessages): only this device's own optimistic send returns
  // the viewport to the bottom, never an own message mirrored in from another device.
  const justSentOwn = Boolean(lastGroupMessage)
    && lastGroupMessage.direction !== "incoming"
    && lastGroupMessage.status !== MESSAGE_STATUSES.CONFIRMED
    && !String(lastGroupMessage.txid || "").trim();
  if (isThreadSwitch || wasNearBottom || justSentOwn) {
    groupMessageArea.scrollTop = groupMessageArea.scrollHeight;
  } else {
    groupMessageArea.scrollTop = previousScrollTop;
  }
}

// --- create / add-member modal ---
/// Everyone you could add in one click: your existing chats plus both directions of your KaPosts
/// follow graph - the same set Create Chat offers, and the same set iOS builds here.
///
/// Returns plain {address, name} rows rather than contacts, since most of the follow graph has no
/// contact record to hand: a name is resolved once here instead of per comparison in the sort,
/// which is what made this list crawl on iOS before it was cached the same way.
/// Matches iOS's AddContactView.maxGroupMembers.
const MAX_GROUP_MEMBERS = 50;

/// The photo chosen while creating a group, as hex, plus a data URL for the preview.
///
/// Nothing is sent from here - the group does not exist yet, so it is held until createGroup()
/// returns an id to attach it to. Same ~10KB JPEG budget as the Group Info photo flow, because it
/// rides on-chain to every member either way.
let groupCreatePhotoHex = null;
let groupCreatePhotoUrl = null;

function renderGroupCreatePhoto() {
  const image = document.querySelector("[data-group-create-photo-image]");
  const placeholder = document.querySelector("[data-group-create-photo-placeholder]");
  const clear = document.querySelector("[data-group-create-photo-clear]");
  if (image) {
    image.hidden = !groupCreatePhotoUrl;
    if (groupCreatePhotoUrl) image.src = groupCreatePhotoUrl;
    else image.removeAttribute("src");
  }
  if (placeholder) placeholder.hidden = Boolean(groupCreatePhotoUrl);
  if (clear) clear.hidden = !groupCreatePhotoUrl;
}

function clearGroupCreatePhoto() {
  groupCreatePhotoHex = null;
  groupCreatePhotoUrl = null;
  renderGroupCreatePhoto();
}

async function pickGroupCreatePhoto() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImageBlob(file, { targetBytes: 10 * 1024, maxDimension: 256 });
      groupCreatePhotoHex = groupPhotoHexFromDataUrl(compressed.dataUrl);
      groupCreatePhotoUrl = compressed.dataUrl;
      renderGroupCreatePhoto();
    } catch (error) {
      setStatus(`Could not read that image: ${error.message}`);
    }
  });
  input.click();
}

function eligibleGroupContacts(excludeAddresses = []) {
  const exclude = new Set([engine.address, ...excludeAddresses].filter(Boolean));
  const addresses = new Set();
  for (const contact of state.contacts || []) {
    if (contact.address && !exclude.has(contact.address)) addresses.add(contact.address);
  }
  for (const row of createChatPickerRows) {
    if (row.address && !exclude.has(row.address)) addresses.add(row.address);
  }
  return [...addresses]
    .map((address) => {
      const contact = (state.contacts || []).find((entry) => entry.address === address);
      return {
        address,
        contact,
        name: contact ? displayNameForAddress(contact)
          : (engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || shortAddress(address)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
function renderGroupMemberPicker(excludeAddresses = []) {
  if (!groupMemberPicker) return;
  const all = eligibleGroupContacts(excludeAddresses);
  if (!all.length) {
    groupMemberPicker.innerHTML = `<p class="group-picker-empty">No contacts to add yet. Start a 1:1 chat with someone first, then you can add them to a group.</p>`;
    return;
  }
  // Filter by the search box (name, nickname, or address). Selection persists across
  // filtering because it is tracked by address in groupCreateSelected, not by the DOM.
  const query = String(groupMemberSearch?.value || "").trim().toLowerCase();
  const rows = query
    ? all.filter((row) => row.name.toLowerCase().includes(query) || row.address.toLowerCase().includes(query))
    : all;
  if (!rows.length) {
    groupMemberPicker.innerHTML = `<p class="group-picker-empty">No matches.</p>`;
    return;
  }
  groupMemberPicker.innerHTML = rows.map((row) => {
    const selected = groupCreateSelected.has(row.address);
    const avatar = row.contact
      ? avatarHtmlFor(row.contact, "chat-avatar")
      : groupPickerAvatarHtml(row.address, row.name);
    return `
      <button type="button" class="group-member-option${selected ? " selected" : ""}" data-group-member-toggle="${escapeHtml(row.address)}">
        ${avatar}
        <span class="group-member-option-meta">
          <strong>${escapeHtml(row.name)}</strong>
          <span>${escapeHtml(shortAddress(row.address))}</span>
        </span>
        <span class="group-member-check"><svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg></span>
      </button>`;
  }).join("");
}

/// Avatar for someone with no contact record - straight off their KNS profile, initials otherwise.
function groupPickerAvatarHtml(address, name) {
  const avatarUrl = engine.peekKnsAddressProfile?.(address)?.profile?.avatarUrl;
  if (avatarUrl) return `<span class="chat-avatar"><img src="${escapeHtml(avatarUrl)}" alt="" /></span>`;
  return `<span class="chat-avatar">${escapeHtml(initialsFor(name))}</span>`;
}
function updateGroupCreateSubmit() {
  if (!groupCreateSubmit) return;
  if (groupModalMode === "add") {
    groupCreateSubmit.disabled = groupCreateSelected.size < 1;
  } else {
    const name = String(groupNameInput?.value || "").trim();
    groupCreateSubmit.disabled = !(name && groupCreateSelected.size >= 1);
  }
  // "Members (X)" is the collapsible section header — reflects how many are added.
  const membersTitle = document.querySelector("[data-group-members-title]");
  if (membersTitle) membersTitle.textContent = groupCreateSelected.size ? `Members (${groupCreateSelected.size})` : "Members";
  renderGroupSelectedMembers();
}

// Sets a collapsible New Group section open/closed (body visibility + chevron + aria).
function setGroupSection(toggle, body, open) {
  if (body) body.hidden = !open;
  if (toggle) {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.classList.toggle("open", open);
  }
}

// Renders the "Members (N)" dropdown: everyone added so far (contacts + by-address), each
// with a remove control.
function renderGroupSelectedMembers() {
  if (!groupMembersList) return;
  const addrs = [...groupCreateSelected];
  if (!addrs.length) {
    groupMembersList.innerHTML = `<p class="group-picker-empty">No members added yet. Open Contacts below to add people.</p>`;
    return;
  }
  groupMembersList.innerHTML = addrs.map((addr) => {
    const contact = (state.contacts || []).find((c) => c.address === addr);
    // Someone added from the follow graph or by domain has no contact record, but usually does
    // have a KNS name and avatar - falling straight to the short address dropped both.
    const name = contact
      ? displayNameForAddress(contact)
      : (engine.peekKnsAddressInfo?.(addr)?.explicitPrimaryDomain || shortAddress(addr));
    const avatar = contact
      ? avatarHtmlFor(contact, "chat-avatar")
      : groupPickerAvatarHtml(addr, name);
    return `
      <div class="group-member-added">
        ${avatar}
        <span class="group-member-option-meta">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(shortAddress(addr))}</span>
        </span>
        <button type="button" class="group-member-remove" data-group-member-remove="${escapeHtml(addr)}" aria-label="Remove">&times;</button>
      </div>`;
  }).join("");
}
function openGroupCreate() {
  if (!getGroupManager()) { setStatus("Load a wallet before creating a group."); return; }
  groupModalMode = "create";
  groupModalTargetId = null;
  groupCreateSelected.clear();
  if (groupCreateTitle) groupCreateTitle.textContent = "New Group";
  if (groupCreateSubmit) groupCreateSubmit.textContent = "Create Group";
  if (groupNameInput) { groupNameInput.value = ""; groupNameInput.hidden = false; }
  const identityRow = document.querySelector("[data-group-identity-row]");
  if (identityRow) identityRow.hidden = false;
  if (groupPickerHint) groupPickerHint.textContent = "Add contacts to the group. You control the membership as the group admin.";
  if (groupCreateError) groupCreateError.hidden = true;
  if (groupMemberSearch) groupMemberSearch.value = "";
  groupPickerExclude = [];
  clearGroupCreatePhoto();
  resetGroupAddressSection();
  renderGroupMemberPicker();
  updateGroupCreateSubmit();
  // The picker offers the follow graph as well as contacts; this fills it and repaints when the
  // indexer answers. Guarded internally, so sharing it with Create Chat costs nothing.
  loadCreateChatPicker().then(() => {
    if (!groupCreateModal || groupCreateModal.hidden) return;
    renderGroupMemberPicker(groupPickerExclude);
  });
  // Both sections start collapsed: Members opens to review who's added; Contacts opens to
  // search and pick people.
  setGroupSection(groupMembersToggle, groupMembersBody, false);
  setGroupSection(groupContactsToggle, groupContactsBody, false);
  if (groupCreateModal) groupCreateModal.hidden = false;
  window.setTimeout(() => groupNameInput?.focus(), 0);
}
function openGroupAddMember(groupId) {
  const mgr = getGroupManager();
  const g = mgr && mgr.getGroup(groupId);
  if (!g) return;
  groupModalMode = "add";
  groupModalTargetId = groupId;
  groupCreateSelected.clear();
  if (groupCreateTitle) groupCreateTitle.textContent = "Add Member";
  if (groupCreateSubmit) groupCreateSubmit.textContent = "Add";
  if (groupNameInput) { groupNameInput.value = ""; groupNameInput.hidden = true; }
  const identityRow = document.querySelector("[data-group-identity-row]");
  if (identityRow) identityRow.hidden = true;
  if (groupPickerHint) groupPickerHint.textContent = "Adding a member issues a fresh group key to everyone.";
  if (groupCreateError) groupCreateError.hidden = true;
  if (groupMemberSearch) groupMemberSearch.value = "";
  groupPickerExclude = g.members.map((m) => m.address);
  clearGroupCreatePhoto();
  resetGroupAddressSection();
  renderGroupMemberPicker(groupPickerExclude);
  updateGroupCreateSubmit();
  loadCreateChatPicker().then(() => {
    if (!groupCreateModal || groupCreateModal.hidden) return;
    renderGroupMemberPicker(groupPickerExclude);
  });
  // In add-member mode, open Contacts straight away since picking people is the whole task.
  setGroupSection(groupMembersToggle, groupMembersBody, false);
  setGroupSection(groupContactsToggle, groupContactsBody, true);
  if (groupCreateModal) groupCreateModal.hidden = false;
}
function closeGroupCreate() { if (groupCreateModal) groupCreateModal.hidden = true; }

// --- "Add by address" section: add someone who is not in your contacts at all ---

function setGroupAddressStatus(html) {
  if (!groupAddressStatus) return;
  groupAddressStatus.innerHTML = html || "";
  groupAddressStatus.hidden = !html;
}

/// The same "who am I about to add" card the 1:1 sheet shows, for the group's address field.
///
/// A raw address tells you nothing about whether you typed the right one; a face and a domain do.
/// Only rendered for an address the app is confident about, so it never flickers through wrong
/// faces mid-type.
let groupAddressPreviewToken = 0;
function renderGroupAddressPreview() {
  const card = document.querySelector("[data-group-address-preview]");
  if (!card) return;
  const address = groupAddressResolved || "";
  if (!address) { card.hidden = true; card.innerHTML = ""; return; }

  const profile = engine.peekKnsAddressProfile?.(address);
  const info = engine.peekKnsAddressInfo?.(address);
  const domain = info?.explicitPrimaryDomain || profile?.domainName || null;
  const avatarUrl = profile?.profile?.avatarUrl || "";
  const looking = !profile && !info;

  card.hidden = false;
  card.innerHTML = `
    <span class="create-chat-preview-avatar">${avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" />`
      : escapeHtml(initialsFor(domain || address))}</span>
    <span class="create-chat-preview-copy">
      <span class="create-chat-preview-name${domain ? "" : " muted"}">${escapeHtml(domain || (looking ? "Looking up…" : "No KNS domain"))}</span>
      <span class="create-chat-preview-address">${escapeHtml(address)}</span>
    </span>`;

  if (looking) {
    const token = ++groupAddressPreviewToken;
    Promise.allSettled([
      engine.getKnsAddressProfile?.(address),
      engine.getKnsAddressInfo?.(address),
    ]).then(() => {
      if (token !== groupAddressPreviewToken) return;
      if (groupAddressResolved !== address) return;
      renderGroupAddressPreview();
    });
  }
}

function resetGroupAddressSection() {
  groupAddressResolved = null;
  groupAddressResolveToken++;
  if (groupAddressInput) groupAddressInput.value = "";
  setGroupAddressStatus("");
  renderGroupAddressPreview();
  if (groupAddressAddButton) groupAddressAddButton.disabled = true;
  renderGroupSelectedMembers();
}

/// Says so while you are still typing, rather than waiting for the Add click to refuse. iOS shows
/// exactly these three, in this order.
function groupAddressDuplicateWarning(address) {
  if (address === engine.address) return "That is your own address";
  if (groupPickerExclude.includes(address)) return "Already in this group";
  if (groupCreateSelected.has(address)) return "Already added to this group";
  return null;
}

// Live validity feedback for the group address field (raw address or KNS domain),
// mirroring the 1:1 create-chat resolver. Sets groupAddressResolved to the address
// that "Add to Group" will use.
function updateGroupAddressState() {
  if (!groupAddressInput) return;
  const raw = String(groupAddressInput.value || "").trim();
  const token = ++groupAddressResolveToken;
  groupAddressResolved = null;
  if (groupAddressAddButton) groupAddressAddButton.disabled = true;

  if (!raw) { setGroupAddressStatus(""); renderGroupAddressPreview(); return; }

  if (raw.startsWith("kaspa:") || raw.startsWith("kaspatest:")) {
    let valid = false;
    try { validateContactAddress(raw); valid = true; } catch { valid = false; }
    if (valid) {
      groupAddressResolved = raw;
      const dupe = groupAddressDuplicateWarning(raw);
      setGroupAddressStatus(dupe
        ? `<span class="create-chat-status-bad">✕ ${escapeHtml(dupe)}</span>`
        : '<span class="create-chat-status-good">✓ Valid address</span>');
      if (groupAddressAddButton) groupAddressAddButton.disabled = Boolean(dupe);
    } else {
      setGroupAddressStatus('<span class="create-chat-status-bad">✕ Invalid address format</span>');
    }
    renderGroupAddressPreview();
    return;
  }

  if (engine.knsLooksLikeDomain(raw)) {
    setGroupAddressStatus('<span class="create-chat-status-muted">Resolving KNS domain…</span>');
    window.setTimeout(async () => {
      if (token !== groupAddressResolveToken) return;
      try {
        const resolution = await engine.resolveKnsDomain(raw);
        if (token !== groupAddressResolveToken) return;
        if (resolution?.ownerAddress) {
          groupAddressResolved = resolution.ownerAddress;
          const dupe = groupAddressDuplicateWarning(resolution.ownerAddress);
          setGroupAddressStatus(dupe
            ? `<span class="create-chat-status-bad">✕ ${escapeHtml(dupe)}</span><span class="create-chat-status-mono">${escapeHtml(resolution.ownerAddress)}</span>`
            : `<span class="create-chat-status-good">✓ Resolved: ${escapeHtml(resolution.domain || raw)}</span><span class="create-chat-status-mono">${escapeHtml(resolution.ownerAddress)}</span>`);
          if (groupAddressAddButton) groupAddressAddButton.disabled = Boolean(dupe);
        } else {
          setGroupAddressStatus('<span class="create-chat-status-bad">✕ KNS domain not found</span>');
        }
        renderGroupAddressPreview();
      } catch {
        if (token !== groupAddressResolveToken) return;
        setGroupAddressStatus('<span class="create-chat-status-bad">✕ KNS domain not found</span>');
      }
    }, 300);
    return;
  }

  setGroupAddressStatus('<span class="create-chat-status-bad">✕ Invalid address format</span>');
  renderGroupAddressPreview();
}

function addResolvedGroupAddress() {
  const addr = groupAddressResolved;
  if (!addr) return;
  if (addr === engine.address) { setGroupAddressStatus('<span class="create-chat-status-bad">✕ That is your own address</span>'); return; }
  if (groupPickerExclude.includes(addr)) { setGroupAddressStatus('<span class="create-chat-status-muted">Already in this group</span>'); return; }
  if (groupCreateSelected.has(addr)) { setGroupAddressStatus('<span class="create-chat-status-muted">Already added</span>'); return; }
  if (groupCreateSelected.size >= MAX_GROUP_MEMBERS) { setGroupAddressStatus(`<span class="create-chat-status-bad">✕ A group can have at most ${MAX_GROUP_MEMBERS} members</span>`); return; }
  groupCreateSelected.add(addr);
  resetGroupAddressSection();
  renderGroupMemberPicker(groupPickerExclude);
  updateGroupCreateSubmit();
  // Reveal the Members list so the just-added person is visible.
  setGroupSection(groupMembersToggle, groupMembersBody, true);
}

// --- manage / group info ---
function openGroupManage(groupId) {
  const mgr = getGroupManager();
  const g = mgr && mgr.getGroup(groupId);
  if (!g || !groupManageBody) return;
  const isAdmin = Boolean(g.isAdmin);
  const memberRows = g.members.map((m) => {
    const canRemove = isAdmin && m.address !== g.adminAddress;
    return `
      <div class="group-member-line">
        ${memberAvatarHtml(m.address, "chat-avatar")}
        <span class="group-member-line-meta">
          <strong>${escapeHtml(groupSenderLabel(m.address))}</strong>
          <span>${escapeHtml(shortAddress(m.address))}</span>
        </span>
        ${m.isAdmin ? `<span class="group-member-admin-badge">Admin</span>` : ``}
        ${isAdmin && !m.isAdmin ? `<button type="button" class="group-member-resend-btn" data-group-resend-member="${escapeHtml(m.address)}" title="Resend invite to this member" aria-label="Resend invite"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg></button>` : ``}
        ${canRemove ? `<button type="button" class="group-member-remove-btn" data-group-remove-member="${escapeHtml(m.address)}" title="Remove from group" aria-label="Remove from group"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>` : ``}
      </div>`;
  }).join("");
  // Hidden members: whose messages are filtered from your view, with an Unhide control. Shown as
  // its own always-present "Hidden Users" dropdown (matching iOS), empty state included.
  const hiddenAddrs = groupHiddenMembersFor(groupId);
  const hiddenRows = hiddenAddrs.length
    ? hiddenAddrs.map((addr) => `
        <div class="group-member-line">
          ${memberAvatarHtml(addr, "chat-avatar")}
          <span class="group-member-line-meta">
            <strong>${escapeHtml(groupSenderLabel(addr))}</strong>
            <span>${escapeHtml(shortAddress(addr))}</span>
          </span>
          <button type="button" class="group-member-remove" data-group-unhide-member="${escapeHtml(addr)}">Unhide</button>
        </div>`).join("")
    : `<p class="group-manage-empty">No hidden users in this group.</p>`;
  const icEye = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.16 3.19M6.6 6.6A18 18 0 0 0 2 12s3 8 10 8a9 9 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/></svg>`;
  const icPencil = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
  const icResend = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>`;
  const icAdd = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c.6-3.3 2.7-5 5.5-5s4.9 1.7 5.5 5"/><path d="M18 8v6M15 11h6"/></svg>`;
  const icBell = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg>`;
  // Per-group notification mode (iOS Group Info > "Only Notify if I'm Mentioned", widened to the
  // same three choices the 1:1 Chat Info offers plus mentions). Sits on the group's info screen,
  // where the 1:1 notification toggle lives for a contact.
  const notifyMode = getGroupNotify(groupId);
  const notifyRows = [
    ["all", "All messages"],
    ["mentions", "Only when I'm mentioned"],
    ["muted", "Mute this group"],
  ].map(([value, label]) => `
      <button type="button" class="group-manage-row" data-group-notify-mode="${value}" aria-pressed="${notifyMode === value ? "true" : "false"}">
        <span class="group-manage-row-icon">${notifyMode === value ? "✓" : "&nbsp;"}</span> ${escapeHtml(label)}
      </button>`).join("");
  groupManageBody.innerHTML = `
    <div class="group-manage-section group-photo-section">
      <div class="group-photo-avatar${isAdmin ? " editable" : ""}"${isAdmin ? " data-group-photo-edit" : ""}${isAdmin ? ` title="Change group photo"` : ""}>
        ${groupAvatarHtml(g.photoHex)}
        ${isAdmin ? `<span class="group-photo-edit-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span>` : ``}
      </div>
      <p class="group-photo-name">${escapeHtml(g.name || "Group")}</p>
      <p class="group-photo-count">${g.members.length} member${g.members.length === 1 ? "" : "s"}</p>
      ${isAdmin && g.photoHex ? `<button type="button" class="group-manage-remove-photo" data-group-photo-remove>Remove photo</button>` : ``}
    </div>
    <div class="group-manage-section">
      <details class="group-members-details">
        <summary class="group-manage-section-title group-members-summary">Members (${g.members.length})</summary>
        ${memberRows}
      </details>
    </div>
    <div class="group-manage-section">
      <details class="group-members-details">
        <summary class="group-manage-section-title group-members-summary"><span class="group-manage-row-icon">${icEye}</span> Hidden Users</summary>
        ${hiddenRows}
      </details>
    </div>
    <div class="group-manage-section">
      <details class="group-members-details">
        <summary class="group-manage-section-title group-members-summary"><span class="group-manage-row-icon">${icBell}</span> Notifications</summary>
        ${notifyRows}
        <p class="group-manage-footer">Only when I'm mentioned: you are notified about messages that @mention you and replies to your own messages. Everything else arrives in the chat silently. Mute this group: no notifications at all. Unread counts still update either way.</p>
      </details>
    </div>
    ${isAdmin ? `
    <div class="group-manage-section">
      <button type="button" class="group-manage-row" data-group-rename><span class="group-manage-row-icon">${icPencil}</span> Rename Group</button>
      <button type="button" class="group-manage-row" data-group-resend-invites><span class="group-manage-row-icon">${icResend}</span> Resend invites to all</button>
      <button type="button" class="group-manage-row" data-group-add-member><span class="group-manage-row-icon">${icAdd}</span> Add Members</button>
      <p class="group-manage-footer">Resends the group invite to every member (or use a member's ↻ to resend just theirs) — use this if someone didn't receive the group. Adding members rotates the group key, so new members see messages from when they join onward.</p>
    </div>` : ``}
    <div class="group-manage-section">
      ${isAdmin
        ? `<button type="button" class="group-manage-danger" data-group-delete>Delete Group</button>`
        : `<button type="button" class="group-manage-danger" data-group-leave>Leave Group</button>`}
    </div>`;
  if (groupManageScreen) groupManageScreen.hidden = false;
}
function closeGroupManage() { if (groupManageScreen) groupManageScreen.hidden = true; }

// --- background sync: pull invites + new messages into the store ---
async function syncGroupsNow({ catchUp = false } = {}) {
  const mgr = getGroupManager();
  if (!mgr || !engine.isKasiaCipherLoaded?.()) return 0;
  let result;
  try { result = await mgr.syncGroups(); } catch { return 0; }
  let changed = 0;
  for (const decoded of result.messages || []) {
    // Reactions are group messages carrying a {type:"reaction"} envelope — apply them to the
    // reactions store and never render them as their own bubble (mirrors the 1:1 path).
    const reaction = parseReactionEnvelope(decoded.plaintext);
    if (reaction) {
      applyGroupReaction(decoded.groupId, reaction.targetTxId, decoded.senderAddress, reaction.emoji, reaction.action);
      if (decoded.groupId === activeGroupId) changed++;
      continue;
    }
    const direction = decoded.senderAddress === engine.address ? "local" : "incoming";
    const bt = Number(decoded.blockTime || 0);
    const createdAt = bt > 1e12 ? bt : (bt > 0 ? bt * 1000 : Date.now());
    const added = appendGroupMessage(decoded.groupId, {
      id: nowId(),
      senderAddress: decoded.senderAddress,
      direction,
      text: decoded.plaintext,
      createdAt,
      txId: decoded.txId || null,
      msgIdHex: decoded.msgIdHex || null,
      senderIsAdmin: Boolean(decoded.senderIsAdmin),
    });
    if (added) {
      changed++;
      if (direction === "incoming") {
        // The first sweep after a load/switch/restore backfills history from the indexer, so it
        // is not new mail: it adds silently, exactly like the 1:1 path (pendingInitialCatchUp)
        // and like iOS's backfill floor for groups. Without this, an "all messages" group would
        // fire a banner for every historical message on the first sync.
        if (!catchUp) {
          maybeNotifyGroupIncoming(decoded.groupId, decoded.senderAddress, decoded.plaintext, decoded.txId || decoded.msgIdHex || nowId(), createdAt);
        }
        if (decoded.groupId !== activeGroupId) {
          setGroupUnread(decoded.groupId, groupUnreadFor(decoded.groupId) + 1);
        }
      }
    }
  }
  // iMessage-style membership lines for members who received a key rotation: the engine reports
  // which addresses were added/removed on each root update (see _applyRoot). The acting admin
  // emits its own lines directly in the add/remove handlers, so those dedupe via the stable key.
  for (const ev of result.controls || []) {
    if (!ev || !ev.groupId) continue;
    // A group photo the admin changed — system line + refresh the open header/list.
    if (ev.kind === "photo-updated") {
      if (ev.changed) {
        const who = groupSenderLabel(ev.adminAddress);
        appendGroupSystemMessage(ev.groupId, ev.cleared ? `${who} removed the group photo` : `${who} changed the group photo`, Date.now(), `sys:${ev.groupId}:photo:${ev.photoKey || (ev.cleared ? "cleared" : "set")}`);
      }
      if (ev.groupId === activeGroupId) { try { openGroupChat(activeGroupId); } catch {} }
      if (groupManageScreen && !groupManageScreen.hidden && activeGroupId === ev.groupId) { try { openGroupManage(activeGroupId); } catch {} }
      continue;
    }
    // A rename (admin changed the group name) — system line for members.
    if (ev.renamedTo) {
      appendGroupSystemMessage(ev.groupId, `${groupSenderLabel(ev.adminAddress)} changed the group name to "${ev.renamedTo}"`, Date.now(), `sys:${ev.groupId}:name:${ev.epoch}:${ev.renamedTo}`);
    }
    for (const addr of ev.added || []) {
      if (addr === engine.address) continue;
      appendGroupSystemMessage(ev.groupId, `${groupSenderLabel(addr)} was added to the group chat`, Date.now(), `sys:${ev.groupId}:${ev.epoch}:add:${addr}`);
    }
    for (const addr of ev.removed || []) {
      appendGroupSystemMessage(ev.groupId, `${groupSenderLabel(addr)} was removed from the group chat`, Date.now(), `sys:${ev.groupId}:${ev.epoch}:rem:${addr}`);
    }
  }
  if ((result.controls || []).length) changed++;
  if (changed) {
    if (activeGroupId) renderGroupMessages();
    renderGroupList();
  }
  return changed;
}

// --- events ---
document.querySelectorAll("[data-new-group]").forEach((btn) => btn.addEventListener("click", openGroupCreate));
document.querySelectorAll("[data-close-group-create]").forEach((button) => {
  button.addEventListener("click", closeGroupCreate);
});
groupCreateModal?.addEventListener("click", (event) => { if (event.target === groupCreateModal) closeGroupCreate(); });
groupNameInput?.addEventListener("input", updateGroupCreateSubmit);
// Live-filter the member list as the user types (uses the current exclude set).
groupMemberSearch?.addEventListener("input", () => renderGroupMemberPicker(groupPickerExclude));

// "Add by address" section: resolve + add a member who is not in your contacts.
groupAddressInput?.addEventListener("input", updateGroupAddressState);
groupAddressInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); addResolvedGroupAddress(); }
});
groupAddressAddButton?.addEventListener("click", addResolvedGroupAddress);
document.querySelector("[data-group-create-photo]")?.addEventListener("click", pickGroupCreatePhoto);
document.querySelector("[data-group-create-photo-clear]")?.addEventListener("click", clearGroupCreatePhoto);
groupAddressPasteButton?.addEventListener("click", async () => {
  try {
    if (!navigator.clipboard?.readText) return;
    const pasted = String(await navigator.clipboard.readText() || "").trim();
    if (!pasted || !groupAddressInput) return;
    groupAddressInput.value = pasted;
    updateGroupAddressState();
    groupAddressInput.focus();
  } catch { /* clipboard denied/empty: leave the field unchanged */ }
});
groupAddressImportButton?.addEventListener("click", async () => {
  try {
    if (navigator.contacts?.select) {
      const selected = await navigator.contacts.select(["name", "address", "email", "tel"], { multiple: false });
      const entry = selected?.[0];
      if (!entry) return;
      const addressMatch = JSON.stringify(entry).match(/kaspa:[a-z0-9]+/i);
      if (!addressMatch) { setGroupAddressStatus('<span class="create-chat-status-bad">✕ No Kaspa address in that contact</span>'); return; }
      if (groupAddressInput) { groupAddressInput.value = addressMatch[0]; updateGroupAddressState(); }
      return;
    }
    groupAddressImportFile?.click();
  } catch (error) {
    setGroupAddressStatus(`<span class="create-chat-status-bad">✕ ${escapeHtml(error?.message || "Import unavailable")}</span>`);
  }
});
groupAddressImportFile?.addEventListener("change", async () => {
  const file = groupAddressImportFile.files?.[0];
  groupAddressImportFile.value = "";
  if (!file) return;
  try {
    const addressMatch = (await file.text()).match(/kaspa:[a-z0-9]+/i);
    if (!addressMatch) { setGroupAddressStatus('<span class="create-chat-status-bad">✕ No Kaspa address in that file</span>'); return; }
    if (groupAddressInput) { groupAddressInput.value = addressMatch[0]; updateGroupAddressState(); }
  } catch (error) {
    setGroupAddressStatus(`<span class="create-chat-status-bad">✕ ${escapeHtml(error?.message || "Could not read that file")}</span>`);
  }
});
groupAddressScanButton?.addEventListener("click", async () => {
  const scanned = await scanKaspaAddress({
    title: "Scan a member's code",
    hint: "Point the camera at the address QR code of the person you want to add.",
  });
  if (!scanned || !groupAddressInput) return;
  groupAddressInput.value = scanned;
  groupAddressInput.dispatchEvent(new Event("input", { bubbles: true }));
  groupAddressInput.focus();
});
// Collapsible section toggles.
groupMembersToggle?.addEventListener("click", () => {
  setGroupSection(groupMembersToggle, groupMembersBody, groupMembersBody?.hidden);
});
groupContactsToggle?.addEventListener("click", () => {
  setGroupSection(groupContactsToggle, groupContactsBody, groupContactsBody?.hidden);
});
// Remove a member from the "Members (N)" dropdown.
groupMembersList?.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-group-member-remove]");
  if (!removeButton) return;
  const addr = removeButton.dataset.groupMemberRemove;
  groupCreateSelected.delete(addr);
  updateGroupCreateSubmit();
  // Keep the contact picker's checkmarks in sync if that section is open.
  renderGroupMemberPicker(groupPickerExclude);
});

// The create button is tab-aware: Group Chats tab opens the group builder, the Chats
// tab opens the 1:1 create screen. There are two instances (the floating one for the
// empty state, and the inline one next to the composer Send button), so wire both.
document.querySelectorAll("[data-new-chat-fab]").forEach((button) => {
  button.addEventListener("click", () => {
    if (activeChatsListTab === "groups") openGroupCreate();
    else showContactModal();
  });
});
groupMemberPicker?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-group-member-toggle]");
  if (!btn) return;
  const address = btn.dataset.groupMemberToggle;
  if (groupCreateSelected.has(address)) {
    groupCreateSelected.delete(address);
  } else if (groupCreateSelected.size >= MAX_GROUP_MEMBERS) {
    // The by-address field enforced this and the checklist did not, so the cap could be walked
    // straight past by clicking rows.
    setGroupAddressStatus(`<span class="create-chat-status-bad">✕ A group can have at most ${MAX_GROUP_MEMBERS} members</span>`);
    return;
  } else {
    groupCreateSelected.add(address);
  }
  btn.classList.toggle("selected", groupCreateSelected.has(address));
  updateGroupCreateSubmit();
});
groupCreateSubmit?.addEventListener("click", async () => {
  const mgr = getGroupManager();
  if (!mgr) { setStatus("Load a wallet first."); return; }
  const members = [...groupCreateSelected];
  if (!members.length) return;
  groupCreateSubmit.disabled = true;
  if (groupCreateError) groupCreateError.hidden = true;
  try {
    if (groupModalMode === "add" && groupModalTargetId) {
      // Each added member triggers a full key rotation (epoch + root to everyone), so the cost
      // grows with how many you add — show the estimated total before committing.
      const rec = mgr.getGroup(groupModalTargetId);
      const finalOthers = groupOtherMemberCount(rec) + members.length;
      const hasPhoto = Boolean(rec?.photoHex);
      if (!await confirmText(`Add ${members.length} member${members.length === 1 ? "" : "s"} to the group?${await groupOpFeeHint(groupModalTargetId, { controlTx: members.length * (2 * finalOthers + 1), photoTx: hasPhoto ? members.length * finalOthers : 0 })}`)) { updateGroupCreateSubmit(); return; }
      setStatus("Adding member(s) to the group…");
      for (const address of members) {
        await mgr.addMember(groupModalTargetId, address);
        // iMessage-style membership line for the admin (other members get theirs on the rotation).
        const epAdd = mgr.getGroup(groupModalTargetId)?.currentEpoch;
        appendGroupSystemMessage(groupModalTargetId, `${groupSenderLabel(address)} was added to the group chat`, Date.now(), `sys:${groupModalTargetId}:${epAdd}:add:${address}`);
      }
      closeGroupCreate();
      if (activeGroupId === groupModalTargetId) { openGroupChat(groupModalTargetId); openGroupManage(groupModalTargetId); }
      renderGroupList();
      setStatus("Group updated");
    } else {
      const name = String(groupNameInput?.value || "").trim();
      if (!name) { updateGroupCreateSubmit(); return; }
      // Estimate the create cost (one invite per member + a self-recovery copy) before committing.
      {
        // One invite per member, a self-recovery copy, and - if a photo was chosen - one photo
        // control per member on top, since the photo rides on-chain to each of them.
        const photoTx = groupCreatePhotoHex ? members.length : 0;
        const txCount = members.length + 1 + photoTx;
        let feeLine = `\n\n(${txCount} network transaction${txCount === 1 ? "" : "s"}.)`;
        try {
          const perInvite = parseFloat(await engine.estimateMessageFee(2 * (400 + (members.length + 1) * 70)) || "0");
          const perPhoto = photoTx
            ? parseFloat(await engine.estimateMessageFee(2 * (300 + groupCreatePhotoHex.length)) || "0")
            : 0;
          const total = perInvite * (members.length + 1) + perPhoto * photoTx;
          if (total > 0) feeLine = `\n\nEstimated network fee ≈ ${total.toFixed(6)} KAS across ${txCount} transaction${txCount === 1 ? "" : "s"}.`;
        } catch {}
        if (!await confirmText(`Create "${name}" and invite ${members.length} member${members.length === 1 ? "" : "s"}?${feeLine}`)) { updateGroupCreateSubmit(); return; }
      }
      setStatus("Creating group and inviting members…");
      const record = await mgr.createGroup({ name, memberAddresses: members });
      // The photo goes out after the group exists, since it is addressed to its members. A photo
      // that fails to distribute must not fail the creation - the group is already real, and the
      // admin can retry from Group Info.
      if (groupCreatePhotoHex) {
        setStatus("Sending the group photo…");
        try {
          await mgr.setGroupPhoto(record.groupId, groupCreatePhotoHex);
        } catch (error) {
          setStatus(`Group created, but the photo did not reach everyone: ${error.message}`);
        }
      }
      // Take the admin straight into the new group. The modal closes first, then the thread
      // opens in the detail pane.
      closeGroupCreate();
      renderGroupList();
      openGroupChat(record.groupId);
      if (record.inviteWarning) {
        setStatus(`Group created, but some invites did not send: ${record.inviteWarning}`);
        showCopyToast("Group created. Some invites failed to send - open group info to retry.");
      } else {
        setStatus("Group created");
      }
    }
  } catch (error) {
    if (groupCreateError) { groupCreateError.textContent = error.message; groupCreateError.hidden = false; }
    setStatus(`Group action failed: ${error.message}`);
  } finally {
    updateGroupCreateSubmit();
  }
});

groupListEl?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-group-open]");
  if (!row) return;
  const groupId = row.dataset.groupOpen;
  // In select mode a tap toggles the group's checkbox instead of opening it.
  if (chatSelectionModeActive) {
    if (selectedGroupIds.has(groupId)) selectedGroupIds.delete(groupId);
    else selectedGroupIds.add(groupId);
    renderGroupList();
    updateChatSelectionBar();
    return;
  }
  // Clicking the already-open group again closes its view.
  if (groupId === activeGroupId) { closeGroupChat(); return; }
  openGroupChat(groupId);
});
document.querySelector("[data-group-chat-back]")?.addEventListener("click", closeGroupChat);
document.querySelector("[data-open-group-manage]")?.addEventListener("click", () => { if (activeGroupId) openGroupManage(activeGroupId); });
document.querySelector("[data-group-manage-back]")?.addEventListener("click", closeGroupManage);

// --- group composer: reply, @mentions, photo, voice (mirrors the 1:1 composer) ---
const groupPlusButton = document.querySelector("[data-group-plus]");
const groupPlusMenu = document.querySelector("[data-group-plus-menu]");
const groupPhotoInput = document.querySelector("[data-group-photo-input]");
const groupVoicePanel = document.querySelector("[data-group-voice-panel]");
const groupVoiceTimeEl = document.querySelector("[data-group-voice-time]");
const groupVoiceCancelBtn = document.querySelector("[data-group-voice-cancel]");
const groupVoiceStopBtn = document.querySelector("[data-group-voice-stop]");
const groupReplyBanner = document.querySelector("[data-group-reply-banner]");
const groupReplyPreview = document.querySelector("[data-group-reply-preview]");
const groupCancelReplyBtn = document.querySelector("[data-group-cancel-reply]");
const groupMentionSuggestions = document.querySelector("[data-group-mention-suggestions]");

let groupReplyTarget = null;            // message currently being replied to
const groupDraftMentions = new Map();   // inserted @label -> kaspa address (for encode-on-send)
let groupVoiceRecorder = null, groupVoiceChunks = [], groupVoiceStartMs = 0, groupVoiceTimer = null, groupVoiceMime = "";

function autoGrowGroupComposer() {
  if (!groupComposerInput) return;
  groupComposerInput.style.height = "auto";
  groupComposerInput.style.height = `${Math.min(groupComposerInput.scrollHeight, 132)}px`;
}

function startGroupReply(message) {
  groupReplyTarget = message;
  if (groupReplyPreview) groupReplyPreview.textContent = decodeGroupMentions(replyPreviewTextFor(message)) || "Message";
  if (groupReplyBanner) groupReplyBanner.hidden = false;
  groupComposerInput?.focus();
}
function cancelGroupReply() {
  groupReplyTarget = null;
  if (groupReplyBanner) groupReplyBanner.hidden = true;
}

// Members mentionable with a single-token handle (KNS domain / short address, no spaces).
function groupMentionCandidates(query) {
  const g = getGroupManager()?.getGroup(activeGroupId);
  if (!g) return [];
  const q = String(query || "").toLowerCase();
  return g.members
    .filter((m) => m.address && m.address !== engine.address)
    .map((m) => {
      // Prefer the KNS domain as the single-token handle (what the user wants shown); fall back to
      // a space-free contact label, else the short address.
      const label = mentionDisplayLabel(m.address);
      const handle = /\s/.test(label) ? shortAddress(m.address) : label;
      return { address: m.address, label, handle };
    })
    .filter((m) => !q || m.handle.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
    .slice(0, 6);
}
function closeGroupMentions() { if (groupMentionSuggestions) { groupMentionSuggestions.hidden = true; groupMentionSuggestions.innerHTML = ""; } }
function refreshGroupMentions() {
  if (!groupComposerInput || !groupMentionSuggestions) return;
  const value = groupComposerInput.value;
  const caret = groupComposerInput.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return closeGroupMentions();
  const candidates = groupMentionCandidates(match[2]);
  if (!candidates.length) return closeGroupMentions();
  groupMentionSuggestions.innerHTML = candidates.map((c) => `
    <button type="button" class="mention-suggestion" data-mention-address="${escapeHtml(c.address)}" data-mention-handle="${escapeHtml(c.handle)}">
      ${memberAvatarHtml(c.address, "chat-avatar")}
      <span><strong>${escapeHtml(c.label)}</strong><small>${escapeHtml(shortAddress(c.address))}</small></span>
    </button>`).join("");
  groupMentionSuggestions.hidden = false;
}
function insertGroupMention(address, handle) {
  if (!groupComposerInput) return;
  const value = groupComposerInput.value;
  const caret = groupComposerInput.selectionStart ?? value.length;
  const before = value.slice(0, caret).replace(/@([^\s@]*)$/, `@${handle} `);
  groupComposerInput.value = before + value.slice(caret);
  groupDraftMentions.set(`@${handle}`, address);
  closeGroupMentions();
  groupComposerInput.focus();
  autoGrowGroupComposer();
}
// Replace tracked @handle tokens with the on-chain @<address> form. No braces — matches iOS/Android
// GroupMentionCodec so mentions decode cross-platform (desktop's old @{address} form did not).
function encodeGroupMentions(text) {
  let out = String(text || "");
  // Autocomplete-tracked handles first (exactly what the user inserted).
  for (const [handle, address] of [...groupDraftMentions.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(handle).join(`@${address}`);
  }
  // Also catch a member's KNS domain / name typed by hand — iterate members longest-label-first,
  // mirroring iOS/Android GroupMentionCodec so a manually-typed @alice.kas still encodes.
  const g = getGroupManager()?.getGroup(activeGroupId);
  const members = (g?.members || [])
    .filter((m) => m.address && m.address !== engine.address)
    .map((m) => ({ address: m.address, label: mentionDisplayLabel(m.address) }))
    .filter((m) => m.label && !/\s/.test(m.label))
    .sort((a, b) => b.label.length - a.label.length);
  for (const m of members) out = out.split(`@${m.label}`).join(`@${m.address}`);
  return out;
}

// Shared group send: appends the local echo after the tx is broadcast (so sync dedupes by
// msgId), with a delivery-status marker.
// Patch an existing group message in place (status/txId/msgIdHex) and persist.
function patchGroupMessage(groupId, localId, patch) {
  const list = groupMessages(groupId);
  const m = list.find((x) => x.id === localId);
  if (!m) return;
  Object.assign(m, patch);
  saveGroupMessages(groupId, list);
}

// Re-send a failed group message: patch it back to pending and retry the broadcast in place
// (no duplicate row), mirroring the 1:1 retry.
async function retryGroupMessage(message) {
  if (!activeGroupId) return;
  const gid = activeGroupId;
  patchGroupMessage(gid, message.id, { status: MESSAGE_STATUSES.PENDING });
  if (activeGroupId === gid) renderGroupMessages();
  const mgr = getGroupManager();
  if (!mgr) return;
  try {
    const res = await mgr.sendGroupMessage(gid, message.text);
    patchGroupMessage(gid, message.id, { txId: res?.txid || null, msgIdHex: res?.msgIdHex || null, status: MESSAGE_STATUSES.CONFIRMED });
  } catch (error) {
    patchGroupMessage(gid, message.id, { status: MESSAGE_STATUSES.FAILED });
    setStatus(`Group send failed: ${error.message}`);
  }
  if (activeGroupId === gid) { renderGroupMessages(); renderGroupList(); }
}

// Optimistic group send: the bubble appears instantly (pending), then flips to a delivered
// checkmark or a failed+retry state — so a slow/failed broadcast never leaves the feed blank.
async function sendGroupWire(text) {
  const mgr = getGroupManager();
  if (!mgr || !activeGroupId) return false;
  const gid = activeGroupId;
  const localId = nowId();
  appendGroupMessage(gid, {
    id: localId, senderAddress: engine.address, direction: "local",
    text, createdAt: Date.now(), txId: null, msgIdHex: null,
    senderIsAdmin: Boolean(mgr.getGroup(gid)?.isAdmin), status: MESSAGE_STATUSES.PENDING,
  });
  if (activeGroupId === gid) renderGroupMessages();
  renderGroupList();
  try {
    const res = await mgr.sendGroupMessage(gid, text);
    // Patch the same row so a later sync of our own message dedupes by msgId (no duplicate).
    patchGroupMessage(gid, localId, { txId: res?.txid || null, msgIdHex: res?.msgIdHex || null, status: MESSAGE_STATUSES.CONFIRMED });
    if (activeGroupId === gid) renderGroupMessages();
    renderGroupList();
    return true;
  } catch (error) {
    patchGroupMessage(gid, localId, { status: MESSAGE_STATUSES.FAILED });
    if (activeGroupId === gid) renderGroupMessages();
    setStatus(`Group send failed: ${error.message}`);
    return false;
  }
}

groupComposer?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeGroupId || !getGroupManager()) return;
  const raw = String(groupComposerInput?.value || "").trim();
  // A staged photo sends on Send (with the typed caption as a following message, if any).
  if (groupPendingPhoto) {
    const { attachment, fileName } = groupPendingPhoto;
    clearGroupPendingPhoto();
    sendGroupWire(buildImageEnvelopeJson(attachment, fileName));
  }
  if (!raw) return;
  const encoded = encodeGroupMentions(raw);
  let wire = encoded;
  if (groupReplyTarget) {
    wire = JSON.stringify({
      type: "reply",
      replyToId: groupMsgKey(groupReplyTarget),
      replyToSender: groupReplyTarget.senderAddress || "",
      replyToPreview: replyPreviewTextFor(groupReplyTarget),
      text: encoded,
    });
  }
  groupComposerInput.value = "";
  autoGrowGroupComposer();
  groupDraftMentions.clear();
  cancelGroupReply();
  closeGroupMentions();
  // Optimistic: the bubble is already in the feed. On failure it shows a "Retry" affordance,
  // so we don't restore the draft (that would double up the message).
  sendGroupWire(wire);
});

// Enter sends, Shift+Enter is a newline; keep the box auto-growing.
groupComposerInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); groupComposer?.requestSubmit(); }
});
groupComposerInput?.addEventListener("input", () => { autoGrowGroupComposer(); refreshGroupMentions(); });
groupMentionSuggestions?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-mention-address]");
  if (btn) insertGroupMention(btn.dataset.mentionAddress, btn.dataset.mentionHandle);
});
groupCancelReplyBtn?.addEventListener("click", cancelGroupReply);

// Plus-menu (Photo / Voice).
function closeGroupPlusMenu() { if (groupPlusMenu) groupPlusMenu.hidden = true; }
groupPlusButton?.addEventListener("click", () => { if (groupPlusMenu) groupPlusMenu.hidden = !groupPlusMenu.hidden; });
groupPlusMenu?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-group-compose]");
  if (!btn) return;
  closeGroupPlusMenu();
  if (btn.dataset.groupCompose === "photo") groupPhotoInput?.click();
  else if (btn.dataset.groupCompose === "voice") startGroupVoice();
});

// Photo send.
// Group pending-photo staging: selecting a photo stages it in the composer (with a preview)
// so you press Send yourself — it does NOT auto-send. Mirrors the 1:1 flow.
const groupPendingPhotoPreview = document.querySelector("[data-group-pending-photo-preview]");
const groupPendingPhotoThumb = document.querySelector("[data-group-pending-photo-thumb]");
const groupPendingPhotoMeta = document.querySelector("[data-group-pending-photo-meta]");
const groupPendingPhotoRemove = document.querySelector("[data-group-pending-photo-remove]");
let groupPendingPhoto = null;
function clearGroupPendingPhoto() {
  groupPendingPhoto = null;
  if (groupPendingPhotoPreview) groupPendingPhotoPreview.hidden = true;
}
function setGroupPendingPhoto(attachment, fileName) {
  groupPendingPhoto = { attachment, fileName };
  if (groupPendingPhotoThumb) groupPendingPhotoThumb.src = attachment.dataUrl;
  if (groupPendingPhotoMeta) groupPendingPhotoMeta.textContent = `Photo · ${attachment.width}×${attachment.height} · ${(attachment.bytes / 1024).toFixed(1)} KB`;
  if (groupPendingPhotoPreview) groupPendingPhotoPreview.hidden = false;
  groupComposerInput?.focus();
}
groupPendingPhotoRemove?.addEventListener("click", clearGroupPendingPhoto);
groupPhotoInput?.addEventListener("change", async () => {
  const file = groupPhotoInput.files?.[0];
  groupPhotoInput.value = "";
  if (!file || !activeGroupId) return;
  try {
    setStatus("Compressing photo…");
    const attachment = await compressImageBlob(file);
    setGroupPendingPhoto(attachment, file.name || "photo.jpg");
    setStatus(`Photo ready · ${(attachment.bytes / 1024).toFixed(1)} KB · press Send`);
  } catch (error) { showCopyToast(error.message || "Could not attach that photo."); }
});

// Voice send (native MediaRecorder → the same {type:"file",audio/...} envelope as 1:1).
async function startGroupVoice() {
  if (!activeGroupId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    groupVoiceMime = pickVoiceMimeType();
    groupVoiceRecorder = new MediaRecorder(stream, groupVoiceMime ? { mimeType: groupVoiceMime, audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND } : undefined);
    groupVoiceChunks = [];
    groupVoiceRecorder.ondataavailable = (e) => { if (e.data?.size) groupVoiceChunks.push(e.data); };
    groupVoiceRecorder.onstop = () => stream.getTracks().forEach((t) => t.stop());
    groupVoiceRecorder.start();
    groupVoiceStartMs = Date.now();
    if (groupVoicePanel) groupVoicePanel.hidden = false;
    if (groupVoiceTimeEl) groupVoiceTimeEl.textContent = "0:00";
    groupVoiceTimer = window.setInterval(() => {
      const secs = (Date.now() - groupVoiceStartMs) / 1000;
      if (groupVoiceTimeEl) groupVoiceTimeEl.textContent = formatRecordingTime(secs);
      if (secs >= voiceMaxDurationSeconds()) finishGroupVoice(true);
    }, 250);
  } catch (error) { showCopyToast("Microphone access denied or unavailable."); }
}
function stopGroupVoiceTimer() { if (groupVoiceTimer) { clearInterval(groupVoiceTimer); groupVoiceTimer = null; } }
function cancelGroupVoice() {
  stopGroupVoiceTimer();
  try { groupVoiceRecorder?.stop(); } catch {}
  groupVoiceRecorder = null; groupVoiceChunks = [];
  if (groupVoicePanel) groupVoicePanel.hidden = true;
}
async function finishGroupVoice(send) {
  stopGroupVoiceTimer();
  if (groupVoicePanel) groupVoicePanel.hidden = true;
  const recorder = groupVoiceRecorder;
  groupVoiceRecorder = null;
  if (!recorder) return;
  const durationSec = Math.round((Date.now() - groupVoiceStartMs) / 1000);
  await new Promise((resolve) => { recorder.addEventListener("stop", resolve, { once: true }); try { recorder.stop(); } catch { resolve(); } });
  if (!send || !groupVoiceChunks.length || !activeGroupId) { groupVoiceChunks = []; return; }
  const blob = new Blob(groupVoiceChunks, { type: groupVoiceMime || "audio/webm" });
  groupVoiceChunks = [];
  const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || "")); r.readAsDataURL(blob); });
  if (!dataUrl.startsWith("data:")) return;
  await sendGroupWire(JSON.stringify({ type: "file", name: "voice.webm", size: blob.size, mimeType: groupVoiceMime || "audio/webm", content: dataUrl, duration: durationSec }));
}
groupVoiceStopBtn?.addEventListener("click", () => finishGroupVoice(true));
groupVoiceCancelBtn?.addEventListener("click", cancelGroupVoice);

// Scroll-to-latest button for the group thread — appears when scrolled up.
(function setupGroupScrollToBottom() {
  if (!groupMessageArea || !groupMessageArea.parentElement) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "group-scroll-bottom";
  btn.setAttribute("aria-label", "Scroll to latest");
  btn.hidden = true;
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  btn.addEventListener("click", () => groupMessageArea.scrollTo({ top: groupMessageArea.scrollHeight, behavior: "smooth" }));
  groupMessageArea.parentElement.appendChild(btn);
  groupMessageArea.addEventListener("scroll", () => {
    btn.hidden = groupMessageArea.scrollHeight - groupMessageArea.scrollTop - groupMessageArea.clientHeight < 120;
  }, { passive: true });
})();

groupManageBody?.addEventListener("click", async (event) => {
  // Per-group notification mode: all messages / mentions only / muted.
  const notifyRow = event.target.closest("[data-group-notify-mode]");
  if (notifyRow && activeGroupId) {
    const mode = notifyRow.dataset.groupNotifyMode;
    setGroupNotify(activeGroupId, mode);
    // Move the checkmark in place rather than re-rendering the screen, so the open
    // Notifications dropdown (a <details>) does not snap shut on every choice.
    groupManageBody.querySelectorAll("[data-group-notify-mode]").forEach((row) => {
      const selected = row.dataset.groupNotifyMode === mode;
      row.setAttribute("aria-pressed", selected ? "true" : "false");
      const icon = row.querySelector(".group-manage-row-icon");
      if (icon) icon.innerHTML = selected ? "✓" : "&nbsp;";
    });
    if (mode === "muted") {
      showCopyToast("Muted. This group will not notify you.");
    } else {
      const granted = await ensureNotificationPermission();
      if (!granted) showCopyToast("Allow notifications in your browser to receive them.");
      else showCopyToast(mode === "all" ? "Notifying for all messages in this group." : "Notifying only for mentions and replies to you.");
    }
    return;
  }
  // Change the group photo (admin): pick a file, compress, and push to every member.
  const photoEdit = event.target.closest("[data-group-photo-edit]");
  if (photoEdit && activeGroupId) {
    const mgr = getGroupManager();
    if (!mgr) return;
    const gid = activeGroupId;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        setStatus("Preparing group photo…");
        // Rides on-chain to every member (hex-encoded), so keep it small.
        const compressed = await compressImageBlob(file, { targetBytes: 10 * 1024, maxDimension: 256 });
        const hex = groupPhotoHexFromDataUrl(compressed.dataUrl);
        // Confirm with the estimated fee — a photo is the priciest control (it rides on-chain to
        // every member), so show the cost before committing.
        const others = groupOtherMemberCount(mgr.getGroup(gid));
        let feeLine = `\n\n(${others} network transaction${others === 1 ? "" : "s"}.)`;
        try {
          const per = parseFloat(await engine.estimateMessageFee(2 * (300 + hex.length)) || "0");
          if (per * others > 0) feeLine = `\n\nEstimated network fee ≈ ${(per * others).toFixed(6)} KAS across ${others} transaction${others === 1 ? "" : "s"}.`;
        } catch {}
        if (!await confirmText(`Set this as the group photo for everyone?${feeLine}`)) { setStatus(""); return; }
        setStatus("Updating group photo…");
        await mgr.setGroupPhoto(gid, hex);
        appendGroupSystemMessage(gid, "You changed the group photo", Date.now(), `sys:${gid}:photo:${hex.length}:${hex.slice(0, 16)}`);
        openGroupManage(gid);
        openGroupChat(gid);
        renderGroupList();
        setStatus("Group photo updated");
      } catch (error) {
        setStatus(`Could not set group photo: ${error.message}`);
        showCopyToast(`Could not set group photo. ${error.message}`);
      }
    });
    input.click();
    return;
  }
  // Remove the group photo (admin).
  const photoRemove = event.target.closest("[data-group-photo-remove]");
  if (photoRemove && activeGroupId) {
    const mgr = getGroupManager();
    if (!mgr) return;
    if (!await confirmText(`Remove the group photo for everyone?${await groupOpFeeHint(activeGroupId, { controlTx: groupOtherMemberCount(mgr.getGroup(activeGroupId)) })}`)) return;
    try {
      setStatus("Removing group photo…");
      await mgr.setGroupPhoto(activeGroupId, "");
      appendGroupSystemMessage(activeGroupId, "You removed the group photo", Date.now(), `sys:${activeGroupId}:photo:cleared`);
      openGroupManage(activeGroupId);
      openGroupChat(activeGroupId);
      renderGroupList();
      setStatus("Group photo removed");
    } catch (error) {
      setStatus(`Could not remove group photo: ${error.message}`);
    }
    return;
  }
  // Unhide is local-only (no engine call) — handle it before the admin-action gate.
  const unhide = event.target.closest("[data-group-unhide-member]");
  if (unhide && activeGroupId) {
    setGroupMemberHidden(activeGroupId, unhide.dataset.groupUnhideMember, false);
    renderGroupMessages();
    openGroupManage(activeGroupId);
    return;
  }
  // Resend an invite to ONE member (admin) — targeted retry.
  const resendOne = event.target.closest("[data-group-resend-member]");
  if (resendOne && activeGroupId) {
    const mgr = getGroupManager();
    if (!mgr) return;
    const addr = resendOne.dataset.groupResendMember;
    if (!await confirmText(`Resend the group invite to ${groupSenderLabel(addr)}?${await groupOpFeeHint(activeGroupId, { controlTx: 1 })}`)) return;
    resendOne.disabled = true;
    setStatus("Resending invite…");
    try {
      await mgr.resendInviteToMember(activeGroupId, addr);
      setStatus("Invite resent");
      showCopyToast("Invite resent.");
    } catch (error) {
      setStatus(`Invite failed: ${error.message}`);
      showCopyToast(`Invite failed. ${error.message}`);
    } finally {
      resendOne.disabled = false;
    }
    return;
  }
  // Resend invites (admin) — retry any that failed to send at create time.
  const resend = event.target.closest("[data-group-resend-invites]");
  if (resend && activeGroupId) {
    const mgr = getGroupManager();
    if (!mgr) return;
    const rec = mgr.getGroup(activeGroupId);
    const others = groupOtherMemberCount(rec);
    const hasPhoto = Boolean(rec?.photoHex);
    if (!await confirmText(`Resend the group invite to all members?${await groupOpFeeHint(activeGroupId, { controlTx: others + 1, photoTx: hasPhoto ? others : 0 })}`)) return;
    resend.disabled = true;
    setStatus("Resending invites…");
    try {
      await mgr.resendInvites(activeGroupId);
      setStatus("Invites resent");
      showCopyToast("Invites resent to all members.");
    } catch (error) {
      setStatus(`Some invites still failed: ${error.message}`);
      showCopyToast(`Some invites still failed. ${error.message}`);
    } finally {
      resend.disabled = false;
    }
    return;
  }
  const target = event.target.closest("[data-group-remove-member],[data-group-add-member],[data-group-rename],[data-group-delete],[data-group-leave]");
  if (!target || !activeGroupId) return;
  const mgr = getGroupManager();
  if (!mgr) return;
  try {
    if (target.dataset.groupRemoveMember) {
      const removeAddr = target.dataset.groupRemoveMember;
      const rec = mgr.getGroup(activeGroupId);
      const afterN = Math.max(0, groupOtherMemberCount(rec) - 1);          // remaining others after removal
      const hasPhoto = Boolean(rec?.photoHex);
      if (!await confirmText(`Remove ${groupSenderLabel(removeAddr)} from the group chat? A fresh group key is issued to everyone who stays.${await groupOpFeeHint(activeGroupId, { controlTx: 2 * afterN + 1, photoTx: hasPhoto ? afterN : 0 })}`)) return;
      setStatus("Removing member…");
      await mgr.removeMember(activeGroupId, removeAddr);
      // iMessage-style membership line for the admin (other members get theirs on the rotation).
      const epRem = mgr.getGroup(activeGroupId)?.currentEpoch;
      appendGroupSystemMessage(activeGroupId, `${groupSenderLabel(removeAddr)} was removed from the group chat`, Date.now(), `sys:${activeGroupId}:${epRem}:rem:${removeAddr}`);
      openGroupManage(activeGroupId);
      openGroupChat(activeGroupId);
      setStatus("Member removed");
    } else if (target.dataset.groupAddMember != null) {
      openGroupAddMember(activeGroupId);
    } else if (target.dataset.groupRename != null) {
      const current = mgr.getGroup(activeGroupId)?.name || "";
      const name = String(await promptText("Rename group — every member will see the new name.", current) || "").trim();
      if (!name || name === current) return;
      const others = groupOtherMemberCount(mgr.getGroup(activeGroupId));
      if (!await confirmText(`Rename the group to "${name}"? Every member is notified.${await groupOpFeeHint(activeGroupId, { controlTx: others + 1 })}`)) return;
      setStatus("Renaming group…");
      const prevName = mgr.getGroup(activeGroupId)?.name;
      await mgr.renameGroup(activeGroupId, name);
      if (prevName !== name) appendGroupSystemMessage(activeGroupId, `You changed the group name to "${name}"`, Date.now(), `sys:${activeGroupId}:name:${name}`);
      openGroupManage(activeGroupId);
      openGroupChat(activeGroupId);
      setStatus("Group renamed");
    } else if (target.dataset.groupDelete != null) {
      if (!await confirmText("Delete this group from this device? Members you invited keep their copy.")) return;
      const id = activeGroupId;
      closeGroupManage();
      closeGroupChat();
      mgr.deleteGroup(id);
      renderGroupList();
      setStatus("Group deleted");
    } else if (target.dataset.groupLeave != null) {
      if (!await confirmText("Leave this group? You will stop receiving its messages on this device.")) return;
      const id = activeGroupId;
      closeGroupManage();
      closeGroupChat();
      mgr.deleteGroup(id);
      renderGroupList();
      setStatus("Left group");
    }
  } catch (error) {
    setStatus(`Group action failed: ${error.message}`);
    showCopyToast(`Group action failed. ${error.message}`);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (groupManageScreen && !groupManageScreen.hidden) { closeGroupManage(); return; }
  if (groupCreateModal && !groupCreateModal.hidden) { closeGroupCreate(); return; }
  if (groupChatScreen && !groupChatScreen.hidden) { closeGroupChat(); }
});
