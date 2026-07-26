import {
  assertValidDate,
  localDateForTimestamp,
  resolveCodexHome,
  resolveTimezone,
  resolveWlHome,
  wlPaths,
} from './paths.js'
import {
  atomicWrite,
  eventId,
  isoNow,
  normalizeText,
  readJson,
  readJsonl,
  unique,
} from './util.js'
import { collectCodex } from './collectors/codex.js'
import { collectGitlog } from './collectors/gitlog.js'

const DAY_MS = 24 * 60 * 60 * 1000

export async function assembleDay({ wlHome, date, timezone, lookbackDays, useLlm = false } = {}) {
  assertValidDate(date)
  const home = resolveWlHome(wlHome)
  const paths = wlPaths(home)
  const tz = resolveTimezone(timezone)
  const lookback = parseLookback(lookbackDays)

  const inbox = await readJsonl(paths.inbox)
  const knownCommitSources = new Set()
  for (const row of inbox.rows) {
    if (typeof row?.source === 'string' && row.source.startsWith('commit:')) {
      knownCommitSources.add(row.source)
    }
  }

  const firsthandAll = []
  for (const row of inbox.rows) {
    if (!row || typeof row.ts !== 'string' || typeof row.text !== 'string') continue
    if (localDateForTimestamp(row.ts, tz) !== date) continue
    firsthandAll.push({
      id: eventId(row.ts, row.text),
      ts: row.ts,
      type: row.type,
      text: row.text,
      project: row.project || '',
      source: row.source || 'manual',
    })
  }
  firsthandAll.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))

  const snapshot = await readJson(paths.ledgerSnapshot, null)
  const openTodosSnapshot = buildOpenTodosSnapshot(snapshot, date)

  const supplement = await detectSupplement({ paths, snapshot, date })
  const firsthand = supplement
    ? firsthandAll.filter(event => {
        const tsMs = Date.parse(event.ts)
        return Number.isFinite(tsMs) && tsMs > supplement.lastAppliedAtMs
      })
    : firsthandAll

  const codexResult = await runCollector(() =>
    collectCodex({ date, codexHome: resolveCodexHome(), timezone: tz, lookbackDays: lookback }),
  )
  const gitlogResult = await runCollector(() =>
    collectGitlog({ date, timezone: tz, reposListPath: paths.reposList, knownCommitSources }),
  )

  const candidates = dedupeCandidates({
    rawCandidates: [...codexResult.candidates, ...gitlogResult.candidates],
    firsthandAll,
    knownCommitSources,
    decidedCandidateIds: supplement ? supplement.decidedCandidateIds : new Set(),
  })

  const completionCandidates = exactCompletions({ firsthand, candidates, openTodosSnapshot })

  let llm = null
  if (useLlm && process.env.WORKLOG_MATCH_MODEL) {
    try {
      const { runMatch } = await import('./match.js')
      const result = await runMatch({
        candidates,
        firsthand,
        openTodos: openTodosSnapshot,
        lang: 'zh-CN',
      })
      llm = interpretMatchResult({ result, firsthand, candidates, openTodosSnapshot, completionCandidates })
    } catch {
      llm = null
    }
  }

  const finalCandidates = llm ? candidates.filter(candidate => !llm.mergedIds.has(candidate.id)) : candidates
  if (llm) completionCandidates.push(...llm.completions)

  const overview = llm && llm.overview
    ? { text: llm.overview, by: 'llm' }
    : {
        text: `共 ${firsthand.length} 条记录覆盖 ${unique(firsthand.map(event => event.project)).length} 个项目。`,
        by: 'template',
      }

  const day = {
    schemaVersion: 1,
    date,
    ...(supplement ? { mode: 'supplement' } : {}),
    assembledAt: isoNow(),
    firsthand,
    candidates: finalCandidates,
    completionCandidates,
    openTodosSnapshot,
    overview,
    scan: {
      inboxLines: firsthandAll.length,
      collectors: { codex: codexResult.scan, gitlog: gitlogResult.scan },
    },
  }

  const dayJsonPath = paths.dayJson(date)
  await atomicWrite(dayJsonPath, `${JSON.stringify(day, null, 2)}\n`)
  return { path: dayJsonPath, day }
}

const PATCH_FIELDS = [
  'date',
  'acceptCandidates',
  'rejectCandidates',
  'editText',
  'completeTodos',
  'addTodos',
  'addIdeas',
  'skipDay',
]

export async function confirmDay({ wlHome, date, patch } = {}) {
  assertValidDate(date)
  const home = resolveWlHome(wlHome)
  const paths = wlPaths(home)

  const day = await readJson(paths.dayJson(date), null)
  if (!day) {
    throw new Error(`day.json for ${date} is missing or invalid. Run \`wl assemble --date ${date}\` first.`)
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Invalid patch: expected a JSON object.')
  }

  const unknownFields = Object.keys(patch).filter(key => !PATCH_FIELDS.includes(key))
  if (unknownFields.length) {
    throw new Error(
      `Unknown patch fields: ${unknownFields.join(', ')}. Allowed fields: ${PATCH_FIELDS.join(', ')}.`,
    )
  }
  if (patch.date !== undefined && patch.date !== date) {
    throw new Error(`Patch date "${patch.date}" does not match --date ${date}.`)
  }
  if (patch.skipDay !== undefined && typeof patch.skipDay !== 'boolean') {
    throw new Error('Invalid patch field skipDay: expected a boolean.')
  }

  const acceptCandidates = stringArrayField(patch.acceptCandidates, 'acceptCandidates')
  const rejectCandidates = stringArrayField(patch.rejectCandidates, 'rejectCandidates')
  const editText = objectArrayField(patch.editText, 'editText', { required: ['id', 'text'], optional: [] })
  const completeTodos = objectArrayField(patch.completeTodos, 'completeTodos', {
    required: ['todoId'],
    optional: ['evidence'],
  })
  const addTodos = objectArrayField(patch.addTodos, 'addTodos', { required: ['text'], optional: ['project'] })
  const addIdeas = objectArrayField(patch.addIdeas, 'addIdeas', { required: ['text'], optional: [] })

  const candidateIds = new Set((Array.isArray(day.candidates) ? day.candidates : []).map(item => item.id))
  const firsthandIds = new Set((Array.isArray(day.firsthand) ? day.firsthand : []).map(item => item.id))
  const todoIds = new Set(
    (Array.isArray(day.openTodosSnapshot) ? day.openTodosSnapshot : []).map(item => item.id),
  )

  const unknownIds = []
  for (const id of acceptCandidates) if (!candidateIds.has(id)) unknownIds.push(id)
  for (const id of rejectCandidates) if (!candidateIds.has(id)) unknownIds.push(id)
  for (const entry of editText) {
    if (!firsthandIds.has(entry.id) && !candidateIds.has(entry.id)) unknownIds.push(entry.id)
  }
  for (const entry of completeTodos) if (!todoIds.has(entry.todoId)) unknownIds.push(entry.todoId)
  if (unknownIds.length) {
    throw new Error(
      `Unknown ids in patch: ${unique(unknownIds).join(', ')}. ` +
        'Ids must come from day.json candidates/firsthand or openTodosSnapshot.',
    )
  }

  const doubleDecided = acceptCandidates.filter(id => rejectCandidates.includes(id))
  if (doubleDecided.length) {
    throw new Error(`Candidate ids listed in both acceptCandidates and rejectCandidates: ${unique(doubleDecided).join(', ')}.`)
  }

  const confirmation = {
    date,
    acceptCandidates,
    rejectCandidates,
    editText,
    completeTodos,
    addTodos,
    addIdeas,
    skipDay: patch.skipDay === true,
  }

  const confirmationPath = paths.confirmation(date)
  await atomicWrite(confirmationPath, `${JSON.stringify(confirmation, null, 2)}\n`)
  return { path: confirmationPath }
}

function parseLookback(value) {
  if (value === undefined || value === null) return 30
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid lookbackDays "${value}". Expected a non-negative integer.`)
  }
  return number
}

async function runCollector(collect) {
  try {
    const result = await collect()
    return {
      candidates: Array.isArray(result?.candidates) ? result.candidates : [],
      scan: result?.scan === undefined ? {} : result.scan,
    }
  } catch (error) {
    return {
      candidates: [],
      scan: { error: error instanceof Error ? error.message : String(error) },
    }
  }
}

function dedupeCandidates({ rawCandidates, firsthandAll, knownCommitSources, decidedCandidateIds }) {
  const inboxCommitShas = new Set()
  for (const source of knownCommitSources) inboxCommitShas.add(source.slice('commit:'.length))
  const firsthandTexts = new Set(firsthandAll.map(event => normalizeText(event.text)))
  const seenTexts = new Set()
  const candidates = []
  for (const candidate of rawCandidates) {
    if (!candidate || typeof candidate.text !== 'string') continue
    if (decidedCandidateIds.has(candidate.id)) continue
    const sha = commitShaForSource(candidate.source)
    if (sha && inboxCommitShas.has(sha)) continue
    const normalized = normalizeText(candidate.text)
    if (firsthandTexts.has(normalized)) continue
    if (seenTexts.has(normalized)) continue
    seenTexts.add(normalized)
    candidates.push(candidate)
  }
  return candidates
}

function commitShaForSource(source) {
  const match = /^(?:commit|archaeology:gitlog):(.+)$/.exec(String(source || ''))
  return match ? match[1] : ''
}

function buildOpenTodosSnapshot(snapshot, date) {
  const todos = Array.isArray(snapshot?.todos) ? snapshot.todos : []
  const open = []
  for (const todo of todos) {
    if (!todo || todo.status !== 'open') continue
    open.push({
      id: todo.id,
      text: todo.text,
      project: todo.project || '',
      ageDays: ageDaysFor(date, todo.createdDate),
    })
  }
  return open
}

function ageDaysFor(date, createdDate) {
  const target = Date.parse(`${date}T00:00:00Z`)
  const created = Date.parse(`${String(createdDate || '')}T00:00:00Z`)
  if (!Number.isFinite(created)) return 0
  return Math.max(0, Math.round((target - created) / DAY_MS))
}

function exactCompletions({ firsthand, candidates, openTodosSnapshot }) {
  const doneEvents = [...firsthand, ...candidates].filter(event => event.type === 'done')
  const completions = []
  for (const todo of openTodosSnapshot) {
    const normalized = normalizeText(todo.text)
    const match = doneEvents.find(event => normalizeText(event.text) === normalized)
    if (match) {
      completions.push({ todoId: todo.id, evidence: match.source, confidence: 'high', by: 'exact' })
    }
  }
  return completions
}

function interpretMatchResult({ result, firsthand, candidates, openTodosSnapshot, completionCandidates }) {
  const knownIds = new Set([...firsthand.map(e => e.id), ...candidates.map(c => c.id)])
  const mergedIds = new Set()
  for (const merge of Array.isArray(result?.merges) ? result.merges : []) {
    if (!merge || typeof merge.candidateId !== 'string' || typeof merge.duplicateOf !== 'string') continue
    if (merge.candidateId === merge.duplicateOf) continue
    if (!knownIds.has(merge.duplicateOf)) continue
    mergedIds.add(merge.candidateId)
  }

  const eventById = new Map([...firsthand, ...candidates].map(event => [event.id, event]))
  const openTodoIds = new Set(openTodosSnapshot.map(todo => todo.id))
  const coveredTodoIds = new Set(completionCandidates.map(entry => entry.todoId))
  const completions = []
  for (const completion of Array.isArray(result?.completions) ? result.completions : []) {
    if (!completion || typeof completion.todoId !== 'string') continue
    if (!openTodoIds.has(completion.todoId) || coveredTodoIds.has(completion.todoId)) continue
    const event = eventById.get(completion.candidateId)
    completions.push({
      todoId: completion.todoId,
      evidence: event ? event.source : `event:${completion.candidateId}`,
      confidence: completion.confidence === 'high' ? 'high' : 'low',
      by: 'llm',
    })
    coveredTodoIds.add(completion.todoId)
  }

  const overview = typeof result?.overview === 'string' ? result.overview.trim() : ''
  return { mergedIds, completions, overview }
}

async function detectSupplement({ paths, snapshot, date }) {
  const status = snapshot?.days?.[date]?.status
  if (status !== 'confirmed' && status !== 'supplemented') return null
  const log = await readJsonl(paths.ledgerLog)
  let lastAppliedAtMs = Number.NEGATIVE_INFINITY
  const decidedCandidateIds = new Set()
  for (const tx of log.rows) {
    if (!tx || tx.date !== date) continue
    const appliedAtMs = Date.parse(tx.appliedAt)
    if (Number.isFinite(appliedAtMs) && appliedAtMs > lastAppliedAtMs) lastAppliedAtMs = appliedAtMs
    const confirmation = tx.confirmation || {}
    for (const id of Array.isArray(confirmation.acceptCandidates) ? confirmation.acceptCandidates : []) {
      decidedCandidateIds.add(id)
    }
    for (const id of Array.isArray(confirmation.rejectCandidates) ? confirmation.rejectCandidates : []) {
      decidedCandidateIds.add(id)
    }
  }
  if (!Number.isFinite(lastAppliedAtMs)) return null
  return { lastAppliedAtMs, decidedCandidateIds }
}

function stringArrayField(value, name) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
    throw new Error(`Invalid patch field ${name}: expected an array of non-empty strings.`)
  }
  return value
}

function objectArrayField(value, name, { required, optional }) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`Invalid patch field ${name}: expected an array of objects.`)
  }
  const allowed = new Set([...required, ...optional])
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid patch field ${name}[${index}]: expected an object.`)
    }
    const unknownKeys = Object.keys(entry).filter(key => !allowed.has(key))
    if (unknownKeys.length) {
      throw new Error(
        `Invalid patch field ${name}[${index}]: unknown keys ${unknownKeys.join(', ')}. ` +
          `Allowed keys: ${[...allowed].join(', ')}.`,
      )
    }
    for (const key of required) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) {
        throw new Error(`Invalid patch field ${name}[${index}]: "${key}" must be a non-empty string.`)
      }
    }
    for (const key of optional) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') {
        throw new Error(`Invalid patch field ${name}[${index}]: "${key}" must be a string when present.`)
      }
    }
    return entry
  })
}
