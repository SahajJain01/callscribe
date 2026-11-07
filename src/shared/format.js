// Transcript rendering and file naming. ES module (background, library page, tests).

const pad = (n) => String(n).padStart(2, "0")

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

function localDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function slug(s, max = 60) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, max)
    .replace(/-+$/, "")
}

export function fileBase(session) {
  const d = new Date(session.startedAt)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
  const parts = [stamp, slug(session.platformName)]
  const title = slug(session.title)
  if (title) parts.push(title)
  return parts.join("_")
}

/** Consecutive lines from one speaker read as one paragraph. */
export function turns(utterances) {
  const out = []
  for (const u of utterances || []) {
    if (!u.text) continue
    const last = out[out.length - 1]
    if (last && last.speaker === u.speaker && u.start - last.end < 4000) {
      last.text += " " + u.text
      last.end = Math.max(last.end, u.end)
      last.estimated = last.estimated || Boolean(u.estimated)
    } else {
      out.push({ speaker: u.speaker, text: u.text, start: u.start, end: u.end, estimated: Boolean(u.estimated) })
    }
  }
  return out
}

// opts.audioFile: the audio file actually written next to this transcript (a name), or null
// when the audio couldn't be saved. Left out: the old guess from the session's base name.
export function formatTranscript(session, opts = {}) {
  const start = session.startedAt
  const end = session.endedAt || session.updatedAt || start
  const ts = turns(session.utterances)
  const speakers = [...new Set(ts.map((t) => t.speaker))]
  const lines = [
    `# ${session.title || session.platformName + " call"}`,
    "",
    `- Platform: ${session.platformName}`,
    `- Started: ${localDateTime(new Date(start))}`,
    `- Duration: ${clock(end - start)}`,
  ]
  if (speakers.length) lines.push(`- Speakers: ${speakers.join(", ")}`)
  if (session.audio && session.audio.chunks) {
    const file = opts.audioFile === undefined ? `${fileBase(session)}.webm` : opts.audioFile
    lines.push(file ? `- Audio backup: ${file} (timestamps below match it)` : "- Audio backup: not saved")
  }
  if (session.url) lines.push(`- Link: ${session.url}`)
  if (ts.some((t) => t.estimated)) lines.push("- Times marked ~ are estimates: those captions reached the page in a batch, not live.")
  lines.push("", "---", "")
  if (!ts.length) lines.push("_No captions were captured. Were captions turned on?_", "")
  for (const t of ts) lines.push(`**${t.speaker}** \`${t.estimated ? "~" : ""}${clock(t.start - start)}\``, t.text, "")
  return lines.join("\n")
}
