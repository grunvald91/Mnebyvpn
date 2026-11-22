# Disposable Windows runner only. DO NOT run this on a customer's PC.
# The read-only diagnostic service must never mutate Windows DNS settings.
$ErrorActionPreference = 'Stop'
$setup = (Resolve-Path 'apps/windows-dns/setup/target/release/mnebydns-setup.exe').Path
$svc = (Resolve-Path 'apps/windows-dns/service/target/release/mnebydns-health-service.exe').Path
Copy-Item -LiteralPath $svc -Destination (Join-Path (Split-Path -Parent $setup) 'mnebydns-health-service.exe') -ErrorAction Stop

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
    & $setup install
    if ($LASTEXITCODE -ne 0) { throw "Native setup install failed with exit $LASTEXITCODE" }
    $installed = $true

    & $setup status
    if ($LASTEXITCODE -ne 0) { throw "Native setup status failed with exit $LASTEXITCODE" }

    $ready = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        & cargo run --release --manifest-path apps/windows-dns/ipc/Cargo.toml --example read_status --quiet
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $ready) { throw "Protected named pipe did not respond on temporary runner" }

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
        & $setup uninstall
        if ($LASTEXITCODE -ne 0) { $cleanupFailure = "Native setup uninstall failed: $LASTEXITCODE" }
    }
    $after = DnsSnapshot
    if ($before -ne $after) {
        $cleanupFailure = "DNS configuration changed during read-only diagnostic service install"
    }
}
if ($cleanupFailure) { throw $cleanupFailure }
if ($smokeFailure) { throw $smokeFailure }
Write-Output 'Read-only Windows service and protected IPC smoke test PASSED.'
