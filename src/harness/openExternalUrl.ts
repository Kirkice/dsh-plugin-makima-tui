import { spawn, type SpawnOptions } from 'node:child_process'

export interface ExternalUrlLaunchCommand {
  args: string[]
  command: string
}

/**
 * Builds an argument-vector invocation for the operating system's default URL
 * handler. URLs are always passed as a distinct child-process argument; they
 * are never interpolated into a shell command.
 */
export function externalUrlLaunchCommand(url: string, platform: NodeJS.Platform = process.platform): ExternalUrlLaunchCommand {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs can be opened externally')
  }

  switch (platform) {
    case 'win32':
      // rundll32 invokes the registered FileProtocolHandler without cmd.exe,
      // avoiding shell parsing of OAuth query parameters such as "&".
      return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', parsed.toString()] }
    case 'darwin':
      return { command: 'open', args: [parsed.toString()] }
    default:
      return { command: 'xdg-open', args: [parsed.toString()] }
  }
}

export async function openExternalUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn
): Promise<void> {
  const { command, args } = externalUrlLaunchCommand(url, platform)
  const options: SpawnOptions = {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, options)
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
