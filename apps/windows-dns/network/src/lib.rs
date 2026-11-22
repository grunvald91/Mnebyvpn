//! Windows adapter inventory and reversible per-interface DNS controller.
//! DNS source modes are captured before writes so DHCP/RA and static settings
//! can be restored independently for IPv4, IPv6, and saved network profiles.

use serde::{Deserialize, Serialize};

mod registry_source;
pub use registry_source::RegistryDnsEvidence;
use std::ffi::c_void;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::ptr::null;
use std::slice;
use windows_sys::core::GUID;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    ConvertInterfaceLuidToGuid, GetAdaptersAddresses, GAA_FLAG_INCLUDE_ALL_INTERFACES,
    IF_TYPE_ETHERNET_CSMACD, IF_TYPE_IEEE80211, IF_TYPE_SOFTWARE_LOOPBACK, IF_TYPE_TUNNEL,
    IP_ADAPTER_ADDRESSES_LH, IP_ADAPTER_DNS_SERVER_ADDRESS_XP,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, SOCKET_ADDRESS};

const ERROR_BUFFER_OVERFLOW: u32 = 111;
const INITIAL_BUFFER_BYTES: usize = 16 * 1024;
const MAX_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_ADAPTERS: usize = 128;
const MAX_DNS_SERVERS_PER_ADAPTER: usize = 32;

#[derive(Clone, Debug, Serialize)]
pub struct AdapterInfo {
    pub guid: String,
    pub name: String,
    pub kind: String,
    pub operational: bool,
    pub ipv6_enabled: bool,
    pub is_tunnel: bool,
    pub is_loopback: bool,
    pub likely_physical: bool,
    pub dns_ipv4: Vec<String>,
    pub dns_ipv6: Vec<String>,
    pub note: String,
}

fn guid_to_string(guid: &GUID) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4[0],
        guid.data4[1],
        guid.data4[2],
        guid.data4[3],
        guid.data4[4],
        guid.data4[5],
        guid.data4[6],
        guid.data4[7]
    )
}

fn adapter_kind(if_type: u32) -> (&'static str, bool, bool) {
    match if_type {
        IF_TYPE_ETHERNET_CSMACD => ("Ethernet", false, true),
        IF_TYPE_IEEE80211 => ("Wi-Fi", false, true),
        IF_TYPE_TUNNEL => ("Туннель / VPN", true, false),
        IF_TYPE_SOFTWARE_LOOPBACK => ("Loopback", false, false),
        _ => ("Другой / виртуальный", false, false),
    }
}

unsafe fn read_wide_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while len < 1024 && *ptr.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(slice::from_raw_parts(ptr, len))
}

unsafe fn socket_address_to_ip(address: &SOCKET_ADDRESS) -> Option<IpAddr> {
    let ptr = address.lpSockaddr.cast::<u8>();
    if ptr.is_null() || address.iSockaddrLength < 2 {
        return None;
    }
    let family = u16::from_ne_bytes([*ptr, *ptr.add(1)]);
    match family {
        value if value == AF_INET as u16 && address.iSockaddrLength >= 16 => Some(IpAddr::V4(
            Ipv4Addr::new(*ptr.add(4), *ptr.add(5), *ptr.add(6), *ptr.add(7)),
        )),
        value if value == AF_INET6 as u16 && address.iSockaddrLength >= 28 => {
            let bytes: [u8; 16] = slice::from_raw_parts(ptr.add(8), 16).try_into().ok()?;
            Some(IpAddr::V6(Ipv6Addr::from(bytes)))
        }
        _ => None,
    }
}

unsafe fn collect_dns_servers(
    mut current: *mut IP_ADAPTER_DNS_SERVER_ADDRESS_XP,
) -> Result<(Vec<String>, Vec<String>), String> {
    let mut ipv4 = Vec::new();
    let mut ipv6 = Vec::new();
    let mut count = 0usize;
    while !current.is_null() && count < MAX_DNS_SERVERS_PER_ADAPTER {
        if let Some(address) = socket_address_to_ip(&(*current).Address) {
            match address {
                IpAddr::V4(value) => {
                    let value = value.to_string();
                    if !ipv4.contains(&value) {
                        ipv4.push(value);
                    }
                }
                IpAddr::V6(value) => {
                    let value = value.to_string();
                    if !ipv6.contains(&value) {
                        ipv6.push(value);
                    }
                }
            }
        }
        current = (*current).Next;
        count += 1;
    }
    if !current.is_null() {
        return Err("Список DNS-серверов адаптера неполный".to_owned());
    }
    Ok((ipv4, ipv6))
}

/// Enumerates interfaces and their effective DNS addresses. Read-only; no elevation required.
pub fn list_adapters() -> Result<Vec<AdapterInfo>, String> {
    let mut requested_bytes = INITIAL_BUFFER_BYTES;
    let mut retries = 0usize;
    loop {
        if retries >= 5 {
            return Err(
                "Конфигурация адаптеров изменялась во время чтения; попробуйте ещё раз".to_owned(),
            );
        }
        retries += 1;
        if requested_bytes > MAX_BUFFER_BYTES {
            return Err("Список сетевых адаптеров превышает допустимый размер".to_owned());
        }
        let words = requested_bytes.div_ceil(std::mem::size_of::<u64>());
        let mut buffer = vec![0u64; words];
        let mut actual_bytes = (buffer.len() * std::mem::size_of::<u64>()) as u32;
        let status = unsafe {
            GetAdaptersAddresses(
                0, // AF_UNSPEC: IPv4 and IPv6.
                GAA_FLAG_INCLUDE_ALL_INTERFACES,
                null::<c_void>(),
                buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut actual_bytes,
            )
        };
        if status == ERROR_BUFFER_OVERFLOW {
            requested_bytes = (actual_bytes as usize).max(requested_bytes.saturating_mul(2));
            continue;
        }
        if status != 0 {
            return Err(format!(
                "Windows не смогла получить список адаптеров (код {})",
                status
            ));
        }

        let mut result = Vec::new();
        let mut current = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let mut count = 0usize;
        unsafe {
            while !current.is_null() && count < MAX_ADAPTERS {
                let adapter = &*current;
                let mut guid = GUID::default();
                if ConvertInterfaceLuidToGuid(&adapter.Luid, &mut guid) == 0 {
                    let (kind, is_tunnel, likely_physical_type) = adapter_kind(adapter.IfType);
                    let (dns_ipv4, dns_ipv6) = collect_dns_servers(adapter.FirstDnsServerAddress)?;
                    let operational = adapter.OperStatus == 1; // IfOperStatusUp.
                    let ipv6_enabled = adapter.Ipv6IfIndex != 0;
                    let is_loopback = adapter.IfType == IF_TYPE_SOFTWARE_LOOPBACK;
                    let likely_physical =
                        operational && likely_physical_type && !is_tunnel && !is_loopback;
                    let note = if is_tunnel {
                        "Туннельный интерфейс. Не выбирать для первой настройки DNS.".to_owned()
                    } else if is_loopback {
                        "Системный loopback. Не является подключением к интернету.".to_owned()
                    } else if !operational {
                        "Адаптер сейчас не активен.".to_owned()
                    } else if likely_physical {
                        "Похож на физический Ethernet/Wi-Fi. Перед будущим применением проверьте название.".to_owned()
                    } else {
                        "Тип адаптера не определён как физический. Проверьте, не является ли он виртуальным/VPN.".to_owned()
                    };
                    let name = read_wide_string(adapter.FriendlyName);
                    result.push(AdapterInfo {
                        guid: guid_to_string(&guid),
                        name: if name.is_empty() {
                            "Адаптер без имени".to_owned()
                        } else {
                            name
                        },
                        kind: kind.to_owned(),
                        operational,
                        ipv6_enabled,
                        is_tunnel,
                        is_loopback,
                        likely_physical,
                        dns_ipv4,
                        dns_ipv6,
                        note,
                    });
                } else {
                    return Err("Не удалось определить GUID сетевого адаптера".to_owned());
                }
                current = adapter.Next;
                count += 1;
            }
            if !current.is_null() {
                return Err("Список сетевых адаптеров неполный".to_owned());
            }
        }
        result.sort_by_key(|adapter| {
            (
                !adapter.operational,
                !adapter.likely_physical,
                adapter.name.to_lowercase(),
            )
        });
        return Ok(result);
    }
}

// Windows 10 build 19041+: GetInterfaceDnsSettings reads; SetInterfaceDnsSettings
// applies per-interface IPv4 and IPv6 DNS. Every mutation is preceded by a
// protected service-side snapshot and followed by read-back verification.
use windows_sys::Win32::NetworkManagement::IpHelper::{
    FreeInterfaceDnsSettings, GetInterfaceDnsSettings, SetInterfaceDnsSettings,
    DNS_INTERFACE_SETTINGS, DNS_INTERFACE_SETTINGS_VERSION1, DNS_SETTING_IPV6,
    DNS_SETTING_NAMESERVER, DNS_SETTING_PROFILE_NAMESERVER,
};

#[derive(Clone, Debug, Serialize)]
pub struct FamilyDnsConfig {
    pub static_servers: Vec<String>,
    pub profile_servers: Vec<String>,
    pub flags: u64,
    /// Evidence only. Never use this read-only report as a recovery journal.
    pub origin_evidence: String,
    pub interpretation: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdapterPreflight {
    pub guid: String,
    pub adapter_name: String,
    pub adapter_kind: String,
    pub ipv4: Option<FamilyDnsConfig>,
    pub ipv6: Option<FamilyDnsConfig>,
    pub ipv4_error: Option<String>,
    pub ipv6_error: Option<String>,
    pub local_dns_targets: Vec<String>,
    pub mutation_enabled: bool,
    pub warning: String,
    /// A verified two-family backup is not yet available.
    pub recovery_ready: bool,
    pub recovery_blockers: Vec<String>,
    pub registry: Option<RegistryDnsEvidence>,
    pub registry_error: Option<String>,
}

/// Convert only canonical Windows interface GUID strings returned by list_adapters().
fn parse_guid(input: &str) -> Result<GUID, String> {
    let chunks: Vec<&str> = input.split('-').collect();
    if chunks.len() != 5 || chunks.iter().map(|s| s.len()).collect::<Vec<_>>() != [8, 4, 4, 4, 12] {
        return Err("Некорректный GUID сетевого адаптера".to_owned());
    }
    let data1 = u32::from_str_radix(chunks[0], 16).map_err(|_| "Некорректный GUID")?;
    let data2 = u16::from_str_radix(chunks[1], 16).map_err(|_| "Некорректный GUID")?;
    let data3 = u16::from_str_radix(chunks[2], 16).map_err(|_| "Некорректный GUID")?;
    let hex = format!("{}{}", chunks[3], chunks[4]);
    let mut data4 = [0u8; 8];
    for (idx, slot) in data4.iter_mut().enumerate() {
        *slot =
            u8::from_str_radix(&hex[idx * 2..idx * 2 + 2], 16).map_err(|_| "Некорректный GUID")?;
    }
    Ok(GUID {
        data1,
        data2,
        data3,
        data4,
    })
}

/// Never truncate or silently discard a DNS server. A truncated backup
/// could restore a different resolver order after a crash.
fn parse_servers(value: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for entry in value
        .split([',', ' ', '\t', '\n'])
        .filter(|s| !s.is_empty())
    {
        if result.len() >= MAX_DNS_SERVERS_PER_ADAPTER {
            return Err("DNS server list exceeds recovery inspection limit".into());
        }
        let ip: IpAddr = entry
            .parse()
            .map_err(|_| "Invalid DNS IP address in Windows settings".to_owned())?;
        if !ip.is_ipv4() {
            return Err("IPv6 address found in an IPv4-only configuration read".into());
        }
        result.push(entry.to_owned());
    }
    Ok(result)
}

/// Windows owns these API-allocated strings. Reject unterminated or invalid
/// UTF-16 instead of silently keeping a truncated backup candidate.
unsafe fn read_dns_wide(ptr: *const u16) -> Result<String, String> {
    if ptr.is_null() {
        return Ok(String::new());
    }
    const MAX_UNITS: usize = 2048;
    let mut length = 0;
    while length < MAX_UNITS && *ptr.add(length) != 0 {
        length += 1;
    }
    if length == MAX_UNITS {
        return Err("Windows returned an unterminated DNS setting".into());
    }
    String::from_utf16(slice::from_raw_parts(ptr, length))
        .map_err(|_| "Windows returned invalid DNS setting UTF-16".into())
}

fn interpret_family(static_servers: &[String], profile_servers: &[String]) -> String {
    if !profile_servers.is_empty() {
        "Есть DNS профильного подключения; точный способ восстановления требует дополнительной проверки".to_owned()
    } else if !static_servers.is_empty() {
        "Найдены статические IPv4 DNS; для отката нужно подтвердить источник и их точный порядок"
            .to_owned()
    } else {
        "Статический DNS не указан; это не доказывает режим DHCP/RA".to_owned()
    }
}

fn read_dns_ipv4(guid: GUID) -> Result<FamilyDnsConfig, String> {
    // Microsoft GetInterfaceDnsSettings contract: set ONLY Version. Passing
    // DNS_SETTING_IPV6 on input is not supported by the documented read API.
    let mut settings: DNS_INTERFACE_SETTINGS = unsafe { std::mem::zeroed() };
    settings.Version = DNS_INTERFACE_SETTINGS_VERSION1;
    let code = unsafe { GetInterfaceDnsSettings(guid, &mut settings) };
    if code != 0 {
        return Err(format!(
            "Не удалось прочитать IPv4 DNS (Windows API код {code})"
        ));
    }
    // Release Windows-owned strings even when strict parsing fails.
    let strings = unsafe {
        (|| {
            let static_text = read_dns_wide(settings.NameServer)?;
            let profile_text = read_dns_wide(settings.ProfileNameServer)?;
            Ok::<_, String>((static_text, profile_text))
        })()
    };
    let flags = settings.Flags;
    unsafe { FreeInterfaceDnsSettings(&mut settings) };
    let (raw_static, raw_profile) = strings?;
    let static_servers = parse_servers(&raw_static)?;
    let profile_servers = parse_servers(&raw_profile)?;
    let origin_evidence =
        if flags & DNS_SETTING_NAMESERVER as u64 != 0 && !static_servers.is_empty() {
            "Статическая конфигурация обнаружена (IPv4), но откат ещё не разрешён"
        } else {
            "Источник DNS не подтверждён; DHCP нельзя определять по пустому полю"
        };
    let interpretation = interpret_family(&static_servers, &profile_servers);
    Ok(FamilyDnsConfig {
        static_servers,
        profile_servers,
        flags,
        origin_evidence: origin_evidence.to_owned(),
        interpretation,
    })
}

/// Strictly read-only preflight for one adapter selected by GUID.
/// The caller must not infer that the snapshot is a safe backup or restore plan.
pub fn preflight_adapter(guid: &str) -> Result<AdapterPreflight, String> {
    let _ = parse_guid(guid)?;
    let adapter = list_adapters()?
        .into_iter()
        .find(|item| item.guid.eq_ignore_ascii_case(guid))
        .ok_or_else(|| "Сетевой адаптер больше не существует — обновите список".to_owned())?;

    let interface_guid = parse_guid(&adapter.guid)?;
    let (ipv4, ipv4_error) = match read_dns_ipv4(interface_guid) {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    // GetAdaptersAddresses reports effective IPv6 DNS separately in adapter
    // inventory. The documented GetInterfaceDnsSettings V1 read API does not
    // provide a validated IPv6 source-mode selector; NEVER relabel an IPv4
    // result as an IPv6 configuration or assume IPv6 RA/DHCP settings.
    let ipv6: Option<FamilyDnsConfig> = None;
    let ipv6_error = Some(
        "Источник IPv6 DNS не подтверждён: эффективные IPv6 адреса смотрите в карточке адаптера"
            .to_owned(),
    );
    let mut recovery_blockers =
        vec!["Не подтверждено происхождение IPv6 DNS (статический/DHCPv6/RA/профиль)".to_owned()];
    if adapter.is_tunnel || adapter.is_loopback || !adapter.likely_physical {
        recovery_blockers.push("Адаптер не подтверждён как физический Wi-Fi/Ethernet".to_owned());
    }
    if ipv4_error.is_some() {
        recovery_blockers.push("Не удалось прочитать исходный IPv4 DNS без потерь".to_owned());
    }
    if ipv4.as_ref().is_some_and(|v| v.profile_servers.len() > 0) {
        recovery_blockers
            .push("Обнаружен профильный DNS, необходим отдельный план восстановления".to_owned());
    }
    if ipv4.as_ref().is_some_and(|v| {
        v.static_servers.is_empty() || v.flags & DNS_SETTING_NAMESERVER as u64 == 0
    }) {
        recovery_blockers.push("Источник IPv4 DNS (DHCP/статический) не доказан".to_owned());
    }
    // Independent, read-only registry evidence supplements the DNS API.
    // Registry values are not proof of the currently active source mode:
    // DHCP, RDNSS/RA, VPN/NRPT and policy may override effective servers.
    let (registry, registry_error) = match registry_source::inspect(&adapter.guid) {
        Ok(value) => (Some(value), None),
        Err(error) => {
            recovery_blockers.push("Не удалось независимо прочитать DNS из реестра".to_owned());
            (None, Some(error))
        }
    };
    if let Some(evidence) = registry.as_ref() {
        if let (Some(static4), Some(api4)) = (evidence.ipv4_static.as_ref(), ipv4.as_ref()) {
            if *static4 != api4.static_servers {
                recovery_blockers
                    .push("IPv4 NameServer реестра отличается от Windows DNS API".to_owned());
            }
        }
        if evidence
            .ipv6_static
            .as_ref()
            .is_some_and(|values| !values.is_empty())
        {
            // Even if static nameservers match the effective list, RA, DHCPv6,
            // profile DNS and policy are not proven absent.
            recovery_blockers.push(
                "Статический IPv6 найден в реестре, но источник действующего DNS не доказан"
                    .to_owned(),
            );
        }
    }
    let warning =
        "Неполный снимок: нельзя сохранять его как точный backup IPv4+IPv6 и менять DNS Windows.";
    Ok(AdapterPreflight {
        guid: adapter.guid,
        adapter_name: adapter.name,
        adapter_kind: adapter.kind,
        ipv4,
        ipv6,
        ipv4_error,
        ipv6_error,
        local_dns_targets: vec!["127.0.0.1".to_owned(), "::1".to_owned()],
        mutation_enabled: false,
        warning: warning.to_owned(),
        recovery_ready: false,
        recovery_blockers,
        registry,
        registry_error,
    })
}


/// Exact per-stack DNS source captured before the client takes ownership.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DnsServerMode {
    Automatic,
    Static(Vec<String>),
}

/// DNS state for one Windows network interface. IPv4/IPv6 and profile DNS
/// are kept separately so restore does not convert DHCP/RA into static DNS.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterDnsSnapshot {
    pub interface_guid: String,
    pub adapter_name: String,
    pub ipv4: DnsServerMode,
    pub ipv6: DnsServerMode,
    pub ipv4_profile: DnsServerMode,
    pub ipv6_profile: DnsServerMode,
}

fn mode_from_servers(servers: Option<Vec<String>>) -> DnsServerMode {
    match servers {
        Some(values) if !values.is_empty() => DnsServerMode::Static(values),
        _ => DnsServerMode::Automatic,
    }
}

fn validate_mode(mode: &DnsServerMode, ipv6: bool) -> Result<(), String> {
    if let DnsServerMode::Static(values) = mode {
        if values.is_empty() || values.len() > MAX_DNS_SERVERS_PER_ADAPTER {
            return Err("Неполный или пустой список DNS для восстановления".into());
        }
        for value in values {
            let address: IpAddr = value
                .parse()
                .map_err(|_| "Снимок содержит некорректный DNS-адрес".to_owned())?;
            if address.is_ipv6() != ipv6 {
                return Err("Снимок содержит DNS-адрес неверного семейства".into());
            }
        }
    }
    Ok(())
}

fn mode_from_api(
    servers: Vec<String>,
    flags: u64,
    flag: u64,
) -> DnsServerMode {
    if flags & flag == 0 {
        DnsServerMode::Automatic
    } else {
        mode_from_servers(Some(servers))
    }
}

/// Capture exact static/automatic DNS source for both IP families and
/// Wi-Fi profile DNS. Any mismatch between independent IPv4 API/registry
/// observations blocks a destructive change.
pub fn capture_adapter_dns(interface_guid: &str) -> Result<AdapterDnsSnapshot, String> {
    let adapter = list_adapters()?
        .into_iter()
        .find(|item| item.guid.eq_ignore_ascii_case(interface_guid))
        .ok_or_else(|| "Сетевой адаптер исчез во время снимка DNS".to_owned())?;
    if adapter.is_loopback {
        return Err("Loopback не является целевым сетевым адаптером".into());
    }

    let guid = parse_guid(&adapter.guid)?;
    let ipv4_api = read_dns_ipv4(guid)?;
    let registry = registry_source::inspect(&adapter.guid)?;

    let ipv4 = mode_from_api(
        ipv4_api.static_servers.clone(),
        ipv4_api.flags,
        DNS_SETTING_NAMESERVER as u64,
    );
    let ipv4_registry = mode_from_servers(registry.ipv4_static.clone());
    if ipv4 != ipv4_registry {
        return Err("IPv4 DNS API и реестр не совпадают; точное восстановление не подтверждено".into());
    }
    let ipv4_profile = mode_from_api(
        ipv4_api.profile_servers.clone(),
        ipv4_api.flags,
        DNS_SETTING_PROFILE_NAMESERVER as u64,
    );
    let ipv6 = mode_from_servers(registry.ipv6_static.clone());
    let ipv6_profile = mode_from_servers(registry.ipv6_profile_static.clone());

    validate_mode(&ipv4, false)?;
    validate_mode(&ipv4_profile, false)?;
    validate_mode(&ipv6, true)?;
    validate_mode(&ipv6_profile, true)?;

    if adapter.operational {
        for (mode, observed, family) in [
            (&ipv4, &adapter.dns_ipv4, "IPv4"),
            (&ipv6, &adapter.dns_ipv6, "IPv6"),
        ] {
            if let DnsServerMode::Static(expected) = mode {
                if expected.iter().any(|server| !observed.contains(server)) {
                    return Err(format!(
                        "{family} static DNS snapshot does not match the effective resolver list"
                    ));
                }
            }
        }
    }

    Ok(AdapterDnsSnapshot {
        interface_guid: adapter.guid,
        adapter_name: adapter.name,
        ipv4,
        ipv6,
        ipv4_profile,
        ipv6_profile,
    })
}

fn mode_text(mode: &DnsServerMode) -> String {
    match mode {
        DnsServerMode::Automatic => String::new(),
        DnsServerMode::Static(values) => values.join(","),
    }
}

fn set_interface_static_dns(
    interface_guid: &str,
    ipv6: bool,
    servers: &[String],
) -> Result<(), String> {
    validate_mode(&DnsServerMode::Static(servers.to_vec()), ipv6)?;
    let guid = parse_guid(interface_guid)?;
    let mut name_server = servers.join(",").encode_utf16().chain([0]).collect::<Vec<_>>();
    let mut settings: DNS_INTERFACE_SETTINGS = unsafe { std::mem::zeroed() };
    settings.Version = DNS_INTERFACE_SETTINGS_VERSION1;
    settings.Flags = DNS_SETTING_NAMESERVER as u64;
    if ipv6 {
        settings.Flags |= DNS_SETTING_IPV6 as u64;
    }
    settings.NameServer = name_server.as_mut_ptr();
    let code = unsafe { SetInterfaceDnsSettings(guid, &settings) };
    if code != 0 {
        return Err(format!(
            "Windows не смогла изменить {} DNS адаптера {} (код {})",
            if ipv6 { "IPv6" } else { "IPv4" },
            interface_guid,
            code
        ));
    }
    Ok(())
}

fn set_profile_static_dns(
    interface_guid: &str,
    ipv6: bool,
    servers: &[String],
) -> Result<(), String> {
    validate_mode(&DnsServerMode::Static(servers.to_vec()), ipv6)?;
    let guid = parse_guid(interface_guid)?;
    let mut profile_server = servers.join(",").encode_utf16().chain([0]).collect::<Vec<_>>();
    let mut settings: DNS_INTERFACE_SETTINGS = unsafe { std::mem::zeroed() };
    settings.Version = DNS_INTERFACE_SETTINGS_VERSION1;
    settings.Flags = DNS_SETTING_PROFILE_NAMESERVER as u64;
    if ipv6 {
        settings.Flags |= DNS_SETTING_IPV6 as u64;
    }
    settings.ProfileNameServer = profile_server.as_mut_ptr();
    let code = unsafe { SetInterfaceDnsSettings(guid, &settings) };
    if code != 0 {
        return Err(format!(
            "Windows не смогла изменить {} DNS профиля адаптера {} (код {})",
            if ipv6 { "IPv6" } else { "IPv4" },
            interface_guid,
            code
        ));
    }
    Ok(())
}

fn reset_interface_dns_to_automatic(interface_name: &str, ipv6: bool) -> Result<(), String> {
    let root = std::env::var_os("SystemRoot")
        .ok_or_else(|| "Не найден каталог Windows для восстановления DHCP DNS".to_owned())?;
    let netsh = std::path::PathBuf::from(root)
        .join("System32")
        .join("netsh.exe");
    let family = if ipv6 { "ipv6" } else { "ipv4" };
    let interface = format!("name={interface_name}");
    let output = Command::new(netsh)
        .args([
            "interface",
            family,
            "set",
            "dnsservers",
            interface.as_str(),
            "source=dhcp",
        ])
        .output()
        .map_err(|error| format!("Не удалось запустить netsh для восстановления DNS: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Windows не смогла вернуть {} DNS в автоматический режим для {} ({}): {}",
            family,
            interface_name,
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn restore_profile_dns(
    snapshot: &AdapterDnsSnapshot,
    ipv6: bool,
    mode: &DnsServerMode,
) -> Result<(), String> {
    match mode {
        DnsServerMode::Automatic => Ok(()), // The profile was never overridden.
        DnsServerMode::Static(servers) => {
            set_profile_static_dns(&snapshot.interface_guid, ipv6, servers)
        }
    }
}

/// Apply localhost to each interface and to a saved profile only when that
/// profile originally had its own static resolver. Automatic profiles remain
/// automatic and inherit the interface DNS configuration.
pub fn apply_adapter_loopback_dns(snapshot: &AdapterDnsSnapshot) -> Result<(), String> {
    set_interface_static_dns(
        &snapshot.interface_guid,
        false,
        &["127.0.0.1".to_owned()],
    )?;
    if matches!(snapshot.ipv4_profile, DnsServerMode::Static(_)) {
        set_profile_static_dns(
            &snapshot.interface_guid,
            false,
            &["127.0.0.1".to_owned()],
        )?;
    }
    set_interface_static_dns(&snapshot.interface_guid, true, &["::1".to_owned()])?;
    if matches!(snapshot.ipv6_profile, DnsServerMode::Static(_)) {
        set_profile_static_dns(&snapshot.interface_guid, true, &["::1".to_owned()])?;
    }
    Ok(())
}

/// Restore exact static DNS with SetInterfaceDnsSettings and return automatic
/// DNS to DHCP/RA using netsh's documented source=dhcp operation.
pub fn restore_adapter_dns(snapshot: &AdapterDnsSnapshot) -> Result<(), String> {
    let mut errors = Vec::new();
    let ipv4 = match &snapshot.ipv4 {
        DnsServerMode::Automatic => {
            reset_interface_dns_to_automatic(&snapshot.adapter_name, false)
        }
        DnsServerMode::Static(servers) => {
            set_interface_static_dns(&snapshot.interface_guid, false, servers)
        }
    };
    if let Err(error) = ipv4 {
        errors.push(format!("IPv4: {error}"));
    }
    if let Err(error) = restore_profile_dns(snapshot, false, &snapshot.ipv4_profile) {
        errors.push(format!("IPv4 profile: {error}"));
    }

    let ipv6 = match &snapshot.ipv6 {
        DnsServerMode::Automatic => {
            reset_interface_dns_to_automatic(&snapshot.adapter_name, true)
        }
        DnsServerMode::Static(servers) => {
            set_interface_static_dns(&snapshot.interface_guid, true, servers)
        }
    };
    if let Err(error) = ipv6 {
        errors.push(format!("IPv6: {error}"));
    }
    if let Err(error) = restore_profile_dns(snapshot, true, &snapshot.ipv6_profile) {
        errors.push(format!("IPv6 profile: {error}"));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Read-back verification after activation: both stacks must resolve only
/// through their loopback listeners, not through a surviving public resolver.
pub fn verify_adapter_loopback_dns(interface_guid: &str) -> Result<(), String> {
    let adapter = list_adapters()?
        .into_iter()
        .find(|item| item.guid.eq_ignore_ascii_case(interface_guid))
        .ok_or_else(|| "Адаптер исчез после применения DNS".to_owned())?;
    if adapter.dns_ipv4 != ["127.0.0.1"] {
        return Err(format!(
            "IPv4 DNS не применился полностью: {}",
            adapter.dns_ipv4.join(", ")
        ));
    }
    if adapter.dns_ipv6 != ["::1"] {
        return Err(format!(
            "IPv6 DNS не применился полностью: {}",
            adapter.dns_ipv6.join(", ")
        ));
    }
    Ok(())
}

/// Restore verification compares the entire captured DNS source state,
/// including DHCP/RA-vs-static mode and profile DNS, not just effective IPs.
pub fn verify_adapter_restored(snapshot: &AdapterDnsSnapshot) -> Result<(), String> {
    let current = capture_adapter_dns(&snapshot.interface_guid)?;
    if current != *snapshot {
        return Err(format!(
            "DNS адаптера {} отличается от исходного снимка",
            snapshot.adapter_name
        ));
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_parse_roundtrips_and_rejects_invalid_strings() {
        let original = "12345678-9abc-def0-1234-56789abcdef0";
        assert_eq!(guid_to_string(&parse_guid(original).unwrap()), original);
        assert!(parse_guid("deadbeef").is_err());
        assert!(parse_guid("zzzzzzzz-1111-1111-1111-111111111111").is_err());
    }

    #[test]
    fn dns_family_interpretation_is_fail_closed() {
        assert!(interpret_family(&[], &[]).contains("не доказывает"));
        assert!(interpret_family(&["1.1.1.1".into()], &[]).contains("статические"));
        assert!(interpret_family(&[], &["1.1.1.1".into()]).contains("профильного"));
        assert_eq!(
            parse_servers("1.1.1.1, 8.8.8.8").unwrap(),
            vec!["1.1.1.1", "8.8.8.8"]
        );
    }

    #[test]
    fn reject_lossy_or_wrong_family_ipv4_recovery_evidence() {
        assert!(parse_servers("::1").is_err());
        assert!(parse_servers("1.1.1.1,not-an-ip").is_err());
        assert!(parse_servers(&vec!["1.1.1.1"; 33].join(",")).is_err());
        assert_eq!(parse_servers(""), Ok(Vec::new()));
    }

    #[test]
    fn guid_format_uses_canonical_groups() {
        let guid = GUID {
            data1: 0x12345678,
            data2: 0x9abc,
            data3: 0xdef0,
            data4: [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0],
        };
        assert_eq!(
            guid_to_string(&guid),
            "12345678-9abc-def0-1234-56789abcdef0"
        );
    }

    #[test]
    fn adapter_kind_never_marks_tunnel_as_physical() {
        assert_eq!(adapter_kind(IF_TYPE_TUNNEL), ("Туннель / VPN", true, false));
        assert_eq!(
            adapter_kind(IF_TYPE_ETHERNET_CSMACD),
            ("Ethernet", false, true)
        );
        assert_eq!(adapter_kind(IF_TYPE_IEEE80211), ("Wi-Fi", false, true));
    }

    #[test]
    fn sockaddr_parser_reads_ipv4_and_ipv6_without_network_io() {
        let mut v4 = [0u8; 16];
        v4[0..2].copy_from_slice(&(AF_INET as u16).to_ne_bytes());
        v4[4..8].copy_from_slice(&[1, 1, 1, 1]);
        let address4 = SOCKET_ADDRESS {
            lpSockaddr: v4.as_mut_ptr().cast(),
            iSockaddrLength: 16,
        };
        assert_eq!(
            unsafe { socket_address_to_ip(&address4) },
            Some(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)))
        );

        let mut v6 = [0u8; 28];
        v6[0..2].copy_from_slice(&(AF_INET6 as u16).to_ne_bytes());
        v6[8..24].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
        let address6 = SOCKET_ADDRESS {
            lpSockaddr: v6.as_mut_ptr().cast(),
            iSockaddrLength: 28,
        };
        assert_eq!(
            unsafe { socket_address_to_ip(&address6) },
            Some(IpAddr::V6(Ipv6Addr::LOCALHOST))
        );
    }
}
