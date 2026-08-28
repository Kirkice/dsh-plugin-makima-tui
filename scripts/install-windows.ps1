[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:MAKIMA_TUI_PROFILE) { $env:MAKIMA_TUI_PROFILE } else { 'makima-tui' }),
  [int]$SmokeSeconds = 12,
  [switch]$SkipBuild,
  [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dshHome = if ($env:DSH_HOME) {
  [System.IO.Path]::GetFullPath($env:DSH_HOME)
} else {
  Join-Path $HOME '.dsh'
}
$profileRoot = Join-Path $dshHome (Join-Path 'profiles' $Profile)
$profilePackage = Join-Path $profileRoot 'package.json'
$link = Join-Path $profileRoot (Join-Path 'node_modules' 'makima-tui')
$sourcePlugin = Join-Path $root (Join-Path 'dist' 'plugin.js')
$linkedPlugin = Join-Path $link (Join-Path 'dist' 'plugin.js')
$linkedPackage = Join-Path $link 'package.json'

function Invoke-Checked {
  param(
    [Parameter(Mandatory)] [string]$FilePath,
    [Parameter(Mandatory)] [string[]]$ArgumentList,
    [Parameter(Mandatory)] [string]$FailureMessage
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code $LASTEXITCODE)"
  }
}

function Test-SamePath {
  param(
    [Parameter(Mandatory)] [string]$Left,
    [Parameter(Mandatory)] [string]$Right
  )

  $leftPath = [System.IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
  $rightPath = [System.IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
  return [string]::Equals($leftPath, $rightPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Repair-ProfileManifest {
  if (-not (Test-Path -LiteralPath $profilePackage -PathType Leaf)) {
    throw "Profile manifest does not exist: $profilePackage"
  }
  if (-not (Test-Path -LiteralPath $linkedPackage -PathType Leaf)) {
    throw "Installed plugin manifest does not resolve: $linkedPackage"
  }

  $manifest = Get-Content -LiteralPath $profilePackage -Raw | ConvertFrom-Json
  $pluginManifest = Get-Content -LiteralPath $linkedPackage -Raw | ConvertFrom-Json
  if ($pluginManifest.name -ne 'makima-tui' -or -not $pluginManifest.dsh.bundle.patch) {
    throw "Installed package is not a dsh bundle: $linkedPackage"
  }
  if (-not $manifest.dependencies -or -not $manifest.dependencies.'makima-tui') {
    throw "Profile does not declare makima-tui as a dependency: $profilePackage"
  }
  if (-not $manifest.dsh) {
    $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $manifest.dsh.profile) {
    $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
  }

  # Match dsh's reconcileProfilePlugins semantics: activate a dependency only
  # after its installed package is proven to declare dsh.bundle.patch. Keep the
  # base bundle first for this dedicated TUI profile and preserve other layers.
  $bundles = @($manifest.dsh.profile.bundles)
  $requiredBundles = @('@deepseek-ai/dsh-base', 'makima-tui')
  $nextBundles = @($requiredBundles + $bundles | Select-Object -Unique)
  $changed = $nextBundles.Count -ne $bundles.Count
  if (-not $changed) {
    for ($index = 0; $index -lt $nextBundles.Count; $index++) {
      if ($nextBundles[$index] -ne $bundles[$index]) {
        $changed = $true
        break
      }
    }
  }

  if ($changed) {
    $manifest.dsh.profile.bundles = $nextBundles
    $json = $manifest | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($profilePackage, "$json`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host "==> reconciled profile bundles: $($nextBundles -join ', ')"
  } else {
    Write-Host "==> profile bundles verified: $($bundles -join ', ')"
  }
}

function Repair-ProfileJunction {
  $parent = Split-Path -Parent $link
  New-Item -ItemType Directory -Path $parent -Force | Out-Null

  $existing = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if ($existing) {
    $targets = @($existing.Target)
    if ($existing.LinkType -eq 'Junction' -and $targets.Count -eq 1 -and (Test-SamePath $targets[0] $root)) {
      Write-Host "==> profile junction already correct: $link -> $root"
      return
    }

    if (-not ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing to replace non-link path: $link"
    }

    Write-Host "==> replacing invalid profile link: $link"
    Remove-Item -LiteralPath $link -Force
  }

  New-Item -ItemType Junction -Path $link -Target $root | Out-Null

  $created = Get-Item -LiteralPath $link -Force
  $createdTargets = @($created.Target)
  if ($created.LinkType -ne 'Junction' -or $createdTargets.Count -ne 1 -or -not (Test-SamePath $createdTargets[0] $root)) {
    throw "Profile junction target verification failed: $link"
  }

  Write-Host "==> repaired profile junction: $link -> $root"
}

function Assert-InstalledPlugin {
  if (-not (Test-Path -LiteralPath $sourcePlugin -PathType Leaf)) {
    throw "Built plugin does not exist: $sourcePlugin"
  }
  if (-not (Test-Path -LiteralPath $linkedPlugin -PathType Leaf)) {
    throw "Profile plugin does not resolve through the junction: $linkedPlugin"
  }

  $sourceHash = (Get-FileHash -LiteralPath $sourcePlugin -Algorithm SHA256).Hash
  $linkedHash = (Get-FileHash -LiteralPath $linkedPlugin -Algorithm SHA256).Hash
  if ($sourceHash -ne $linkedHash) {
    throw "Profile plugin hash mismatch: source=$sourceHash linked=$linkedHash"
  }

  Write-Host "==> plugin hash verified: $sourceHash"
}

function Invoke-StartupSmoke {
  $dsh = (Get-Command 'dsh.cmd' -ErrorAction Stop).Source
  $temp = [System.IO.Path]::GetTempPath()
  $stdout = Join-Path $temp "makima-tui-smoke-$PID.out"
  $stderr = Join-Path $temp "makima-tui-smoke-$PID.err"
  $ready = Join-Path $temp "makima-tui-smoke-$PID.ready"
  $process = $null
  $previousAllowNoTty = $env:MAKIMA_TUI_ALLOW_NO_TTY
  $previousReadyFile = $env:MAKIMA_TUI_READY_FILE

  try {
    Remove-Item -LiteralPath $stdout, $stderr, $ready -Force -ErrorAction SilentlyContinue
    $env:MAKIMA_TUI_ALLOW_NO_TTY = '1'
    $env:MAKIMA_TUI_READY_FILE = $ready
    $process = Start-Process `
      -FilePath $dsh `
      -ArgumentList '--profile', $Profile `
      -WorkingDirectory $root `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds($SmokeSeconds)
    while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $ready)) {
      $process.Refresh()
      if ($process.HasExited) { break }
      Start-Sleep -Milliseconds 100
    }
    $process.Refresh()

    if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) {
      $outText = if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Raw } else { '' }
      $errText = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { '' }
      $state = if ($process.HasExited) { "exited with code $($process.ExitCode)" } else { 'remained alive without rendering' }
      throw "dsh startup smoke failed: makima-tui $state and never completed ink.render().`nstdout:`n$outText`nstderr:`n$errText"
    }

    Write-Host '==> startup smoke passed: makima-tui loaded and completed ink.render()'
  } finally {
    if ($process -and -not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    }
    if ($null -eq $previousAllowNoTty) { Remove-Item Env:MAKIMA_TUI_ALLOW_NO_TTY -ErrorAction SilentlyContinue } else { $env:MAKIMA_TUI_ALLOW_NO_TTY = $previousAllowNoTty }
    if ($null -eq $previousReadyFile) { Remove-Item Env:MAKIMA_TUI_READY_FILE -ErrorAction SilentlyContinue } else { $env:MAKIMA_TUI_READY_FILE = $previousReadyFile }
    Remove-Item -LiteralPath $stdout, $stderr, $ready -Force -ErrorAction SilentlyContinue
  }
}

if ($env:OS -ne 'Windows_NT') {
  throw 'This installer is Windows-only. Use ./install.sh on Unix-like systems.'
}
if (-not (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue)) {
  throw 'npm.cmd is required to build makima-tui.'
}
if (-not (Get-Command 'dsh.cmd' -ErrorAction SilentlyContinue)) {
  throw 'dsh.cmd is not on PATH. Install @deepseek-ai/dsh first.'
}

Push-Location $root
try {
  if (-not $SkipBuild) {
    Write-Host "==> installing project dependencies in $root"
    Invoke-Checked 'npm.cmd' @('install') 'npm install failed'
    Write-Host '==> building makima-tui'
    Invoke-Checked 'npm.cmd' @('run', 'build') 'makima-tui build failed'
  }

  if (-not (Test-Path -LiteralPath $profilePackage -PathType Leaf)) {
    Write-Host "==> creating dsh profile '$Profile'"
    Invoke-Checked 'dsh.cmd' @('plugin', '--profile', $Profile, 'add', $root) 'dsh profile installation failed'
  }

  # Repair the cross-drive link before reproducing dsh's bundle reconciliation;
  # bundle detection reads the installed package manifest through this path.
  Repair-ProfileJunction
  Repair-ProfileManifest
  Assert-InstalledPlugin

  if (-not $SkipSmoke) {
    Invoke-StartupSmoke
  }

  Write-Host ''
  Write-Host "done. launch with: dsh --profile $Profile"
} finally {
  Pop-Location
}
