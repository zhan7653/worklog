import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assembleDay } from '../../scripts/worklog/lib/assemble.js'
import { wlPaths } from '../../scripts/worklog/lib/paths.js'
import { eventId } from '../../scripts/worklog/lib/util.js'
import {
  inboxLine,
  makeSandbox,
  readJson,
  rolloutEvent,
  withEnv,
  writeInbox,
  writeJson,
  writeRollout,
} from './fixtures/helpers.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const worklogBin = path.resolve(__dirname, '../../scripts/worklog/bin/worklog.js')
const failCodexBin = path.join(__dirname, 'fixtures', 'bin', 'mock-codex-fail.cjs')

const DATE = '2026-07-01'
const TZ = 'Asia/Shanghai'

// GIT_CONFIG_GLOBAL/SYSTEM 指向空设备:隔离用户的全局配置
// (尤其是本系统自己安装的 core.hooksPath post-commit 钩子,避免测试提交写进真实 inbox)
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_AUTHOR_NAME: 'wl-test',
  GIT_AUTHOR_EMAIL: 'wl-test@example.com',
  GIT_COMMITTER_NAME: 'wl-test',
  GIT_COMMITTER_EMAIL: 'wl-test@example.com',
}

async function initRepo(dir) {
  await fs.mkdir(dir, { recursive: true })
  await execFileAsync('git', ['init', '-q', dir], { env: gitEnv })
}

async function commitAt(dir, subject, iso) {
  await execFileAsync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', subject], {
    env: { ...gitEnv, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  })
  const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { env: gitEnv })
  return stdout.trim()
}

function message(timestamp, text, cwd) {
  return rolloutEvent(timestamp, {
    type: 'event_msg',
    payload: { type: 'user_message', message: text, cwd, title: 'fixture' },
  })
}

test('assembleDay slices the target local day and dedups candidates deterministically', async t => {
  const sandbox = await makeSandbox(t, 'wl-assemble-')
  const wlHome = path.join(sandbox, 'wl-home')
  const codexHome = path.join(sandbox, 'codex-home')
  const repoDir = path.join(sandbox, 'repo-alpha')
  // codex collector 经 resolveCodexHome 读 CODEX_HOME;无 LLM 配置(AC-9),
  // CODEX_BIN 兜底指向 fail mock:契约被违反时快速失败而不是挂住真实 codex
  withEnv(t, { CODEX_HOME: codexHome, WORKLOG_MATCH_MODEL: undefined, WORKLOG_CODEX_BIN: failCodexBin })

  await initRepo(repoDir)
  const shaCaptured = await commitAt(repoDir, '已捕获的提交不应重复出现', '2026-07-01T10:00:00+08:00')
  const shaFresh = await commitAt(repoDir, 'gitlog 捞回的独立提交', '2026-07-01T12:00:00+08:00')
  const shaNormalized = await commitAt(repoDir, '整理  发布 CHECKLIST', '2026-07-01T13:00:00+08:00')

  await writeInbox(wlHome, [
    inboxLine({ ts: '2026-06-30T23:00:00+08:00', type: 'done', text: '前一日手记不应进入' }),
    inboxLine({ ts: '2026-07-01T10:00:05+08:00', type: 'done', text: '手工改写过的提交记录', source: `commit:${shaCaptured}` }),
    inboxLine({ ts: '2026-07-01T11:00:00+08:00', type: 'done', text: '整理 发布 checklist' }),
    inboxLine({ ts: '2026-07-01T15:00:00+08:00', type: 'todo', text: '补一条端到端用例' }),
    inboxLine({ ts: '2026-07-02T09:00:00+08:00', type: 'done', text: '次日手记不应进入' }),
  ])
  await fs.mkdir(path.join(wlHome, 'state'), { recursive: true })
  await fs.writeFile(path.join(wlHome, 'state', 'repos.list'), `${repoDir}\n`, 'utf8')

  // 单个 rollout 文件同时含 目标日/前日/次日/缺 ts/坏行 事件(V1 跨日切片语义)
  await writeRollout(codexHome, DATE, 'cross', [
    message('2026-06-30T15:00:00.000Z', '旧日期工作。待办: 前日事件不应进入目标日。', '/workspace/cross'),
    message('2026-07-01T05:00:00.000Z', '目标日工作。待办: 收敛跨天日报能力。', '/workspace/cross'),
    message('2026-07-01T16:30:00.000Z', '次日事件不应进入。待办: 次日待办不应进入目标日。', '/workspace/cross'),
    { type: 'event_msg', payload: { type: 'user_message', message: '无 timestamp 不应进入。待办: 缺时间戳不应进入。', cwd: '/workspace/cross' } },
    'not-json',
  ])
  await writeRollout(codexHome, '2026-07-03', 'future-dir', [
    message('2026-07-01T06:00:00.000Z', '未来目录里的目标日事件不应被扫描。待办: 未来目录不应被扫描。', '/workspace/future'),
  ])

  const result = await assembleDay({ wlHome, date: DATE, timezone: TZ, lookbackDays: 0, useLlm: true })

  const paths = wlPaths(wlHome)
  assert.equal(result.path, paths.dayJson(DATE))
  const day = await readJson(paths.dayJson(DATE))
  assert.deepEqual(result.day, day)

  // day.json 形状(实现方案 §4.2)
  assert.equal(day.schemaVersion, 1)
  assert.equal(day.date, DATE)
  for (const key of ['firsthand', 'candidates', 'completionCandidates', 'openTodosSnapshot']) {
    assert.ok(Array.isArray(day[key]), `day.${key} should be an array`)
  }
  assert.equal(typeof day.scan, 'object')
  assert.equal(typeof day.scan.inboxLines, 'number')
  assert.ok(day.scan.collectors.codex, 'scan.collectors.codex should be recorded')
  assert.ok(day.scan.collectors.gitlog, 'scan.collectors.gitlog should be recorded')

  // 一手记录:只含目标本地日的 inbox 行,id = eventId(ts, text)
  const firsthandJson = JSON.stringify(day.firsthand)
  assert.equal(day.firsthand.length, 3)
  assert.ok(firsthandJson.includes('手工改写过的提交记录'))
  assert.ok(firsthandJson.includes('整理 发布 checklist'))
  assert.ok(firsthandJson.includes('补一条端到端用例'))
  assert.ok(!firsthandJson.includes('前一日手记不应进入'))
  assert.ok(!firsthandJson.includes('次日手记不应进入'))
  const manual = day.firsthand.find(item => item.text === '手工改写过的提交记录')
  assert.equal(manual.id, eventId('2026-07-01T10:00:05+08:00', '手工改写过的提交记录'))

  // codex 候选:目标日事件产候选,前日/次日/缺 ts/未来目录事件不产
  const candidatesJson = JSON.stringify(day.candidates)
  assert.ok(candidatesJson.includes('收敛跨天日报能力'))
  assert.ok(!candidatesJson.includes('前日事件不应进入目标日'))
  assert.ok(!candidatesJson.includes('次日待办不应进入目标日'))
  assert.ok(!candidatesJson.includes('缺时间戳不应进入'))
  assert.ok(!candidatesJson.includes('未来目录不应被扫描'))

  // gitlog 候选:sha 精确去重(inbox 已有的 commit 不再出现),normalizeText 精确去重
  const gitlogCandidate = day.candidates.find(item => item.source === `archaeology:gitlog:${shaFresh}`)
  assert.ok(gitlogCandidate, 'the un-captured commit should surface as a gitlog candidate')
  assert.equal(gitlogCandidate.text, 'gitlog 捞回的独立提交')
  assert.ok(
    !day.candidates.some(item => String(item.source).includes(shaCaptured)),
    'a commit already captured in inbox must not reappear as a candidate',
  )
  assert.ok(!candidatesJson.includes('已捕获的提交不应重复出现'))
  assert.ok(
    !day.candidates.some(item => String(item.source).includes(shaNormalized)),
    'a candidate equal to a firsthand text after normalizeText must be dropped',
  )

  // 无 LLM 配置:概览为模板句(AC-9);无账本:未结待办快照为空
  assert.equal(day.overview.by, 'template')
  assert.match(day.overview.text, /^共 \d+ 条记录覆盖 \d+ 个项目。$/)
  assert.deepEqual(day.openTodosSnapshot, [])
  assert.deepEqual(day.completionCandidates, [])
})

test('assembleDay surfaces exact completion candidates from the open-todo snapshot', async t => {
  const sandbox = await makeSandbox(t, 'wl-exact-')
  const wlHome = path.join(sandbox, 'wl-home')
  const codexHome = path.join(sandbox, 'codex-home-empty')
  await fs.mkdir(codexHome, { recursive: true })
  withEnv(t, { CODEX_HOME: codexHome, WORKLOG_MATCH_MODEL: undefined, WORKLOG_CODEX_BIN: failCodexBin })

  await writeJson(path.join(wlHome, 'ledger', 'ledger.json'), {
    schemaVersion: 1,
    confirmedThrough: '2026-06-30',
    todos: [
      {
        id: 't-open-1',
        text: '补齐渲染测试',
        project: 'alpha',
        status: 'open',
        createdDate: '2026-06-27',
        updatedAt: '2026-06-27T10:00:00+08:00',
        sources: ['manual'],
      },
      {
        id: 't-done-1',
        text: '已完成的旧待办',
        project: 'alpha',
        status: 'done',
        createdDate: '2026-06-20',
        updatedAt: '2026-06-25T10:00:00+08:00',
        closedDate: '2026-06-25',
        sources: ['manual'],
      },
    ],
    ideas: [],
    days: {},
  })
  // 快照有一条 open todo,inbox 出现同文本 done → completionCandidates exact 命中
  await writeInbox(wlHome, [
    inboxLine({ ts: '2026-07-01T09:30:00+08:00', type: 'done', text: '补齐渲染测试' }),
  ])

  const { day } = await assembleDay({ wlHome, date: DATE, timezone: TZ, lookbackDays: 0, useLlm: false })

  assert.deepEqual(day.openTodosSnapshot.map(item => item.id), ['t-open-1'])
  assert.ok(Number.isInteger(day.openTodosSnapshot[0].ageDays), 'openTodosSnapshot should carry ageDays')
  assert.equal(day.completionCandidates.length, 1)
  assert.equal(day.completionCandidates[0].todoId, 't-open-1')
  assert.equal(day.completionCandidates[0].by, 'exact')
})

// AC 入口校验:非法 --date(路径穿越)在所有带 date 的子命令入口被拒
test('worklog.js rejects path-traversal --date across subcommands', async t => {
  const sandbox = await makeSandbox(t, 'wl-cli-')
  for (const subcommand of ['assemble', 'confirm', 'commit', 'render']) {
    await assert.rejects(
      execFileAsync(process.execPath, [worklogBin, subcommand, '--date', '../x'], {
        env: { ...process.env, WL_HOME: sandbox },
      }),
      error => {
        assert.equal(error.code, 1, `${subcommand} should exit 1 on an invalid --date`)
        assert.match(String(error.stderr), /Invalid --date/, `${subcommand} should report the invalid --date on stderr`)
        return true
      },
    )
  }
})
