import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { localDayUtcRange, resolveTimezone } from '../paths.js'
import { eventId, redactText } from '../util.js'

const execFileAsync = promisify(execFile)
const FIELD_SEP = '\u001f'
const RECORD_SEP = '\u001e'
// ts 取提交者日期 %cI,与 --since/--until 的过滤锚点一致(作者日期在 rebase/cherry-pick 后可能跨日)
const GIT_FORMAT = '%H%x1f%h%x1f%s%x1f%cI%x1e'
const GIT_TIMEOUT_MS = 15000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const ERROR_SNIPPET_LIMIT = 200

export async function collectGitlog({ date, timezone, reposListPath, knownCommitSources } = {}) {
  const resolvedTimezone = resolveTimezone(timezone)
  const range = localDayUtcRange(date, resolvedTimezone)
  const startIso = stripMilliseconds(range.startIso)
  const endIso = stripMilliseconds(range.endIso)
  const knownRaw = knownCommitSources instanceof Set ? knownCommitSources : new Set(knownCommitSources || [])
  const known = new Set([...knownRaw].map(value => String(value).toLowerCase()))

  const scan = {
    reposListPath: reposListPath || '',
    reposListFound: false,
    timezone: resolvedTimezone,
    window: { startIso, endIso },
    repos: [],
  }
  const candidates = []

  const repos = await readReposList(reposListPath)
  if (repos === null) return { candidates, scan }
  scan.reposListFound = true

  const seenShas = new Set()
  for (const repoPath of repos) {
    const entry = { path: repoPath, status: 'ok', commitCount: 0, newCount: 0, badRecords: 0 }
    scan.repos.push(entry)

    if (!(await isDirectory(repoPath))) {
      entry.status = 'missing'
      continue
    }

    // per-repo 逃生门(FR-13):git config worklog.capture false 的仓库,考古兜底同样跳过,
    // 否则"先用后关"的仓库提交仍会以候选身份回到确认面
    if ((await gitConfigValue(repoPath, 'worklog.capture')) === 'false') {
      entry.status = 'opted-out'
      continue
    }

    let stdout
    try {
      const result = await execFileAsync(
        'git',
        [
          '-C', repoPath,
          'log',
          `--since=${startIso}`,
          `--until=${endIso}`,
          '--no-merges',
          `--format=${GIT_FORMAT}`,
        ],
        { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      )
      stdout = result.stdout
    } catch (error) {
      entry.status = 'git-error'
      // stderr 可能含带凭据的 remote URL,入 day.json 前脱敏(FR-12)
      entry.error = redactText(String(error?.stderr || error?.message || error).trim().slice(0, ERROR_SNIPPET_LIMIT))
      continue
    }

    const project = path.basename(repoPath)
    for (const rawRecord of String(stdout).split(RECORD_SEP)) {
      const record = rawRecord.trim()
      if (!record) continue
      const fields = record.split(FIELD_SEP)
      if (fields.length < 4) {
        entry.badRecords += 1
        continue
      }
      const [fullSha, shortSha, subject, committerIso] = fields.map(field => field.trim())
      if (!fullSha || !shortSha || !committerIso) {
        entry.badRecords += 1
        continue
      }
      entry.commitCount += 1
      if (!subject) continue
      if (known.has(`commit:${shortSha.toLowerCase()}`) || known.has(`commit:${fullSha.toLowerCase()}`)) continue
      if (seenShas.has(fullSha)) continue
      seenShas.add(fullSha)
      entry.newCount += 1

      const text = redactText(subject)
      candidates.push({
        id: eventId(committerIso, text),
        ts: committerIso,
        type: 'done',
        text,
        project,
        source: `archaeology:gitlog:${shortSha}`,
      })
    }
  }

  candidates.sort(compareCandidates)
  return { candidates, scan }
}

async function readReposList(reposListPath) {
  if (!reposListPath) return null
  let raw
  try {
    raw = await fs.readFile(reposListPath, 'utf8')
  } catch {
    return null
  }
  const seen = new Set()
  const repos = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    repos.push(trimmed)
  }
  return repos
}

async function isDirectory(candidatePath) {
  try {
    return (await fs.stat(candidatePath)).isDirectory()
  } catch {
    return false
  }
}

async function gitConfigValue(repoPath, key) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'config', '--get', key], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    return String(stdout).trim()
  } catch {
    return ''
  }
}

function stripMilliseconds(iso) {
  return String(iso).replace(/\.\d{3}Z$/, 'Z')
}

function compareCandidates(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}
