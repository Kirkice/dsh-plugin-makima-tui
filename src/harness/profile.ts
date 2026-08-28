export interface ResolveProfileOptions {
  argv?: readonly string[]
  configured?: string
  env?: NodeJS.ProcessEnv
  fallback?: string
}

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * Resolve the profile managed by Makima without assuming a fixed profile name.
 * A bundle configuration is an intentional override; otherwise retain the
 * profile passed to `dsh --profile`, then honour the legacy environment hook.
 */
export function resolveManagedProfile({
  argv = process.argv,
  configured,
  env = process.env,
  fallback = 'makima'
}: ResolveProfileOptions = {}): string {
  const configuredProfile = nonEmpty(configured)
  if (configuredProfile) return configuredProfile

  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index] ?? ''
    if (argument.startsWith('--profile=')) {
      const profile = nonEmpty(argument.slice('--profile='.length))
      if (profile) return profile
      continue
    }

    if (argument === '--profile') {
      const profile = nonEmpty(argv[index + 1])
      if (profile) return profile
    }
  }

  return nonEmpty(env.MAKIMA_TUI_PROFILE) ?? fallback
}
