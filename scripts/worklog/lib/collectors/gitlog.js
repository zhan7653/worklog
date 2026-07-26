import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { localDayUtcRange, resolveTimezone } from '../paths.js'
import { eventId, redactText } from '../util.js'

const execFileAsync = promisify(execFile)
const FIELD_SEP = '\u001f'
const RECORD_SEP = '\u001e'
const GIT_FORMAT = '%H%x1f%h%x1f%s%x1f%aI%x1e'
const GIT_TIMEOUT_MS = 15000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const ERROR_SNIPPET_LIMIT = 200

export async function collectGitlog({ date, timezone, reposListPath, knownCommitSources } = {}) {
  const resolvedTimezone = resolveTimezone(timezone)
  const range = localDayUtcRange(date, resolvedTimezone)
  const startIso = stripMilliseconds(range.startIso)
  const endIso = stripMilliseconds(range.endIso)
  const known = knownCommitSources instanceof Set ? knownCommitSources : new Set(knownCommitSources || [])

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
      entry.error = String(error?.stderr || error?.message || error).trim().slice(0, ERROR_SNIPPET_LIMIT)
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
      const [fullSha, shortSha, subject, authorIso] = fields.map(field => field.trim())
      if (!fullSha || !shortSha || !authorIso) {
        entry.badRecords += 1
        continue
      }
      entry.commitCount += 1
      if (!subject) continue
      if (known.has(`commit:${shortSha}`) || known.has(`commit:${fullSha}`)) continue
      if (seenShas.has(fullSha)) continue
      seenShas.add(fullSha)
      entry.newCount += 1

      const text = redactText(subject)
      candidates.push({
        id: eventId(authorIso, text),
        ts: authorIso,
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

function stripMilliseconds(iso) {
  return String(iso).replace(/\.\d{3}Z$/, 'Z')
}

function compareCandidates(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}
