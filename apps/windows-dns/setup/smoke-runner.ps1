# Disposable Windows runner only. DO NOT run this on a customer's PC.
# The controller starts idle without a saved DoT configuration; install/status/uninstall must not mutate adapter DNS.
$ErrorActionPreference = 'Stop'
$setup = (Resolve-Path 'apps/windows-dns/setup/target/release/mnebydns-setup.exe').Path
$svc = (Resolve-Path 'apps/windows-dns/service/target/release/mnebydns-health-service.exe').Path
Copy-Item -LiteralPath $svc -Destination (Join-Path (Split-Path -Parent $setup) 'mnebydns-health-service.exe') -ErrorAction Stop

function RunSetup([string]$action) {
    $process = Start-Process -FilePath $setup -ArgumentList @($action) -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Native setup $action failed with exit $($process.ExitCode)"
    }
}

function DnsSnapshot {
    @(Get-DnsClientServerAddress |
       Sort-Object InterfaceIndex,AddressFamily |
       Select-Object InterfaceIndex,AddressFamily,ServerAddresses |
       ConvertTo-Json -Depth 4 -Compress) -join ''
}

$before = DnsSnapshot
$installed = $false
$smokeFailure = $null
$cleanupFailure = $null
try {
    RunSetup install
    $installed = $true

    RunSetup status

    $ready = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        & cargo run --release --manifest-path apps/windows-dns/ipc/Cargo.toml --example read_status --quiet
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $ready) { throw "Protected named pipe did not respond on temporary runner" }

    # Upgrade the installed, idle controller in-place without changing DNS.
    # This checks the one-time UAC migration path on a disposable runner.
    RunSetup upgrade
    $upgraded = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        & cargo run --release --manifest-path apps/windows-dns/ipc/Cargo.toml --example read_status --quiet
        if ($LASTEXITCODE -eq 0) { $upgraded = $true; break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $upgraded) { throw "Upgraded DNS service did not expose authenticated status/control pipes" }

    # A second upgrade must archive the prior rollback executable, instead of
    # trapping the customer after the first successful version update.
    RunSetup upgrade
    $upgradedAgain = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        & cargo run --release --manifest-path apps/windows-dns/ipc/Cargo.toml --example read_status --quiet
        if ($LASTEXITCODE -eq 0) { $upgradedAgain = $true; break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $upgradedAgain) { throw "Second service upgrade broke protected IPC" }

    # Simulate a corrupted replacement executable on the disposable runner:
    # the upgrader MUST reject it and restore the previously running service.
    $stagedSource = Join-Path (Split-Path -Parent $setup) 'mnebydns-health-service.exe'
    $verifiedSource = [System.IO.File]::ReadAllBytes($stagedSource)
    try {
        Copy-Item -LiteralPath $setup -Destination $stagedSource -Force
        $bad = Start-Process -FilePath $setup -ArgumentList @('upgrade') -Wait -PassThru
        if ($bad.ExitCode -eq 0) {
            throw 'CRITICAL: upgrade accepted an executable that is not a Windows service'
        }
        $rollbackVerified = $false
        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            & cargo run --release --manifest-path apps/windows-dns/ipc/Cargo.toml --example read_status --quiet
            if ($LASTEXITCODE -eq 0) { $rollbackVerified = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $rollbackVerified) { throw 'CRITICAL: failed upgrade did not restore prior service IPC' }
    } finally {
        [System.IO.File]::WriteAllBytes($stagedSource, $verifiedSource)
    }

    # The offline repair operation is intentionally allowed only after the
    # service stops, and must leave DNS unchanged if no backup is pending.
    Stop-Service -Name MnebyDnsHealth -ErrorAction Stop
    $stopped = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ((Get-Service -Name MnebyDnsHealth).Status -eq 'Stopped') { $stopped = $true; break }
        Start-Sleep -Milliseconds 300
    }
    if (-not $stopped) { throw "Could not stop idle DNS service for offline repair smoke" }
    RunSetup repair
    Start-Service -Name MnebyDnsHealth -ErrorAction Stop
    Start-Sleep -Milliseconds 500

    # Deliberately open the authenticated status pipe without reading or
    # acknowledging. A stuck client must not monopolize the next request.
    $stalled = [System.IO.Pipes.NamedPipeClientStream]::new(
        '.', 'mnebydns-status-v1', [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $stalled.Connect(2000)
        Start-Sleep -Milliseconds 1800
    } finally {
        $stalled.Dispose()
    }
    # A client that immediately closes must not permanently stop the IPC loop.
    $early = [System.IO.Pipes.NamedPipeClientStream]::new(
        '.', 'mnebydns-status-v1', [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $early.Connect(2000)
    } finally {
        $early.Dispose()
    }
    Start-Sleep -Milliseconds 250

    $recovered = $false
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        & cargo run --release --manifest-path apps/windows-dns/ipc/Cargo.toml --example read_status --quiet
        if ($LASTEXITCODE -eq 0) { $recovered = $true; break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $recovered) { throw "Named pipe did not recover after unresponsive client" }
} catch {
    $smokeFailure = $_
} finally {
    if ($installed) {
        try { RunSetup uninstall } catch { $cleanupFailure = $_.Exception.Message }
    }
    $after = DnsSnapshot
    if ($before -ne $after) {
        $cleanupFailure = "DNS configuration changed during idle service install/uninstall"
    }
}
if ($cleanupFailure) { throw $cleanupFailure }
if ($smokeFailure) { throw $smokeFailure }
Write-Output 'Idle Windows DNS controller service and protected IPC smoke test PASSED.'
