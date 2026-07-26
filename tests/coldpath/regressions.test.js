// 对抗验收审查确认缺陷的回归锁(2026-07-26 审查轮)。
// 每个用例对应一个已复现后修复的缺陷,防止无声回归。
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { assembleDay, confirmDay } from '../../scripts/worklog/lib/assemble.js'
import { commitDay, rebuildLedger } from '../../scripts/worklog/lib/commit.js'
import { renderDay } from '../../scripts/worklog/lib/render.js'
import { wlPaths } from '../../scripts/worklog/lib/paths.js'
import { eventId } from '../../scripts/worklog/lib/util.js'
import {
  appendJsonlLines,
  inboxLine,
  makeSandbox,
  readJson,
  readText,
  withEnv,
  writeInbox,
} from './fixtures/helpers.js'

const DATE = '2026-07-01'
const TZ = 'Asia/Shanghai'

async function isolatedHome(t, prefix) {
  const sandbox = await makeSandbox(t, prefix)
  const wlHome = path.join(sandbox, 'wl-home')
  // codex 采集器指向空目录、无 repos.list:候选为空,聚焦一手链路
  withEnv(t, { CODEX_HOME: path.join(sandbox, 'codex-empty'), WORKLOG_MATCH_MODEL: undefined })
  return wlHome
}

async function settle(wlHome, date, patch = {}) {
  await confirmDay({ wlHome, date, patch: { date, ...patch } })
  return commitDay({ wlHome, date })
}

// 缺陷:txId 只哈希 confirmation,空补丁补充结算与首轮碰撞 → 补充事件静默丢失(AC-10)
test('supplement with an identical empty patch still lands as a new transaction', async t => {
  const wlHome = await isolatedHome(t, 'wl-reg-supplement-')
  const paths = wlPaths(wlHome)
  await writeInbox(wlHome, [inboxLine({ ts: `${DATE}T10:00:00+08:00`, type: 'done', text: '第一批工作' })])
  await assembleDay({ wlHome, date: DATE, timezone: TZ, lookbackDays: 0 })
  const first = await settle(wlHome, DATE)
  assert.equal(first.noop, false)

  // 确认后追加的事件(ts 甚至早于 appliedAt——assemble 与 commit 之间的窗口)
  await writeInbox(wlHome, [inboxLine({ ts: `${DATE}T09:00:00+08:00`, type: 'done', text: '窗口内捕获的工作' })])
  const { day } = await assembleDay({ wlHome, date: DATE, timezone: TZ, lookbackDays: 0 })
  assert.equal(day.mode, 'supplement')
  assert.deepEqual(day.firsthand.map(event => event.text), ['窗口内捕获的工作'])

  const second = await settle(wlHome, DATE)
  assert.equal(second.noop, false, 'supplement commit must not collide with the first txId')
  assert.notEqual(second.txId, first.txId)

  const log = (await readText(paths.ledgerLog)).trim().split('\n')
  assert.equal(log.length, 2)
  const report = await readText(paths.reportMd(DATE))
  assert.ok(report.includes('第一批工作'))
  assert.ok(report.includes('窗口内捕获的工作'))

  // 空补充(无任何新内容)不再落事务
  await assembleDay({ wlHome, date: DATE, timezone: TZ, lookbackDays: 0 })
  const third = await settle(wlHome, DATE)
  assert.equal(third.noop, true)
  assert.equal((await readText(paths.ledgerLog)).trim().split('\n').length, 2)
})

// 缺陷:replay 不按 txId 去重,并发竞态留下的重复事务行被双重应用
test('rebuild ignores duplicated transaction lines in the log', async t => {
  const wlHome = await isolatedHome(t, 'wl-reg-replay-')
  const paths = wlPaths(wlHome)
  const tx = {
    txId: `${DATE}:deadbeef`,
    date: DATE,
    appliedAt: `${DATE}T22:00:00+08:00`,
    confirmation: { date: DATE, skipDay: false },
    resolvedEvents: [
      { id: eventId(`${DATE}T10:00:00+08:00`, '重复行工作'), ts: `${DATE}T10:00:00+08:00`, type: 'done', text: '重复行工作', project: 'alpha', source: 'manual' },
      { id: eventId(`${DATE}T11:00:00+08:00`, '重复行待办'), ts: `${DATE}T11:00:00+08:00`, type: 'todo', text: '重复行待办', project: 'alpha', source: 'manual' },
    ],
  }
  await appendJsonlLines(paths.ledgerLog, [tx, tx])

  const result = await rebuildLedger({ wlHome })
  assert.equal(result.days, 1)
  assert.equal(result.todos, 1)
  const snapshot = await readJson(paths.ledgerSnapshot)
  assert.equal(snapshot.days[DATE].status, 'confirmed', 'duplicate line must not flip the day to supplemented')
  assert.equal(snapshot.days[DATE].counts.done, 1)
})

// 缺陷:跳过今天必须先跑全量 assemble(FR-8「零成本退出」被违反)
test('skipDay settles without day.json and renders an empty skipped report', async t => {
  const wlHome = await isolatedHome(t, 'wl-reg-skip-')
  const paths = wlPaths(wlHome)
  await confirmDay({ wlHome, date: DATE, patch: { date: DATE, skipDay: true } })
  const result = await commitDay({ wlHome, date: DATE })
  assert.equal(result.noop, false)
  const snapshot = await readJson(paths.ledgerSnapshot)
  assert.equal(snapshot.days[DATE].status, 'skipped')
  const report = await readText(paths.reportMd(DATE))
  assert.ok(report.includes('status:skipped'))
  // skip 与其他补丁字段互斥
  await assert.rejects(
    () => confirmDay({ wlHome, date: '2026-07-02', patch: { skipDay: true, addTodos: [{ text: 'x' }] } }),
    /skipDay/,
  )
})

// 缺陷:乱序结算把有数据的欠账日静默吞进 confirmedThrough
test('settling a later day refuses to swallow earlier days that still hold data', async t => {
  const wlHome = await isolatedHome(t, 'wl-reg-ordered-')
  await writeInbox(wlHome, [inboxLine({ ts: '2026-07-01T10:00:00+08:00', type: 'done', text: 'D1 工作' })])
  await assembleDay({ wlHome, date: '2026-07-01', timezone: TZ, lookbackDays: 0 })
  await settle(wlHome, '2026-07-01')

  await writeInbox(wlHome, [
    inboxLine({ ts: '2026-07-02T10:00:00+08:00', type: 'done', text: 'D2 工作' }),
    inboxLine({ ts: '2026-07-03T10:00:00+08:00', type: 'done', text: 'D3 工作' }),
  ])
  await assembleDay({ wlHome, date: '2026-07-03', timezone: TZ, lookbackDays: 0 })
  await confirmDay({ wlHome, date: '2026-07-03', patch: { date: '2026-07-03' } })
  await assert.rejects(() => commitDay({ wlHome, date: '2026-07-03' }), /2026-07-02/)

  // 显式跳过 D2 之后,D3 正常入账
  await confirmDay({ wlHome, date: '2026-07-02', patch: { date: '2026-07-02', skipDay: true } })
  await commitDay({ wlHome, date: '2026-07-02' })
  const result = await commitDay({ wlHome, date: '2026-07-03' })
  assert.equal(result.noop, false)
})

// 缺陷:多行事件文本可向 report.md 注入 FR-11 明令不设的区块标题
test('multi-line event text cannot inject banned section headings', async t => {
  const wlHome = await isolatedHome(t, 'wl-reg-inject-')
  const paths = wlPaths(wlHome)
  const evil = '看似无害的第一行\n## 明日优先\n- 接管世界'
  await writeInbox(wlHome, [inboxLine({ ts: `${DATE}T10:00:00+08:00`, type: 'done', text: evil })])
  await assembleDay({ wlHome, date: DATE, timezone: TZ, lookbackDays: 0 })
  await settle(wlHome, DATE)
  await renderDay({ wlHome, date: DATE })
  const report = await readText(paths.reportMd(DATE))
  assert.ok(!/^## 明日优先/m.test(report), 'event text newlines must be folded before markdown rendering')
  assert.ok(report.includes('接管世界'), 'the text itself still renders, folded into one line')
})
