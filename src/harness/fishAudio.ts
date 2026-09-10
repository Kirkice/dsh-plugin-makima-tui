import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_BASE_URL = 'https://api.fish.audio'
const MAX_TTS_CHARS = 12_000

const speechText = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!?(?:\[[^\]]*\])\([^)]*\)/g, '$1')
    .replace(/[#>*_|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TTS_CHARS)

/** Synthesize through Fish Audio and play the resulting WAV on Windows. */
export interface FishAudioProfile {
  apiKey: string
  id: string
  name: string
  referenceId: string
}

export async function speakWithFishAudio(rawText: string, profile?: Pick<FishAudioProfile, 'apiKey' | 'referenceId'>): Promise<{ chars: number }> {
  const apiKey = profile?.apiKey?.trim() || process.env.MAKIMA_FISH_AUDIO_KEY?.trim()
  const referenceId = profile?.referenceId?.trim() || process.env.MAKIMA_FISH_AUDIO_REFERENCE_ID?.trim()

  if (!apiKey || !referenceId) {
    throw new Error('Fish Audio is not configured: set MAKIMA_FISH_AUDIO_KEY and MAKIMA_FISH_AUDIO_REFERENCE_ID')
  }

  const text = speechText(rawText)
  if (!text) throw new Error('there is no speakable assistant text')

  const baseUrl = (process.env.MAKIMA_FISH_AUDIO_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/v1/tts`, {
    body: JSON.stringify({ format: 'wav', latency: 'normal', normalize: true, reference_id: referenceId, text }),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(90_000)
  })

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Fish Audio TTS failed (${response.status}): ${detail || response.statusText}`)
  }

  const audio = Buffer.from(await response.arrayBuffer())
  if (!audio.length) throw new Error('Fish Audio returned empty audio')

  const dir = join(tmpdir(), 'makima-tui-tts')
  const file = join(dir, `${randomUUID()}.wav`)
  await mkdir(dir, { recursive: true })
  await writeFile(file, audio)

  try {
    // Use the WinMM MCI waveaudio driver directly. `SoundPlayer` can silently
    // complete for WAV variants it cannot render, while WMPlayer's COM state
    // is unreliable in a hidden non-interactive PowerShell process. MCI's
    // `play ... wait` blocks until the default Windows audio device finishes.
    // The path travels as a single-quoted PowerShell literal. `-Command` does
    // not reliably bind trailing argv on Windows PowerShell.
    const psPath = file.replace(/'/g, "''")
    const mci = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MakimaMci {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
  public static extern int mciSendString(string command, IntPtr buffer, int bufferSize, IntPtr callback);
}
'@; $alias = 'makima_tts'; $path = '${psPath}'; $open = [MakimaMci]::mciSendString(('open "' + $path + '" type waveaudio alias ' + $alias), [IntPtr]::Zero, 0, [IntPtr]::Zero); if ($open -ne 0) { throw ('Cannot open synthesized WAV (MCI error ' + $open + ').') }; try { $play = [MakimaMci]::mciSendString(('play ' + $alias + ' wait'), [IntPtr]::Zero, 0, [IntPtr]::Zero); if ($play -ne 0) { throw ('Cannot play synthesized WAV (MCI error ' + $play + ').') } } finally { [void][MakimaMci]::mciSendString(('close ' + $alias), [IntPtr]::Zero, 0, [IntPtr]::Zero) }`
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      mci
    ], { windowsHide: true })
  } finally {
    await rm(file, { force: true }).catch(() => undefined)
  }

  return { chars: text.length }
}
