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
    if snapshot.interface_guid.is_empty() || snapshot.interface_guid.len() > 64 {
        return Err("Invalid interface GUID in recovery record".into());
    }
    if !snapshot.eligible_physical_adapter {
        return Err("Recovery record was not captured for an eligible adapter".into());
    }
    for mode in [&snapshot.ipv4, &snapshot.ipv6] {
        match mode {
            SourceMode::Unknown => return Err("Recovery record contains unknown DNS mode".into()),
            SourceMode::Static(values) => {
                if values.is_empty() || values.len() > 32 || values.iter().any(|v| v.is_empty() || v.len() > 255) {
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

    fn no_staging_file(&self) -> Result<(), String> {
        if fs::symlink_metadata(self.staging_path()).is_ok() {
            return Err("Unfinished journal write detected; manual recovery review required".into());
        }
        Ok(())
    }

    fn load(&self) -> Result<Option<Snapshot>, String> {
        self.no_staging_file()?;
        let path = self.record_path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("Recovery journal metadata error: {err}")),
        };
        if !metadata.file_type().is_file() || metadata.len() > MAX_RECORD_BYTES {
            return Err("Recovery journal is not a regular bounded file".into());
        }
        let mut file = File::open(&path).map_err(|e| e.to_string())?;
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
            return Err(format!("Recovery record not durable; operation blocked: {error}"));
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
        windows_acl::create_or_verify_private_directory(&root)?;
        Ok(Self {
            inner: FileJournal::new(root),
        })
    }
}

#[cfg(windows)]
impl RecoveryJournal for ProtectedJournal {
    fn read(&self) -> Result<Option<Snapshot>, String> { self.inner.read() }
    fn save_before_changes(&mut self, original: &Snapshot) -> Result<(), String> {
        self.inner.save_before_changes(original)
    }
    fn clear_after_verified_restore(&mut self) -> Result<(), String> {
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

    struct MockBackend { fail_v6: bool }
    impl NetworkBackend for MockBackend {
        fn capture(&mut self, _: &str) -> Result<Snapshot, String> { Ok(original()) }
        fn apply_ipv4_loopback(&mut self, _: &str) -> Result<(), String> { Ok(()) }
        fn apply_ipv6_loopback(&mut self, _: &str) -> Result<(), String> {
            if self.fail_v6 { Err("IPv6 failure".into()) } else { Ok(()) }
        }
        fn verify_active(&mut self, _: &str) -> Result<(), String> { Ok(()) }
        fn restore_ipv4(&mut self, _: &Snapshot) -> Result<(), String> { Ok(()) }
        fn restore_ipv6(&mut self, _: &Snapshot) -> Result<(), String> { Ok(()) }
        fn verify_restored(&mut self, _: &Snapshot) -> Result<(), String> { Ok(()) }
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
