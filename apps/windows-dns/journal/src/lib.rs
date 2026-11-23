//! Persistent, fail-closed DNS recovery record. Never stores personal DNS credentials.
//!
//! A record is created and synced BEFORE network mutation. It remains on disk
//! while DNS is enabled and is deleted only after verified restoration.
//! The checksum detects accidental corruption, not administrator tampering.
//! The GUI does not use or open the protected directory.

use mnebydns_transaction::{RecoveryJournal, Snapshot, SourceMode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

#[cfg(windows)]
mod windows_acl;

const SCHEMA_VERSION: u16 = 1;
const MAX_RECORD_BYTES: u64 = 16 * 1024;
const RECORD_NAME: &str = "recovery-v1.json";
const STAGING_NAME: &str = "recovery-v1.writing";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u16,
    snapshot: Snapshot,
    snapshot_sha256: String,
}

impl Record {
    fn new(snapshot: &Snapshot) -> Result<Self, String> {
        let bytes = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
        let digest = Sha256::digest(bytes);
        Ok(Self {
            version: SCHEMA_VERSION,
            snapshot: snapshot.clone(),
            snapshot_sha256: format!("{digest:x}"),
        })
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != SCHEMA_VERSION {
            return Err("Unsupported recovery journal version".into());
        }
        validate_snapshot(&self.snapshot)?;
        let data = serde_json::to_vec(&self.snapshot).map_err(|e| e.to_string())?;
        let digest = Sha256::digest(data);
        if self.snapshot_sha256 != format!("{digest:x}") {
            return Err("Recovery journal integrity check failed".into());
        }
        Ok(())
    }
}

fn validate_snapshot(snapshot: &Snapshot) -> Result<(), String> {
    let fields: Vec<_> = snapshot.interface_guid.split('-').collect();
    if fields.len() != 5
        || fields
            .iter()
            .zip([8, 4, 4, 4, 12])
            .any(|(part, len)| part.len() != len || !part.bytes().all(|ch| ch.is_ascii_hexdigit()))
    {
        return Err("Invalid interface GUID in recovery record".into());
    }
    if !snapshot.eligible_physical_adapter {
        return Err("Recovery record was not captured for an eligible adapter".into());
    }
    for (mode, is_ipv6) in [(&snapshot.ipv4, false), (&snapshot.ipv6, true)] {
        match mode {
            SourceMode::Unknown => return Err("Recovery record contains unknown DNS mode".into()),
            SourceMode::Static(values) => {
                if values.is_empty()
                    || values.len() > 32
                    || values.iter().any(|value| {
                        if value.len() > 255 {
                            return true;
                        }
                        if is_ipv6 {
                            value.parse::<Ipv6Addr>().is_err()
                        } else {
                            value.parse::<Ipv4Addr>().is_err()
                        }
                    })
                {
                    return Err("Invalid static DNS snapshot".into());
                }
            }
            SourceMode::Automatic => {}
        }
    }
    Ok(())
}

pub struct FileJournal {
    directory: PathBuf,
}

impl FileJournal {
    // Deliberately private; production callers must use ProtectedJournal.
    fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn record_path(&self) -> PathBuf {
        self.directory.join(RECORD_NAME)
    }

    fn staging_path(&self) -> PathBuf {
        self.directory.join(STAGING_NAME)
    }

    /// Validate one bounded regular file independently. We do not interpret an
    /// absent file as an empty recovery journal until BOTH filenames are checked.
    fn read_valid_record(&self, path: &std::path::Path) -> Result<Option<Snapshot>, String> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("Recovery journal metadata error: {err}")),
        };
        if !metadata.file_type().is_file() || metadata.len() > MAX_RECORD_BYTES {
            return Err("Recovery journal is not a regular bounded file".into());
        }
        let file = File::open(path).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err("Recovery journal size limit exceeded".into());
        }
        let record: Record = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Recovery journal corrupted: {e}"))?;
        record.validate()?;
        Ok(Some(record.snapshot))
    }

    fn load(&self) -> Result<Option<Snapshot>, String> {
        let committed = self.read_valid_record(&self.record_path())?;
        let staging = self.read_valid_record(&self.staging_path())?;

        match (committed, staging) {
            (None, None) => Ok(None),
            (Some(snapshot), None) => Ok(Some(snapshot)),
            (None, Some(_)) => Err(
                "Only a staging journal exists: interrupted save; manual recovery review required"
                    .into(),
            ),
            (Some(snapshot), Some(staged)) if snapshot == staged => {
                // Crash after hard-link commit but before staging cleanup:
                // allow recovery using the VALID committed copy, while save()
                // will continue to refuse a second activation.
                Ok(Some(snapshot))
            }
            (Some(_), Some(_)) => {
                Err("Staging and committed recovery records differ; manual review required".into())
            }
        }
    }

    fn save(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        validate_snapshot(snapshot)?;
        if self.load()?.is_some() {
            return Err("Pending recovery exists; refusing to overwrite it".into());
        }
        let bytes = serde_json::to_vec(&Record::new(snapshot)?)
            .map_err(|e| format!("Journal encoding failed: {e}"))?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err("Recovery snapshot is too large".into());
        }
        let staging = self.staging_path();
        let record_path = self.record_path();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|e| format!("Cannot create recovery staging record: {e}"))?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            // Keep a failed staging record in place to block all further mutations
            // until an administrator investigates; never erase evidence blindly.
            return Err(format!(
                "Recovery record not durable; operation blocked: {error}"
            ));
        }
        drop(file);

        // Hard-link is atomic on supported local NTFS/ReFS volumes, fails
        // if the final name exists, and does not overwrite recovery history.
        // Unsupported file systems fail closed before DNS can be changed.
        fs::hard_link(&staging, &record_path)
            .map_err(|e| format!("Cannot commit recovery record: {e}"))?;
        fs::remove_file(&staging)
            .map_err(|e| format!("Record committed but staging cleanup failed: {e}"))?;

        // Re-read and checksum the committed record before allowing activation.
        if self.load()?.as_ref() != Some(snapshot) {
            return Err("Committed recovery journal does not match snapshot".into());
        }
        Ok(())
    }

    fn clear(&mut self) -> Result<(), String> {
        if self.load()?.is_none() {
            return Err("Cannot clear journal: no recovery record exists".into());
        }
        // If power was lost after the hard-link commit, delete staging FIRST.
        // A crash during cleanup must leave the committed recovery record readable.
        match fs::remove_file(self.staging_path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot remove recovery staging file: {error}")),
        }
        fs::remove_file(self.record_path())
            .map_err(|e| format!("Cannot remove verified recovery record: {e}"))
    }
}

impl RecoveryJournal for FileJournal {
    fn read(&self) -> Result<Option<Snapshot>, String> {
        self.load()
    }
    fn save_before_changes(&mut self, original: &Snapshot) -> Result<(), String> {
        self.save(original)
    }
    fn clear_after_verified_restore(&mut self) -> Result<(), String> {
        self.clear()
    }
}

/// Only a privileged Windows service should be allowed to construct this type.
/// The directory DACL is checked every time it is opened.
/// Installer-only one-time provision. Never called by the Windows service or GUI.
/// Rejects preexisting directories whose DACL is not the expected protected ACL.
#[cfg(windows)]
pub fn provision_for_installer() -> Result<(), String> {
    let program_data = std::env::var_os("ProgramData")
        .ok_or_else(|| "ProgramData system directory is unknown".to_owned())?;
    let root = Path::new(&program_data).join("mnebydns-controller-v1");
    windows_acl::create_or_verify_private_directory(&root)
}

const CONFIG_NAME: &str = "controller-v1.json";
const CONFIG_STAGING_NAME: &str = "controller-v1.writing";
const MAX_CONFIG_BYTES: u64 = 16 * 1024;
const SYSTEM_RECORD_PREFIX: &str = "system-dns-";
const SYSTEM_STAGING_SUFFIX: &str = ".writing";
const MAX_SYSTEM_RECORDS: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerConfig {
    pub version: u16,
    pub enabled: bool,
    pub dot_host: String,
    pub upstream_addresses: Vec<std::net::SocketAddr>,
}

impl ControllerConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported DNS controller configuration version".into());
        }
        let host = self.dot_host.as_str();
        if host.len() < 4
            || host.len() > 253
            || !host.is_ascii()
            || host.contains("://")
            || host.contains(':')
            || host.chars().any(char::is_whitespace)
            || host.parse::<std::net::IpAddr>().is_ok()
        {
            return Err("Invalid personal DoT hostname in controller configuration".into());
        }
        for label in host.split('.') {
            if label.is_empty()
                || label.len() > 63
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || label.starts_with('-')
                || label.ends_with('-')
            {
                return Err("Invalid personal DoT hostname label".into());
            }
        }
        if self.enabled && self.upstream_addresses.is_empty() {
            return Err("Enabled DNS controller has no pinned DoT upstream addresses".into());
        }
        if self.upstream_addresses.len() > 5
            || self.upstream_addresses.iter().any(|address| {
                address.port() != 853
                    || address.ip().is_loopback()
                    || address.ip().is_unspecified()
                    || address.ip().is_multicast()
            })
        {
            return Err("Invalid pinned DoT upstream address list".into());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SystemRecord {
    version: u16,
    snapshot: mnebydns_network::AdapterDnsSnapshot,
    snapshot_sha256: String,
}

impl SystemRecord {
    fn new(snapshot: &mnebydns_network::AdapterDnsSnapshot) -> Result<Self, String> {
        let bytes = serde_json::to_vec(snapshot).map_err(|error| error.to_string())?;
        let digest = Sha256::digest(bytes);
        Ok(Self {
            version: 1,
            snapshot: snapshot.clone(),
            snapshot_sha256: format!("{digest:x}"),
        })
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported system DNS recovery record version".into());
        }
        validate_system_snapshot(&self.snapshot)?;
        let bytes = serde_json::to_vec(&self.snapshot).map_err(|error| error.to_string())?;
        let digest = Sha256::digest(bytes);
        if self.snapshot_sha256 != format!("{digest:x}") {
            return Err("System DNS recovery record checksum mismatch".into());
        }
        Ok(())
    }
}

fn validate_system_snapshot(snapshot: &mnebydns_network::AdapterDnsSnapshot) -> Result<(), String> {
    let parts: Vec<_> = snapshot.interface_guid.split('-').collect();
    if parts.len() != 5
        || parts.iter().zip([8, 4, 4, 4, 12]).any(|(part, size)| {
            part.len() != size || !part.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err("Invalid interface GUID in system DNS recovery record".into());
    }
    if snapshot.adapter_name.is_empty() || snapshot.adapter_name.len() > 512 {
        return Err("Invalid adapter name in system DNS recovery record".into());
    }
    for (mode, ipv6) in [
        (&snapshot.ipv4, false),
        (&snapshot.ipv4_profile, false),
        (&snapshot.ipv6, true),
        (&snapshot.ipv6_profile, true),
    ] {
        if let mnebydns_network::DnsServerMode::Static(values) = mode {
            if values.is_empty() || values.len() > 32 {
                return Err("Invalid static DNS server list in recovery record".into());
            }
            for value in values {
                if value.len() > 255 {
                    return Err("DNS address too long in recovery record".into());
                }
                let address: std::net::IpAddr = value
                    .parse()
                    .map_err(|_| "Invalid DNS IP in recovery record".to_owned())?;
                if address.is_ipv6() != ipv6 {
                    return Err("Wrong DNS address family in recovery record".into());
                }
            }
        }
    }
    Ok(())
}

fn validate_system_guid(guid: &str) -> Result<(), String> {
    let parts: Vec<_> = guid.split('-').collect();
    if parts.len() != 5
        || parts.iter().zip([8, 4, 4, 4, 12]).any(|(part, size)| {
            part.len() != size || !part.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err("Invalid adapter GUID for system DNS journal path".into());
    }
    Ok(())
}

/// Append-only per-interface journal. A record is committed before the
/// corresponding adapter is modified. New adapters can be added while active.
pub struct SystemDnsJournal {
    directory: PathBuf,
}

impl SystemDnsJournal {
    fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn record_path(&self, guid: &str) -> Result<PathBuf, String> {
        validate_system_guid(guid)?;
        Ok(self
            .directory
            .join(format!("{SYSTEM_RECORD_PREFIX}{guid}.json")))
    }

    fn staging_path(&self, guid: &str) -> Result<PathBuf, String> {
        validate_system_guid(guid)?;
        Ok(self.directory.join(format!(
            "{SYSTEM_RECORD_PREFIX}{guid}{SYSTEM_STAGING_SUFFIX}"
        )))
    }

    fn read_one(
        &self,
        path: &Path,
    ) -> Result<Option<mnebydns_network::AdapterDnsSnapshot>, String> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("System DNS journal metadata error: {error}")),
        };
        if !metadata.file_type().is_file() || metadata.len() > MAX_RECORD_BYTES {
            return Err("System DNS journal record is not a bounded regular file".into());
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|error| error.to_string())?
            .take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err("System DNS journal record exceeds size limit".into());
        }
        let record: SystemRecord = serde_json::from_slice(&bytes)
            .map_err(|error| format!("System DNS journal record is corrupt: {error}"))?;
        record.validate()?;
        Ok(Some(record.snapshot))
    }

    /// A power loss after hard_link(staging, committed) but before removing
    /// staging leaves TWO valid identical copies. Only that fully committed
    /// case can be repaired automatically: the committed backup is retained.
    /// A staging file without a committed twin must still block all changes.
    fn reconcile_committed_staging(&self, filename: &str) -> Result<(), String> {
        let guid = filename
            .strip_prefix(SYSTEM_RECORD_PREFIX)
            .and_then(|tail| tail.strip_suffix(SYSTEM_STAGING_SUFFIX))
            .ok_or_else(|| "Malformed system DNS staging filename".to_owned())?;
        validate_system_guid(guid)?;
        let staged = self.staging_path(guid)?;
        let committed = self.record_path(guid)?;
        let staged_record = self.read_one(&staged)?.ok_or_else(|| {
            "System DNS staging record disappeared during reconciliation".to_owned()
        })?;
        let committed_record = self.read_one(&committed)?.ok_or_else(|| {
            "Uncommitted system DNS staging backup requires manual review; original evidence retained".to_owned()
        })?;
        if staged_record != committed_record
            || !committed_record.interface_guid.eq_ignore_ascii_case(guid)
        {
            return Err("Staged and committed DNS snapshots disagree; no automatic cleanup".into());
        }
        fs::remove_file(staged).map_err(|error| {
            format!("Could not clean verified duplicate DNS staging record: {error}")
        })?;
        Ok(())
    }

    pub fn read_all(&self) -> Result<Vec<mnebydns_network::AdapterDnsSnapshot>, String> {
        let mut records: Vec<mnebydns_network::AdapterDnsSnapshot> = Vec::new();
        for entry in fs::read_dir(&self.directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(SYSTEM_RECORD_PREFIX) {
                continue;
            }
            if name.ends_with(SYSTEM_STAGING_SUFFIX) {
                self.reconcile_committed_staging(&name)?;
                continue;
            }
            if !name.ends_with(".json") {
                continue;
            }
            let file_guid = name
                .strip_prefix(SYSTEM_RECORD_PREFIX)
                .and_then(|value| value.strip_suffix(".json"))
                .ok_or_else(|| "Malformed system DNS recovery filename".to_owned())?;
            validate_system_guid(file_guid)?;
            let snapshot = self
                .read_one(&entry.path())?
                .ok_or_else(|| "System DNS recovery record disappeared".to_owned())?;
            if !snapshot.interface_guid.eq_ignore_ascii_case(file_guid) {
                return Err("System DNS recovery filename does not match its adapter GUID".into());
            }
            if records.iter().any(|item| {
                item.interface_guid
                    .eq_ignore_ascii_case(&snapshot.interface_guid)
            }) {
                return Err("Duplicate adapter in system DNS recovery journal".into());
            }
            records.push(snapshot);
            if records.len() > MAX_SYSTEM_RECORDS {
                return Err("System DNS recovery journal contains too many adapters".into());
            }
        }
        records.sort_by(|left, right| left.interface_guid.cmp(&right.interface_guid));
        Ok(records)
    }

    pub fn save_before_change(
        &mut self,
        snapshot: &mnebydns_network::AdapterDnsSnapshot,
    ) -> Result<(), String> {
        validate_system_snapshot(snapshot)?;
        let committed = self.record_path(&snapshot.interface_guid)?;
        let staging = self.staging_path(&snapshot.interface_guid)?;
        if committed.exists() || staging.exists() {
            return Err("A system DNS recovery record already exists for this adapter".into());
        }
        if self.read_all()?.len() >= MAX_SYSTEM_RECORDS {
            return Err("System DNS recovery journal adapter limit reached".into());
        }
        let bytes =
            serde_json::to_vec(&SystemRecord::new(snapshot)?).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|error| format!("Cannot create system DNS staging record: {error}"))?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            return Err(format!("System DNS backup was not made durable: {error}"));
        }
        drop(file);
        fs::hard_link(&staging, &committed)
            .map_err(|error| format!("Cannot commit system DNS backup: {error}"))?;
        fs::remove_file(&staging).map_err(|error| {
            format!("System DNS backup committed but staging cleanup failed: {error}")
        })?;
        if self.read_one(&committed)?.as_ref() != Some(snapshot) {
            return Err("System DNS backup read-back does not match the original snapshot".into());
        }
        Ok(())
    }

    pub fn clear_verified(&mut self, guid: &str) -> Result<(), String> {
        let path = self.record_path(guid)?;
        let staging = self.staging_path(guid)?;
        if staging.exists() {
            let name = staging.file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Invalid system DNS staging filename".to_owned())?;
            self.reconcile_committed_staging(name)?;
        }
        if self.read_one(&path)?.is_none() {
            return Err("System DNS recovery record is missing".into());
        }
        fs::remove_file(path).map_err(|error| format!("Cannot clear verified DNS backup: {error}"))
    }

    pub fn has_pending(&self) -> Result<bool, String> {
        Ok(!self.read_all()?.is_empty())
    }
}

#[cfg(windows)]
pub struct ProtectedJournal {
    inner: FileJournal,
}

#[cfg(windows)]
impl ProtectedJournal {
    pub fn open_service() -> Result<Self, String> {
        let program_data = std::env::var_os("ProgramData")
            .ok_or_else(|| "ProgramData system directory is unknown".to_owned())?;
        let root = Path::new(&program_data).join("mnebydns-controller-v1");
        // The INSTALLER must provision this directory first. Never create a
        // fresh empty recovery directory on service restart: that would make
        // deletion of a pending journal look like a clean configuration.
        windows_acl::verify_existing_private_directory(&root)?;
        Ok(Self {
            inner: FileJournal::new(root),
        })
    }

    pub fn check_recovery_pending(&self) -> Result<bool, String> {
        windows_acl::verify_existing_private_directory(&self.inner.directory)?;
        Ok(self.inner.load()?.is_some())
    }

    /// Only a privileged Windows service should use this path. The GUI must
    /// use authenticated IPC in a future stage, not open protected state files.
    pub fn protected_status_path(&self) -> Result<PathBuf, String> {
        windows_acl::verify_existing_private_directory(&self.inner.directory)?;
        Ok(self.inner.directory.join("health-v1.json"))
    }

    pub fn system_dns_journal(&self) -> Result<SystemDnsJournal, String> {
        windows_acl::verify_existing_private_directory(&self.inner.directory)?;
        Ok(SystemDnsJournal::new(self.inner.directory.clone()))
    }

    pub fn read_controller_config(&self) -> Result<Option<ControllerConfig>, String> {
        windows_acl::verify_existing_private_directory(&self.inner.directory)?;
        let path = self.inner.directory.join(CONFIG_NAME);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.file_type().is_file() || metadata.len() > MAX_CONFIG_BYTES {
            return Err("DNS controller configuration is not a bounded regular file".into());
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|error| error.to_string())?
            .take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err("DNS controller configuration exceeds size limit".into());
        }
        let config: ControllerConfig =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        config.validate()?;
        Ok(Some(config))
    }

    pub fn write_controller_config(&self, config: &ControllerConfig) -> Result<(), String> {
        windows_acl::verify_existing_private_directory(&self.inner.directory)?;
        config.validate()?;
        let staging = self.inner.directory.join(CONFIG_STAGING_NAME);
        let target = self.inner.directory.join(CONFIG_NAME);
        if staging.exists() {
            return Err("An interrupted DNS controller configuration write requires review".into());
        }
        let bytes = serde_json::to_vec(config).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err("DNS controller configuration is too large".into());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|error| {
                format!("Cannot create controller configuration staging file: {error}")
            })?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Cannot persist controller configuration: {error}"))?;
        drop(file);
        fs::rename(&staging, &target)
            .map_err(|error| format!("Cannot commit controller configuration: {error}"))?;
        if self.read_controller_config()?.as_ref() != Some(config) {
            return Err("Controller configuration read-back mismatch".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl RecoveryJournal for ProtectedJournal {
    fn read(&self) -> Result<Option<Snapshot>, String> {
        windows_acl::verify_existing_private_directory(&self.inner.directory)?;
        self.inner.read()
    }
    fn save_before_changes(&mut self, original: &Snapshot) -> Result<(), String> {
        windows_acl::verify_existing_private_directory(&self.inner.directory)?;
        self.inner.save_before_changes(original)
    }
    fn clear_after_verified_restore(&mut self) -> Result<(), String> {
        windows_acl::verify_existing_private_directory(&self.inner.directory)?;
        self.inner.clear_after_verified_restore()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnebydns_transaction::{activate, restore, NetworkBackend};
    use tempfile::TempDir;

    fn original() -> Snapshot {
        Snapshot {
            interface_guid: "12345678-9abc-def0-1234-56789abcdef0".into(),
            eligible_physical_adapter: true,
            ipv4: SourceMode::Automatic,
            ipv6: SourceMode::Static(vec!["2001:4860:4860::8888".into()]),
        }
    }

    fn journal() -> (TempDir, FileJournal) {
        let temp = tempfile::tempdir().unwrap();
        let journal = FileJournal::new(temp.path().to_path_buf());
        (temp, journal)
    }

    #[test]
    fn persists_across_instances_and_clears_only_explicitly() {
        let (_dir, mut first) = journal();
        let snapshot = original();
        first.save_before_changes(&snapshot).unwrap();
        let reopened = FileJournal::new(first.directory.clone());
        assert_eq!(reopened.read().unwrap(), Some(snapshot));
        assert!(first.save_before_changes(&original()).is_err());
        first.clear_after_verified_restore().unwrap();
        assert!(reopened.read().unwrap().is_none());
    }

    #[test]
    fn orphaned_staging_record_blocks_both_reads_and_new_activation() {
        let (_dir, mut journal) = journal();
        File::create(journal.staging_path()).unwrap();
        assert!(journal.read().is_err());
        assert!(journal.save_before_changes(&original()).is_err());
        assert!(journal.staging_path().exists());
    }

    #[test]
    fn interrupted_post_commit_cleanup_still_allows_verified_restore() {
        let (_dir, mut journal) = journal();
        let snapshot = original();
        journal.save_before_changes(&snapshot).unwrap();
        // Simulate crash after hard_link(staging, committed), before staging removal.
        fs::hard_link(journal.record_path(), journal.staging_path()).unwrap();
        let reopened = FileJournal::new(journal.directory.clone());
        assert_eq!(reopened.read().unwrap(), Some(snapshot.clone()));
        assert!(journal.save_before_changes(&snapshot).is_err());
        journal.clear_after_verified_restore().unwrap();
        assert!(!journal.record_path().exists());
        assert!(!journal.staging_path().exists());
    }

    #[test]
    fn mismatched_staging_and_committed_files_block_recovery() {
        let (_dir, mut journal) = journal();
        journal.save_before_changes(&original()).unwrap();
        let mut different = original();
        different.ipv6 = SourceMode::Automatic;
        let staged_record = serde_json::to_vec(&Record::new(&different).unwrap()).unwrap();
        fs::write(journal.staging_path(), staged_record).unwrap();
        assert!(journal.read().is_err());
        assert!(journal.clear_after_verified_restore().is_err());
        assert!(journal.record_path().exists());
    }

    #[test]
    fn ipv4_ipv6_and_guid_validation_rejects_malformed_snapshot() {
        let (_dir, mut journal) = journal();
        let mut snapshot = original();
        snapshot.interface_guid = "not-a-windows-guid".to_owned();
        assert!(journal.save_before_changes(&snapshot).is_err());
        snapshot = original();
        snapshot.ipv4 = SourceMode::Static(vec!["not-an-ip".to_owned()]);
        assert!(journal.save_before_changes(&snapshot).is_err());
        snapshot = original();
        snapshot.ipv6 = SourceMode::Static(vec!["1.1.1.1".to_owned()]);
        assert!(journal.save_before_changes(&snapshot).is_err());
        assert!(journal.read().unwrap().is_none());
    }

    #[test]
    fn corrupt_checksum_never_falls_back_to_empty_journal() {
        let (_dir, mut journal) = journal();
        journal.save_before_changes(&original()).unwrap();
        let path = journal.record_path();
        let mut bytes = fs::read(&path).unwrap();
        let idx = bytes.iter().position(|&x| x == b'8').unwrap();
        bytes[idx] = b'9';
        fs::write(path, bytes).unwrap();
        assert!(journal.read().is_err());
        assert!(journal.save_before_changes(&original()).is_err());
    }

    #[test]
    fn refuses_invalid_dns_modes() {
        let (_dir, mut journal) = journal();
        let mut snapshot = original();
        snapshot.ipv6 = SourceMode::Unknown;
        assert!(journal.save_before_changes(&snapshot).is_err());
        assert!(journal.read().unwrap().is_none());
    }

    struct MockBackend {
        fail_v6: bool,
    }
    impl NetworkBackend for MockBackend {
        fn capture(&mut self, _: &str) -> Result<Snapshot, String> {
            Ok(original())
        }
        fn verify_pre_apply(&mut self, _: &Snapshot) -> Result<(), String> {
            Ok(())
        }
        fn verify_restore_target(&mut self, _: &Snapshot) -> Result<(), String> {
            Ok(())
        }
        fn apply_ipv4_loopback(&mut self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn apply_ipv6_loopback(&mut self, _: &str) -> Result<(), String> {
            if self.fail_v6 {
                Err("IPv6 failure".into())
            } else {
                Ok(())
            }
        }
        fn verify_active(&mut self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn restore_ipv4(&mut self, _: &Snapshot) -> Result<(), String> {
            Ok(())
        }
        fn restore_ipv6(&mut self, _: &Snapshot) -> Result<(), String> {
            Ok(())
        }
        fn verify_restored(&mut self, _: &Snapshot) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn real_disk_journal_is_kept_until_restoration() {
        let (_dir, mut journal) = journal();
        let guid = original().interface_guid;
        let mut network = MockBackend { fail_v6: false };
        activate(&guid, &mut network, &mut journal).unwrap();
        assert!(journal.record_path().exists());
        restore(&mut network, &mut journal).unwrap();
        assert!(!journal.record_path().exists());
    }

    #[test]
    fn failure_rolls_back_and_deletes_record_only_after_verification() {
        let (_dir, mut journal) = journal();
        let guid = original().interface_guid;
        let mut network = MockBackend { fail_v6: true };
        assert!(activate(&guid, &mut network, &mut journal).is_err());
        assert!(journal.read().unwrap().is_none());
    }
}

#[cfg(test)]
mod system_dns_tests {
    use super::*;
    use mnebydns_network::DnsServerMode;

    fn snapshot() -> mnebydns_network::AdapterDnsSnapshot {
        mnebydns_network::AdapterDnsSnapshot {
            interface_guid: "12345678-9abc-def0-1234-56789abcdef0".into(),
            adapter_name: "Wi-Fi".into(),
            ipv4: DnsServerMode::Automatic,
            ipv6: DnsServerMode::Static(vec!["2001:4860:4860::8888".into()]),
            ipv4_profile: DnsServerMode::Automatic,
            ipv6_profile: DnsServerMode::Automatic,
        }
    }

    #[test]
    fn system_journal_persists_snapshot_until_verified_clear() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = SystemDnsJournal::new(directory.path().to_path_buf());
        let original = snapshot();
        journal.save_before_change(&original).unwrap();
        assert_eq!(journal.read_all().unwrap(), vec![original.clone()]);
        assert!(journal.save_before_change(&original).is_err());
        journal.clear_verified(&original.interface_guid).unwrap();
        assert!(journal.read_all().unwrap().is_empty());
    }

    #[test]
    fn interrupted_system_journal_write_blocks_activation_and_restore() {
        let directory = tempfile::tempdir().unwrap();
        let journal = SystemDnsJournal::new(directory.path().to_path_buf());
        fs::write(
            journal
                .staging_path("12345678-9abc-def0-1234-56789abcdef0")
                .unwrap(),
            b"incomplete",
        )
        .unwrap();
        assert!(journal.read_all().is_err());
        assert!(journal.has_pending().is_err());
    }

    #[test]
    fn system_journal_checksum_corruption_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = SystemDnsJournal::new(directory.path().to_path_buf());
        let original = snapshot();
        journal.save_before_change(&original).unwrap();
        let path = journal.record_path(&original.interface_guid).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let index = bytes.iter().position(|byte| *byte == b'W').unwrap();
        bytes[index] = b'X';
        fs::write(path, bytes).unwrap();
        assert!(journal.read_all().is_err());
    }

    #[test]
    fn controller_config_requires_pinned_dot_address_when_enabled() {
        let config = ControllerConfig {
            version: 1,
            enabled: true,
            dot_host: "dns.example.net".into(),
            upstream_addresses: Vec::new(),
        };
        assert!(config.validate().is_err());
        let disabled = ControllerConfig {
            enabled: false,
            ..config
        };
        assert!(disabled.validate().is_ok());
    }

    #[test]
    fn controller_config_rejects_invalid_host_and_non_dot_port() {
        let invalid_host = ControllerConfig {
            version: 1,
            enabled: false,
            dot_host: "https://dns.example.net/dns-query".into(),
            upstream_addresses: Vec::new(),
        };
        assert!(invalid_host.validate().is_err());
        let invalid_port = ControllerConfig {
            version: 1,
            enabled: true,
            dot_host: "dns.example.net".into(),
            upstream_addresses: vec!["192.0.2.1:443".parse().unwrap()],
        };
        assert!(invalid_port.validate().is_err());
    }
}
