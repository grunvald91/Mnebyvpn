#Requires -Version 5.1
<#
Temporary MnebyDNS system resolver override for Windows 10.
Uses Windows NRPT Any (.) and preserves adapter IPv4/IPv6 modes.
An independent SYSTEM scheduled task removes the rule at 15 min or reboot.
No hostname is persisted or passed via command-line arguments.
#>
param(
    [ValidateSet('Enable','Disable','Status')]
    [string]$Action = 'Status'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$prefix = 'MnebyDNS Trial '
$taskPrefix = 'MnebyDNS-DNS-Restore-'
$listenIPs = @('127.0.0.1', '::1')
$durationMinutes = 15

function OwnRules {
    @(Get-DnsClientNrptRule -ErrorAction Stop | Where-Object {
        $_.DisplayName -like "$prefix*" -and @($_.Namespace) -contains '.'
    })
}
function AssertAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Необходим запуск с правами администратора (UAC).'
    }
}
function StopOwnServer {
    $binary = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'mnebydns-loopback.exe'))
    Get-CimInstance Win32_Process -Filter "Name='mnebydns-loopback.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $binary } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function RemoveTrial {
    foreach ($r in @(OwnRules)) {
        Remove-DnsClientNrptRule -Name $r.Name -Force -Confirm:$false -ErrorAction Stop
    }
    StopOwnServer
    Get-ScheduledTask -ErrorAction SilentlyContinue |
        Where-Object { $_.TaskName -like "$taskPrefix*" } |
        ForEach-Object { Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue }
}
function CheckHost([string]$h) {
    $v = $h.Trim().ToLowerInvariant()
    if ($v.Length -lt 4 -or $v.Length -gt 253 -or $v -notmatch '^[a-z0-9-]+(\.[a-z0-9-]+)+$') {
        throw 'Нужно полное DNS-имя сервера без URL, пробелов, IP и порта.'
    }
    foreach ($label in $v.Split('.')) {
        if ($label.Length -gt 63 -or $label.StartsWith('-') -or $label.EndsWith('-')) {
            throw 'Неверное DNS-имя.'
        }
    }
    return $v
}

if ($Action -eq 'Status') {
    if (@(OwnRules).Count -eq 0) { 'OFF' } else { 'ACTIVE' }
    exit 0
}
AssertAdmin
if ($Action -eq 'Disable') {
    RemoveTrial
    'Системная NRPT-политика мнебыDNS удалена. Настройки адаптеров не менялись.'
    exit 0
}
# Respect pre-existing VPN/corporate NRPT policies; no guessing about priority.
if (@(Get-DnsClientNrptRule -ErrorAction Stop).Count -gt 0) {
    throw 'Уже настроены правила NRPT (возможно, VPN или корпоративные). Пробный режим не будет менять их.'
}
$binary = Join-Path $PSScriptRoot 'mnebydns-loopback.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw 'Не найден mnebydns-loopback.exe рядом со скриптом. Распакуйте весь архив.'
}
$hostname = CheckHost (Read-Host 'Введите персональный DNS-over-TLS хост (не DoH)')
$env:MNEBYDNS_DOT_HOST = $hostname
$child = $null
try {
    $child = Start-Process -FilePath $binary -PassThru -WindowStyle Hidden
} finally {
    Remove-Item Env:\MNEBYDNS_DOT_HOST -ErrorAction SilentlyContinue
}
try {
    Start-Sleep -Milliseconds 900
    $child.Refresh()
    if ($child.HasExited) { throw 'Локальный DNS-сервер не запустился; вероятно, занят порт 53.' }
    foreach ($ip in $listenIPs) {
        $records = @(Resolve-DnsName -Name example.com -Type A -DnsOnly -Server $ip -ErrorAction Stop | Where-Object { $_.Type -eq 'A' })
        if ($records.Count -eq 0) { throw "Нет DNS A-ответа через локальный сервер $ip." }
    }
    $token = ([guid]::NewGuid()).ToString('N')
    $marker = "$prefix$token"
    $taskname = "$taskPrefix$token"
    $expires = (Get-Date).AddMinutes($durationMinutes)
    $started = $child.StartTime.ToUniversalTime().Ticks
    # SYSTEM task does not run a user-writable .ps1; its only action is a
    # fixed encoded cleanup command bound to this unique NRPT rule and PID.
    $cleanup = @'
$ErrorActionPreference = 'Stop'
try {
    $p = Get-Process -Id __PID__ -ErrorAction SilentlyContinue
    $matches = $p -and $p.ProcessName -eq 'mnebydns-loopback' -and $p.StartTime.ToUniversalTime().Ticks -eq [long]__TICKS__
    if ($matches -and (Get-Date) -lt [datetime]::FromBinary([long]__DEADLINE__)) { exit 0 }
    Get-DnsClientNrptRule -ErrorAction Stop | Where-Object { $_.DisplayName -eq '__MARKER__' -and @($_.Namespace) -contains '.' } | ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force -Confirm:$false -ErrorAction Stop }
    if (@(Get-DnsClientNrptRule -ErrorAction Stop | Where-Object { $_.DisplayName -eq '__MARKER__' }).Count -gt 0) { exit 1 }
    if ($matches) { Stop-Process -Id __PID__ -Force -ErrorAction SilentlyContinue }
    Unregister-ScheduledTask -TaskName '__TASK__' -Confirm:$false -ErrorAction SilentlyContinue
} catch { exit 1 }
'@
    $cleanup = $cleanup.Replace('__PID__', "$($child.Id)").Replace('__TICKS__', "$started").Replace('__DEADLINE__', "$($expires.ToBinary())").Replace('__MARKER__', $marker).Replace('__TASK__', $taskname)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanup))
    $taskExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $actionTask = New-ScheduledTaskAction -Execute $taskExe -Argument "-NoProfile -NonInteractive -EncodedCommand $encoded"
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $tick = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Minutes $durationMinutes)
    $boot = New-ScheduledTaskTrigger -AtStartup
    $logon = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $taskname -Action $actionTask -Trigger @($tick, $boot, $logon) -Principal $principal -Force | Out-Null
    Add-DnsClientNrptRule -Namespace '.' -NameServers $listenIPs -DisplayName $marker -ErrorAction Stop | Out-Null
    if (@(OwnRules).Count -ne 1) { throw 'NRPT правило не найдено после записи.' }
    'SYSTEM-DNS-TRIAL-ACTIVE'
    "Системная политика DNS включена на $durationMinutes минут. Автооткат запланирован даже после перезагрузки."
} catch {
    # Immediate cleanup plus the independently scheduled recovery task.
    try { RemoveTrial } catch { }
    if ($child -and -not $child.HasExited) {
        Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
    }
    throw
}
