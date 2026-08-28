import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type VcsKind = 'git' | 'none' | 'p4' | 'svn'
export type VcsChangeKind = 'added' | 'deleted' | 'modified' | 'unknown'

export interface VcsChange {
  kind: VcsChangeKind
  path: string
  status: string
}

export interface VcsSnapshot {
  changes: VcsChange[]
  kind: VcsKind
  label: string
  summary: string
}

const pexec = promisify(execFile)
const TIMEOUT_MS = 1_500

const run = async (file: string, args: string[], cwd: string): Promise<null | string> => {
  try {
    const { stdout } = await pexec(file, args, { cwd, timeout: TIMEOUT_MS, windowsHide: true })
    return stdout
  } catch {
    return null
  }
}

const changeSummary = (kind: VcsKind, changes: VcsChange[], label: string): VcsSnapshot => ({
  changes,
  kind,
  label,
  summary: changes.length ? `${changes.length} open change${changes.length === 1 ? '' : 's'}` : 'working copy clean'
})

export const parseGitStatus = (raw: string): VcsChange[] =>
  raw
    .split(/\r?\n/)
    .flatMap(line => {
      if (line.length < 4 || line.startsWith('##')) return []
      const code = line.slice(0, 2)
      const path = line.slice(3).split(' -> ').at(-1)?.trim() ?? ''
      if (!path) return []
      const kind: VcsChangeKind = code.includes('D') ? 'deleted' : code.includes('A') || code === '??' ? 'added' : 'modified'
      return [{ kind, path, status: code }]
    })

export const parseSvnStatus = (raw: string): VcsChange[] =>
  raw
    .split(/\r?\n/)
    .flatMap(line => {
      if (!line.trim()) return []
      const code = line[0] ?? ' '
      const path = line.slice(8).trim()
      if (!path || code === ' ') return []
      const kind: VcsChangeKind = code === 'D' ? 'deleted' : code === 'A' || code === '?' ? 'added' : 'modified'
      return [{ kind, path, status: code }]
    })

export const parseP4Opened = (raw: string): VcsChange[] =>
  raw
    .split(/\r?\n/)
    .flatMap(line => {
      const match = /^(.*?)#\d+\s+-\s+([^\s]+)/.exec(line.trim())
      if (!match) return []
      const action = match[2]!.toLowerCase()
      const kind: VcsChangeKind = action === 'delete' ? 'deleted' : action === 'add' || action === 'branch' ? 'added' : action === 'edit' ? 'modified' : 'unknown'
      return [{ kind, path: match[1]!, status: action }]
    })

/**
 * Capability-first VCS probe. Each backend retains its native status semantics,
 * and a missing executable/client is a normal `none` state rather than an error.
 */
export const inspectVcs = async (cwd: string): Promise<VcsSnapshot> => {
  const git = await run('git', ['status', '--porcelain=v1', '--branch'], cwd)
  if (git !== null) {
    const branch = git.split(/\r?\n/, 1)[0]?.match(/^##\s+([^\.\s]+)/)?.[1] ?? 'detached HEAD'
    return changeSummary('git', parseGitStatus(git), branch)
  }

  // `p4 opened` returns a non-zero exit code when nothing is open, so probe
  // the workspace independently before reading its optional open-file list.
  const p4Info = await run('p4', ['info'], cwd)
  if (p4Info !== null) {
    const opened = await run('p4', ['opened'], cwd)
    return changeSummary('p4', parseP4Opened(opened ?? ''), 'Perforce workspace')
  }

  const svn = await run('svn', ['status'], cwd)
  if (svn !== null) return changeSummary('svn', parseSvnStatus(svn), 'Subversion working copy')

  return { changes: [], kind: 'none', label: 'No supported VCS', summary: 'Git, Perforce, and Subversion were not detected' }
}
