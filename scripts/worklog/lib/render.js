// 视图渲染:report.md 正典 + 可选 report.html + 周期视图(设计规格 FR-11)。
// 只读 ledger.json / day.json / confirmation.json,绝不写回它们(AC-12)。
import { assertValidDate, wlPaths } from './paths.js'
import { atomicWrite, readJson, readJsonl } from './util.js'

const EMPTY_SNAPSHOT = { schemaVersion: 1, confirmedThrough: '', todos: [], ideas: [], days: {} }

export async function renderDay({ wlHome, date, html = false }) {
  assertValidDate(date)
  const paths = wlPaths(wlHome)
  const snapshot = await readJson(paths.ledgerSnapshot, EMPTY_SNAPSHOT)
  const day = await readJson(paths.dayJson(date), null)
  const confirmation = await readJson(paths.confirmation(date), null)
  const { rows: log } = await readJsonl(paths.ledgerLog)
  const hasLedgerEntry = Boolean(daysOf(snapshot)[date])
  if (!day && !hasLedgerEntry) {
    throw new Error(`Nothing to render for ${date}: no day.json and no ledger entry.`)
  }
  const view = composeDayView({ date, snapshot, day, confirmation, log })
  const written = []
  await atomicWrite(paths.reportMd(date), renderDayMarkdown(view))
  written.push(paths.reportMd(date))
  if (html) {
    await atomicWrite(paths.reportHtml(date), renderDayHtml(view))
    written.push(paths.reportHtml(date))
  }
  return { paths: written }
}

export async function renderAll({ wlHome, html = false }) {
  const paths = wlPaths(wlHome)
  const snapshot = await readJson(paths.ledgerSnapshot, EMPTY_SNAPSHOT)
  const dates = Object.keys(daysOf(snapshot)).sort()
  let count = 0
  for (const date of dates) {
    await renderDay({ wlHome, date, html })
    count += 1
  }
  return { count }
}

export async function renderPeriod({ wlHome, start, end }) {
  assertValidDate(start)
  assertValidDate(end)
  if (start > end) {
    throw new Error(`Invalid period: start "${start}" is after end "${end}".`)
  }
  const paths = wlPaths(wlHome)
  const snapshot = await readJson(paths.ledgerSnapshot, EMPTY_SNAPSHOT)
  const { rows: log } = await readJsonl(paths.ledgerLog)
  const dates = Object.keys(daysOf(snapshot))
    .filter(date => date >= start && date <= end)
    .sort()
  const totals = { days: 0, done: 0, newTodos: 0, closedTodos: 0, ideas: 0 }
  const sections = []
  for (const date of dates) {
    const day = await readJson(paths.dayJson(date), null)
    const confirmation = await readJson(paths.confirmation(date), null)
    const view = composeDayView({ date, snapshot, day, confirmation, log })
    const itemCount = view.done.length + view.newTodos.length + view.closedTodos.length + view.ideas.length
    if (!itemCount) continue
    totals.days += 1
    totals.done += view.done.length
    totals.newTodos += view.newTodos.length
    totals.closedTodos += view.closedTodos.length
    totals.ideas += view.ideas.length
    sections.push(renderPeriodDay(view))
  }
  const lines = []
  lines.push(
    `# 周期报告 · ${start} ~ ${end} · ${totals.days} 天有记录 · ` +
      `完成 ${totals.done} · 新增待办 ${totals.newTodos} · 关闭待办 ${totals.closedTodos} · 想法 ${totals.ideas}`,
  )
  lines.push('')
  if (!sections.length) {
    lines.push('无记录。')
    lines.push('')
  } else {
    for (const section of sections) lines.push(...section)
  }
  return { markdown: `${lines.join('\n')}\n` }
}

// ---------------------------------------------------------------------------
// 视图组合:ledger 快照 + day.json + confirmation.json → 渲染视图(纯函数,不落盘)
// ---------------------------------------------------------------------------

function daysOf(snapshot) {
  return snapshot && typeof snapshot.days === 'object' && snapshot.days !== null ? snapshot.days : {}
}

function composeDayView({ date, snapshot, day, confirmation, log = [] }) {
  const dayEntry = daysOf(snapshot)[date] || null
  const status = dayEntry?.status || 'draft'
  const conf = confirmation && typeof confirmation === 'object' ? confirmation : {}
  const edits = new Map(
    (Array.isArray(conf.editText) ? conf.editText : [])
      .filter(item => item && item.id)
      .map(item => [item.id, String(item.text ?? '')]),
  )
  const accepted = new Set(Array.isArray(conf.acceptCandidates) ? conf.acceptCandidates : [])
  const withEdit = event => ({
    id: event.id,
    type: String(event.type ?? ''),
    text: edits.has(event.id) ? edits.get(event.id) : String(event.text ?? ''),
    project: String(event.project ?? ''),
    source: String(event.source ?? ''),
  })

  // 已入账日以 ledger-log 的 resolvedEvents 为事实来源(FR-1:视图可由 ledger 重建;
  // 补充事务累加而不丢原始事件)。草稿日(尚无该日事务)才用 day.json + confirmation 预览。
  const dayTxs = listOf(log).filter(
    tx => tx && tx.date === date && tx.confirmation && tx.confirmation.skipDay !== true,
  )
  const ledgerMode = dayTxs.length > 0

  let events
  let salvageCount
  let completions
  if (ledgerMode) {
    events = dayTxs
      .flatMap(tx => listOf(tx.resolvedEvents))
      .map(event => ({
        id: event?.id,
        type: String(event?.type ?? ''),
        text: String(event?.text ?? ''),
        project: String(event?.project ?? ''),
        source: String(event?.source ?? ''),
      }))
    salvageCount = new Set(dayTxs.flatMap(tx => listOf(tx.confirmation.acceptCandidates))).size
    completions = dayTxs.flatMap(tx => listOf(tx.confirmation.completeTodos)).filter(item => item && item.todoId)
  } else {
    const firsthand = listOf(day?.firsthand).map(withEdit)
    const salvaged = listOf(day?.candidates).filter(item => item && accepted.has(item.id)).map(withEdit)
    events = [...firsthand, ...salvaged]
    salvageCount = salvaged.length
    completions = listOf(conf.completeTodos).filter(item => item && item.todoId)
  }

  // skipped 日(仅有 skip 事务):不把未入账的草稿事件渲染成"完成",报告保持空(AC-13 语义)
  const suppressDraftPreview = status === 'skipped' && !ledgerMode
  if (suppressDraftPreview) {
    events = []
    salvageCount = 0
    completions = []
  }

  const manualEntries = items =>
    listOf(items)
      .map(item => ({
        text: String(item?.text ?? ''),
        project: String(item?.project ?? ''),
        source: 'manual',
      }))
      .filter(item => item.text)

  // 入账日的 addTodos/addIdeas 已被 resolve 物化进 resolvedEvents,再叠加会重复计数
  const includeManual = !ledgerMode && !suppressDraftPreview
  const done = events.filter(event => event.type === 'done')
  const newTodos = [...events.filter(event => event.type === 'todo'), ...(includeManual ? manualEntries(conf.addTodos) : [])]
  const ideas = [...events.filter(event => event.type === 'idea'), ...(includeManual ? manualEntries(conf.addIdeas) : [])]

  const openTodos = day
    ? listOf(day?.openTodosSnapshot).map(item => ({
        id: item?.id,
        text: String(item?.text ?? ''),
        project: String(item?.project ?? ''),
        ageDays: Number(item?.ageDays) || 0,
      }))
    : openTodosFromSnapshot(snapshot, date)
  const todoIndex = new Map()
  for (const todo of listOf(snapshot?.todos)) if (todo?.id) todoIndex.set(todo.id, todo)
  for (const todo of openTodos) if (todo.id) todoIndex.set(todo.id, todo)
  const completedIds = new Set(completions.map(item => item.todoId))
  const evidenceByTodoId = new Map(completions.map(item => [item.todoId, String(item.evidence ?? '')]))
  const completionEntry = item => {
    const known = todoIndex.get(item.todoId)
    return {
      text: String(known?.text || item.todoId),
      project: String(known?.project ?? ''),
      source: String(item.evidence ?? ''),
    }
  }

  // 关闭段:入账日以快照 closedDate === date 为准(覆盖 completeTodos 之外的关闭路径);
  // 草稿日用 confirmation 预览将要关闭的条目
  let closedTodos
  if (ledgerMode) {
    const closedSnapshot = listOf(snapshot?.todos).filter(
      todo => todo && todo.closedDate === date && todo.status !== 'open',
    )
    const seen = new Set(closedSnapshot.map(todo => todo.id))
    closedTodos = [
      ...closedSnapshot.map(todo => ({
        text: String(todo.text ?? '') || String(todo.id ?? ''),
        project: String(todo.project ?? ''),
        source: evidenceByTodoId.get(todo.id) || '',
      })),
      ...completions.filter(item => !seen.has(item.todoId)).map(completionEntry),
    ]
    for (const todo of closedSnapshot) completedIds.add(todo.id)
  } else {
    closedTodos = completions.map(completionEntry)
  }
  const retainedTodos = openTodos.filter(todo => !completedIds.has(todo.id))
  const oldestAgeDays = retainedTodos.reduce((max, todo) => Math.max(max, todo.ageDays), 0)

  const records = [...done, ...newTodos, ...ideas]
  const projectCount = new Set(records.map(record => record.project).filter(Boolean)).size
  const recordCount = records.length
  // 入账日的模板概览按入账终态重算(day.json 里的计数在确认/补充后已过期);
  // LLM 概览与草稿日概览沿用 day.json
  const recomputed = `共 ${recordCount} 条记录覆盖 ${projectCount} 个项目。`
  const dayOverviewText = String(day?.overview?.text ?? '').trim()
  const overviewText = ledgerMode
    ? (day?.overview?.by === 'llm' && dayOverviewText) || recomputed
    : dayOverviewText || recomputed

  return {
    date,
    status,
    overviewText,
    done,
    newTodos,
    closedTodos,
    retainedTodos,
    oldestAgeDays,
    ideas,
    projectCount,
    recordCount,
    inboxLines: Number(day?.scan?.inboxLines) || 0,
    salvageCount,
    hasDayJson: Boolean(day),
  }
}

function listOf(value) {
  return Array.isArray(value) ? value : []
}

// day.json 缺失(如 skipped 补记日或缓存被清)时,从快照推导该日的保留待办视图
function openTodosFromSnapshot(snapshot, date) {
  return listOf(snapshot?.todos)
    .filter(todo => todo && todo.id && todo.createdDate && todo.createdDate <= date)
    .filter(todo => todo.status === 'open' || (todo.closedDate && todo.closedDate > date))
    .map(todo => ({
      id: todo.id,
      text: String(todo.text ?? ''),
      project: String(todo.project ?? ''),
      ageDays: dayDiff(todo.createdDate, date),
    }))
}

function dayDiff(from, to) {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 86400000) : 0
}

// 出处标记(设计规格 FR-11):commit:*→短sha、session:*→⌥、manual→✎、archaeology:*→⌂
function sourceMarker(source) {
  const value = String(source || '')
  if (value.startsWith('commit:')) {
    const sha = value.slice('commit:'.length).trim()
    return sha ? `(${sha.slice(0, 7)})` : ''
  }
  if (value.startsWith('session:')) return '(⌥)'
  if (value === 'manual') return '(✎)'
  if (value.startsWith('archaeology:')) return '(⌂)'
  return ''
}

function entryText(entry, { markers = true } = {}) {
  const parts = []
  if (entry.project) parts.push(`[${entry.project}]`)
  // 折叠条目内换行:多行捕获文本不得把自己的行首变成 markdown 标题/列表,
  // 否则普通输入就能注入 FR-11 明令不设的区块
  parts.push(String(entry.text ?? '').replace(/[\r\n]+\s*/g, ' '))
  const marker = markers ? sourceMarker(entry.source) : ''
  if (marker) parts.push(marker)
  return parts.join(' ')
}

function entryLine(entry, options = {}) {
  const label = options.label ? `${options.label} ` : ''
  return `- ${label}${entryText(entry, options)}`
}

// ---------------------------------------------------------------------------
// report.md(正典,一屏纪律;无表格、无内嵌 HTML)
// ---------------------------------------------------------------------------

function renderDayMarkdown(view) {
  const lines = []
  lines.push(`# 日报 · ${view.date} · ${view.projectCount} 项目 · ${view.recordCount} 条 · status:${view.status}`)
  lines.push('')
  lines.push(view.overviewText)
  lines.push('')
  lines.push('## 完成')
  lines.push('')
  appendBullets(lines, view.done)
  lines.push('## 待办')
  lines.push('')
  lines.push('### 新增')
  lines.push('')
  appendBullets(lines, view.newTodos)
  lines.push('### 关闭')
  lines.push('')
  appendBullets(lines, view.closedTodos)
  lines.push('### 保留')
  lines.push('')
  appendBullets(lines, view.retainedTodos, { markers: false })
  if (view.retainedTodos.length) {
    lines.push(`最老挂 ${view.oldestAgeDays} 天`)
    lines.push('')
  }
  lines.push('## 想法')
  lines.push('')
  appendBullets(lines, view.ideas)
  lines.push('---')
  const footer = `inbox ${view.inboxLines} 条 · 捞漏确认 ${view.salvageCount} 条`
  lines.push(view.hasDayJson ? `${footer} · [day.json](./day.json)` : footer)
  return `${lines.join('\n')}\n`
}

function appendBullets(lines, entries, options = {}) {
  if (!entries.length) {
    lines.push('无。')
    lines.push('')
    return
  }
  for (const entry of entries) lines.push(entryLine(entry, options))
  lines.push('')
}

function renderPeriodDay(view) {
  const lines = []
  lines.push(
    `## ${view.date} · 完成 ${view.done.length} · 新增待办 ${view.newTodos.length} · ` +
      `关闭待办 ${view.closedTodos.length} · 想法 ${view.ideas.length}`,
  )
  lines.push('')
  for (const entry of view.done) lines.push(entryLine(entry, { label: '完成' }))
  for (const entry of view.newTodos) lines.push(entryLine(entry, { label: '新增待办' }))
  for (const entry of view.closedTodos) lines.push(entryLine(entry, { label: '关闭待办' }))
  for (const entry of view.ideas) lines.push(entryLine(entry, { label: '想法' }))
  lines.push('')
  return lines
}

// ---------------------------------------------------------------------------
// report.html(可选视图;单文件骨架自 V1 迁移:主题切换/打印样式/响应式)
// ---------------------------------------------------------------------------

function renderDayHtml(view) {
  const title = `工作日报 · ${view.date}`
  const nav = [
    ['overview', '概览'],
    ['done', '完成'],
    ['todos', '待办'],
    ['ideas', '想法'],
  ]

  return `<!doctype html>
<html lang="${escapeAttr('zh-CN')}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f7f5ef;
      --paper: #fffdf8;
      --paper-2: #ffffff;
      --ink: #1f2933;
      --ink-soft: #4b5563;
      --muted: #7b8494;
      --line: rgba(31, 41, 51, .10);
      --line-strong: rgba(31, 41, 51, .16);
      --accent: #2563eb;
      --accent-2: #7c3aed;
      --green: #059669;
      --amber: #d97706;
      --blue-soft: #eef4ff;
      --green-soft: #ecfdf5;
      --amber-soft: #fff7ed;
      --shadow: 0 18px 50px rgba(31, 41, 51, .10);
      --shadow-sm: 0 8px 24px rgba(31, 41, 51, .07);
      --max: 1040px;
    }
    [data-theme="dark"] {
      --bg: #0f172a;
      --paper: #111827;
      --paper-2: #172033;
      --ink: #f8fafc;
      --ink-soft: #d1d5db;
      --muted: #94a3b8;
      --line: rgba(255,255,255,.10);
      --line-strong: rgba(255,255,255,.18);
      --blue-soft: rgba(37, 99, 235, .16);
      --green-soft: rgba(5, 150, 105, .16);
      --amber-soft: rgba(217, 119, 6, .16);
      --shadow: 0 20px 60px rgba(0,0,0,.25);
      --shadow-sm: 0 10px 28px rgba(0,0,0,.18);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 0%, rgba(37,99,235,.12), transparent 28%),
        radial-gradient(circle at 88% 5%, rgba(124,58,237,.10), transparent 30%),
        linear-gradient(180deg, var(--bg), var(--bg));
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif;
      line-height: 1.74;
      letter-spacing: 0;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      background-image: linear-gradient(rgba(31,41,51,.045) 1px, transparent 1px);
      background-size: 100% 44px;
      mask-image: linear-gradient(180deg, #000, transparent 72%);
    }
    a { color: inherit; text-decoration: none; }
    .progress {
      position: fixed;
      left: 0;
      top: 0;
      width: 0%;
      height: 3px;
      z-index: 50;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      box-shadow: 0 0 18px rgba(37,99,235,.35);
    }
    .wrap {
      width: min(var(--max), calc(100% - 32px));
      margin: 0 auto;
      padding: 34px 0 72px;
    }
    .hero {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 30px;
      background:
        linear-gradient(135deg, rgba(255,255,255,.92), rgba(255,255,255,.76)),
        radial-gradient(circle at 90% 12%, rgba(37,99,235,.18), transparent 32%);
      box-shadow: var(--shadow);
      padding: 44px;
    }
    [data-theme="dark"] .hero {
      background:
        linear-gradient(135deg, rgba(17,24,39,.96), rgba(23,32,51,.92)),
        radial-gradient(circle at 90% 12%, rgba(37,99,235,.24), transparent 34%);
    }
    .hero::after {
      content: "";
      position: absolute;
      right: -120px;
      top: -120px;
      width: 320px;
      height: 320px;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(37,99,235,.18), rgba(124,58,237,.16));
      filter: blur(4px);
    }
    .hero-content { position: relative; z-index: 1; }
    .topline {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 30px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,.55);
      color: var(--ink-soft);
      font-weight: 700;
      font-size: 13px;
    }
    [data-theme="dark"] .brand { background: rgba(255,255,255,.05); }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 8px;
      color: white;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      font-weight: 900;
      font-size: 12px;
    }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .button {
      border: 1px solid var(--line);
      background: var(--paper-2);
      color: var(--ink);
      border-radius: 999px;
      padding: 9px 13px;
      font: inherit;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(31,41,51,.06);
    }
    h1 {
      margin: 0;
      max-width: 820px;
      font-size: clamp(42px, 7vw, 82px);
      line-height: 1;
      letter-spacing: 0;
    }
    h1 span { display: block; }
    h1 .title-date { font-size: .86em; }
    .lead {
      max-width: 820px;
      margin: 24px 0 0;
      color: var(--ink-soft);
      font-size: 18px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin: 18px 0;
    }
    .stat {
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 22px;
      background: var(--paper);
      box-shadow: var(--shadow-sm);
    }
    .stat-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .stat-value {
      margin-top: 5px;
      font-size: 20px;
      font-weight: 900;
      word-break: break-word;
    }
    .nav {
      position: sticky;
      top: 10px;
      z-index: 20;
      display: flex;
      gap: 6px;
      margin: 18px 0 22px;
      padding: 8px;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: color-mix(in srgb, var(--paper) 88%, transparent);
      backdrop-filter: blur(16px);
      box-shadow: var(--shadow-sm);
    }
    .nav a {
      flex: 0 0 auto;
      padding: 8px 12px;
      border-radius: 999px;
      color: var(--ink-soft);
      font-size: 13px;
      font-weight: 900;
    }
    .nav a.active, .nav a:hover {
      background: var(--blue-soft);
      color: var(--accent);
    }
    .section {
      margin-top: 18px;
      scroll-margin-top: 90px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--paper);
      box-shadow: var(--shadow-sm);
      padding: 28px;
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 20px;
    }
    .kicker {
      color: var(--accent);
      font-size: 12px;
      font-weight: 900;
      text-transform: uppercase;
    }
    h2, h3, h4 { margin: 0; line-height: 1.25; letter-spacing: 0; }
    h2 { font-size: 28px; }
    h3 { font-size: 18px; }
    .section-note {
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
      text-align: right;
    }
    .overview-text {
      margin: 0;
      color: var(--ink-soft);
      font-size: 17px;
    }
    .task-board {
      display: grid;
      gap: 16px;
    }
    .task-panel {
      padding: 18px;
      border: 1px solid rgba(5,150,105,.18);
      border-radius: 20px;
      background: var(--green-soft);
    }
    .task-panel.closed {
      border-color: rgba(37,99,235,.18);
      background: var(--blue-soft);
    }
    .task-panel.backlog {
      border-color: rgba(217,119,6,.20);
      background: var(--amber-soft);
    }
    .task-panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 14px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 3px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--paper-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
      white-space: nowrap;
    }
    .task-list {
      display: grid;
      gap: 10px;
    }
    .task {
      display: grid;
      grid-template-columns: 30px 1fr;
      gap: 10px;
      align-items: start;
      color: var(--ink-soft);
    }
    .checkbox {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 10px;
      background: var(--paper-2);
      color: var(--accent);
      font-size: 12px;
      font-weight: 900;
    }
    .age-note {
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      padding: 9px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--paper-2);
      color: var(--ink-soft);
      font-weight: 800;
      word-break: break-word;
    }
    .footer {
      margin-top: 24px;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
    }
    .footer a { text-decoration: underline; }
    .empty {
      margin: 0;
      color: var(--muted);
      font-style: italic;
    }
    @media (max-width: 820px) {
      .wrap { width: min(100% - 20px, var(--max)); padding-top: 16px; }
      .hero { padding: 28px 22px; border-radius: 24px; }
      h1 { font-size: 42px; }
      .stats { grid-template-columns: 1fr; }
      .section-title { display: block; }
      .section-note { margin-top: 4px; text-align: left; }
    }
    @media print {
      body { background: #fff; color: #111827; }
      body::before, .progress, .nav, .actions { display: none !important; }
      .wrap { width: 100%; padding: 0; }
      .hero, .card, .stat { box-shadow: none; break-inside: avoid; }
      .section { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="progress" id="progress"></div>
  <main class="wrap">
    <header class="hero">
      <div class="hero-content">
        <div class="topline">
          <div class="brand"><span class="brand-mark">W</span> worklog</div>
          <div class="actions">
            <button class="button" id="themeBtn" type="button">切换深色</button>
            <button class="button" onclick="window.print()" type="button">打印 / 导出 PDF</button>
          </div>
        </div>
        <h1><span>工作日报</span><span class="title-date">${escapeHtml(view.date)}</span></h1>
        <p class="lead">${escapeHtml(view.overviewText)}</p>
      </div>
    </header>

    <section class="stats" aria-label="metadata">
      ${statHtml('日期', view.date)}
      ${statHtml('状态', view.status)}
      ${statHtml('项目数', view.projectCount)}
      ${statHtml('条数', view.recordCount)}
    </section>

    <nav class="nav" id="nav">
      ${nav.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('\n      ')}
    </nav>

    <section id="overview" class="section card">
      ${sectionTitle('Overview', '概览', '全文唯一散文段')}
      <p class="overview-text">${escapeHtml(view.overviewText)}</p>
    </section>

    <section id="done" class="section card">
      ${sectionTitle('Done', '完成', `${view.done.length} 项`)}
      <div class="task-list">
        ${listOrEmpty(view.done, entry => `<div class="task"><div class="checkbox">✓</div><div>${escapeHtml(entryText(entry))}</div></div>`)}
      </div>
    </section>

    <section id="todos" class="section card">
      ${sectionTitle('Todos', '待办', '新增 / 关闭 / 保留')}
      <div class="task-board">
        ${todoPanelHtml('新增', view.newTodos, '', true)}
        ${todoPanelHtml('关闭', view.closedTodos, 'closed', true)}
        ${todoPanelHtml('保留', view.retainedTodos, 'backlog', false, view.oldestAgeDays)}
      </div>
    </section>

    <section id="ideas" class="section card">
      ${sectionTitle('Ideas', '想法', `${view.ideas.length} 条`)}
      <div class="chips">
        ${listOrEmpty(view.ideas, entry => `<span class="chip">${escapeHtml(entryText(entry))}</span>`)}
      </div>
    </section>

    <footer class="footer">inbox ${view.inboxLines} 条 · 捞漏确认 ${view.salvageCount} 条 · <a href="${escapeAttr('./day.json')}">day.json</a></footer>
  </main>
  <script>
    const root = document.documentElement;
    const themeBtn = document.getElementById('themeBtn');
    const savedTheme = localStorage.getItem('worklog-report-theme');
    if (savedTheme) root.dataset.theme = savedTheme;
    themeBtn?.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? '' : 'dark';
      if (next) root.dataset.theme = next;
      else delete root.dataset.theme;
      localStorage.setItem('worklog-report-theme', next);
    });

    const progress = document.getElementById('progress');
    const updateProgress = () => {
      const total = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = total > 0 ? Math.min(1, window.scrollY / total) : 0;
      progress.style.width = (ratio * 100).toFixed(2) + '%';
    };
    window.addEventListener('scroll', updateProgress, { passive: true });
    window.addEventListener('resize', updateProgress);
    updateProgress();

    const navLinks = [...document.querySelectorAll('#nav a')];
    const sections = navLinks.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === '#' + visible.target.id));
    }, { rootMargin: '-20% 0px -65% 0px', threshold: [0.05, 0.2, 0.5] });
    sections.forEach(section => observer.observe(section));
  </script>
</body>
</html>
`
}

function statHtml(label, value) {
  return `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div></div>`
}

function sectionTitle(kicker, title, note) {
  return `<div class="section-title"><div><div class="kicker">${escapeHtml(kicker)}</div><h2>${escapeHtml(title)}</h2></div><div class="section-note">${escapeHtml(note)}</div></div>`
}

function todoPanelHtml(title, items, variant, markers, oldestAgeDays = 0) {
  const ageNote = items.length ? `<p class="age-note">最老挂 ${oldestAgeDays} 天</p>` : ''
  return `<div class="task-panel${variant ? ` ${variant}` : ''}">
          <div class="task-panel-head"><h3>${escapeHtml(title)}</h3><span class="badge">${items.length} 项</span></div>
          <div class="task-list">
            ${listOrEmpty(items, entry => `<div class="task"><div class="checkbox">•</div><div>${escapeHtml(entryText(entry, { markers }))}</div></div>`)}
          </div>
          ${variant === 'backlog' ? ageNote : ''}
        </div>`
}

function listOrEmpty(items, renderer) {
  if (!items.length) return '<p class="empty">无。</p>'
  return items.map(renderer).join('\n        ')
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttr(value) {
  return escapeHtml(value)
}
