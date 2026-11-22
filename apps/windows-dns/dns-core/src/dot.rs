//! Authenticated DNS-over-TLS reachability check (RFC 7858, RFC 8310).
//! Never modifies Windows DNS, routes, service, or credentials.
//! Uses the platform TLS trust store; certificate and hostname verification
//! remain enabled. No plaintext DNS fallback is performed by this probe.

use super::{parse_reply, query_packet, EndpointProbe, NEXT_DNS_ID};
use native_tls::TlsConnector;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const DOT_PORT: u16 = 853;
const IO_TIMEOUT: Duration = Duration::from_millis(2500);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_IP_ADDRESSES: usize = 4;
const MAX_DNS_FRAME: usize = 4096;

#[derive(Clone, Debug, Serialize)]
pub struct DotProbeReport {
    pub tls_verified: bool,
    pub ipv4: EndpointProbe,
    pub ipv6: EndpointProbe,
    pub elapsed_ms: u64,
    /// True only if both DNS queries were validated through authenticated TLS.
    pub complete: bool,
}

fn checked_hostname(input: &str) -> Result<String, String> {
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
                || !part.bytes().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-')
        })
    {
        return Err("Некорректное DNS-имя. Нужен хост без https://, пути и порта".into());
    }
    Ok(host)
}

fn exchange<S: Read + Write>(
    stream: &mut S,
    id: u16,
    kind: u16,
) -> Result<EndpointProbe, &'static str> {
    let query = query_packet(id, kind);
    let size = u16::try_from(query.len()).map_err(|_| "Слишком большой DNS-запрос")?;
    let started = Instant::now();
    stream
        .write_all(&size.to_be_bytes())
        .and_then(|_| stream.write_all(&query))
        .and_then(|_| stream.flush())
        .map_err(|_| "Не удалось отправить DNS-запрос внутри TLS")?;

    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .map_err(|_| "Нет длины DNS-ответа внутри TLS")?;
    let length = u16::from_be_bytes(header) as usize;
    if !(12..=MAX_DNS_FRAME).contains(&length) {
        return Err("Некорректный размер DNS-ответа внутри TLS");
    }
    let mut packet = vec![0u8; length];
    stream
        .read_exact(&mut packet)
        .map_err(|_| "DNS-ответ внутри TLS оборван")?;
    let answer_count = parse_reply(&packet, id, kind)
        .map_err(|_| "DNS-ответ внутри TLS не прошёл проверку")?;
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
    let started = Instant::now();

    // Bootstrap hostname resolution is performed by the OS resolver. This
    // diagnostic does not claim that bootstrap resolution itself uses DoT.
    let addresses = (host.as_str(), DOT_PORT)
        .to_socket_addrs()
        .map_err(|_| "Windows не смогла определить IP-адрес DoT-сервера".to_owned())?;
    let mut stream = None;
    for address in addresses.take(MAX_IP_ADDRESSES) {
        if let Ok(connection) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            stream = Some(connection);
            break;
        }
    }
    let connection =
        stream.ok_or_else(|| "Не удалось установить TCP-соединение с DoT-сервером на порту 853".to_owned())?;
    connection
        .set_read_timeout(Some(IO_TIMEOUT))
        .and_then(|_| connection.set_write_timeout(Some(IO_TIMEOUT)))
        .and_then(|_| connection.set_nodelay(true))
        .map_err(|_| "Не удалось настроить таймауты защищённого соединения".to_owned())?;
    let connector = TlsConnector::new()
        .map_err(|_| "Не удалось создать системный TLS-контекст Windows".to_owned())?;
    let mut tls = connector
        .connect(&host, connection)
        .map_err(|_| "TLS-рукопожатие или проверка сертификата/имени DoT-сервера не прошли".to_owned())?;

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

    struct FakeTls {
        incoming: Cursor<Vec<u8>>,
        sent: Vec<u8>,
    }

    impl Read for FakeTls {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.incoming.read(buf)
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
        let addr = if qtype == 1 { vec![93, 184, 215, 14] } else { vec![0u8; 16] };
        answer.extend_from_slice(&(addr.len() as u16).to_be_bytes());
        answer.extend_from_slice(&addr);
        let mut framed = (answer.len() as u16).to_be_bytes().to_vec();
        framed.extend_from_slice(&answer);
        framed
    }

    #[test]
    fn host_validation_rejects_urls_ports_ip_literals_and_local() {
        for host in [
            "", "localhost", "resolver.local", "127.0.0.1", "::1",
            "https://dns.example.com", "dns.example.com:853",
            "dns.example.com/path", "bad..example.com", "-bad.example.com",
            "dns.example.com\nInjected", "dns_example.com",
        ] {
            assert!(checked_hostname(host).is_err(), "Accepted invalid hostname");
        }
        assert_eq!(checked_hostname("  A1B2.dns.example.com  ").unwrap(), "a1b2.dns.example.com");
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
