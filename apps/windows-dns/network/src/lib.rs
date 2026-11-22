//! Read-only adapter inventory. No DNS mutation API is exposed.
//! Effective DNS addresses do not identify whether Windows obtained them statically,
//! through DHCP, or through IPv6 router advertisements.

use serde::Serialize;
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
        guid.data1, guid.data2, guid.data3,
        guid.data4[0], guid.data4[1], guid.data4[2], guid.data4[3],
        guid.data4[4], guid.data4[5], guid.data4[6], guid.data4[7]
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
    if ptr.is_null() { return String::new(); }
    let mut len = 0usize;
    while len < 1024 && *ptr.add(len) != 0 { len += 1; }
    String::from_utf16_lossy(slice::from_raw_parts(ptr, len))
}

unsafe fn socket_address_to_ip(address: &SOCKET_ADDRESS) -> Option<IpAddr> {
    let ptr = address.lpSockaddr.cast::<u8>();
    if ptr.is_null() || address.iSockaddrLength < 2 { return None; }
    let family = u16::from_ne_bytes([*ptr, *ptr.add(1)]);
    match family {
        value if value == AF_INET as u16 && address.iSockaddrLength >= 16 => {
            Some(IpAddr::V4(Ipv4Addr::new(*ptr.add(4), *ptr.add(5), *ptr.add(6), *ptr.add(7))))
        }
        value if value == AF_INET6 as u16 && address.iSockaddrLength >= 28 => {
            let bytes: [u8; 16] = slice::from_raw_parts(ptr.add(8), 16).try_into().ok()?;
            Some(IpAddr::V6(Ipv6Addr::from(bytes)))
        }
        _ => None,
    }
}

unsafe fn collect_dns_servers(
    mut current: *mut IP_ADAPTER_DNS_SERVER_ADDRESS_XP,
) -> (Vec<String>, Vec<String>) {
    let mut ipv4 = Vec::new();
    let mut ipv6 = Vec::new();
    let mut count = 0usize;
    while !current.is_null() && count < MAX_DNS_SERVERS_PER_ADAPTER {
        if let Some(address) = socket_address_to_ip(&(*current).Address) {
            match address {
                IpAddr::V4(value) => {
                    let value = value.to_string();
                    if !ipv4.contains(&value) { ipv4.push(value); }
                }
                IpAddr::V6(value) => {
                    let value = value.to_string();
                    if !ipv6.contains(&value) { ipv6.push(value); }
                }
            }
        }
        current = (*current).Next;
        count += 1;
    }
    (ipv4, ipv6)
}

/// Enumerates interfaces and their effective DNS addresses. Read-only; no elevation required.
pub fn list_adapters() -> Result<Vec<AdapterInfo>, String> {
    let mut requested_bytes = INITIAL_BUFFER_BYTES;
    loop {
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
            requested_bytes = actual_bytes as usize;
            continue;
        }
        if status != 0 {
            return Err(format!("Windows не смогла получить список адаптеров (код {})", status));
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
                    let (dns_ipv4, dns_ipv6) = collect_dns_servers(adapter.FirstDnsServerAddress);
                    let operational = adapter.OperStatus == 1; // IfOperStatusUp.
                    let is_loopback = adapter.IfType == IF_TYPE_SOFTWARE_LOOPBACK;
                    let likely_physical = operational && likely_physical_type && !is_tunnel && !is_loopback;
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
                        name: if name.is_empty() { "Адаптер без имени".to_owned() } else { name },
                        kind: kind.to_owned(),
                        operational,
                        is_tunnel,
                        is_loopback,
                        likely_physical,
                        dns_ipv4,
                        dns_ipv6,
                        note,
                    });
                }
                current = adapter.Next;
                count += 1;
            }
        }
        result.sort_by_key(|adapter| (
            !adapter.operational,
            !adapter.likely_physical,
            adapter.name.to_lowercase(),
        ));
        return Ok(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_format_uses_canonical_groups() {
        let guid = GUID {
            data1: 0x12345678, data2: 0x9abc, data3: 0xdef0,
            data4: [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0],
        };
        assert_eq!(guid_to_string(&guid), "12345678-9abc-def0-1234-56789abcdef0");
    }

    #[test]
    fn adapter_kind_never_marks_tunnel_as_physical() {
        assert_eq!(adapter_kind(IF_TYPE_TUNNEL), ("Туннель / VPN", true, false));
        assert_eq!(adapter_kind(IF_TYPE_ETHERNET_CSMACD), ("Ethernet", false, true));
        assert_eq!(adapter_kind(IF_TYPE_IEEE80211), ("Wi-Fi", false, true));
    }

    #[test]
    fn sockaddr_parser_reads_ipv4_and_ipv6_without_network_io() {
        let mut v4 = [0u8; 16];
        v4[0..2].copy_from_slice(&(AF_INET as u16).to_ne_bytes());
        v4[4..8].copy_from_slice(&[1, 1, 1, 1]);
        let address4 = SOCKET_ADDRESS { lpSockaddr: v4.as_mut_ptr().cast(), iSockaddrLength: 16 };
        assert_eq!(unsafe { socket_address_to_ip(&address4) }, Some(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));

        let mut v6 = [0u8; 28];
        v6[0..2].copy_from_slice(&(AF_INET6 as u16).to_ne_bytes());
        v6[8..24].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
        let address6 = SOCKET_ADDRESS { lpSockaddr: v6.as_mut_ptr().cast(), iSockaddrLength: 28 };
        assert_eq!(unsafe { socket_address_to_ip(&address6) }, Some(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }
}
