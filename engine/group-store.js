// Group-chat state + orchestration (the "GroupBag/roster store" + service layer,
// mirroring iOS's GroupStore + GroupChatService). Persists per-wallet group state
// in localStorage, drives key distribution over the 1:1 ECIES channel, and turns
// on-chain payloads into decoded messages. Pure of DOM/UI; the app layer renders
// what syncGroups() returns and calls createGroup/sendGroupMessage/etc.
//
// The injected `engine` must provide: address, privateKeyHex, xOnlyPubKeyForAddress,
// sendGroupPayload, encryptGroupControl, decryptGroupControl, and the scanGroup*
// methods (see engine/index.js).
import * as G from "./group.js";

const GROUPS_KEY = "kachat-groups-v1";
// Per-wallet group deletion tombstones: { [wallet]: { deleted: [groupId...], published: [groupId...] } }.
// `deleted` blocks a group from ever being re-added by discovery/recovery; `published` tracks
// which tombstones have been written on-chain (so the delete survives a seedless re-import).
const GROUP_TOMBSTONES_KEY = "kachat-group-tombstones-v1";

// Deep-ish clone via JSON is fine — records are plain data (hex strings, numbers).
function loadAll() {
  try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveAll(all) {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(all)); } catch {}
}
function loadTombstonesAll() {
  try { return JSON.parse(localStorage.getItem(GROUP_TOMBSTONES_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveTombstonesAll(all) {
  try { localStorage.setItem(GROUP_TOMBSTONES_KEY, JSON.stringify(all)); } catch {}
}

export class GroupManager {
  constructor(engine) {
    this.engine = engine;
    this._selfPubHex = null;
  }

  get walletAddress() { return this.engine.address || ""; }

  // Our own x-only signing pubkey, derived once from the wallet key.
  selfPubHex() {
    if (!this._selfPubHex) this._selfPubHex = G.bytesToHex(G.xOnlyPublicKey(this.engine.privateKeyHex));
    return this._selfPubHex;
  }

  // --- persistence (scoped per wallet address) ---
  _bucket() {
    const all = loadAll();
    if (!all[this.walletAddress]) all[this.walletAddress] = {};
    return { all, bucket: all[this.walletAddress] };
  }
  listGroups() {
    const { bucket } = this._bucket();
    return Object.values(bucket).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  getGroup(groupId) {
    const { bucket } = this._bucket();
    return bucket[groupId] || null;
  }
  _put(record) {
    const { all, bucket } = this._bucket();
    record.updatedAt = record.updatedAt || 0;
    bucket[record.groupId] = record;
    all[this.walletAddress] = bucket;
    saveAll(all);
    return record;
  }
  deleteGroup(groupId) {
    const { all, bucket } = this._bucket();
    delete bucket[groupId];
    all[this.walletAddress] = bucket;
    saveAll(all);
    // Tombstone it so discovery/recovery never re-adds it, and publish an on-chain delete
    // marker (best-effort now, retried by syncGroups' backfill) so the delete survives a
    // seedless re-import too. Local intent is recorded synchronously; the chain write is async.
    this._recordTombstone(groupId, { published: false });
    Promise.resolve().then(() => this._publishTombstone(groupId)).catch(() => {});
  }

  // --- deletion tombstones ---
  _tombstoneBucket() {
    const all = loadTombstonesAll();
    const bucket = all[this.walletAddress] || { deleted: [], published: [] };
    bucket.deleted = Array.isArray(bucket.deleted) ? bucket.deleted : [];
    bucket.published = Array.isArray(bucket.published) ? bucket.published : [];
    return { all, bucket };
  }
  isGroupTombstoned(groupId) {
    return this._tombstoneBucket().bucket.deleted.includes(String(groupId));
  }
  _recordTombstone(groupId, { published }) {
    const id = String(groupId);
    const { all, bucket } = this._tombstoneBucket();
    if (!bucket.deleted.includes(id)) bucket.deleted.push(id);
    if (published && !bucket.published.includes(id)) bucket.published.push(id);
    all[this.walletAddress] = bucket;
    saveTombstonesAll(all);
  }
  _markTombstonePublished(groupId) {
    const id = String(groupId);
    const { all, bucket } = this._tombstoneBucket();
    if (!bucket.published.includes(id)) bucket.published.push(id);
    all[this.walletAddress] = bucket;
    saveTombstonesAll(all);
  }
  // Self-addressed, self-signed delete marker. Only our own key can produce one, and only our
  // own key can read it — see verifyTombstonePayload + the signing_pub === self check on receipt.
  async _publishTombstone(groupId) {
    const payload = G.buildSignedTombstonePayload({ groupId, signingPub: this.selfPubHex(), privateKey: this.engine.privateKeyHex });
    const encryptedHex = await this.engine.encryptGroupControl(this.walletAddress, JSON.stringify(payload));
    const wire = G.buildControlPayload({ recipientXOnlyPubKey: this.selfPubHex(), encryptedHex });
    await this.engine.sendGroupPayload(wire);
    this._markTombstonePublished(groupId);
  }

  /**
   * Import a group from a cross-platform backup archive (ChatHistoryArchive.groups). Carries
   * the full key material - including the admin's groupSeed - so a second device of the same
   * account recovers groups it created (which have no on-chain invite addressed to us) as well
   * as member groups. Returns true if a group was created or advanced to a newer epoch.
   *
   * deviceId and msgCounter are intentionally NOT taken from the archive: they are per-device
   * (spec), and reusing the exporting device's values would let this device's sends collide
   * with msg_ids the phone already used. A fresh device gets its own id and a zeroed counter.
   */
  importGroupRecord(g) {
    if (!g || !g.groupId) return false;
    const groupId = String(g.groupId);
    // A tombstoned (deleted) group is never re-created from a backup — same rule as the
    // on-chain recovery path, so a restore can't resurrect a group you deleted.
    if (this.isGroupTombstoned(groupId)) return false;
    const incomingEpoch = Number(g.currentEpoch || 0);
    const existing = this.getGroup(groupId);
    // Never downgrade to an older epoch than what we already hold.
    if (existing && Number(existing.currentEpoch || 0) > incomingEpoch) return false;

    const members = Array.isArray(g.members)
      ? g.members
          .map((m) => ({
            address: String(m.address || "").trim(),
            xOnlyPubKeyHex: m.xOnlyPubKeyHex ? String(m.xOnlyPubKeyHex) : null,
            isAdmin: Boolean(m.isAdmin),
          }))
          .filter((m) => m.address)
      : [];

    const record = {
      groupId,
      name: String(g.name || existing?.name || "Group"),
      isAdmin: Boolean(g.isAdmin),
      adminAddress: g.adminAddress ? String(g.adminAddress) : (existing?.adminAddress || null),
      adminSigningPub: g.adminSigningPub ? String(g.adminSigningPub) : (existing?.adminSigningPub || null),
      groupSeedHex: g.groupSeed ? String(g.groupSeed) : (existing?.groupSeedHex || null),
      groupRootEpochHex: g.groupRootEpoch ? String(g.groupRootEpoch) : (existing?.groupRootEpochHex || null),
      blindingKeyHex: g.blindingKey ? String(g.blindingKey) : (existing?.blindingKeyHex || null),
      currentEpoch: incomingEpoch,
      deviceIdHex: existing?.deviceIdHex || G.bytesToHex(G.generateDeviceId()),
      msgCounter: existing && Number(existing.currentEpoch || 0) === incomingEpoch ? (existing.msgCounter || 0) : 0,
      members: members.length ? members : (existing?.members || []),
      cursors: existing?.cursors || {},
      photoHex: g.photo ? String(g.photo) : (existing?.photoHex || null),
      updatedAt: existing?.updatedAt || 0,
    };
    if (!record.groupRootEpochHex || !record.blindingKeyHex) return false; // unusable without keys
    this._put(record);
    return true;
  }

  // --- roster helper: resolve each address to its x-only pubkey ---
  async _buildRoster(memberAddresses, adminAddress) {
    const seen = new Set();
    const roster = [];
    for (const address of [adminAddress, ...memberAddresses]) {
      const addr = String(address || "").trim();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      const xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr);
      roster.push({ address: addr, xOnlyPubKeyHex, isAdmin: addr === adminAddress });
    }
    return roster;
  }

  // --- create (admin) ---
  // Generates the group, persists the admin's GroupBag, and distributes gctl_root
  // to every member (including self is skipped — we already hold the keys).
  async createGroup({ name, memberAddresses = [] }) {
    const adminAddress = this.walletAddress;
    if (!adminAddress) throw new Error("Load a wallet before creating a group.");
    const roster = await this._buildRoster(memberAddresses, adminAddress);
    if (roster.length < 2) throw new Error("A group needs at least one other member.");
    if (roster.length > 50) throw new Error("A group can have at most 50 members.");

    const groupSeed = G.generateGroupSeed();
    const groupId = G.deriveGroupId(groupSeed);
    const epoch = 0;
    const groupRootEpoch = G.deriveGroupRootEpoch(groupSeed, groupId, epoch);
    const blindingKey = G.deriveBlindingKey(groupSeed, groupId);
    const deviceId = G.generateDeviceId();
    const adminSigningPub = this.selfPubHex();

    const record = {
      groupId: G.bytesToHex(groupId),
      name: String(name || "Group"),
      isAdmin: true,
      adminAddress,
      adminSigningPub,
      groupSeedHex: G.bytesToHex(groupSeed), // admin-only: lets us re-derive any epoch
      groupRootEpochHex: G.bytesToHex(groupRootEpoch),
      blindingKeyHex: G.bytesToHex(blindingKey),
      currentEpoch: epoch,
      // When THIS device learned about the group. Anything mined before it is history, not new
      // mail - see the backfill floor in maybeNotifyGroupIncoming.
      learnedAtMs: Date.now(),
      deviceIdHex: G.bytesToHex(deviceId),
      msgCounter: 0,
      members: roster,
      cursors: {},
      updatedAt: 0,
    };
    this._put(record);
    // The group is already created and persisted. A failed invite broadcast (transient node
    // / balance / network) must NOT block the admin from entering the new group — surface it
    // as a soft warning and let it be retried (re-adding a member re-distributes the root).
    try {
      await this._distributeRoot(record, epoch);
    } catch (error) {
      record.inviteWarning = error?.message || String(error);
      this._put(record);
    }
    return record;
  }

  // Build + encrypt + broadcast a gctl_root to every non-self member at `epoch`.
  async _distributeRoot(record, epoch) {
    const groupSeed = G.hexToBytes(record.groupSeedHex);
    const groupId = G.hexToBytes(record.groupId);
    const groupRootEpoch = G.deriveGroupRootEpoch(groupSeed, groupId, epoch);
    const blindingKey = G.hexToBytes(record.blindingKeyHex);
    const memberAddresses = record.members.map((m) => m.address);
    const payload = G.buildSignedRootPayload({
      groupId, epoch, groupRootEpoch, blindingKey,
      adminSigningPub: record.adminSigningPub, members: memberAddresses,
      name: record.name, adminPrivateKey: this.engine.privateKeyHex,
    });
    const json = JSON.stringify(payload);
    // Each member's invite is its own self-spend tx. Send them per-member and resiliently:
    // one member failing must NOT abort the others (that's how a second member — e.g. the
    // iPhone one — was silently dropped). Retry each send a few times with a short delay,
    // because back-to-back sends contend for the same UTXO until the prior tx's change output
    // settles, so a bare second send often fails until it does.
    const failures = [];
    for (const member of record.members) {
      if (member.address === this.walletAddress) continue; // we already have the keys
      try {
        await this._sendControlToMember(member, json);
      } catch (error) {
        failures.push({ address: member.address, message: error?.message || String(error) });
      }
    }
    // Self-addressed copy WITH the group seed, so a seedless re-import of this wallet
    // rediscovers and fully rebuilds the group from chain alone (no cloud backup). This is
    // what closes the "admin groups vanish on fresh import" gap. Best-effort: a failure here
    // never blocks member delivery, and the backfill in syncGroups retries it.
    try {
      const selfMember = { address: this.walletAddress, xOnlyPubKeyHex: this.selfPubHex() };
      const selfPayload = G.buildSignedRootPayload({
        groupId, epoch, groupRootEpoch, blindingKey,
        adminSigningPub: record.adminSigningPub, members: memberAddresses,
        name: record.name, adminPrivateKey: this.engine.privateKeyHex,
        groupSeed, // the extra field ONLY the self copy carries
      });
      await this._sendControlToMember(selfMember, JSON.stringify(selfPayload));
      record.selfInviteEpoch = epoch; // mark this epoch's recovery invite as published
      this._put(record);
    } catch (error) {
      // Leave selfInviteEpoch unset so syncGroups' backfill retries.
      this.engine.log?.(`Group self-invite send failed: ${error?.message || error}`);
    }
    if (failures.length) {
      const err = new Error(`${failures.length} of ${record.members.length - 1} invite(s) could not be sent`);
      err.failures = failures;
      throw err;
    }
  }

  // Encrypt + broadcast one member's gctl_root, retrying to ride out UTXO contention from a
  // just-sent sibling tx (the change output needs a moment to become spendable again).
  async _sendControlToMember(member, json, { attempts = 4, delayMs = 1800 } = {}) {
    const encryptedHex = await this.engine.encryptGroupControl(member.address, json);
    const wire = G.buildControlPayload({ recipientXOnlyPubKey: member.xOnlyPubKeyHex, encryptedHex });
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      try { return await this.engine.sendGroupPayload(wire); }
      catch (error) {
        lastError = error;
        if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  // --- membership changes (admin), each bumps the epoch and re-distributes ---
  async addMember(groupId, address) {
    const record = this._requireAdmin(groupId);
    const addr = String(address || "").trim();
    if (record.members.some((m) => m.address === addr)) return record;
    if (record.members.length >= 50) throw new Error("A group can have at most 50 members.");
    const xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr);
    record.members.push({ address: addr, xOnlyPubKeyHex, isAdmin: false });
    return this._rotateEpoch(record, "add");
  }
  async removeMember(groupId, address) {
    const record = this._requireAdmin(groupId);
    const addr = String(address || "").trim();
    if (addr === record.adminAddress) throw new Error("The admin can't be removed.");
    record.members = record.members.filter((m) => m.address !== addr);
    return this._rotateEpoch(record, "remove");
  }
  async renameGroup(groupId, name) {
    const record = this._requireAdmin(groupId);
    record.name = String(name || record.name);
    record.updatedAt = 0;
    this._put(record);
    // Rename is not a forward-secrecy event — re-send the root at the SAME epoch.
    await this._distributeRoot(record, record.currentEpoch);
    return record;
  }

  async _rotateEpoch(record, reason) {
    const groupSeed = G.hexToBytes(record.groupSeedHex);
    const groupId = G.hexToBytes(record.groupId);
    const newEpoch = record.currentEpoch + 1;
    record.currentEpoch = newEpoch;
    record.groupRootEpochHex = G.bytesToHex(G.deriveGroupRootEpoch(groupSeed, groupId, newEpoch));
    record.msgCounter = 0; // counter resets when the epoch advances
    this._put(record);
    // Announce, then hand out the new root (removed members never get it).
    const epochPayload = G.buildSignedEpochPayload({ groupId, epoch: newEpoch, reason, adminPrivateKey: this.engine.privateKeyHex });
    const epochJson = JSON.stringify(epochPayload);
    for (const member of record.members) {
      if (member.address === this.walletAddress) continue;
      const encryptedHex = await this.engine.encryptGroupControl(member.address, epochJson);
      await this.engine.sendGroupPayload(G.buildControlPayload({ recipientXOnlyPubKey: member.xOnlyPubKeyHex, encryptedHex }));
    }
    await this._distributeRoot(record, newEpoch);
    // A newly-added member should also receive the current group photo (root doesn't carry it).
    if (record.photoHex) { try { await this._distributePhoto(record); } catch {} }
    return record;
  }

  _requireAdmin(groupId) {
    const record = this.getGroup(groupId);
    if (!record) throw new Error("Group not found.");
    if (!record.isAdmin) throw new Error("Only the group admin can do that.");
    return record;
  }

  // Re-broadcast the CURRENT epoch's root to every member (admin) — used to retry invites
  // that failed to send at create time, without rotating the epoch. Throws (with .failures)
  // if any member still can't be reached.
  async resendInvites(groupId) {
    const record = this._requireAdmin(groupId);
    await this._distributeRoot(record, record.currentEpoch);
    delete record.inviteWarning;
    this._put(record);
    // Also re-push the group photo so anyone who missed it (or a new device) catches up.
    if (record.photoHex) { try { await this._distributePhoto(record); } catch {} }
    return record;
  }

  // Re-broadcast the current root to ONE member (admin) — a targeted retry of a single failed
  // invite, no epoch rotation. Throws if the send fails.
  async resendInviteToMember(groupId, address) {
    const record = this._requireAdmin(groupId);
    const member = record.members.find((m) => m.address === address);
    if (!member) throw new Error("That member is not in the group.");
    if (member.address === this.walletAddress) return record; // never invite ourselves
    const groupSeed = G.hexToBytes(record.groupSeedHex);
    const groupIdBytes = G.hexToBytes(record.groupId);
    const groupRootEpoch = G.deriveGroupRootEpoch(groupSeed, groupIdBytes, record.currentEpoch);
    const blindingKey = G.hexToBytes(record.blindingKeyHex);
    const payload = G.buildSignedRootPayload({
      groupId: groupIdBytes, epoch: record.currentEpoch, groupRootEpoch, blindingKey,
      adminSigningPub: record.adminSigningPub, members: record.members.map((m) => m.address),
      name: record.name, adminPrivateKey: this.engine.privateKeyHex,
    });
    await this._sendControlToMember(member, JSON.stringify(payload));
    return record;
  }

  // Admin: set (photoHex = hex of a compressed JPEG) or clear (photoHex = "") the group photo,
  // then push it to every member via a signed gctl_photo control message.
  async setGroupPhoto(groupId, photoHex) {
    const record = this._requireAdmin(groupId);
    record.photoHex = String(photoHex || "");
    this._put(record);
    await this._distributePhoto(record);
    return record;
  }

  // Send the current group photo to every member (admin). Best-effort; throws with .failures set
  // if any member couldn't be reached, so the caller can surface a "some didn't receive it" note.
  async _distributePhoto(record) {
    const payload = G.buildSignedPhotoPayload({
      groupId: G.hexToBytes(record.groupId),
      photoHex: record.photoHex || "",
      signingPub: this.selfPubHex(),
      privateKey: this.engine.privateKeyHex,
    });
    const json = JSON.stringify(payload);
    let failures = 0;
    for (const member of record.members) {
      if (member.address === this.walletAddress) continue;
      try { await this._sendControlToMember(member, json); } catch { failures += 1; }
    }
    // Also send a self-addressed copy so the SAME account's OTHER devices pick up the photo change
    // (they scan for controls addressed to their own key). Best-effort; not counted as a failure.
    try { await this._sendControlToMember({ address: this.walletAddress, xOnlyPubKeyHex: this.selfPubHex() }, json); } catch {}
    if (failures) { const e = new Error(`${failures} member(s) may not have received the photo yet.`); e.failures = failures; throw e; }
  }

  // --- send a message ---
  async sendGroupMessage(groupId, plaintext) {
    const record = this.getGroup(groupId);
    if (!record) throw new Error("Group not found.");
    if (!record.groupRootEpochHex) throw new Error("No group key for the current epoch.");
    // Reserve the counter BEFORE sending so a retry never reuses a msg_id.
    const counter = record.msgCounter;
    record.msgCounter = counter + 1;
    this._put(record);
    const payload = G.sealGroupMessage({
      plaintext,
      groupId: G.hexToBytes(record.groupId),
      epoch: record.currentEpoch,
      groupRootEpoch: G.hexToBytes(record.groupRootEpochHex),
      blindingKey: G.hexToBytes(record.blindingKeyHex),
      senderAddress: this.walletAddress,
      senderPrivateKey: this.engine.privateKeyHex,
      senderXOnlyPub: this.selfPubHex(),
      deviceId: G.hexToBytes(record.deviceIdHex),
      counter,
    });
    const msgIdHex = G.bytesToHex(G.buildMsgId(G.hexToBytes(record.deviceIdHex), counter));
    const result = await this.engine.sendGroupPayload(payload);
    return { txid: result?.txids?.[0] || null, counter, epoch: record.currentEpoch, msgIdHex };
  }

  // --- apply an incoming control message (gctl_root / gctl_epoch) ---
  // `senderAddress` comes from the indexer row. Returns a small event describing
  // what changed, or null if it wasn't for us / was invalid / was stale.
  async applyControl(payloadString, senderAddress, blockTime = 0) {
    const parsed = G.parseControlPayload(payloadString);
    if (!parsed) return null;
    // The indexer strips the recipient in REST responses, so parsed.recipientXOnlyPubKey
    // is usually null here. When it IS present (live wire / our own echo) we can fast-skip
    // controls addressed to someone else; otherwise we just try to decrypt — a control that
    // isn't ours fails ECIES and returns null, exactly as iOS relies on.
    if (parsed.recipientXOnlyPubKey && G.bytesToHex(parsed.recipientXOnlyPubKey) !== this.selfPubHex()) return null;
    let json;
    try { json = await this.engine.decryptGroupControl(parsed.encryptedHex); }
    catch { return null; } // not decryptable by us
    let payload;
    try { payload = JSON.parse(json); } catch { return null; }

    if (payload.type === "gctl_root") return this._applyRoot(payload, senderAddress);
    // gctl_epoch is a heads-up only; the real state change lands on the matching gctl_root.
    if (payload.type === "gctl_epoch") return { kind: "epoch-notice", groupId: payload.group_id, epoch: payload.epoch };
    // A delete marker — honor ONLY our own (signed by, and addressed to, us). Record the
    // tombstone (already on chain, so mark it published) and drop the group if we still hold it.
    // A group photo set by the admin — apply only if signed by THIS group's known admin.
    if (payload.type === "gctl_photo") {
      const record = this.getGroup(payload.group_id);
      if (!record) return null;
      if (payload.signing_pub !== record.adminSigningPub || !G.verifyPhotoPayload(payload)) return null;
      // The by-recipient control scan has no cursor, so it re-returns historical controls every
      // sync. Photo controls oscillate photoHex (set/clear), which would re-apply and re-emit a
      // system message on every poll. Guard by block time: ignore any photo control not strictly
      // newer than the last one we applied. (photoUpdatedAt is preserved across root rebuilds.)
      const bt = Number(blockTime || 0);
      if (bt > 0 && bt <= Number(record.photoUpdatedAt || 0)) return null;
      const newHex = String(payload.photo || "");
      const changed = (record.photoHex || "") !== newHex;
      record.photoHex = newHex;
      if (bt > 0) record.photoUpdatedAt = bt;
      this._put(record);
      // Content-stable key so the actor's own "You changed…" line and this self-echo dedupe
      // to a single message instead of doubling.
      const photoKey = newHex === "" ? "cleared" : `${newHex.length}:${newHex.slice(0, 16)}`;
      return { kind: "photo-updated", groupId: record.groupId, changed, cleared: newHex === "", photoKey, adminAddress: record.adminAddress };
    }
    if (payload.type === "gctl_tombstone") {
      if (payload.signing_pub !== this.selfPubHex() || !G.verifyTombstonePayload(payload)) return null;
      const id = String(payload.group_id);
      const had = this.getGroup(id) != null;
      this._recordTombstone(id, { published: true });
      if (had) { const { all, bucket } = this._bucket(); delete bucket[id]; all[this.walletAddress] = bucket; saveAll(all); }
      return had ? { kind: "deleted", groupId: id } : null;
    }
    return null;
  }

  async _applyRoot(payload, senderAddress) {
    if (!G.verifyRootPayload(payload)) return null;
    const groupId = payload.group_id;
    // A tombstoned group must never be re-added — this is what makes a delete survive a
    // seedless re-import against the recovery invite.
    if (this.isGroupTombstoned(groupId)) return null;
    const existing = this.getGroup(groupId);
    // Replay guard: never apply an epoch strictly older than what we hold.
    if (existing && payload.epoch < existing.currentEpoch) return null;

    // Admin self-recovery: a self-addressed root carries the group seed. Trust it only if it
    // re-derives the SIGNED group_id + blinding_key (that binding is what authenticates the
    // otherwise-unsigned seed). When valid, this is our own group and we rebuild it as admin.
    let recoveredSeedHex = null;
    if (payload.group_seed && payload.admin_signing_pub === this.selfPubHex()) {
      try {
        const seed = G.hexToBytes(payload.group_seed);
        const derivedId = G.bytesToHex(G.deriveGroupId(seed));
        const derivedBlinding = G.bytesToHex(G.deriveBlindingKey(seed, G.hexToBytes(groupId)));
        if (derivedId === groupId && derivedBlinding === payload.blinding_key) recoveredSeedHex = G.bytesToHex(seed);
      } catch { recoveredSeedHex = null; }
    }
    const isAdminRecord = recoveredSeedHex != null;

    // Resolve each member address to its pubkey for the local roster.
    const roster = [];
    for (const address of payload.members || []) {
      const addr = String(address || "").trim();
      if (!addr || roster.some((m) => m.address === addr)) continue;
      let xOnlyPubKeyHex = null;
      try { xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr); } catch { xOnlyPubKeyHex = null; }
      // For an admin record the admin is ourselves; otherwise the sender is admin.
      const memberIsAdmin = isAdminRecord ? addr === this.walletAddress : addr === senderAddress;
      roster.push({ address: addr, xOnlyPubKeyHex, isAdmin: memberIsAdmin });
    }

    const isNewEpoch = !existing || payload.epoch > existing.currentEpoch;
    const record = {
      groupId,
      name: payload.name || existing?.name || "Group",
      isAdmin: isAdminRecord || existing?.isAdmin === true,
      adminAddress: isAdminRecord ? this.walletAddress : (senderAddress || existing?.adminAddress || null),
      adminSigningPub: payload.admin_signing_pub,
      // Keep any seed we already hold; adopt a validly-recovered one on a seedless rebuild.
      groupSeedHex: recoveredSeedHex || existing?.groupSeedHex || null,
      groupRootEpochHex: payload.group_root_epoch,
      blindingKeyHex: payload.blinding_key,
      currentEpoch: payload.epoch,
      // Set once, on the root that first told us this group exists, and preserved across every
      // later epoch rotation - an add/remove must not reset the backfill floor and re-arm a
      // flood of banners for messages already read.
      learnedAtMs: existing?.learnedAtMs || Date.now(),
      // device_id is preserved across updates; counter resets only when the epoch advances.
      deviceIdHex: existing?.deviceIdHex || G.bytesToHex(G.generateDeviceId()),
      msgCounter: isNewEpoch ? 0 : (existing?.msgCounter || 0),
      members: roster,
      cursors: existing?.cursors || {},
      // A recovered admin group already has its recovery invite on chain for this epoch.
      selfInviteEpoch: isAdminRecord ? payload.epoch : existing?.selfInviteEpoch,
      // Group photo isn't carried in the root (separate gctl_photo control) — preserve it.
      photoHex: existing?.photoHex || null,
      photoUpdatedAt: existing?.photoUpdatedAt || 0,
      updatedAt: 0,
    };
    this._put(record);
    const kind = existing ? "root-updated" : (isAdminRecord ? "recovered" : "joined");
    // Membership diff, so the UI can show iMessage-style "X was added/removed" lines to every
    // member on a key rotation. Only for an already-known group (a first join has no baseline).
    let added = [], removed = [];
    if (existing) {
      const oldAddrs = new Set((existing.members || []).map((m) => m.address));
      const newAddrs = new Set(roster.map((m) => m.address));
      added = roster.map((m) => m.address).filter((a) => !oldAddrs.has(a));
      removed = (existing.members || []).map((m) => m.address).filter((a) => !newAddrs.has(a));
    }
    // Surface a rename (name changed on an already-known group) so the UI can show a system line.
    const renamedTo = (existing && existing.name !== record.name) ? record.name : null;
    return { kind, groupId, epoch: payload.epoch, name: record.name, added, removed, renamedTo, adminAddress: record.adminAddress };
  }

  // --- process an incoming gcomm message ---
  // Trial-matches the parsed message's blinded id against each local group's
  // roster; on a match, verifies roster membership + sender_id, then decrypts.
  // Returns a decoded message or null.
  processMessage(parsed) {
    if (!parsed) return null;
    for (const record of this.listGroups()) {
      const blindingKey = G.hexToBytes(record.blindingKeyHex);
      const expected = G.bytesToHex(G.deriveBlindedGroupId(blindingKey, parsed.senderPubKey));
      if (expected !== G.bytesToHex(parsed.blindedGroupId)) continue;
      // Sender must be in the roster (matched by pubkey).
      const member = record.members.find((m) => m.xOnlyPubKeyHex === G.bytesToHex(parsed.senderPubKey));
      if (!member) return null;
      // sender_id must equal SHA256(sender_address).
      if (G.bytesToHex(G.deriveSenderId(member.address)) !== G.bytesToHex(parsed.senderId)) return null;
      // Need the epoch's root. Non-admins only hold the current epoch's root; the
      // admin can re-derive any epoch from the seed.
      let rootHex = null;
      if (parsed.epoch === record.currentEpoch) rootHex = record.groupRootEpochHex;
      else if (record.groupSeedHex) rootHex = G.bytesToHex(G.deriveGroupRootEpoch(G.hexToBytes(record.groupSeedHex), G.hexToBytes(record.groupId), parsed.epoch));
      if (!rootHex) return null;
      let plaintext;
      try { plaintext = G.openGroupMessage(parsed, { groupId: G.hexToBytes(record.groupId), groupRootEpoch: G.hexToBytes(rootHex) }); }
      catch { return null; }
      return {
        groupId: record.groupId,
        senderAddress: member.address,
        senderIsAdmin: member.isAdmin,
        epoch: parsed.epoch,
        msgIdHex: G.bytesToHex(parsed.msgId),
        plaintext,
      };
    }
    return null;
  }

  // --- sync: pull new controls (invites/rotations) then new messages ---
  // Returns { controls: [...events], messages: [...decoded] }. The app persists
  // decoded messages into its conversation state and renders control events.
  async syncGroups() {
    const events = [];
    // 0. Backfill recovery invites: publish a self-addressed root (with the group seed) for any
    // admin group that lacks one for its current epoch — i.e. every group created before this
    // feature existed. One-time per group per epoch; after it lands on chain, a seedless import
    // of this wallet rediscovers the group with no cloud backup. Best-effort, never blocks sync.
    for (const record of this.listGroups()) {
      if (!record.isAdmin || !record.groupSeedHex) continue;
      if (record.selfInviteEpoch === record.currentEpoch) continue;
      try {
        const groupSeed = G.hexToBytes(record.groupSeedHex);
        const groupId = G.hexToBytes(record.groupId);
        const selfPayload = G.buildSignedRootPayload({
          groupId, epoch: record.currentEpoch,
          groupRootEpoch: G.hexToBytes(record.groupRootEpochHex),
          blindingKey: G.hexToBytes(record.blindingKeyHex),
          adminSigningPub: record.adminSigningPub, members: record.members.map((m) => m.address),
          name: record.name, adminPrivateKey: this.engine.privateKeyHex, groupSeed,
        });
        await this._sendControlToMember({ address: this.walletAddress, xOnlyPubKeyHex: this.selfPubHex() }, JSON.stringify(selfPayload));
        record.selfInviteEpoch = record.currentEpoch;
        this._put(record);
      } catch (error) {
        this.engine.log?.(`Group self-invite backfill failed: ${error?.message || error}`);
      }
    }
    // 0b. Backfill delete markers: publish the on-chain tombstone for any group deleted while
    // offline (or whose delete-time publish failed), so the delete survives a seedless re-import.
    {
      const { bucket } = this._tombstoneBucket();
      for (const id of bucket.deleted) {
        if (bucket.published.includes(id)) continue;
        try { await this._publishTombstone(id); }
        catch (error) { this.engine.log?.(`Group tombstone backfill failed: ${error?.message || error}`); }
      }
    }

    // 1. Discover invites / rotations addressed to us.
    try {
      const recips = await this.engine.scanGroupControlByRecipient();
      for (const row of recips) {
        const ev = await this.applyControl(row.payloadString, row.sender, row.blockTime);
        if (ev) events.push(ev);
      }
    } catch { /* indexer hiccup — try messages anyway */ }

    // 2. For each known group, pull messages under every member's blinded id — 4 scans in
    // flight at a time. The old fully-sequential nested loop was one awaited round trip per
    // member per group (two 8-member groups = 16 serial requests on EVERY 5s sweep).
    const messages = [];
    for (const record of this.listGroups()) {
      const blindingKey = G.hexToBytes(record.blindingKeyHex);
      record.cursors = record.cursors || {};
      const scans = record.members
        .filter((member) => member.xOnlyPubKeyHex)
        .map((member) => G.bytesToHex(G.deriveBlindedGroupId(blindingKey, member.xOnlyPubKeyHex)));
      let next = 0;
      const results = new Array(scans.length);
      await Promise.all(Array.from({ length: Math.min(4, scans.length) }, async () => {
        while (next < scans.length) {
          const i = next++;
          try { results[i] = await this.engine.scanGroupMessages(scans[i], record.cursors[scans[i]] || null); }
          catch { results[i] = null; }
        }
      }));
      // Decode sequentially (processMessage mutates shared group state) in member order.
      results.forEach((rows, i) => {
        if (!rows) return;
        const blindedHex = scans[i];
        for (const row of rows) {
          const parsed = G.parseGroupMessagePayload(row.payloadString);
          const decoded = this.processMessage(parsed);
          if (decoded) messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
          if (row.cursor) record.cursors[blindedHex] = row.cursor;
        }
      });
      this._put(record);
    }
    return { controls: events, messages };
  }
}

export function createGroupManager(engine) {
  return new GroupManager(engine);
}
