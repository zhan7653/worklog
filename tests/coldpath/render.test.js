import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { renderAll, renderDay } from '../../scripts/worklog/lib/render.js'
import { wlPaths } from '../../scripts/worklog/lib/paths.js'
import { eventId } from '../../scripts/worklog/lib/util.js'
import { assertOrder, makeSandbox, readText, writeJson } from './fixtures/helpers.js'

const DATE = '2026-07-01'

function ev(ts, type, text, project, source) {
  return { id: eventId(ts, text), ts, type, text, project, source }
}

// 手工构造一个"已确认日"的全套数据:ledger.json + ledger-log + day.json + confirmation.json
// 形状按实现方案 §4.2/§4.3/§4.4;渲染只读 ledger 与 day.json(契约)
async function buildConfirmedDay(wlHome) {
  const paths = wlPaths(wlHome)
  const events = [
    ev('2026-07-01T10:00:00+08:00', 'done', '修复授权衰减边界判定', 'alpha', 'commit:a3f2c19'),
    ev('2026-07-01T11:00:00+08:00', 'done', '整理发布清单', 'alpha', 'manual'),
    ev('2026-07-01T12:00:00+08:00', 'done', '确认 <script>alert(1)</script> 被当作文本', 'beta', 'manual'),
    ev('2026-07-01T13:00:00+08:00', 'todo', '补齐渲染测试', 'alpha', 'manual'),
    ev('2026-07-01T14:00:00+08:00', 'idea', '把确认流程做成 skill', 'alpha', 'manual'),
  ]
  const confirmation = {
    date: DATE,
    acceptCandidates: [],
    rejectCandidates: [],
    editText: [],
    completeTodos: [],
    addTodos: [],
    addIdeas: [],
    skipDay: false,
  }
  const txId = `${DATE}:${'ab12'.repeat(16)}`
  const snapshot = {
    schemaVersion: 1,
    confirmedThrough: DATE,
    todos: [
      // 新增(当日创建)、保留(历史挂账)、关闭(当日 closed)各一条,保证三段都有内容
      { id: 't-new-1', text: '补齐渲染测试', project: 'alpha', status: 'open', createdDate: DATE, updatedAt: '2026-07-01T18:00:00+08:00', sources: ['manual'] },
      { id: 't-old-1', text: '历史遗留待办', project: 'beta', status: 'open', createdDate: '2026-06-27', updatedAt: '2026-06-27T10:00:00+08:00', sources: ['manual'] },
      { id: 't-closed-1', text: '已完成的历史待办', project: 'alpha', status: 'done', createdDate: '2026-06-25', updatedAt: '2026-07-01T12:30:00+08:00', closedDate: DATE, sources: ['commit:a3f2c19'] },
    ],
    ideas: [
      { id: 'i-1', text: '把确认流程做成 skill', project: 'alpha', createdDate: DATE, sources: ['manual'] },
    ],
    days: {
      [DATE]: { status: 'confirmed', txId, counts: { done: 3, todoAdd: 1 } },
    },
  }
  const day = {
    schemaVersion: 1,
    date: DATE,
    assembledAt: '2026-07-01T21:00:00+08:00',
    firsthand: events,
    candidates: [],
    completionCandidates: [],
    openTodosSnapshot: [
      { id: 't-old-1', text: '历史遗留待办', project: 'beta', ageDays: 4 },
    ],
    overview: { text: '共 5 条记录覆盖 2 个项目。', by: 'template' },
    scan: { inboxLines: 5, collectors: {} },
  }
  await writeJson(paths.ledgerSnapshot, snapshot)
  await fs.mkdir(path.dirname(paths.ledgerLog), { recursive: true })
  await fs.writeFile(
    paths.ledgerLog,
    `${JSON.stringify({ txId, date: DATE, appliedAt: '2026-07-01T22:00:00+08:00', confirmation, resolvedEvents: events })}\n`,
    'utf8',
  )
  await writeJson(paths.dayJson(DATE), day)
  await writeJson(paths.confirmation(DATE), confirmation)
  return paths
}

test('renderDay writes the FR-11 report shape with source markers', async t => {
  const sandbox = await makeSandbox(t, 'wl-render-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = await buildConfirmedDay(wlHome)

  const result = await renderDay({ wlHome, date: DATE })
  assert.ok(result.paths, 'renderDay should report the written paths')

  const report = await readText(paths.reportMd(DATE))
  // FR-11 区块顺序:标题行 → 概览 → 完成 → 待办(新增/关闭/保留) → 想法 → 脚注
  assertOrder(report, [DATE, '## 完成', '## 待办', '新增', '关闭', '保留', '## 想法', 'day.json'])
  for (const banned of ['关键决策', '风险与阻塞', '明日优先', '项目进展']) {
    assert.ok(!report.includes(banned), `report.md must not contain the retired section "${banned}"`)
  }

  // 出处标记:commit:* → 短 sha,manual → ✎
  assert.ok(report.includes('修复授权衰减边界判定'))
  assert.ok(report.includes('a3f2c19'), 'commit:* source should render as a short sha marker')
  assert.ok(report.includes('✎'), 'manual source should render as the ✎ marker')

  // 待办三段的内容与账龄、想法区内容
  assert.ok(report.includes('补齐渲染测试'))
  assert.ok(report.includes('已完成的历史待办'))
  assert.ok(report.includes('历史遗留待办'))
  assert.match(report, /\d+\s*天/, 'the retained section should carry an age in days')
  assert.ok(report.includes('把确认流程做成 skill'))
})

test('renderAll re-renders views without touching ledger or day data (AC-12)', async t => {
  const sandbox = await makeSandbox(t, 'wl-render-all-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = await buildConfirmedDay(wlHome)
  await renderDay({ wlHome, date: DATE })

  const ledgerBefore = await fs.readFile(paths.ledgerSnapshot)
  const logBefore = await fs.readFile(paths.ledgerLog)
  const dayBefore = await fs.readFile(paths.dayJson(DATE))

  const result = await renderAll({ wlHome })
  assert.equal(typeof result.count, 'number')
  assert.ok(result.count >= 1, 'renderAll should re-render at least the confirmed day')
  const report = await readText(paths.reportMd(DATE))
  assert.ok(report.includes('## 完成'))

  const ledgerAfter = await fs.readFile(paths.ledgerSnapshot)
  const logAfter = await fs.readFile(paths.ledgerLog)
  const dayAfter = await fs.readFile(paths.dayJson(DATE))
  assert.ok(ledgerAfter.equals(ledgerBefore), 'ledger.json must stay byte-identical after renderAll')
  assert.ok(logAfter.equals(logBefore), 'ledger-log.jsonl must stay byte-identical after renderAll')
  assert.ok(dayAfter.equals(dayBefore), 'day.json must stay byte-identical after renderAll')
})

test('html rendering escapes event text', async t => {
  const sandbox = await makeSandbox(t, 'wl-render-html-')
  const wlHome = path.join(sandbox, 'wl-home')
  const paths = await buildConfirmedDay(wlHome)

  await renderDay({ wlHome, date: DATE, html: true })

  const html = await readText(paths.reportHtml(DATE))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'event text should be HTML-escaped')
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw event markup must never reach the html view')
})
