import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { spawnSync } from 'node:child_process'

export type ImageMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'

export interface IngressImage {
  data: Uint8Array
  mediaType: ImageMediaType
  name: string
}

const mediaTypeOf = (data: Uint8Array, hint = ''): ImageMediaType | undefined => {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  )
    return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && String.fromCharCode(...data.slice(0, 6)) === 'GIF87a') return 'image/gif'
  if (data.length >= 6 && String.fromCharCode(...data.slice(0, 6)) === 'GIF89a') return 'image/gif'
  if (data.length >= 12 && String.fromCharCode(...data.slice(0, 4)) === 'RIFF' && String.fromCharCode(...data.slice(8, 12)) === 'WEBP')
    return 'image/webp'

  switch (extname(hint).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    default:
      return undefined
  }
}

export async function readImageFile(path: string): Promise<IngressImage> {
  const data = new Uint8Array(await readFile(path))
  const mediaType = mediaTypeOf(data, path)

  if (!mediaType) throw new Error('The selected file is not a supported PNG, JPEG, GIF, or WebP image')

  return { data, mediaType, name: basename(path) || 'image' }
}

/**
 * Windows screenshots live only in the native clipboard. PowerShell runs in an
 * STA process so Windows Forms can retrieve the bitmap, then encodes it as PNG
 * before returning base64 over stdout. No temporary image file is created.
 */
export function readWindowsClipboardImage(run = spawnSync, platform = process.platform): IngressImage | undefined {
  if (platform !== 'win32') return undefined

  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $image) { exit 3 }',
    '$stream = New-Object System.IO.MemoryStream',
    'try { $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray()) } finally { $stream.Dispose(); $image.Dispose() }'
  ].join('; ')
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })

  if (result.error) throw new Error(`Unable to access the Windows clipboard: ${result.error.message}`)
  if (result.status === 3) return undefined
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    throw new Error(`Unable to read an image from the Windows clipboard${detail ? `: ${detail}` : ''}`)
  }

  const raw = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  if (!raw) return undefined
  const data = new Uint8Array(Buffer.from(raw, 'base64'))
  if (!mediaTypeOf(data)) throw new Error('Windows clipboard returned an invalid image')

  return { data, mediaType: 'image/png', name: 'clipboard-screenshot.png' }
}
