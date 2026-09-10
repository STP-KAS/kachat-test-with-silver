// KSPT ("Kaspa Signable Partial Transaction") — the compact binary transport format KasSigner's
// firmware scans/displays for air-gapped signing, plus the unsigned-transaction build/broadcast
// engine around it. Port of iOS's KsptCodec.swift + QrFrameChunker.swift + ColdStorageSendEngine
// .swift (themselves verified against KasSigner's own `bootloader/src/wallet/pskt.rs` and
// `kassee/src/kspt.rs`) — field order, widths, mass math, and selection policy must match those
// exactly, or the device rejects the QR or the network rejects the fee.
//
// KSPT wire layout (all multi-byte integers little-endian):
//   Header:  magic(4)="KSPT"  version(1)=0x01  flags(1) [bit0: signed, bit1: has redeem script]
//   Global:  txVersion(2)  numInputs(1)  numOutputs(1)  lockTime(8)  subnetworkId(20)  gas(8)
//            payloadLen(2)  payload(payloadLen)
//   Input:   prevTxId(32)  prevIndex(4)  amount(8)  sequence(8)  sigOpCount(1)
//            spkVersion(2)  spkLen(1)  spkScript(spkLen)
//            [if signed: sigLen(1)  signature(sigLen)  sighashType(1)]
//   Output:  value(8)  spkVersion(2)  spkLen(1)  spkScript(spkLen)

import { getEndpoint } from "../engine/endpoints.js";

// Matches firmware MAX_INPUTS=32 as of KasSigner v1.0.5 (was 8; devices on older
// firmware reject >8-input — and pre-1.0.5, even >5-input — transactions).
export const KSPT_MAX_INPUTS = 32;
export const KSPT_MAX_OUTPUTS = 4;

const MAGIC = [0x4b, 0x53, 0x50, 0x54]; // "KSPT"
const KSPT_VERSION = 0x01;
const FLAG_SIGNED = 0x01;
const FLAG_REDEEM = 0x02;

// Post-"Toccata" minimum relay fee rate (sompi per mass-gram) — KaspaFeePolicy on iOS.
export const MIN_RELAY_FEE_PER_GRAM = 100n;
// Standard Schnorr signature script size (0x41 push + 64-byte sig + 0x01 sighash).
const SCHNORR_SIG_SCRIPT_LEN = 66n;
// Change-output dust threshold — matches iOS/Android Cold Storage engines and the
// KasSigner firmware's own kspt.rs DUST_THRESHOLD.
const CHANGE_DUST_THRESHOLD = 20_000_000n;
const NATIVE_SUBNETWORK_ID_HEX = "00".repeat(20);

// ---------------------------------------------------------------------------
// Hex / byte helpers
// ---------------------------------------------------------------------------

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const clean = String(hex || "").trim();
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pushU16LE(arr, value) {
  const v = Number(value) & 0xffff;
  arr.push(v & 0xff, (v >> 8) & 0xff);
}

function pushU32LE(arr, value) {
  const v = Number(value) >>> 0;
  for (let i = 0; i < 4; i++) arr.push((v >>> (8 * i)) & 0xff);
}

function pushU64LE(arr, value) {
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) { arr.push(Number(v & 0xffn)); v >>= 8n; }
}

class ByteReader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  skip(n) { this.offset += n; }
  readBytes(n) {
    if (n < 0 || this.offset + n > this.bytes.length) throw new Error("KSPT payload is truncated");
    const slice = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  readU8() { return this.readBytes(1)[0]; }
  readU16LE() { const b = this.readBytes(2); return b[0] | (b[1] << 8); }
  readU32LE() { const b = this.readBytes(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; }
  readU64LE() {
    const b = this.readBytes(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }
}

// ---------------------------------------------------------------------------
// KSPT codec
// ---------------------------------------------------------------------------

export function looksLikeKspt(bytes) {
  return bytes.length >= 4 && MAGIC.every((m, i) => bytes[i] === m);
}

/** inputs: [{prevTxId, prevIndex, amountSompi, sequence, sigOpCount, spkVersion, spkScriptHex}]
 *  outputs: [{valueSompi, spkVersion, spkScriptHex}] — returns Uint8Array. */
export function encodeUnsignedKspt({ txVersion = 0, lockTime = 0n, subnetworkIdHex = NATIVE_SUBNETWORK_ID_HEX, gas = 0n, payloadHex = null, inputs, outputs }) {
  if (inputs.length < 1 || inputs.length > KSPT_MAX_INPUTS) throw new Error(`KSPT supports 1-${KSPT_MAX_INPUTS} inputs, got ${inputs.length}`);
  if (outputs.length < 1 || outputs.length > KSPT_MAX_OUTPUTS) throw new Error(`KSPT supports 1-${KSPT_MAX_OUTPUTS} outputs, got ${outputs.length}`);

  const out = [...MAGIC, KSPT_VERSION, 0x00]; // unsigned, no redeem script
  const payloadBytes = payloadHex ? (hexToBytes(payloadHex) || new Uint8Array(0)) : new Uint8Array(0);
  if (payloadBytes.length > 128) throw new Error(`KSPT payload must be <=128 bytes, got ${payloadBytes.length}`);

  pushU16LE(out, txVersion);
  out.push(inputs.length, outputs.length);
  pushU64LE(out, lockTime);
  const subnetworkBytes = hexToBytes(subnetworkIdHex);
  if (!subnetworkBytes || subnetworkBytes.length !== 20) throw new Error("subnetworkId must be 20 bytes");
  out.push(...subnetworkBytes);
  pushU64LE(out, gas);
  pushU16LE(out, payloadBytes.length);
  out.push(...payloadBytes);

  for (const input of inputs) {
    const txIdBytes = hexToBytes(input.prevTxId);
    if (!txIdBytes || txIdBytes.length !== 32) throw new Error("prevTxId must be 32 bytes");
    out.push(...txIdBytes);
    pushU32LE(out, input.prevIndex);
    pushU64LE(out, input.amountSompi);
    pushU64LE(out, input.sequence ?? 0n);
    out.push(Number(input.sigOpCount ?? 1) & 0xff);
    pushU16LE(out, input.spkVersion ?? 0);
    const spkBytes = hexToBytes(input.spkScriptHex) || new Uint8Array(0);
    if (spkBytes.length > 64) throw new Error(`scriptPublicKey must be <=64 bytes, got ${spkBytes.length}`);
    out.push(spkBytes.length, ...spkBytes);
  }

  for (const output of outputs) {
    pushU64LE(out, output.valueSompi);
    pushU16LE(out, output.spkVersion ?? 0);
    const spkBytes = hexToBytes(output.spkScriptHex) || new Uint8Array(0);
    if (spkBytes.length > 64) throw new Error(`scriptPublicKey must be <=64 bytes, got ${spkBytes.length}`);
    out.push(spkBytes.length, ...spkBytes);
  }

  return new Uint8Array(out);
}

export function decodeKspt(bytes) {
  if (!looksLikeKspt(bytes)) throw new Error("Not a KSPT payload (bad magic)");
  const reader = new ByteReader(bytes);
  reader.skip(4);

  const version = reader.readU8();
  if (version !== KSPT_VERSION) throw new Error(`Unsupported KSPT version ${version}`);
  const flags = reader.readU8();
  const signed = (flags & FLAG_SIGNED) !== 0;
  if (flags & FLAG_REDEEM) throw new Error("Multisig/redeem-script KSPT isn't supported");

  const txVersion = reader.readU16LE();
  const numInputs = reader.readU8();
  const numOutputs = reader.readU8();
  if (numInputs < 1 || numInputs > KSPT_MAX_INPUTS) throw new Error(`KSPT supports 1-${KSPT_MAX_INPUTS} inputs, got ${numInputs}`);
  if (numOutputs < 1 || numOutputs > KSPT_MAX_OUTPUTS) throw new Error(`KSPT supports 1-${KSPT_MAX_OUTPUTS} outputs, got ${numOutputs}`);
  const lockTime = reader.readU64LE();
  const subnetworkIdHex = bytesToHex(reader.readBytes(20));
  const gas = reader.readU64LE();
  const payloadLen = reader.readU16LE();
  if (payloadLen > 128) throw new Error(`KSPT payload must be <=128 bytes, got ${payloadLen}`);
  const payloadHex = bytesToHex(reader.readBytes(payloadLen));

  const inputs = [];
  for (let i = 0; i < numInputs; i++) {
    const prevTxId = bytesToHex(reader.readBytes(32));
    const prevIndex = reader.readU32LE();
    const amountSompi = reader.readU64LE();
    const sequence = reader.readU64LE();
    const sigOpCount = reader.readU8();
    const spkVersion = reader.readU16LE();
    const spkLen = reader.readU8();
    if (spkLen > 64) throw new Error(`scriptPublicKey must be <=64 bytes, got ${spkLen}`);
    const spkScriptHex = bytesToHex(reader.readBytes(spkLen));

    let signatureHex = null;
    let sighashType = null;
    if (signed) {
      const sigLen = reader.readU8();
      if (sigLen > 64) throw new Error(`signature must be <=64 bytes, got ${sigLen}`);
      if (sigLen > 0) {
        signatureHex = bytesToHex(reader.readBytes(sigLen));
        sighashType = reader.readU8();
      }
    }
    inputs.push({ prevTxId, prevIndex, amountSompi, sequence, sigOpCount, spkVersion, spkScriptHex, signatureHex, sighashType });
  }

  const outputs = [];
  for (let i = 0; i < numOutputs; i++) {
    const valueSompi = reader.readU64LE();
    const spkVersion = reader.readU16LE();
    const spkLen = reader.readU8();
    if (spkLen > 64) throw new Error(`scriptPublicKey must be <=64 bytes, got ${spkLen}`);
    const spkScriptHex = bytesToHex(reader.readBytes(spkLen));
    outputs.push({ valueSompi, spkVersion, spkScriptHex });
  }

  return { signed, txVersion, lockTime, subnetworkIdHex, gas, payloadHex, inputs, outputs };
}

// ---------------------------------------------------------------------------
// Multi-frame (animated) QR chunking — QrFrameChunker port, symmetric with
// KasSigner's own raw-byte scheme (kassee/src/qr.rs):
//   <=134 bytes: no wrapper — the raw payload is a single QR frame.
//   otherwise: [frameNum(1)][totalFrames(1)][fragLen(1)][fragment], balanced across
//   frames, capped at 64 frames, zero-padded to a minimum of 20 bytes per frame.
// ---------------------------------------------------------------------------

const SINGLE_FRAME_MAX = 134;
const MAX_FRAME_DATA = 106;
const MAX_FRAMES = 64;
const MIN_FRAME_SIZE = 20;
const FRAME_HEADER_SIZE = 3;

export function chunkQrFrames(bytes) {
  if (bytes.length <= SINGLE_FRAME_MAX) return [bytes];

  const totalFrames = Math.ceil(bytes.length / MAX_FRAME_DATA);
  if (totalFrames > MAX_FRAMES) throw new Error(`Payload too large to chunk into QR frames (${bytes.length} bytes)`);
  const perFrame = Math.ceil(bytes.length / totalFrames);

  const frames = [];
  let offset = 0;
  for (let frameNum = 0; frameNum < totalFrames; frameNum++) {
    const end = Math.min(offset + perFrame, bytes.length);
    const fragment = bytes.slice(offset, end);
    if (fragment.length > 255) throw new Error("Chunk fragment overflowed a single byte length field");
    const frame = [frameNum, totalFrames, fragment.length, ...fragment];
    while (frame.length < MIN_FRAME_SIZE) frame.push(0);
    frames.push(new Uint8Array(frame));
    offset = end;
  }
  return frames;
}

/** Reassembles frames scanned in any order/with duplicates. `isComplete` identifies a payload
 *  that arrived as a single unwrapped frame (pass looksLikeKspt). */
export class QrFrameAccumulator {
  constructor(isComplete) {
    this.isComplete = isComplete;
    this.totalFrames = null;
    this.received = new Map();
  }

  addFrame(bytes) {
    if (this.isComplete(bytes)) return bytes;
    if (bytes.length < FRAME_HEADER_SIZE) return null;

    const frameNum = bytes[0];
    const total = bytes[1];
    const fragLen = bytes[2];
    if (total < 2 || total > MAX_FRAMES || frameNum >= total || fragLen === 0) return null;
    if (bytes.length < FRAME_HEADER_SIZE + fragLen) return null;

    // A frame from a different scan (mismatched total) — reset rather than mixing
    // two different transactions' fragments together.
    if (this.totalFrames !== null && this.totalFrames !== total) this.reset();
    this.totalFrames = total;
    this.received.set(frameNum, bytes.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + fragLen));

    if (this.received.size < this.totalFrames) return null;

    const pieces = [];
    let length = 0;
    for (let i = 0; i < this.totalFrames; i++) {
      const piece = this.received.get(i);
      if (!piece) return null;
      pieces.push(piece);
      length += piece.length;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const piece of pieces) { out.set(piece, offset); offset += piece.length; }
    return out;
  }

  get progress() {
    return this.totalFrames === null ? null : { received: this.received.size, total: this.totalFrames };
  }

  get receivedFrameIndices() { return new Set(this.received.keys()); }

  reset() {
    this.totalFrames = null;
    this.received.clear();
  }
}

// ---------------------------------------------------------------------------
// Mass / fee (KaspaMass port) — verified reference: 1 input, two 34-byte
// outputs, no payload -> mass 2036.
// ---------------------------------------------------------------------------

export function calculateMass(numInputs, outputScriptLens, payloadSize = 0, sigOpCountPerInput = 1) {
  const n = BigInt(numInputs);
  const totalSigScriptBytes = n * SCHNORR_SIG_SCRIPT_LEN;

  let byteSize = 2n; // version (u16)
  byteSize += 8n; // input count
  byteSize += n * (36n + 8n + 8n) + totalSigScriptBytes; // outpoint + sigscript-len field + sequence, + sigscript bytes
  byteSize += 8n; // output count

  let scriptPubKeyMass = 0n;
  for (const scriptLen of outputScriptLens) {
    byteSize += 8n + 2n + 8n + BigInt(scriptLen); // value + scriptVersion + scriptLen + script
    scriptPubKeyMass += (2n + BigInt(scriptLen)) * 10n;
  }

  byteSize += 8n;  // lockTime
  byteSize += 20n; // subnetworkId
  byteSize += 8n;  // gas
  byteSize += 32n; // payload hash (fixed 32 bytes regardless of payload length)
  byteSize += 8n;  // payload length
  byteSize += BigInt(payloadSize);

  const sigOpMass = n * BigInt(sigOpCountPerInput) * 1000n;
  const computeMass = byteSize + scriptPubKeyMass + sigOpMass;

  // Post-"Toccata" RPC minimum-standard-fee policy: fee floor is
  // 100 sompi * max(computeMass, 2 * transactionByteSize).
  const doubled = byteSize * 2n;
  return computeMass > doubled ? computeMass : doubled;
}

export function calculateFee(mass, rateSompiPerGram) {
  const rate = BigInt(rateSompiPerGram);
  return mass * (rate > MIN_RELAY_FEE_PER_GRAM ? rate : MIN_RELAY_FEE_PER_GRAM);
}

/** Reference mass (1 input, two standard 34-byte P2PK outputs) — converts a user-entered
 *  total fee into a sompi-per-gram rate in the send form's fee editor. */
export const REFERENCE_MASS_FOR_FEE_EDITOR = calculateMass(1, [34, 34], 0);

/** Live quoted fee rate (sompi per mass-gram): the network's "normal" bucket quote or the
 *  protocol minimum, whichever is higher. Falls back to the minimum on any failure. */
export async function fetchQuotedFeeRateSompiPerGram() {
  try {
    const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
    const response = await fetch(`${base}/info/fee-estimate`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return MIN_RELAY_FEE_PER_GRAM;
    const decoded = await response.json();
    const quoted = decoded?.normalBuckets?.[0]?.feerate;
    if (!Number.isFinite(quoted)) return MIN_RELAY_FEE_PER_GRAM;
    const rate = BigInt(Math.ceil(quoted));
    return rate > MIN_RELAY_FEE_PER_GRAM ? rate : MIN_RELAY_FEE_PER_GRAM;
  } catch {
    return MIN_RELAY_FEE_PER_GRAM;
  }
}

// ---------------------------------------------------------------------------
// UTXO plumbing
// ---------------------------------------------------------------------------

/** Normalizes a wasm/rpc UTXO entry into the plain shape the engine works with. */
function normalizeUtxo(entry) {
  const outpoint = entry.outpoint || entry.entry?.outpoint || {};
  const spk = entry.scriptPublicKey || entry.entry?.scriptPublicKey || {};
  return {
    transactionId: String(outpoint.transactionId || ""),
    index: Number(outpoint.index ?? 0),
    amountSompi: BigInt(entry.amount ?? entry.entry?.amount ?? 0),
    spkVersion: Number(spk.version ?? 0),
    spkScriptHex: String(spk.script ?? ""),
    isCoinbase: Boolean(entry.isCoinbase ?? entry.entry?.isCoinbase),
    blockDaaScore: entry.blockDaaScore ?? entry.entry?.blockDaaScore ?? 0n,
  };
}

export function utxoKey(utxo) {
  return `${utxo.transactionId}:${utxo.index}`;
}

/** Fresh spendable set at `address`. Deliberately no coinbase filtering — the node's UTXO-set
 *  query only returns mature, spendable outputs, matching iOS/Android exactly. */
export async function fetchSpendableUtxos(engine, address) {
  const balance = await engine.balanceForAddress(address);
  return (balance.entries || []).map(normalizeUtxo);
}

export function isValidKaspaAddress(engine, address) {
  try {
    engine.kaspa.payToAddressScript(String(address || "").trim());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Selection (KaspaUtxoSelector port) — always prices as if there will be a change
// output: if change ends up dust and gets dropped, the real required fee is only
// lower, so this never underpays the network.
// ---------------------------------------------------------------------------

function selectUtxos(utxos, amountSompi, feeRateSompiPerGram, recipientScriptLen, changeScriptLen) {
  const sorted = [...utxos].sort((a, b) => (a.amountSompi > b.amountSompi ? -1 : a.amountSompi < b.amountSompi ? 1 : 0));
  const selected = [];
  let totalSelected = 0n;
  let estimatedFee = 0n;
  const outputScriptLens = [recipientScriptLen, changeScriptLen];

  for (const utxo of sorted) {
    selected.push(utxo);
    totalSelected += utxo.amountSompi;
    const mass = calculateMass(selected.length, outputScriptLens, 0);
    estimatedFee = calculateFee(mass, feeRateSompiPerGram);
    if (totalSelected >= amountSompi + estimatedFee) break;
  }

  let finalAmount = amountSompi;
  let requiredAmount = amountSompi + estimatedFee;

  if (totalSelected < requiredAmount) {
    // "Max Send" leeway: within 2000 sompi, trim the amount down rather than failing.
    if (totalSelected > estimatedFee && requiredAmount - totalSelected < 2000n) {
      finalAmount = totalSelected - estimatedFee;
    } else {
      return null;
    }
  }

  const changeSompi = totalSelected - finalAmount - estimatedFee;
  return { utxos: selected, feeSompi: estimatedFee, finalAmount, changeSompi };
}

function buildManualSelection(utxos, amountSompi, feeRateSompiPerGram, recipientScriptLen, changeScriptLen) {
  if (!utxos.length) return null;
  const totalSelected = utxos.reduce((sum, u) => sum + u.amountSompi, 0n);
  const mass = calculateMass(utxos.length, [recipientScriptLen, changeScriptLen], 0);
  const estimatedFee = calculateFee(mass, feeRateSompiPerGram);

  let finalAmount = amountSompi;
  const requiredAmount = amountSompi + estimatedFee;
  if (totalSelected < requiredAmount) {
    if (totalSelected > estimatedFee && requiredAmount - totalSelected < 2000n) {
      finalAmount = totalSelected - estimatedFee;
    } else {
      return null;
    }
  }

  const changeSompi = totalSelected - finalAmount - estimatedFee;
  return { utxos, feeSompi: estimatedFee, finalAmount, changeSompi };
}

// ---------------------------------------------------------------------------
// Build / preview / max / compound
// ---------------------------------------------------------------------------

function scriptFor(engine, address) {
  const spk = engine.kaspa.payToAddressScript(String(address).trim());
  return { version: Number(spk.version ?? 0), scriptHex: String(spk.script) };
}

/** Builds (but does not sign) a transfer. `manualUtxoKeys`, if given, fixes the exact input
 *  set (re-resolved against this call's own fresh fetch by outpoint, so a UTXO spent since
 *  the picker was shown can't silently get included). Returns the unsigned model used for
 *  KSPT encoding, verification, and broadcast. */
export async function buildUnsignedTransaction({ engine, fromAddress, toAddress, amountSompi, feeRateOverride = null, manualUtxoKeys = null }) {
  if (amountSompi <= 0n) throw new Error("Amount must be greater than zero");
  let recipientScript, changeScript;
  try { recipientScript = scriptFor(engine, toAddress); } catch { throw new Error("Invalid recipient address"); }
  try { changeScript = scriptFor(engine, fromAddress); } catch { throw new Error("Invalid source address"); }

  const spendable = await fetchSpendableUtxos(engine, fromAddress);
  if (!spendable.length) throw new Error("No spendable UTXOs at this address");

  const feeRate = feeRateOverride ?? await fetchQuotedFeeRateSompiPerGram();

  let selection;
  if (manualUtxoKeys && manualUtxoKeys.length) {
    const freshByKey = new Map(spendable.map((u) => [utxoKey(u), u]));
    const resolved = manualUtxoKeys.map((k) => freshByKey.get(k)).filter(Boolean);
    selection = buildManualSelection(resolved, amountSompi, feeRate, recipientScript.scriptHex.length / 2, changeScript.scriptHex.length / 2);
  } else {
    selection = selectUtxos(spendable, amountSompi, feeRate, recipientScript.scriptHex.length / 2, changeScript.scriptHex.length / 2);
  }
  if (!selection) throw new Error("Insufficient funds to cover that amount plus the network fee");
  if (selection.utxos.length > KSPT_MAX_INPUTS) {
    throw new Error(`This send would need ${selection.utxos.length} UTXOs, but KasSigner only supports ${KSPT_MAX_INPUTS} inputs per transaction. Send a smaller amount or consolidate this address first.`);
  }

  const outputs = [{ valueSompi: selection.finalAmount, spkVersion: recipientScript.version, spkScriptHex: recipientScript.scriptHex }];
  let changeSompi = 0n;
  if (selection.changeSompi > CHANGE_DUST_THRESHOLD) {
    changeSompi = selection.changeSompi;
    outputs.push({ valueSompi: selection.changeSompi, spkVersion: changeScript.version, spkScriptHex: changeScript.scriptHex });
  }

  return {
    fromAddress,
    toAddress,
    txVersion: 0,
    lockTime: 0n,
    subnetworkIdHex: NATIVE_SUBNETWORK_ID_HEX,
    gas: 0n,
    payloadHex: null,
    inputs: selection.utxos.map((utxo) => ({
      prevTxId: utxo.transactionId,
      prevIndex: utxo.index,
      amountSompi: utxo.amountSompi,
      sequence: 0n,
      sigOpCount: 1,
      spkVersion: utxo.spkVersion,
      spkScriptHex: utxo.spkScriptHex,
    })),
    outputs,
    finalAmountSompi: selection.finalAmount,
    feeSompi: selection.feeSompi,
    changeSompi,
  };
}

/** Live preview of what automatic selection would pick — lets the form show an already-exact
 *  fee and pass this same set into the real build so the two can't diverge. Standard 34-byte
 *  script lengths, matching iOS (this only needs the input count to be right). */
export async function previewAutomaticSelection({ engine, fromAddress, amountSompi, feeRateSompiPerGram }) {
  if (amountSompi <= 0n) return null;
  let spendable;
  try { spendable = await fetchSpendableUtxos(engine, fromAddress); } catch { return null; }
  if (!spendable.length) return null;
  const selection = selectUtxos(spendable, amountSompi, feeRateSompiPerGram, 34, 34);
  if (!selection) return null;
  return { utxoKeys: selection.utxos.map(utxoKey), feeSompi: selection.feeSompi };
}

/** Max sendable (full balance minus estimated fee, no change) — prices with every spendable
 *  UTXO as the input count, or the fixed coin-control subset when one is set. */
export async function estimateMaxAmount({ engine, fromAddress, feeRateOverride = null, manualUtxoKeys = null }) {
  const spendable = await fetchSpendableUtxos(engine, fromAddress);
  if (!spendable.length) throw new Error("No spendable UTXOs at this address");

  let utxosToUse = spendable;
  if (manualUtxoKeys && manualUtxoKeys.length) {
    const freshByKey = new Map(spendable.map((u) => [utxoKey(u), u]));
    utxosToUse = manualUtxoKeys.map((k) => freshByKey.get(k)).filter(Boolean);
    if (!utxosToUse.length) return 0n;
  } else {
    // Only as much as ONE transaction can actually spend. Automatic selection takes UTXOs
    // largest-first and stops when the amount is covered, so the most a single send can move is
    // the largest KSPT_MAX_INPUTS of them. Summing all of them, which is what this used to do,
    // offered a Max that could not be built: the build needs every UTXO to reach it, hits the
    // input cap, and refuses - and the reader only finds that out after pressing Build. Compound
    // is the way to spend the rest, and it is a press away in the same menu.
    utxosToUse = [...spendable]
      .sort((a, b) => (a.amountSompi > b.amountSompi ? -1 : a.amountSompi < b.amountSompi ? 1 : 0))
      .slice(0, KSPT_MAX_INPUTS);
  }

  const totalBalance = utxosToUse.reduce((sum, u) => sum + u.amountSompi, 0n);
  const feeRate = feeRateOverride ?? await fetchQuotedFeeRateSompiPerGram();
  const mass = calculateMass(Math.max(utxosToUse.length, 1), [34, 34], 0);
  const fee = calculateFee(mass, feeRate);
  return totalBalance > fee ? totalBalance - fee : 0n;
}

/** Compound: the largest up-to-KSPT_MAX_INPUTS spendable UTXOs (one KasSigner-signable
 *  transaction's worth), plus whether more remain for another round. */
export async function compoundInputs({ engine, fromAddress }) {
  const spendable = await fetchSpendableUtxos(engine, fromAddress);
  if (!spendable.length) throw new Error("No spendable UTXOs at this address");
  const sorted = [...spendable].sort((a, b) => (a.amountSompi > b.amountSompi ? -1 : a.amountSompi < b.amountSompi ? 1 : 0));
  const capped = sorted.slice(0, KSPT_MAX_INPUTS);
  return { utxoKeys: capped.map(utxoKey), hasMore: sorted.length > KSPT_MAX_INPUTS };
}

/** KSPT-encodes an unsigned build for display as an (animated) QR sequence. */
export function unsignedToKsptBytes(unsigned) {
  return encodeUnsignedKspt({
    txVersion: unsigned.txVersion,
    lockTime: unsigned.lockTime,
    subnetworkIdHex: unsigned.subnetworkIdHex,
    gas: unsigned.gas,
    payloadHex: unsigned.payloadHex,
    inputs: unsigned.inputs,
    outputs: unsigned.outputs,
  });
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/** Merges a scanned signed-KSPT response's per-input Schnorr signatures back into the
 *  unsigned build and broadcasts. Verifies every input outpoint AND every output
 *  amount/script against what was actually sent for signing first — a compromised or
 *  malfunctioning device altering the destination or amount must fail loudly here. */
export async function broadcastSigned({ engine, unsigned, decoded }) {
  if (!decoded.signed) throw new Error("Scanned transaction is not signed");
  if (decoded.inputs.length !== unsigned.inputs.length) throw new Error("Signed transaction has a different number of inputs");
  if (decoded.outputs.length !== unsigned.outputs.length) throw new Error("Signed transaction has a different number of outputs");

  decoded.outputs.forEach((decodedOutput, index) => {
    const original = unsigned.outputs[index];
    if (decodedOutput.valueSompi !== original.valueSompi || decodedOutput.spkScriptHex !== original.spkScriptHex) {
      throw new Error(`Signed transaction's output ${index} doesn't match what was sent for signing, so it won't be broadcast`);
    }
  });

  const signedInputs = unsigned.inputs.map((input, index) => {
    const decodedInput = decoded.inputs[index];
    if (decodedInput.prevTxId !== input.prevTxId || decodedInput.prevIndex !== input.prevIndex) {
      throw new Error(`Signed transaction's input ${index} doesn't match what was sent for signing`);
    }
    if (!decodedInput.signatureHex) throw new Error(`Input ${index} wasn't signed`);
    const sigBytes = hexToBytes(decodedInput.signatureHex);
    if (!sigBytes || sigBytes.length !== 64) throw new Error(`Unexpected signature length (${sigBytes?.length ?? 0} bytes, expected 64)`);

    // Standard P2PK signature script: push-64 opcode + 64-byte Schnorr sig + 1-byte sighash.
    const sighash = (decodedInput.sighashType ?? 0x01).toString(16).padStart(2, "0");
    const sigScriptHex = `41${decodedInput.signatureHex}${sighash}`;

    return {
      previousOutpoint: { transactionId: input.prevTxId, index: input.prevIndex },
      signatureScript: sigScriptHex,
      sequence: input.sequence,
      sigOpCount: input.sigOpCount,
      utxo: {
        address: undefined,
        outpoint: { transactionId: input.prevTxId, index: input.prevIndex },
        amount: input.amountSompi,
        scriptPublicKey: new engine.kaspa.ScriptPublicKey(input.spkVersion, input.spkScriptHex),
        blockDaaScore: 0n,
        isCoinbase: false,
      },
    };
  });

  const tx = new engine.kaspa.Transaction({
    version: unsigned.txVersion,
    inputs: signedInputs,
    outputs: unsigned.outputs.map((output) => ({
      value: output.valueSompi,
      scriptPublicKey: new engine.kaspa.ScriptPublicKey(output.spkVersion, output.spkScriptHex),
    })),
    lockTime: unsigned.lockTime,
    subnetworkId: unsigned.subnetworkIdHex,
    gas: unsigned.gas,
    payload: unsigned.payloadHex || "",
  });
  tx.finalize();

  await engine.connect();
  const response = await engine.withRpc(
    (rpc) => rpc.submitTransaction({ transaction: tx, allowOrphan: false }),
    { retries: 1, label: "Cold storage broadcast" }
  );
  return response?.transactionId || tx.id;
}
