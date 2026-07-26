import path from 'node:path'
import { promises as fs } from 'node:fs'
import { assertValidDate, wlPaths } from './paths.js'
import {
  appendJsonLine,
  atomicWrite,
  canonicalJson,
  isoNow,
  readJson,
  readJsonl,
  readRequiredJson,
  sha256Hex,
  stableId,
  unique,
} from './util.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// ---------------------------------------------------------------------------
// commitDay:全系统唯一写 ledger 的入口(实现方案 §5.3)
// ---------------------------------------------------------------------------

export async function commitDay({ wlHome, date }) {
  assertValidDate(date)
  const paths = wlPaths(wlHome)
  return withLedgerLock(paths, async () => {
    const confirmation = await readRequiredJson(paths.confirmation(date))
    assertMatchingDate('confirmation.json', confirmation?.date, date)
    const patch = normalizeConfirmation(confirmation)
    // 跳过日零成本(FR-8/AC-13):skipDay 不要求先 assemble,day.json 允许缺席
    const day = patch.skipDay ? await readJson(paths.dayJson(date), null) : await readRequiredJson(paths.dayJson(date))
    if (day) assertMatchingDate('day.json', day.date, date)

    // txId 由 (date, confirmation, 草稿事件身份) 共同派生:同一草稿+同一补丁重复执行仍幂等(AC-7),
    // 而补充结算即使补丁与首轮逐字节相同(最常见的空补丁流)也不会与首轮碰撞(AC-10)
    const txId = `${date}:${sha256Hex(canonicalJson(txIdentity(day, confirmation)))}`
    const { rows: log } = await readJsonl(paths.ledgerLog)

    if (log.some(tx => tx && tx.txId === txId)) {
      // AC-7:重复应用零副作用;视图是缓存,顺手刷新以修复「log 已写、视图未渲染」的崩溃窗口
      await refreshView(wlHome, date)
      return { txId, noop: true }
    }

    const appliedAt = isoNow()
    const resolved = resolve(day, confirmation, appliedAt)
    const state = replay(log)

    // 空补充(重新装配后无任何新内容)不落事务,避免无意义的 supplemented 翻转
    if (day?.mode === 'supplement' && !resolved.events.length && !patch.completeTodos.length) {
      await refreshView(wlHome, date)
      return { txId, noop: true }
    }

    const inboxDates = await readInboxDates(paths.inbox)

    // 乱序结算闸门:区间内有数据且未结算的日子不允许被 confirmedThrough 静默吞掉,
    // 必须先逐日结算或显式跳过(FR-10 欠账收敛语义)
    const pendingDataDays = []
    for (const gapDate of gapDays({ state, date })) {
      if (inboxDates.has(gapDate) && !state.days[gapDate]) pendingDataDays.push(gapDate)
    }
    if (pendingDataDays.length) {
      throw new Error(
        `Cannot settle ${date}: earlier days with data are still unsettled: ${pendingDataDays.join(', ')}. ` +
          'Settle them first (wl assemble --date <D> → confirm → commit) or skip them explicitly ' +
          '(confirm {"skipDay":true} → commit).',
      )
    }

    // 无数据欠账日:批量补记 skipped 事务,(confirmedThrough, date) 开区间(实现方案 §5.3)
    const transactions = []
    for (const skipDate of gapDays({ state, date })) {
      if (inboxDates.has(skipDate) || state.days[skipDate]) continue
      const skipConfirmation = { date: skipDate, skipDay: true }
      transactions.push({
        txId: `${skipDate}:${sha256Hex(canonicalJson(skipConfirmation))}`,
        date: skipDate,
        appliedAt,
        confirmation: skipConfirmation,
        resolvedEvents: [],
      })
    }
    transactions.push({
      txId,
      date,
      appliedAt,
      ...(day?.mode === 'supplement' ? { mode: 'supplement' } : {}),
      confirmation,
      resolvedEvents: resolved.events,
    })

    for (const tx of transactions) applyTx(state, tx)
    // 先追加 log 后换快照:崩在中间 = 快照落后,rebuild 天然修复(NFR 故障模型)
    for (const tx of transactions) await appendJsonLine(paths.ledgerLog, tx)
    await atomicWrite(paths.ledgerSnapshot, snapshotContent(state))
    await refreshView(wlHome, date)
    return { txId, noop: false }
  })
}

// 事务身份:confirmation + 草稿事件 id 集(事件 id 由 ts+text 确定性派生,
// 不含 assembledAt 之类的墙钟字段,重新装配同样内容得到同一身份)
function txIdentity(day, confirmation) {
  return {
    confirmation,
    mode: day?.mode || 'full',
    firsthand: asArray(day?.firsthand).map(event => String(event?.id || '')),
    candidates: asArray(day?.candidates).map(event => String(event?.id || '')),
  }
}

function assertMatchingDate(label, value, date) {
  if (value !== undefined && value !== null && value !== '' && value !== date) {
    throw new Error(`${label} has date "${value}" but --date is ${date}; refusing to settle mismatched files.`)
  }
}

// 冷路径结算锁:mkdir 原子创建,持有者崩溃留下的陈旧锁按 mtime 超时清除。
// 并发 commit/rebuild/import 串行化,防止双双通过 txId 检查后重复追加(AC-7)。
async function withLedgerLock(paths, fn) {
  const lockDir = path.join(paths.ledgerDir, '.lock')
  await fs.mkdir(paths.ledgerDir, { recursive: true })
  const deadline = Date.now() + 10000
  for (;;) {
    try {
      await fs.mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const stats = await fs.stat(lockDir)
        if (Date.now() - stats.mtimeMs > 30000) {
          await fs.rm(lockDir, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`ledger is locked by another worklog process (${lockDir}); retry later or remove a stale lock`)
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 50 + Math.floor(Math.random() * 50)))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// rebuildLedger:空状态起按 log 顺序重放,快照与 log 冲突以 log 为准(AC-8)
// ---------------------------------------------------------------------------

export async function rebuildLedger({ wlHome }) {
  const paths = wlPaths(wlHome)
  return withLedgerLock(paths, async () => {
    const { rows, badLines } = await readJsonl(paths.ledgerLog)
    if (badLines > 0) {
      // 结算故障显式报错(NFR):log 自身损坏不能被静默掩盖;能解析的行仍然重放
      process.stderr.write(`worklog: warning: ledger-log contains ${badLines} unparsable line(s); rebuilt from the remaining transactions.\n`)
    }
    const state = replay(rows)
    await atomicWrite(paths.ledgerSnapshot, snapshotContent(state))
    return { days: Object.keys(state.days).length, todos: state.todos.length, badLines }
  })
}

// ---------------------------------------------------------------------------
// importV1:V1 memory.json 一次性导入为一笔 type:'import' 事务(实现方案 §9)
// ---------------------------------------------------------------------------

export async function importV1({ wlHome, memoryPath }) {
  if (!memoryPath) throw new Error('importV1 requires a memoryPath')
  const paths = wlPaths(wlHome)
  const memory = normalizeV1Memory(await readRequiredJson(memoryPath))
  const payload = {
    todos: memory.todos.map(v1TodoEntry),
    ideas: memory.ideas.map(v1IdeaEntry),
    confirmedThrough: lastReportDate(memory.reports),
  }
  const txId = `import:${sha256Hex(canonicalJson(payload))}`
  const imported = { todos: payload.todos.length, ideas: payload.ideas.length }
  return withLedgerLock(paths, async () => {
    const { rows: log } = await readJsonl(paths.ledgerLog)
    if (log.some(tx => tx && tx.txId === txId)) return { txId, imported, noop: true }

    const tx = { txId, type: 'import', appliedAt: isoNow(), ...payload }
    const state = replay(log)
    applyTx(state, tx)
    await appendJsonLine(paths.ledgerLog, tx)
    await atomicWrite(paths.ledgerSnapshot, snapshotContent(state))
    return { txId, imported, noop: false }
  })
}

// ---------------------------------------------------------------------------
// resolve:草稿 + 补丁 → 入账终态事件(纯函数)
// ---------------------------------------------------------------------------

export function resolve(day, confirmation, now = isoNow()) {
  const patch = normalizeConfirmation(confirmation)
  if (patch.skipDay) return { skip: true, events: [] }

  const edits = new Map(patch.editText.map(entry => [entry.id, String(entry.text ?? '')]))
  const accepted = new Set(patch.acceptCandidates)
  const rejected = new Set(patch.rejectCandidates)
  const events = []

  // 一手记录默认全通过(AC-5),editText 按 id 应用
  for (const event of asArray(day?.firsthand)) {
    if (!event || !event.id) continue
    events.push(finalEvent(event, edits))
  }
  // 候选仅在 acceptCandidates 点头后提升;未列出与 reject 的一律不入账(AC-11)
  for (const candidate of asArray(day?.candidates)) {
    if (!candidate || !candidate.id) continue
    if (!accepted.has(candidate.id) || rejected.has(candidate.id)) continue
    events.push(finalEvent(candidate, edits))
  }
  for (const item of patch.addTodos) {
    const text = String(item?.text || '').trim()
    if (!text) continue
    const project = String(item?.project || '')
    events.push({ id: stableId(project, text), ts: now, type: 'todo', text, project, source: 'manual' })
  }
  for (const item of patch.addIdeas) {
    const text = String(item?.text || '').trim()
    if (!text) continue
    events.push({ id: stableId('', text), ts: now, type: 'idea', text, project: '', source: 'manual' })
  }
  return { skip: false, events }
}

function finalEvent(event, edits) {
  return {
    id: event.id,
    ts: event.ts || '',
    type: event.type || 'note',
    text: edits.has(event.id) ? edits.get(event.id) : String(event.text ?? ''),
    project: event.project || '',
    source: event.source || 'manual',
  }
}

// ---------------------------------------------------------------------------
// applyTx:单一实现,commitDay 与 rebuildLedger 共用(实现方案 §4.4)
// ---------------------------------------------------------------------------

function replay(rows) {
  const state = { confirmedThrough: null, todos: [], ideas: [], days: {} }
  // 按 txId 去重:历史竞态/手工拼接产生的重复事务行不被双重应用,重放对损坏 log 自愈
  const seenTxIds = new Set()
  for (const tx of asArray(rows)) {
    const txId = tx && typeof tx === 'object' ? tx.txId : ''
    if (txId) {
      if (seenTxIds.has(txId)) continue
      seenTxIds.add(txId)
    }
    applyTx(state, tx)
  }
  return state
}

function applyTx(state, tx) {
  if (!tx || typeof tx !== 'object' || !tx.txId) return state
  if (tx.type === 'import') return applyImport(state, tx)
  const date = String(tx.date || '')
  if (!DATE_PATTERN.test(date)) return state
  const confirmation = normalizeConfirmation(tx.confirmation)
  const appliedAt = tx.appliedAt || ''

  if (confirmation.skipDay) {
    // 已结算日不被 skip 事务降级;仅未记录日落 skipped
    if (!state.days[date]) {
      state.days[date] = { status: 'skipped', txId: tx.txId, counts: { done: 0, todoAdd: 0 } }
    }
    advanceConfirmedThrough(state, date)
    return state
  }

  let done = 0
  let todoAdd = 0
  for (const event of asArray(tx.resolvedEvents)) {
    if (!event || !event.type || !event.text) continue
    if (event.type === 'done') done += 1
    if (event.type === 'todo') {
      todoAdd += 1
      upsertTodo(state.todos, {
        id: stableId(event.project || '', event.text),
        text: String(event.text),
        project: event.project || '',
        status: 'open',
        createdDate: date,
        updatedAt: appliedAt,
        sources: event.source ? [event.source] : [],
      })
    }
    if (event.type === 'idea') {
      upsertIdea(state.ideas, {
        id: stableId(event.project || '', event.text),
        text: String(event.text),
        project: event.project || '',
        createdDate: date,
        updatedAt: appliedAt,
        sources: event.source ? [event.source] : [],
      })
    }
  }

  for (const completion of confirmation.completeTodos) {
    const todo = state.todos.find(item => item.id === completion.todoId)
    if (!todo) continue
    todo.status = 'done'
    todo.closedDate = date
    if (appliedAt) todo.updatedAt = appliedAt
    if (completion.evidence) todo.sources = unique([...asArray(todo.sources), completion.evidence])
  }

  // 已确认日的追加事务 = 补充(AC-10):原事务不动,status 置 supplemented,counts 累计
  const prior = state.days[date]
  const supplement = tx.mode === 'supplement' || Boolean(prior && prior.status !== 'skipped')
  const base = supplement && prior ? prior.counts || {} : {}
  state.days[date] = {
    status: supplement ? 'supplemented' : 'confirmed',
    txId: tx.txId,
    counts: { done: (base.done || 0) + done, todoAdd: (base.todoAdd || 0) + todoAdd },
  }
  advanceConfirmedThrough(state, date)
  return state
}

function applyImport(state, tx) {
  const appliedAt = tx.appliedAt || ''
  for (const todo of asArray(tx.todos)) {
    if (!todo || !todo.id || !todo.text) continue
    upsertTodo(state.todos, { ...todo, updatedAt: todo.updatedAt || appliedAt, sources: asArray(todo.sources) })
  }
  for (const idea of asArray(tx.ideas)) {
    if (!idea || !idea.id || !idea.text) continue
    upsertIdea(state.ideas, { ...idea, updatedAt: idea.updatedAt || appliedAt, sources: asArray(idea.sources) })
  }
  if (DATE_PATTERN.test(String(tx.confirmedThrough || ''))) advanceConfirmedThrough(state, tx.confirmedThrough)
  return state
}

function upsertTodo(todos, entry) {
  const existing = todos.find(item => item.id === entry.id)
  if (!existing) {
    todos.push(entry)
    return
  }
  existing.sources = unique([...asArray(existing.sources), ...asArray(entry.sources)])
  if (entry.updatedAt && (!existing.updatedAt || entry.updatedAt > existing.updatedAt)) existing.updatedAt = entry.updatedAt
  if (!existing.createdDate && entry.createdDate) existing.createdDate = entry.createdDate
  // 同 id 重复新增不改已有状态;仅 open → done/dropped 的导入合并生效
  if (existing.status === 'open' && entry.status && entry.status !== 'open') {
    existing.status = entry.status
    if (entry.closedDate) existing.closedDate = entry.closedDate
  }
}

function upsertIdea(ideas, entry) {
  const existing = ideas.find(item => item.id === entry.id)
  if (!existing) {
    ideas.push(entry)
    return
  }
  existing.sources = unique([...asArray(existing.sources), ...asArray(entry.sources)])
  if (entry.updatedAt && (!existing.updatedAt || entry.updatedAt > existing.updatedAt)) existing.updatedAt = entry.updatedAt
  if (!existing.createdDate && entry.createdDate) existing.createdDate = entry.createdDate
}

function advanceConfirmedThrough(state, date) {
  if (!state.confirmedThrough || date > state.confirmedThrough) state.confirmedThrough = date
}

// ---------------------------------------------------------------------------
// 快照与欠账区间
// ---------------------------------------------------------------------------

function snapshotContent(state) {
  const days = Object.fromEntries(Object.keys(state.days).sort().map(date => [date, state.days[date]]))
  const snapshot = {
    schemaVersion: 1,
    confirmedThrough: state.confirmedThrough || null,
    todos: state.todos,
    ideas: state.ideas,
    days,
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

function* gapDays({ state, date }) {
  const from = String(state.confirmedThrough || '')
  if (!DATE_PATTERN.test(from)) return
  for (let day = nextDate(from); day < date; day = nextDate(day)) {
    yield day
  }
}

async function readInboxDates(inboxPath) {
  const { rows } = await readJsonl(inboxPath)
  const dates = new Set()
  for (const row of rows) {
    const day = String(row?.ts || '').slice(0, 10)
    if (DATE_PATTERN.test(day)) dates.add(day)
  }
  return dates
}

function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// confirmation 归一化与视图刷新
// ---------------------------------------------------------------------------

function normalizeConfirmation(confirmation) {
  const value = confirmation && typeof confirmation === 'object' && !Array.isArray(confirmation) ? confirmation : {}
  return {
    skipDay: value.skipDay === true,
    acceptCandidates: asArray(value.acceptCandidates),
    rejectCandidates: asArray(value.rejectCandidates),
    editText: asArray(value.editText).filter(entry => entry && entry.id),
    completeTodos: asArray(value.completeTodos).filter(entry => entry && entry.todoId),
    addTodos: asArray(value.addTodos),
    addIdeas: asArray(value.addIdeas),
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

async function refreshView(wlHome, date) {
  // 动态 import:render 模块并行开发中,不让 commit.js 的模块加载依赖它
  const { renderDay } = await import('./render.js')
  await renderDay({ wlHome, date })
}

// ---------------------------------------------------------------------------
// V1 归一化(语义内联自 V1 lib/memory.js 的 normalizeMemory/normalizeTodos)
// ---------------------------------------------------------------------------

function normalizeV1Memory(value) {
  const memory = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    todos: normalizeV1Items(memory.todos, true),
    ideas: normalizeV1Items(memory.ideas, false),
    reports: asArray(memory.reports),
  }
}

function normalizeV1Items(items, withStatus) {
  if (!Array.isArray(items)) return []
  return items
    .map(item => {
      if (typeof item === 'string') return { text: item.trim(), project: '', status: 'open' }
      return {
        ...item,
        text: String(item?.text || '').trim(),
        project: item?.project || '',
        ...(withStatus ? { status: normalizeV1Status(item?.status) } : {}),
      }
    })
    .filter(item => item.text)
}

function normalizeV1Status(status) {
  if (status === 'done' || status === 'dropped') return status
  return 'open'
}

function v1TodoEntry(item) {
  const entry = {
    id: item.id || stableId(item.project || '', item.text),
    text: item.text,
    project: item.project || '',
    status: item.status,
    createdDate: v1Date(item.sourceDate || item.createdAt),
    updatedAt: item.updatedAt || item.createdAt || '',
    sources: v1Sources(item),
  }
  const closedDate = v1Date(item.completedDate || item.completedReportDate)
  if (entry.status !== 'open' && closedDate) entry.closedDate = closedDate
  return entry
}

function v1IdeaEntry(item) {
  return {
    id: item.id || stableId(item.project || '', item.text),
    text: item.text,
    project: item.project || '',
    createdDate: v1Date(item.sourceDate || item.createdAt),
    updatedAt: item.updatedAt || item.createdAt || '',
    sources: v1Sources(item),
  }
}

function v1Sources(item) {
  return unique(['import:v1', ...asArray(item.sourceSessionIds).map(id => `session:${id}`)])
}

function v1Date(value) {
  const day = String(value || '').slice(0, 10)
  return DATE_PATTERN.test(day) ? day : ''
}

function lastReportDate(reports) {
  const dates = reports
    .map(report => String(report?.date || ''))
    .filter(date => DATE_PATTERN.test(date))
    .sort()
  return dates.length ? dates[dates.length - 1] : null
}
