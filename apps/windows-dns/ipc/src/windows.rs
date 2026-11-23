//! Native Windows implementation. The pipe is one-way, local-only, and has
//! a restrictive DACL. There is no write-capable client command endpoint.

use super::{decode_status, encode_status, MAX_FRAME};
use mnebydns_core::{now_ms, ServiceReport};
use std::ffi::{c_void, OsStr};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::ptr::{null, null_mut};
use std::sync::{Arc, RwLock};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA,
    ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId,
    WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx, SC_MANAGER_CONNECT,
    SC_STATUS_PROCESS_INFO, SERVICE_QUERY_STATUS, SERVICE_STATUS_PROCESS,
};
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::System::IO::{
    CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED,
};

const PIPE_NAME: &str = r"\\.\pipe\mnebydns-status-v1";
const CONTROL_PIPE_NAME: &str = r"\\.\pipe\mnebydns-control-v1";
const RECOVERY_PIPE_NAME: &str = r"\\.\pipe\mnebydns-recovery-v1";
const RECOVERY_SERVICE_NAME: &str = "MnebyDnsRecovery";
const SERVICE_NAME: &str = "MnebyDnsHealth";
const CONTROL_ACK: u8 = 0x06;
const CONTROL_REJECT: u8 = 0x15;
const CONTROL_CONFIGURE_AND_ENABLE: u8 = 0x32;
const MAX_DOT_HOST_BYTES: usize = 253;
const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
const FIRST_INSTANCE: u32 = 0x0008_0000; // FILE_FLAG_FIRST_PIPE_INSTANCE
const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
const PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)";
const CLIENT_WAIT_MS: u32 = 500;
const CLIENT_IO_MS: u32 = 1_000;
const STATUS_ACK: u8 = 0x06; // This is only a delivery acknowledgement, never a command.

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

struct ScHandle(windows_sys::Win32::System::Services::SC_HANDLE);
impl Drop for ScHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseServiceHandle(self.0);
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

/// Verify the exact service PID through the Service Control Manager.
/// Opening a LocalSystem process token from a standard-user GUI can fail
/// with Access Denied even when the pipe belongs to the legitimate service.
fn validate_server_is_registered_service(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    service_name: &str,
) -> Result<(), String> {
    let mut pipe_pid = 0u32;
    if unsafe { GetNamedPipeServerProcessId(pipe, &mut pipe_pid) } == 0 || pipe_pid == 0 {
        return Err("Cannot verify named pipe server PID".to_owned());
    }
    let scm = ScHandle(unsafe { OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT) });
    if scm.0.is_null() {
        return Err("Cannot open Windows Service Control Manager".to_owned());
    }
    let service_name = wide(service_name);
    let service =
        ScHandle(unsafe { OpenServiceW(scm.0, service_name.as_ptr(), SERVICE_QUERY_STATUS) });
    if service.0.is_null() {
        return Err("Cannot query installed DNS Windows service".to_owned());
    }
    let mut status: SERVICE_STATUS_PROCESS = unsafe { std::mem::zeroed() };
    let mut needed = 0u32;
    let success = unsafe {
        QueryServiceStatusEx(
            service.0,
            SC_STATUS_PROCESS_INFO,
            (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    };
    if success == 0 || status.dwProcessId == 0 || status.dwProcessId != pipe_pid {
        return Err("DNS pipe process does not match the installed Windows service".to_owned());
    }
    Ok(())
}

/// GUI-side read-only request. Never permits unsafe fallback to local file.
pub fn read_service_status() -> Result<ServiceReport, String> {
    let pipe_name = wide(PIPE_NAME);
    if unsafe { WaitNamedPipeW(pipe_name.as_ptr(), CLIENT_WAIT_MS) } == 0 {
        return Err("Служба Windows недоступна: защищённый канал не найден".into());
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(PIPE_NAME)
        .map_err(|err| format!("Не удалось открыть канал службы: {err}"))?;
    validate_server_is_registered_service(file.as_raw_handle().cast(), SERVICE_NAME)?;
    let mut buf = Vec::new();
    let mut reader = BufReader::new(&file).take(MAX_FRAME as u64 + 1);
    // The server sends one newline-terminated, bounded JSON object.
    reader
        .read_until(b'\n', &mut buf)
        .map_err(|err| format!("Ошибка чтения статуса службы: {err}"))?;
    let report = decode_status(&buf, now_ms())?;
    // Acknowledge only an authenticated, decoded status frame. The server does
    // not flush synchronously: it waits at most CLIENT_IO_MS for this byte.
    let mut writer = &file;
    writer
        .write_all(&[STATUS_ACK])
        .map_err(|err| format!("Не удалось подтвердить статус службы: {err}"))?;
    Ok(report)
}

/// Create a manual-reset event for each overlapped operation. The operation
/// must finish or be cancelled AND reaped before its OVERLAPPED storage drops.
fn new_event() -> Result<Handle, String> {
    let event = Handle(unsafe { CreateEventW(null(), 1, 0, null()) });
    if event.0.is_null() {
        return Err(format!("CreateEventW failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok(event)
}

fn wait_for_connection(pipe: windows_sys::Win32::Foundation::HANDLE) -> Result<bool, String> {
    let event = new_event()?;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event.0;
    let connected = unsafe { ConnectNamedPipe(pipe, &mut overlapped) };
    if connected != 0 {
        return Ok(true);
    }
    match unsafe { GetLastError() } {
        ERROR_PIPE_CONNECTED => Ok(true),
        ERROR_NO_DATA | ERROR_BROKEN_PIPE => Ok(false),
        ERROR_IO_PENDING => {
            let mut transferred = 0;
            if unsafe { GetOverlappedResult(pipe, &overlapped, &mut transferred, 1) } == 0 {
                match unsafe { GetLastError() } {
                    ERROR_NO_DATA | ERROR_BROKEN_PIPE => Ok(false),
                    error => Err(format!("Named pipe connection failed: {error}")),
                }
            } else {
                Ok(true)
            }
        }
        error => Err(format!("Named pipe connection failed: {error}")),
    }
}

/// Only used after a client connects. A timed-out overlapped request is
/// cancelled and reaped before freeing memory or reusing the pipe instance.
fn bounded_io(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    name: &str,
    operation: impl FnOnce(*mut OVERLAPPED, &mut u32) -> i32,
) -> Result<u32, String> {
    let event = new_event()?;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event.0;
    let mut transferred = 0u32;
    let completed = operation(&mut overlapped, &mut transferred);
    if completed != 0 {
        return Ok(transferred);
    }
    let error = unsafe { GetLastError() };
    if error != ERROR_IO_PENDING {
        return Err(format!("{name} failed: {error}"));
    }
    if unsafe { GetOverlappedResultEx(pipe, &overlapped, &mut transferred, CLIENT_IO_MS, 0) } != 0 {
        return Ok(transferred);
    }
    let error = unsafe { GetLastError() };
    // Even on timeout, the kernel may still reference both OVERLAPPED and the
    // I/O buffer. Cancel and reap the request before either is dropped.
    unsafe {
        CancelIoEx(pipe, &overlapped);
        GetOverlappedResult(pipe, &overlapped, &mut transferred, 1);
    }
    Err(format!("{name} did not complete: {error}"))
}

fn serve_one_client(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    current: &Arc<RwLock<ServiceReport>>,
) -> Result<(), String> {
    let data = {
        let report = current
            .read()
            .map_err(|_| "DNS service status lock poisoned".to_owned())?;
        encode_status(&report)?
    };
    let sent = bounded_io(pipe, "Pipe status write", |overlapped, count| unsafe {
        WriteFile(
            pipe,
            data.as_ptr().cast(),
            data.len() as u32,
            count,
            overlapped,
        )
    })?;
    if sent != data.len() as u32 {
        return Err("Incomplete status frame write".into());
    }
    // The client sends ACK only after consuming and validating the entire
    // status frame. This replaces an unbounded FlushFileBuffers call.
    let mut ack = 0u8;
    let read = bounded_io(pipe, "Pipe status ACK", |overlapped, count| unsafe {
        ReadFile(pipe, (&mut ack as *mut u8).cast(), 1, count, overlapped)
    })?;
    if read != 1 || ack != STATUS_ACK {
        return Err("Client did not acknowledge the status frame".into());
    }
    Ok(())
}

/// One reusable local-only named pipe with a per-client I/O deadline. A client
/// that connects and refuses to read cannot monopolize the service forever.
/// Requests are delivery acknowledgements only; no DNS mutations are exposed.
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
            PIPE_ACCESS_DUPLEX | FIRST_INSTANCE | FILE_FLAG_OVERLAPPED,
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
        // A client may disconnect before ConnectNamedPipe completes. Reset
        // this instance and keep the service available instead of exiting.
        let connected = wait_for_connection(pipe.0)?;
        if !connected {
            unsafe {
                DisconnectNamedPipe(pipe.0);
            }
            continue;
        }
        if let Err(error) = serve_one_client(pipe.0, &current) {
            eprintln!("Diagnostic pipe request rejected: {error}");
        }
        unsafe {
            DisconnectNamedPipe(pipe.0);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlRequest {
    EnableSaved,
    Disable,
    /// A restricted DNS hostname, never an executable path or arbitrary shell.
    ConfigureAndEnable(String),
    EmergencyRestore,
}
impl ControlRequest {
    fn byte(&self) -> u8 {
        match self {
            Self::EnableSaved => 0x31,
            Self::Disable => 0x30,
            Self::ConfigureAndEnable(_) => CONTROL_CONFIGURE_AND_ENABLE,
            Self::EmergencyRestore => 0x33,
        }
    }
    fn from_byte(value: u8) -> Option<Self> {
        match value {
            0x31 => Some(Self::EnableSaved),
            0x30 => Some(Self::Disable),
            0x33 => Some(Self::EmergencyRestore),
            _ => None,
        }
    }
}

/// Only fixed DNS operations are accepted. A new DoT endpoint is validated
/// against DNS hostname rules by the privileged service before persistence.
pub fn send_control(request: ControlRequest) -> Result<(), String> {
    send_request(CONTROL_PIPE_NAME, SERVICE_NAME, request)
}

/// Independent recovery broker installed by the initial UAC.
pub fn send_recovery() -> Result<(), String> {
    send_request(
        RECOVERY_PIPE_NAME,
        RECOVERY_SERVICE_NAME,
        ControlRequest::EmergencyRestore,
    )
}

fn send_request(
    pipe_address: &str,
    expected_service: &str,
    request: ControlRequest,
) -> Result<(), String> {
    let pipe_name = wide(pipe_address);
    if unsafe { WaitNamedPipeW(pipe_name.as_ptr(), CLIENT_WAIT_MS) } == 0 {
        return Err("CONTROL_PIPE_UNAVAILABLE".to_owned());
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(pipe_address)
        .map_err(|_| "CONTROL_PIPE_UNAVAILABLE".to_owned())?;
    validate_server_is_registered_service(file.as_raw_handle().cast(), expected_service)?;
    file.write_all(&[request.byte()])
        .map_err(|_| "Не удалось отправить команду службе DNS".to_owned())?;
    if let ControlRequest::ConfigureAndEnable(host) = &request {
        let bytes = host.as_bytes();
        if bytes.is_empty() || bytes.len() > MAX_DOT_HOST_BYTES || !host.is_ascii() {
            return Err("Некорректная длина или кодировка имени DoT-сервера".to_owned());
        }
        let length = u16::try_from(bytes.len())
            .map_err(|_| "Слишком длинное имя DoT-сервера".to_owned())?;
        file.write_all(&length.to_be_bytes())
            .and_then(|_| file.write_all(bytes))
            .map_err(|_| "Не удалось передать DoT-адрес службе".to_owned())?;
    }
    let mut reply = [0u8; 1];
    file.read_exact(&mut reply)
        .map_err(|_| "Служба DNS не подтвердила команду".to_owned())?;
    match reply[0] {
        CONTROL_ACK => Ok(()),
        CONTROL_REJECT => {
            Err("Служба отклонила DNS-команду: проверьте статус и завершение восстановления".to_owned())
        }
        _ => Err("Неизвестный ответ от службы DNS".to_owned()),
    }
}

fn read_control_exact(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    target: &mut [u8],
) -> Result<(), String> {
    let mut offset = 0usize;
    while offset < target.len() {
        let remaining = &mut target[offset..];
        let count = bounded_io(pipe, "Control parameter read", |overlapped, read| unsafe {
            ReadFile(
                pipe,
                remaining.as_mut_ptr().cast(),
                remaining.len() as u32,
                read,
                overlapped,
            )
        })? as usize;
        if count == 0 || count > remaining.len() {
            return Err("Incomplete or invalid control frame".to_owned());
        }
        offset += count;
    }
    Ok(())
}

fn serve_control_client(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    handler: &impl Fn(ControlRequest) -> Result<(), String>,
) -> Result<(), String> {
    let mut opcode = [0u8; 1];
    let read = bounded_io(pipe, "Control request", |overlapped, count| unsafe {
        ReadFile(pipe, opcode.as_mut_ptr().cast(), 1, count, overlapped)
    })?;
    if read != 1 {
        return Err("Invalid DNS control request size".to_owned());
    }
    let allowed = if opcode[0] == CONTROL_CONFIGURE_AND_ENABLE {
        (|| -> Result<ControlRequest, String> {
            let mut len = [0u8; 2];
            read_control_exact(pipe, &mut len)?;
            let length = usize::from(u16::from_be_bytes(len));
            if length == 0 || length > MAX_DOT_HOST_BYTES {
                return Err("Invalid DoT hostname length in control request".to_owned());
            }
            let mut bytes = vec![0u8; length];
            read_control_exact(pipe, &mut bytes)?;
            let host = String::from_utf8(bytes)
                .map_err(|_| "Invalid DoT hostname encoding".to_owned())?;
            if !host.is_ascii() {
                return Err("Only ASCII DNS hostnames are accepted".to_owned());
            }
            Ok(ControlRequest::ConfigureAndEnable(host))
        })()
    } else {
        ControlRequest::from_byte(opcode[0])
            .ok_or_else(|| "Unsupported DNS control command".to_owned())
    };
    let accepted = allowed.and_then(handler).is_ok();
    let byte = if accepted {
        CONTROL_ACK
    } else {
        CONTROL_REJECT
    };
    bounded_io(pipe, "Control response", |overlapped, count| unsafe {
        WriteFile(pipe, (&byte as *const u8).cast(), 1, count, overlapped)
    })?;
    Ok(())
}

/// Local privileged endpoint accepts only DNS profile toggles or a validated
/// DoT hostname. It never accepts arbitrary process arguments, paths, or code.

pub fn serve_local_control(
    handler: impl Fn(ControlRequest) -> Result<(), String>,
) -> Result<(), String> {
    serve_control_pipe(CONTROL_PIPE_NAME, handler)
}

/// Separate local recovery endpoint is restricted to one fixed opcode.
pub fn serve_local_recovery(
    handler: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    serve_control_pipe(RECOVERY_PIPE_NAME, move |request| {
        if request != ControlRequest::EmergencyRestore {
            return Err("Recovery service only accepts restore".to_owned());
        }
        handler()
    })
}

fn serve_control_pipe(
    pipe_address: &str,
    handler: impl Fn(ControlRequest) -> Result<(), String>,
) -> Result<(), String> {
    let desc = private_pipe_descriptor()?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: desc.0,
        bInheritHandle: 0,
    };
    let name = wide(pipe_address);
    let pipe = Handle(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FIRST_INSTANCE | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            128,
            128,
            500,
            &mut attributes,
        )
    });
    if pipe.0 == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Cannot create protected DNS control pipe: {}",
            unsafe { GetLastError() }
        ));
    }
    loop {
        let connected = wait_for_connection(pipe.0)?;
        if connected {
            if let Err(err) = serve_control_client(pipe.0, &handler) {
                eprintln!("DNS control request rejected: {err}");
            }
        }
        unsafe {
            DisconnectNamedPipe(pipe.0);
        }
    }
}

#[cfg(test)]
mod control_tests {
    use super::*;
    #[test]
    fn control_opcode_is_small_and_allowlisted() {
        assert_eq!(
            ControlRequest::from_byte(0x31),
            Some(ControlRequest::EnableSaved)
        );
        assert_eq!(
            ControlRequest::from_byte(0x30),
            Some(ControlRequest::Disable)
        );
        assert_eq!(ControlRequest::from_byte(0x21), None);
        assert_eq!(ControlRequest::from_byte(0xff), None);
        assert_eq!(ControlRequest::from_byte(0x33), Some(ControlRequest::EmergencyRestore));
        assert_eq!(ControlRequest::from_byte(CONTROL_CONFIGURE_AND_ENABLE), None);
        assert_eq!(
            ControlRequest::ConfigureAndEnable("dns.example.net".to_owned()).byte(),
            CONTROL_CONFIGURE_AND_ENABLE,
        );
    }
}
