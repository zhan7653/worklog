import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'

export function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function stableId(project, text) {
  return crypto.createHash('sha1').update(`${project || ''}\n${normalizeText(text)}`).digest('hex').slice(0, 16)
}

export function eventId(ts, text) {
  return crypto.createHash('sha1').update(`${ts}\n${text}`).digest('hex').slice(0, 12)
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sortValue(value[key])]),
    )
  }
  return value
}

export function isoNow(now = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

export async function readRequiredJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Required JSON file is missing or invalid: ${filePath}: ${error.message}`)
  }
}

export async function readJsonl(filePath) {
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return { rows: [], badLines: 0 }
  }
  const rows = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { rows, badLines }
}

export async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

export async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  // pid 之外再加随机后缀:同进程并发写同一目标时临时名不碰撞
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const handle = await fs.open(tempPath, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tempPath, filePath)
}

const REDACT_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
]

const REDACT_KEYED = /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)(\s*[=:]\s*)\S+/gi
const REDACT_BEARER = /\b(Bearer\s+)[A-Za-z0-9._-]{16,}\b/gi

export function redactText(value) {
  let text = String(value ?? '')
  text = text.replace(REDACT_BEARER, '$1[REDACTED]')
  text = text.replace(REDACT_KEYED, '$1$2[REDACTED]')
  for (const pattern of REDACT_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]')
  }
  return text
}

export function unique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort()
}
