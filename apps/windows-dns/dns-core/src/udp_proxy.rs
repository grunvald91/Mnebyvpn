//! Preview-only DNS/UDP -> authenticated DNS-over-TLS bridge.
//! Binds exclusively to IPv4 loopback on an ephemeral port. No OS DNS edits,
//! no port 53 bind, no plaintext upstream fallback and no secrets at rest.
//! The upstream name is resolved and pinned *before* the local listener starts;
//! otherwise changing system DNS could create a bootstrap resolution loop.
//!
//! This proof of concept does NOT claim to be a complete DNS server: no TCP
//! listener, cache, background service, IPv6 listener or production pooling.

use super::dot::{
    candidate_addresses, checked_hostname, connect_authenticated, read_exact_until, DOT_PORT,
    IO_TIMEOUT, MAX_DNS_FRAME,
};
use super::{parse_reply, query_packet, NEXT_DNS_ID};
use native_tls::TlsConnector;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_UDP_PACKET: usize = 1232;
const MAX_TCP_FRAME: usize = 4096;
const TCP_READ_TIMEOUT: Duration = Duration::from_millis(3000);
const WORKERS: usize = 2;
const RECV_POLL: Duration = Duration::from_millis(100);
const SMOKE_TIMEOUT: Duration = Duration::from_millis(12000);

#[derive(Clone, Copy)]
struct QueryInfo {
    end_of_question: usize,
    udp_limit: usize,
}

fn read_query(packet: &[u8]) -> Option<QueryInfo> {
    if packet.len() < 17 || packet.len() > MAX_TCP_FRAME {
        return None;
    }
    // QR/opcode/AA/TC must be zero; RD can be on or off. Response code=0.
    if packet[2] & 0xfe != 0 || packet[3] & 0x4f != 0 {
        return None;
    }
    if u16::from_be_bytes([packet[4], packet[5]]) != 1
        || packet[6..10].iter().any(|&n| n != 0)
        || packet[10] != 0
        || packet[11] > 1
    {
        return None;
    }

    let mut cursor = 12usize;
    let mut name_length = 1usize;
    let mut terminated = false;
    for _ in 0..127 {
        let label = *packet.get(cursor)? as usize;
        if label == 0 {
            cursor += 1;
            terminated = true;
            break;
        }
        // Compression in client questions is rejected; only plain QNAME.
        if label > 63 || name_length.checked_add(label + 1)? > 255 {
            return None;
        }
        cursor = cursor.checked_add(label + 1)?;
        if cursor > packet.len() {
            return None;
        }
        name_length += label + 1;
    }
    // A valid DNS QNAME must end with the zero root label.
    if !terminated {
        return None;
    }
    let question_end = cursor.checked_add(4)?;
    if question_end > packet.len() {
        return None;
    }
    let mut udp_limit = 512usize;
    if packet[11] == 1 {
        // One EDNS OPT pseudo-RR is supported. Other additional RR types are
        // rejected to avoid parsing ambiguity in this bounded prototype.
        let header_end = question_end.checked_add(11)?;
        if header_end > packet.len()
            || packet[question_end] != 0
            || &packet[question_end + 1..question_end + 3] != [0, 41]
        {
            return None;
        }
        let advertised = u16::from_be_bytes([packet[question_end + 3], packet[question_end + 4]]);
        udp_limit = usize::from(advertised).clamp(512, MAX_UDP_PACKET);
        let opt_len =
            u16::from_be_bytes([packet[question_end + 9], packet[question_end + 10]]) as usize;
        if header_end.checked_add(opt_len)? != packet.len() {
            return None;
        }
    } else if question_end != packet.len() {
        return None;
    }
    Some(QueryInfo {
        end_of_question: question_end,
        udp_limit,
    })
}

fn valid_upstream_answer(request: &[u8], answer: &[u8], question_end: usize) -> bool {
    answer.len() >= question_end
        && answer.len() <= MAX_DNS_FRAME
        && answer[0..2] == request[0..2]
        && answer[2] & 0xf8 == 0x80
        && answer[4..6] == [0, 1]
        && answer[12..question_end] == request[12..question_end]
}

fn response_header(request: &[u8], info: QueryInfo, truncated: bool) -> Vec<u8> {
    let mut reply = vec![0u8; 12];
    reply[0..2].copy_from_slice(&request[0..2]);
    reply[2] = 0x80 | (request[2] & 1) | if truncated { 0x02 } else { 0 };
    // SERVFAIL when not truncated, otherwise TC causes a TCP retry (not yet served here).
    reply[3] = (request[3] & 0x10) | if truncated { 0 } else { 2 };
    reply[5] = 1;
    reply.extend_from_slice(&request[12..info.end_of_question]);
    reply
}

trait Upstream: Send + Sync + 'static {
    fn forward(&self, query: &[u8]) -> Result<Vec<u8>, String>;
}

struct PinnedDotUpstream {
    host: String,
    addresses: Vec<SocketAddr>,
}

impl Upstream for PinnedDotUpstream {
    fn forward(&self, query: &[u8]) -> Result<Vec<u8>, String> {
        let mut tls_builder = TlsConnector::builder();
        tls_builder.min_protocol_version(Some(native_tls::Protocol::Tlsv12));
        let connector = tls_builder
            .build()
            .map_err(|_| "TLS context unavailable".to_owned())?;
        let mut tls =
            connect_authenticated(&self.host, self.addresses.iter().copied(), &connector)?;
        let framed_len: u16 = query
            .len()
            .try_into()
            .map_err(|_| "DNS query too large".to_owned())?;
        tls.write_all(&framed_len.to_be_bytes())
            .and_then(|_| tls.write_all(query))
            .and_then(|_| tls.flush())
            .map_err(|_| "DoT write failed".to_owned())?;
        let deadline = Instant::now() + IO_TIMEOUT;
        let mut frame_len = [0u8; 2];
        read_exact_until(&mut tls, &mut frame_len, deadline).map_err(str::to_owned)?;
        let len = usize::from(u16::from_be_bytes(frame_len));
        if !(12..=MAX_DNS_FRAME).contains(&len) {
            return Err("Invalid DoT response size".to_owned());
        }
        let mut response = vec![0u8; len];
        read_exact_until(&mut tls, &mut response, deadline).map_err(str::to_owned)?;
        Ok(response)
    }
}

fn reply_for_query(upstream: &dyn Upstream, query: &[u8]) -> Option<Vec<u8>> {
    if query.len() > MAX_UDP_PACKET {
        return None;
    }
    let info = read_query(query)?;
    match upstream.forward(query) {
        Ok(response) if valid_upstream_answer(query, &response, info.end_of_question) => {
            if response.len() <= info.udp_limit {
                Some(response)
            } else {
                Some(response_header(query, info, true))
            }
        }
        _ => Some(response_header(query, info, false)),
    }
}

/// TCP DNS shares the exact validation and TLS upstream but does not apply
/// UDP's 512/EDNS0 size limit. It always emits a full framed response.
fn reply_for_tcp(upstream: &dyn Upstream, query: &[u8]) -> Option<Vec<u8>> {
    let info = read_query(query)?;
    Some(match upstream.forward(query) {
        Ok(reply) if valid_upstream_answer(query, &reply, info.end_of_question) => reply,
        _ => response_header(query, info, false),
    })
}

fn handle_tcp(mut stream: TcpStream, upstream: &dyn Upstream, stopping: &AtomicBool) {
    if stream
        .set_read_timeout(Some(TCP_READ_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(TCP_READ_TIMEOUT)))
        .is_err()
    {
        return;
    }
    // Query reuse on a single TCP session is supported, but bounded. This
    // preview does not support pipelining (queries on the wire before replies).
    for _ in 0..16 {
        if stopping.load(Ordering::Acquire) {
            return;
        }
        let mut header = [0u8; 2];
        if stream.read_exact(&mut header).is_err() {
            return;
        }
        let len = usize::from(u16::from_be_bytes(header));
        if !(17..=MAX_TCP_FRAME).contains(&len) {
            return;
        }
        let mut packet = vec![0u8; len];
        if stream.read_exact(&mut packet).is_err() {
            return;
        }
        let Some(answer) = reply_for_tcp(upstream, &packet) else {
            return;
        };
        let Ok(size) = u16::try_from(answer.len()) else {
            return;
        };
        if stream
            .write_all(&size.to_be_bytes())
            .and_then(|_| stream.write_all(&answer))
            .is_err()
        {
            return;
        }
    }
}

#[must_use]
pub struct LoopbackDnsServer {
    port: u16,
    stopping: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl LoopbackDnsServer {
    /// Binds both IPv4 and IPv6 on localhost, both UDP and TCP, on the SAME
    /// port. All four binds must succeed before a worker thread starts.
    /// Explicitly requesting 53 can fail if another DNS server owns it.
    fn start_with_upstream(upstream: Arc<dyn Upstream>, port: u16) -> Result<Self, String> {
        let tcp4 = TcpListener::bind(("127.0.0.1", port))
            .map_err(|_| "TCP IPv4 loopback port unavailable".to_owned())?;
        let actual_port = tcp4
            .local_addr()
            .map_err(|_| "Cannot determine loopback TCP port".to_owned())?
            .port();
        if actual_port == 0 {
            return Err("Invalid local DNS listener port".into());
        }
        let udp4 = UdpSocket::bind(("127.0.0.1", actual_port))
            .map_err(|_| "UDP IPv4 loopback port unavailable".to_owned())?;
        let tcp6 = TcpListener::bind(("::1", actual_port))
            .map_err(|_| "TCP IPv6 loopback port unavailable".to_owned())?;
        let udp6 = UdpSocket::bind(("::1", actual_port))
            .map_err(|_| "UDP IPv6 loopback port unavailable".to_owned())?;

        // Configure ALL sockets before starting workers: a partial error
        // must not leave a detached listener holding port 53.
        for socket in [&tcp4, &tcp6] {
            socket
                .set_nonblocking(true)
                .map_err(|_| "Cannot configure DNS TCP listener".to_owned())?;
        }
        for socket in [&udp4, &udp6] {
            socket
                .set_read_timeout(Some(RECV_POLL))
                .map_err(|_| "Cannot configure DNS UDP listener".to_owned())?;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let mut threads = Vec::new();
        for listener in [tcp4, tcp6] {
            let resolver = Arc::clone(&upstream);
            let stopping = Arc::clone(&stop);
            threads.push(thread::spawn(move || {
                while !stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, peer)) if peer.ip().is_loopback() => {
                            handle_tcp(stream, resolver.as_ref(), stopping.as_ref());
                        }
                        Ok(_) => continue,
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(RECV_POLL);
                        }
                        Err(_) => break,
                    }
                }
            }));
        }
        for listener in [udp4, udp6] {
            // All socket options were configured before starting workers.
            let resolver = Arc::clone(&upstream);
            let stopping = Arc::clone(&stop);
            threads.push(thread::spawn(move || {
                let mut buf = [0u8; MAX_UDP_PACKET + 1];
                while !stopping.load(Ordering::Acquire) {
                    let (count, peer) = match listener.recv_from(&mut buf) {
                        Ok(x) => x,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::TimedOut
                                || error.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            continue
                        }
                        Err(_) => break,
                    };
                    if !peer.ip().is_loopback() || stopping.load(Ordering::Acquire) {
                        continue;
                    }
                    if let Some(answer) = reply_for_query(resolver.as_ref(), &buf[..count]) {
                        if !stopping.load(Ordering::Acquire) {
                            let _ = listener.send_to(&answer, peer);
                        }
                    }
                }
            }));
        }
        Ok(Self {
            port: actual_port,
            stopping: stop,
            threads,
        })
    }

    /// Bootstraps the trusted DoT hostname before any potential OS mutation.
    /// This binds a local DNS server, but does NOT modify Windows DNS settings.
    pub fn start(hostname: &str, port: u16) -> Result<Self, String> {
        let addresses = super::dot::resolve_dot_addresses(hostname)?;
        Self::start_pinned(hostname, addresses, port)
    }

    /// Start from addresses resolved and persisted before the system DNS
    /// switch. Certificate validation still uses the original hostname.
    pub fn start_pinned(
        hostname: &str,
        addresses: Vec<SocketAddr>,
        port: u16,
    ) -> Result<Self, String> {
        let host = checked_hostname(hostname)?;
        if addresses.is_empty()
            || addresses.len() > 5
            || addresses.iter().any(|address| {
                address.port() != DOT_PORT
                    || address.ip().is_loopback()
                    || address.ip().is_unspecified()
                    || address.ip().is_multicast()
            })
        {
            return Err("Invalid pinned DoT server address list".into());
        }
        let addresses = candidate_addresses(addresses.into_iter());
        if addresses.is_empty() {
            return Err("No usable pinned DoT server IP addresses".into());
        }
        Self::start_with_upstream(Arc::new(PinnedDotUpstream { host, addresses }), port)
    }

    pub fn local_port(&self) -> u16 {
        self.port
    }
}

impl Drop for LoopbackDnsServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        for worker in self.threads.drain(..) {
            let _ = worker.join();
        }
    }
}

/// Owns the short-lived loopback socket and threads. No external interfaces are
/// exposed and all workers stop on drop. The caller must not drop this handle
/// until the preview has finished.
#[must_use]
pub struct UdpDotPreview {
    address: SocketAddr,
    stopping: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
}

impl UdpDotPreview {
    fn start_with_upstream(upstream: Arc<dyn Upstream>) -> Result<Self, String> {
        let listener = UdpSocket::bind("127.0.0.1:0")
            .map_err(|_| "Cannot bind ephemeral loopback UDP port".to_owned())?;
        listener
            .set_read_timeout(Some(RECV_POLL))
            .map_err(|_| "Cannot configure loopback listener".to_owned())?;
        let address = listener
            .local_addr()
            .map_err(|_| "Cannot read loopback address".to_owned())?;
        // Clone all sockets before spawning workers, so a failure cannot
        // leave an unowned, immortal listener thread.
        let sockets = (0..WORKERS)
            .map(|_| {
                listener
                    .try_clone()
                    .map_err(|_| "Cannot clone loopback socket".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let stopping = Arc::new(AtomicBool::new(false));
        let mut workers = Vec::with_capacity(WORKERS);
        for socket in sockets {
            let stop = Arc::clone(&stopping);
            let resolver = Arc::clone(&upstream);
            workers.push(thread::spawn(move || {
                let mut buf = [0u8; MAX_UDP_PACKET + 1];
                while !stop.load(Ordering::Acquire) {
                    let (n, peer) = match socket.recv_from(&mut buf) {
                        Ok(pair) => pair,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::TimedOut
                                || error.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            continue
                        }
                        Err(_) => break,
                    };
                    if !peer.ip().is_loopback() || stop.load(Ordering::Acquire) {
                        continue;
                    }
                    if let Some(response) = reply_for_query(resolver.as_ref(), &buf[..n]) {
                        if !stop.load(Ordering::Acquire) {
                            let _ = socket.send_to(&response, peer);
                        }
                    }
                }
            }));
        }
        Ok(Self {
            address,
            stopping,
            workers,
        })
    }

    /// Bootstrap and pin upstream addresses while OS DNS has not been changed.
    /// This method neither configures nor starts an OS-level DNS service.
    pub fn preview_for_hostname(input: &str) -> Result<Self, String> {
        let host = checked_hostname(input)?;
        let addresses = (host.as_str(), DOT_PORT)
            .to_socket_addrs()
            .map_err(|_| "Windows could not resolve the DoT hostname for preview".to_owned())?;
        let addresses = candidate_addresses(addresses);
        if addresses.is_empty() {
            return Err("No upstream IP address available for DoT preview".into());
        }
        Self::start_with_upstream(Arc::new(PinnedDotUpstream { host, addresses }))
    }

    pub fn local_address(&self) -> SocketAddr {
        self.address
    }
}

impl Drop for UdpDotPreview {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct UdpDotSmokeReport {
    pub success: bool,
    pub elapsed_ms: u64,
    pub answer_count: u16,
    pub local_port: u16,
    pub note: &'static str,
}

/// One UDP query over a temporary loopback listener through authenticated
/// DoT, with a fixed example.com A question. The preview is shut down even
/// on error. The live probe does not change the Windows DNS server.
pub fn smoke_udp_dot_preview(host: &str) -> Result<UdpDotSmokeReport, String> {
    let started = Instant::now();
    let proxy = UdpDotPreview::preview_for_hostname(host)?;
    let socket = UdpSocket::bind("127.0.0.1:0")
        .map_err(|_| "Cannot bind temporary UDP probe socket".to_owned())?;
    socket
        .set_read_timeout(Some(SMOKE_TIMEOUT))
        .map_err(|_| "Cannot set UDP smoke timeout".to_owned())?;
    let query_id = NEXT_DNS_ID.fetch_add(1, Ordering::Relaxed);
    let query = query_packet(query_id, 1);
    socket
        .send_to(&query, proxy.local_address())
        .map_err(|_| "Cannot send local UDP DNS query".to_owned())?;
    let mut buf = [0u8; MAX_UDP_PACKET + 1];
    let (count, peer) = socket
        .recv_from(&mut buf)
        .map_err(|_| "Local UDP DNS relay did not reply before timeout".to_owned())?;
    if peer != proxy.local_address() {
        return Err("Unexpected loopback UDP response peer".into());
    }
    let answers = parse_reply(&buf[..count], query_id, 1).map_err(|_| {
        "Authenticated UDP/DoT relay did not return a valid positive DNS A answer".to_owned()
    })?;
    Ok(UdpDotSmokeReport {
        success: true,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        answer_count: answers,
        local_port: proxy.local_address().port(),
        note: "Only a temporary loopback UDP port was used; system DNS and port 53 were untouched.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    struct MockUpstream {
        corrupt: bool,
        unavailable: bool,
        large: bool,
    }

    impl Upstream for MockUpstream {
        fn forward(&self, query: &[u8]) -> Result<Vec<u8>, String> {
            if self.unavailable {
                return Err("simulated TLS failure".into());
            }
            let mut response = query[..read_query(query).unwrap().end_of_question].to_vec();
            response[2] = 0x81;
            response[3] = 0x80;
            response[6..8].copy_from_slice(&1u16.to_be_bytes());
            response.extend_from_slice(&[0xc0, 0x0c]);
            response.extend_from_slice(&[0, 1, 0, 1]);
            response.extend_from_slice(&60u32.to_be_bytes());
            let data = if self.large {
                vec![7u8; 500]
            } else {
                vec![93, 184, 215, 14]
            };
            response.extend_from_slice(&(data.len() as u16).to_be_bytes());
            response.extend_from_slice(&data);
            if self.corrupt {
                response[0] ^= 0xff;
            }
            Ok(response)
        }
    }

    fn mock(corrupt: bool, unavailable: bool, large: bool) -> Arc<dyn Upstream> {
        Arc::new(MockUpstream {
            corrupt,
            unavailable,
            large,
        })
    }

    #[test]
    fn accepts_one_question_and_bounded_edns_only() {
        let q = query_packet(123, 1);
        assert_eq!(read_query(&q).unwrap().udp_limit, 512);
        let mut edns = q.clone();
        edns[11] = 1;
        edns.extend_from_slice(&[0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(read_query(&edns).unwrap().udp_limit, 1232);
        let last = edns.len() - 1;
        edns[last] = 1;
        assert!(read_query(&edns).is_none());
        let mut multiple = q.clone();
        multiple[5] = 2;
        assert!(read_query(&multiple).is_none());
        let mut qr = q.clone();
        qr[2] |= 0x80;
        assert!(read_query(&qr).is_none());
        let mut compressed = q.clone();
        compressed[12] = 0xc0;
        assert!(read_query(&compressed).is_none());
        assert!(read_query(&q[..12]).is_none());
        assert!(read_query(&vec![0u8; MAX_UDP_PACKET + 1]).is_none());
    }

    #[test]
    fn matches_transaction_question_and_handles_failure_without_plaintext() {
        let q = query_packet(88, 1);
        let info = read_query(&q).unwrap();
        let good = mock(false, false, false).forward(&q).unwrap();
        assert!(valid_upstream_answer(&q, &good, info.end_of_question));
        let mut bad_question = good.clone();
        bad_question[13] = b'Z';
        assert!(!valid_upstream_answer(
            &q,
            &bad_question,
            info.end_of_question
        ));
        let servfail = reply_for_query(mock(false, true, false).as_ref(), &q).unwrap();
        assert_eq!(&servfail[0..2], &q[0..2]);
        assert_eq!(servfail[3] & 0x0f, 2);
        assert_eq!(u16::from_be_bytes([servfail[6], servfail[7]]), 0);
        let mismatch = reply_for_query(mock(true, false, false).as_ref(), &q).unwrap();
        assert_eq!(mismatch[3] & 0x0f, 2);
    }

    #[test]
    fn oversized_upstream_response_results_in_tc_not_udp_fragmentation() {
        let q = query_packet(99, 1);
        let reply = reply_for_query(mock(false, false, true).as_ref(), &q).unwrap();
        assert!(reply[2] & 0x02 != 0);
        assert_eq!(reply.len(), 12 + b"\x07example\x03com\x00".len() + 4);
    }

    #[test]
    fn native_loopback_udp_socket_forwards_and_cleans_up() -> Result<(), String> {
        let proxy = UdpDotPreview::start_with_upstream(mock(false, false, false))?;
        assert!(proxy.local_address().ip().is_loopback());
        assert_ne!(proxy.local_address().port(), 53);
        let socket = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        let query = query_packet(0xa1b2, 1);
        socket
            .send_to(&query, proxy.local_address())
            .map_err(|e| e.to_string())?;
        let mut answer = [0u8; 512];
        let (len, peer) = socket.recv_from(&mut answer).map_err(|e| e.to_string())?;
        assert_eq!(peer, proxy.local_address());
        assert!(parse_reply(&answer[..len], 0xa1b2, 1).is_ok());
        drop(proxy);
        Ok(())
    }

    #[test]
    fn native_loopback_udp_sends_servfail_on_upstream_error() -> Result<(), String> {
        let proxy = UdpDotPreview::start_with_upstream(mock(false, true, false))?;
        let socket = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        let query = query_packet(0x1941, 28);
        socket
            .send_to(&query, proxy.local_address())
            .map_err(|e| e.to_string())?;
        let mut buf = [0u8; 512];
        let (len, _) = socket.recv_from(&mut buf).map_err(|e| e.to_string())?;
        assert_eq!(buf[3] & 0x0f, 2);
        assert_eq!(&buf[..2], &query[..2]);
        assert!(len < 512);
        drop(proxy);
        Ok(())
    }

    #[test]
    fn dual_stack_loopback_udp_and_tcp_share_port() -> Result<(), String> {
        let resolver = mock(false, false, false);
        let server = LoopbackDnsServer::start_with_upstream(resolver, 0)?;
        assert_ne!(server.local_port(), 0);
        for local in ["127.0.0.1", "::1"] {
            let address: SocketAddr = format!(
                "{}:{}",
                if local.contains(':') {
                    format!("[{local}]")
                } else {
                    local.to_owned()
                },
                server.local_port()
            )
            .parse()
            .map_err(|_| "test address parse failure".to_owned())?;
            let socket = if local.contains(':') {
                UdpSocket::bind("[::1]:0")
            } else {
                UdpSocket::bind("127.0.0.1:0")
            }
            .map_err(|e| e.to_string())?;
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .map_err(|e| e.to_string())?;
            let packet = query_packet(0x1405, 1);
            socket
                .send_to(&packet, address)
                .map_err(|e| e.to_string())?;
            let mut reply = [0u8; 512];
            let (n, _) = socket.recv_from(&mut reply).map_err(|e| e.to_string())?;
            assert!(parse_reply(&reply[..n], 0x1405, 1).is_ok());

            let mut tcp = TcpStream::connect_timeout(&address, Duration::from_secs(2))
                .map_err(|e| e.to_string())?;
            tcp.set_read_timeout(Some(Duration::from_secs(2)))
                .map_err(|e| e.to_string())?;
            tcp.write_all(&(packet.len() as u16).to_be_bytes())
                .map_err(|e| e.to_string())?;
            tcp.write_all(&packet).map_err(|e| e.to_string())?;
            let mut header = [0u8; 2];
            tcp.read_exact(&mut header).map_err(|e| e.to_string())?;
            let mut dns = vec![0u8; usize::from(u16::from_be_bytes(header))];
            tcp.read_exact(&mut dns).map_err(|e| e.to_string())?;
            assert!(parse_reply(&dns, 0x1405, 1).is_ok());
        }
        drop(server);
        Ok(())
    }

    #[test]
    fn tcp_transports_large_dns_responses_without_udp_truncation() {
        let query = query_packet(88, 1);
        let answer = reply_for_tcp(mock(false, false, true).as_ref(), &query).unwrap();
        assert!(answer.len() > 512);
        assert_eq!(answer[2] & 2, 0);
        let datagram = reply_for_query(mock(false, false, true).as_ref(), &query).unwrap();
        assert_ne!(datagram[2] & 2, 0);
    }

    #[test]
    fn port_conflicts_block_all_dns_server_startup() -> Result<(), String> {
        let occupied = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = occupied.local_addr().map_err(|e| e.to_string())?.port();
        assert!(LoopbackDnsServer::start_with_upstream(mock(false, false, false), port).is_err());
        Ok(())
    }

    #[test]
    fn tcp_upstream_failure_returns_servfail() {
        let query = query_packet(91, 1);
        let answer = reply_for_tcp(mock(false, true, false).as_ref(), &query).unwrap();
        assert_eq!(answer[3] & 15, 2);
    }
    #[test]
    fn oversized_and_invalid_packets_are_dropped_without_reply() -> Result<(), io::Error> {
        let proxy = UdpDotPreview::start_with_upstream(mock(false, false, false))
            .map_err(io::Error::other)?;
        let socket = UdpSocket::bind("127.0.0.1:0")?;
        socket.set_read_timeout(Some(Duration::from_millis(350)))?;
        socket.send_to(&[1, 2, 3], proxy.local_address())?;
        let mut reply = [0u8; 512];
        assert!(socket.recv_from(&mut reply).is_err());
        drop(proxy);
        Ok(())
    }
}
