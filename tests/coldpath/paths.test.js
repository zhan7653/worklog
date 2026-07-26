import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { assertValidDate, dateWindow, localDayUtcRange } from '../../scripts/worklog/lib/paths.js'

const codexHome = path.join(path.sep, 'tmp', 'wl-codex-window')

// V1 语义:正时区跨日窗口带前一 UTC 目录进位(上海凌晨事件落在前一 UTC 目录)
test('dateWindow slices a cross-day window with previous UTC carry for Asia/Shanghai', () => {
  const window = dateWindow({ codexHome, date: '2026-07-02', lookbackDays: 1, timezone: 'Asia/Shanghai' })
  assert.deepEqual(
    window.map(item => item.date),
    ['2026-06-30', '2026-07-01', '2026-07-02'],
  )
  assert.ok(!window.some(item => item.date === '2026-07-03'))
  assert.equal(window[0].path, path.join(codexHome, 'sessions', '2026', '06', '30'))
  assert.equal(window[2].path, path.join(codexHome, 'sessions', '2026', '07', '02'))
})

// V1 语义:负时区跨日窗口带后一 UTC 目录进位(LA 傍晚事件落在后一 UTC 目录)
test('dateWindow slices a cross-day window with next UTC carry for America/Los_Angeles', () => {
  const window = dateWindow({ codexHome, date: '2026-07-02', lookbackDays: 1, timezone: 'America/Los_Angeles' })
  assert.deepEqual(
    window.map(item => item.date),
    ['2026-07-01', '2026-07-02', '2026-07-03'],
  )
  assert.ok(!window.some(item => item.date === '2026-06-30'))
})

// V1 'collect scans previous UTC directory' 的窗口层等价
test('dateWindow adds the previous UTC directory when the timezone maps it into the target day', () => {
  const window = dateWindow({ codexHome, date: '2026-07-01', lookbackDays: 0, timezone: 'Asia/Shanghai' })
  assert.deepEqual(
    window.map(item => item.date),
    ['2026-06-30', '2026-07-01'],
  )
})

// V1 'collect scans next UTC directory' 的窗口层等价
test('dateWindow adds the next UTC directory when the timezone maps it into the target day', () => {
  const window = dateWindow({ codexHome, date: '2026-07-01', lookbackDays: 0, timezone: 'America/Los_Angeles' })
  assert.deepEqual(
    window.map(item => item.date),
    ['2026-07-01', '2026-07-02'],
  )
})

test('localDayUtcRange maps a Shanghai local day to absolute UTC boundaries', () => {
  const range = localDayUtcRange('2026-07-01', 'Asia/Shanghai')
  assert.equal(range.startIso, '2026-06-30T16:00:00.000Z')
  assert.equal(range.endIso, '2026-07-01T16:00:00.000Z')
})

test('localDayUtcRange maps a Los Angeles local day to absolute UTC boundaries', () => {
  const range = localDayUtcRange('2026-07-01', 'America/Los_Angeles')
  assert.equal(range.startIso, '2026-07-01T07:00:00.000Z')
  assert.equal(range.endIso, '2026-07-02T07:00:00.000Z')
})

test('assertValidDate rejects traversal, fake calendar dates and malformed input', () => {
  for (const bad of ['../x', '../2026-07-01', '2026-13-40', '2026-02-29', '2026/07/01', '2026-7-1', '', 'not-a-date']) {
    assert.throws(() => assertValidDate(bad), /Invalid --date/, `"${bad}" should be rejected`)
  }
  assert.doesNotThrow(() => assertValidDate('2026-07-01'))
  assert.doesNotThrow(() => assertValidDate('2028-02-29'))
})
