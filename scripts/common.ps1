Set-StrictMode -Version Latest

function Assert-ProjectChildPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$CandidatePath,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $rootFull = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $candidateFull = [System.IO.Path]::GetFullPath($CandidatePath)
    $requiredPrefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidateFull.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside the application root: $candidateFull"
    }
    return $candidateFull
}

function Get-PrototypeReviewPaths {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$ScriptsRoot)

    $resolvedScripts = (Resolve-Path -LiteralPath $ScriptsRoot -ErrorAction Stop).Path
    $projectRoot = (Resolve-Path -LiteralPath (Join-Path $resolvedScripts '..') -ErrorAction Stop).Path
    $expectedScripts = Assert-ProjectChildPath -ProjectRoot $projectRoot -CandidatePath (Join-Path $projectRoot 'scripts') -Label 'Scripts directory'
    if (-not [string]::Equals($resolvedScripts.TrimEnd('\'), $expectedScripts.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Scripts must run from this application's scripts directory: $resolvedScripts"
    }

    $runtimeRoot = Assert-ProjectChildPath -ProjectRoot $projectRoot -CandidatePath (Join-Path $projectRoot 'runtime') -Label 'Runtime directory'
    $pidFile = Assert-ProjectChildPath -ProjectRoot $projectRoot -CandidatePath (Join-Path $runtimeRoot 'server.pid') -Label 'PID file'
    $stdoutLog = Assert-ProjectChildPath -ProjectRoot $projectRoot -CandidatePath (Join-Path $runtimeRoot 'server.stdout.log') -Label 'Standard output log'
    $stderrLog = Assert-ProjectChildPath -ProjectRoot $projectRoot -CandidatePath (Join-Path $runtimeRoot 'server.stderr.log') -Label 'Standard error log'
    $serverEntry = Assert-ProjectChildPath -ProjectRoot $projectRoot -CandidatePath (Join-Path $projectRoot 'server\index.mjs') -Label 'Server entry'
    $distIndex = Assert-ProjectChildPath -ProjectRoot $projectRoot -CandidatePath (Join-Path $projectRoot 'dist\index.html') -Label 'Production entry'

    if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
        throw "Server entry does not exist: $serverEntry"
    }
    if (Test-Path -LiteralPath $runtimeRoot) {
        $runtimeItem = Get-Item -LiteralPath $runtimeRoot -Force -ErrorAction Stop
        if (-not $runtimeItem.PSIsContainer) {
            throw "Runtime path is not a directory: $runtimeRoot"
        }
        if (($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to use a reparse-point runtime directory: $runtimeRoot"
        }
    }

    return [pscustomobject]@{
        ProjectRoot = $projectRoot
        RuntimeRoot = $runtimeRoot
        PidFile = $pidFile
        StdoutLog = $stdoutLog
        StderrLog = $stderrLog
        ServerEntry = $serverEntry
        DistIndex = $distIndex
    }
}

function Assert-OrdinaryPidFile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Paths)

    $expectedPidFile = Assert-ProjectChildPath -ProjectRoot $Paths.ProjectRoot -CandidatePath $Paths.PidFile -Label 'PID file'
    if (-not [string]::Equals($expectedPidFile, $Paths.PidFile, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'PID file path validation failed.'
    }
    if (Test-Path -LiteralPath $Paths.PidFile) {
        $item = Get-Item -LiteralPath $Paths.PidFile -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to read a reparse-point PID file: $($Paths.PidFile)"
        }
        if ($item.PSIsContainer) {
            throw "PID path is not a regular file: $($Paths.PidFile)"
        }
    }
}

function Read-ProjectServerPid {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Paths)

    Assert-OrdinaryPidFile -Paths $Paths
    if (-not (Test-Path -LiteralPath $Paths.PidFile -PathType Leaf)) { return $null }
    $raw = (Get-Content -LiteralPath $Paths.PidFile -Raw -Encoding ASCII).Trim()
    if ($raw -notmatch '^[1-9][0-9]{0,9}$') {
        throw "PID file content is invalid; no process was touched: $($Paths.PidFile)"
    }
    $serverProcessId = [int64]$raw
    if ($serverProcessId -gt [int]::MaxValue) {
        throw "PID is outside the valid range: $raw"
    }
    return [int]$serverProcessId
}

function Get-ValidatedProjectNodeProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)][int]$ServerProcessId
    )

    $processInfo = Get-Process -Id $ServerProcessId -ErrorAction SilentlyContinue
    if ($null -eq $processInfo) { return $null }

    if (-not [string]::Equals($processInfo.ProcessName, 'node', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "PID $ServerProcessId is not node.exe; refusing to operate on it."
    }

    try {
        $identity = Invoke-RestMethod -Uri 'http://127.0.0.1:3018/api/health' -Method Get -TimeoutSec 3 -ErrorAction Stop
    } catch {
        throw "PID $ServerProcessId could not prove ownership through the project health endpoint."
    }
    if ($identity.data.app -ne 'product-collaboration-platform' -or [int]$identity.data.pid -ne $ServerProcessId) {
        throw "PID $ServerProcessId does not match the project service identity; refusing to operate on it."
    }
    return $processInfo
}

function Remove-ProjectPidFile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Paths)

    Assert-OrdinaryPidFile -Paths $Paths
    if (Test-Path -LiteralPath $Paths.PidFile -PathType Leaf) {
        Remove-Item -LiteralPath $Paths.PidFile -Force
    }
}

function Test-PrototypeReviewHealth {
    [CmdletBinding()]
    param([int]$Port = 3018)

    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -Method Get -TimeoutSec 3 -ErrorAction Stop
        return $response.ok -eq $true -and $response.data.status -eq 'ok' -and $response.data.app -eq 'product-collaboration-platform'
    } catch {
        return $false
    }
}

function Start-PrototypeReviewServer {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ScriptsRoot,
        [Parameter(Mandatory = $true)][ValidateSet('127.0.0.1', '0.0.0.0')][string]$ListenAddress,
        [int]$Port = 3018
    )

    $paths = Get-PrototypeReviewPaths -ScriptsRoot $ScriptsRoot
    New-Item -ItemType Directory -Path $paths.RuntimeRoot -Force | Out-Null

    $existingProcessId = Read-ProjectServerPid -Paths $paths
    if ($null -ne $existingProcessId) {
        $existingProcess = Get-ValidatedProjectNodeProcess -Paths $paths -ServerProcessId $existingProcessId
        if ($null -ne $existingProcess) {
            Write-Host "Service is already running. PID: $existingProcessId"
            if (Test-PrototypeReviewHealth -Port $Port) {
                Write-Host "Health check passed: http://127.0.0.1:$Port/"
                return
            }
            throw 'The managed process is running but its health check failed. Inspect runtime/server.stderr.log.'
        }
        Remove-ProjectPidFile -Paths $paths
        Write-Warning 'Removed a stale PID file for a process that no longer exists.'
    }

    if (Test-PrototypeReviewHealth -Port $Port) {
        throw "Port $Port already responds as a healthy service, but no validated project PID file owns it. Refusing to start."
    }

    if (-not (Test-Path -LiteralPath $paths.DistIndex -PathType Leaf)) {
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($null -eq $npmCommand) { $npmCommand = Get-Command npm -ErrorAction Stop }
        Write-Host 'dist is missing; running npm run build...'
        Push-Location -LiteralPath $paths.ProjectRoot
        try {
            & $npmCommand.Source run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
        if (-not (Test-Path -LiteralPath $paths.DistIndex -PathType Leaf)) {
            throw "Production entry is still missing after build: $($paths.DistIndex)"
        }
    }

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }
    # Codex Desktop can expose both `Path` and `PATH`. Windows PowerShell 5.1
    # treats them as duplicate dictionary keys while creating a child process.
    $processEnvironment = [System.Environment]::GetEnvironmentVariables('Process')
    $processPathKeys = @($processEnvironment.Keys | Where-Object {
        [string]::Equals([string]$_, 'Path', [System.StringComparison]::OrdinalIgnoreCase)
    })
    $processPathValue = (@($processPathKeys | ForEach-Object { [string]$processEnvironment[$_] } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ';')
    if ([string]::IsNullOrWhiteSpace($processPathValue)) {
        $processPathValue = @(
            [System.Environment]::GetEnvironmentVariable('Path', 'Machine'),
            [System.Environment]::GetEnvironmentVariable('Path', 'User')
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        $processPathValue = $processPathValue -join ';'
    }
    if ($processPathKeys -contains 'Path' -and $processPathKeys -contains 'PATH') {
        [System.Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
    }
    if (-not [string]::IsNullOrWhiteSpace($processPathValue)) {
        [System.Environment]::SetEnvironmentVariable('Path', $processPathValue, 'Process')
    }
    $serverProcess = Start-Process -FilePath $nodeCommand.Source `
        -ArgumentList @("`"$($paths.ServerEntry)`"", '--host', $ListenAddress, '--port', [string]$Port) `
        -WorkingDirectory $paths.ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $paths.StdoutLog `
        -RedirectStandardError $paths.StderrLog `
        -PassThru

    Set-Content -LiteralPath $paths.PidFile -Value ([string]$serverProcess.Id) -Encoding ASCII -NoNewline
    $healthy = $false
    for ($attempt = 0; $attempt -lt 32; $attempt++) {
        if ($serverProcess.HasExited) { break }
        if (Test-PrototypeReviewHealth -Port $Port) {
            $healthy = $true
            break
        }
        Start-Sleep -Milliseconds 250
        $serverProcess.Refresh()
    }
    $serverProcess.Refresh()
    if ($healthy -and $serverProcess.HasExited) { $healthy = $false }
    if ($healthy) {
        $validatedProcess = Get-ValidatedProjectNodeProcess -Paths $paths -ServerProcessId $serverProcess.Id
        if ($null -eq $validatedProcess) { $healthy = $false }
    }
    if (-not $healthy) {
        if (-not $serverProcess.HasExited) {
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        }
        Remove-ProjectPidFile -Paths $paths
        throw "Server did not pass its health check. Inspect: $($paths.StderrLog)"
    }

    Write-Host "Server started. PID: $($serverProcess.Id)"
    Write-Host "Listening on: $ListenAddress`:$Port"
    Write-Host "Local URL: http://127.0.0.1:$Port/"
}
