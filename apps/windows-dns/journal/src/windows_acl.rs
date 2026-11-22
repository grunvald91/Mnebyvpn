//! Native Windows DACL: only LOCAL SYSTEM and BUILTIN Administrators.
//! Directory has a protected (non-inherited) ACL, checked every open.

use std::ffi::c_void;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::ptr::null_mut;
use std::slice;
use windows_sys::Win32::Foundation::{GetLastError, LocalFree, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
    SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

const SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

struct SecurityDescriptor(*mut c_void);

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

fn wide(input: &std::ffi::OsStr) -> Vec<u16> {
    input.encode_wide().chain(std::iter::once(0)).collect()
}

fn descriptor_from_sddl() -> Result<SecurityDescriptor, String> {
    let text = wide(std::ffi::OsStr::new(SDDL));
    let mut pointer = null_mut();
    let success = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            1,
            &mut pointer,
            null_mut(),
        )
    };
    if success == 0 || pointer.is_null() {
        return Err(format!(
            "Failed to create protected security descriptor: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(SecurityDescriptor(pointer))
}

fn dacl_bytes(sd: *mut c_void) -> Result<Vec<u8>, String> {
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl: *mut ACL = null_mut();
    let ok = unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) };
    if ok == 0 || present == 0 || dacl.is_null() {
        return Err("Recovery directory has no explicit protected DACL".into());
    }
    let len = unsafe { (*dacl).AclSize as usize };
    if len < 8 || len > 8192 {
        return Err("Recovery directory DACL size invalid".into());
    }
    Ok(unsafe { slice::from_raw_parts(dacl.cast::<u8>(), len) }.to_vec())
}

fn verify_directory(path: &Path, expected: &SecurityDescriptor) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect recovery directory: {e}"))?;
    if !metadata.is_dir() || (metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err("Recovery directory is not a normal local directory".into());
    }
    let path_wide = wide(path.as_os_str());
    let mut actual_dacl: *mut ACL = null_mut();
    let mut raw_sd: *mut c_void = null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut actual_dacl,
            null_mut(),
            &mut raw_sd,
        )
    };
    if code != 0 || raw_sd.is_null() {
        return Err(format!("Cannot verify recovery directory ACL: {code}"));
    }
    let actual = SecurityDescriptor(raw_sd);
    let mut control = 0u16;
    let mut revision = 0u32;
    let ok = unsafe { GetSecurityDescriptorControl(actual.0, &mut control, &mut revision) };
    if ok == 0 || (control & 0x1000) == 0 {
        return Err("Recovery directory DACL must be protected from inheritance".into());
    }
    if dacl_bytes(actual.0)? != dacl_bytes(expected.0)? {
        return Err("Recovery directory ACL differs from SYSTEM+Administrators-only policy".into());
    }
    Ok(())
}

/// Re-check an already established directory without silently recreating it.
/// This is important while the service is live: a missing journal directory
/// cannot be interpreted as an empty, safe recovery state.
pub fn verify_existing_private_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Recovery directory path must be absolute".into());
    }
    let expected = descriptor_from_sddl()?;
    verify_directory(path, &expected)
}

pub fn create_or_verify_private_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Recovery directory path must be absolute".into());
    }
    let expected = descriptor_from_sddl()?;
    if fs::symlink_metadata(path).is_err() {
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: expected.0,
            bInheritHandle: 0,
        };
        let wide_path = wide(path.as_os_str());
        let created = unsafe { CreateDirectoryW(wide_path.as_ptr(), &mut attributes) };
        if created == 0 && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
            return Err(format!(
                "Cannot create private recovery directory: {}",
                unsafe { GetLastError() }
            ));
        }
    }
    verify_directory(path, &expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_directory_permissions_survive_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("private-state");
        create_or_verify_private_directory(&root).unwrap();
        create_or_verify_private_directory(&root).unwrap();
    }

    #[test]
    fn disappeared_directory_is_not_recreated_during_runtime_check() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("was-private");
        create_or_verify_private_directory(&root).unwrap();
        fs::remove_dir(&root).unwrap();
        assert!(verify_existing_private_directory(&root).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn existing_unprotected_directory_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("unprotected");
        fs::create_dir(&root).unwrap();
        assert!(create_or_verify_private_directory(&root).is_err());
    }
}
