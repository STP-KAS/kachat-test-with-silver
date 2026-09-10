// Broadcasts tab UI — desktop port of the iOS/Android 4.0 broadcast rooms. Channel list
// (featured rooms pinned + joinable customs), room view with indexer backfill (once on open +
// 8s polling while open), per-room hidden users, the "Other Languages" disclosure of curated
// language rooms, and a live connection dot in the room header. Feature parity with mobile:
// link previews in bubbles (same progressive Nextcloud probe as 1:1), reactions (same
// cross-platform JSON payload as 1:1, sent as normal broadcast messages), and voice notes
// via Nextcloud media upload.

import {
  BROADCAST_RETENTION_MS,
  FEATURED_BROADCAST_CHANNELS,
  LANGUAGE_BROADCAST_CHANNELS,
  broadcastLanguageDisplayName,
  fetchBroadcastHistory,
  hasBroadcastIndexer,
  isIndexedBroadcastChannel,
  isValidBroadcastChannel,
  normalizeBroadcastChannel,
  sendBroadcastMessage,
} from "../engine/broadcasts.js";
import { confirmText, promptText } from "./dialogs.js";

const CHANNELS_KEY = "kachat-broadcast-channels-v1";        // account-scoped: ["name", ...]
const HIDDEN_KEY = "kachat-broadcast-hidden-v1";            // account-scoped: { [channel]: [address, ...] }
const NOTIFY_KEY = "kachat-broadcast-notify-v1";            // account-scoped: { [channel]: true } — the bell
const LISTEN_KEY = "kachat-broadcast-listen-v1";            // account-scoped: { [channel]: true } — always-listen
const RETENTION_KEY = "kachat-broadcast-retention-v1";      // account-scoped: { [channel]: days } (0/absent = forever, own channels only)
const CACHE_KEY = "kachat-broadcast-messages-cache-v1";     // GLOBAL: public chain data, account-agnostic
const REACTIONS_KEY = "kachat-broadcast-reactions-cache-v1"; // GLOBAL: public chain data, account-agnostic
const POLL_MS = 8000;
// Nextcloud carries the audio bytes — same 600s cap as the 1:1 Nextcloud voice notes.
const VOICE_MAX_DURATION_SECONDS = 600;

let deps = null;

let listEl, roomEl, roomTitleEl, roomDotEl, roomBodyEl, composerInput, sendBtn, joinInput;
let voicePanelEl, voiceTimeEl, voiceBtn;
let joinedChannels = [];
let hiddenByRoom = {};
let notifyByChannel = {};    // { [channel]: true } — the bell: OS pings for new messages
let retentionByChannel = {}; // { [channel]: days } — own channels only; indexed rooms are fixed 30-day
// { [channel]: true } — always-listen, own channels only. Keeps a custom room's live block
// scan running while its screen is closed (iOS BroadcastChannel.alwaysListen). Curated rooms
// deliberately have no toggle: they are indexer-backed, so there is nothing to keep alive.
let listenByChannel = {};
// True while the Broadcasts tab is the visible tab. An open room only counts as "wanted"
// (and only polls) while its screen is actually on screen.
let tabVisible = false;
// "Other Languages" disclosure under Popular. Collapsed by default: eleven language rooms
// would bury the two Popular rooms and the user's own channels under a wall of list.
let languagesExpanded = false;
// Only messages arriving AFTER app launch may ping — backfilled history never notifies.
const broadcastSessionStartMs = Date.now();
let messageCache = {}; // { [channel]: [{ txId, senderAddress, content, blockTime, status? }] }
// { [channel]: { byTarget: { [targetTxId]: { [reactorAddress]: { emoji, blockTime, removed? } } },
//                txIds: [processed reaction txids], lastEvent: { senderAddress, emoji, blockTime } | null } }
let reactionsCache = {};
let activeChannel = null;
let pollTimer = null;
let sendInFlight = false;
let voiceRecorder = null;
let voiceRecordingChannel = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadState() {
  try {
    joinedChannels = JSON.parse(localStorage.getItem(deps.accountScopedKey(CHANNELS_KEY)) || "[]") || [];
  } catch { joinedChannels = []; }
  try {
    hiddenByRoom = JSON.parse(localStorage.getItem(deps.accountScopedKey(HIDDEN_KEY)) || "{}") || {};
  } catch { hiddenByRoom = {}; }
  try {
    notifyByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(NOTIFY_KEY)) || "{}") || {};
  } catch { notifyByChannel = {}; }
  try {
    retentionByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(RETENTION_KEY)) || "{}") || {};
  } catch { retentionByChannel = {}; }
  try {
    listenByChannel = JSON.parse(localStorage.getItem(deps.accountScopedKey(LISTEN_KEY)) || "{}") || {};
  } catch { listenByChannel = {}; }
  try {
    messageCache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {};
  } catch { messageCache = {}; }
  try {
    reactionsCache = JSON.parse(localStorage.getItem(REACTIONS_KEY) || "{}") || {};
  } catch { reactionsCache = {}; }
  // The two featured rooms are always present for every account (matches iOS/Android). The
  // curated LANGUAGE rooms are deliberately NOT auto-joined - they are joined on first open or
  // bell tap, so a user who wants none of them pays for none of them.
  for (const name of FEATURED_BROADCAST_CHANNELS) {
    if (!joinedChannels.includes(name)) joinedChannels.push(name);
  }
  migrateCachedReactionRows();
  pruneCache();
}

/** Older caches stored reaction payload rows as normal messages — lift them into the
 *  reactions store so they never render as raw-JSON rows. */
function migrateCachedReactionRows() {
  let migrated = false;
  for (const channel of Object.keys(messageCache)) {
    const kept = [];
    for (const row of messageCache[channel] || []) {
      const reaction = deps.parseReactionEnvelope?.(row.content);
      if (reaction) {
        recordReaction(channel, row.txId, reaction, row.senderAddress || "", Number(row.blockTime) || 0);
        migrated = true;
      } else {
        kept.push(row);
      }
    }
    messageCache[channel] = kept;
  }
  if (migrated) { saveCache(); saveReactions(); }
}

function saveChannels() {
  localStorage.setItem(deps.accountScopedKey(CHANNELS_KEY), JSON.stringify(joinedChannels));
}

function saveHidden() {
  localStorage.setItem(deps.accountScopedKey(HIDDEN_KEY), JSON.stringify(hiddenByRoom));
}

function saveNotify() {
  localStorage.setItem(deps.accountScopedKey(NOTIFY_KEY), JSON.stringify(notifyByChannel));
}

function saveRetention() {
  localStorage.setItem(deps.accountScopedKey(RETENTION_KEY), JSON.stringify(retentionByChannel));
}

function saveListen() {
  localStorage.setItem(deps.accountScopedKey(LISTEN_KEY), JSON.stringify(listenByChannel));
}

// ---------------------------------------------------------------------------
// Live block scanning (custom rooms)
//
// The broadcast indexer only tracks the curated rooms, so a user-created room has no
// history anywhere: its only delivery path is watching the chain live. The engine
// subscribes to the node's block-added notifications and hands back rows in the exact
// shape `fetchBroadcastHistory` returns, so both paths land in `mergeMessages` and dedupe
// by txId against the same cache. Live only, by construction - nothing backfills.
// ---------------------------------------------------------------------------

/** True for a room the user asked to keep listening to with its screen closed. */
function alwaysListening(channel) {
  return Boolean(listenByChannel[channel]) && !isIndexedBroadcastChannel(channel);
}

/**
 * The rooms that justify the block stream right now - iOS `BroadcastService.wantedChannels`:
 * the room whose screen is open, plus every always-listen room. Nothing else, so an idle app
 * does no block work at all.
 *
 * Indexer-backed rooms are then dropped, because they already have a service watching the
 * chain 24/7 plus an 8s poll while open: streaming every block for them would be pure
 * duplicate cost. If the user clears the broadcast indexer, they stay in - then the block
 * stream is their only live path too.
 */
function scanWantedChannels() {
  const wanted = new Set();
  if (tabVisible && activeChannel) wanted.add(activeChannel);
  for (const channel of Object.keys(listenByChannel)) {
    if (alwaysListening(channel) && joinedChannels.includes(channel)) wanted.add(channel);
  }
  if (hasBroadcastIndexer()) {
    for (const channel of [...wanted]) {
      if (isIndexedBroadcastChannel(channel)) wanted.delete(channel);
    }
  }
  return [...wanted];
}

/** Pushes the wanted set to the engine. Idempotent - the engine only starts/stops the
 *  subscription when the set actually changes between empty and non-empty. */
function syncScanWanted() {
  if (!deps?.engine?.setBroadcastScanChannels) return;
  try { deps.engine.setBroadcastScanChannels(scanWantedChannels()); }
  catch (error) { deps.appendEngineLog?.(`Broadcast live scan update failed: ${error.message}`); }
}

/** Live hits from the block stream, already filtered to the wanted rooms by the engine.
 *  Straight into `mergeMessages` — same store, same txId dedupe, same retention, same
 *  render as the indexer rows. */
function handleBroadcastBlockHits(hits) {
  const byChannel = new Map();
  for (const hit of hits || []) {
    const channel = normalizeBroadcastChannel(hit?.channel);
    if (!channel || !hit?.txId) continue;
    // Deliberately NOT filtering hidden senders here: the indexer path stores them and
    // filters at render time, so unhiding a user brings their messages back. Both paths must
    // leave the store in the same state, so this one stores them too.
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(hit);
  }
  let touched = false;
  for (const [channel, rows] of byChannel) {
    if (mergeMessages(channel, rows) > 0) {
      touched = true;
      if (activeChannel === channel) renderRoom();
    }
  }
  if (touched) renderChannelList();
}

/** Effective retention cutoff for a channel: every indexer-backed room (featured + the curated
 *  language rooms) is fixed 30-day, matching iOS; own channels use their configured days,
 *  forever when unset/0. */
function retentionCutoffMs(channel) {
  if (isIndexedBroadcastChannel(channel)) return Date.now() - BROADCAST_RETENTION_MS;
  const days = Number(retentionByChannel[channel] || 0);
  return days > 0 ? Date.now() - days * 86_400_000 : 0;
}

function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(messageCache)); }
  catch {
    // Quota: actually drop the OLDEST HALF of each channel's messages (the old code wiped
    // messageCache entirely, silently deleting every channel's history) and retry once.
    try {
      for (const channel of Object.keys(messageCache)) {
        const rows = messageCache[channel] || [];
        if (rows.length > 50) messageCache[channel] = rows.slice(Math.floor(rows.length / 2));
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(messageCache));
    } catch { /* still over quota — keep the in-memory copy, skip persisting */ }
  }
}

function saveReactions() {
  try { localStorage.setItem(REACTIONS_KEY, JSON.stringify(reactionsCache)); }
  catch { reactionsCache = {}; }
}

/** Rolling retention, matching the indexed rooms' product rule. */
function pruneCache() {
  // Per-channel retention (iOS parity): indexed rooms fixed 30-day, own channels use their
  // configured retention (0 = keep forever).
  for (const channel of Object.keys(messageCache)) {
    const cutoff = retentionCutoffMs(channel);
    if (!cutoff) continue;
    messageCache[channel] = (messageCache[channel] || []).filter((m) => (m.blockTime || 0) >= cutoff);
    if (messageCache[channel].length === 0) delete messageCache[channel];
  }
  for (const channel of Object.keys(reactionsCache)) {
    const cutoff = retentionCutoffMs(channel);
    const entry = reactionsCache[channel] || {};
    if (cutoff) {
      for (const targetTxId of Object.keys(entry.byTarget || {})) {
        const perReactor = entry.byTarget[targetTxId];
        for (const reactor of Object.keys(perReactor)) {
          if (Number(perReactor[reactor]?.blockTime || 0) < cutoff) delete perReactor[reactor];
        }
        if (Object.keys(perReactor).length === 0) delete entry.byTarget[targetTxId];
      }
      if (entry.lastEvent && Number(entry.lastEvent.blockTime || 0) < cutoff) entry.lastEvent = null;
    }
    if (Array.isArray(entry.txIds) && entry.txIds.length > 500) entry.txIds = entry.txIds.slice(-500);
    if (Object.keys(entry.byTarget || {}).length === 0 && !entry.lastEvent) delete reactionsCache[channel];
  }
}

function hiddenIn(channel) {
  return new Set(hiddenByRoom[channel] || []);
}

// ---------------------------------------------------------------------------
// Reactions store (mirrors app.js's reactionsByTxId semantics, per channel)
// ---------------------------------------------------------------------------

function reactionsFor(channel) {
  return reactionsCache[channel]?.byTarget || {};
}

/** Applies one reaction event. Newest-wins per (targetTxId, reactor); a "remove" is kept as
 *  a tombstone so an older "add" seen again on a later poll can't resurrect the reaction.
 *  Dedupes by reaction txId (pass null for optimistic local applies). Returns true if the
 *  store changed. */
function recordReaction(channel, txId, reaction, reactorAddress, blockTime) {
  if (!reactorAddress) return false;
  const entry = (reactionsCache[channel] ||= { byTarget: {}, txIds: [], lastEvent: null });
  entry.txIds ||= [];
  entry.byTarget ||= {};
  if (txId && entry.txIds.includes(txId)) return false;
  if (txId) entry.txIds.push(txId);
  const perReactor = (entry.byTarget[reaction.targetTxId] ||= {});
  const existing = perReactor[reactorAddress];
  if (!existing || Number(existing.blockTime || 0) <= blockTime) {
    perReactor[reactorAddress] = {
      emoji: reaction.emoji,
      blockTime,
      ...(reaction.action === "remove" ? { removed: true } : {}),
    };
  }
  // Drives the channel list's "Reacted <emoji>" preview line. A remove clears the
  // event rather than advertising an undone reaction (same idea as 1:1's
  // lastReactionEvent handling).
  if (reaction.action === "remove") {
    if (entry.lastEvent && entry.lastEvent.senderAddress === reactorAddress && entry.lastEvent.emoji === reaction.emoji) {
      entry.lastEvent = null;
    }
  } else if (!entry.lastEvent || blockTime >= Number(entry.lastEvent.blockTime || 0)) {
    entry.lastEvent = { senderAddress: reactorAddress, emoji: reaction.emoji, blockTime };
  }
  return true;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function mergeMessages(channel, rows) {
  const existing = messageCache[channel] || [];
  const seen = new Set(existing.map((m) => m.txId));
  let added = 0;
  let reactionsChanged = false;
  const freshIncoming = [];
  for (const row of rows) {
    if (!row?.txId || seen.has(row.txId)) continue;
    seen.add(row.txId);
    const blockTime = Number(row.blockTime) || Date.now();
    // Reactions ride the same wire as normal messages but never become message
    // rows — they only update the per-channel reactions store (same as 1:1).
    const reaction = deps.parseReactionEnvelope?.(row.content);
    if (reaction) {
      if (recordReaction(channel, row.txId, reaction, row.senderAddress || "", blockTime)) reactionsChanged = true;
      continue;
    }
    // Our own just-sent message can come back from the chain BEFORE `sendBroadcastText`
    // rewrites its optimistic bubble from `pending-...` to the real txid — the live block
    // scan is fast enough to win that race where the 8s indexer poll never did. Resolve the
    // pending bubble in place instead of adding a second row for the same message (the later
    // rewrite then finds no pending row and is a no-op).
    if ((row.senderAddress || "") === deps.engine.address) {
      const pending = existing.find((m) =>
        m.status === "pending"
        && m.senderAddress === deps.engine.address
        && m.content === (row.content ?? ""));
      if (pending) {
        pending.txId = row.txId;
        pending.blockTime = blockTime;
        delete pending.status;
        added += 1;
        continue;
      }
    }
    existing.push({
      txId: row.txId,
      senderAddress: row.senderAddress || "",
      content: row.content ?? "",
      blockTime,
    });
    added += 1;
    if ((row.senderAddress || "") !== deps.engine.address) {
      freshIncoming.push({ channel, senderAddress: row.senderAddress || "", content: row.content ?? "", txId: row.txId, blockTime });
    }
  }
  existing.sort((a, b) => a.blockTime - b.blockTime);
  messageCache[channel] = existing;
  if (added > 0) saveCache();
  if (reactionsChanged) saveReactions();
  // The global notification center gates these by arrival time (only live messages ping, not the
  // backfilled history), so it's safe to hand it every fresh incoming row.
  if (freshIncoming.length) deps.onIncomingBroadcast?.(freshIncoming);
  // The per-channel bell (iOS parity): OS pings for LIVE messages in notify-enabled channels
  // you're not currently reading. Capped so one poll can't fire a burst.
  const pingable = freshIncoming.filter((row) =>
    notifyByChannel[row.channel]
    && row.channel !== activeChannel
    && Number(row.blockTime || 0) >= broadcastSessionStartMs);
  for (const row of pingable.slice(0, 3)) {
    deps.postDesktopNotification?.({
      title: `#${row.channel}`,
      body: `${senderName(row.senderAddress)}: ${humanizeBroadcastContent(row.content).slice(0, 90)}`,
      tag: `kachat-broadcast-${row.txId}`,
    });
  }
  return added + (reactionsChanged ? 1 : 0);
}

// Channels that already did the full historical page-back this session — the 8s poll
// afterwards only needs the newest page.
const deepBackfilled = new Set();

async function backfillChannel(channel, { quiet = true } = {}) {
  try {
    let added = 0;
    if (deepBackfilled.has(channel)) {
      const result = await fetchBroadcastHistory({ channel });
      added = mergeMessages(channel, result.messages);
    } else {
      // First open this session: page backwards through the indexer's full history
      // (newest-first, `before` = oldest blockTime seen) so the room shows every
      // message still retained server-side, not just the newest page.
      deepBackfilled.add(channel);
      const cutoff = retentionCutoffMs(channel);
      let before = null;
      for (let page = 0; page < 20; page++) {
        const result = await fetchBroadcastHistory({ channel, limit: 500, before });
        added += mergeMessages(channel, result.messages);
        if (!result.hasMore || !result.messages.length) break;
        const oldest = result.messages.reduce(
          (min, m) => Math.min(min, Number(m.blockTime) || Infinity), Infinity);
        if (!Number.isFinite(oldest)) break;
        if (cutoff && oldest < cutoff) break; // older pages would be pruned anyway
        before = oldest;
      }
    }
    if (added > 0) {
      if (activeChannel === channel) renderRoom();
      renderChannelList();
    }
    return added;
  } catch (error) {
    if (!quiet) deps.showToast?.(error.message);
    deps.appendEngineLog?.(`Broadcast backfill failed for #${channel}: ${error.message}`);
    return -1;
  }
}

function startPolling(channel) {
  stopPolling();
  pollTimer = window.setInterval(() => { if (!document.hidden) backfillChannel(channel); }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------------------
// Sending (single serialized queue so concurrent tx builds can't race UTXOs)
// ---------------------------------------------------------------------------

let sendQueue = Promise.resolve();
function enqueueBroadcastSend(task) {
  const run = sendQueue.then(task, task);
  sendQueue = run.then(() => {}, () => {});
  return run;
}

/** Shared send pipeline used by the composer, voice-note share links, and reactions
 *  (reactions pass showBubble:false — they never get a message row). */
async function sendBroadcastText(channel, text, { showBubble = true } = {}) {
  const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (showBubble) {
    (messageCache[channel] ||= []).push({
      txId: pendingId,
      senderAddress: deps.engine.address || "",
      content: text,
      blockTime: Date.now(),
      status: "pending",
    });
    if (activeChannel === channel) renderRoom();
  }
  try {
    const txid = await enqueueBroadcastSend(() => sendBroadcastMessage({ engine: deps.engine, channel, content: text }));
    if (showBubble) {
      messageCache[channel] = (messageCache[channel] || []).map((m) =>
        m.txId === pendingId ? { ...m, txId: txid, status: undefined } : m);
      saveCache();
    }
    return txid;
  } catch (error) {
    if (showBubble) {
      messageCache[channel] = (messageCache[channel] || []).map((m) =>
        m.txId === pendingId ? { ...m, status: "failed" } : m);
    }
    throw error;
  } finally {
    if (showBubble && activeChannel === channel) renderRoom();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function senderName(address) {
  if (!address) return "unknown";
  if (address === deps.engine.address) return "You";
  const info = deps.engine.peekKnsAddressInfo?.(address);
  const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
  if (domain) return domain.toLowerCase().endsWith(".kas") ? domain.slice(0, -4) : domain;
  return deps.shortAddress(address);
}

/** Last-activity preview for the channel list. Reaction payloads are humanized as
 *  "Reacted <emoji>" instead of showing raw JSON. */
function channelPreviewText(channel) {
  const last = (messageCache[channel] || []).at(-1) || null;
  const lastReaction = reactionsCache[channel]?.lastEvent || null;
  if (!last && !lastReaction) return "";
  if (Number(lastReaction?.blockTime || 0) > Number(last?.blockTime || 0)) {
    return `Reacted ${lastReaction.emoji}`;
  }
  if (!last) return "";
  const reaction = deps.parseReactionEnvelope?.(last.content); // defensive: shouldn't survive migration
  if (reaction) return `Reacted ${reaction.emoji}`;
  return humanizeBroadcastContent(last.content).replace(/\s+/g, " ").slice(0, 64);
}

// The bell icon pair, iOS-style: filled accent when notifications are on, slashed when off.
const BELL_ON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a5.5 5.5 0 0 1 5.5 5.5c0 3.2.8 5 1.8 6.2.4.5.05 1.3-.6 1.3H5.3c-.65 0-1-.8-.6-1.3 1-1.2 1.8-3 1.8-6.2A5.5 5.5 0 0 1 12 4Z" fill="currentColor" stroke="none"/><path d="M10 19.5a2 2 0 0 0 4 0"/></svg>`;
const BELL_OFF_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a5.5 5.5 0 0 1 5.5 5.5c0 3.2.8 5 1.8 6.2.4.5.05 1.3-.6 1.3H5.3c-.65 0-1-.8-.6-1.3 1-1.2 1.8-3 1.8-6.2A5.5 5.5 0 0 1 12 4Z"/><path d="M10 19.5a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/></svg>`;
const GEAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`;

function bellButtonHtml(name) {
  const on = Boolean(notifyByChannel[name]);
  return `<button class="broadcast-card-icon${on ? " active" : ""}" type="button" data-broadcast-notify="${deps.escapeHtml(name)}" title="${on ? "Notifications on" : "Notifications off"}" aria-label="Toggle notifications">${on ? BELL_ON_SVG : BELL_OFF_SVG}</button>`;
}

// Always-listen (own channels only): a broadcast antenna, filled with accent when on.
// Curated rooms get no such control - they are indexer-backed, so there is nothing to keep
// alive (same split iOS uses to hide the toggle for its indexed channels).
const LISTEN_ON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="2.4" fill="currentColor" stroke="none"/><path d="M8.5 7.5a5 5 0 0 0 0 7"/><path d="M15.5 7.5a5 5 0 0 1 0 7"/><path d="M5.8 4.8a9 9 0 0 0 0 12.4"/><path d="M18.2 4.8a9 9 0 0 1 0 12.4"/><path d="M12 13.4V21"/></svg>`;
const LISTEN_OFF_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="11" r="2.4"/><path d="M8.5 7.5a5 5 0 0 0 0 7"/><path d="M15.5 7.5a5 5 0 0 1 0 7"/><path d="M12 13.4V21"/></svg>`;

function listenButtonHtml(name) {
  const on = alwaysListening(name);
  const title = on
    ? "Always listening. New messages arrive even with this room closed."
    : "Listen in the background. Off means this room only receives while it is open.";
  return `<button class="broadcast-card-icon${on ? " active" : ""}" type="button" data-broadcast-listen="${deps.escapeHtml(name)}" title="${title}" aria-label="Toggle background listening">${on ? LISTEN_ON_SVG : LISTEN_OFF_SVG}</button>`;
}

const GLOBE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z"/></svg>`;
const CHEVRON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

// `indexed` = an indexer-backed room (featured or curated language). Those rooms have a fixed
// 30-day retention served by the indexer, so they get no retention gear and no Leave.
function channelCardHtml(name, { indexed }) {
  // Name only, no preview/description line - matches iOS's clean rows.
  return `
    <div class="broadcast-card">
      <button class="broadcast-card-main" type="button" data-broadcast-open="${deps.escapeHtml(name)}">
        <strong>#${deps.escapeHtml(name)}</strong>
      </button>
      ${bellButtonHtml(name)}
      ${indexed ? "" : listenButtonHtml(name)}
      ${indexed ? "" : `<button class="broadcast-card-icon" type="button" data-broadcast-retention="${deps.escapeHtml(name)}" title="Message retention" aria-label="Message retention">${GEAR_SVG}</button>`}
      ${indexed ? "" : `<button class="broadcast-card-leave" type="button" data-broadcast-leave="${deps.escapeHtml(name)}">Leave</button>`}
    </div>`;
}

/** One curated language room, indented under "Other Languages": native language name over the
 *  literal `#channel-name`, plus its own bell. Neither control assumes the room is joined -
 *  both join it on demand (see openRoom / the bell handler). */
function languageCardHtml(name) {
  const label = broadcastLanguageDisplayName(name) || `#${name}`;
  return `
    <div class="broadcast-card broadcast-card-language">
      <button class="broadcast-card-main" type="button" data-broadcast-open="${deps.escapeHtml(name)}">
        <strong>${deps.escapeHtml(label)}</strong>
        <span>#${deps.escapeHtml(name)}</span>
      </button>
      ${bellButtonHtml(name)}
    </div>`;
}

// iOS's list anatomy: Popular (curated, permanent - bell is the only control) pinned on top
// with the 30-day retention note beside its title and the collapsed "Other Languages" category
// at its foot, then Your Channels with a + to join/create, each row bell + retention gear +
// Leave. Note: these headers scroll away with their content - they are deliberately not sticky.
function renderChannelList() {
  if (!listEl) return;
  const own = joinedChannels
    .filter((name) => !isIndexedBroadcastChannel(name))
    .sort((a, b) => a.localeCompare(b));
  listEl.innerHTML = `
    <div class="broadcast-section-header">
      <span>Popular</span>
      <span class="broadcast-section-note">All messages persist for 30 days</span>
    </div>
    ${FEATURED_BROADCAST_CHANNELS.map((name) => channelCardHtml(name, { indexed: true })).join("")}
    <button class="broadcast-card broadcast-languages-toggle${languagesExpanded ? " expanded" : ""}" type="button"
            data-broadcast-languages-toggle aria-expanded="${languagesExpanded ? "true" : "false"}">
      <span class="broadcast-languages-globe">${GLOBE_SVG}</span>
      <strong>Other Languages</strong>
      <span class="broadcast-languages-count">${LANGUAGE_BROADCAST_CHANNELS.length}</span>
      <span class="broadcast-languages-chevron">${CHEVRON_SVG}</span>
    </button>
    ${languagesExpanded ? LANGUAGE_BROADCAST_CHANNELS.map((name) => languageCardHtml(name)).join("") : ""}
    <div class="broadcast-section-header broadcast-section-your">
      <span>Your Channels</span>
      <span style="display:flex;align-items:center;gap:8px;">
        <span class="broadcast-section-note">Live only, while open or listening</span>
        <button class="broadcast-join-toggle" type="button" data-broadcast-join-toggle aria-label="Join or create a channel">+</button>
      </span>
    </div>
    ${own.length
      ? own.map((name) => channelCardHtml(name, { indexed: false })).join("")
      : `<p class="broadcast-empty-hint">No channels yet. Tap + to join or create one.</p>`}
  `;
}

/** One broadcast bubble: header, linkified body (+ the same preview card treatment as 1:1
 *  bubbles — Nextcloud shares get the progressive video→audio→img→attachment probe), hover
 *  reaction bar, and aggregated reaction chips. */
/** Avatar + bubble row, matching 1:1/group chats: sender avatar beside every message
 *  (left for others, right for your own). */
function buildMessageRow(m) {
  const mine = m.senderAddress === deps.engine.address;
  const row = document.createElement("div");
  row.className = `broadcast-msg-row${mine ? " mine" : ""}`;
  const avatar = document.createElement("span");
  avatar.className = "broadcast-avatar-slot";
  avatar.innerHTML = deps.avatarHtmlForAddress?.(m.senderAddress, "message-avatar") || "";
  const card = buildMessageElement(m);
  if (mine) row.append(card, avatar);
  else row.append(avatar, card);
  return row;
}

function buildMessageElement(m) {
  const mine = m.senderAddress === deps.engine.address;
  const el = document.createElement("div");
  el.className = `broadcast-message${mine ? " mine" : ""}`;

  const head = document.createElement("div");
  head.className = "broadcast-message-head";
  const sender = document.createElement("strong");
  sender.dataset.broadcastSender = m.senderAddress;
  sender.textContent = senderName(m.senderAddress);
  const time = document.createElement("span");
  time.textContent = new Date(m.blockTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  head.append(sender, time);
  if (m.status === "pending") {
    const badge = document.createElement("span");
    badge.className = "broadcast-pending";
    badge.textContent = "sending…";
    head.append(badge);
  }
  if (m.status === "failed") {
    const badge = document.createElement("span");
    badge.className = "broadcast-failed";
    badge.textContent = "failed";
    head.append(badge);
  }
  el.append(head);

  // Decode the same wire envelopes 1:1 chats use - replies, photos, and voice notes all
  // arrive as JSON payloads that must never render raw.
  const replyEnvelope = deps.parseReplyEnvelope?.(m.content) || null;
  const imageEnvelope = replyEnvelope ? null : (deps.parseImageEnvelope?.(m.content) || null);
  const audioEnvelope = (replyEnvelope || imageEnvelope) ? null : (deps.parseAudioEnvelope?.(m.content) || null);

  if (replyEnvelope) {
    const quote = document.createElement("div");
    quote.className = "message-reply-quote";
    const label = document.createElement("strong");
    label.textContent = replyEnvelope.replyToSender ? `Reply to ${senderName(replyEnvelope.replyToSender)}` : "Reply";
    const preview = document.createElement("span");
    preview.textContent = replyEnvelope.replyToPreview || "Message";
    quote.append(label, preview);
    el.append(quote);
  }

  if (imageEnvelope) {
    const img = document.createElement("img");
    img.className = "broadcast-photo";
    img.src = imageEnvelope.content;
    img.alt = imageEnvelope.name || "Photo";
    img.addEventListener("click", () => deps.openPhotoPreview?.(imageEnvelope.content));
    el.append(img);
  } else if (audioEnvelope) {
    const audioWrap = document.createElement("div");
    audioWrap.className = "message-audio-bubble";
    const player = document.createElement("audio");
    player.controls = true;
    player.preload = "metadata";
    player.src = audioEnvelope.content;
    player.addEventListener("click", (event) => event.stopPropagation());
    audioWrap.append(player);
    el.append(audioWrap);
  } else {
    const body = document.createElement("div");
    body.className = "broadcast-message-body";
    const bodyText = replyEnvelope ? replyEnvelope.text : m.content;
    const urls = deps.renderTextWithLinks?.(body, bodyText) ?? [];
    if (!deps.renderTextWithLinks) body.textContent = bodyText;
    el.append(body);
    const previewable = urls.find((url) => deps.isPreviewableUrl?.(url));
    if (previewable) {
      const card = deps.buildLinkPreviewCard?.(previewable);
      if (card) el.append(card);
    }
  }

  appendReactionUi(el, m);
  // 1:1 parity: right-click opens the reactions + Reply/Copy/Hide menu.
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openBroadcastMessageMenu(m, event.clientX, event.clientY);
  });
  return el;
}

// ---------------------------------------------------------------------------
// Right-click context menu (1:1 parity): quick reactions + Reply / Copy /
// View in Explorer / Hide user. Reply-SENDING rides the same cross-platform
// reply envelope the room already renders.
// ---------------------------------------------------------------------------

let broadcastReplyTarget = null; // { txId, senderAddress, preview }

function startBroadcastReply(m) {
  broadcastReplyTarget = {
    txId: m.txId,
    senderAddress: m.senderAddress,
    preview: humanizeBroadcastContent(m.content).replace(/\s+/g, " ").slice(0, 90),
  };
  renderBroadcastReplyBanner();
  composerInput?.focus();
}

function cancelBroadcastReply() {
  broadcastReplyTarget = null;
  renderBroadcastReplyBanner();
}

function renderBroadcastReplyBanner() {
  const banner = document.querySelector("[data-broadcast-reply-banner]");
  const preview = document.querySelector("[data-broadcast-reply-preview]");
  if (!banner) return;
  banner.hidden = !broadcastReplyTarget;
  if (preview && broadcastReplyTarget) {
    preview.textContent = `Reply to ${senderName(broadcastReplyTarget.senderAddress)}: ${broadcastReplyTarget.preview}`;
  }
}

function openBroadcastMessageMenu(m, x, y) {
  if (!deps.openMsgContextMenu) return;
  const mine = m.senderAddress === deps.engine.address;
  const pending = Boolean(m.status); // pending/failed rows have no on-chain txid yet
  const myAddress = deps.engine.address || "";
  const perReactor = reactionsFor(activeChannel)[m.txId] || {};
  const myEntry = perReactor[myAddress];
  const current = myEntry && !myEntry.removed ? myEntry.emoji : null;
  const icons = deps.getMsgMenuIcons?.() || {};
  const text = humanizeBroadcastContent(m.content);
  const items = [];
  if (!pending) {
    items.push({ label: "Reply", icon: icons.reply, onClick: () => startBroadcastReply(m) });
  }
  if (text) {
    items.push({
      label: "Copy", icon: icons.copy,
      onClick: () => deps.copyText?.(text).then(() => deps.showToast?.("Message copied")).catch(() => {}),
    });
  }
  if (!pending && deps.explorerTxUrl) {
    items.push({
      label: "View in Explorer", icon: icons.explorer,
      onClick: () => window.open(deps.explorerTxUrl(m.txId), "_blank", "noopener,noreferrer"),
    });
  }
  if (!mine) {
    items.push({ label: `Hide ${senderName(m.senderAddress)}`, icon: icons.trash, danger: true, onClick: () => hideSender(m.senderAddress) });
  }
  deps.openMsgContextMenu({
    x, y,
    reaction: pending ? null : { current, onPick: (emoji) => sendBroadcastReaction(m.txId, emoji) },
    items,
  });
}

/** Human text for previews/notifications: unwrap replies, name photos/voice notes. */
function humanizeBroadcastContent(content) {
  const reply = deps.parseReplyEnvelope?.(content);
  if (reply) return reply.text || "Reply";
  if (deps.parseImageEnvelope?.(content)) return "📷 Photo";
  if (deps.parseAudioEnvelope?.(content)) return "🎤 Audio message";
  return String(content || "");
}

function appendReactionUi(el, m) {
  if (m.status) return; // pending/failed rows have no on-chain txid to react to
  const myAddress = deps.engine.address || "";
  const perReactor = reactionsFor(activeChannel)[m.txId] || {};
  const myEntry = perReactor[myAddress];
  const myCurrentEmoji = myEntry && !myEntry.removed ? myEntry.emoji : null;

  // Hover quick-reaction bar — same fixed emoji set as 1:1/iOS/Android.
  const bar = document.createElement("div");
  bar.className = "message-reaction-bar";
  const barPill = document.createElement("div");
  barPill.className = "message-reaction-bar-pill";
  for (const emoji of (typeof deps.quickReactionEmojis === "function" ? deps.quickReactionEmojis() : deps.quickReactionEmojis) || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.dataset.broadcastReact = m.txId;
    button.dataset.emoji = emoji;
    if (emoji === myCurrentEmoji) button.classList.add("active");
    barPill.append(button);
  }
  bar.append(barPill);
  el.append(bar);

  // Aggregated chips under the bubble; clicking your own active emoji removes it.
  const entries = Object.values(perReactor).filter((entry) => !entry.removed);
  if (entries.length) {
    const chips = document.createElement("div");
    chips.className = "message-reaction-pill";
    const counts = new Map();
    for (const entry of entries) counts.set(entry.emoji, (counts.get(entry.emoji) || 0) + 1);
    for (const [emoji, count] of counts) {
      const chip = document.createElement("span");
      chip.className = "message-reaction-pill-entry";
      chip.textContent = emoji;
      if (emoji === myCurrentEmoji) {
        chip.classList.add("active");
        chip.dataset.broadcastReact = m.txId;
        chip.dataset.emoji = emoji;
        chip.title = "Remove your reaction";
      }
      if (count > 1) {
        const countEl = document.createElement("span");
        countEl.className = "message-reaction-pill-count";
        countEl.textContent = String(count);
        chip.append(countEl);
      }
      // Delivery indicator on YOUR just-sent reaction: ✓ once on-chain, red ! to retry.
      const statusEl = broadcastReactionStatusEl(`${m.txId}|${emoji}`);
      if (statusEl) chip.append(statusEl);
      chips.append(chip);
    }
    el.append(chips);
    el.classList.add("has-reactions");
  }
}

function renderRoom() {
  const inRoom = Boolean(activeChannel);
  if (roomEl) roomEl.hidden = !inRoom;
  const listWrap = document.querySelector("[data-broadcast-list-wrap]");
  if (listWrap) listWrap.hidden = inRoom;
  if (!inRoom) return;

  if (roomTitleEl) roomTitleEl.textContent = `#${activeChannel}`;
  // No in-room retention banner: iOS removed it so the room reads clean. The 30-day rule is
  // stated once, beside the Popular header in the channel list.
  updateVoiceButtonVisibility();

  const hidden = hiddenIn(activeChannel);
  const messages = (messageCache[activeChannel] || []).filter((m) =>
    !hidden.has(m.senderAddress) && !deps.parseReactionEnvelope?.(m.content));
  if (roomBodyEl) {
    roomBodyEl.replaceChildren();
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "no-results-card";
      // A custom room has no history service anywhere, so "empty" here means "nothing has
      // been posted while you were watching" — say that plainly instead of leaving the room
      // looking broken or as if history were still loading.
      empty.innerHTML = isIndexedBroadcastChannel(activeChannel)
        ? `<strong>No messages yet</strong><span>Be the first to post in #${deps.escapeHtml(activeChannel)}.</span>`
        : `<strong>Listening for new messages</strong><span>#${deps.escapeHtml(activeChannel)} is a live room: messages appear here as they land on chain while it is open, or any time when background listening is on. There is no history to load.</span>`;
      roomBodyEl.append(empty);
    } else {
      // "Today"/"Yesterday"/date pill whenever the calendar day changes (iOS parity;
      // same pill class + label formatter as 1:1 and group chats).
      let lastDayKey = "";
      for (const m of messages) {
        const ts = Number(m.blockTime) || Date.now();
        const dayKey = new Date(ts).toDateString();
        if (dayKey !== lastDayKey && deps.daySeparatorLabel) {
          lastDayKey = dayKey;
          const sep = document.createElement("div");
          sep.className = "message-day-separator";
          const pill = document.createElement("span");
          pill.textContent = deps.daySeparatorLabel(ts);
          sep.append(pill);
          roomBodyEl.append(sep);
        }
        roomBodyEl.append(buildMessageRow(m));
      }
    }
    roomBodyEl.scrollTop = roomBodyEl.scrollHeight;
  }
  refreshVisibleSenderNames(messages);
}

let knsInFlight = false;
async function refreshVisibleSenderNames(messages) {
  if (knsInFlight) return;
  knsInFlight = true;
  try {
    const addresses = [...new Set(messages.slice(-30).map((m) => m.senderAddress))]
      .filter((a) => a && a !== deps.engine.address);
    let changed = false;
    for (const address of addresses) {
      const before = deps.engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || null;
      await deps.engine.fetchKnsAddressInfo?.(address).catch(() => null);
      const after = deps.engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || null;
      if (before !== after) changed = true;
    }
    if (changed && activeChannel) renderRoom();
  } finally {
    knsInFlight = false;
  }
}

function updateConnectionDot() {
  if (!roomDotEl) return;
  const status = deps.engine.connectionState?.status || deps.engine.connectionState?.state || "";
  const healthy = String(status).toLowerCase().includes("connect") || deps.engine.rpc != null;
  roomDotEl.classList.toggle("ok", healthy);
}

// ---------------------------------------------------------------------------
// Voice notes (Nextcloud only — desktop has no on-chain broadcast audio)
// ---------------------------------------------------------------------------

function updateVoiceButtonVisibility() {
  if (voiceBtn) voiceBtn.hidden = !deps.isNextcloudMediaSendActive?.();
}

function ensureVoiceRecorder() {
  if (voiceRecorder || !deps.createVoiceRecorder) return voiceRecorder;
  voiceRecorder = deps.createVoiceRecorder({
    maxDurationSeconds: () => VOICE_MAX_DURATION_SECONDS,
    onElapsed: (elapsed) => {
      if (voiceTimeEl) voiceTimeEl.textContent = deps.formatRecordingTime?.(elapsed) ?? String(Math.floor(elapsed));
    },
    onFinish: handleVoiceRecordingFinished,
  });
  return voiceRecorder;
}

async function startVoiceRecording() {
  if (!activeChannel) return;
  if (!deps.isNextcloudMediaSendActive?.()) return; // button only shows when active anyway
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const recorder = ensureVoiceRecorder();
  if (!recorder || recorder.isRecording()) return;
  voiceRecordingChannel = activeChannel;
  const error = await recorder.start();
  if (error) {
    deps.showToast?.(error);
    voiceRecordingChannel = null;
    return;
  }
  if (voiceTimeEl) voiceTimeEl.textContent = "0:00";
  if (voicePanelEl) voicePanelEl.hidden = false;
}

async function handleVoiceRecordingFinished({ blob, mimeType, cancelled }) {
  if (voicePanelEl) voicePanelEl.hidden = true;
  const channel = voiceRecordingChannel;
  voiceRecordingChannel = null;
  if (cancelled || !blob || !channel) return;
  // Upload to Nextcloud and send the share link as a plain broadcast message — recipients
  // render it as an audio card via the same link-preview probe as 1:1. No on-chain
  // fallback: on failure nothing stays staged.
  try {
    const url = await deps.uploadNextcloudMedia(blob, `voice_${Date.now()}.webm`, mimeType);
    await sendBroadcastText(channel, url);
    renderChannelList();
  } catch (error) {
    deps.showToast?.(`Voice note failed: ${error.message}`);
    deps.appendEngineLog?.(`Broadcast voice note failed: ${error.message}`);
  }
}

function cancelVoiceRecordingIfActive() {
  if (voiceRecorder?.isRecording()) voiceRecorder.stop(true);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openRoom(channel) {
  activeChannel = normalizeBroadcastChannel(channel);
  // Curated language rooms are not auto-joined, so opening one is what creates its row.
  if (activeChannel && isIndexedBroadcastChannel(activeChannel) && !joinedChannels.includes(activeChannel)) {
    joinedChannels.push(activeChannel);
    saveChannels();
    renderChannelList();
  }
  cancelBroadcastReply(); // a reply drafted in another room must not leak across
  renderRoom();
  updateConnectionDot();
  // Only the curated rooms have an indexer behind them. A custom room must never call it:
  // it serves nothing for that channel, so the request is pure noise and a failure there
  // would log a scary "backfill failed" for a room that was never meant to backfill.
  if (isIndexedBroadcastChannel(activeChannel)) {
    backfillChannel(activeChannel, { quiet: true });
    startPolling(activeChannel);
  } else {
    stopPolling();
  }
  syncScanWanted();
}

function closeRoom() {
  cancelVoiceRecordingIfActive();
  cancelBroadcastReply();
  activeChannel = null;
  stopPolling();
  syncScanWanted();
  renderRoom();
  renderChannelList();
}

function joinChannel(rawName) {
  const name = normalizeBroadcastChannel(rawName);
  if (!isValidBroadcastChannel(name)) {
    deps.showToast?.("Channel names are up to 36 characters, no spaces or colons.");
    return;
  }
  if (!joinedChannels.includes(name)) {
    joinedChannels.push(name);
    saveChannels();
  }
  const joinCard = document.querySelector("[data-broadcast-join-card]");
  if (joinCard) joinCard.hidden = true;
  if (joinInput) joinInput.value = "";
  renderChannelList();
  openRoom(name);
}

function leaveChannel(name) {
  // Indexer-backed rooms (featured + curated language) can't be left - both are permanent
  // fixtures of the list screen, so no UI offers it; this guards stray paths.
  if (isIndexedBroadcastChannel(name)) return;
  joinedChannels = joinedChannels.filter((c) => c !== name);
  saveChannels();
  delete messageCache[name];
  saveCache();
  delete reactionsCache[name];
  saveReactions();
  delete listenByChannel[name];
  saveListen();
  if (activeChannel === name) closeRoom();
  syncScanWanted();
  renderChannelList();
}

async function sendCurrentMessage() {
  if (sendInFlight || !activeChannel || !composerInput) return;
  // Broadcast messages cost KAS too — same funding popup as chats when the
  // chatting balance is a confirmed zero.
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const text = composerInput.value.trim();
  if (!text) return;
  sendInFlight = true;
  composerInput.value = "";
  const channel = activeChannel;
  // Reply mode: wrap in the exact cross-platform reply envelope the room renders.
  const replyTarget = broadcastReplyTarget;
  const content = replyTarget
    ? JSON.stringify({
        type: "reply",
        replyToId: replyTarget.txId,
        replyToSender: replyTarget.senderAddress,
        replyToPreview: replyTarget.preview,
        text,
      })
    : text;
  cancelBroadcastReply();
  try {
    await sendBroadcastText(channel, content);
    renderChannelList();
  } catch (error) {
    deps.showToast?.(error.message);
    deps.appendEngineLog?.(`Broadcast send failed: ${error.message}`);
  } finally {
    sendInFlight = false;
  }
}

/** Toggle-sends a reaction. EXACT cross-platform wire format (iOS/Android/desktop 1:1):
 *  {"type":"reaction","targetTxId":"<txid>","emoji":"<emoji>","action":"add"|"remove"} —
 *  a normal broadcast message whose content is that JSON. Applied optimistically; the
 *  send failure is non-fatal (local state stays), matching the 1:1 behavior. */
async function sendBroadcastReaction(targetTxId, emoji) {
  if (!activeChannel || !targetTxId || !emoji) return;
  const myAddress = deps.engine.address || "";
  if (!myAddress) return;
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const channel = activeChannel;
  const existing = reactionsFor(channel)[targetTxId]?.[myAddress];
  const action = existing && !existing.removed && existing.emoji === emoji ? "remove" : "add";

  recordReaction(channel, null, { targetTxId, emoji, action }, myAddress, Date.now());
  saveReactions();
  renderRoom();
  renderChannelList();

  const payload = JSON.stringify({ type: "reaction", targetTxId, emoji, action });
  // Delivery indicator only for ADDs — a removal deletes the chip (matches iOS/1:1).
  const statusKey = action === "add" ? `${targetTxId}|${emoji}` : null;
  const attempt = async () => {
    if (statusKey) setBroadcastReactionStatus(statusKey, "pending");
    try {
      const txid = await enqueueBroadcastSend(() => sendBroadcastMessage({ engine: deps.engine, channel, content: payload }));
      // Remember our own reaction tx so the next poll doesn't re-process it.
      const entry = reactionsCache[channel];
      if (entry && txid) {
        (entry.txIds ||= []).push(txid);
        saveReactions();
      }
      if (statusKey) setBroadcastReactionStatus(statusKey, "sent");
    } catch (error) {
      deps.appendEngineLog?.(`Broadcast reaction send failed (local state already applied): ${error.message}`);
      if (statusKey) setBroadcastReactionStatus(statusKey, "failed", attempt);
    }
  };
  await attempt();
}

// Reaction delivery status (1:1 parity): ✓ once on-chain (auto-hides after 60s),
// red "!" that retries on click when the send failed. In-memory only.
const broadcastReactionStatus = new Map(); // "txId|emoji" -> { status, retry }

function setBroadcastReactionStatus(key, status, retry = null) {
  broadcastReactionStatus.set(key, { status, retry });
  if (status === "sent") {
    window.setTimeout(() => {
      if (broadcastReactionStatus.get(key)?.status === "sent") {
        broadcastReactionStatus.delete(key);
        renderRoom();
      }
    }, 60_000);
  }
  renderRoom();
}

function broadcastReactionStatusEl(key) {
  const entry = broadcastReactionStatus.get(key);
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

function hideSender(address) {
  if (!activeChannel || !address || address === deps.engine.address) return;
  const set = new Set(hiddenByRoom[activeChannel] || []);
  set.add(address);
  hiddenByRoom[activeChannel] = [...set];
  saveHidden();
  renderRoom();
  deps.showToast?.("User hidden in this room");
}

function renderHiddenUsersPanel() {
  const panel = document.querySelector("[data-broadcast-hidden-panel]");
  if (!panel || !activeChannel) return;
  const addresses = hiddenByRoom[activeChannel] || [];
  panel.hidden = false;
  panel.innerHTML = `
    <div class="kaposts-thread-header"><strong>Hidden in #${deps.escapeHtml(activeChannel)}</strong>
      <button class="kaposts-view-link" type="button" data-broadcast-hidden-close>Done</button></div>
    ${addresses.length === 0
      ? `<div class="no-results-card"><strong>No hidden users</strong><span>Click a sender's name in the room to hide them here.</span></div>`
      : addresses.map((address) => `
          <div class="kaposts-notification-row">
            <div class="kaposts-notification-main"><span><strong>${deps.escapeHtml(senderName(address))}</strong></span></div>
            <button class="kaposts-view-link" type="button" data-broadcast-unhide="${deps.escapeHtml(address)}">Unhide</button>
          </div>`).join("")}`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function refreshBroadcasts() {
  tabVisible = true;
  loadState();
  renderChannelList();
  if (activeChannel) renderRoom();
  syncScanWanted();
}

export function resetBroadcastsForAccount() {
  cancelVoiceRecordingIfActive();
  stopPolling();
  activeChannel = null;
  loadState();
  syncScanWanted();
  renderChannelList();
  renderRoom();
}

/** Called when the Broadcasts tab stops being the visible tab. The open room stops
 *  polling AND stops counting as wanted; always-listen rooms keep their block scan. */
export function stopBroadcastPolling() {
  stopPolling();
  if (!deps) return;
  tabVisible = false;
  syncScanWanted();
}

/** Deep-open a channel's room from OUTSIDE this module (the global bell center). */
export function openBroadcastChannelFromNotification(channel) {
  if (!deps) return;
  const clean = normalizeBroadcastChannel(channel);
  if (!clean) return;
  loadState();
  openRoom(clean);
}

export function initBroadcasts(dependencies) {
  deps = dependencies;
  listEl = document.querySelector("[data-broadcast-list]");
  roomEl = document.querySelector("[data-broadcast-room]");
  roomTitleEl = document.querySelector("[data-broadcast-room-title]");
  roomDotEl = document.querySelector("[data-broadcast-room-dot]");
  roomBodyEl = document.querySelector("[data-broadcast-room-body]");
  // The in-room retention banner was removed for iOS parity (the room reads clean; the 30-day
  // rule is stated beside the Popular header instead). Its markup still lives in index.html —
  // drop the node so it can never render. Safe to delete the element from index.html later.
  // The banner markup is gone from index.html, but this is a PWA: a service-worker-cached
  // old shell can still carry it, so strip it at runtime too.
  document.querySelector("[data-broadcast-room-banner]")?.remove();
  composerInput = document.querySelector("[data-broadcast-input]");
  sendBtn = document.querySelector("[data-broadcast-send]");
  joinInput = document.querySelector("[data-broadcast-join-input]");
  voicePanelEl = document.querySelector("[data-broadcast-voice-panel]");
  voiceTimeEl = document.querySelector("[data-broadcast-voice-time]");
  voiceBtn = document.querySelector("[data-broadcast-voice]");
  document.querySelector("[data-broadcast-reply-cancel]")?.addEventListener("click", cancelBroadcastReply);

  loadState();
  renderChannelList();
  updateVoiceButtonVisibility();

  deps.engine.onConnectionState?.(() => updateConnectionDot());
  // Live block scanning: rows arrive in the indexer's row shape and go through the same
  // mergeMessages dedupe/retention/render path, so a message seen by both paths is stored once.
  deps.engine.onBroadcastBlockHits?.(handleBroadcastBlockHits);
  // Always-listen rooms must start scanning at launch, before the tab is ever opened.
  syncScanWanted();

  document.querySelector("[data-broadcast-join]")?.addEventListener("click", () => {
    joinChannel(joinInput?.value || "");
    if (joinInput) joinInput.value = "";
  });
  joinInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      joinChannel(joinInput.value);
      joinInput.value = "";
    }
  });

  document.querySelector("[data-broadcast-back]")?.addEventListener("click", closeRoom);
  sendBtn?.addEventListener("click", sendCurrentMessage);
  composerInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });
  document.querySelector("[data-broadcast-hidden-users]")?.addEventListener("click", renderHiddenUsersPanel);

  voiceBtn?.addEventListener("click", startVoiceRecording);
  document.querySelector("[data-broadcast-voice-stop]")?.addEventListener("click", () => voiceRecorder?.stop(false));
  document.querySelector("[data-broadcast-voice-cancel]")?.addEventListener("click", () => voiceRecorder?.stop(true));

  const screen = document.querySelector('[data-app-tab-screen="broadcasts"]');
  screen?.addEventListener("click", async (event) => {
    const react = event.target.closest("[data-broadcast-react]");
    if (react) {
      event.stopPropagation();
      sendBroadcastReaction(react.dataset.broadcastReact, react.dataset.emoji);
      return;
    }

    const leave = event.target.closest("[data-broadcast-leave]");
    if (leave) {
      event.stopPropagation();
      if (await confirmText(`Leave #${leave.dataset.broadcastLeave}?\n\nLeaving this broadcast permanently deletes every message cached for it on this device. This cannot be undone. Rejoining later starts with no history.`)) {
        leaveChannel(leave.dataset.broadcastLeave);
      }
      return;
    }

    // "Other Languages": the collapsed category of curated language rooms under Popular.
    const languagesToggle = event.target.closest("[data-broadcast-languages-toggle]");
    if (languagesToggle) {
      event.stopPropagation();
      languagesExpanded = !languagesExpanded;
      renderChannelList();
      return;
    }

    // The bell: OS notifications for new messages in this channel.
    const notify = event.target.closest("[data-broadcast-notify]");
    if (notify) {
      event.stopPropagation();
      const name = notify.dataset.broadcastNotify;
      // Curated language rooms are not auto-joined - the bell creates the row on demand, so
      // the very first tap turns notifications ON rather than silently creating an off row.
      if (isIndexedBroadcastChannel(name) && !joinedChannels.includes(name)) {
        joinedChannels.push(name);
        saveChannels();
      }
      if (notifyByChannel[name]) {
        delete notifyByChannel[name];
        deps.showToast?.(`Notifications off for #${name}.`);
      } else {
        notifyByChannel[name] = true;
        // Make sure the OS-level permission is actually granted so the pings can fire.
        deps.ensureNotificationPermission?.();
        deps.showToast?.(`Notifications on for #${name}. You will be notified of every new message.`);
      }
      saveNotify();
      renderChannelList();
      return;
    }

    // Always-listen (own channels): keep this room's live block scan running with its screen
    // closed. Off, a custom room only receives while you are looking at it.
    const listen = event.target.closest("[data-broadcast-listen]");
    if (listen) {
      event.stopPropagation();
      const name = listen.dataset.broadcastListen;
      if (listenByChannel[name]) {
        delete listenByChannel[name];
        deps.showToast?.(`#${name} now receives only while the room is open.`);
      } else {
        listenByChannel[name] = true;
        deps.showToast?.(`Listening to #${name} in the background. New messages arrive with the room closed.`);
      }
      saveListen();
      syncScanWanted();
      renderChannelList();
      return;
    }

    // Retention gear (own channels): how long cached messages are kept on this device.
    const retention = event.target.closest("[data-broadcast-retention]");
    if (retention) {
      event.stopPropagation();
      const name = retention.dataset.broadcastRetention;
      const current = Number(retentionByChannel[name] || 0);
      const answer = await promptText(
        `Keep #${name} messages for how many days on this device?\n0 = keep forever. Older messages are deleted from this device only.`,
        String(current),
      );
      if (answer == null) return;
      const days = Math.max(0, Math.floor(Number(answer)));
      if (!Number.isFinite(days)) return;
      if (days > 0) retentionByChannel[name] = days;
      else delete retentionByChannel[name];
      saveRetention();
      pruneCache();
      saveCache();
      saveReactions();
      renderChannelList();
      deps.showToast?.(days > 0 ? `#${name}: keeping ${days} day${days === 1 ? "" : "s"} of messages.` : `#${name}: keeping messages forever.`);
      return;
    }

    // + in the "Your Channels" header: reveal the join/create card (iOS's join alert).
    const joinToggle = event.target.closest("[data-broadcast-join-toggle]");
    if (joinToggle) {
      event.stopPropagation();
      const card = document.querySelector("[data-broadcast-join-card]");
      if (card) {
        card.hidden = !card.hidden;
        if (!card.hidden) joinInput?.focus();
      }
      return;
    }

    const open = event.target.closest("[data-broadcast-open]");
    if (open) { openRoom(open.dataset.broadcastOpen); return; }

    const sender = event.target.closest("[data-broadcast-sender]");
    if (sender) {
      const address = sender.dataset.broadcastSender;
      if (address && address !== deps.engine.address &&
          await confirmText(`Hide ${senderName(address)} in #${activeChannel}? Their messages disappear from this room only.`)) {
        hideSender(address);
      }
      return;
    }

    const unhide = event.target.closest("[data-broadcast-unhide]");
    if (unhide) {
      hiddenByRoom[activeChannel] = (hiddenByRoom[activeChannel] || []).filter((a) => a !== unhide.dataset.broadcastUnhide);
      saveHidden();
      renderHiddenUsersPanel();
      renderRoom();
      return;
    }

    const hiddenClose = event.target.closest("[data-broadcast-hidden-close]");
    if (hiddenClose) {
      const panel = document.querySelector("[data-broadcast-hidden-panel]");
      if (panel) panel.hidden = true;
    }
  });
}
