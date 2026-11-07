// Google Meet's caption stream: the protobuf messages on its "captions_v2" WebRTC data channel.
//
// Meet's server runs speech recognition for every call. A client gets the results by sending a
// "language" request on captions_v2 (the CC button sends one with e.g. "en-US"; turning CC off
// sends one with ""). Captions then arrive on the same channel whether or not the page draws
// them. Field numbers below were read from real traffic (test/fixtures/meet-captions-v2.json).
//
//   client -> server  { 1: { 2: { 1: seq, 2: { 1: { 2: lang, 3: lang } } } } }   captions on
//                     { 1: { 2: { 1: seq, 2: { 1: "" } } } }                      captions off
//                     { 1: { 1: { 1: utteranceId, 2: version, 3: 1 } }* }         acks (Meet sends these)
//   server -> client  { 1: { 2: { 1: seq, 3: "" } } }                             reply to a request
//                     { 1: { 1: utterance, 6: { 1: unixSeconds } } }              caption update
//   utterance         { 1: id, 2: version, 3: { 2: final?, 3: text, 4: lang, 6: deviceId } }
//
// Each update carries the utterance's whole current text; higher versions replace lower ones,
// and the last version has the final flag set. deviceId matches data-participant-id on tiles.
//
// Classic script (content scripts cannot import modules); also loadable from Node for tests.
;(function (root) {
  "use strict"

  const utf8 = new TextDecoder("utf-8", { fatal: true })
  const utf8enc = new TextEncoder()

  /** Parse one protobuf message into [{ f, w, v }] (v: number or Uint8Array). null if malformed. */
  function fields(b) {
    const out = []
    let i = 0
    const varint = () => {
      let r = 0
      let mul = 1
      for (let n = 0; n < 10; n++) {
        if (i >= b.length) return null
        const x = b[i++]
        r += (x & 127) * mul
        if (!(x & 128)) return r
        mul *= 128
      }
      return null
    }
    while (i < b.length) {
      const k = varint()
      if (k === null) return null
      const f = Math.floor(k / 8)
      const w = k % 8
      if (f < 1) return null
      if (w === 0) {
        const v = varint()
        if (v === null) return null
        out.push({ f, w, v })
      } else if (w === 2) {
        const n = varint()
        if (n === null || i + n > b.length) return null
        out.push({ f, w, v: b.subarray(i, i + n) })
        i += n
      } else if (w === 1 || w === 5) {
        const n = w === 1 ? 8 : 4
        if (i + n > b.length) return null
        out.push({ f, w, v: b.subarray(i, i + n) })
        i += n
      } else return null
    }
    return out
  }

  const get = (fs, f) => fs && fs.find((x) => x.f === f)
  const all = (fs, f) => (fs ? fs.filter((x) => x.f === f) : [])
  const sub = (x) => (x && x.w === 2 ? fields(x.v) : null)
  const num = (x) => (x && x.w === 0 ? x.v : undefined)
  function str(x) {
    if (!x || x.w !== 2) return undefined
    try {
      return utf8.decode(x.v)
    } catch {
      return undefined
    }
  }

  function utterance(x) {
    const u = sub(x)
    const cap = sub(get(u, 3))
    const id = num(get(u, 1))
    const device = str(get(cap, 6))
    if (id === undefined || !cap || !device) return null
    return {
      id: String(id),
      version: num(get(u, 2)) || 0,
      final: num(get(cap, 2)) === 1,
      text: str(get(cap, 3)) || "",
      lang: str(get(cap, 4)) || "",
      device,
    }
  }

  /** Server -> client. { kind: "captions", utterances, serverTime } | { kind: "reply", seq } | { kind: "other" } | null */
  function decodeIncoming(bytes) {
    const top = fields(bytes)
    const body = sub(get(top, 1))
    if (!body) return null
    const utterances = all(body, 1).map(utterance).filter(Boolean)
    if (utterances.length) {
      const secs = num(get(sub(get(body, 6)), 1))
      return { kind: "captions", utterances, serverTime: secs ? secs * 1000 : undefined }
    }
    const reply = sub(get(body, 2))
    const seq = num(get(reply, 1))
    if (seq !== undefined && get(reply, 3)) return { kind: "reply", seq }
    return { kind: "other" }
  }

  /** Client -> server. { kind: "language", seq, lang } ("" = captions off) | { kind: "other" } | null */
  function decodeOutgoing(bytes) {
    const top = fields(bytes)
    const body = sub(get(top, 1))
    if (!body) return null
    const req = sub(get(body, 2))
    const seq = num(get(req, 1))
    const prefs = sub(get(req, 2))
    if (seq !== undefined && prefs) {
      const pair = get(prefs, 1)
      if (pair && pair.w === 2 && pair.v.length === 0) return { kind: "language", seq, lang: "" }
      const p = sub(pair)
      if (p) return { kind: "language", seq, lang: str(get(p, 2)) || str(get(p, 3)) || "" }
    }
    return { kind: "other" }
  }

  function varintBytes(n) {
    const o = []
    while (n > 127) {
      o.push((n % 128) | 128)
      n = Math.floor(n / 128)
    }
    o.push(n)
    return o
  }
  const ld = (f, b) => [(f << 3) | 2, ...varintBytes(b.length), ...b]

  /** The request Meet's CC button sends: captions in `lang` ("" turns them off). */
  function encodeLanguage(seq, lang) {
    const l = [...utf8enc.encode(lang)]
    const prefs = lang ? ld(1, [...ld(2, l), ...ld(3, l)]) : ld(1, [])
    return new Uint8Array(ld(1, ld(2, [0x08, ...varintBytes(seq), ...ld(2, prefs)])))
  }

  /**
   * Participant names from a "collections" message: any nested message whose field 1 is a
   * device id ("spaces/…/devices/…") and field 2 a non-empty string. Returns [[deviceId, name]].
   */
  function findDeviceNames(bytes, depth = 0, out = []) {
    if (depth > 14) return out
    const fs = fields(bytes)
    if (!fs) return out
    const id = str(get(fs, 1))
    const name = str(get(fs, 2))
    if (id && /^spaces\/[^/]+\/devices\/[^/]+$/.test(id) && name && !/[\u0000-\u001f]/.test(name)) out.push([id, name])
    for (const x of fs) if (x.w === 2 && x.v.length > 2) findDeviceNames(x.v, depth + 1, out)
    return out
  }

  const api = { decodeIncoming, decodeOutgoing, encodeLanguage, findDeviceNames, fields }
  root.CallScribe = root.CallScribe || {}
  root.CallScribe.MeetProto = api
  if (typeof module !== "undefined" && module.exports) module.exports = api
})(typeof globalThis !== "undefined" ? globalThis : this)
