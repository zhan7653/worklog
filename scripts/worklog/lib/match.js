import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'

const MATCH_SCHEMA_PATH = fileURLToPath(new URL('../schemas/match.schema.json', import.meta.url))
const DEFAULT_REASONING_EFFORT = 'medium'
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])
const CONFIDENCE_LEVELS = new Set(['high', 'low'])

export async function runMatch({ candidates = [], firsthand = [], openTodos = [], lang = 'zh-CN' } = {}) {
  const model = requireModel()
  const reasoningEffort = resolveReasoningEffort()
  const codexBin = process.env.WORKLOG_CODEX_BIN || 'codex'
  const prompt = buildPrompt({ candidates, firsthand, openTodos, lang })
  const result = await runCodex(codexBin, prompt, { model, reasoningEffort })
  return parseMatchJson(result.stdout)
}

function requireModel() {
  const model = (process.env.WORKLOG_MATCH_MODEL || '').trim()
  if (!model) {
    throw new Error(
      'WORKLOG_MATCH_MODEL is not set: the LLM match layer is unconfigured. ' +
        'Set WORKLOG_MATCH_MODEL to a codex model name to enable it.',
    )
  }
  return model
}

function resolveReasoningEffort() {
  const raw = (process.env.WORKLOG_MATCH_REASONING_EFFORT || '').trim()
  if (!raw) return DEFAULT_REASONING_EFFORT
  if (!REASONING_EFFORTS.has(raw)) {
    throw new Error(
      `WORKLOG_MATCH_REASONING_EFFORT must be one of minimal|low|medium|high|xhigh, got: ${raw}`,
    )
  }
  return raw
}

function pickFields(item) {
  const out = {}
  if (item?.id != null) out.id = String(item.id)
  if (item?.type != null) out.type = String(item.type)
  out.text = String(item?.text ?? '')
  if (item?.project != null && item.project !== '') out.project = String(item.project)
  return out
}

function buildPrompt({ candidates, firsthand, openTodos, lang }) {
  const input = {
    candidates: candidates.map(pickFields),
    firsthand: firsthand.map(pickFields),
    openTodos: openTodos.map(pickFields),
  }
  return `You are the matching layer of a local personal worklog system.

The input below has three lists:
- candidates: events recovered from log archaeology for the day (advisory, may duplicate firsthand records)
- firsthand: events the user recorded firsthand during the day (authoritative)
- openTodos: todos still open in the ledger before this day

Perform exactly three tasks:
1. merges: find candidates that describe the same work as a firsthand record even when the wording differs. Report each pair as { "candidateId": <candidate id>, "duplicateOf": <firsthand id> }. Only pair a candidate with a firsthand record, and only when they clearly refer to the same piece of work.
2. completions: find open todos that were completed by a done-type candidate or done-type firsthand event. Report each as { "candidateId": <candidate or firsthand id>, "todoId": <open todo id>, "confidence": "high" | "low" }. Use "high" only when the texts clearly describe the same task; use "low" for plausible but uncertain matches.
3. overview: write a two-to-three sentence overview of the day in language ${lang}, grounded in the firsthand and candidate events. No headings, no lists, no invented facts.

Never invent ids: every candidateId, duplicateOf and todoId must be copied verbatim from the input. When unsure, omit the pair — empty arrays are valid answers.

Return only the JSON object required by the configured output schema. Do not include Markdown fences.

Input:
${JSON.stringify(input, null, 2)}`
}

async function runCodex(codexBin, prompt, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-match-'))
  const args = buildCodexArgs({
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    tempDir,
    schemaPath: options.schemaPath,
  })
  const stdoutPath = path.join(tempDir, 'stdout.jsonl')
  const stderrPath = path.join(tempDir, 'stderr.log')
  const stdoutHandle = await fs.open(stdoutPath, 'w')
  const stderrHandle = await fs.open(stderrPath, 'w')

  try {
    const timeoutMs = parseTimeoutMs(process.env.WORKLOG_MATCH_TIMEOUT_MS)
    const code = await new Promise((resolve, reject) => {
      const child = spawn(codexBin, args, {
        cwd: tempDir,
        stdio: ['pipe', stdoutHandle.fd, stderrHandle.fd],
        env: process.env,
      })
      // 挂起型故障也要走降级(FR-7):codex 卡死不能把 assemble 无限拖死
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`codex exec timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.on('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', value => {
        clearTimeout(timer)
        resolve(value)
      })
      // 子进程早退时写 stdin 会抛 EPIPE,未挂 error 处理会打崩整个进程(V1 缺陷修复)。
      // 真实失败由退出码与 stderr 呈现,这里只吞掉流错误。
      child.stdin.on('error', () => {})
      child.stdin.write(prompt)
      child.stdin.end()
    })
    await stdoutHandle.close()
    await stderrHandle.close()

    const stdout = await readText(stdoutPath)
    const stderr = await readText(stderrPath)
    if (code !== 0) throw new Error(`codex exec failed (${code}): ${stderr || stdout}`)
    return { stdout, stderr }
  } finally {
    await stdoutHandle.close().catch(() => {})
    await stderrHandle.close().catch(() => {})
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

function parseTimeoutMs(value) {
  const number = Number(value)
  if (Number.isInteger(number) && number > 0) return number
  return 120000
}

export function buildCodexArgs({
  model,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  tempDir,
  schemaPath = MATCH_SCHEMA_PATH,
}) {
  if (!model) throw new Error('buildCodexArgs requires an explicit model (no default model name)')
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--model',
    model,
    '--sandbox',
    'read-only',
    '--config',
    `model_reasoning_effort="${reasoningEffort}"`,
    '--cd',
    tempDir,
    '--output-schema',
    schemaPath,
    '-',
  ]
}

export function parseMatchJson(stdout) {
  const candidates = []
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        candidates.push(String(event.item.text || ''))
      }
    } catch {
      candidates.push(trimmed)
    }
  }
  candidates.push(String(stdout || ''))

  let lastError = null
  for (const candidate of candidates) {
    for (const text of [candidate, extractFirstJsonObject(candidate)]) {
      if (!text) continue
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        continue
      }
      try {
        if (parsed?.type === 'item.completed' && parsed.item?.type === 'agent_message') {
          return validateMatchShape(JSON.parse(parsed.item.text))
        }
        if (looksLikeMatch(parsed)) return validateMatchShape(parsed)
      } catch (error) {
        lastError = error
      }
    }
  }

  throw new Error(
    `codex returned no parseable match JSON${lastError ? `: ${lastError.message}` : ''}`,
  )
}

function looksLikeMatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return 'merges' in value || 'completions' in value || 'overview' in value
}

export function validateMatchShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('match output must be a JSON object')
  }
  if (!Array.isArray(value.merges)) throw new Error('match output missing array field: merges')
  if (!Array.isArray(value.completions)) {
    throw new Error('match output missing array field: completions')
  }
  if (typeof value.overview !== 'string' || !value.overview.trim()) {
    throw new Error('match output missing non-empty string field: overview')
  }
  const merges = value.merges.map((entry, index) => {
    assertEntryObject(entry, `merges[${index}]`)
    return {
      candidateId: requireString(entry.candidateId, `merges[${index}].candidateId`),
      duplicateOf: requireString(entry.duplicateOf, `merges[${index}].duplicateOf`),
    }
  })
  const completions = value.completions.map((entry, index) => {
    assertEntryObject(entry, `completions[${index}]`)
    const confidence = requireString(entry.confidence, `completions[${index}].confidence`)
    if (!CONFIDENCE_LEVELS.has(confidence)) {
      throw new Error(`match output completions[${index}].confidence must be high|low, got: ${confidence}`)
    }
    return {
      candidateId: requireString(entry.candidateId, `completions[${index}].candidateId`),
      todoId: requireString(entry.todoId, `completions[${index}].todoId`),
      confidence,
    }
  })
  return { merges, completions, overview: value.overview.trim() }
}

function assertEntryObject(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`match output ${label} must be an object`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`match output missing non-empty string field: ${label}`)
  }
  return value.trim()
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function extractFirstJsonObject(text) {
  const source = String(text || '').trim()
  const start = source.indexOf('{')
  if (start === -1) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}
