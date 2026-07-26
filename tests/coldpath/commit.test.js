import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { confirmDay } from '../../scripts/worklog/lib/assemble.js'
import { commitDay, rebuildLedger } from '../../scripts/worklog/lib/commit.js'
import { wlPaths } from '../../scripts/worklog/lib/paths.js'
import { eventId } from '../../scripts/worklog/lib/util.js'
import {
  inboxLine,
  makeSandbox,
  readJson,
  readText,
  withEnv,
  writeInbox,
  writeJson,
} from './fixtures/helpers.js'

function ev({ ts, type = 'done', text, project = 'alpha', source = 'manual' }) {
  return { id: eventId(ts, text), ts, type, text, project, source }
}

function candidate({ ts, type = 'done', text, project = 'alpha', source = 'archaeology:codex:session-a' }) {
  return { id: eventId(ts, text), ts, type, text, project, source }
}

function dayFixture({ date, firsthand = [], candidates = [], mode }) {
  const day = {
    schemaVersion: 1,
    date,
    assembledAt: `${date}T21:00:00+08:00`,
    firsthand,
    candidates,
    completionCandidates: [],
    openTodosSnapshot: [],
    overview: { text: `共 ${firsthand.length + candidates.length} 条记录覆盖 1 个项目。`, by: 'template' },
    scan: { inboxLines: firsthand.length, collectors: {} },
  }
  if (mode) day.mode = mode
  return day
}

// confirmation.json 完整形状(实现方案 §4.3);commit 只关心文件内容,不依赖 confirmDay
function confirmationFixture(date, overrides = {}) {
  return {
    date,
    acceptCandidates: [],
    rejectCandidates: [],
    editText: [],
    completeTodos: [],
    addTodos: [],
    addIdeas: [],
    skipDay: false,
    ...overrides,
  }
}

async function seedDay(paths, date, day, confirmation) {
  await writeJson(paths.dayJson(date), day)
  if (confirmation) await writeJson(paths.confirmation(date), confirmation)
}

async function readLogLines(paths) {
  const raw = await readText(paths.ledgerLog)
  return raw.split('\n').filter(line => line.trim())
}

test('confirmDay rejects unknown ids and fills defaulted fields', async t => {
  const sandbox = await makeSandbox(t, 'wl-confirm-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = wlPaths(wlHome)
  const date = '2026-07-01'
  const cand = candidate({ ts: '2026-07-01T09:00:00+08:00', text: '考古捞回的完成项' })
  await seedDay(paths, date, dayFixture({ date, candidates: [cand] }))

  await assert.rejects(
    async () => { await confirmDay({ wlHome, date, patch: { acceptCandidates: ['nope-1'] } }) },
    /nope-1/,
  )

  const result = await confirmDay({ wlHome, date, patch: { acceptCandidates: [cand.id] } })
  assert.equal(result.path, paths.confirmation(date))
  const confirmation = await readJson(paths.confirmation(date))
  assert.equal(confirmation.date, date)
  assert.deepEqual(confirmation.acceptCandidates, [cand.id])
  for (const key of ['rejectCandidates', 'editText', 'completeTodos', 'addTodos', 'addIdeas']) {
    assert.deepEqual(confirmation[key], [], `confirmation.${key} should default to []`)
  }
  assert.ok(!confirmation.skipDay)
})

test('commitDay applies one transaction and reruns as a noop (AC-7)', async t => {
  const sandbox = await makeSandbox(t, 'wl-commit-idem-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = wlPaths(wlHome)
  const date = '2026-07-01'
  const done = ev({ ts: '2026-07-01T10:00:00+08:00', text: '第一手完成事项' })
  const cand = candidate({ ts: '2026-07-01T12:00:00+08:00', text: '考古捞回的完成项' })
  await seedDay(
    paths,
    date,
    dayFixture({ date, firsthand: [done], candidates: [cand] }),
    confirmationFixture(date, { acceptCandidates: [cand.id] }),
  )

  const first = await commitDay({ wlHome, date })
  assert.equal(first.noop, false)
  assert.ok(String(first.txId).startsWith(`${date}:`), 'txId should be date-prefixed')
  const linesAfterFirst = await readLogLines(paths)
  assert.equal(linesAfterFirst.length, 1, 'one confirmation should append exactly one transaction')
  const snapshotAfterFirst = await readText(paths.ledgerSnapshot)

  const second = await commitDay({ wlHome, date })
  assert.equal(second.noop, true)
  assert.equal(second.txId, first.txId)
  assert.deepEqual(await readLogLines(paths), linesAfterFirst, 'a rerun must not append to ledger-log')
  assert.equal(await readText(paths.ledgerSnapshot), snapshotAfterFirst, 'a rerun must not change the snapshot')

  const snapshot = JSON.parse(snapshotAfterFirst)
  assert.equal(snapshot.confirmedThrough, date)
  assert.equal(snapshot.days[date].status, 'confirmed')
})

test('rebuildLedger replays the log when the snapshot lags behind (AC-8)', async t => {
  const sandbox = await makeSandbox(t, 'wl-rebuild-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = wlPaths(wlHome)
  const dateOne = '2026-07-01'
  const dateTwo = '2026-07-02'

  await seedDay(
    paths,
    dateOne,
    dayFixture({ date: dateOne, firsthand: [ev({ ts: '2026-07-01T10:00:00+08:00', text: '第一天的完成事项' })] }),
    confirmationFixture(dateOne),
  )
  await commitDay({ wlHome, date: dateOne })
  const snapshotAfterOne = await readText(paths.ledgerSnapshot)

  await seedDay(
    paths,
    dateTwo,
    dayFixture({ date: dateTwo, firsthand: [ev({ ts: '2026-07-02T10:00:00+08:00', text: '第二天的完成事项' })] }),
    confirmationFixture(dateTwo, { addTodos: [{ text: '重放校验新增待办', project: 'alpha' }] }),
  )
  await commitDay({ wlHome, date: dateTwo })
  const snapshotAfterTwo = await readText(paths.ledgerSnapshot)
  const logAfterTwo = await readText(paths.ledgerLog)

  // 崩溃注入:ledger-log 已含第二笔合法事务,快照被回退到第一笔之后的状态
  // (等价于"追加了事务但没来得及换快照"的中断点)
  await fs.writeFile(paths.ledgerSnapshot, snapshotAfterOne, 'utf8')

  const rebuilt = await rebuildLedger({ wlHome })
  assert.ok(rebuilt, 'rebuildLedger should report its result')
  assert.equal(await readText(paths.ledgerLog), logAfterTwo, 'rebuild must not touch ledger-log')
  const replayed = JSON.parse(await readText(paths.ledgerSnapshot))
  assert.deepEqual(replayed, JSON.parse(snapshotAfterTwo), 'replayed snapshot must equal the pre-crash state')
  assert.equal(replayed.confirmedThrough, dateTwo)
  assert.ok(replayed.todos.some(todo => todo.text === '重放校验新增待办' && todo.status === 'open'))
})

test('unacknowledged candidates stay out of the ledger and the report (AC-11)', async t => {
  const sandbox = await makeSandbox(t, 'wl-ac11-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = wlPaths(wlHome)
  const date = '2026-07-01'
  const done = ev({ ts: '2026-07-01T10:00:00+08:00', text: '第一手完成事项' })
  const accepted = candidate({ ts: '2026-07-01T12:00:00+08:00', text: '考古捞回的完成项' })
  const rejected = candidate({ ts: '2026-07-01T13:00:00+08:00', text: '被拒绝的候选不入账', source: 'archaeology:codex:session-b' })
  await seedDay(
    paths,
    date,
    dayFixture({ date, firsthand: [done], candidates: [accepted, rejected] }),
    confirmationFixture(date, { acceptCandidates: [accepted.id] }),
  )

  await commitDay({ wlHome, date })

  const logText = await readText(paths.ledgerLog)
  assert.ok(logText.includes('考古捞回的完成项'))
  assert.ok(!logText.includes('被拒绝的候选不入账'), 'unaccepted candidate text must not enter ledger-log')
  const snapshotText = await readText(paths.ledgerSnapshot)
  assert.ok(!snapshotText.includes('被拒绝的候选不入账'), 'unaccepted candidate text must not enter the snapshot')

  // commit 成功后调用 renderDay 刷新视图(契约),已确认日报也不得出现被拒条目
  const report = await readText(paths.reportMd(date))
  assert.ok(report.includes('第一手完成事项'))
  assert.ok(report.includes('考古捞回的完成项'))
  assert.ok(!report.includes('被拒绝的候选不入账'))
})

test('skipDay confirmation advances confirmedThrough with a skipped day entry', async t => {
  const sandbox = await makeSandbox(t, 'wl-skip-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = wlPaths(wlHome)
  const date = '2026-07-01'
  await seedDay(paths, date, dayFixture({ date }), confirmationFixture(date, { skipDay: true }))

  const result = await commitDay({ wlHome, date })
  assert.equal(result.noop, false)
  const snapshot = await readJson(paths.ledgerSnapshot)
  assert.equal(snapshot.days[date].status, 'skipped')
  assert.equal(snapshot.confirmedThrough, date)
})

test('no-data days between confirmations are backfilled as skipped', async t => {
  const sandbox = await makeSandbox(t, 'wl-gap-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = wlPaths(wlHome)
  // 隔离真实 CODEX_HOME:欠账日"有无数据"的判定不能被本机会话目录污染
  const codexHome = path.join(sandbox, 'codex-home-empty')
  await fs.mkdir(codexHome, { recursive: true })
  withEnv(t, { CODEX_HOME: codexHome })

  const dayOld = '2026-07-01'
  const dayGap = '2026-07-02'
  const dayNew = '2026-07-03'
  const evOld = ev({ ts: '2026-07-01T10:00:00+08:00', text: '第一天的完成事项' })
  const evNew = ev({ ts: '2026-07-03T10:00:00+08:00', text: '第三天的完成事项' })
  // inbox 只有 D-3 与 D-1 两天有数据,中间的 D-2 无任何数据
  await writeInbox(wlHome, [
    inboxLine({ ts: evOld.ts, type: 'done', text: evOld.text }),
    inboxLine({ ts: evNew.ts, type: 'done', text: evNew.text }),
  ])

  await seedDay(paths, dayOld, dayFixture({ date: dayOld, firsthand: [evOld] }), confirmationFixture(dayOld))
  await commitDay({ wlHome, date: dayOld })

  await seedDay(paths, dayNew, dayFixture({ date: dayNew, firsthand: [evNew] }), confirmationFixture(dayNew))
  await commitDay({ wlHome, date: dayNew })

  const snapshot = await readJson(paths.ledgerSnapshot)
  assert.equal(snapshot.days[dayOld].status, 'confirmed')
  assert.equal(snapshot.days[dayGap].status, 'skipped', 'the no-data gap day should be auto-skipped')
  assert.equal(snapshot.days[dayNew].status, 'confirmed')
  assert.equal(snapshot.confirmedThrough, dayNew)

  const transactions = (await readLogLines(paths)).map(line => JSON.parse(line))
  assert.ok(transactions.some(tx => tx.date === dayGap), 'the skipped gap day should get its own transaction')
})

test('supplement commits add events without touching the original transaction (AC-10)', async t => {
  const sandbox = await makeSandbox(t, 'wl-supplement-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = wlPaths(wlHome)
  const date = '2026-07-01'
  const original = ev({ ts: '2026-07-01T10:00:00+08:00', text: '第一天的完成事项' })
  await seedDay(
    paths,
    date,
    dayFixture({ date, firsthand: [original] }),
    confirmationFixture(date, { addIdeas: [{ text: '首轮确认的想法' }] }),
  )
  const first = await commitDay({ wlHome, date })
  assert.equal(first.noop, false)
  const linesAfterFirst = await readLogLines(paths)
  const [originalLine] = linesAfterFirst
  assert.equal(linesAfterFirst.length, 1)

  // 确认后再产生的事件:直接构造 mode:'supplement' 的 day.json 草稿喂 commitDay
  const supplement = ev({ ts: '2026-07-01T23:30:00+08:00', text: '补充的完成事项' })
  await seedDay(
    paths,
    date,
    dayFixture({ date, firsthand: [supplement], mode: 'supplement' }),
    confirmationFixture(date),
  )
  const second = await commitDay({ wlHome, date })
  assert.equal(second.noop, false)
  assert.notEqual(second.txId, first.txId)

  const lines = await readLogLines(paths)
  assert.equal(lines.length, 2)
  assert.equal(lines[0], originalLine, 'the original transaction line must stay byte-identical')
  const supplementLine = lines[lines.length - 1]
  assert.ok(supplementLine.includes('补充的完成事项'))
  assert.ok(!supplementLine.includes('第一天的完成事项'), 'the supplement must not restate already-committed events')

  const snapshot = await readJson(paths.ledgerSnapshot)
  assert.equal(snapshot.days[date].status, 'supplemented')
  assert.equal(snapshot.confirmedThrough, date)
})
