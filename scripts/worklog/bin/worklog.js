#!/usr/bin/env node

import { promises as fs } from 'node:fs'
import { assembleDay, confirmDay } from '../lib/assemble.js'
import { assertValidDate } from '../lib/paths.js'

const COMMANDS = {
  assemble: assembleCommand,
  confirm: confirmCommand,
  commit: commitCommand,
  render: renderCommand,
  rebuild: rebuildCommand,
  'import-v1': importV1Command,
}

export async function runCli(argv) {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }
  const handler = COMMANDS[command]
  if (!handler) throw new Error(`Unknown command "${command}".`)
  await handler(rest)
}

async function assembleCommand(args) {
  const options = parseArgs(args, { known: ['date', 'timezone', 'lookbackDays', 'wlHome'], flags: ['llm'] })
  const date = requiredOption(options, 'date')
  assertValidDate(date)
  const result = await assembleDay({
    wlHome: options.wlHome,
    date,
    timezone: options.timezone,
    lookbackDays: parseLookbackDays(options.lookbackDays),
    useLlm: Boolean(options.llm),
  })
  printResult({ path: result.path, date })
}

async function confirmCommand(args) {
  const options = parseArgs(args, { known: ['date', 'patch', 'wlHome'] })
  const date = requiredOption(options, 'date')
  assertValidDate(date)
  const patchSource = requiredOption(options, 'patch')
  const raw = patchSource === '-' ? await readStdin() : await fs.readFile(patchSource, 'utf8')
  let patch
  try {
    patch = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid patch JSON from ${patchSource === '-' ? 'stdin' : patchSource}: ${error.message}`)
  }
  const result = await confirmDay({ wlHome: options.wlHome, date, patch })
  printResult({ path: result.path, date })
}

async function commitCommand(args) {
  const options = parseArgs(args, { known: ['date', 'wlHome'] })
  const date = requiredOption(options, 'date')
  assertValidDate(date)
  const { commitDay } = await import('../lib/commit.js')
  const result = await commitDay({ wlHome: options.wlHome, date })
  printResult(result)
}

async function renderCommand(args) {
  const options = parseArgs(args, { known: ['date', 'range', 'wlHome'], flags: ['html', 'all'] })
  if (options.date !== undefined) assertValidDate(options.date)
  const modes = ['date', 'all', 'range'].filter(key => options[key] !== undefined)
  if (modes.length !== 1) {
    throw new Error('render requires exactly one of --date YYYY-MM-DD, --all, --range YYYY-MM.')
  }
  let range = null
  if (options.range !== undefined) {
    if (options.html) throw new Error('--html is not supported with --range.')
    range = monthRange(options.range)
  }
  const render = await import('../lib/render.js')
  if (options.date !== undefined) {
    const result = await render.renderDay({
      wlHome: options.wlHome,
      date: options.date,
      html: Boolean(options.html),
    })
    printResult(result)
    return
  }
  if (options.all) {
    const result = await render.renderAll({ wlHome: options.wlHome, html: Boolean(options.html) })
    printResult(result)
    return
  }
  const result = await render.renderPeriod({ wlHome: options.wlHome, start: range.start, end: range.end })
  printResult(result)
}

async function rebuildCommand(args) {
  const options = parseArgs(args, { known: ['wlHome'] })
  const { rebuildLedger } = await import('../lib/commit.js')
  const result = await rebuildLedger({ wlHome: options.wlHome })
  printResult(result)
}

async function importV1Command(args) {
  const options = parseArgs(args, { known: ['memory', 'wlHome'] })
  const memoryPath = requiredOption(options, 'memory')
  const { importV1 } = await import('../lib/commit.js')
  const result = await importV1({ wlHome: options.wlHome, memoryPath })
  printResult(result)
}

function parseArgs(args, { known = [], flags = [] } = {}) {
  const options = {}
  const knownSet = new Set([...known, ...flags])
  const flagSet = new Set(flags)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}".`)
    const key = toCamel(arg.slice(2))
    if (!knownSet.has(key)) throw new Error(`Unknown option ${arg}.`)
    if (flagSet.has(key)) {
      options[key] = true
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`)
    options[key] = value
    index += 1
  }
  return options
}

function requiredOption(options, key) {
  if (options[key] === undefined) throw new Error(`Missing required --${toKebab(key)} option.`)
  return options[key]
}

function parseLookbackDays(value) {
  if (value === undefined) return 30
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid --lookback-days "${value}". Expected a non-negative integer.`)
  }
  return number
}

function monthRange(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''))
  if (!match) throw new Error(`Invalid --range "${value}". Expected YYYY-MM.`)
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) {
    throw new Error(`Invalid --range "${value}". Expected a real calendar month.`)
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    start: `${match[1]}-${match[2]}-01`,
    end: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`,
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function printResult(value) {
  console.log(JSON.stringify(value))
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function toKebab(value) {
  return value.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
}

function printHelp() {
  console.log(`worklog (cold path)

Usage:
  worklog assemble --date YYYY-MM-DD [--timezone TZ] [--lookback-days N] [--llm] [--wl-home DIR]
  worklog confirm --date YYYY-MM-DD --patch <file|-> [--wl-home DIR]
  worklog commit --date YYYY-MM-DD [--wl-home DIR]
  worklog render --date YYYY-MM-DD [--html] [--wl-home DIR]
  worklog render --all [--html] [--wl-home DIR]
  worklog render --range YYYY-MM [--wl-home DIR]
  worklog rebuild [--wl-home DIR]
  worklog import-v1 --memory PATH [--wl-home DIR]

One-line JSON result on stdout; errors on stderr with exit code 1.`)
}

runCli(process.argv.slice(2)).catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`worklog: ${message}`)
  process.exitCode = 1
})
