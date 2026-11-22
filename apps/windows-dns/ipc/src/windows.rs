//! Native Windows implementation. The pipe is one-way, local-only, and has
//! a restrictive DACL. There is no write-capable client command endpoint.

use super::{decode_status, encode_status, MAX_FRAME};
use mnebydns_core::{now_ms, ServiceReport};
use std::ffi::{c_void, OsStr};
use std::io::{BufRead, BufReader, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::ptr::null_mut;
use std::sync::{Arc, RwLock};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::{
    GetTokenInformation, IsWellKnownSid, TokenUser, WinLocalSystemSid, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{FlushFileBuffers, WriteFile};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId,
    WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

const PIPE_NAME: &str = r"\\.\pipe\mnebydns-status-v1";
const PIPE_ACCESS_OUTBOUND: u32 = 0x0000_0002;
const FIRST_INSTANCE: u32 = 0x0008_0000; // FILE_FLAG_FIRST_PIPE_INSTANCE
                                         // SDDL: local SYSTEM/Admins may manage; interactive users can read only.
                                         // Remote connections are separately rejected by PIPE_REJECT_REMOTE_CLIENTS.
const PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;IU)";
const CLIENT_WAIT_MS: u32 = 500;

struct Handle(windows_sys::Win32::Foundation::HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct LocalDescriptor(*mut c_void);
impl Drop for LocalDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn private_pipe_descriptor() -> Result<LocalDescriptor, String> {
    let mut pointer = null_mut();
    let sddl = wide(PIPE_SDDL);
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut pointer,
            null_mut(),
        )
    };
    if ok == 0 || pointer.is_null() {
        return Err(format!(
            "Pipe descriptor initialization failed: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(LocalDescriptor(pointer))
}

fn validate_server_is_local_system(
    pipe: windows_sys::Win32::Foundation::HANDLE,
) -> Result<(), String> {
    let mut pid = 0u32;
    let ok = unsafe { GetNamedPipeServerProcessId(pipe, &mut pid) };
    if ok == 0 || pid == 0 {
        return Err("Cannot verify Windows service PID".into());
    }
    let process = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
    if process.0.is_null() {
        return Err("Cannot inspect Windows service process".into());
    }
    let mut raw_token = null_mut();
    if unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err("Cannot inspect Windows service identity".into());
    }
    let token = Handle(raw_token);
    let mut needed = 0u32;
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed);
    }
    if needed == 0 || needed > 4096 {
        return Err("Unexpected service token size".into());
    }
    let mut aligned = vec![0u64; (needed as usize).div_ceil(8)];
    let ok = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            aligned.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err("Cannot read Windows service token".into());
    }
    let token_user = unsafe { &*aligned.as_ptr().cast::<TOKEN_USER>() };
    let local_system = unsafe { IsWellKnownSid(token_user.User.Sid, WinLocalSystemSid) };
    if local_system == 0 {
        return Err("Named pipe is not owned by a LocalSystem service".into());
    }
    Ok(())
}

/// GUI-side read-only request. Never permits unsafe fallback to local file.
pub fn read_service_status() -> Result<ServiceReport, String> {
    let pipe_name = wide(PIPE_NAME);
    if unsafe { WaitNamedPipeW(pipe_name.as_ptr(), CLIENT_WAIT_MS) } == 0 {
        return Err("Служба Windows недоступна: защищённый канал не найден".into());
    }
    let file = std::fs::File::open(PIPE_NAME)
        .map_err(|err| format!("Не удалось открыть канал службы: {err}"))?;
    validate_server_is_local_system(file.as_raw_handle().cast())?;
    let mut buf = Vec::new();
    let mut reader = BufReader::new(file).take(MAX_FRAME as u64 + 1);
    // The server sends one newline-terminated, bounded JSON object.
    reader
        .read_until(b'\n', &mut buf)
        .map_err(|err| format!("Ошибка чтения статуса службы: {err}"))?;
    decode_status(&buf, now_ms())
}

/// A single persistent named pipe instance. FIRST_INSTANCE prevents unprivileged
/// name squatting; if another process already owns it, the server fails closed.
/// This is diagnostics ONLY: the wire protocol offers no mutation commands.
pub fn serve_local_status(current: Arc<RwLock<ServiceReport>>) -> Result<(), String> {
    let desc = private_pipe_descriptor()?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: desc.0,
        bInheritHandle: 0,
    };
    let name = wide(PIPE_NAME);
    let pipe = Handle(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_OUTBOUND | FIRST_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            4096,
            4096,
            500,
            &mut attributes,
        )
    });
    if pipe.0 == INVALID_HANDLE_VALUE {
        return Err(format!("Cannot create protected named pipe: {}", unsafe {
            GetLastError()
        }));
    }

    loop {
        let connected = unsafe { ConnectNamedPipe(pipe.0, null_mut()) };
        if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
            return Err(format!("Named pipe connect failed: {}", unsafe {
                GetLastError()
            }));
        }
        let response = current
            .read()
            .map_err(|_| "DNS service status lock poisoned".to_owned())
            .and_then(|report| encode_status(&report));
        if let Ok(data) = response {
            let mut sent = 0u32;
            let wrote = unsafe {
                WriteFile(
                    pipe.0,
                    data.as_ptr().cast(),
                    data.len() as u32,
                    &mut sent,
                    null_mut(),
                )
            };
            if wrote != 0 && sent == data.len() as u32 {
                // Flush waits for the reader to receive bytes; currently this
                // one-way status channel may be DoS'd by a connected client.
                // The service's DNS protection / recovery does not depend on it.
                unsafe {
                    FlushFileBuffers(pipe.0);
                }
            }
        }
        unsafe {
            DisconnectNamedPipe(pipe.0);
        }
    }
}
