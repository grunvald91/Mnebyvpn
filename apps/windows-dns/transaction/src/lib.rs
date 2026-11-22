//! Platform-independent DNS transaction state machine.
//! This module is intentionally NOT wired to the Windows networking API yet.
//! Production integration requires a protected durable journal, privileged service,
//! verified DNSProxy DoT connectivity, and tested Windows adapter restore logic.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceMode {
    Automatic,
    Static(Vec<String>),
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub interface_guid: String,
    pub eligible_physical_adapter: bool,
    pub ipv4: SourceMode,
    pub ipv6: SourceMode,
}

/// The journal MUST be durable before any changes and retained until verified restoration.
/// A pending journal on boot requires recovery, never an optimistic re-activation.
pub trait RecoveryJournal {
    fn read(&self) -> Result<Option<Snapshot>, String>;
    fn save_before_changes(&mut self, original: &Snapshot) -> Result<(), String>;
    fn clear_after_verified_restore(&mut self) -> Result<(), String>;
}

/// Only a future privileged Windows service may implement this trait in production.
/// It must restore both sources, including DHCP/RA, exactly as captured.
pub trait NetworkBackend {
    fn capture(&mut self, interface_guid: &str) -> Result<Snapshot, String>;
    fn apply_ipv4_loopback(&mut self, interface_guid: &str) -> Result<(), String>;
    fn apply_ipv6_loopback(&mut self, interface_guid: &str) -> Result<(), String>;
    fn verify_active(&mut self, interface_guid: &str) -> Result<(), String>;
    fn restore_ipv4(&mut self, original: &Snapshot) -> Result<(), String>;
    fn restore_ipv6(&mut self, original: &Snapshot) -> Result<(), String>;
    fn verify_restored(&mut self, original: &Snapshot) -> Result<(), String>;
}

fn validate(original: &Snapshot, requested_guid: &str) -> Result<(), String> {
    if original.interface_guid != requested_guid || !original.eligible_physical_adapter {
        return Err("Adapter identity or type is not approved".to_owned());
    }
    match (&original.ipv4, &original.ipv6) {
        (SourceMode::Unknown, _) | (_, SourceMode::Unknown) => {
            Err("Unknown IPv4/IPv6 DNS source: switching is blocked".to_owned())
        }
        _ => Ok(()),
    }
}

/// Restores both address families, even if the first restore fails.
/// Do not erase recovery data until both restores and verification succeed.
pub fn restore<B: NetworkBackend, J: RecoveryJournal>(
    backend: &mut B,
    journal: &mut J,
) -> Result<(), String> {
    let original = journal
        .read()?
        .ok_or_else(|| "No saved DNS configuration in recovery journal".to_owned())?;
    let v4 = backend.restore_ipv4(&original);
    let v6 = backend.restore_ipv6(&original);
    if let (Err(a), Err(b)) = (&v4, &v6) {
        return Err(format!(
            "Both restorations failed: IPv4: {a}; IPv6: {b}; recovery journal kept"
        ));
    }
    if let Err(error) = v4 {
        return Err(format!(
            "IPv4 restore failed: {error}; recovery journal kept"
        ));
    }
    if let Err(error) = v6 {
        return Err(format!(
            "IPv6 restore failed: {error}; recovery journal kept"
        ));
    }
    backend.verify_restored(&original).map_err(|error| {
        format!("DNS restore verification failed: {error}; recovery journal kept")
    })?;
    journal.clear_after_verified_restore()?;
    Ok(())
}

/// Must be invoked only by a privileged backend after DNSProxy is TLS-validated.
/// The pending journal stays in place while the connection is active.
pub fn activate<B: NetworkBackend, J: RecoveryJournal>(
    requested_guid: &str,
    backend: &mut B,
    journal: &mut J,
) -> Result<(), String> {
    if journal.read()?.is_some() {
        return Err("Pending recovery journal exists; restore before activation".to_owned());
    }
    let original = backend.capture(requested_guid)?;
    validate(&original, requested_guid)?;
    journal.save_before_changes(&original)?;

    let applied = backend
        .apply_ipv4_loopback(requested_guid)
        .and_then(|_| backend.apply_ipv6_loopback(requested_guid))
        .and_then(|_| backend.verify_active(requested_guid));
    if let Err(error) = applied {
        return match restore(backend, journal) {
            Ok(()) => Err(format!(
                "DNS activation failed, original settings restored: {error}"
            )),
            Err(recovery_error) => Err(format!(
                "DNS activation failed: {error}; RECOVERY REQUIRED: {recovery_error}"
            )),
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockJournal {
        saved: Option<Snapshot>,
        fail_save: bool,
    }
    impl RecoveryJournal for MockJournal {
        fn read(&self) -> Result<Option<Snapshot>, String> {
            Ok(self.saved.clone())
        }
        fn save_before_changes(&mut self, original: &Snapshot) -> Result<(), String> {
            if self.fail_save {
                return Err("disk unavailable".to_owned());
            }
            self.saved = Some(original.clone());
            Ok(())
        }
        fn clear_after_verified_restore(&mut self) -> Result<(), String> {
            self.saved = None;
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockBackend {
        calls: Vec<&'static str>,
        fail_v6_apply: bool,
        fail_v4_restore: bool,
        fail_health: bool,
        unknown_mode: bool,
    }
    impl NetworkBackend for MockBackend {
        fn capture(&mut self, guid: &str) -> Result<Snapshot, String> {
            self.calls.push("capture");
            Ok(Snapshot {
                interface_guid: guid.to_owned(),
                eligible_physical_adapter: true,
                ipv4: SourceMode::Automatic,
                ipv6: if self.unknown_mode {
                    SourceMode::Unknown
                } else {
                    SourceMode::Static(vec!["2001:4860:4860::8888".to_owned()])
                },
            })
        }
        fn apply_ipv4_loopback(&mut self, _: &str) -> Result<(), String> {
            self.calls.push("apply4");
            Ok(())
        }
        fn apply_ipv6_loopback(&mut self, _: &str) -> Result<(), String> {
            self.calls.push("apply6");
            if self.fail_v6_apply {
                Err("v6 update failed".to_owned())
            } else {
                Ok(())
            }
        }
        fn verify_active(&mut self, _: &str) -> Result<(), String> {
            self.calls.push("health");
            if self.fail_health {
                Err("failed TLS validation".to_owned())
            } else {
                Ok(())
            }
        }
        fn restore_ipv4(&mut self, _: &Snapshot) -> Result<(), String> {
            self.calls.push("restore4");
            if self.fail_v4_restore {
                Err("v4 restore failed".to_owned())
            } else {
                Ok(())
            }
        }
        fn restore_ipv6(&mut self, _: &Snapshot) -> Result<(), String> {
            self.calls.push("restore6");
            Ok(())
        }
        fn verify_restored(&mut self, _: &Snapshot) -> Result<(), String> {
            self.calls.push("verify_restore");
            Ok(())
        }
    }
    fn journal() -> MockJournal {
        MockJournal {
            saved: None,
            fail_save: false,
        }
    }

    #[test]
    fn success_leaves_recovery_record_until_explicit_disable() {
        let mut backend = MockBackend::default();
        let mut disk = journal();
        activate("adapter-1", &mut backend, &mut disk).unwrap();
        assert!(disk.saved.is_some());
        assert!(activate("adapter-1", &mut backend, &mut disk).is_err());
        restore(&mut backend, &mut disk).unwrap();
        assert!(disk.saved.is_none());
    }

    #[test]
    fn refuses_unknown_dns_modes_without_modifying_network() {
        let mut backend = MockBackend {
            unknown_mode: true,
            ..Default::default()
        };
        let mut disk = journal();
        assert!(activate("adapter-1", &mut backend, &mut disk).is_err());
        assert_eq!(backend.calls, vec!["capture"]);
        assert!(disk.saved.is_none());
    }

    #[test]
    fn journal_write_must_succeed_before_any_dns_change() {
        let mut backend = MockBackend::default();
        let mut disk = MockJournal {
            saved: None,
            fail_save: true,
        };
        assert!(activate("adapter-1", &mut backend, &mut disk).is_err());
        assert_eq!(backend.calls, vec!["capture"]);
    }

    #[test]
    fn ipv6_apply_failure_rolls_back_both_families() {
        let mut backend = MockBackend {
            fail_v6_apply: true,
            ..Default::default()
        };
        let mut disk = journal();
        let error = activate("adapter-1", &mut backend, &mut disk).unwrap_err();
        assert!(error.contains("restored"));
        assert!(backend.calls.contains(&"restore4"));
        assert!(backend.calls.contains(&"restore6"));
        assert!(disk.saved.is_none());
    }

    #[test]
    fn verification_failure_triggers_rollback() {
        let mut backend = MockBackend {
            fail_health: true,
            ..Default::default()
        };
        let mut disk = journal();
        assert!(activate("adapter-1", &mut backend, &mut disk).is_err());
        assert!(backend.calls.contains(&"verify_restore"));
        assert!(disk.saved.is_none());
    }

    #[test]
    fn failed_recovery_keeps_journal_for_next_attempt() {
        let mut backend = MockBackend {
            fail_v6_apply: true,
            fail_v4_restore: true,
            ..Default::default()
        };
        let mut disk = journal();
        let error = activate("adapter-1", &mut backend, &mut disk).unwrap_err();
        assert!(error.contains("RECOVERY REQUIRED"));
        assert!(disk.saved.is_some());
        assert!(backend.calls.contains(&"restore6"));
    }
}
