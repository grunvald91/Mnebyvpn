//! Authenticated DNS-over-TLS reachability check (RFC 7858, RFC 8310).
//! Never modifies Windows DNS, routes, service, or credentials.
//! Uses the platform TLS trust store; certificate and hostname verification
//! remain enabled. No plaintext DNS fallback is performed by this probe.

use super::{parse_reply, query_packet, EndpointProbe, NEXT_DNS_ID};
use native_tls::TlsConnector;
use serde::Serialize;
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub(crate) const DOT_PORT: u16 = 853;
pub(crate) const IO_TIMEOUT: Duration = Duration::from_millis(2500);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_IP_ADDRESSES: usize = 5;
// DoT uses a 16-bit length prefix; preserve full legitimate DNS/TCP frames.
pub(crate) const MAX_DNS_FRAME: usize = u16::MAX as usize;
const MAX_OS_ADDRESSES: usize = 32;

pub(crate) type AuthenticatedStream = native_tls::TlsStream<TcpStream>;

/// DNS-over-TLS must not allow slow trickle responses to prolong a probe
/// indefinitely: each read is bounded by the time LEFT in one frame deadline.
pub(crate) trait DnsIo: Read + Write {
    fn set_read_budget(&self, remaining: Duration) -> io::Result<()>;
}
impl DnsIo for AuthenticatedStream {
    fn set_read_budget(&self, remaining: Duration) -> io::Result<()> {
        self.get_ref().set_read_timeout(Some(remaining))
    }
}

pub(crate) fn read_exact_until<S: DnsIo>(
    stream: &mut S,
    bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), &'static str> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Время ожидания DNS-ответа через TLS истекло");
        }
        stream
            .set_read_budget(remaining)
            .map_err(|_| "Не удалось ограничить ожидание DNS-ответа")?;
        match stream.read(&mut bytes[offset..]) {
            Ok(0) => return Err("DNS-сервер разорвал TLS-соединение до полного ответа"),
            Ok(n) => offset += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Не удалось прочитать DNS-ответ внутри TLS"),
        }
        if Instant::now() > deadline {
            return Err("Время ожидания DNS-ответа через TLS истекло");
        }
    }
    Ok(())
}

/// Prefer IPv4 where the personal service has no IPv6 record, but never
/// discard all IPv6 candidates just because Windows listed them first.
/// Deduplicate and bound retries to keep a failed probe responsive.
pub(crate) fn candidate_addresses(addresses: impl Iterator<Item = SocketAddr>) -> Vec<SocketAddr> {
    let mut ipv4 = Vec::new();
    let mut ipv6 = Vec::new();
    for address in addresses.take(MAX_OS_ADDRESSES) {
        let bucket = if address.is_ipv4() {
            &mut ipv4
        } else {
            &mut ipv6
        };
        if !bucket.contains(&address) {
            bucket.push(address);
        }
    }
    ipv4.into_iter()
        .take(3)
        .chain(ipv6.into_iter().take(2))
        .take(MAX_IP_ADDRESSES)
        .collect()
}

/// Resolve the personal DoT hostname before Windows DNS is redirected to
/// localhost. The returned socket addresses are persisted so the service can
/// restart after reboot without depending on the DNS resolver it replaces.
pub fn resolve_dot_addresses(hostname: &str) -> Result<Vec<SocketAddr>, String> {
    let host = checked_hostname(hostname)?;
    let addresses = (host.as_str(), DOT_PORT)
        .to_socket_addrs()
        .map_err(|_| "Не удалось разрешить имя персонального DoT-сервера".to_owned())?;
    let candidates = candidate_addresses(addresses);
    if candidates.is_empty() {
        return Err("Для персонального DoT-сервера не найден IP-адрес".into());
    }
    Ok(candidates)
}

pub(crate) fn connect_authenticated(
    host: &str,
    addresses: impl Iterator<Item = SocketAddr>,
    connector: &TlsConnector,
) -> Result<AuthenticatedStream, String> {
    let mut tls_failed = false;
    for address in candidate_addresses(addresses) {
        let connection = match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        if connection.set_read_timeout(Some(IO_TIMEOUT)).is_err()
            || connection.set_write_timeout(Some(IO_TIMEOUT)).is_err()
            || connection.set_nodelay(true).is_err()
        {
            continue;
        }
        match connector.connect(host, connection) {
            Ok(tls) => return Ok(tls),
            Err(_) => tls_failed = true,
        }
    }
    if tls_failed {
        Err("TCP:853 доступен, но TLS-сертификат или рукопожатие не прошли проверку".to_owned())
    } else {
        Err("Не удалось установить TCP-соединение с DoT-сервером на порту 853".to_owned())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct DotProbeReport {
    pub tls_verified: bool,
    pub ipv4: EndpointProbe,
    pub ipv6: EndpointProbe,
    pub elapsed_ms: u64,
    /// True only if both DNS queries were validated through authenticated TLS.
    pub complete: bool,
}

pub(crate) fn checked_hostname(input: &str) -> Result<String, String> {
    // DNS authentication requires the exact hostname from the trusted profile.
    // Reject URLs, ports, IP literals, control characters and whitespace.
    let host = input.trim().to_ascii_lowercase();
    if host.len() < 4 || host.len() > 253 || host.parse::<IpAddr>().is_ok() {
        return Err("Укажите полное DNS-имя сервера, без IP-адреса".into());
    }
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err("Локальные имена нельзя использовать как персональный DoT-сервер".into());
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2
        || labels.iter().any(|part| {
            part.is_empty()
                || part.len() > 63
                || part.starts_with('-')
                || part.ends_with('-')
                || !part
                    .bytes()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-')
        })
    {
        return Err("Некорректное DNS-имя. Нужен хост без https://, пути и порта".into());
    }
    Ok(host)
}

fn exchange<S: DnsIo>(stream: &mut S, id: u16, kind: u16) -> Result<EndpointProbe, &'static str> {
    let query = query_packet(id, kind);
    let size = u16::try_from(query.len()).map_err(|_| "Слишком большой DNS-запрос")?;
    let started = Instant::now();
    stream
        .write_all(&size.to_be_bytes())
        .and_then(|_| stream.write_all(&query))
        .and_then(|_| stream.flush())
        .map_err(|_| "Не удалось отправить DNS-запрос внутри TLS")?;

    let deadline = Instant::now() + IO_TIMEOUT;
    let mut header = [0u8; 2];
    read_exact_until(stream, &mut header, deadline)?;
    let length = u16::from_be_bytes(header) as usize;
    if !(12..=MAX_DNS_FRAME).contains(&length) {
        return Err("Некорректный размер DNS-ответа внутри TLS");
    }
    let mut packet = vec![0u8; length];
    read_exact_until(stream, &mut packet, deadline)?;
    let answer_count =
        parse_reply(&packet, id, kind).map_err(|_| "DNS-ответ внутри TLS не прошёл проверку")?;
    Ok(EndpointProbe {
        ok: true,
        latency_ms: Some(started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)),
        answer_count,
        error: None,
    })
}

/// Performs a strict upstream check without persisting the hostname.
/// Verifies the certificate chain AND authentication hostname using native-tls.
/// TCP 853 is fixed, and no fallback to cleartext DNS is allowed.
pub fn probe_dot_strict(input: &str) -> Result<DotProbeReport, String> {
    let host = checked_hostname(input)?;
    // Diagnostic for a NEW hostname. Bootstrap resolution uses the OS.
    let addresses = (host.as_str(), DOT_PORT)
        .to_socket_addrs()
        .map_err(|_| "Windows не смогла определить IP-адрес DoT-сервера".to_owned())?;
    probe_dot_using_addresses(&host, addresses)
}

/// Checks an already saved DoT profile without asking Windows to resolve its
/// hostname again. This avoids DNS bootstrap loops while system DNS is active
/// and never exposes the customer's personalized domain to the GUI.
pub fn probe_dot_pinned(host: &str, addresses: &[SocketAddr]) -> Result<DotProbeReport, String> {
    let host = checked_hostname(host)?;
    if addresses.is_empty()
        || addresses.len() > MAX_IP_ADDRESSES
        || addresses.iter().any(|addr| {
            addr.port() != DOT_PORT
                || addr.ip().is_loopback()
                || addr.ip().is_unspecified()
                || addr.ip().is_multicast()
        })
    {
        return Err("Некорректные сохранённые адреса DoT".to_owned());
    }
    probe_dot_using_addresses(&host, addresses.iter().copied())
}

fn probe_dot_using_addresses(
    host: &str,
    addresses: impl Iterator<Item = SocketAddr>,
) -> Result<DotProbeReport, String> {
    let started = Instant::now();
    let mut tls_builder = TlsConnector::builder();
    // Explicitly disallow TLS 1.0/1.1 even when an older Windows policy allows them.
    tls_builder.min_protocol_version(Some(native_tls::Protocol::Tlsv12));
    let connector = tls_builder
        .build()
        .map_err(|_| "Не удалось создать системный TLS-контекст Windows".to_owned())?;
    let mut tls = connect_authenticated(host, addresses, &connector)?;

    let a_id = NEXT_DNS_ID.fetch_add(1, Ordering::Relaxed);
    let ipv4 = match exchange(&mut tls, a_id, 1) {
        Ok(probe) => probe,
        Err(error) => EndpointProbe::failure(error),
    };
    let ipv6 = if ipv4.ok {
        let aaaa_id = NEXT_DNS_ID.fetch_add(1, Ordering::Relaxed);
        match exchange(&mut tls, aaaa_id, 28) {
            Ok(probe) => probe,
            Err(error) => EndpointProbe::failure(error),
        }
    } else {
        EndpointProbe::failure("AAAA не проверялась: предыдущий запрос A завершился ошибкой")
    };
    let complete = ipv4.ok && ipv6.ok;
    Ok(DotProbeReport {
        tls_verified: true,
        ipv4,
        ipv6,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        complete,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn saved_probe_rejects_missing_or_unsafe_pinned_servers_before_network_io() {
        assert!(probe_dot_pinned("dns.example.net", &[]).is_err());
        assert!(probe_dot_pinned(
            "dns.example.net",
            &[SocketAddr::from(([127, 0, 0, 1], DOT_PORT))]
        )
        .is_err());
        assert!(probe_dot_pinned(
            "dns.example.net",
            &[SocketAddr::from(([198, 51, 100, 1], 443))]
        )
        .is_err());
    }

    struct FakeTls {
        incoming: Cursor<Vec<u8>>,
        sent: Vec<u8>,
    }

    impl Read for FakeTls {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.incoming.read(buf)
        }
    }
    impl DnsIo for FakeTls {
        fn set_read_budget(&self, _: Duration) -> io::Result<()> {
            Ok(())
        }
    }
    impl Write for FakeTls {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.sent.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn valid_reply(id: u16, qtype: u16) -> Vec<u8> {
        let mut answer = query_packet(id, qtype);
        answer[2] = 0x81;
        answer[3] = 0x80;
        answer[7] = 1;
        answer.extend_from_slice(&[0xc0, 0x0c]);
        answer.extend_from_slice(&qtype.to_be_bytes());
        answer.extend_from_slice(&1u16.to_be_bytes());
        answer.extend_from_slice(&60u32.to_be_bytes());
        let addr = if qtype == 1 {
            vec![93, 184, 215, 14]
        } else {
            vec![0u8; 16]
        };
        answer.extend_from_slice(&(addr.len() as u16).to_be_bytes());
        answer.extend_from_slice(&addr);
        let mut framed = (answer.len() as u16).to_be_bytes().to_vec();
        framed.extend_from_slice(&answer);
        framed
    }

    #[test]
    fn host_validation_rejects_urls_ports_ip_literals_and_local() {
        for host in [
            "",
            "localhost",
            "resolver.local",
            "127.0.0.1",
            "::1",
            "https://dns.example.com",
            "dns.example.com:853",
            "dns.example.com/path",
            "bad..example.com",
            "-bad.example.com",
            "dns.example.com\nInjected",
            "dns_example.com",
        ] {
            assert!(checked_hostname(host).is_err(), "Accepted invalid hostname");
        }
        assert_eq!(
            checked_hostname("  A1B2.dns.example.com  ").unwrap(),
            "a1b2.dns.example.com"
        );
    }

    #[test]
    fn dot_message_framing_validates_a_and_aaaa() {
        for kind in [1, 28] {
            let mut tls = FakeTls {
                incoming: Cursor::new(valid_reply(0x1248, kind)),
                sent: vec![],
            };
            let probe = exchange(&mut tls, 0x1248, kind).unwrap();
            assert!(probe.ok);
            let sent_len = u16::from_be_bytes([tls.sent[0], tls.sent[1]]) as usize;
            assert_eq!(sent_len, tls.sent.len() - 2);
            assert_eq!(&tls.sent[2..4], &[0x12, 0x48]);
        }
    }

    #[test]
    fn candidates_prefer_ipv4_and_retry_both_families() {
        use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6};
        let v6 = SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 853, 0, 0));
        let v4 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 10), 853));
        assert_eq!(candidate_addresses([v6, v6, v4].into_iter()), vec![v4, v6]);
        assert_eq!(candidate_addresses(std::iter::empty()).len(), 0);
        let many = std::iter::repeat(v4).take(100);
        assert_eq!(candidate_addresses(many), vec![v4]);
    }

    #[test]
    fn slow_dns_frame_cannot_ignore_deadline() {
        let mut tls = FakeTls {
            incoming: Cursor::new(valid_reply(6, 1)),
            sent: vec![],
        };
        let mut bytes = [0u8; 2];
        let expired = Instant::now() - Duration::from_millis(1);
        assert!(read_exact_until(&mut tls, &mut bytes, expired).is_err());
    }

    #[test]
    fn dot_rejects_replayed_oversized_and_truncated_frames() {
        let mut replay = FakeTls {
            incoming: Cursor::new(valid_reply(1, 1)),
            sent: vec![],
        };
        assert!(exchange(&mut replay, 2, 1).is_err());
        let mut big = FakeTls {
            incoming: Cursor::new(5000u16.to_be_bytes().to_vec()),
            sent: vec![],
        };
        assert!(exchange(&mut big, 3, 1).is_err());
        let mut truncated = valid_reply(4, 1);
        truncated.pop();
        let mut tls = FakeTls {
            incoming: Cursor::new(truncated),
            sent: vec![],
        };
        assert!(exchange(&mut tls, 4, 1).is_err());
    }
}
