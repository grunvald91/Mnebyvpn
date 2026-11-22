//! Read-only localhost DNS diagnosis shared by the GUI and Windows health service.
//! A successful local query does NOT prove upstream DoT or Smart DNS routing.

use serde::{Deserialize, Serialize};

mod dot;
mod udp_proxy;
pub use dot::{probe_dot_strict, DotProbeReport};
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub use udp_proxy::{smoke_udp_dot_preview, UdpDotPreview, UdpDotSmokeReport};

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
    /// Internal service state only; not an authorization or truth signal for GUI.
    #[serde(default)]
    pub recovery_state: Option<String>,
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

/// Validate a full positive DNS answer for the exact name and type we queried.
/// A response on localhost proves only local DNS functionality, not TLS/DoT.
fn parse_reply(packet: &[u8], id: u16, requested_type: u16) -> Result<u16, &'static str> {
    if packet.len() < 12 {
        return Err("Короткий DNS-ответ");
    }
    if u16::from_be_bytes([packet[0], packet[1]]) != id {
        return Err("Не совпадает идентификатор DNS-запроса");
    }
    if packet[2] & 0x80 == 0 || packet[2] & 0x78 != 0 {
        return Err("Некорректные флаги DNS-ответа");
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

    const QUERY_NAME: &[u8] = b"\x07example\x03com\x00";
    let question_end = 12 + QUERY_NAME.len() + 4;
    if packet.len() < question_end || &packet[12..12 + QUERY_NAME.len()] != QUERY_NAME {
        return Err("DNS-ответ содержит другой вопрос");
    }
    let qtype = u16::from_be_bytes([packet[12 + QUERY_NAME.len()], packet[13 + QUERY_NAME.len()]]);
    let qclass = u16::from_be_bytes([packet[14 + QUERY_NAME.len()], packet[15 + QUERY_NAME.len()]]);
    if qtype != requested_type || qclass != 1 {
        return Err("DNS-ответ содержит другой тип вопроса");
    }

    let count = u16::from_be_bytes([packet[6], packet[7]]);
    if count == 0 {
        return Err("Пустой DNS-ответ");
    }

    let mut cursor = question_end;
    let mut matching_records = 0u16;
    for _ in 0..count {
        let (owner, next) =
            decode_dns_name(packet, cursor).ok_or("Некорректное имя в DNS-ответе")?;
        cursor = next;
        if packet.len() < cursor + 10 {
            return Err("Повреждена запись DNS-ответа");
        }
        let record_type = u16::from_be_bytes([packet[cursor], packet[cursor + 1]]);
        let record_class = u16::from_be_bytes([packet[cursor + 2], packet[cursor + 3]]);
        let data_len = u16::from_be_bytes([packet[cursor + 8], packet[cursor + 9]]) as usize;
        cursor += 10;
        let data_end = cursor
            .checked_add(data_len)
            .ok_or("Некорректная длина DNS-ответа")?;
        if data_end > packet.len() {
            return Err("Обрезанные данные DNS-ответа");
        }
        if owner.eq_ignore_ascii_case(QUERY_NAME)
            && record_type == requested_type
            && record_class == 1
            && ((requested_type == 1 && data_len == 4) || (requested_type == 28 && data_len == 16))
        {
            matching_records += 1;
        }
        cursor = data_end;
    }

    if matching_records == 0 {
        return Err("DNS-ответ не содержит запрошенного IP-адреса");
    }
    Ok(matching_records)
}

/// Decode bounded DNS wire-format owner names, including compression.
/// Compression pointers must point strictly backward and cannot form loops.
/// Returns the expanded name and the position after the encoded name.
fn decode_dns_name(packet: &[u8], mut cursor: usize) -> Option<(Vec<u8>, usize)> {
    let mut name = Vec::new();
    let mut encoded_end = None;
    for _ in 0..128 {
        let label = *packet.get(cursor)?;
        if label & 0xc0 == 0xc0 {
            let next = *packet.get(cursor + 1)?;
            let target = (((label & 0x3f) as usize) << 8) | next as usize;
            if target < 12 || target >= cursor {
                return None;
            }
            if encoded_end.is_none() {
                encoded_end = Some(cursor + 2);
            }
            cursor = target;
            continue;
        }
        if label & 0xc0 != 0 || label > 63 {
            return None;
        }
        let len = label as usize;
        if name.len().checked_add(len + 1)? > 255 {
            return None;
        }
        name.push(label);
        cursor += 1;
        if label == 0 {
            return Some((name, encoded_end.unwrap_or(cursor)));
        }
        name.extend_from_slice(packet.get(cursor..cursor.checked_add(len)?)?);
        cursor += len;
    }
    None
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
    match parse_reply(&response[..len], id, qtype) {
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

    fn dns_reply(query_type: u16, data: &[u8]) -> Vec<u8> {
        let mut answer = query_packet(0x1234, query_type);
        answer[2] = 0x81;
        answer[3] = 0x80;
        answer[7] = 1;
        answer.extend_from_slice(&[0xc0, 0x0c]); // compression pointer to question
        answer.extend_from_slice(&query_type.to_be_bytes());
        answer.extend_from_slice(&1u16.to_be_bytes());
        answer.extend_from_slice(&60u32.to_be_bytes());
        answer.extend_from_slice(&(data.len() as u16).to_be_bytes());
        answer.extend_from_slice(data);
        answer
    }

    #[test]
    fn parser_validates_complete_positive_a_and_aaaa_answers() {
        let a = dns_reply(1, &[93, 184, 215, 14]);
        assert_eq!(parse_reply(&a, 0x1234, 1), Ok(1));
        assert!(parse_reply(&a, 0x4321, 1).is_err());
        assert!(parse_reply(&a, 0x1234, 28).is_err());

        let aaaa = dns_reply(28, &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(parse_reply(&aaaa, 0x1234, 28), Ok(1));
    }

    #[test]
    fn reply_does_not_accept_an_address_for_a_different_owner() {
        let original = dns_reply(1, &[93, 184, 215, 14]);
        let answer_start = 12 + b"\x07example\x03com\x00".len() + 4;
        let mut forged = original[..answer_start].to_vec();
        forged.extend_from_slice(b"\x05wrong\x03com\x00");
        forged.extend_from_slice(&original[answer_start + 2..]);
        assert!(parse_reply(&forged, 0x1234, 1).is_err());
        let (owner, next) = decode_dns_name(&original, answer_start).unwrap();
        assert_eq!(owner, b"\x07example\x03com\x00");
        assert_eq!(next, answer_start + 2);
        let mut looping = original;
        looping[answer_start] = 0xc0;
        looping[answer_start + 1] = answer_start as u8;
        assert!(parse_reply(&looping, 0x1234, 1).is_err());
    }

    #[test]
    fn parser_rejects_incomplete_and_mismatched_payloads() {
        let a = dns_reply(1, &[93, 184, 215, 14]);
        assert!(parse_reply(&a[..12], 0x1234, 1).is_err());
        assert!(parse_reply(&a[..a.len() - 2], 0x1234, 1).is_err());
        let mut wrong_question = a.clone();
        wrong_question[13] = b'X';
        assert!(parse_reply(&wrong_question, 0x1234, 1).is_err());
        let mut truncated = a.clone();
        truncated[2] |= 0x02;
        assert!(parse_reply(&truncated, 0x1234, 1).is_err());
        let mut rcode = a.clone();
        rcode[3] |= 0x03;
        assert!(parse_reply(&rcode, 0x1234, 1).is_err());
        let mut pointer_loop = a.clone();
        pointer_loop[29] = 0xc0;
        pointer_loop[30] = 29;
        assert!(parse_reply(&pointer_loop, 0x1234, 1).is_err());
    }
}
