//! Independent, read-only Windows DNS registry evidence.
//! Registry NameServer is an independent observation, NOT proof of active
//! DHCPv4/DHCPv6/RA/NRPT/profile source and not a restorable snapshot.
//! Paths are documented by Microsoft Windows network-driver guidance.

use serde::Serialize;
use std::ffi::c_void;
use std::net::IpAddr;
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA};
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

const MAX_REGISTRY_BYTES: u32 = 4096;
const MAX_RESOLVERS: usize = 32;

#[derive(Clone, Debug, Serialize)]
pub struct RegistryDnsEvidence {
    /// None = missing value, Some([]) = existing but empty REG_SZ.
    /// Neither means that automatic DNS is definitively active.
    pub ipv4_static: Option<Vec<String>>,
    pub ipv4_dhcp: Option<Vec<String>>,
    pub ipv6_static: Option<Vec<String>>,
    pub ipv6_profile_static: Option<Vec<String>>,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn parse_reg_sz(words: &[u16]) -> Result<String, String> {
    if words.is_empty() || words.len() > (MAX_REGISTRY_BYTES as usize / 2) {
        return Err("Unexpected registry string length".into());
    }
    if *words.last().unwrap() != 0 || words[..words.len() - 1].contains(&0) {
        return Err("Registry DNS value is not a single terminated REG_SZ".into());
    }
    String::from_utf16(&words[..words.len() - 1])
        .map_err(|_| "Registry DNS value is not valid UTF-16".to_owned())
}

fn parse_servers(text: &str, ipv6: bool) -> Result<Vec<String>, String> {
    let mut servers = Vec::new();
    for field in text
        .split([',', ' ', '\t', '\r', '\n'])
        .filter(|s| !s.is_empty())
    {
        if servers.len() == MAX_RESOLVERS {
            return Err("Registry DNS server list exceeds safety limit".into());
        }
        let ip: IpAddr = field
            .parse()
            .map_err(|_| "Registry DNS list contains an invalid address".to_owned())?;
        if ip.is_ipv6() != ipv6 {
            return Err("Registry DNS list has wrong address family".into());
        }
        servers.push(field.to_owned());
    }
    Ok(servers)
}

fn read_reg_sz(subkey: &str, name: &str) -> Result<Option<String>, String> {
    let path = wide(subkey);
    let value_name = wide(name);
    let mut expected_bytes = 0u32;
    let code = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut expected_bytes,
        )
    };
    if code == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if code != 0 && code != ERROR_MORE_DATA {
        return Err(format!("Registry DNS read failed ({name}): {code}"));
    }
    if expected_bytes < 2 || expected_bytes > MAX_REGISTRY_BYTES || expected_bytes % 2 != 0 {
        return Err(format!("Registry DNS value has invalid size ({name})"));
    }
    // u16 allocation guarantees the required alignment for UTF-16.
    let mut words = vec![0u16; (expected_bytes / 2) as usize];
    let mut actual_bytes = expected_bytes;
    let code = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            words.as_mut_ptr().cast::<c_void>(),
            &mut actual_bytes,
        )
    };
    if code != 0 || actual_bytes == 0 || actual_bytes > expected_bytes || actual_bytes % 2 != 0 {
        return Err(format!(
            "Registry DNS changed or could not be read ({name}): {code}"
        ));
    }
    words.truncate((actual_bytes / 2) as usize);
    Ok(Some(parse_reg_sz(&words)?))
}

pub(super) fn inspect(interface_guid: &str) -> Result<RegistryDnsEvidence, String> {
    // All GUIDs originate from the validated Windows adapter inventory.
    super::parse_guid(interface_guid)?;
    let guid = format!("{{{}}}", interface_guid);
    let v4_path =
        format!("SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{guid}");
    let v6_path =
        format!("SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\Interfaces\\{guid}");
    Ok(RegistryDnsEvidence {
        ipv4_static: read_reg_sz(&v4_path, "NameServer")?
            .map(|v| parse_servers(&v, false))
            .transpose()?,
        ipv4_dhcp: read_reg_sz(&v4_path, "DhcpNameServer")?
            .map(|v| parse_servers(&v, false))
            .transpose()?,
        ipv6_static: read_reg_sz(&v6_path, "NameServer")?
            .map(|v| parse_servers(&v, true))
            .transpose()?,
        ipv6_profile_static: read_reg_sz(&v6_path, "ProfileNameServer")?
            .map(|v| parse_servers(&v, true))
            .transpose()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_well_formed_terminated_reg_sz() {
        let valid: Vec<u16> = "2001:db8::1".encode_utf16().chain([0]).collect();
        assert_eq!(parse_reg_sz(&valid).unwrap(), "2001:db8::1");
        assert!(parse_reg_sz(&[65, 66]).is_err());
        assert!(parse_reg_sz(&[65, 0, 66, 0]).is_err());
        assert!(parse_reg_sz(&[0xD800, 0]).is_err());
        assert!(parse_reg_sz(&[]).is_err());
    }

    #[test]
    fn rejects_wrong_family_invalid_and_overlong_dns_lists() {
        assert!(parse_servers("1.1.1.1, 8.8.8.8", false).is_ok());
        assert!(parse_servers("2001:db8::1 2606:4700:4700::1111", true).is_ok());
        assert!(parse_servers("1.1.1.1,::1", false).is_err());
        assert!(parse_servers("::1", false).is_err());
        assert!(parse_servers("8.8.8.8", true).is_err());
        assert!(parse_servers("not-dns", false).is_err());
        assert!(parse_servers(&vec!["1.1.1.1"; 33].join(","), false).is_err());
        assert_eq!(parse_servers("", false).unwrap(), Vec::<String>::new());
    }
}
