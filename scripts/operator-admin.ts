#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import {pipeline} from 'stream/promises'
import axios from 'axios'
import readlineSync from 'readline-sync'
import {getArchiveFilenameForObserverUrl, isValidAdminProcessName} from '../observer/admin'
import {loadObserverUrlsFromRoot} from '../shared/utils/observerPeers'
import {resolveProjectRoot} from '../shared/utils/paths'

type AdminAction = 'collect-logs' | 'restart'
type ResultStatus = 'ok' | 'scheduled' | 'failed'

type Options = {
  action?: AdminAction
  target?: string
  name?: string
  yes?: boolean
  help?: boolean
}

type LogCollectionResult = {
  url: string
  filename: string
  status: ResultStatus
  sizeKb?: number
  durationMs: number
  error?: string
}

type RestartResult = {
  url: string
  requestedName: string
  resolvedName?: string
  status: ResultStatus
  durationMs: number
  error?: string
}

const LOG_FETCH_TIMEOUT_MS = 5 * 60 * 1000
const RESTART_TIMEOUT_MS = 10 * 1000

export class UsageError extends Error {}

function usage(exitCode = 1): never {
  const message = [
    'Usage: node dist/scripts/operator-admin.js [options]',
    '',
    'Options:',
    '  --action collect-logs|restart',
    '  --target all|<observer-url>',
    '  --name observer|tss-party',
    '  --yes',
    '  -h, --help',
  ].join('\n')
  const stream = exitCode === 0 ? console.log : console.error
  stream(message)
  process.exit(exitCode)
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]

    switch (arg) {
      case '--action':
        if (value !== 'collect-logs' && value !== 'restart') {
          throw new UsageError(`Invalid action: ${value}`)
        }
        options.action = value
        i += 1
        break
      case '--target':
        if (!value) throw new UsageError('--target requires a value')
        options.target = value
        i += 1
        break
      case '--name':
        if (!value) throw new UsageError('--name requires a value')
        options.name = value
        i += 1
        break
      case '--yes':
        options.yes = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new UsageError(`Unknown argument: ${arg}`)
    }
  }

  return options
}

export function validateOptionsForAction(options: Options, action: AdminAction): void {
  if (action !== 'restart' && options.name) {
    throw new UsageError('--name can only be used with --action restart')
  }
}

export function normalizeObserverUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl.trim()).href.replace(/\/$/, '')
  } catch {
    throw new Error(`Invalid observer URL: ${rawUrl}`)
  }
}

function loadAdminObserverUrls(projectRoot: string): string[] {
  return Array.from(new Set(loadObserverUrlsFromRoot(projectRoot).map(normalizeObserverUrl)))
}

export function resolveTargets(target: string, observerUrls: string[]): string[] {
  if (target === 'all') {
    if (observerUrls.length === 0) throw new Error('observer-list.json has no observer URLs')
    return observerUrls
  }

  const normalizedTarget = normalizeObserverUrl(target)
  if (!observerUrls.includes(normalizedTarget)) {
    throw new Error(`Target ${normalizedTarget} is not present in observer-list.json`)
  }
  return [normalizedTarget]
}

export function validateRestartName(name: string): string {
  const trimmed = name.trim()
  if (!isValidAdminProcessName(trimmed)) {
    throw new Error(`Invalid PM2 process name: ${name}`)
  }
  return trimmed
}

export function formatAdminTimestamp(date = new Date()): string {
  const pad = (value: number) => `${value}`.padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('-')
}

export function formatResultSummary(results: Array<{status: ResultStatus; url: string; error?: string}>): string {
  const total = results.length
  const success = results.filter((result) => result.status !== 'failed').length
  const failed = total - success
  const lines = [`success=${success}/${total} fail=${failed}/${total}`]
  for (const result of results) {
    if (result.status === 'failed') {
      lines.push(`failed ${result.url}: ${result.error ?? 'unknown error'}`)
    }
  }
  return lines.join('\n')
}

export function bytesToKb(bytes: number): number {
  return Math.round((bytes / 1024) * 100) / 100
}

export function formatHttpError(status: number, statusText: string | undefined, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  const statusLabel = statusText ? ` ${statusText}` : ''
  return payload ? `HTTP ${status}${statusLabel}: ${payload}` : `HTTP ${status}${statusLabel}`
}

function selectAction(options: Options): AdminAction {
  if (options.action) return options.action
  const choices: AdminAction[] = ['collect-logs', 'restart']
  console.log('Operator admin actions:')
  const selected = readlineSync.keyInSelect(choices, 'Select admin action:', {cancel: false})
  return choices[selected]
}

function selectTarget(options: Options, observerUrls: string[]): string {
  if (options.target) return options.target
  const choices = ['all', ...observerUrls]
  const selected = readlineSync.keyInSelect(choices, 'Select target:', {cancel: false})
  return choices[selected]
}

function selectRestartName(options: Options): string {
  if (options.name) return validateRestartName(options.name)
  const choices = ['observer', 'tss-party']
  const selected = readlineSync.keyInSelect(choices, 'Select PM2 process:', {cancel: false})
  return choices[selected]
}

function confirmProceed(action: AdminAction, targets: string[], name: string | undefined, yes: boolean | undefined): void {
  if (yes) return
  const detail = name ? `${action} ${name}` : action
  const ok = readlineSync.keyInYNStrict(`Proceed with ${detail} on ${targets.length} target(s)?`)
  if (!ok) {
    console.log('Aborted.')
    process.exit(0)
  }
}

async function downloadLogsArchive(observerUrl: string, outputPath: string): Promise<{size: number}> {
  let size = 0
  try {
    const response = await axios.get(`${observerUrl}/admin/logs/archive`, {
      responseType: 'stream',
      timeout: LOG_FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    })
    if (response.status < 200 || response.status >= 300) {
      response.data?.destroy?.()
      throw new Error(formatHttpError(response.status, response.statusText, response.data))
    }
    response.data.on('data', (chunk: Buffer) => {
      size += chunk.length
    })
    await pipeline(response.data, fs.createWriteStream(outputPath))
    return {size}
  } catch (error) {
    try {
      fs.unlinkSync(outputPath)
    } catch {}
    throw error
  }
}

async function postRestart(observerUrl: string, requestedName: string): Promise<{resolvedName?: string}> {
  const response = await axios.post(
    `${observerUrl}/admin/pm2/restart`,
    {name: requestedName},
    {
      timeout: RESTART_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    },
  )
  if (response.status < 200 || response.status >= 300) {
    throw new Error(formatHttpError(response.status, response.statusText, response.data))
  }
  return {resolvedName: response.data?.resolvedName}
}

async function collectLogs(projectRoot: string, targets: string[]): Promise<void> {
  const outputDir = path.join(projectRoot, 'collected-logs', formatAdminTimestamp())
  fs.mkdirSync(outputDir, {recursive: true})

  const results = await Promise.all(targets.map(async (url): Promise<LogCollectionResult> => {
    const filename = getArchiveFilenameForObserverUrl(url)
    const outputPath = path.join(outputDir, filename)
    const startedAt = Date.now()
    try {
      const {size} = await downloadLogsArchive(url, outputPath)
      return {url, filename, status: 'ok', sizeKb: bytesToKb(size), durationMs: Date.now() - startedAt}
    } catch (error) {
      return {
        url,
        filename,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))

  const manifestPath = path.join(outputDir, 'manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    action: 'collect-logs',
    createdAt: new Date().toISOString(),
    results,
  }, null, 2)}\n`)
  console.log(`manifest=${manifestPath}`)
  console.log(formatResultSummary(results))
}

async function restartTargets(projectRoot: string, targets: string[], requestedName: string): Promise<void> {
  const outputDir = path.join(projectRoot, 'admin-results')
  fs.mkdirSync(outputDir, {recursive: true})

  const results = await Promise.all(targets.map(async (url): Promise<RestartResult> => {
    const startedAt = Date.now()
    try {
      const {resolvedName} = await postRestart(url, requestedName)
      return {url, requestedName, resolvedName, status: 'scheduled', durationMs: Date.now() - startedAt}
    } catch (error) {
      return {
        url,
        requestedName,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))

  const manifestPath = path.join(outputDir, `restart-${formatAdminTimestamp()}.json`)
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    action: 'restart',
    createdAt: new Date().toISOString(),
    requestedName,
    results,
  }, null, 2)}\n`)
  console.log(`manifest=${manifestPath}`)
  console.log(formatResultSummary(results))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) usage(0)

  const projectRoot = resolveProjectRoot()
  const observerUrls = loadAdminObserverUrls(projectRoot)
  if (observerUrls.length === 0) {
    throw new Error('observer-list.json has no observer URLs')
  }

  const action = selectAction(options)
  validateOptionsForAction(options, action)
  const target = selectTarget(options, observerUrls)
  const targets = resolveTargets(target, observerUrls)
  const name = action === 'restart' ? selectRestartName(options) : undefined

  console.log('Resolved operator admin config:')
  console.log(`  action: ${action}`)
  console.log(`  targets: ${targets.join(', ')}`)
  if (name) console.log(`  name: ${name}`)

  confirmProceed(action, targets, name, options.yes)

  if (action === 'collect-logs') {
    await collectLogs(projectRoot, targets)
  } else {
    await restartTargets(projectRoot, targets, name as string)
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof UsageError) {
      console.error(error.message)
      usage()
    }
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
