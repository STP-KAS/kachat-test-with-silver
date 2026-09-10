// KaPosts tab UI — desktop port of iOS's KaPostsView. Self-contained: app.js calls
// initKaPosts(...) once with the shared helpers, and everything else lives here.
//
// State model mirrors iOS/Android: local session posts (optimistic composer output) overlay
// the indexer feed until their txids round-trip; post/quote/like/dislike submits are held
// behind a 5-second undo countdown — cancel and nothing ever touches the network.

import {
  KAPOSTS_POST_CHARACTER_LIMIT,
  fetchFollowingFeed,
  fetchFollowList,
  fetchGlobalFeed,
  fetchKaPostNotifications,
  fetchKaPostUserDetails,
  fetchPostEngagement,
  fetchReplies,
  fetchUserPosts,
  fetchUserReplies,
  decodePostContent,
  nextPageCursor,
  stripKaChatMarker,
  kaspaAddressFromPubkey,
  requesterPubkeyFor,
  submitKaPost,
  submitKaPostFollow,
  submitKaPostQuote,
  submitKaPostReply,
  submitKaPostUnquote,
  submitKaPostVote,
} from "../engine/kaposts.js";
// Imported, not a string path: Vite only rewrites and emits assets it can SEE, and a path inside
// a template literal is invisible to it - which left this 404ing on the built site.
import kaspaLogoUrl from "./assets/kaspa-logo.png";

const UNDO_DELAY_MS = 5000;
const KAPOSTS_PREFS_KEY = "kachat-kaposts-prefs-v1"; // { following:[], muted:[], blocked:[] } — account-scoped

let deps = null; // { engine, escapeHtml, shortAddress, accountScopedKey, showToast, appendEngineLog }

// DOM
let feedEl, statusEl, tabsEl, threadEl, threadRootEl, threadRepliesEl, toastsEl;
let composerEl, composerInput, composerMeter, composerSubmit, composerTitle, composerQuote;
let replyInput, replyMeter, replySend;

// State
let activeFeedTab = "feed";
let panelEl, panelTitleEl, panelBodyEl, popoverEl;
// activePanel: null | {type:"profile", address, pubkey, tab, posts, replies, details, loading}
//            | {type:"notifications", items, loading}
//            | {type:"engagement", postId, postTxId, tab, lists, loading}
//            | {type:"list", kind}  (bookmarks | muted | blocked | menu)
let activePanel = null;
let myContentPosts = []; // own posts+replies fetched for share/notification resolution
let localPosts = [];      // newest first, optimistic
let remotePosts = [];
let feedLoading = false;
let feedError = null;
let prefs = { following: [], muted: [], blocked: [] };
let threadStack = [];     // post ids (local ids)
// A panel opened from INSIDE an open thread (Post Activity, a poster's profile) presents OVER
// the thread and its Back returns to the thread — the desktop stand-in for the sheets iOS
// presents from the thread's own hierarchy. False = the thread owns the viewport.
let panelOverThread = false;
// Reply-notification landing: the txid of the reply to scroll to once the parent thread's
// comment list contains it, and the txid currently flashing after that landing.
let pendingThreadScrollRemoteId = null;
let threadHighlightRemoteId = null;
let threadHighlightTimer = 0;
let replyTargetId = null; // in-thread: which comment the reply bar targets (null = the root post)
let composerQuoteTarget = null; // post being quoted, when the composer is a quote composer
let countdownTicker = null;
let savedFeedScroll = 0;

// Endless-scroll state (see the "Endless scrolling" section below)
let feedPager = null;
let feedGeneration = 0;   // bumped on every reload/tab switch/account reset — stale-response guard
let threadGeneration = 0;
let panelGeneration = 0;
let lastFeedLoadAt = 0;
let renderedFeedIds = new Set(); // what the feed DOM currently holds, so appends never duplicate
const threadPagers = new Map();  // post id -> pager (a nested thread keeps its own cursor)

function kapostsScrollEl() {
  return document.querySelector(".kaposts-content");
}

function rememberFeedScroll() {
  // Only when actually LEAVING the feed (not when moving between thread levels/panels).
  if (threadStack.length === 0 && !activePanel) {
    savedFeedScroll = kapostsScrollEl()?.scrollTop || 0;
  }
}

function restoreFeedScroll() {
  requestAnimationFrame(() => {
    const el = kapostsScrollEl();
    if (el && threadStack.length === 0 && !activePanel) el.scrollTop = savedFeedScroll;
  });
}

// key -> { deadline, timer, undo() } — pending 5s-undo actions
const pendingActions = new Map();

function nowId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`;
}

// ---------------------------------------------------------------------------
// Persistence (per account)
// ---------------------------------------------------------------------------

function loadPrefs() {
  try {
    const raw = localStorage.getItem(deps.accountScopedKey(KAPOSTS_PREFS_KEY));
    const parsed = raw ? JSON.parse(raw) : null;
    prefs = {
      following: Array.isArray(parsed?.following) ? parsed.following : [],
      muted: Array.isArray(parsed?.muted) ? parsed.muted : [],
      blocked: Array.isArray(parsed?.blocked) ? parsed.blocked : [],
    };
  } catch {
    prefs = { following: [], muted: [], blocked: [] };
  }
}

function savePrefs() {
  localStorage.setItem(deps.accountScopedKey(KAPOSTS_PREFS_KEY), JSON.stringify(prefs));
}

function isHiddenAuthor(address) {
  return prefs.muted.includes(address) || prefs.blocked.includes(address);
}

// ---------------------------------------------------------------------------
// Identity (contact custom name > KNS primary > short address; .kas stripped)
// ---------------------------------------------------------------------------

function posterName(address) {
  if (!address) return "Unknown";
  // Your saved contact name wins, then their KNS domain, then the short address —
  // same order iOS resolves display names for notifications and posts.
  const alias = deps.contactAliasFor?.(address);
  if (alias) return alias.toLowerCase().endsWith(".kas") ? alias.slice(0, -4) : alias;
  const info = deps.engine.peekKnsAddressInfo?.(address);
  const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
  if (domain) return domain.toLowerCase().endsWith(".kas") ? domain.slice(0, -4) : domain;
  return deps.shortAddress(address);
}

function posterAvatarHtml(address) {
  const avatarUrl = deps.engine.peekKnsAddressProfile?.(address)?.profile?.avatarUrl;
  if (avatarUrl) {
    return `<span class="kaposts-avatar"><img src="${deps.escapeHtml(avatarUrl)}" alt="" loading="lazy" /></span>`;
  }
  // Person glyph fallback (4.0 look — no initials).
  return `<span class="kaposts-avatar kaposts-avatar-fallback" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.118a7.5 7.5 0 0 1 15 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.5-1.632Z"/></svg></span>`;
}

/**
 * KNS names/avatars for a batch of freshly appended rows. Goes through the engine's
 * refreshKnsIfNeeded — ONE pass that dedupes, skips addresses already cached and honours
 * the per-address backoff — never a request per post. Re-renders only when it actually
 * fetched something (the caller's render reads the warm cache synchronously via peek*).
 */
let knsRefreshInFlight = false;
async function resolvePosterIdentities(addresses, onResolved) {
  if (!deps?.engine?.refreshKnsIfNeeded) return;
  const unique = [...new Set((addresses || []).filter(Boolean))].slice(0, 60);
  if (unique.length === 0) return;
  const fetched = await deps.engine.refreshKnsIfNeeded(unique).catch(() => 0);
  if (fetched) onResolved?.();
}

async function refreshVisiblePosterNames() {
  if (knsRefreshInFlight) return;
  knsRefreshInFlight = true;
  try {
    await resolvePosterIdentities(visibleFeedPosts().slice(0, 30).map((p) => p.posterAddress), () => renderFeed());
  } finally {
    knsRefreshInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Endless scrolling (shared paginator)
// ---------------------------------------------------------------------------
//
// Every KaPosts list is server-paginated with an opaque cursor ({hasMore, nextCursor}) but
// CLIENT-FILTERED afterwards: engine/kaposts.js keeps only KaChat-marked content, then muted
// and blocked authors drop out here, then the Following tab intersects with the local follow
// list and the profile Posts tab drops replies. A 50-row page can therefore yield ZERO
// visible rows, so "one fetch per sentinel hit" would either stall forever or thrash. Instead
// runPager keeps pulling pages until it has PAGER_TARGET_ROWS NEW VISIBLE rows or the server
// runs out — capped at PAGER_MAX_REQUESTS requests per trigger so one scroll can never
// stampede the indexer.

const PAGER_PAGE_SIZE = 50;
const PAGER_THREAD_PAGE_SIZE = 100;
const PAGER_TARGET_ROWS = 18;
const PAGER_MAX_REQUESTS = 5;
const PAGER_MAX_UNPRODUCTIVE = 3; // consecutive all-filtered triggers before we ask for a tap
const FEED_FRESH_MS = 90_000;

function makePager({ pageSize = PAGER_PAGE_SIZE, target = PAGER_TARGET_ROWS } = {}) {
  return {
    cursor: null,
    hasMore: true,
    loading: false,
    error: null,
    stalled: false,
    unproductive: 0,
    seen: new Set(), // raw server ids already absorbed — dedupe across pages
    pageSize,
    target,
  };
}

/** Primes a pager from the surface's FIRST page (the one the open/refresh path fetched). */
function seedPager(pager, rawItems, pagination, idOf = (item) => item?.id) {
  if (!pager) return;
  pager.seen = new Set();
  for (const item of rawItems || []) {
    const id = idOf(item);
    if (id) pager.seen.add(String(id));
  }
  pager.cursor = nextPageCursor(pagination);
  pager.hasMore = Boolean(pager.cursor);
  pager.loading = false;
  pager.error = null;
  pager.stalled = false;
  pager.unproductive = 0;
}

/**
 * The filter-shrinkage loop. `fetchPage(before, limit)` returns {items, pagination};
 * `absorb(freshItems)` merges them into the surface's model, paints them and returns how many
 * VISIBLE rows that produced; `isStale()` reports whether the surface has moved on (tab
 * switch, panel close, thread pop, account change) — a stale response is dropped whole and
 * the cursor is left untouched, so the surface that comes back is never fed the old list's
 * rows. Exactly one run per pager at a time.
 */
async function runPager(pager, { fetchPage, absorb, isStale, onUpdate, idOf = (item) => item?.id }) {
  if (!pager || pager.loading || pager.stalled || !pager.hasMore || pager.error) return;
  pager.loading = true;
  onUpdate?.();
  let addedVisible = 0;
  let requests = 0;
  try {
    while (pager.hasMore && addedVisible < pager.target && requests < PAGER_MAX_REQUESTS) {
      requests += 1;
      const cursor = pager.cursor;
      const page = await fetchPage(cursor, pager.pageSize);
      if (isStale()) return; // drop the response AND keep the cursor where it was
      const items = Array.isArray(page?.items) ? page.items : [];
      const fresh = [];
      for (const item of items) {
        const id = idOf(item);
        if (!id) continue;
        const key = String(id);
        if (pager.seen.has(key)) continue;
        pager.seen.add(key);
        fresh.push(item);
      }
      const next = nextPageCursor(page?.pagination);
      pager.cursor = next;
      // Stop when the server runs out, repeats its cursor, or hands back a page we have
      // already absorbed in full — an indexer that silently ignored `before` would
      // otherwise re-serve page one forever.
      pager.hasMore = Boolean(next) && next !== cursor && !(items.length > 0 && fresh.length === 0);
      addedVisible += absorb(fresh) || 0;
    }
  } catch (error) {
    if (!isStale()) pager.error = error?.message || "Could not load more posts.";
    deps.appendEngineLog?.(`KaPosts load-more failed: ${error?.message || error}`);
  } finally {
    pager.loading = false;
    if (!isStale()) {
      // Nothing visible came back but the server still has rows: allow a few more automatic
      // sweeps, then fall back to an explicit "Load more" so we never spin on a feed whose
      // every page is filtered away.
      pager.unproductive = addedVisible > 0 ? 0 : pager.unproductive + 1;
      pager.stalled = pager.hasMore && !pager.error && pager.unproductive >= PAGER_MAX_UNPRODUCTIVE;
      onUpdate?.();
    }
  }
}

// --- sentinel + IntersectionObserver lifecycle -----------------------------

const pagerObservers = new Map(); // sentinel key -> IntersectionObserver
const pagerLoaders = new Map();   // sentinel key -> { pager, load } (for the retry button)

/** Nearest scrolling ancestor, so rootMargin prefetch works inside .kaposts-panel-body too. */
function scrollRootFor(element) {
  let node = element?.parentElement;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

function clearPagerSentinel(key) {
  pagerObservers.get(key)?.disconnect();
  pagerObservers.delete(key);
  pagerLoaders.delete(key);
}

function clearPanelPagerSentinels() {
  for (const key of ["profile-posts", "profile-replies", "notifications", "engagement"]) {
    clearPagerSentinel(key);
  }
}

function clearAllPagerSentinels() {
  for (const observer of pagerObservers.values()) observer.disconnect();
  pagerObservers.clear();
  pagerLoaders.clear();
}

function pagerFooterHtml(pager, key) {
  if (pager.loading) {
    return `<span class="kaposts-pager-spinner" aria-hidden="true"></span><span>Loading more…</span>`;
  }
  if (pager.error) {
    return `<span class="kaposts-pager-error">${deps.escapeHtml(pager.error)}</span>
            <button type="button" data-kaposts-pager-retry="${deps.escapeHtml(key)}">Retry</button>`;
  }
  if (pager.stalled) {
    return `<button type="button" data-kaposts-pager-retry="${deps.escapeHtml(key)}">Load more</button>`;
  }
  return "";
}

/**
 * (Re)places the bottom sentinel for `key` inside `container` and re-arms its observer.
 * Called at the END of every render of that surface — because the module rewrites list
 * innerHTML, the previous sentinel node is detached, and re-arming here (after an explicit
 * disconnect) is what keeps observers from leaking across views. Once the surface reports
 * end-of-list the sentinel is removed and nothing is observed at all.
 */
function mountPagerSentinel(key, container, pager, load) {
  clearPagerSentinel(key);
  container?.querySelector?.(`[data-kaposts-sentinel="${key}"]`)?.remove();
  if (!container || !pager) return;
  if (!pager.hasMore && !pager.loading && !pager.error) return; // end reached — stop observing
  const sentinel = document.createElement("div");
  sentinel.className = "kaposts-pager";
  sentinel.dataset.kapostsSentinel = key;
  sentinel.innerHTML = pagerFooterHtml(pager, key);
  container.appendChild(sentinel);
  pagerLoaders.set(key, { pager, load });
  if (pager.loading || pager.error || pager.stalled) return; // busy or waiting on the user
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) load();
  }, { root: scrollRootFor(sentinel), rootMargin: "0px 0px 600px 0px" });
  observer.observe(sentinel);
  pagerObservers.set(key, observer);
}

function retryPager(key) {
  const entry = pagerLoaders.get(key);
  if (!entry) return;
  entry.pager.error = null;
  entry.pager.stalled = false;
  entry.pager.unproductive = 0;
  entry.load();
}

// ---------------------------------------------------------------------------
// Feed data
// ---------------------------------------------------------------------------

function mapRemotePost(post) {
  const content = decodePostContent(post);
  const address = kaspaAddressFromPubkey(deps.engine, post.userPublicKey);
  if (content === null || !address) return null;
  let quoted = null;
  if (post.quote?.referencedSenderPubkey) {
    const quotedText = post.quote.referencedMessage ? decodePostContent({ postContent: post.quote.referencedMessage }) : null;
    const quotedAddress = kaspaAddressFromPubkey(deps.engine, post.quote.referencedSenderPubkey);
    if (quotedText !== null && quotedAddress) {
      quoted = { remoteId: post.quote.referencedContentId || null, text: stripKaChatMarker(quotedText), posterAddress: quotedAddress };
    }
  }
  return {
    id: `remote-${post.id}`, // stable identity across refreshes
    remoteId: post.id,
    posterPubkey: post.userPublicKey,
    posterAddress: address,
    text: stripKaChatMarker(content),
    timestamp: Number(post.timestamp) || Date.now(),
    likes: post.upVotesCount || 0,
    dislikes: post.downVotesCount || 0,
    reposts: post.quotesCount || 0,
    likedByMe: post.isUpvoted === true,
    dislikedByMe: post.isDownvoted === true,
    repostedByMe: false,
    remoteReplyCount: post.repliesCount || 0,
    comments: [],
    quoted,
    parentRemoteId: post.parentPostId || null,
    delivery: "sent",
  };
}

function fetchFeedPage(before, limit = PAGER_PAGE_SIZE) {
  const args = { engine: deps.engine, limit, before };
  // "Popular" is the global feed re-sorted client-side, so it pages the same endpoint.
  return activeFeedTab === "following" ? fetchFollowingFeed(args) : fetchGlobalFeed(args);
}

/** Page one. Resets the endless-scroll window: new cursor, cleared end-reached, top of list. */
// One-shot per session: rebuild the LOCAL follow set from the on-chain follow graph. Every
// Follow button and the Following tab filter read prefs.following, which lives only in
// localStorage — a cleared profile left users "following 0" with Follow buttons beside
// people they already follow on-chain. Chain entries are only ever ADDED (never removed),
// so a just-clicked local unfollow the indexer hasn't caught up on can't be resurrected.
let followingChainSynced = false;
async function syncFollowingFromChain() {
  if (followingChainSynced) return;
  followingChainSynced = true;
  try {
    const pubkey = safeRequesterPubkey();
    if (!pubkey) { followingChainSynced = false; return; }
    const raw = await fetchFollowList({ engine: deps.engine, pubkey, followers: false, limit: 500 });
    const merged = new Set(prefs.following);
    for (const item of raw || []) {
      const rowPubkey = item?.userPublicKey || item?.publicKey || item?.pubkey || item?.followedPubkey || item?.user || "";
      const address = item?.address || kaspaAddressFromPubkey(deps.engine, rowPubkey) || "";
      if (address) merged.add(address);
    }
    merged.delete(deps.engine.address || "");
    if (merged.size !== prefs.following.length) {
      prefs.following = [...merged];
      savePrefs();
      renderAll();
    }
  } catch {
    followingChainSynced = false; // network miss — retry on the next feed load
  }
}

async function loadFeed() {
  syncFollowingFromChain();
  // The KaPosts tab can be clicked before initKaPosts has run (startup awaits storage/engine
  // first) — deps is still null then, and every deps.* access below would throw.
  if (!deps) return;
  const generation = ++feedGeneration; // any in-flight page from the previous tab is now stale
  clearPagerSentinel("feed");
  feedPager = makePager();
  feedLoading = true;
  feedError = null;
  renderStatus();
  try {
    const result = await fetchFeedPage(null);
    if (generation !== feedGeneration) return;
    remotePosts = result.posts.map(mapRemotePost).filter(Boolean);
    seedPager(feedPager, result.posts, result.pagination);
  } catch (error) {
    if (generation !== feedGeneration) return;
    feedError = error?.message || "Could not load the feed.";
    feedPager.hasMore = false;
    deps.appendEngineLog?.(`KaPosts feed load failed: ${feedError}`);
  } finally {
    if (generation === feedGeneration) {
      feedLoading = false;
      lastFeedLoadAt = Date.now();
      renderStatus();
      renderFeed({ resetScroll: true });
      refreshVisiblePosterNames();
    }
  }
}

/** Sentinel hit at the bottom of the feed — keeps paging until ~a screenful is visible. */
function loadMoreFeed() {
  if (!deps || !feedPager) return;
  const generation = feedGeneration;
  const pager = feedPager; // a tab switch swaps the module-level one out from under us
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const result = await fetchFeedPage(before, limit);
      return { items: result.posts, pagination: result.pagination };
    },
    absorb: (fresh) => {
      const mapped = fresh.map(mapRemotePost).filter(Boolean);
      const known = new Set(remotePosts.map((post) => post.remoteId));
      const added = mapped.filter((post) => post.remoteId && !known.has(post.remoteId));
      remotePosts = [...remotePosts, ...added];
      const rendered = appendFeedRows(); // mute/block + Following-list filtering happens here
      resolvePosterIdentities(added.map((post) => post.posterAddress), () => renderFeed());
      return rendered;
    },
    isStale: () => generation !== feedGeneration,
    onUpdate: () => {
      if (generation === feedGeneration) mountPagerSentinel("feed", feedEl, pager, loadMoreFeed);
    },
  });
}

function visibleFeedPosts() {
  const combined = [
    ...localPosts,
    ...remotePosts.filter((r) => !localPosts.some((l) => l.remoteId && l.remoteId === r.remoteId)),
  ].filter((p) => !isHiddenAuthor(p.posterAddress));
  if (activeFeedTab === "following") return combined.filter((p) => prefs.following.includes(p.posterAddress));
  if (activeFeedTab === "popular") {
    return [...combined].sort((a, b) => (b.likes + b.reposts + b.dislikes) - (a.likes + a.reposts + a.dislikes));
  }
  return combined;
}

// Tree helpers (posts + nested comments)
function allPostLists() {
  const extra = [];
  if (activePanel?.type === "profile") {
    extra.push(...(activePanel.posts || []), ...(activePanel.replies || []));
  }
  return [...localPosts, ...remotePosts, ...myContentPosts, ...extra];
}

/**
 * Depth-first lookup over every collection that can hold a post node. Thread-chain copies are
 * searched LAST (iOS findPost): segments beyond the first live ONLY in threadChains, and
 * without that fallback a like/bookmark tap on a chain segment resolved to nothing at all.
 */
function findPostWhere(match) {
  const search = (list) => {
    for (const post of list || []) {
      if (match(post)) return post;
      const hit = search(post.comments);
      if (hit) return hit;
    }
    return null;
  };
  const hit = search(allPostLists());
  if (hit) return hit;
  for (const chain of threadChains.values()) {
    const chainHit = search(chain);
    if (chainHit) return chainHit;
  }
  return null;
}

function findPost(id) {
  return findPostWhere((post) => post.id === id);
}

/**
 * Applies `transform` to EVERY node carrying this id, in every collection and at any depth
 * (iOS mutatePost). Remote ids are a stable hash of the txid, so one post routinely exists as
 * several DISTINCT objects at once — a feed row, a comment nested under its parent, and a
 * thread-chain segment. Stopping at the first match updated whichever twin the search order
 * hit first, so a like/dislike/repost/bookmark made inside an open thread landed on the feed
 * twin and the thread kept rendering the untouched node until it was closed and reopened.
 * Nodes are de-duplicated by OBJECT identity: the same object can be reachable through two
 * lists (a chain segment is also its parent's comment), and a counter must not be bumped twice.
 */
function mutatePost(id, transform) {
  const visited = new Set();
  const walk = (list) => {
    for (const post of list || []) {
      if (!post || visited.has(post)) continue;
      visited.add(post);
      if (post.id === id) transform(post);
      walk(post.comments);
    }
  };
  walk(allPostLists());
  // The open thread's "Thread" section renders from threadChains copies, so sweep them too.
  for (const chain of threadChains.values()) walk(chain);
}

function findPostByRemoteId(remoteId) {
  return findPostWhere((post) => post.remoteId === remoteId);
}

/** Widens the resolution pool without dropping what it already holds (dedupe by txid). */
function mergeIntoResolutionPool(mapped) {
  const known = new Set(myContentPosts.map((post) => post.remoteId).filter(Boolean));
  const fresh = (mapped || []).filter((post) => post.remoteId && !known.has(post.remoteId));
  if (fresh.length) myContentPosts = [...myContentPosts, ...fresh];
}

/**
 * Own posts + replies into the resolution pool. Deep-link/notification targets are usually
 * YOUR content, which lives outside the feed window, and a reply notification's PARENT
 * always is. Returns false when there is nothing to fetch with.
 */
async function loadOwnContentIntoResolutionPool() {
  const pubkey = safeRequesterPubkey();
  if (!pubkey) return false;
  try {
    const [ownPosts, ownReplies] = await Promise.all([
      fetchUserPosts({ engine: deps.engine, pubkey }),
      fetchUserReplies({ engine: deps.engine, pubkey }).catch(() => ({ posts: [] })),
    ]);
    mergeIntoResolutionPool([...ownPosts.posts, ...ownReplies.posts].map(mapRemotePost).filter(Boolean));
    return true;
  } catch (error) {
    deps.appendEngineLog?.(`KaPost own-content fetch failed: ${error.message}`);
    return false;
  }
}

/**
 * A resolved deep-link/notification target that is itself a REPLY opens its PARENT's thread —
 * the post that was replied to on top, the reply itself scrolled into view below — instead of
 * presenting the bare reply as a context-free thread root (iOS openResolvedPost). The parent
 * resolves from what is already loaded, then from own posts+replies; when it still cannot be
 * found, the reply's own thread opens as before.
 */
async function openResolvedPost(post, { parentRemoteIdHint = null, ownContentLoaded = false } = {}) {
  const parentId = post.parentRemoteId || parentRemoteIdHint || null;
  if (!parentId || parentId === post.remoteId) {
    closePanel();
    openThread(post);
    return;
  }
  let parent = findPostByRemoteId(parentId);
  if (!parent && !ownContentLoaded) {
    await loadOwnContentIntoResolutionPool();
    parent = findPostByRemoteId(parentId);
  }
  closePanel();
  if (parent) openThread(parent, { scrollToRemoteId: post.remoteId });
  else openThread(post);
}

/**
 * Shared-link/notification landing: resolve a txid to a loaded post — loaded lists first,
 * then a feed refresh, then OWN content from the indexer (notification targets are almost
 * always your posts, which live outside the feed window). Matches iOS's openSharedPost.
 */
async function resolveAndOpenPost(txId, { parentRemoteIdHint = null } = {}) {
  let post = findPostByRemoteId(txId);
  let ownContentLoaded = false;
  if (!post) {
    await loadFeed();
    post = findPostByRemoteId(txId);
  }
  if (!post) {
    ownContentLoaded = await loadOwnContentIntoResolutionPool();
    post = findPostByRemoteId(txId);
  }
  if (!post) {
    // Still unresolved: the txid is usually a notification's ACTING content — someone
    // ELSE's reply/quote/mentioning post, which neither the feed window nor the own-content
    // fetch above ever returns (there is no fetch-post-by-id endpoint). The notification
    // stream knows who wrote it, so fetch THAT author's posts+replies and search those.
    try {
      const { notifications } = await fetchKaPostNotifications({ engine: deps.engine, limit: 100 });
      const n = (notifications || []).find((x) => String(x?.id || "") === String(txId));
      if (n?.userPublicKey) {
        const [theirPosts, theirReplies] = await Promise.all([
          fetchUserPosts({ engine: deps.engine, pubkey: n.userPublicKey }).catch(() => ({ posts: [] })),
          fetchUserReplies({ engine: deps.engine, pubkey: n.userPublicKey }).catch(() => ({ posts: [] })),
        ]);
        const mapped = [...theirPosts.posts, ...theirReplies.posts].map(mapRemotePost).filter(Boolean);
        // myContentPosts is purely the resolution pool behind findPostByRemoteId —
        // widening it with the actor's content is safe (nothing renders it directly).
        mergeIntoResolutionPool(mapped);
        post = findPostByRemoteId(txId);
        // For a reply notification the stream's contentId IS the parent — pass it through in
        // case the fetched mapping lost parentPostId.
        if (post && n.contentType === "reply" && n.contentId) parentRemoteIdHint = String(n.contentId);
        // A reply's own thread can open directly; but when the target still isn't
        // findable, fall back to the conversation it belongs to (the parent post) — that
        // parent IS the thread to show, so it opens as the root rather than resolving
        // one level further up.
        if (!post && n.contentId) {
          const parent = findPostByRemoteId(String(n.contentId));
          if (parent) {
            closePanel();
            openThread(parent);
            return;
          }
        }
      }
    } catch (error) {
      deps.appendEngineLog?.(`KaPost actor-content fetch failed: ${error.message}`);
    }
  }
  if (post) {
    await openResolvedPost(post, { parentRemoteIdHint, ownContentLoaded });
  } else {
    deps.showToast?.("Post not found — it may be older than the feed window.");
  }
}

// ---------------------------------------------------------------------------
// 5-second undo scheduler
// ---------------------------------------------------------------------------

/** `label` overrides the key-derived toast wording (a like and an un-like share one key). */
function scheduleUndoable(key, action, undo = null, label = null) {
  cancelUndoable(key);
  const timer = setTimeout(() => {
    pendingActions.delete(key);
    stopTickerIfIdle();
    // Repaint every surface NOW rather than trusting the action to do it. The countdown is
    // not only a toast: countdownOrIconHtml swaps it in for the like/repost icon inside the
    // post cell itself, so the cell has to be re-rendered for the icon to come back. The
    // action re-renders at best one surface, and only after its network round trip, which
    // left a dead countdown frozen at 1 on the cell.
    renderAll();
    action();
  }, UNDO_DELAY_MS);
  pendingActions.set(key, { deadline: Date.now() + UNDO_DELAY_MS, timer, undo, label });
  startTicker();
  renderAll();
}

function cancelUndoable(key) {
  const pending = pendingActions.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingActions.delete(key);
  pending.undo?.();
  stopTickerIfIdle();
  renderAll();
}

function startTicker() {
  if (countdownTicker) return;
  countdownTicker = setInterval(() => {
    document.querySelectorAll("[data-kaposts-countdown]").forEach((el) => {
      const key = el.dataset.kapostsCountdown;
      const pending = pendingActions.get(key);
      if (pending) el.textContent = String(Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000)));
    });
  }, 200);
}

function stopTickerIfIdle() {
  if (pendingActions.size === 0 && countdownTicker) {
    clearInterval(countdownTicker);
    countdownTicker = null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderFeed();
  renderThread();
  renderToasts();
}

function renderStatus() {
  if (!statusEl) return;
  if (feedLoading && remotePosts.length === 0) {
    statusEl.hidden = false;
    statusEl.textContent = "Loading the feed…";
  } else if (feedError && remotePosts.length === 0) {
    statusEl.hidden = false;
    statusEl.textContent = feedError;
  } else {
    statusEl.hidden = true;
  }
}

function countdownOrIconHtml(key, iconHtml) {
  const pending = pendingActions.get(key);
  if (pending) {
    // Real remaining seconds, not a hardcoded 5: any re-render mid-countdown (a sibling
    // action, an arriving post) would otherwise flash the badge back to 5 until the next tick.
    const seconds = Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000));
    return `<span class="kaposts-countdown" data-kaposts-countdown="${deps.escapeHtml(key)}">${seconds}</span>`;
  }
  return iconHtml;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** Escapes text and wraps URLs in clickable spans (confirmation popover on click). */
// @mention token: `@domain` (optionally dotted, optional .kas), not part of an email — must be
// at the start or follow whitespace / an opening bracket-quote. Matches the indexer spec so what
// highlights here is exactly what triggers a mention notification server-side.
const MENTION_PATTERN = /(^|[\s([{<"'])@([a-z0-9-]+(?:\.[a-z0-9-]+)*)/gi;

// Escape a plain-text run, but wrap any @mention tokens in a highlight span first.
function escapeWithMentions(rawText) {
  const value = String(rawText || "");
  let out = "";
  let last = 0;
  for (const m of value.matchAll(MENTION_PATTERN)) {
    const lead = m[1] || "";
    const domain = m[2];
    const at = m.index + lead.length; // index of the '@'
    out += deps.escapeHtml(value.slice(last, at));
    out += `<span class="kaposts-mention" data-kaposts-mention="${deps.escapeHtml(domain.toLowerCase())}">@${deps.escapeHtml(domain)}</span>`;
    last = at + 1 + domain.length;
  }
  out += deps.escapeHtml(value.slice(last));
  return out;
}

// Resolve the @mentions in a post's text to the compressed pubkeys the indexer needs in
// mentioned_pubkeys. Chatted contacts resolve from the local candidate list; ANYONE else with
// a KNS domain resolves live (owner address -> pubkey). Unresolvable tokens stay plain text.
async function mentionedPubkeysFor(text) {
  const domains = [];
  const seenDomains = new Set();
  for (const m of String(text || "").matchAll(MENTION_PATTERN)) {
    const domain = m[2].toLowerCase().replace(/\.kas$/, "");
    if (domain && !seenDomains.has(domain)) { seenDomains.add(domain); domains.push(domain); }
  }
  if (!domains.length) return [];
  const byDomain = new Map((deps.getMentionCandidates?.() || []).map((c) => [c.domain.toLowerCase(), c.pubkey]));
  const found = new Set();
  for (const domain of domains) {
    let pubkey = byDomain.get(domain) || null;
    if (!pubkey) {
      try {
        const resolution = await deps.engine.resolveKnsDomain?.(domain);
        if (resolution?.ownerAddress) pubkey = deps.engine.kapostPubkeyForAddress?.(resolution.ownerAddress) || null;
      } catch { /* unresolvable: plain text */ }
    }
    if (pubkey) found.add(pubkey);
  }
  return [...found];
}

// Tapped @mention anywhere in KaPosts: resolve the KNS domain and open that user's profile
// (any KNS holder, contact or not - never-posted owners get an honest empty profile).
async function openMentionProfile(domain) {
  try {
    const resolution = await deps.engine.resolveKnsDomain?.(domain);
    if (!resolution?.ownerAddress) { deps.showToast?.(`Couldn't resolve @${domain}.`); return; }
    const pubkey = deps.engine.kapostPubkeyForAddress?.(resolution.ownerAddress) || null;
    openPosterProfile(resolution.ownerAddress, pubkey);
  } catch (error) {
    deps.showToast?.(error?.message || `Couldn't resolve @${domain}.`);
  }
}

function linkifyPostText(text) {
  const value = String(text || "");
  let result = "";
  let last = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    result += escapeWithMentions(value.slice(last, match.index));
    const url = match[0];
    result += `<span class="kaposts-link" data-kaposts-link="${deps.escapeHtml(url)}">${deps.escapeHtml(url)}</span>`;
    last = match.index + url.length;
  }
  result += escapeWithMentions(value.slice(last));
  return result;
}

const ICONS = {
  comment: `<svg viewBox="0 0 24 24"><path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM21 12c0 4.556-4.03 8.25-9 8.25a9.76 9.76 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"/></svg>`,
  repost: `<svg viewBox="0 0 24 24"><path d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"/></svg>`,
  like: `<svg viewBox="0 0 24 24"><path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/></svg>`,
  dislike: `<svg viewBox="0 0 24 24"><path d="M7.498 15.25H4.372c-1.026 0-1.945-.694-2.054-1.715a12.137 12.137 0 0 1-.068-1.285c0-2.848.992-5.464 2.649-7.521C5.287 4.247 5.886 4 6.504 4h4.016a4.5 4.5 0 0 1 1.423.23l3.114 1.04a4.5 4.5 0 0 0 1.423.23h1.294M7.498 15.25c.618 0 .991.724.725 1.282A7.471 7.471 0 0 0 7.5 19.75 2.25 2.25 0 0 0 9.75 22a.75.75 0 0 0 .75-.75v-.633c0-.573.11-1.14.322-1.672.304-.76.93-1.33 1.653-1.715a9.04 9.04 0 0 0 2.86-2.4c.498-.634 1.226-1.08 2.032-1.08h.384m-10.253 1.5H9.7m8.075-9.75c.01.05.027.1.05.148.593 1.2.925 2.55.925 3.977 0 1.487-.36 2.89-.999 4.125m.023-8.25c-.076-.365.183-.75.575-.75h.908c.889 0 1.713.518 1.972 1.368.339 1.11.521 2.287.521 3.507 0 1.553-.295 3.036-.831 4.398-.306.774-1.086 1.227-1.918 1.227h-1.053c-.472 0-.745-.556-.5-.96a8.95 8.95 0 0 0 .303-.54"/></svg>`,
  share: `<svg viewBox="0 0 24 24"><path d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>`,
  bookmark: `<svg viewBox="0 0 24 24"><path d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z"/></svg>`,
  tip: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.25"/><path d="M13.8 9.4c-.4-.7-1.1-1.15-2-1.15-1.24 0-2.05.83-2.05 1.83 0 1 .8 1.5 2.05 1.8 1.25.3 2.05.8 2.05 1.8 0 1-.81 1.84-2.05 1.84-.9 0-1.6-.45-2-1.15M11.85 6.7v10.6"/></svg>`,
};

function postCellHtml(post, { inThread = false, isRoot = false, replyInline = false } = {}) {
  const name = posterName(post.posterAddress);
  const time = formatRelativeTime(post.timestamp);
  const isMine = post.posterAddress === deps.engine.address;
  const isFollowing = prefs.following.includes(post.posterAddress);
  const isLong = post.text.length > 280 || (post.text.match(/\n/g) || []).length >= 8;
  const foldText = !inThread && isLong;
  const commentCount = Math.max(post.remoteReplyCount || 0, post.comments.filter((c) => !isHiddenAuthor(c.posterAddress)).length);

  const deliveryHtml = post.delivery === "pending"
    ? `<div class="kaposts-delivery">Posting…</div>`
    : post.delivery === "failed"
      ? `<div class="kaposts-delivery failed">Failed to post. <button type="button" data-kaposts-retry="${post.id}">Retry</button></div>`
      : "";

  const quotedHtml = post.quoted
    ? `<div class="kaposts-quote-embed" ${post.quoted.remoteId ? `data-kaposts-open-remote="${deps.escapeHtml(post.quoted.remoteId)}"` : ""}>
         <strong>${deps.escapeHtml(posterName(post.quoted.posterAddress))}</strong>
         <span>${deps.escapeHtml(post.quoted.text || "Reposted")}</span>
       </div>`
    : "";

  return `
    <article class="kaposts-cell${isRoot ? " root" : ""}${!isRoot ? " openable" : ""}" data-kaposts-post="${post.id}"${post.remoteId ? ` data-kaposts-remote-id="${deps.escapeHtml(post.remoteId)}"` : ""}${!isRoot ? ` data-kaposts-open="${post.id}"` : ""}>
      <span data-kaposts-profile="${post.id}" class="kaposts-avatar-tap">${posterAvatarHtml(post.posterAddress)}</span>
      <div class="kaposts-cell-main">
        <div class="kaposts-cell-head">
          <strong class="kaposts-cell-name" data-kaposts-profile="${post.id}">${deps.escapeHtml(name)}</strong>
          <span class="kaposts-cell-time">${deps.escapeHtml(time)}</span>
          ${!isMine ? `<button class="kaposts-follow${isFollowing ? " following" : ""}" type="button" data-kaposts-follow="${post.id}">${isFollowing ? "Following" : "Follow"}</button>` : ""}
          <button class="kaposts-action kaposts-more" type="button" data-kaposts-more="${post.id}" aria-label="More">
            <svg viewBox="0 0 24 24"><path d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/></svg>
          </button>
        </div>
        <div class="kaposts-cell-text${foldText ? " folded" : ""}">${linkifyPostText(post.text)}</div>
        ${foldText ? `<button class="kaposts-show-more" type="button" data-kaposts-open="${post.id}">Show more</button>` : ""}
        ${quotedHtml}
        ${deliveryHtml}
        <div class="kaposts-actions">
          <button class="kaposts-action" type="button" ${replyInline ? `data-kaposts-reply-to="${post.id}"` : `data-kaposts-open="${post.id}"`} title="${replyInline ? "Reply" : "Replies"}">
            ${ICONS.comment}${commentCount > 0 ? `<span>${commentCount}</span>` : ""}
          </button>
          <button class="kaposts-action${post.repostedByMe ? " active-repost" : ""}" type="button" data-kaposts-repost="${post.id}" title="Repost">
            ${countdownOrIconHtml(`repost:${post.id}`, ICONS.repost)}${post.reposts > 0 ? `<span>${post.reposts}</span>` : ""}
          </button>
          <button class="kaposts-action${post.likedByMe ? " active-like" : ""}" type="button" data-kaposts-like="${post.id}" title="Like">
            ${countdownOrIconHtml(`like:${post.id}`, ICONS.like)}${post.likes > 0 ? `<span>${post.likes}</span>` : ""}
          </button>
          <button class="kaposts-action${post.dislikedByMe ? " active-dislike" : ""}" type="button" data-kaposts-dislike="${post.id}" title="Dislike">
            ${countdownOrIconHtml(`dislike:${post.id}`, ICONS.dislike)}${post.dislikes > 0 ? `<span>${post.dislikes}</span>` : ""}
          </button>
          <button class="kaposts-action${post.bookmarkedByMe ? " active-bookmark" : ""}" type="button" data-kaposts-bookmark="${post.id}" title="${post.bookmarkedByMe ? "Remove Bookmark" : "Bookmark"}">${ICONS.bookmark}</button>
          ${post.remoteId ? `<button class="kaposts-action" type="button" data-kaposts-share="${post.id}" title="Copy share link">${ICONS.share}</button>` : ""}
          ${isMine ? "" : `<button class="kaposts-action kaposts-tip" type="button" data-kaposts-tip="${post.id}" title="Send a Kaspa tip"><img class="kaposts-tip-logo" src="${kaspaLogoUrl}" alt="" aria-hidden="true" /><span>Tip</span></button>`}
        </div>
        ${!inThread && isThreadRootPost(post) ? `<button class="kaposts-view-thread" type="button" data-kaposts-open="${post.id}">⤷ View thread</button>` : ""}
      </div>
    </article>`;
}

function engagementScore(post) {
  return (post.likes || 0) + (post.reposts || 0) + (post.dislikes || 0);
}

/**
 * Full repaint. Keeps the scroll position by default — a like or a countdown tick calls
 * renderAll(), and with hundreds of paged-in rows a rewrite that jumped to the top would be
 * unusable. Only page-one loads pass resetScroll.
 */
function renderFeed({ resetScroll = false } = {}) {
  if (!feedEl) return;
  const scroller = kapostsScrollEl();
  const previousTop = scroller?.scrollTop || 0;
  const posts = visibleFeedPosts();
  if (posts.length === 0 && !feedLoading && !feedError) {
    renderedFeedIds = new Set();
    feedEl.innerHTML = `
      <div class="no-results-card">
        <strong>${activeFeedTab === "following" ? "Nothing here yet" : "No posts yet"}</strong>
        <span>${activeFeedTab === "following"
          ? "Follow people from their posts and their content shows up here."
          : "Be the first to post something on the Kaspa network."}</span>
      </div>`;
  } else {
    renderedFeedIds = new Set(posts.map((post) => post.id));
    feedEl.innerHTML = posts.map((post) => postCellHtml(post)).join("");
  }
  // While page one is in flight the status line owns the loading state — no sentinel yet, or
  // it would fire a second request for the same page.
  mountPagerSentinel("feed", feedEl, feedLoading ? null : feedPager, loadMoreFeed);
  if (scroller) scroller.scrollTop = resetScroll ? 0 : previousTop;
  // Thread-root probes for commented posts (throttled, once per post per session) so the
  // "View thread" link can appear on other people's threads too.
  probeThreadRoots(posts);
}

/**
 * Appends only the rows the DOM does not have yet, above the sentinel — never a rebuild, so
 * the scroll position is untouched. Returns how many rows actually landed (0 when the whole
 * page was muted/blocked/unfollowed away, which is what drives the shrinkage loop).
 */
function appendFeedRows() {
  if (!feedEl) return 0;
  const posts = visibleFeedPosts().filter((post) => !renderedFeedIds.has(post.id));
  if (posts.length === 0) return 0;
  if (renderedFeedIds.size === 0) { renderFeed(); return posts.length; } // replaces the empty card
  // Popular sorts client-side over the loaded window; a batch is ranked within itself and
  // parked below what is already on screen (a refresh re-sorts everything).
  const ordered = activeFeedTab === "popular"
    ? [...posts].sort((a, b) => engagementScore(b) - engagementScore(a))
    : posts;
  const html = ordered.map((post) => postCellHtml(post)).join("");
  const sentinel = feedEl.querySelector('[data-kaposts-sentinel="feed"]');
  if (sentinel) sentinel.insertAdjacentHTML("beforebegin", html);
  else feedEl.insertAdjacentHTML("beforeend", html);
  for (const post of ordered) renderedFeedIds.add(post.id);
  return ordered.length;
}

function updateReplyContext() {
  const chip = document.querySelector("[data-kaposts-reply-context]");
  const label = document.querySelector("[data-kaposts-reply-context-label]");
  if (!chip) return;
  const target = replyTargetId ? findPost(replyTargetId) : null;
  const topId = threadStack[threadStack.length - 1];
  const isNested = target && target.id !== topId;
  chip.hidden = !isNested;
  if (isNested && label) label.textContent = `Replying to ${posterName(target.posterAddress)}`;
}

/**
 * The feed, the thread and the panel are `flex: 1` SIBLINGS in one scroller, so any two of
 * them visible at once produce a stacked split view with two back headers. Exactly one wins,
 * decided here in one place (both renderThread and renderPanel route through it):
 *
 *  - a panel opened from the rail/feed wins whenever no thread is open;
 *  - a thread opened FROM a panel (profile row, bookmark) takes the viewport over, and the
 *    panel returns when the thread stack empties;
 *  - a panel opened from INSIDE a thread (Post Activity, a poster's profile) is presented
 *    OVER the thread — `panelOverThread` — and its Back returns to the thread, mirroring the
 *    nested sheets iOS presents from the thread's own hierarchy.
 */
function syncSurfaces(threadPost) {
  const hasThread = Boolean(threadPost);
  const showPanel = Boolean(activePanel) && (!hasThread || panelOverThread);
  const showThread = hasThread && !showPanel;
  const showFeed = !showPanel && !showThread;
  if (threadEl) threadEl.hidden = !showThread;
  if (panelEl) panelEl.hidden = !showPanel;
  if (feedEl) feedEl.hidden = !showFeed;
  if (tabsEl) tabsEl.hidden = !showFeed;
}

function currentThreadPost() {
  const topId = threadStack[threadStack.length - 1];
  return topId ? findPost(topId) : null;
}

function renderThread() {
  const post = currentThreadPost();
  const showThread = Boolean(post);
  syncSurfaces(post);
  if (!showThread) clearPagerSentinel("thread");
  if (!post || !threadRootEl) return;
  if (replyTargetId && !findPost(replyTargetId)) replyTargetId = null;
  const scroller = kapostsScrollEl();
  const previousTop = scroller?.scrollTop || 0;
  // Thread segments are the author's own continuation - they render as a connected section
  // under the root and are excluded from the replies list (segment 2 IS a direct reply).
  const chain = threadChains.get(post.id) || [];
  const chainIds = new Set(chain.map((segment) => segment.remoteId).filter(Boolean));
  const comments = post.comments.filter((c) => !isHiddenAuthor(c.posterAddress)
    && !(c.remoteId && chainIds.has(c.remoteId)));
  updateReplyContext();
  if (threadRootEl) {
    threadRootEl.innerHTML = postCellHtml(post, { inThread: true, isRoot: true, replyInline: true })
      + (chain.length ? `
      <div class="kaposts-thread-chain">
        <div class="kaposts-thread-chain-header">Thread · ${chain.length + 1} posts</div>
        ${chain.map((segment) => `<div class="kaposts-thread-chain-item">${postCellHtml(segment, { inThread: true, replyInline: true })}</div>`).join("")}
      </div>` : "");
  }
  if (threadRepliesEl) {
    threadRepliesEl.innerHTML = `
      <div class="kaposts-thread-replies">
        ${comments.map((comment) => `
          <div class="kaposts-thread-reply">
            ${postCellHtml(comment, { inThread: true, replyInline: true })}
            ${comment.remoteReplyCount > 0 || comment.comments.length > 0
              ? `<button class="kaposts-show-more" type="button" data-kaposts-open="${comment.id}">View replies</button>`
              : ""}
          </div>`).join("")}
      </div>`;
    const pager = threadPagers.get(post.id);
    mountPagerSentinel("thread", threadRepliesEl, pager, () => loadMoreThreadReplies(post.id));
    // The replies list is rebuilt whole (comment counts and countdowns live in every row),
    // so hold the scroll position explicitly or paging in older replies would jump the view.
    if (scroller) scroller.scrollTop = previousTop;
  }
  // Runs AFTER the scroll restore above, which would otherwise undo the landing scroll.
  applyPendingThreadScroll();
  applyThreadHighlight();
}

/** The rendered cell for a txid inside the open thread (replies first, then root/chain). */
function threadCellElementFor(remoteId) {
  if (!remoteId || !threadEl) return null;
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(remoteId) : remoteId;
  const selector = `[data-kaposts-remote-id="${escaped}"]`;
  return threadRepliesEl?.querySelector(selector) || threadEl.querySelector(selector);
}

/**
 * Reply-notification landing: the parent's thread is open, so as soon as the reply itself is
 * in the comment list, bring it into view and flash it. Stays pending until the reply lands
 * (openThread's reply fetch re-renders), and is cleared by the next openThread either way.
 */
function applyPendingThreadScroll() {
  // Measuring a hidden thread (a panel is presented over it) yields zero-sized rects — the
  // landing waits until the thread is the surface on screen again.
  if (!pendingThreadScrollRemoteId || !threadEl || threadEl.hidden) return;
  const target = threadCellElementFor(pendingThreadScrollRemoteId);
  const scroller = kapostsScrollEl();
  if (!target || !scroller) return;
  threadHighlightRemoteId = pendingThreadScrollRemoteId;
  pendingThreadScrollRemoteId = null;
  requestAnimationFrame(() => {
    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const centering = Math.max(0, (scroller.clientHeight - targetRect.height) / 2);
    scroller.scrollTop += targetRect.top - scrollerRect.top - centering;
    applyThreadHighlight();
  });
  window.clearTimeout(threadHighlightTimer);
  threadHighlightTimer = window.setTimeout(() => {
    threadHighlightRemoteId = null;
    threadEl?.querySelectorAll(".kaposts-cell-highlight")
      .forEach((el) => el.classList.remove("kaposts-cell-highlight"));
  }, 2600);
}

/** Re-applies the landing flash after a re-render rebuilt the replies list from scratch. */
function applyThreadHighlight() {
  if (!threadHighlightRemoteId) return;
  threadCellElementFor(threadHighlightRemoteId)?.classList.add("kaposts-cell-highlight");
}

/** Toast label per pending-action key: EVERY interaction gets a visible undo toast. */
function toastLabelFor(key) {
  if (key.startsWith("post:quote")) return "Posting quote";
  if (key.startsWith("post:")) return "Posting";
  if (key.startsWith("like:")) return "Liking";
  if (key.startsWith("dislike:")) return "Disliking";
  if (key.startsWith("repost:")) return "Reposting";
  if (key.startsWith("comment:")) return "Posting comment";
  return "Posting";
}

function renderToasts() {
  if (!toastsEl) return;
  const parts = [];
  for (const [key, pending] of pendingActions) {
    const seconds = Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000));
    parts.push(`
      <div class="kaposts-toast">
        <span class="kaposts-countdown" data-kaposts-countdown="${deps.escapeHtml(key)}">${seconds}</span>
        <span>${deps.escapeHtml(pending.label || toastLabelFor(key))}</span>
        <button type="button" data-kaposts-undo="${deps.escapeHtml(key)}">Undo</button>
      </div>`);
  }
  toastsEl.innerHTML = parts.join("");
}

function formatRelativeTime(timestampMs) {
  const delta = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)}d`;
  return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function makeLocalPost(text, { quotedOf = null } = {}) {
  return {
    id: nowId(),
    remoteId: null,
    posterPubkey: safeRequesterPubkey(),
    posterAddress: deps.engine.address || "",
    text,
    timestamp: Date.now(),
    likes: 0, dislikes: 0, reposts: 0,
    likedByMe: false, dislikedByMe: false, repostedByMe: false,
    remoteReplyCount: 0,
    comments: [],
    quoted: quotedOf
      ? { remoteId: quotedOf.remoteId, text: quotedOf.text, posterAddress: quotedOf.posterAddress, posterPubkey: quotedOf.posterPubkey || null }
      : null,
    parentRemoteId: null,
    delivery: "pending",
  };
}

function safeRequesterPubkey() {
  try { return requesterPubkeyFor(deps.engine); } catch { return null; }
}

function schedulePost(text) {
  const post = makeLocalPost(text);
  localPosts.unshift(post);
  const key = `post:${post.id}`;
  scheduleUndoable(key, async () => {
    renderToasts();
    try {
      const txid = await submitKaPost({ engine: deps.engine, text, mentionedPubkeys: await mentionedPubkeysFor(text) });
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
    } catch (error) {
      mutatePost(post.id, (p) => { p.delivery = "failed"; });
      deps.appendEngineLog?.(`KaPost submit failed: ${error.message}`);
    }
    renderAll();
  }, () => {
    localPosts = localPosts.filter((p) => p.id !== post.id);
  });
}

// --- X-style thread reading ---------------------------------------------------
// remoteId -> "its replies include one by the author" (thread root). false is cached too, so a
// post is probed at most once per session.
const threadRootProbe = new Map();
// root post local id -> [segment posts] (the author's own continuation, in order).
const threadChains = new Map();

function isThreadRootPost(post) {
  if (post?.isThreadRoot) return true;
  return Boolean(post?.remoteId && threadRootProbe.get(post.remoteId));
}

// Cheap feed probe, a few posts per render pass: first reply page, any self-authored reply =
// thread root (X's own "Show this thread" heuristic).
function probeThreadRoots(posts) {
  const candidates = (posts || []).filter((p) => p.remoteId
    && !threadRootProbe.has(p.remoteId)
    && ((p.remoteReplyCount || 0) > 0 || (p.comments || []).length > 0)).slice(0, 10);
  if (!candidates.length) return;
  (async () => {
    let found = false;
    for (const post of candidates) {
      if (threadRootProbe.has(post.remoteId)) continue;
      threadRootProbe.set(post.remoteId, false); // claim: never probe twice
      try {
        const page = await fetchReplies({ engine: deps.engine, postId: post.remoteId, limit: 10 });
        const isThread = (page?.posts || []).some((reply) => {
          const mapped = mapRemotePost(reply);
          return mapped && mapped.posterAddress === post.posterAddress;
        });
        if (isThread) { threadRootProbe.set(post.remoteId, true); found = true; }
      } catch { /* stays false */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (found) renderFeed();
  })();
}

// Walks the author's self-reply chain from an opened root (root <- seg2 <- seg3 ... by the
// same author), fetching each next link. Capped defensively.
async function loadSelfThreadChain(post) {
  if (!post?.remoteId) return;
  const chain = [];
  let current = (post.comments || [])
    .filter((c) => c.remoteId && c.posterAddress === post.posterAddress)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0] || null;
  let hops = 0;
  while (current && hops < 25) {
    chain.push(current);
    hops += 1;
    if (!current.remoteId) break;
    let page = null;
    try { page = await fetchReplies({ engine: deps.engine, postId: current.remoteId, limit: 25 }); }
    catch { break; }
    current = (page?.posts || []).map(mapRemotePost).filter(Boolean)
      .filter((reply) => reply.posterAddress === post.posterAddress)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0] || null;
  }
  threadChains.set(post.id, chain);
  if (chain.length) threadRootProbe.set(post.remoteId, true);
}

// --- X-style thread posting --------------------------------------------------
// Unposted work per in-flight/failed thread, keyed by the root's LOCAL id: rootText until the
// root posts, the remaining segments, and the last landed txid. Kept until every segment lands
// so Retry RESUMES the chain from the first unposted segment (never duplicates).
const threadRemainders = new Map();

// Consecutive payload txs spend each other's change before the node indexes it (~1s blocks) -
// retry a few times with settle delays before giving up.
async function submitWithUtxoRetry(op) {
  let attempt = 0;
  for (;;) {
    try { return await op(); }
    catch (error) {
      attempt += 1;
      if (attempt > 4) throw error;
      deps.appendEngineLog?.(`KaPost thread segment retry ${attempt}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

// First segment = top-level post, each following segment = reply to the PREVIOUS one.
// Threads submit sequentially right away (each segment needs the previous txid) - no 5s undo;
// the optimistic root carries pending/sent/failed for the whole chain.
function scheduleThread(segments) {
  if (!segments.length) return;
  if (segments.length === 1) { schedulePost(segments[0]); return; }
  const post = makeLocalPost(segments[0]);
  post.isThreadRoot = true;
  localPosts.unshift(post);
  threadRemainders.set(post.id, { rootText: segments[0], segments: segments.slice(1), parentTxId: null });
  renderAll();
  continueThread(post.id);
}

async function continueThread(localId) {
  const state = threadRemainders.get(localId);
  if (!state) return;
  mutatePost(localId, (p) => { p.delivery = "pending"; });
  renderAll();
  try {
    if (state.rootText != null) {
      const rootText = state.rootText;
      const txid = await submitWithUtxoRetry(async () =>
        submitKaPost({ engine: deps.engine, text: rootText, mentionedPubkeys: await mentionedPubkeysFor(rootText) }));
      mutatePost(localId, (p) => { p.remoteId = txid; });
      state.rootText = null;
      state.parentTxId = txid;
    }
    const myPubkey = safeRequesterPubkey();
    while (state.segments.length && state.parentTxId) {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // let the previous change settle
      const segment = state.segments[0];
      const txid = await submitWithUtxoRetry(async () =>
        submitKaPostReply({
          engine: deps.engine, text: segment, postId: state.parentTxId, parentAuthorPubkey: myPubkey,
          mentionedPubkeys: await mentionedPubkeysFor(segment),
        }));
      state.segments.shift();
      state.parentTxId = txid;
    }
    threadRemainders.delete(localId);
    mutatePost(localId, (p) => { p.delivery = "sent"; });
  } catch (error) {
    mutatePost(localId, (p) => { p.delivery = "failed"; });
    deps.appendEngineLog?.(`KaPost thread submit failed (resumable): ${error.message}`);
  }
  renderAll();
}

function scheduleQuote(target, text) {
  const post = makeLocalPost(text, { quotedOf: target });
  localPosts.unshift(post);
  const key = `post:quote-${post.id}`;
  scheduleUndoable(key, async () => {
    renderToasts();
    mutatePost(target.id, (p) => { if (!p.repostedByMe) { p.repostedByMe = true; p.reposts += 1; } });
    try {
      const txid = await submitKaPostQuote({
        engine: deps.engine, text, contentId: target.remoteId, quotedAuthorPubkey: target.posterPubkey,
      });
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
      deps.showToast?.("Quote posted to the network");
    } catch (error) {
      mutatePost(post.id, (p) => { p.delivery = "failed"; });
      deps.appendEngineLog?.(`KaPost quote failed: ${error.message}`);
    }
    renderAll();
  }, () => {
    localPosts = localPosts.filter((p) => p.id !== post.id);
  });
}

/** Same optimistic-now / submit-after-the-countdown rule as toggleVote. */
function scheduleRepost(target) {
  const key = `repost:${target.id}`;
  if (pendingActions.has(key)) { cancelUndoable(key); return; }
  const wasReposted = (findPost(target.id) || target).repostedByMe === true;
  if (!wasReposted) {
    mutatePost(target.id, (p) => { p.repostedByMe = true; p.reposts = (p.reposts || 0) + 1; });
    renderAll();
  }
  scheduleUndoable(key, async () => {
    try {
      await submitKaPostQuote({ engine: deps.engine, text: "", contentId: target.remoteId, quotedAuthorPubkey: target.posterPubkey });
      deps.showToast?.("Repost posted to the network");
    } catch (error) {
      deps.appendEngineLog?.(`KaPost repost failed: ${error.message}`);
    }
  }, () => {
    if (!wasReposted) {
      mutatePost(target.id, (p) => { p.repostedByMe = false; p.reposts = Math.max(0, (p.reposts || 0) - 1); });
    }
  });
}

function playVoteBurst(postId, kind) {
  const selector = kind === "like" ? `[data-kaposts-like="${postId}"]` : `[data-kaposts-dislike="${postId}"]`;
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.remove("kaposts-burst");
    void button.offsetWidth; // restart the animation
    button.classList.add("kaposts-burst");
    if (kind === "like") spawnKaspaLogoBurst(button);
  });
}

/** iOS-style like celebration: a burst of little Kaspa logos flying out of the heart. */
function spawnKaspaLogoBurst(anchor) {
  const rect = anchor.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const count = 7;
  for (let i = 0; i < count; i += 1) {
    const particle = document.createElement("img");
    particle.src = kaspaLogoUrl;
    particle.alt = "";
    particle.className = "kaposts-logo-particle";
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const distance = 34 + Math.random() * 26;
    particle.style.left = `${originX}px`;
    particle.style.top = `${originY}px`;
    particle.style.setProperty("--burst-x", `${Math.cos(angle) * distance}px`);
    particle.style.setProperty("--burst-y", `${Math.sin(angle) * distance - 14}px`);
    particle.style.setProperty("--burst-rot", `${(Math.random() - 0.5) * 240}deg`);
    document.body.appendChild(particle);
    particle.addEventListener("animationend", () => particle.remove());
    // Safety net in case animationend never fires (tab hidden etc.).
    setTimeout(() => particle.remove(), 1200);
  }
}

/**
 * Like/dislike. The state change is OPTIMISTIC and lands immediately — filled icon, bumped
 * count, burst — on every copy of the post; only the on-chain submit waits out the 5s undo
 * countdown, and Undo reverts the state it applied. Deferring the mutation to the end of the
 * countdown (as this used to) read as a dead button for five seconds, worst of all inside an
 * open thread. Tapping the same button again while the countdown runs cancels it and rolls
 * the state back, exactly like pressing Undo.
 */
function toggleVote(post, kind) {
  const flag = kind === "like" ? "likedByMe" : "dislikedByMe";
  const other = kind === "like" ? "dislikedByMe" : "likedByMe";
  const count = kind === "like" ? "likes" : "dislikes";
  const otherCount = kind === "like" ? "dislikes" : "likes";
  const key = `${kind}:${post.id}`;
  if (pendingActions.has(key)) { cancelUndoable(key); return; }
  const current = findPost(post.id) || post;
  const wasSet = current[flag] === true;
  const clearedOther = !wasSet && current[other] === true;
  mutatePost(post.id, (p) => {
    if (wasSet) { p[flag] = false; p[count] = Math.max(0, (p[count] || 0) - 1); }
    else {
      p[flag] = true; p[count] = (p[count] || 0) + 1;
      if (clearedOther) { p[other] = false; p[otherCount] = Math.max(0, (p[otherCount] || 0) - 1); }
    }
  });
  renderAll();
  if (!wasSet) playVoteBurst(post.id, kind);
  scheduleUndoable(key, async () => {
    if (!post.remoteId || !post.posterPubkey) return;
    try {
      const vote = wasSet ? "unvote" : (kind === "like" ? "upvote" : "downvote");
      await submitKaPostVote({ engine: deps.engine, postId: post.remoteId, vote, authorPubkey: post.posterPubkey });
      deps.showToast?.(wasSet ? "Vote removed on the network" : `${kind === "like" ? "Like" : "Dislike"} posted to the network`);
    } catch (error) {
      deps.appendEngineLog?.(`KaPost vote failed: ${error.message}`);
    }
  }, () => {
    mutatePost(post.id, (p) => {
      if (wasSet) { p[flag] = true; p[count] = (p[count] || 0) + 1; }
      else {
        p[flag] = false; p[count] = Math.max(0, (p[count] || 0) - 1);
        if (clearedOther) { p[other] = true; p[otherCount] = (p[otherCount] || 0) + 1; }
      }
    });
  }, wasSet
    ? (kind === "like" ? "Removing like" : "Removing dislike")
    : (kind === "like" ? "Liking" : "Disliking"));
}

function toggleFollow(post) {
  const address = post.posterAddress;
  if (!address || address === deps.engine.address) return;
  const willFollow = !prefs.following.includes(address);
  prefs.following = willFollow ? [...prefs.following, address] : prefs.following.filter((a) => a !== address);
  savePrefs();
  renderAll();
  if (!post.posterPubkey) return;
  submitKaPostFollow({ engine: deps.engine, follow: willFollow, followedPubkey: post.posterPubkey })
    .then(() => deps.showToast?.(willFollow ? "Follow posted to the network" : "Unfollow posted to the network"))
    .catch((error) => deps.appendEngineLog?.(`KaPost follow failed: ${error.message}`));
}

/**
 * `scrollToRemoteId` is the reply-notification landing: this thread is the PARENT of the reply
 * that was tapped, so once the comment list actually contains that reply it is scrolled into
 * view and flashed. It is cleared on every normal open, so a stale target from an earlier
 * landing can never yank a later thread around (iOS pendingThreadScrollRemoteId).
 */
async function openThread(post, { scrollToRemoteId = null } = {}) {
  rememberFeedScroll();
  pendingThreadScrollRemoteId = scrollToRemoteId;
  // A thread always takes over the viewport: any panel it was opened from waits underneath.
  panelOverThread = false;
  threadStack.push(post.id);
  renderThread();
  if (!post.remoteId) return;
  const generation = ++threadGeneration;
  const pager = makePager({ pageSize: PAGER_THREAD_PAGE_SIZE });
  threadPagers.set(post.id, pager);
  try {
    const result = await fetchReplies({ engine: deps.engine, postId: post.remoteId, limit: PAGER_THREAD_PAGE_SIZE });
    if (generation !== threadGeneration) return;
    const replies = result.posts.map(mapRemotePost).filter(Boolean);
    seedPager(pager, result.posts, result.pagination);
    mutatePost(post.id, (p) => {
      const localOnly = p.comments.filter((c) => !c.remoteId || !replies.some((r) => r.remoteId === c.remoteId));
      p.comments = [...replies, ...localOnly];
    });
    renderThread();
    resolvePosterIdentities(replies.map((reply) => reply.posterAddress), () => {
      if (threadStack[threadStack.length - 1] === post.id) renderThread();
    });
    // Walk the author's own continuation (if any) so the Thread section can render.
    await loadSelfThreadChain(findPost(post.id) || post);
    if (generation === threadGeneration) renderThread();
  } catch (error) {
    if (generation !== threadGeneration) return;
    pager.hasMore = false;
    deps.appendEngineLog?.(`KaPost replies load failed: ${error.message}`);
    renderThread();
  }
}

/** Sentinel hit under a thread's comments — pages older replies in. */
function loadMoreThreadReplies(postId) {
  const post = findPost(postId);
  const pager = threadPagers.get(postId);
  if (!post?.remoteId || !pager) return;
  const generation = threadGeneration;
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const result = await fetchReplies({ engine: deps.engine, postId: post.remoteId, limit, before });
      return { items: result.posts, pagination: result.pagination };
    },
    absorb: (fresh) => {
      const mapped = fresh.map(mapRemotePost).filter(Boolean);
      let added = 0;
      mutatePost(postId, (p) => {
        const known = new Set(p.comments.map((c) => c.remoteId).filter(Boolean));
        const rows = mapped.filter((reply) => reply.remoteId && !known.has(reply.remoteId));
        p.comments = [...p.comments, ...rows];
        // mutatePost now visits EVERY copy of this post and each carries its own comments
        // array, so the copies can disagree on how many rows were new — the pager's shrinkage
        // loop wants the largest, not whichever copy happened to be visited last.
        added = Math.max(added, rows.filter((reply) => !isHiddenAuthor(reply.posterAddress)).length);
      });
      renderThread();
      resolvePosterIdentities(mapped.map((reply) => reply.posterAddress), () => {
        if (threadStack[threadStack.length - 1] === postId) renderThread();
      });
      return added;
    },
    isStale: () => generation !== threadGeneration || threadStack[threadStack.length - 1] !== postId,
    onUpdate: () => renderThread(),
  });
}

async function submitReply(parent, text) {
  const comment = makeLocalPost(text);
  mutatePost(parent.id, (p) => { p.comments = [...p.comments, comment]; });
  renderThread();
  // Same 5s undo window as every other interaction: the optimistic comment shows
  // immediately, the on-chain submit fires when the toast's countdown runs out,
  // and Undo removes the comment before anything hits the network.
  scheduleUndoable(`comment:${comment.id}`, async () => {
    try {
      const txid = await submitKaPostReply({
        engine: deps.engine, text, postId: parent.remoteId, parentAuthorPubkey: parent.posterPubkey,
        // @mentions work in comments exactly like in posts: resolved client-side to pubkeys.
        mentionedPubkeys: await mentionedPubkeysFor(text),
      });
      mutatePost(comment.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
    } catch (error) {
      mutatePost(comment.id, (p) => { p.delivery = "failed"; });
      deps.appendEngineLog?.(`KaPost reply failed: ${error.message}`);
    }
    renderThread();
  }, () => {
    mutatePost(parent.id, (p) => { p.comments = p.comments.filter((c) => c.id !== comment.id); });
    renderThread();
  });
}

function retryPost(post) {
  // A failed THREAD resumes its remaining chain instead of re-posting just the root.
  if (threadRemainders.has(post.id)) {
    continueThread(post.id);
    return;
  }
  mutatePost(post.id, (p) => { p.delivery = "pending"; });
  renderAll();
  (async () => {
    try {
      const txid = post.quoted?.remoteId && post.quoted?.posterPubkey
        ? await submitKaPostQuote({ engine: deps.engine, text: post.text, contentId: post.quoted.remoteId, quotedAuthorPubkey: post.quoted.posterPubkey })
        : await submitKaPost({ engine: deps.engine, text: post.text, mentionedPubkeys: await mentionedPubkeysFor(post.text) });
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
    } catch {
      mutatePost(post.id, (p) => { p.delivery = "failed"; });
    }
    renderAll();
  })();
}

// ---------------------------------------------------------------------------
// Composer + meter
// ---------------------------------------------------------------------------

function updateMeter(input, meter, submit = null) {
  const count = input.value.length;
  const limit = KAPOSTS_POST_CHARACTER_LIMIT;
  const remaining = limit - count;
  const nearLimit = count / limit >= 0.9;
  meter.hidden = count === 0 || !nearLimit;
  if (nearLimit) {
    meter.textContent = String(remaining);
    meter.classList.toggle("over", remaining <= 0);
  }
  if (count > limit) input.value = input.value.slice(0, limit);
  if (submit) submit.disabled = input.value.trim().length === 0;
}

// Thread segments stacked in the composer (X-style "+"), oldest first.
let composerThreadSegments = [];

function composerSegmentsEl() { return document.querySelector("[data-kaposts-thread-segments]"); }
function composerThreadAddEl() { return document.querySelector("[data-kaposts-thread-add]"); }

function renderComposerThreadUi() {
  const listEl = composerSegmentsEl();
  const addBtn = composerThreadAddEl();
  const trimmed = composerInput ? composerInput.value.trim() : "";
  const total = composerThreadSegments.length + (trimmed ? 1 : 0);
  if (listEl) {
    listEl.hidden = composerThreadSegments.length === 0;
    listEl.innerHTML = composerThreadSegments.map((segment, index) => `
      <div class="kaposts-thread-segment">
        <span class="kaposts-thread-segment-num">${index + 1}</span>
        <span class="kaposts-thread-segment-text">${deps.escapeHtml(segment)}</span>
        <button type="button" class="kaposts-thread-segment-remove" data-kaposts-thread-remove="${index}" aria-label="Remove segment">×</button>
      </div>`).join("");
  }
  // The + appears once you type (and never while quoting - quotes stay single-post).
  if (addBtn) addBtn.hidden = Boolean(composerQuoteTarget) || !trimmed;
  if (composerTitle && !composerQuoteTarget) {
    composerTitle.textContent = composerThreadSegments.length ? "New Thread" : "New Post";
  }
  if (composerSubmit) {
    composerSubmit.textContent = total > 1 ? `Post All (${total})` : "Post";
    composerSubmit.disabled = total === 0;
  }
  if (composerInput) {
    composerInput.placeholder = composerThreadSegments.length ? "Add another post" : "What's happening on Kaspa?";
  }
}

function openComposer(quoteTarget = null) {
  // Posting costs KAS — with a confirmed-zero chatting balance, show the funding
  // popup (QR + address + copy) instead of a composer that could never submit.
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  composerQuoteTarget = quoteTarget;
  composerTitle.textContent = quoteTarget ? "Quote Post" : "New Post";
  composerInput.value = "";
  composerSubmit.disabled = true;
  composerMeter.hidden = true;
  composerThreadSegments = [];
  if (quoteTarget) {
    composerQuote.hidden = false;
    composerQuote.innerHTML = `
      <strong>${deps.escapeHtml(posterName(quoteTarget.posterAddress))}</strong>
      <span>${deps.escapeHtml(quoteTarget.text)}</span>`;
  } else {
    composerQuote.hidden = true;
    composerQuote.innerHTML = "";
  }
  renderComposerThreadUi();
  composerEl.hidden = false;
  composerInput.focus();
}

function closeComposer() {
  composerEl.hidden = true;
  composerQuoteTarget = null;
  composerThreadSegments = [];
  renderComposerThreadUi();
}

// ---------------------------------------------------------------------------
// Panels (profile / notifications / engagement / bookmarks / muted / blocked / menu)
// ---------------------------------------------------------------------------

function syncRailActive() {
  const current = !activePanel
    ? "feed"
    : activePanel.type === "list"
      ? activePanel.kind
      : activePanel.type === "profile" && activePanel.address === deps.engine.address
        ? "profile"
        : activePanel.type === "notifications"
          ? "notifications"
          : null;
  document.querySelectorAll("[data-kaposts-rail]").forEach((button) => {
    button.classList.toggle("active", button.dataset.kapostsRail === current);
  });
}

/**
 * Prepares a panel for display, deciding whether it takes the viewport or is presented OVER an
 * open thread. Opened from inside a thread it is an over-thread panel, and whatever panel the
 * thread itself was opened from is parked in `beneath` so closing this one restores the thread
 * and a later thread-back still lands on that original panel.
 */
function beginPanel(next) {
  if (threadStack.length > 0) {
    next.beneath = panelOverThread ? (activePanel?.beneath || null) : (activePanel || null);
    panelOverThread = true;
  } else {
    panelOverThread = false;
  }
  return next;
}

function closePanel() {
  // An over-thread panel closes back to the thread, handing the viewport to whatever panel
  // the thread was opened from (usually none).
  activePanel = panelOverThread ? (activePanel?.beneath || null) : null;
  panelOverThread = false;
  panelGeneration += 1; // any page still in flight for the panel we just left is now stale
  clearPanelPagerSentinels();
  renderPanel();
  if (threadStack.length > 0) renderThread();
  syncRailActive();
  restoreFeedScroll();
}

function renderPanel() {
  const show = Boolean(activePanel);
  syncSurfaces(currentThreadPost());
  if (!show) clearPanelPagerSentinels();
  if (!show || !panelBodyEl) return;
  const panel = activePanel;
  // Panels rebuild their body wholesale (hero, tab bar and rows share one template), so the
  // scroll position has to be carried over by hand when a page of rows lands.
  const previousTop = panelBodyEl.scrollTop || 0;
  const restorePanelScroll = () => { panelBodyEl.scrollTop = previousTop; };
  const titles = {
    profile: "Profile", notifications: "Notifications", engagement: "Post Activity",
    bookmarks: "Bookmarks", muted: "Muted", blocked: "Blocked", menu: "KaPosts",
  };
  panelTitleEl.textContent = titles[panel.type === "list" ? panel.kind : panel.type] || "Panel";

  if (panel.type === "profile") {
    const address = panel.address;
    const profile = deps.engine.peekKnsAddressProfile?.(address)?.profile || null;
    const isMine = address === deps.engine.address;
    const isFollowing = prefs.following.includes(address);
    const feedItems = panel.tab === "replies" ? (panel.replies || []) : (panel.posts || []);
    panelBodyEl.innerHTML = `
      <div class="kaposts-profile-hero">
        <div class="kaposts-profile-banner"${profile?.bannerUrl ? ` style="background-image:url('${deps.escapeHtml(profile.bannerUrl)}')"` : ""}></div>
        <div class="kaposts-profile-row">
          ${posterAvatarHtml(address)}
          <div class="kaposts-profile-meta">
            <strong>${deps.escapeHtml(posterName(address))}</strong>
            ${profile?.bio ? `<span class="kaposts-profile-bio">${deps.escapeHtml(profile.bio)}</span>` : ""}
            <span class="kaposts-profile-counts">
              <button type="button" class="kaposts-count-link" data-kaposts-follow-list="following"${panel.pubkey ? "" : " disabled"}><b>${panel.details?.followingCount ?? "–"}</b> Following</button>&nbsp;&nbsp;
              <button type="button" class="kaposts-count-link" data-kaposts-follow-list="followers"${panel.pubkey ? "" : " disabled"}><b>${panel.details?.followersCount ?? "–"}</b> Followers</button>
            </span>
          </div>
          ${!isMine ? `<button class="kaposts-follow${isFollowing ? " following" : ""}" type="button" data-kaposts-profile-follow>${isFollowing ? "Following" : "Follow"}</button>` : ""}
        </div>
      </div>
      <div class="kaposts-feed-tabs kaposts-profile-tabs">
        <button class="kaposts-feed-tab${panel.tab !== "replies" ? " active" : ""}" type="button" data-kaposts-profile-tab="posts">Posts</button>
        <button class="kaposts-feed-tab${panel.tab === "replies" ? " active" : ""}" type="button" data-kaposts-profile-tab="replies">Replies</button>
      </div>
      <div class="kaposts-panel-list" data-kaposts-panel-list>
        ${panel.loading && feedItems.length === 0
          ? `<div class="kaposts-feed-status">Loading…</div>`
          : feedItems.length === 0
            ? `<div class="no-results-card"><strong>${panel.tab === "replies" ? "No replies yet" : "No posts yet"}</strong></div>`
            : feedItems.map((post) => postCellHtml(post, { inThread: true })).join("")}
      </div>`;
    const profileTab = panel.tab === "replies" ? "replies" : "posts";
    mountPagerSentinel(
      `profile-${profileTab}`,
      panelBodyEl.querySelector("[data-kaposts-panel-list]"),
      panel.loading ? null : panel.pagers?.[profileTab], // the first page owns the Loading… state
      () => loadMoreProfile(profileTab),
    );
    clearPagerSentinel(profileTab === "posts" ? "profile-replies" : "profile-posts");
    restorePanelScroll();
    return;
  }

  if (panel.type === "notifications") {
    const items = panel.items || [];
    panelBodyEl.innerHTML = `<div class="kaposts-panel-list" data-kaposts-panel-list>${
      panel.loading && items.length === 0
      ? `<div class="kaposts-feed-status">Loading…</div>`
      : items.length === 0
        ? `<div class="no-results-card"><strong>Nothing yet</strong><span>When someone likes, replies to or shares your posts, it shows up here.</span></div>`
        : items.map((item) => `
            <div class="kaposts-notification-row${item.targetTxId ? " openable" : ""}" ${item.targetTxId ? `data-kaposts-open-remote="${deps.escapeHtml(item.targetTxId)}"` : ""}${item.parentTxId ? ` data-kaposts-open-remote-parent="${deps.escapeHtml(item.parentTxId)}"` : ""}>
              ${posterAvatarHtml(item.actorAddress)}
              <div class="kaposts-notification-main">
                <span><strong>${deps.escapeHtml(posterName(item.actorAddress))}</strong> ${deps.escapeHtml(item.action)}</span>
                ${item.snippet ? `<span class="kaposts-notification-snippet">${deps.escapeHtml(item.snippet)}</span>` : ""}
                <span class="kaposts-cell-time">${deps.escapeHtml(formatRelativeTime(item.timestamp))}</span>
              </div>
              <a class="kaposts-view-link" href="${deps.escapeHtml(deps.explorerTxUrl(item.id))}" target="_blank" rel="noopener">View</a>
            </div>`).join("")
    }</div>`;
    mountPagerSentinel(
      "notifications",
      panelBodyEl.querySelector("[data-kaposts-panel-list]"),
      panel.loading ? null : panel.pager,
      loadMoreNotifications,
    );
    restorePanelScroll();
    return;
  }

  if (panel.type === "engagement") {
    const lists = panel.lists || { likes: [], dislikes: [], reposts: [], quotes: [] };
    const tab = panel.tab || "likes";
    const rows = lists[tab] || [];
    const tabLabel = (key, label) => {
      const count = (lists[key] || []).length;
      return count > 0 ? `${label} (${count})` : label;
    };
    panelBodyEl.innerHTML = `
      <div class="kaposts-feed-tabs kaposts-profile-tabs">
        ${["likes:Likes", "dislikes:Dislikes", "reposts:Reposts", "quotes:Quotes"].map((entry) => {
          const [key, label] = entry.split(":");
          return `<button class="kaposts-feed-tab${tab === key ? " active" : ""}" type="button" data-kaposts-engagement-tab="${key}">${tabLabel(key, label)}</button>`;
        }).join("")}
      </div>
      <div class="kaposts-panel-list" data-kaposts-panel-list>
        ${panel.loading
          ? `<div class="kaposts-feed-status">Loading…</div>`
          : rows.length === 0
            ? `<div class="no-results-card"><strong>Nothing here yet</strong><span>When someone engages with this post, they'll show up here.</span></div>`
            : rows.map((entry) => `
                <div class="kaposts-notification-row">
                  ${posterAvatarHtml(entry.actorAddress)}
                  <div class="kaposts-notification-main">
                    <span><strong>${deps.escapeHtml(posterName(entry.actorAddress))}</strong></span>
                    <span class="kaposts-cell-time">${deps.escapeHtml(formatRelativeTime(entry.timestamp))}</span>
                  </div>
                  <a class="kaposts-view-link" href="${deps.escapeHtml(deps.explorerTxUrl(entry.actionTxId))}" target="_blank" rel="noopener">View</a>
                </div>`).join("")}
      </div>
      ${panel.postTxId ? `<a class="kaposts-view-link kaposts-post-tx-link" href="${deps.escapeHtml(deps.explorerTxUrl(panel.postTxId))}" target="_blank" rel="noopener">View Post Transaction in Explorer</a>` : ""}`;
    mountPagerSentinel(
      "engagement",
      panelBodyEl.querySelector("[data-kaposts-panel-list]"),
      panel.loading ? null : panel.pager,
      loadMoreEngagement,
    );
    restorePanelScroll();
    return;
  }

  if (panel.type === "followList") {
    clearPanelPagerSentinels();
    panelTitleEl.textContent = panel.mode === "followers" ? "Followers" : "Following";
    const rows = panel.rows || [];
    panelBodyEl.innerHTML = `<div class="kaposts-panel-list" data-kaposts-panel-list>${
      panel.loading && rows.length === 0
        ? `<div class="kaposts-feed-status">Loading…</div>`
        : rows.length === 0
          ? `<div class="no-results-card"><strong>${panel.mode === "followers" ? "No followers yet" : "Not following anyone yet"}</strong></div>`
          : rows.map((row) => {
              const isMe = row.address === deps.engine.address;
              const isFollowing = prefs.following.includes(row.address);
              return `
              <div class="kaposts-notification-row openable" data-kaposts-follow-list-row data-address="${deps.escapeHtml(row.address)}" data-pubkey="${deps.escapeHtml(row.pubkey || "")}">
                ${posterAvatarHtml(row.address)}
                <div class="kaposts-notification-main"><span><strong>${deps.escapeHtml(posterName(row.address))}</strong></span></div>
                ${isMe ? "" : `<button class="kaposts-follow${isFollowing ? " following" : ""}" type="button" data-kaposts-follow-list-follow data-address="${deps.escapeHtml(row.address)}" data-pubkey="${deps.escapeHtml(row.pubkey || "")}">${isFollowing ? "Following" : "Follow"}</button>`}
              </div>`;
            }).join("")
    }</div>`;
    restorePanelScroll();
    return;
  }

  if (panel.type === "list") {
    // Bookmarks/Muted/Blocked are pure client-side lists (see the note on openBookmarks-style
    // panels below) — nothing to page, so no sentinel may survive here.
    clearPanelPagerSentinels();
    if (panel.kind === "bookmarks") {
      // Bookmarks are a local flag on already-loaded posts — the indexer has no bookmark
      // endpoint and no cursor to follow, so this list grows as the feed pages in rather
      // than paging itself.
      const bookmarks = allPostLists().filter((p) => p.bookmarkedByMe && !isHiddenAuthor(p.posterAddress));
      panelBodyEl.innerHTML = bookmarks.length === 0
        ? `<div class="no-results-card"><strong>No bookmarks yet</strong><span>Tap the bookmark icon on any post to save it here.</span></div>`
        : bookmarks.map((post) => postCellHtml(post, { inThread: true })).join("");
      restorePanelScroll();
      return;
    }
    const addresses = panel.kind === "muted" ? prefs.muted : prefs.blocked;
    panelBodyEl.innerHTML = addresses.length === 0
      ? `<div class="no-results-card"><strong>No ${panel.kind} users</strong><span>Their posts hide everywhere in KaPosts.</span></div>`
      : addresses.map((address) => `
          <div class="kaposts-notification-row">
            ${posterAvatarHtml(address)}
            <div class="kaposts-notification-main"><span><strong>${deps.escapeHtml(posterName(address))}</strong></span></div>
            <button class="kaposts-view-link" type="button" data-kaposts-unhide="${deps.escapeHtml(address)}" data-kaposts-unhide-kind="${panel.kind}">
              ${panel.kind === "muted" ? "Unmute" : "Unblock"}
            </button>
          </div>`).join("");
    restorePanelScroll();
  }
}

async function openPosterProfile(address, pubkey) {
  rememberFeedScroll();
  panelGeneration += 1;
  clearPanelPagerSentinels();
  const generation = panelGeneration;
  activePanel = beginPanel({
    type: "profile", address, pubkey, tab: "posts", posts: [], replies: [], details: null, loading: true,
    pagers: { posts: makePager(), replies: makePager() },
  });
  const panel = activePanel;
  renderPanel();
  syncRailActive();
  deps.engine.fetchKnsAddressInfo?.(address).catch(() => null)
    .then(() => deps.engine.fetchKnsAddressProfile?.(address).catch(() => null))
    .then(() => { if (activePanel === panel) renderPanel(); });
  if (!pubkey) {
    panel.loading = false;
    panel.pagers.posts.hasMore = false;
    panel.pagers.replies.hasMore = false;
    renderPanel();
    return;
  }
  try {
    const [details, content, repliesContent] = await Promise.all([
      fetchKaPostUserDetails({ engine: deps.engine, pubkey }).catch(() => null),
      fetchUserPosts({ engine: deps.engine, pubkey, limit: PAGER_PAGE_SIZE }),
      // Separate endpoint — get-posts never returns replies (see fetchUserPosts' note). A
      // replies failure must not blank the Posts tab.
      fetchUserReplies({ engine: deps.engine, pubkey, limit: PAGER_PAGE_SIZE })
        .catch(() => ({ posts: [], pagination: null })),
    ]);
    if (activePanel !== panel || generation !== panelGeneration) return;
    const mapped = content.posts.map(mapRemotePost).filter(Boolean);
    panel.posts = mapped.filter((p) => !p.parentRemoteId);
    panel.replies = repliesContent.posts.map(mapRemotePost).filter(Boolean);
    panel.details = details;
    panel.loading = false;
    seedPager(panel.pagers.posts, content.posts, content.pagination);
    seedPager(panel.pagers.replies, repliesContent.posts, repliesContent.pagination);
    renderPanel();
    resolvePosterIdentities([address], () => { if (activePanel === panel) renderPanel(); });
  } catch (error) {
    deps.appendEngineLog?.(`KaPost profile load failed: ${error.message}`);
    if (activePanel === panel) {
      panel.loading = false;
      panel.pagers.posts.hasMore = false;
      panel.pagers.replies.hasMore = false;
      renderPanel();
    }
  }
}

// Followers / Following list, opened by tapping a profile's counts. `parent` carries the profile
// we came from so the panel's Back button returns there instead of dropping to the feed.
async function openFollowListPanel({ address, pubkey, mode, parent }) {
  if (!pubkey) { deps.showToast?.("This profile has no public key to look up yet."); return; }
  panelGeneration += 1;
  clearPanelPagerSentinels();
  const generation = panelGeneration;
  activePanel = beginPanel({ type: "followList", mode, address, pubkey, parent: parent || null, rows: [], loading: true });
  const panel = activePanel;
  renderPanel();
  syncRailActive();
  try {
    const raw = await fetchFollowList({ engine: deps.engine, pubkey, followers: mode === "followers" });
    if (activePanel !== panel || generation !== panelGeneration) return;
    // The list endpoints return each user under one of several possible pubkey fields; resolve
    // whichever is present to a Kaspa address so the row can render a name/avatar and open.
    const rows = [];
    const seen = new Set();
    for (const item of raw || []) {
      const rowPubkey = item?.userPublicKey || item?.publicKey || item?.pubkey
        || item?.followedPubkey || item?.followerPubkey || item?.user || "";
      const rowAddress = item?.address || kaspaAddressFromPubkey(deps.engine, rowPubkey) || "";
      if (!rowAddress || seen.has(rowAddress)) continue;
      seen.add(rowAddress);
      rows.push({ address: rowAddress, pubkey: rowPubkey });
    }
    panel.rows = rows;
    panel.loading = false;
    renderPanel();
    resolvePosterIdentities(rows.map((row) => row.address), () => { if (activePanel === panel) renderPanel(); });
  } catch (error) {
    deps.appendEngineLog?.(`KaPost ${mode} list load failed: ${error.message}`);
    if (activePanel === panel) { panel.loading = false; renderPanel(); }
  }
}

/** Sentinel hit under a profile's Posts or Replies tab (own profile and other users' alike). */
function loadMoreProfile(tab) {
  const panel = activePanel;
  if (panel?.type !== "profile" || !panel.pubkey) return;
  const pager = panel.pagers?.[tab];
  if (!pager) return;
  const generation = panelGeneration;
  const listKey = tab === "replies" ? "replies" : "posts";
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const result = tab === "replies"
        ? await fetchUserReplies({ engine: deps.engine, pubkey: panel.pubkey, limit, before })
        : await fetchUserPosts({ engine: deps.engine, pubkey: panel.pubkey, limit, before });
      return { items: result.posts, pagination: result.pagination };
    },
    absorb: (fresh) => {
      const mapped = fresh.map(mapRemotePost).filter(Boolean);
      // get-posts is hard-filtered to posts/quotes server-side, but a stray reply would
      // belong on the other tab — the Posts tab shows top-level content only.
      const rows = tab === "replies" ? mapped : mapped.filter((post) => !post.parentRemoteId);
      const known = new Set((panel[listKey] || []).map((post) => post.id));
      const added = rows.filter((post) => !known.has(post.id));
      panel[listKey] = [...(panel[listKey] || []), ...added];
      renderPanel();
      return added.length;
    },
    isStale: () => generation !== panelGeneration
      || activePanel !== panel
      || (panel.tab === "replies" ? "replies" : "posts") !== tab,
    onUpdate: () => renderPanel(),
  });
}

// ---------------------------------------------------------------------------
// Background notification polling (iOS parity: KaPosts activity pings, gated by
// Settings > Notifications > KaPosts per-type toggles via
// deps.shouldNotifyKaPostsAction). Polls the same get-notifications endpoint
// the panel uses, dedupes by notification id (account-scoped, persisted), and
// posts a desktop notification per fresh item. First run for an account seeds
// the baseline silently so enabling never blasts history. Suppressed entirely
// in Child Mode (deps.kaPostsSuppressed), matching the hidden tab.
// ---------------------------------------------------------------------------

const KAPOSTS_SEEN_NOTIFS_KEY = "kachat-kaposts-seen-notifications-v1";
const KAPOSTS_NOTIF_POLL_MS = 90_000;
let kaPostsNotifPollTimer = 0;

function loadSeenKaPostNotificationIds() {
  try { return JSON.parse(localStorage.getItem(deps.accountScopedKey(KAPOSTS_SEEN_NOTIFS_KEY)) || "[]"); }
  catch { return []; }
}

function saveSeenKaPostNotificationIds(ids) {
  try { localStorage.setItem(deps.accountScopedKey(KAPOSTS_SEEN_NOTIFS_KEY), JSON.stringify(ids.slice(-300))); }
  catch {}
}

function kaPostsNotificationAction(n, text) {
  if (n.contentType === "vote") return n.voteType === "downvote" ? "disliked your post" : "liked your post";
  if (n.contentType === "reply") return "replied to your post";
  if (n.contentType === "quote") return text ? "quoted your post" : "reposted your post";
  if (n.contentType === "follow") return "followed you";
  if (n.contentType === "mention") return "mentioned you in a post";
  return "interacted with your post";
}

async function pollKaPostNotificationsForPings() {
  if (!deps?.engine?.address) return;
  if (deps.kaPostsSuppressed?.()) return;
  let raw;
  try { raw = (await fetchKaPostNotifications({ engine: deps.engine })).notifications; } catch { return; }
  if (!Array.isArray(raw) || !raw.length) return;

  const my = deps.engine.address;
  const seen = loadSeenKaPostNotificationIds().map(String);
  const seenSet = new Set(seen);
  const firstRun = seen.length === 0;
  const fresh = [];
  for (const n of raw) {
    const id = String(n?.id || "");
    if (!id || seenSet.has(id)) continue;
    seenSet.add(id);
    seen.push(id);
    if (firstRun) continue; // baseline seeding — history never notifies
    const actorAddress = kaspaAddressFromPubkey(deps.engine, n.userPublicKey);
    if (!actorAddress || actorAddress === my || isHiddenAuthor(actorAddress)) continue;
    // Warm the KNS cache so posterName can use the actor's domain (peek is cache-only;
    // a cold cache would fall back to the short address even when they own a domain).
    try { await deps.engine.refreshKnsIfNeeded?.([actorAddress]); } catch { /* name falls back */ }
    // The global notification center lists every fresh KaPosts action (mentions included),
    // independent of the per-type OS-ping gate below.
    const centerText = stripKaChatMarker(n.postContent ? (decodePostContent({ postContent: n.postContent }) || "") : "").trim();
    deps.recordGlobalNotification?.({
      source: "kaposts",
      id: `kaposts-${n.id}`,
      title: `${posterName(actorAddress)} ${kaPostsNotificationAction(n, centerText)}`,
      body: centerText ? `"${centerText.slice(0, 90)}${centerText.length > 90 ? "…" : ""}"` : "",
      timestamp: Number(n.timestamp) || Date.now(),
      targetKind: "kaposts",
      // Clicking the bell row deep-opens the exact post/comment (same per-kind
      // target rule as the in-app notifications panel).
      targetId: notificationTargetTxId(n, centerText) || undefined,
    });
    // Per-type gate (Settings > Notifications > KaPosts). Disabled types are
    // silently skipped — never queued for later. Unknown kinds always notify.
    if (deps.shouldNotifyKaPostsAction && !deps.shouldNotifyKaPostsAction(n.contentType, n.voteType)) continue;
    fresh.push({ n, actorAddress });
  }
  saveSeenKaPostNotificationIds(seen);

  for (const { n, actorAddress } of fresh.slice(0, 5)) {
    const text = stripKaChatMarker(n.postContent ? (decodePostContent({ postContent: n.postContent }) || "") : "").trim();
    const target = notificationTargetTxId(n, text);
    deps.postDesktopNotification?.({
      title: "KaPosts",
      body: `${posterName(actorAddress)} ${kaPostsNotificationAction(n, text)}`,
      tag: `kachat-kaposts-${n.id}`,
      // Land on the exact post/comment: switch to the KaPosts tab first (the
      // notification can arrive while another tab is active), then deep-open.
      onClick: () => {
        deps.openKaPostsTab?.();
        if (target) resolveAndOpenPost(target, { parentRemoteIdHint: notificationParentTxId(n) });
        else openNotificationsPanel();
      },
    });
  }
}

/** Which post/comment a notification should open — same per-kind rule as mapNotificationRow. */
function notificationTargetTxId(n, decodedText = "") {
  if (n.contentType === "reply") return n.id;
  if (n.contentType === "quote") return decodedText ? n.id : (n.contentId || null);
  if (n.contentType === "follow") return null;
  // A mention's acting content IS the post/comment that mentions you, so when the
  // indexer leaves contentId empty (nothing of YOURS was acted on), fall back to
  // the notification's own txid — without this, mention rows had no target at all.
  if (n.contentType === "mention") return n.contentId || n.id || null;
  return n.contentId || null; // vote, unknown kinds
}

/**
 * A reply notification's target is the REPLY, and the conversation it belongs to is the
 * notification's contentId — the post of yours that was replied to. Handing that through as
 * the parent hint means the parent thread opens even when the indexer's mapping for the reply
 * itself lost parentPostId (iOS parentRemoteIdHint).
 */
function notificationParentTxId(n) {
  return n?.contentType === "reply" && n.contentId ? String(n.contentId) : null;
}

/** Deep-open a post/comment by txid from OUTSIDE this module (the global bell center). */
export function openKaPostFromNotification(txId) {
  if (!deps) return;
  if (txId) resolveAndOpenPost(txId);
  else openNotificationsPanel();
}

function startKaPostsNotificationPolling() {
  if (kaPostsNotifPollTimer) window.clearInterval(kaPostsNotifPollTimer);
  kaPostsNotifPollTimer = window.setInterval(pollKaPostNotificationsForPings, KAPOSTS_NOTIF_POLL_MS);
  window.setTimeout(pollKaPostNotificationsForPings, 10_000);
}

/** One indexer notification -> one panel row, or null when it must not be shown. */
function mapNotificationRow(n) {
  const actorAddress = kaspaAddressFromPubkey(deps.engine, n.userPublicKey);
  if (!actorAddress || actorAddress === deps.engine.address || isHiddenAuthor(actorAddress)) return null;
  const text = stripKaChatMarker(n.postContent ? (decodePostContent({ postContent: n.postContent }) || "") : "").trim();
  let action = "interacted with your post";
  let targetTxId = n.contentId || null;
  if (n.contentType === "vote") action = n.voteType === "downvote" ? "disliked your post" : "liked your post";
  else if (n.contentType === "reply") { action = "replied to your post"; targetTxId = n.id; }
  else if (n.contentType === "quote") {
    action = text ? "quoted your post" : "reposted your post";
    targetTxId = text ? n.id : n.contentId;
  } else if (n.contentType === "follow") { action = "followed you"; targetTxId = null; }
  else if (n.contentType === "mention") { action = "mentioned you in a post"; targetTxId = n.contentId || n.id; }
  return {
    id: n.id, actorAddress, action, snippet: text || null,
    timestamp: Number(n.timestamp) || Date.now(),
    targetTxId, parentTxId: notificationParentTxId(n),
  };
}

async function openNotificationsPanel() {
  rememberFeedScroll();
  panelGeneration += 1;
  clearPanelPagerSentinels();
  const generation = panelGeneration;
  activePanel = beginPanel({ type: "notifications", items: [], loading: true, pager: makePager({ pageSize: PAGER_THREAD_PAGE_SIZE }) });
  const panel = activePanel;
  renderPanel();
  syncRailActive();
  try {
    const page = await fetchKaPostNotifications({ engine: deps.engine, limit: PAGER_THREAD_PAGE_SIZE });
    if (activePanel !== panel || generation !== panelGeneration) return;
    panel.items = page.notifications.map(mapNotificationRow).filter(Boolean);
    panel.loading = false;
    seedPager(panel.pager, page.notifications, page.pagination);
    renderPanel();
    resolvePosterIdentities(panel.items.map((item) => item.actorAddress), () => {
      if (activePanel === panel) renderPanel();
    });
  } catch (error) {
    deps.appendEngineLog?.(`KaPost notifications load failed: ${error.message}`);
    if (activePanel === panel) { panel.loading = false; panel.pager.hasMore = false; renderPanel(); }
  }
}

/** Sentinel hit at the bottom of the notifications panel. */
function loadMoreNotifications() {
  const panel = activePanel;
  if (panel?.type !== "notifications" || !panel.pager) return;
  const generation = panelGeneration;
  return runPager(panel.pager, {
    fetchPage: async (before, limit) => {
      const page = await fetchKaPostNotifications({ engine: deps.engine, limit, before });
      return { items: page.notifications, pagination: page.pagination };
    },
    absorb: (fresh) => {
      // Own actions and muted/blocked actors drop out here — that filtering is why the
      // shrinkage loop keeps pulling instead of settling for one page.
      const rows = fresh.map(mapNotificationRow).filter(Boolean);
      panel.items = [...panel.items, ...rows];
      renderPanel();
      resolvePosterIdentities(rows.map((item) => item.actorAddress), () => {
        if (activePanel === panel) renderPanel();
      });
      return rows.length;
    },
    isStale: () => generation !== panelGeneration || activePanel !== panel,
    onUpdate: () => renderPanel(),
  });
}

/** Distributes engagement rows into the four tab lists; returns how many landed per tab. */
function absorbEngagementRows(lists, rows) {
  const counts = { likes: 0, dislikes: 0, reposts: 0, quotes: 0 };
  for (const row of rows || []) {
    const actorAddress = kaspaAddressFromPubkey(deps.engine, row.actorPubkey);
    if (!actorAddress) continue;
    const entry = { actionTxId: row.actionTxId, actorAddress, timestamp: Number(row.timestamp) || Date.now() };
    const bucket = row.kind === "upvote" ? "likes"
      : row.kind === "downvote" ? "dislikes"
        : row.kind === "repost" ? "reposts"
          : row.kind === "quote" ? "quotes" : null;
    if (!bucket) continue;
    lists[bucket].push(entry);
    counts[bucket] += 1;
  }
  return counts;
}

async function openEngagementPanel(post) {
  panelGeneration += 1;
  clearPanelPagerSentinels();
  const generation = panelGeneration;
  // Post Activity opened from inside a thread presents OVER that thread and returns to it on
  // Back (iOS threadEngagementTarget); from the feed it takes the viewport as before.
  activePanel = beginPanel({
    type: "engagement", postId: post.id, postTxId: post.remoteId, tab: "likes", lists: null, loading: true,
    pager: makePager({ pageSize: PAGER_THREAD_PAGE_SIZE }),
  });
  const panel = activePanel;
  renderPanel();
  const lists = { likes: [], dislikes: [], reposts: [], quotes: [] };
  try {
    const page = await fetchPostEngagement({
      engine: deps.engine, postId: post.remoteId, limit: PAGER_THREAD_PAGE_SIZE,
    });
    absorbEngagementRows(lists, page.engagement);
    seedPager(panel.pager, page.engagement, page.pagination, (row) => row?.actionTxId);
    resolvePosterIdentities(
      Object.values(lists).flat().map((entry) => entry.actorAddress),
      () => { if (activePanel === panel) renderPanel(); },
    );
  } catch (error) {
    // Older deployments: derive from the notification stream (own posts only) — a one-shot
    // list with no cursor of its own, so paging stops here.
    panel.pager.hasMore = false;
    if (post.posterAddress === deps.engine.address) {
      try {
        const raw = (await fetchKaPostNotifications({ engine: deps.engine })).notifications;
        for (const n of raw) {
          if (n.contentId !== post.remoteId) continue;
          const actorAddress = kaspaAddressFromPubkey(deps.engine, n.userPublicKey);
          if (!actorAddress) continue;
          const entry = { actionTxId: n.id, actorAddress, timestamp: Number(n.timestamp) || Date.now() };
          if (n.contentType === "vote") {
            if (n.voteType === "upvote") lists.likes.push(entry);
            else if (n.voteType === "downvote") lists.dislikes.push(entry);
          } else if (n.contentType === "quote") {
            const text = stripKaChatMarker(decodePostContent({ postContent: n.postContent }) || "").trim();
            (text ? lists.quotes : lists.reposts).push(entry);
          }
        }
      } catch { /* leave empty */ }
    }
  }
  if (activePanel !== panel || generation !== panelGeneration) return;
  panel.lists = lists;
  panel.loading = false;
  renderPanel();
}

/**
 * Sentinel hit under a "who liked / reposted" list. One cursor covers the mixed stream the
 * indexer returns, so a page feeds all four tabs at once; only rows landing on the tab the
 * user is looking at count towards the target.
 */
function loadMoreEngagement() {
  const panel = activePanel;
  if (panel?.type !== "engagement" || !panel.pager || !panel.postTxId) return;
  const generation = panelGeneration;
  return runPager(panel.pager, {
    idOf: (row) => row?.actionTxId,
    fetchPage: async (before, limit) => {
      const page = await fetchPostEngagement({
        engine: deps.engine, postId: panel.postTxId, limit, before,
      });
      return { items: page.engagement, pagination: page.pagination };
    },
    absorb: (fresh) => {
      const lists = panel.lists || (panel.lists = { likes: [], dislikes: [], reposts: [], quotes: [] });
      const counts = absorbEngagementRows(lists, fresh);
      renderPanel();
      resolvePosterIdentities(
        fresh.map((row) => kaspaAddressFromPubkey(deps.engine, row.actorPubkey)),
        () => { if (activePanel === panel) renderPanel(); },
      );
      return counts[panel.tab || "likes"] || 0;
    },
    isStale: () => generation !== panelGeneration || activePanel !== panel,
    onUpdate: () => renderPanel(),
  });
}

// ---------------------------------------------------------------------------
// Popovers (repost/quote chooser + per-post ⋯ menu)
// ---------------------------------------------------------------------------

function setKaPostsScrollLock(locked) {
  document.querySelector('[data-app-tab-screen="kaposts"]')?.classList.toggle("scroll-locked", locked);
}

function closePopover() {
  if (popoverEl) { popoverEl.hidden = true; popoverEl.innerHTML = ""; }
  setKaPostsScrollLock(false);
}

function openPopover(anchor, itemsHtml) {
  if (!popoverEl || !anchor) return;
  popoverEl.innerHTML = itemsHtml;
  popoverEl.hidden = false;
  const screenRect = popoverEl.offsetParent?.getBoundingClientRect?.() || { left: 0, top: 0 };
  const rect = anchor.getBoundingClientRect();
  popoverEl.style.left = `${Math.max(8, rect.left - screenRect.left - 120)}px`;
  popoverEl.style.top = `${rect.bottom - screenRect.top + 6}px`;
}

function openRepostPopover(anchor, post) {
  openPopover(anchor, `
    <button type="button" data-kaposts-pop="repost" data-kaposts-pop-id="${post.id}">Repost</button>
    <button type="button" data-kaposts-pop="quote" data-kaposts-pop-id="${post.id}">Quote</button>`);
}

function openMorePopover(anchor, post) {
  const isMine = post.posterAddress === deps.engine.address;
  // Bookmark and Share are their own buttons on every post's action bar (matches iOS), so the
  // ⋯ menu is just Post Activity, Mute, and Block.
  openPopover(anchor, `
    ${post.remoteId ? `<button type="button" data-kaposts-pop="activity" data-kaposts-pop-id="${post.id}">Post Activity</button>` : ""}
    ${!isMine ? `<button type="button" data-kaposts-pop="mute" data-kaposts-pop-id="${post.id}">Mute</button>` : ""}
    ${!isMine ? `<button type="button" data-kaposts-pop="block" data-kaposts-pop-id="${post.id}" class="danger">Block</button>` : ""}`);
}

function handlePopoverAction(action, post) {
  closePopover();
  if (!post) return;
  if (action === "repost") scheduleRepost(post);
  else if (action === "quote") openComposer(post);
  else if (action === "share") {
    const snippet = post.text.slice(0, 60).trim();
    const ellipsis = post.text.length > 60 ? "..." : "";
    navigator.clipboard?.writeText(`"${snippet}${ellipsis}"\n\nOpen in KaChat: kachat://kapost/${post.remoteId}`);
    deps.showToast?.("Share link copied");
  } else if (action === "activity") openEngagementPanel(post);
  else if (action === "bookmark") { mutatePost(post.id, (p) => { p.bookmarkedByMe = !p.bookmarkedByMe; }); renderAll(); }
  else if (action === "mute") { prefs.muted = [...new Set([...prefs.muted, post.posterAddress])]; savePrefs(); renderAll(); }
  else if (action === "block") {
    prefs.blocked = [...new Set([...prefs.blocked, post.posterAddress])];
    prefs.muted = prefs.muted.filter((a) => a !== post.posterAddress);
    savePrefs(); renderAll();
  }
}

// ---------------------------------------------------------------------------
// Init + events
// ---------------------------------------------------------------------------

/**
 * Tab activation. Keeps an already-loaded (and still fresh) endless-scroll window instead of
 * snapping back to page one — leaving KaPosts for a moment must not throw away everything the
 * user scrolled in. The Refresh button always reloads.
 */
export function refreshKaPostsFeed() {
  if (!deps) return;
  if (remotePosts.length > 0 && Date.now() - lastFeedLoadAt < FEED_FRESH_MS) {
    renderFeed();
    return;
  }
  loadFeed();
}

export function resetKaPostsForAccount() {
  loadPrefs();
  localPosts = [];
  remotePosts = [];
  myContentPosts = [];
  threadStack = [];
  activePanel = null;
  panelOverThread = false;
  pendingThreadScrollRemoteId = null;
  threadHighlightRemoteId = null;
  // The one-shot on-chain follow sync is a module latch: without clearing it the SECOND
  // account of a session never rebuilt its local follow set and sat at "following 0" until
  // the app was reloaded.
  followingChainSynced = false;
  // Account change: every cursor, every in-flight page and every observer belongs to the old
  // wallet's lists.
  feedGeneration += 1;
  threadGeneration += 1;
  panelGeneration += 1;
  feedPager = makePager();
  threadPagers.clear();
  // Chains and the thread-root probe cache hold the previous wallet's posts, and both are
  // searched by findPost now — they must not survive the switch.
  threadChains.clear();
  threadRootProbe.clear();
  renderedFeedIds = new Set();
  lastFeedLoadAt = 0;
  clearAllPagerSentinels();
  renderAll();
  renderPanel();
}

// --- @mention autocomplete --------------------------------------------------
// Attach to a composer textarea: typing "@" opens a menu of your 1:1 contacts that have a KNS
// domain (deps.getMentionCandidates). Picking one inserts "@domain ". Only KNS-domain contacts
// are mentionable — the same set the indexer will turn into mention notifications.
const MENTION_QUERY_RE = /(?:^|[\s([{<"'])@([a-z0-9-]*)$/i;

function attachMentionAutocomplete(textarea) {
  if (!textarea || textarea.dataset.mentionWired) return;
  textarea.dataset.mentionWired = "1";
  let menu = null;
  let items = [];
  let activeIndex = 0;
  let anchorStart = -1; // index of the '@' currently being completed
  // Live any-KNS resolution of the current query (contacts come from the local list; this
  // row lets you mention anyone with a KNS domain).
  let resolveToken = 0;
  let resolvedExtra = null; // { query, domain }

  function close() {
    if (menu) { menu.remove(); menu = null; }
    items = [];
    activeIndex = 0;
    anchorStart = -1;
    resolveToken += 1;
    resolvedExtra = null;
  }

  function scheduleAnyKnsResolve(query) {
    const clean = String(query || "").toLowerCase();
    const token = ++resolveToken;
    if (resolvedExtra && resolvedExtra.query !== clean) resolvedExtra = null;
    if (clean.length < 2) return;
    window.setTimeout(async () => {
      if (token !== resolveToken) return;
      try {
        const resolution = await deps.engine.resolveKnsDomain?.(clean);
        if (token !== resolveToken || !resolution?.domain) return;
        resolvedExtra = { query: clean, domain: String(resolution.domain).toLowerCase().replace(/\.kas$/, "") };
        const ctx = currentQuery();
        if (ctx && ctx.query.toLowerCase() === clean) render(ctx.query);
      } catch { /* no match: contacts-only list stands */ }
    }, 400);
  }

  function currentQuery() {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, caret);
    const match = before.match(MENTION_QUERY_RE);
    if (!match) return null;
    const query = match[1] || "";
    return { query, atIndex: caret - query.length - 1, caret };
  }

  function render(query) {
    const q = String(query || "").toLowerCase();
    const candidates = deps.getMentionCandidates?.() || [];
    items = candidates
      .filter((c) => !q || c.domain.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q))
      .slice(0, 6);
    // Live-resolved any-KNS match for the current query rides along at the end.
    if (resolvedExtra && resolvedExtra.query === q
        && !items.some((c) => c.domain.toLowerCase() === resolvedExtra.domain)) {
      items = [...items, { domain: resolvedExtra.domain, name: "" }];
    }
    if (!items.length) { close(); return; }
    if (activeIndex >= items.length) activeIndex = 0;
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "kaposts-mention-menu";
      document.body.appendChild(menu);
    }
    menu.innerHTML = items.map((c, i) => `
      <button type="button" class="kaposts-mention-option${i === activeIndex ? " active" : ""}" data-mention-index="${i}">
        <strong>@${deps.escapeHtml(c.domain)}</strong>${c.name && c.name.toLowerCase() !== c.domain.toLowerCase() ? `<span>${deps.escapeHtml(c.name)}</span>` : ""}
      </button>`).join("");
    const rect = textarea.getBoundingClientRect();
    menu.style.left = `${rect.left + window.scrollX}px`;
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.style.width = `${Math.min(rect.width, 320)}px`;
  }

  function choose(index) {
    const item = items[index];
    const caret = textarea.selectionStart ?? textarea.value.length;
    if (!item || anchorStart < 0) { close(); return; }
    const before = textarea.value.slice(0, anchorStart);
    const after = textarea.value.slice(caret);
    const insert = `@${item.domain} `;
    textarea.value = before + insert + after;
    const newCaret = before.length + insert.length;
    close();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(newCaret, newCaret);
  }

  function refresh() {
    const ctx = currentQuery();
    if (!ctx) { close(); return; }
    anchorStart = ctx.atIndex;
    render(ctx.query);
    scheduleAnyKnsResolve(ctx.query);
  }

  textarea.addEventListener("input", refresh);
  textarea.addEventListener("keydown", (event) => {
    if (!menu || !items.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); activeIndex = (activeIndex + 1) % items.length; render(currentQuery()?.query || ""); }
    else if (event.key === "ArrowUp") { event.preventDefault(); activeIndex = (activeIndex - 1 + items.length) % items.length; render(currentQuery()?.query || ""); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(activeIndex); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  textarea.addEventListener("blur", () => { window.setTimeout(close, 150); });
  document.addEventListener("mousedown", (event) => {
    if (!menu) return;
    const opt = event.target.closest?.("[data-mention-index]");
    if (opt) { event.preventDefault(); choose(Number(opt.dataset.mentionIndex)); return; }
    if (!menu.contains(event.target) && event.target !== textarea) close();
  });
}

export function initKaPosts(dependencies) {
  deps = dependencies;
  startKaPostsNotificationPolling();

  feedEl = document.querySelector("[data-kaposts-feed]");
  statusEl = document.querySelector("[data-kaposts-status]");
  tabsEl = document.querySelector("[data-kaposts-feed-tabs]");
  threadEl = document.querySelector("[data-kaposts-thread]");
  threadRootEl = document.querySelector("[data-kaposts-thread-root]");
  threadRepliesEl = document.querySelector("[data-kaposts-thread-replies]");
  toastsEl = document.querySelector("[data-kaposts-toasts]");
  composerEl = document.querySelector("[data-kaposts-composer]");
  composerInput = document.querySelector("[data-kaposts-composer-input]");
  composerMeter = document.querySelector("[data-kaposts-composer-meter]");
  composerSubmit = document.querySelector("[data-kaposts-composer-submit]");
  composerTitle = document.querySelector("[data-kaposts-composer-title]");
  composerQuote = document.querySelector("[data-kaposts-composer-quote]");
  replyInput = document.querySelector("[data-kaposts-reply-input]");
  replyMeter = document.querySelector("[data-kaposts-reply-meter]");
  replySend = document.querySelector("[data-kaposts-reply-send]");
  attachMentionAutocomplete(composerInput);
  attachMentionAutocomplete(replyInput);
  panelEl = document.querySelector("[data-kaposts-panel]");
  panelTitleEl = document.querySelector("[data-kaposts-panel-title]");
  panelBodyEl = document.querySelector("[data-kaposts-panel-body]");
  popoverEl = document.querySelector("[data-kaposts-popover]");

  loadPrefs();

  // Feed tab switching
  tabsEl?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kaposts-feed-tab]");
    if (!button) return;
    activeFeedTab = button.dataset.kapostsFeedTab;
    tabsEl.querySelectorAll("[data-kaposts-feed-tab]").forEach((b) => b.classList.toggle("active", b === button));
    // Retire the outgoing tab's cursor before anything can repaint: its sentinel must not
    // fire a "load more" that would page the tab the user just left.
    feedPager = null;
    clearPagerSentinel("feed");
    renderFeed();
    loadFeed();
  });

  document.querySelector("[data-kaposts-refresh]")?.addEventListener("click", () => loadFeed());
  document.querySelector("[data-kaposts-compose]")?.addEventListener("click", () => openComposer());
  // X-style persistent rail: the sections are always visible on the left.
  document.querySelectorAll("[data-kaposts-rail]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.kapostsRail;
      threadStack = [];
      threadGeneration += 1; // drops any reply page still in flight for the thread we left
      // The rail always leaves the thread, so nothing here is an over-thread panel.
      panelOverThread = false;
      pendingThreadScrollRemoteId = null;
      if (key === "feed") closePanel();
      else if (key === "notifications") openNotificationsPanel();
      else if (key === "profile") openPosterProfile(deps.engine.address, safeRequesterPubkey());
      else {
        rememberFeedScroll();
        panelGeneration += 1;
        clearPanelPagerSentinels();
        activePanel = beginPanel({ type: "list", kind: key });
        renderPanel();
      }
      renderThread();
      renderFeed();
      syncRailActive();
    });
  });
  document.querySelector("[data-kaposts-panel-back]")?.addEventListener("click", () => {
    // A follow list opened from a profile returns to that profile; everything else closes to the feed.
    if (activePanel?.type === "followList" && activePanel.parent?.address) {
      openPosterProfile(activePanel.parent.address, activePanel.parent.pubkey || null);
      return;
    }
    closePanel();
    syncRailActive();
  });
  document.addEventListener("click", (event) => {
    if (!popoverEl || popoverEl.hidden) return;
    if (!popoverEl.contains(event.target) && !event.target.closest("[data-kaposts-more], [data-kaposts-repost], [data-kaposts-link]")) {
      closePopover();
    }
  });
  document.querySelector("[data-kaposts-composer-cancel]")?.addEventListener("click", closeComposer);
  document.querySelector("[data-kaposts-thread-back]")?.addEventListener("click", () => {
    threadStack.pop();
    replyTargetId = null;
    // Leaving the thread retires any unspent reply-landing scroll target.
    pendingThreadScrollRemoteId = null;
    threadHighlightRemoteId = null;
    if (threadStack.length === 0) {
      // Back at the feed: drop every thread cursor so a re-open starts from a fresh page one.
      threadGeneration += 1;
      threadPagers.clear();
      clearPagerSentinel("thread");
    }
    renderThread();
    // Thread was opened from a profile/bookmarks panel: return to THAT panel, not the feed.
    if (threadStack.length === 0 && activePanel) {
      renderPanel();
      return;
    }
    renderFeed();
    restoreFeedScroll();
  });

  composerInput?.addEventListener("input", () => {
    updateMeter(composerInput, composerMeter, composerSubmit);
    // Runs AFTER updateMeter: the meter disables Post on empty input, but with stacked
    // thread segments "Post All (n)" must stay enabled - the thread UI has the final say.
    renderComposerThreadUi();
  });
  composerSubmit?.addEventListener("click", () => {
    const text = composerInput.value.trim();
    const segments = text ? [...composerThreadSegments, text] : [...composerThreadSegments];
    if (!segments.length) return;
    const quoteTarget = composerQuoteTarget;
    closeComposer();
    if (quoteTarget) scheduleQuote(quoteTarget, segments[0]);
    else if (segments.length > 1) scheduleThread(segments);
    else schedulePost(segments[0]);
  });

  // X-style +: stack the current text as a thread segment and keep writing.
  composerThreadAddEl()?.addEventListener("click", () => {
    const text = composerInput.value.trim();
    if (!text || composerQuoteTarget) return;
    composerThreadSegments.push(text);
    composerInput.value = "";
    updateMeter(composerInput, composerMeter, composerSubmit);
    renderComposerThreadUi();
    composerInput.focus();
  });
  composerSegmentsEl()?.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-kaposts-thread-remove]");
    if (!remove) return;
    composerThreadSegments.splice(Number(remove.dataset.kapostsThreadRemove), 1);
    renderComposerThreadUi();
  });

  replyInput?.addEventListener("input", () => updateMeter(replyInput, replyMeter));
  replySend?.addEventListener("click", () => {
    if (deps.isChattingBalanceZero?.()) {
      deps.showFundingGate?.();
      return;
    }
    const text = replyInput.value.trim();
    const topId = threadStack[threadStack.length - 1];
    const target = (replyTargetId ? findPost(replyTargetId) : null) || (topId ? findPost(topId) : null);
    if (!text || !target || !target.remoteId) return;
    replyInput.value = "";
    updateMeter(replyInput, replyMeter);
    replyTargetId = null;
    updateReplyContext();
    submitReply(target, text);
  });

  // Delegated feed/thread/toast interactions
  const screen = document.querySelector('[data-app-tab-screen="kaposts"]');
  screen?.addEventListener("click", (event) => {
    const link = event.target.closest("[data-kaposts-link]");
    if (link) {
      event.stopPropagation();
      openPopover(link, `
        <button type="button" data-kaposts-link-open="${deps.escapeHtml(link.dataset.kapostsLink)}">Open Link</button>
        <button type="button" data-kaposts-link-copy="${deps.escapeHtml(link.dataset.kapostsLink)}">Copy Link</button>`);
      // Scrolling locks while the link menu is up - click away (or pick an option) to release.
      setKaPostsScrollLock(true);
      return;
    }
    const linkOpen = event.target.closest("[data-kaposts-link-open]");
    if (linkOpen) {
      closePopover();
      window.open(linkOpen.dataset.kapostsLinkOpen, "_blank", "noopener");
      return;
    }
    const linkCopy = event.target.closest("[data-kaposts-link-copy]");
    if (linkCopy) {
      closePopover();
      navigator.clipboard?.writeText(linkCopy.dataset.kapostsLinkCopy);
      deps.showToast?.("Link copied");
      return;
    }

    const replyTo = event.target.closest("[data-kaposts-reply-to]");
    if (replyTo) {
      // Reply to a comment right here - no need to drill into its own thread first.
      replyTargetId = replyTo.dataset.kapostsReplyTo;
      updateReplyContext();
      replyInput?.focus();
      return;
    }
    if (event.target.closest("[data-kaposts-reply-context-clear]")) {
      replyTargetId = null;
      updateReplyContext();
      replyInput?.focus();
      return;
    }

    const pagerRetry = event.target.closest("[data-kaposts-pager-retry]");
    if (pagerRetry) { retryPager(pagerRetry.dataset.kapostsPagerRetry); return; }

    const undo = event.target.closest("[data-kaposts-undo]");
    if (undo) { cancelUndoable(undo.dataset.kapostsUndo); return; }

    const countdown = event.target.closest("[data-kaposts-countdown]");
    if (countdown) { cancelUndoable(countdown.dataset.kapostsCountdown); return; }

    const like = event.target.closest("[data-kaposts-like]");
    if (like) { const p = findPost(like.dataset.kapostsLike); if (p) toggleVote(p, "like"); return; }

    const dislike = event.target.closest("[data-kaposts-dislike]");
    if (dislike) { const p = findPost(dislike.dataset.kapostsDislike); if (p) toggleVote(p, "dislike"); return; }

    const repost = event.target.closest("[data-kaposts-repost]");
    if (repost) {
      const p = findPost(repost.dataset.kapostsRepost);
      if (!p || !p.remoteId || !p.posterPubkey) return;
      openRepostPopover(repost, p);
      return;
    }

    const pop = event.target.closest("[data-kaposts-pop]");
    if (pop) {
      handlePopoverAction(pop.dataset.kapostsPop, findPost(pop.dataset.kapostsPopId));
      return;
    }

    const more = event.target.closest("[data-kaposts-more]");
    if (more) {
      const p = findPost(more.dataset.kapostsMore);
      if (p) openMorePopover(more, p);
      return;
    }

    const profileTap = event.target.closest("[data-kaposts-profile]");
    if (profileTap) {
      const p = findPost(profileTap.dataset.kapostsProfile);
      if (p) openPosterProfile(p.posterAddress, p.posterPubkey);
      return;
    }

    const profileTab = event.target.closest("[data-kaposts-profile-tab]");
    if (profileTab && activePanel?.type === "profile") {
      activePanel.tab = profileTab.dataset.kapostsProfileTab;
      renderPanel();
      return;
    }

    const profileFollow = event.target.closest("[data-kaposts-profile-follow]");
    if (profileFollow && activePanel?.type === "profile") {
      toggleFollow({ posterAddress: activePanel.address, posterPubkey: activePanel.pubkey });
      renderPanel();
      return;
    }

    const followListCount = event.target.closest("[data-kaposts-follow-list]");
    if (followListCount && activePanel?.type === "profile") {
      openFollowListPanel({
        address: activePanel.address,
        pubkey: activePanel.pubkey,
        mode: followListCount.dataset.kapostsFollowList,
        parent: { address: activePanel.address, pubkey: activePanel.pubkey },
      });
      return;
    }

    const followListFollow = event.target.closest("[data-kaposts-follow-list-follow]");
    if (followListFollow) {
      // Follow/unfollow straight from the row without opening the profile behind it.
      toggleFollow({ posterAddress: followListFollow.dataset.address, posterPubkey: followListFollow.dataset.pubkey || null });
      renderPanel();
      return;
    }

    const followListRow = event.target.closest("[data-kaposts-follow-list-row]");
    if (followListRow) {
      openPosterProfile(followListRow.dataset.address, followListRow.dataset.pubkey || null);
      return;
    }

    const engagementTab = event.target.closest("[data-kaposts-engagement-tab]");
    if (engagementTab && activePanel?.type === "engagement") {
      activePanel.tab = engagementTab.dataset.kapostsEngagementTab;
      renderPanel();
      return;
    }

    const unhide = event.target.closest("[data-kaposts-unhide]");
    if (unhide) {
      const address = unhide.dataset.kapostsUnhide;
      if (unhide.dataset.kapostsUnhideKind === "muted") prefs.muted = prefs.muted.filter((a) => a !== address);
      else prefs.blocked = prefs.blocked.filter((a) => a !== address);
      savePrefs();
      renderPanel();
      renderFeed();
      return;
    }

    const follow = event.target.closest("[data-kaposts-follow]");
    if (follow) { const p = findPost(follow.dataset.kapostsFollow); if (p) toggleFollow(p); return; }

    const mentionTap = event.target.closest("[data-kaposts-mention]");
    if (mentionTap) {
      openMentionProfile(mentionTap.dataset.kapostsMention);
      return;
    }

    const tip = event.target.closest("[data-kaposts-tip]");
    if (tip) {
      const p = findPost(tip.dataset.kapostsTip);
      if (p) deps.tipUser?.(p.posterAddress, posterName(p.posterAddress));
      return;
    }

    const bookmark = event.target.closest("[data-kaposts-bookmark]");
    if (bookmark) {
      const p = findPost(bookmark.dataset.kapostsBookmark);
      if (p) {
        mutatePost(p.id, (target) => { target.bookmarkedByMe = !target.bookmarkedByMe; });
        deps.showToast?.(p.bookmarkedByMe ? "Bookmarked" : "Bookmark removed");
        renderAll();
      }
      return;
    }

    const share = event.target.closest("[data-kaposts-share]");
    if (share) {
      const p = findPost(share.dataset.kapostsShare);
      if (p?.remoteId) {
        const snippet = p.text.slice(0, 60).trim();
        const ellipsis = p.text.length > 60 ? "..." : "";
        navigator.clipboard?.writeText(`"${snippet}${ellipsis}"\n\nOpen in KaChat: kachat://kapost/${p.remoteId}`);
        deps.showToast?.("Share link copied");
      }
      return;
    }

    const retry = event.target.closest("[data-kaposts-retry]");
    if (retry) { const p = findPost(retry.dataset.kapostsRetry); if (p) retryPost(p); return; }

    const openRemote = event.target.closest("[data-kaposts-open-remote]");
    if (openRemote) {
      if (event.target.closest("a")) return; // let the explorer link win its own clicks
      // Reply rows carry the conversation they belong to, so the parent's thread opens even
      // when the reply's own indexer mapping has no parent id.
      resolveAndOpenPost(openRemote.dataset.kapostsOpenRemote, {
        parentRemoteIdHint: openRemote.dataset.kapostsOpenRemoteParent || null,
      });
      return;
    }

    const open = event.target.closest("[data-kaposts-open]");
    if (open) { const p = findPost(open.dataset.kapostsOpen); if (p) openThread(p); return; }
  });
}
