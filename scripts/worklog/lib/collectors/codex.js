import path from 'node:path'
import { promises as fs } from 'node:fs'
import { dateWindow, localDateForTimestamp, resolveCodexHome, resolveTimezone } from '../paths.js'
import { eventId, redactText } from '../util.js'

const USER_LIMIT = 1200
const ASSISTANT_LIMIT = 1200
const DEFAULT_LOOKBACK_DAYS = 30
const DONE_TEXT_LIMIT = 80

export async function collectCodex({ date, codexHome, timezone, lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const resolvedCodexHome = resolveCodexHome(codexHome)
  const resolvedTimezone = resolveTimezone(timezone)
  const resolvedLookbackDays = normalizeLookbackDays(lookbackDays)
  const scanDirs = dateWindow({
    codexHome: resolvedCodexHome,
    date,
    lookbackDays: resolvedLookbackDays,
    timezone: resolvedTimezone,
  })

  const scan = {
    codexHome: resolvedCodexHome,
    timezone: resolvedTimezone,
    lookbackDays: resolvedLookbackDays,
    startDate: scanDirs[0]?.date || date,
    endDate: date,
    directories: [],
    scannedDirectoryCount: 0,
    scannedFileCount: 0,
    sessionCount: 0,
    skippedEvents: emptySkippedEvents(),
    errors: [],
  }
  const candidates = []
  const seenFiles = new Set()

  for (const dir of scanDirs) {
    const files = await findRolloutFiles(dir.path, scan)
    scan.directories.push({
      date: dir.date,
      path: dir.path,
      exists: files.exists,
      fileCount: files.paths.length,
    })
    if (files.exists) scan.scannedDirectoryCount += 1

    for (const filePath of files.paths) {
      if (seenFiles.has(filePath)) continue
      seenFiles.add(filePath)
      scan.scannedFileCount += 1
      const session = await summarizeRollout(filePath, { targetDate: date, timezone: resolvedTimezone, scan })
      if (!session) continue
      scan.sessionCount += 1
      candidates.push(...candidatesForSession(session))
    }
  }

  candidates.sort(compareCandidates)
  return { candidates, scan }
}

function candidatesForSession(session) {
  const project = session.cwd ? path.basename(session.cwd) : ''
  const source = `archaeology:codex:${session.id}`
  const doneText = session.title || session.firstUserMessage.slice(0, DONE_TEXT_LIMIT) || session.id
  const out = [makeCandidate({ ts: session.endedAt, type: 'done', text: doneText, project, source })]
  for (const todo of session.todos) {
    out.push(makeCandidate({ ts: todo.ts, type: 'todo', text: todo.text, project, source }))
  }
  for (const idea of session.ideas) {
    out.push(makeCandidate({ ts: idea.ts, type: 'idea', text: idea.text, project, source }))
  }
  return out
}

function makeCandidate({ ts, type, text, project, source }) {
  const redacted = redactText(text)
  return { id: eventId(ts, redacted), ts, type, text: redacted, project, source }
}

async function findRolloutFiles(sessionDir, scan) {
  let entries
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      scan.errors.push({ path: sessionDir, message: String(error?.message || error) })
    }
    return { exists: false, paths: [] }
  }

  const paths = entries
    .filter(entry => entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
    .map(entry => path.join(sessionDir, entry.name))
    .sort()
  return { exists: true, paths }
}

async function summarizeRollout(filePath, { targetDate, timezone, scan }) {
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    scan.errors.push({ path: filePath, message: String(error?.message || error) })
    return null
  }

  const events = []
  const fileMetadata = { cwd: '', title: '' }
  const skippedEvents = emptySkippedEvents()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      const payload = event.payload || {}
      if (event.cwd && !fileMetadata.cwd) fileMetadata.cwd = String(event.cwd)
      if (payload.cwd && !fileMetadata.cwd) fileMetadata.cwd = String(payload.cwd)
      if (payload.title && !fileMetadata.title) fileMetadata.title = String(payload.title)
      const timestamp = typeof event.timestamp === 'string' ? event.timestamp : ''
      if (!timestamp) {
        skippedEvents.missingTimestamp += 1
        continue
      }
      const localDate = localDateForTimestamp(timestamp, timezone)
      if (!localDate) {
        skippedEvents.invalidTimestamp += 1
        continue
      }
      if (localDate !== targetDate) {
        skippedEvents.outsideTargetDate += 1
        continue
      }
      events.push(event)
    } catch {
      skippedEvents.malformedLines += 1
    }
  }

  addSkippedEvents(scan.skippedEvents, skippedEvents)
  if (!events.length) return null

  const session = {
    id: extractSessionId(filePath),
    startedAt: '',
    endedAt: '',
    cwd: '',
    title: '',
    firstUserMessage: '',
    todos: [],
    ideas: [],
  }

  for (const event of events) {
    const timestamp = event.timestamp
    if (!session.startedAt) session.startedAt = timestamp
    session.endedAt = timestamp

    const payload = event.payload || {}
    if (event.cwd && !session.cwd) session.cwd = String(event.cwd)
    if (payload.cwd && !session.cwd) session.cwd = String(payload.cwd)
    if (payload.title && !session.title) session.title = String(payload.title)

    if (event.type === 'event_msg' && payload.type === 'user_message') {
      const text = sanitize(payload.message, USER_LIMIT)
      if (text) {
        if (!session.firstUserMessage) session.firstUserMessage = text
        collectTodoIdeas(text, timestamp, session)
      }
      continue
    }

    if (event.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const text = sanitize(extractAssistantText(payload), ASSISTANT_LIMIT)
      if (text) collectTodoIdeas(text, timestamp, session)
    }
  }

  if (!session.cwd) session.cwd = fileMetadata.cwd
  if (!session.title) session.title = fileMetadata.title
  return session
}

function extractAssistantText(payload) {
  if (!Array.isArray(payload.content)) return ''
  return payload.content
    .map(part => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.content === 'string') return part.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function collectTodoIdeas(text, ts, session) {
  const lines = String(text || '').split(/\n|。|；|;/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/(todo|待办|后续|明天|next step|follow[- ]?up)/i.test(line)) {
      session.todos.push({ ts, text: cleanListMarker(line) })
    }
    if (/(idea|想法|灵感|可以考虑|值得尝试)/i.test(line)) {
      session.ideas.push({ ts, text: cleanListMarker(line) })
    }
  }
}

function cleanListMarker(value) {
  return String(value).replace(/^[-*]\s*/, '').trim()
}

function sanitize(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}...`
}

function extractSessionId(filePath) {
  return path.basename(filePath, '.jsonl').replace(/^rollout-/, '')
}

function compareCandidates(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

function emptySkippedEvents() {
  return {
    malformedLines: 0,
    missingTimestamp: 0,
    invalidTimestamp: 0,
    outsideTargetDate: 0,
  }
}

function addSkippedEvents(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += Number(source?.[key] || 0)
  }
}

function normalizeLookbackDays(value) {
  const number = Number(value ?? DEFAULT_LOOKBACK_DAYS)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid --lookback-days "${value}". Expected a non-negative integer.`)
  }
  return number
}
