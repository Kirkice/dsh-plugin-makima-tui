/** Profile plugin inspection and mutation shared by CLI and Host management APIs. */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_PROFILE_BUNDLES,
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type ProfileManifest
} from './profile.ts'

const NAME = 'dsh'

/** One dependency visible to a profile plugin manager. */
export interface ProfilePluginEntry {
  readonly packageName: string
  readonly specifier: string
  readonly dependency: boolean
  readonly bundle: boolean
  readonly builtIn: boolean
}

/** Point-in-time profile dependency and bundle state. */
export interface ProfilePluginSnapshot {
  readonly profile: string
  readonly entries: readonly ProfilePluginEntry[]
}

/** Result of a profile plugin install or removal. */
export interface ProfilePluginMutationResult {
  readonly profile: string
  readonly packageName: string | null
  readonly operation: 'install' | 'remove'
  readonly restartRequired: true
  readonly warnings: readonly string[]
}

function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  return `${match.groups.prefix ?? ''}${join(cwd, match.groups.path)}`
}

function bundleExists(packageName: string, profileDir: string, installAnchor = join(profileDir, 'package.json')): boolean {
  try {
    const dir = resolveBundleDir(NAME, packageName, installAnchor, profileDir)
    return readProfileManifest(NAME, dir).dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/** Read the dependency and bundle state persisted for one profile. */
export function listProfilePlugins(profile: string, home?: string): ProfilePluginSnapshot {
  const profileDir = resolveProfileDir(profile, home)
  const manifest = readProfileManifest(NAME, profileDir)
  const dependencies = manifest.dependencies ?? {}
  const builtIns = new Set(PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  const entries = Object.entries(dependencies).map(([packageName, specifier]) => ({
    packageName,
    specifier,
    dependency: true,
    bundle: bundles.has(packageName) || bundleExists(packageName, profileDir),
    builtIn: builtIns.has(packageName)
  }))
  for (const packageName of bundles) {
    if (!entries.some((entry) => entry.packageName === packageName)) {
      entries.unshift({ packageName, specifier: 'built-in', dependency: false, bundle: true, builtIn: builtIns.has(packageName) })
    }
  }
  return { profile, entries }
}

/** Run pnpm for a profile and synchronize its bundle list after success. */
export interface ProfilePluginMutationOptions {
  readonly home?: string
  readonly cwd?: string
  readonly output?: 'inherit' | 'capture'
}

export function mutateProfilePlugins(
  profile: string,
  operation: 'install' | 'remove',
  args: readonly string[],
  options: ProfilePluginMutationOptions | string = {}
): ProfilePluginMutationResult {
  const resolvedOptions: ProfilePluginMutationOptions = typeof options === 'string' ? { home: options } : options
  const profileDir = resolveProfileDir(profile, resolvedOptions.home)
  if (!existsSync(join(profileDir, 'package.json'))) {
    initProfile(profileDir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
  }
  const before = readProfileManifest(NAME, profileDir)
  if (args.some((argument) => argument.startsWith('-'))) {
    throw new Error('dsh: structured plugin management does not accept pnpm options')
  }
  const result = spawnSync(
    'pnpm',
    args.map((argument) => anchorPathSpec(argument, resolvedOptions.cwd ?? process.cwd())),
    {
      cwd: profileDir,
      stdio: resolvedOptions.output === 'inherit' ? 'inherit' : 'pipe',
      encoding: resolvedOptions.output === 'inherit' ? undefined : 'utf8',
      shell: process.platform === 'win32'
    }
  )
  if (result.error !== undefined) throw result.error
  if ((result.status ?? 1) !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(`dsh: pnpm ${operation} failed${detail === '' ? '' : `: ${detail}`}`)
  }
  reconcileProfilePlugins(before, profileDir)
  const packageName = operation === 'remove' ? (args.at(-1) ?? null) : null
  return { profile, packageName, operation, restartRequired: true, warnings: [] }
}

function reconcileProfilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest(NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.profile?.bundles ?? []
  let changed = false
  for (const packageName of dependencies) {
    if (bundleExists(packageName, profileDir) && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    const managed = beforeDeps.has(packageName) || dependencySet.has(packageName)
    if (managed && (!dependencySet.has(packageName) || !bundleExists(packageName, profileDir))) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (changed) {
    writeProfileManifest(profileDir, { ...after, dsh: { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } } })
  }
}

/** Validate a package name before a structured removal request reaches pnpm. */
export function assertRemovableProfilePlugin(profile: string, packageName: string, home?: string): void {
  const entry = listProfilePlugins(profile, home).entries.find((item) => item.packageName === packageName)
  if (entry?.builtIn === true) throw new Error(`dsh: cannot remove built-in bundle ${JSON.stringify(packageName)}`)
  if (entry === undefined) throw new Error(`dsh: profile ${JSON.stringify(profile)} has no plugin ${JSON.stringify(packageName)}`)
}
