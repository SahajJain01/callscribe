// Checks on attacker.js's object-level routes (Task 1 review C1, I1, I2, I3), shared by the
// e2e scripts. Not vacuous: every patch the attacker means to install must be installed and
// must have fired on its own objects, and its forgeries must have run.
export const OBJECT_HOOKS = [
  "MediaRecorder.start", "MediaRecorder.stop", "MediaRecorder.pause", "MediaRecorder.resume", "MediaRecorder.requestData",
  "MediaRecorder.get state",
  "AudioContext.createGain", "AudioContext.createMediaStreamSource", "AudioContext.createMediaStreamDestination",
  "AudioContext.createConstantSource", "AudioContext.resume", "AudioContext.close", "AudioContext.get currentTime", "AudioContext.get state",
  "AudioNode.connect", "AudioNode.disconnect", "GainNode.get gain", "ConstantSourceNode.get offset",
  "MediaStreamAudioDestinationNode.get stream", "AudioParam.set value", "AudioParam.setValueAtTime", "AudioParam.setTargetAtTime",
  "AudioParam.linearRampToValueAtTime", "AudioParam.cancelScheduledValues",
  "Blob.get size", "BlobEvent.get data", "FileReader.readAsArrayBuffer",
  "RTCDataChannel.get label", "RTCDataChannel.get readyState", "RTCDataChannel.send", "MessageEvent.get data",
  "RTCPeerConnection.createDataChannel",
]

export function attackerObjectChecks(atk, check, { meet = false } = {}) {
  const hooked = new Set((atk && atk.hooked) || [])
  const missing = OBJECT_HOOKS.filter((h) => !hooked.has(h))
  check(missing.length === 0, `attacker patched every recorder/WebAudio/Blob/data-channel route (missing: ${missing.join(", ") || "none"})`)
  // RTCPeerConnection.createDataChannel is the collector for the dc attack, checked through dcForged.
  const silent = OBJECT_HOOKS.filter((h) => h !== "RTCPeerConnection.createDataChannel" && !(atk && atk.selfTest && atk.selfTest[h] > 0))
  check(silent.length === 0, `each patch fired on the attacker's own objects, so it was live (silent: ${silent.join(", ") || "none"})`)
  check(atk && atk.recorders === 0 && atk.recChunks === 0, `no CallScribe recorder reached page code (caught ${atk && atk.recorders}, chunks read ${atk && atk.recChunks})`)
  check(atk && atk.graphHits === 0 && atk.gateForced === 0, `CallScribe's audio graph never went through page-patched WebAudio (hits ${atk && atk.graphHits}, mic gate forced ${atk && atk.gateForced})`)
  check(atk && atk.blobReads === 0, `no recorded audio read through page-patched Blob/BlobEvent/FileReader (${atk && atk.blobReads})`)
  check(atk && atk.dcReads === 0, `no data-channel read through page-patched getters (${atk && atk.dcReads})`)
  if (meet) check(atk && atk.dcForged > 0, `attacker dispatched forged open/caption-frame events on a data channel CallScribe taps (${atk && atk.dcForged} rounds)`)
  check(atk && atk.errors.length === 0, `attacker ran without errors (${JSON.stringify(atk && atk.errors)})`)
}
