import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runMatch } from '../../scripts/worklog/lib/match.js'
import { withEnv } from './fixtures/helpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mockBin = name => path.join(__dirname, 'fixtures', 'bin', name)

// 输入 id 与 mock 固定输出的 id 对齐(cand-dup/e-first/cand-done/todo-open)
function matchInput() {
  return {
    candidates: [
      { id: 'cand-dup', type: 'done', text: '修复授权衰减边界判定（换个说法）', project: 'alpha', source: 'archaeology:codex:session-a' },
      { id: 'cand-done', type: 'done', text: '渲染测试全部补齐', project: 'alpha', source: 'archaeology:gitlog:a3f2c19' },
    ],
    firsthand: [
      { id: 'e-first', ts: '2026-07-01T10:00:00+08:00', type: 'done', text: '修复授权衰减边界判定', project: 'alpha', source: 'commit:a3f2c19' },
    ],
    openTodos: [
      { id: 'todo-open', text: '补齐渲染测试', project: 'alpha', ageDays: 4 },
    ],
    lang: 'zh-CN',
  }
}

test('runMatch returns merges, completions and overview from the model output', async t => {
  withEnv(t, {
    WORKLOG_CODEX_BIN: mockBin('mock-codex-success.cjs'),
    WORKLOG_MATCH_MODEL: 'mock-model',
    WORKLOG_MATCH_REASONING_EFFORT: 'high',
  })
  const result = await runMatch(matchInput())
  assert.deepEqual(result.merges, [{ candidateId: 'cand-dup', duplicateOf: 'e-first' }])
  assert.deepEqual(result.completions, [{ candidateId: 'cand-done', todoId: 'todo-open', confidence: 'high' }])
  assert.equal(result.overview, '今天收敛了授权边界与渲染测试，两个项目各有推进。')
})

test('runMatch rejects when the codex process exits non-zero', async t => {
  withEnv(t, {
    WORKLOG_CODEX_BIN: mockBin('mock-codex-fail.cjs'),
    WORKLOG_MATCH_MODEL: 'mock-model',
    WORKLOG_MATCH_REASONING_EFFORT: undefined,
  })
  await assert.rejects(async () => { await runMatch(matchInput()) })
})

test('runMatch rejects when the model payload is not valid JSON', async t => {
  withEnv(t, {
    WORKLOG_CODEX_BIN: mockBin('mock-codex-badjson.cjs'),
    WORKLOG_MATCH_MODEL: 'mock-model',
    WORKLOG_MATCH_REASONING_EFFORT: undefined,
  })
  await assert.rejects(async () => { await runMatch(matchInput()) })
})

test('runMatch rejects when WORKLOG_MATCH_MODEL is not configured', async t => {
  withEnv(t, {
    WORKLOG_CODEX_BIN: mockBin('mock-codex-success.cjs'),
    WORKLOG_MATCH_MODEL: undefined,
    WORKLOG_MATCH_REASONING_EFFORT: undefined,
  })
  await assert.rejects(async () => { await runMatch(matchInput()) }, /WORKLOG_MATCH_MODEL/i)
})

test('runMatch rejects a reasoning effort outside the whitelist', async t => {
  withEnv(t, {
    WORKLOG_CODEX_BIN: mockBin('mock-codex-success.cjs'),
    WORKLOG_MATCH_MODEL: 'mock-model',
    WORKLOG_MATCH_REASONING_EFFORT: 'turbo',
  })
  await assert.rejects(async () => { await runMatch(matchInput()) }, /turbo|effort/i)
})
