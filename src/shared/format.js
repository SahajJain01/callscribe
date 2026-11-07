// Transcript rendering and file naming. ES module (background, library page, tests).

const pad = (n) => String(n).padStart(2, "0")

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

function localDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Letters that don't decompose to a base letter plus accents.
const FOLD = { đ: "d", Đ: "D", ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", ø: "o", Ø: "O", œ: "oe", Œ: "OE", ł: "l", Ł: "L", þ: "th", Þ: "Th" }

/**
 * A title as part of a file name, in any script. Latin accents are dropped (é -> e, Đ -> D,
 * ß -> ss); other letters and digits are kept as they are (週次定例, ประชุม). Punctuation and
 * anything a file system refuses goes; spaces become "-". Cut to max characters, not UTF-16 units.
 */
export function slug(s, max = 60) {
  const t = String(s || "")
    .replace(/[đĐßẞæÆøØœŒłŁþÞ]/g, (c) => FOLD[c])
    .normalize("NFKD")
    // Strip accents from Latin letters only: other scripts need their marks (Thai vowels, Hangul jamo).
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/[\s_]+/g, "-")
  return Array.from(t).slice(0, max).join("").replace(/-+$/, "")
}

export function fileBase(session) {
  const d = new Date(session.startedAt)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
  const parts = [stamp, slug(session.platformName)]
  const title = slug(session.title)
  if (title) parts.push(title)
  return parts.join("_")
}

// ---- Markdown escaping. Titles, names, captions and the link come from the call app or other
// participants, so nothing they contain may turn into an image, a link, HTML or a block element.
const oneLine = (s) => String(s == null ? "" : s).replace(/[\s\u2028\u2029]+/g, " ").trim()
// Inline metacharacters: emphasis, code, links and images ("[", so "![x](y)" is plain text),
// HTML and autolinks ("<"). "_" only where it could start or end emphasis, not inside a word,
// so snake_case names stay readable.
function inline(s) {
  return oneLine(s)
    .replace(/[\\`*[\]<>]/g, "\\$&")
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace("_", "\\_"))
}
// A whole line of text: inline escapes, and a start that would make it a heading, list, quote,
// rule, setext underline or numbered list is escaped too.
function line(s) {
  const t = inline(s)
  if (/^(#|>|[-+=]|\d+[.)](\s|$))/.test(t)) return t.replace(/^(\d+)([.)])/, "$1\\$2").replace(/^([#>+=-])/, "\\$1")
  return t
}
// Only https links are written as links.
function link(url) {
  const u = oneLine(url)
  return /^https:\/\/[^\s<>]+$/i.test(u) ? `<${u}>` : inline(u)
}

/** Consecutive lines from one speaker read as one paragraph. Unknown speakers on different devices never merge. */
export function turns(utterances) {
  const out = []
  for (const u of utterances || []) {
    if (!u.text) continue
    const speaker = oneLine(u.speaker) || "Unknown"
    const last = out[out.length - 1]
    // Unnamed speakers merge only when they are known to be the same device.
    const same = last && last.speaker === speaker && (/^Unknown/.test(speaker) ? Boolean(u.device) && last.device === u.device : (last.device || "") === (u.device || ""))
    if (same && u.start - last.end < 4000) {
      last.text += " " + u.text
      last.end = Math.max(last.end, u.end)
    } else {
      // ~ marks the shown time: the first line's start.
      out.push({ speaker, device: u.device, text: u.text, start: u.start, end: u.end, estimated: Boolean(u.estimated) })
    }
  }
  return out
}

// opts.audioFile: the audio file actually written next to this transcript (a name), or null
// when the audio couldn't be saved. Left out: the name it would get (base name and the type
// it was recorded in).
export function formatTranscript(session, opts = {}) {
  const start = session.startedAt
  const end = session.endedAt || session.updatedAt || start
  const ts = turns(session.utterances)
  const speakers = [...new Set(ts.map((t) => t.speaker))]
  const lines = [
    `# ${inline(session.title) || inline(session.platformName + " call")}`,
    "",
    `- Platform: ${inline(session.platformName)}`,
    `- Started: ${localDateTime(new Date(start))}`,
    `- Duration: ${clock(end - start)}`,
  ]
  if (speakers.length) lines.push(`- Speakers: ${speakers.map(inline).join(", ")}`)
  if (session.audio && session.audio.chunks) {
    const ext = /ogg/.test(session.audio.mime || "") ? "ogg" : "webm"
    const file = opts.audioFile === undefined ? `${fileBase(session)}.${ext}` : opts.audioFile
    lines.push(file ? `- Audio backup: ${inline(file)} (timestamps below match it)` : "- Audio backup: not saved")
  }
  if (session.url) lines.push(`- Link: ${link(session.url)}`)
  if (ts.some((t) => t.estimated)) lines.push("- Times marked ~ are estimates: those captions reached the page in a batch, not live.")
  lines.push("", "---", "")
  if (!ts.length) lines.push("_No captions were captured. Were captions turned on?_", "")
  for (const t of ts) lines.push(`**${inline(t.speaker)}** \`${t.estimated ? "~" : ""}${clock(t.start - start)}\``, line(t.text), "")
  return lines.join("\n")
}
