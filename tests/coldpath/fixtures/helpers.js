import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

export async function makeSandbox(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

export async function readText(filePath) {
  return fs.readFile(filePath, 'utf8')
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function appendJsonlLines(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const body = rows.map(row => JSON.stringify(row)).join('\n')
  await fs.appendFile(filePath, `${body}\n`, 'utf8')
}

// FR-2 固定键序:{ts,type,text,project,source}
export function inboxLine({ ts, type, text, project = 'alpha', source = 'manual' }) {
  return { ts, type, text, project, source }
}

export async function writeInbox(wlHome, rows) {
  await appendJsonlLines(path.join(wlHome, 'inbox.jsonl'), rows)
}

export async function writeRollout(codexHome, date, id, lines) {
  const [year, month, day] = date.split('-')
  const dir = path.join(codexHome, 'sessions', year, month, day)
  await fs.mkdir(dir, { recursive: true })
  const body = lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
  await fs.writeFile(path.join(dir, `rollout-${id}.jsonl`), `${body}\n`, 'utf8')
}

export function rolloutEvent(timestamp, rest) {
  return { timestamp, ...rest }
}

export function assertOrder(text, needles) {
  let cursor = -1
  for (const needle of needles) {
    const index = text.indexOf(needle)
    assert.ok(index > cursor, `"${needle}" should appear after the previous marker`)
    cursor = index
  }
}

// 用例内 set,t.after 自动 restore;value 为 undefined 表示删除该变量
export function withEnv(t, vars) {
  const saved = {}
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}
