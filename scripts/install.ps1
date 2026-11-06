#Requires -Version 5.1
<#
.SYNOPSIS
Installs or removes both local Vivaldi UI mods. No downloads or profile edits.
.EXAMPLE
.\scripts\install.ps1 -WhatIf
.EXAMPLE
.\scripts\install.ps1 -VivaldiPath 'D:\Apps\Vivaldi\Application\vivaldi.exe'
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Position = 0)]
    [string]$VivaldiPath,
    [ValidateSet('Install', 'Uninstall')]
    [string]$Action = 'Install',
    [switch]$Pause
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Retain the constellation installer's identity to upgrade existing installs
# in place, without a second canvas, duplicate script tags, or orphaned assets.
$startMarker = '<!-- vivaldi-constellation:start -->'
$endMarker = '<!-- vivaldi-constellation:end -->'
$folder = 'vivaldi-constellation'
$owner = "VivaldiTweaks:signal-constellation`n"
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$sources = [ordered]@{
    'constellation.css' = 'constellation\constellation.css'
    'address-bar-below-tabs.css' = 'mods\address-bar-below-tabs.css'
    'constellation-engine.js' = 'constellation\constellation-engine.js'
    'constellation.js' = 'constellation\constellation.js'
}

function Assert-PlainPath([string]$Path) {
    # Check ancestors too: a normal-looking file inside a junction is redirected.
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a symbolic link, junction, or reparse point: $current"
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Assert-RegularFile([string]$Path) {
    Assert-PlainPath $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file not found (or is a directory): $Path"
    }
}

function Get-WindowFromExecutable([string]$Executable) {
    Assert-RegularFile $Executable
    $version = (Get-Item -LiteralPath $Executable).VersionInfo.ProductVersion
    if ($version -notmatch '^(\d+\.\d+\.\d+\.\d+)(?:\D|$)') {
        throw "Cannot read the Vivaldi version from $Executable. Supply the exact window.html path instead."
    }
    # Do not pick the newest directory: it may belong to a staged update rather
    # than the executable the user actually starts.
    $window = Join-Path (Split-Path -Parent $Executable) "$($Matches[1])\resources\vivaldi\window.html"
    Assert-RegularFile $window
    return [IO.Path]::GetFullPath($window)
}

function Resolve-WindowFile([string]$Requested) {
    if ($Requested) {
        $full = [IO.Path]::GetFullPath($Requested)
        if ([IO.Path]::GetFileName($full) -ieq 'window.html') {
            Assert-RegularFile $full
            return $full
        }
        if ([IO.Path]::GetFileName($full) -ieq 'vivaldi.exe') {
            return Get-WindowFromExecutable $full
        }
        if (Test-Path -LiteralPath $full -PathType Container) {
            foreach ($relative in @('window.html', 'resources\vivaldi\window.html')) {
                $candidate = Join-Path $full $relative
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    Assert-RegularFile $candidate
                    return $candidate
                }
            }
            foreach ($relative in @('vivaldi.exe', 'Application\vivaldi.exe')) {
                $candidate = Join-Path $full $relative
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    return Get-WindowFromExecutable $candidate
                }
            }
        }
        throw "No Vivaldi installation found at $Requested. Supply vivaldi.exe, its installation folder, or window.html."
    }

    $executables = @(
        foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if (-not $root) { continue }
            foreach ($name in @('Vivaldi', 'Vivaldi Snapshot')) {
                $candidate = Join-Path $root "$name\Application\vivaldi.exe"
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate }
            }
        }
    ) | Select-Object -Unique
    $executables = @($executables)
    if ($executables.Count -eq 0) {
        throw 'Vivaldi was not found in the standard Windows locations. Run install.cmd "D:\path\to\Vivaldi\Application\vivaldi.exe" (or uninstall.cmd for removal).'
    }
    if ($executables.Count -ne 1) {
        throw ("Multiple Vivaldi installations found. Supply the one to modify as an argument:`n" + ($executables -join "`n"))
    }
    return Get-WindowFromExecutable $executables[0]
}

function Assert-VivaldiClosed([string]$WindowFile) {
    $ui = Split-Path -Parent $WindowFile
    $resources = Split-Path -Parent $ui
    # Standard Windows layout: Application\<version>\resources\vivaldi.
    $application = $ui
    if ((Split-Path -Leaf $resources) -ieq 'resources') {
        $application = Split-Path -Parent (Split-Path -Parent $resources)
    }
    $prefix = $application.TrimEnd('\') + '\'
    foreach ($process in @(Get-Process -Name vivaldi -ErrorAction SilentlyContinue)) {
        $executable = $process.Path
        if (-not $executable) {
            throw 'Cannot verify a running Vivaldi process. Quit all Vivaldi processes before installing or removing mods.'
        }
        if ($executable.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Vivaldi is still running from $application. Quit it completely, including background processes, then try again. No processes were stopped."
        }
    }
}

function Test-BytesEqual([byte[]]$Left, [byte[]]$Right) {
    if ($null -eq $Left -or $null -eq $Right) {
        return ($null -eq $Left -and $null -eq $Right)
    }
    return [Convert]::ToBase64String($Left) -ceq [Convert]::ToBase64String($Right)
}

function Write-AtomicFile([string]$Path, [byte[]]$Bytes) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($Bytes, 0, $Bytes.Length) } finally { $stream.Dispose() }
        if ([IO.File]::Exists($Path)) {
            # PS5.1 coerces $null to an empty string for this .NET string
            # parameter; NullString means no replacement backup, as intended.
            [IO.File]::Replace($temporary, $Path, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $Path)
        }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Update-Mods([string]$WindowFile) {
    $ui = Split-Path -Parent $WindowFile
    $target = Join-Path $ui $folder
    $backup = "$WindowFile.tweaks-backup"
    Assert-PlainPath $target
    Assert-PlainPath $backup
    if (Test-Path -LiteralPath $backup) { Assert-RegularFile $backup }
    $originalBytes = [IO.File]::ReadAllBytes($WindowFile)
    $reader = [IO.StreamReader]::new($WindowFile, $utf8, $true)
    try {
        $html = $reader.ReadToEnd()
        $encoding = $reader.CurrentEncoding
    } finally { $reader.Dispose() }
    $bodyOpen = [regex]::Matches($html, '(?i)<body(?:\s[^>]*)?>')
    $bodyClose = [regex]::Matches($html, '(?i)</body\s*>')
    if ($bodyOpen.Count -ne 1 -or $bodyClose.Count -ne 1 -or $bodyClose[0].Index -lt $bodyOpen[0].Index) {
        throw 'Expected exactly one HTML body in window.html; nothing was changed.'
    }
    $starts = [regex]::Matches($html, [regex]::Escape($startMarker))
    $ends = [regex]::Matches($html, [regex]::Escape($endMarker))
    $hasBlock = $starts.Count -ne 0 -or $ends.Count -ne 0
    if ($hasBlock -and ($starts.Count -ne 1 -or $ends.Count -ne 1)) {
        throw 'Malformed or duplicate Constellation markers; nothing was changed.'
    }
    if ($hasBlock -and ($ends[0].Index -lt $starts[0].Index -or
        $starts[0].Index -lt $bodyOpen[0].Index -or $ends[0].Index -gt $bodyClose[0].Index)) {
        throw 'Malformed Constellation markers outside the body or in reverse order; nothing was changed.'
    }
    if (-not $hasBlock -and $html.Contains("$folder/")) {
        throw 'Unmarked Constellation references found. Remove or mark the old loader before installing; nothing was changed.'
    }

    $targetExists = Test-Path -LiteralPath $target
    if ($targetExists) {
        if (-not (Test-Path -LiteralPath $target -PathType Container)) {
            throw "The destination is not an owned directory: $target"
        }
        $ownerPath = Join-Path $target '.owner'
        Assert-RegularFile $ownerPath
        if ([IO.File]::ReadAllText($ownerPath).Replace("`r`n", "`n") -cne $owner) {
            throw "The destination is not owned by this installer: $target"
        }
    }

    $desired = [ordered]@{}
    foreach ($asset in $sources.Keys) {
        $desired[$asset] = $null
        if ($Action -eq 'Install') {
            $source = Join-Path (Split-Path -Parent $PSScriptRoot) $sources[$asset]
            Assert-RegularFile $source
            $desired[$asset] = [IO.File]::ReadAllBytes($source)
        }
    }
    $unknown = @()
    if ($targetExists) {
        $unknown = @(Get-ChildItem -LiteralPath $target -Force | Where-Object {
            $_.Name -ne '.owner' -and -not $sources.Contains($_.Name)
        })
    }
    $desired['.owner'] = $null
    if ($Action -eq 'Install' -or $unknown.Count -gt 0) {
        $desired['.owner'] = $utf8.GetBytes($owner)
    }
    # Snapshot only our own files. Unknown files/directories are never traversed,
    # copied, overwritten, or recursively deleted.
    $previous = @{}
    foreach ($asset in $desired.Keys) {
        $filename = Join-Path $target $asset
        Assert-PlainPath $filename
        $previous[$asset] = $null
        if (Test-Path -LiteralPath $filename) {
            Assert-RegularFile $filename
            $previous[$asset] = [IO.File]::ReadAllBytes($filename)
        }
    }

    $next = $html
    if ($Action -eq 'Install') {
        $newline = "`n"
        if ($html.Contains("`r`n")) { $newline = "`r`n" }
        $snippet = @(
            $startMarker
            "<link rel=`"stylesheet`" href=`"$folder/constellation.css`">"
            "<link rel=`"stylesheet`" href=`"$folder/address-bar-below-tabs.css`">"
            "<script src=`"$folder/constellation-engine.js`"></script>"
            "<script src=`"$folder/constellation.js`"></script>"
            $endMarker
        ) -join $newline
        if ($hasBlock) {
            $last = $ends[0].Index + $endMarker.Length
            $next = $html.Substring(0, $starts[0].Index) + $snippet + $html.Substring($last)
        } else {
            $next = $html.Insert($bodyClose[0].Index, $snippet + $newline)
        }
    } elseif ($hasBlock) {
        $last = $ends[0].Index + $endMarker.Length
        $after = $html.Substring($last) -replace '\A\r?\n', ''
        $next = $html.Substring(0, $starts[0].Index) + $after
    }

    Write-Host "Target: $WindowFile"
    if (-not $PSCmdlet.ShouldProcess($WindowFile, "$Action constellation background and address-bar-below-tabs fix")) {
        return
    }
    Assert-VivaldiClosed $WindowFile
    # CreateNew + DeleteOnClose prevents concurrent runs without a stale lock
    # after a crash. Never open/delete a pre-existing file at the lock path.
    $lockPath = "$WindowFile.tweaks-lock"
    Assert-PlainPath $lockPath
    $lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
    try {
        if (-not (Test-BytesEqual $originalBytes ([IO.File]::ReadAllBytes($WindowFile)))) {
            throw 'window.html changed during preflight. Retry after other installers or edits finish.'
        }
        if ($Action -eq 'Install' -and -not [IO.File]::Exists($backup)) {
            [IO.File]::Copy($WindowFile, $backup, $false)
        }
        $createdTarget = $false
        $changed = [Collections.Generic.List[string]]::new()
        try {
            if ($Action -eq 'Install' -and -not $targetExists) {
                [void][IO.Directory]::CreateDirectory($target)
                $createdTarget = $true
            }
            foreach ($asset in $desired.Keys) {
                if (Test-BytesEqual $previous[$asset] $desired[$asset]) { continue }
                $filename = Join-Path $target $asset
                if ($null -eq $desired[$asset]) {
                    [IO.File]::Delete($filename)
                } else {
                    Write-AtomicFile $filename $desired[$asset]
                }
                $changed.Add($asset)
            }
            # Publish the loader last. On any failure before this commit, put
            # the old assets back, leaving the original HTML usable.
            if ($next -cne $html) {
                if (-not (Test-BytesEqual $originalBytes ([IO.File]::ReadAllBytes($WindowFile)))) {
                    throw 'window.html changed during installation; refusing to overwrite another edit.'
                }
                [byte[]]$nextBytes = $encoding.GetPreamble() + $encoding.GetBytes($next)
                Write-AtomicFile $WindowFile $nextBytes
            }
        } catch {
            for ($index = $changed.Count - 1; $index -ge 0; $index--) {
                $asset = $changed[$index]
                $filename = Join-Path $target $asset
                try {
                    if ($null -eq $previous[$asset]) { [IO.File]::Delete($filename) }
                    else { Write-AtomicFile $filename $previous[$asset] }
                } catch {
                    Write-Warning "Could not roll back $filename. Retain the backup and repair this installation before starting Vivaldi: $_"
                }
            }
            if ($createdTarget -and [IO.Directory]::Exists($target) -and
                [IO.Directory]::GetFileSystemEntries($target).Length -eq 0) {
                [IO.Directory]::Delete($target)
            }
            throw
        }
        if ($Action -eq 'Uninstall' -and [IO.Directory]::Exists($target) -and
            [IO.Directory]::GetFileSystemEntries($target).Length -eq 0) {
            [IO.Directory]::Delete($target)
        }
    } finally { $lock.Dispose() }
    if ($Action -eq 'Install') {
        Write-Host "Installed BOTH mods. Backup: $backup"
        Write-Host 'Start Vivaldi. Re-run install.cmd after each Vivaldi update.'
        Write-Host 'For the address-bar fix: put both bars at the top; enable Address Bar auto-hide and leave Tab Bar auto-hide unchecked.'
        Write-Host 'For constellation: use a dark theme; disable Use Native Window to animate the title bar.'
    } else {
        Write-Host 'Removed BOTH mods. Other mods, unknown files, and backups were preserved. Start Vivaldi.'
    }
}

$exitCode = 0
try {
    $windowFile = Resolve-WindowFile $VivaldiPath
    Update-Mods $windowFile
} catch {
    [Console]::Error.WriteLine("VivaldiTweaks: $($_.Exception.Message)")
    [Console]::Error.WriteLine('For access-denied errors on an all-users install, right-click the launcher and choose Run as administrator.')
    $exitCode = 1
} finally {
    if ($Pause) {
        # Read-Host hides its own prompt when stdin is redirected. Emit it
        # explicitly so launcher logs and interactive windows say the same thing.
        Write-Host 'Press Enter to close'
        [void](Read-Host)
    }
}
exit $exitCode
