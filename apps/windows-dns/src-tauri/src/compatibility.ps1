# Read-only diagnostics; no changes to DNS, browser, routes or registry.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Get-Result([scriptblock]$operation) {
    try { @{ ok = $true; data = @(& $operation) } }
    catch { @{ ok = $false; data = @(); error = $_.FullyQualifiedErrorId } }
}
$nrpt = Get-Result { Get-DnsClientNrptPolicy -Effective | ForEach-Object { 1 } }
$routes = Get-Result {
    Get-NetRoute -PolicyStore ActiveStore |
        Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0', '::/0') } |
        ForEach-Object {
            $route = $_
            $interface = Get-NetIPInterface -InterfaceIndex $route.InterfaceIndex -AddressFamily $route.AddressFamily
            if ($interface.ConnectionState -eq 'Connected') {
                @{ family = [string]$route.AddressFamily; alias = [string]$route.InterfaceAlias;
                   metric = [int64]$route.RouteMetric + [int64]$interface.InterfaceMetric }
            }
        } | Sort-Object { $_.metric } | Select-Object -First 20
}
function Read-Mode([string]$key) {
    try {
        $item = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
        $value = [string]$item.DnsOverHttpsMode
        if ($value -in @('off', 'automatic', 'secure')) { return $value }
        if ($value) { return 'other' }
        return 'unset'
    } catch {
        if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { return 'unset' }
        return 'unknown'
    }
}
function Query-Dns([string]$name, [string]$type, [string]$server, [bool]$cache) {
    Get-Result {
        $params = @{ Name = $name; Type = $type; DnsOnly = $true; NoHostsFile = $true; QuickTimeout = $true; ErrorAction = 'Stop' }
        if ($server) { $params.Server = $server }
        if ($cache) { $params.CacheOnly = $true }
        Resolve-DnsName @params | Where-Object { $_.IPAddress } |
            ForEach-Object { [string]$_.IPAddress } | Sort-Object -Unique | Select-Object -First 64
    }
}
$domain = $env:MNEBYDNS_CHECK_HOST
$queries = $null
if ($domain) {
    $queries = @{
        cached_a = Query-Dns $domain 'A' '' $true
        cached_aaaa = Query-Dns $domain 'AAAA' '' $true
        system_a = Query-Dns $domain 'A' '' $false
        system_aaaa = Query-Dns $domain 'AAAA' '' $false
        local_a = Query-Dns $domain 'A' '127.0.0.1' $false
        local_aaaa = Query-Dns $domain 'AAAA' '127.0.0.1' $false
    }
}
@{
    nrpt = @{ ok = $nrpt.ok; count = $nrpt.data.Count }
    routes = $routes
    browser = @{
        chrome_machine = Read-Mode 'HKLM:\SOFTWARE\Policies\Google\Chrome'
        chrome_user = Read-Mode 'HKCU:\SOFTWARE\Policies\Google\Chrome'
        edge_machine = Read-Mode 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
        edge_user = Read-Mode 'HKCU:\SOFTWARE\Policies\Microsoft\Edge'
    }
    queries = $queries
} | ConvertTo-Json -Depth 6 -Compress
