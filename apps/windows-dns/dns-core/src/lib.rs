//! Read-only localhost DNS diagnosis shared by the GUI and Windows health service.
//! A successful local query does NOT prove upstream DoT or Smart DNS routing.

use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static NEXT_DNS_ID: AtomicU16 = AtomicU16::new(0x5379);
const QUERY_TIMEOUT: Duration = Duration::from_millis(900);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EndpointProbe {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub answer_count: u16,
    pub error: Option<String>,
}

impl EndpointProbe {
    fn failure(error: &str) -> Self {
        Self {
            ok: false,
            latency_ms: None,
            answer_count: 0,
            error: Some(error.to_owned()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DnsProbeReport {
    pub checked_at_ms: u64,
    pub ipv4: EndpointProbe,
    pub ipv6: EndpointProbe,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServiceReport {
    pub schema_version: u8,
    pub updated_at_ms: u64,
    pub probe: DnsProbeReport,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn query_packet(id: u16, query_type: u16) -> Vec<u8> {
    let mut request = vec![
        (id >> 8) as u8,
        (id & 0xff) as u8,
        0x01,
        0x00,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
    ];
    request.extend_from_slice(b"\x07example\x03com\x00");
    request.extend_from_slice(&query_type.to_be_bytes());
    request.extend_from_slice(&1u16.to_be_bytes());
    request
}

/// Returns a nonzero answer count for a syntactically plausible response to our query.
/// This is not DNSSEC, TLS, or upstream identity verification.
fn parse_reply(packet: &[u8], id: u16) -> Result<u16, &'static str> {
    if packet.len() < 12 {
        return Err("Короткий DNS-ответ");
    }
    if u16::from_be_bytes([packet[0], packet[1]]) != id {
        return Err("Не совпадает идентификатор DNS-запроса");
    }
    if packet[2] & 0x80 == 0 {
        return Err("Получено не DNS-сообщение ответа");
    }
    if packet[2] & 0x02 != 0 {
        return Err("Ответ DNS усечён");
    }
    if packet[3] & 0x0f != 0 {
        return Err("DNS-сервер вернул ошибку");
    }
    if u16::from_be_bytes([packet[4], packet[5]]) != 1 {
        return Err("Некорректный счётчик вопросов DNS");
    }
    let count = u16::from_be_bytes([packet[6], packet[7]]);
    if count == 0 {
        return Err("Пустой DNS-ответ");
    }
    Ok(count)
}

fn probe_one(address: SocketAddr, qtype: u16) -> EndpointProbe {
    let bind_addr = if address.is_ipv4() {
        "127.0.0.1:0"
    } else {
        "[::1]:0"
    };
    let socket = match UdpSocket::bind(bind_addr) {
        Ok(socket) => socket,
        Err(_) => return EndpointProbe::failure("Не удалось создать локальный UDP-сокет"),
    };
    if socket.set_read_timeout(Some(QUERY_TIMEOUT)).is_err() {
        return EndpointProbe::failure("Не удалось установить таймаут DNS");
    }
    let id = NEXT_DNS_ID.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    if socket.send_to(&query_packet(id, qtype), address).is_err() {
        return EndpointProbe::failure("Локальный DNS-сервер недоступен");
    }
    let mut response = [0u8; 4096];
    let (len, sender) = match socket.recv_from(&mut response) {
        Ok(tuple) => tuple,
        Err(_) => return EndpointProbe::failure("Нет ответа от локального DNS (таймаут)"),
    };
    if sender != address {
        return EndpointProbe::failure("DNS-ответ получен с другого адреса");
    }
    match parse_reply(&response[..len], id) {
        Ok(answer_count) => EndpointProbe {
            ok: true,
            latency_ms: Some(started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)),
            answer_count,
            error: None,
        },
        Err(error) => EndpointProbe::failure(error),
    }
}

/// Both addresses are localhost-only; no system adapters or VPN routes are touched.
pub fn probe_loopback() -> DnsProbeReport {
    DnsProbeReport {
        checked_at_ms: now_ms(),
        ipv4: probe_one(SocketAddr::from(([127, 0, 0, 1], 53)), 1),
        ipv6: probe_one(SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], 53)), 28),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_encodes_a_and_aaaa_without_external_network() {
        let a = query_packet(0x1234, 1);
        let aaaa = query_packet(0x1234, 28);
        assert_eq!(&a[0..2], &[0x12, 0x34]);
        assert_eq!(&a[12..25], b"\x07example\x03com\x00");
        assert_eq!(&a[a.len() - 4..], &[0, 1, 0, 1]);
        assert_eq!(&aaaa[aaaa.len() - 4..], &[0, 28, 0, 1]);
    }

    #[test]
    fn parser_requires_matching_id_and_answer() {
        let good = [0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0];
        assert_eq!(parse_reply(&good, 0x1234), Ok(1));
        assert!(parse_reply(&good, 0x4321).is_err());
        assert!(parse_reply(&good[..11], 0x1234).is_err());
    }

    #[test]
    fn parser_rejects_truncation_errors_and_empty_answers() {
        let mut packet = [0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0];
        packet[2] = 0x83;
        assert!(parse_reply(&packet, 0x1234).is_err());
        packet[2] = 0x81;
        packet[3] = 0x83;
        assert!(parse_reply(&packet, 0x1234).is_err());
        packet[3] = 0x80;
        packet[7] = 0;
        assert!(parse_reply(&packet, 0x1234).is_err());
    }
}
