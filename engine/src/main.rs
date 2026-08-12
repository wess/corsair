//! A STARTTLS terminator for Corsair's SMTP listeners.
//!
//! Corsair runs on Bun, and Bun cannot upgrade an *accepted* socket to TLS:
//! `socket.upgradeTLS({ isServer: true })` answers "Server-side upgradeTLS is
//! not supported. Use upgradeDuplexToTLS with isServer: true instead", and
//! `Bun.upgradeDuplexToTLS` exists on no build. `node:tls` cannot do it either —
//! wrapping an existing socket in a `TLSSocket` constructs the object and then
//! never handshakes. So the mail server advertises STARTTLS nowhere, port 25
//! carries cleartext, and port 587 is unusable because AUTH is refused without
//! encryption.
//!
//! This process sits in front of those two ports and does the one thing the
//! runtime cannot. It is deliberately *not* an SMTP server: it relays the
//! conversation verbatim and intervenes at exactly two points — it advertises
//! STARTTLS in the EHLO response, and it performs the upgrade. Every policy
//! decision, every rejection, and the entire mail path stay in Corsair.
//!
//! The client's real address is handed to the backend with XCLIENT before the
//! session begins. That is load-bearing rather than cosmetic: without it every
//! connection would appear to originate from loopback, which is both a useless
//! SPF result and — because Corsair treats a loopback peer as itself — a way to
//! have any sender's mail accepted as locally generated.

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{server::TlsStream, TlsAcceptor};

/// RFC 5321 §4.5.3.1 caps a command line at 512 octets. The slack matches the
/// backend's own, which exists for the non-conforming senders there are a lot
/// of; past it, this is a probe rather than mail.
const MAX_LINE: usize = 4096;

// ------------------------------------------------------------------ stream --

/// The client connection, before and after the upgrade.
///
/// One type for both so the relay loop does not care which it is holding.
enum Client {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
    /// Held only for the instant the upgrade swaps one for the other.
    Swapping,
}

impl AsyncRead for Client {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Client::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Client::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
            Client::Swapping => Poll::Ready(Err(broken())),
        }
    }
}

impl AsyncWrite for Client {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Client::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Client::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
            Client::Swapping => Poll::Ready(Err(broken())),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Client::Plain(s) => Pin::new(s).poll_flush(cx),
            Client::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
            Client::Swapping => Poll::Ready(Err(broken())),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Client::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Client::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
            Client::Swapping => Poll::Ready(Err(broken())),
        }
    }
}

fn broken() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::BrokenPipe, "stream taken mid-upgrade")
}

// ------------------------------------------------------------------- lines --

/// Takes one complete line from the buffer, terminator included.
///
/// A bare LF is accepted because senders emit it and refusing costs real mail;
/// the line is handed on exactly as it arrived, so nothing downstream sees a
/// rewritten terminator.
fn take_line(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    let end = buf.iter().position(|b| *b == b'\n')?;
    Some(buf.drain(..=end).collect())
}

/// The text of a line without its terminator.
fn trim_eol(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
        end -= 1;
    }
    &line[..end]
}

fn is_command(line: &[u8], verb: &str) -> bool {
    let text = trim_eol(line);
    let bytes = verb.as_bytes();
    if text.len() < bytes.len() {
        return false;
    }
    if !text[..bytes.len()].eq_ignore_ascii_case(bytes) {
        return false;
    }
    // "EHLO" must not match "EHLOX", but "EHLO host" must match.
    text.len() == bytes.len() || text[bytes.len()] == b' ' || text[bytes.len()] == b'\t'
}

/// True for the last line of a reply: `250 text`, as opposed to `250-text`.
fn is_final_reply(line: &[u8]) -> bool {
    let text = trim_eol(line);
    text.len() >= 4 && text[..3].iter().all(|b| b.is_ascii_digit()) && text[3] == b' '
}

fn reply_code(line: &[u8]) -> Option<u16> {
    let text = trim_eol(line);
    if text.len() < 3 || !text[..3].iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    std::str::from_utf8(&text[..3]).ok()?.parse().ok()
}

// ----------------------------------------------------------------- backend --

/// Reads one complete SMTP reply, following continuation lines.
async fn read_reply(stream: &mut TcpStream, buf: &mut Vec<u8>) -> std::io::Result<Vec<u8>> {
    let mut reply = Vec::new();
    loop {
        while let Some(line) = take_line(buf) {
            let last = is_final_reply(&line);
            reply.extend_from_slice(&line);
            if last {
                return Ok(reply);
            }
        }
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "backend closed while sending a reply",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_LINE * 16 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "backend reply is implausibly long",
            ));
        }
    }
}

/// Announces the real client to the backend and consumes the fresh greeting.
///
/// XCLIENT resets the session, so the backend answers with a new 220. Both the
/// address and the encryption state are sent: Corsair refuses AUTH on an
/// unencrypted session, and after the upgrade this connection *is* encrypted
/// even though the backend's own socket is not.
async fn send_xclient(
    backend: &mut TcpStream,
    buf: &mut Vec<u8>,
    addr: Option<&str>,
    proto: &str,
) -> std::io::Result<Vec<u8>> {
    let mut command = String::from("XCLIENT");
    if let Some(addr) = addr {
        command.push_str(" ADDR=");
        command.push_str(addr);
    }
    command.push_str(" PROTO=");
    command.push_str(proto);
    command.push_str("\r\n");
    backend.write_all(command.as_bytes()).await?;
    backend.flush().await?;
    read_reply(backend, buf).await
}

// ------------------------------------------------------------------ relay --

struct Session {
    secure: bool,
    /// Set when the last command forwarded was EHLO, so the reply it produces
    /// can be recognised as the capability list.
    awaiting_ehlo_reply: bool,
    /// Collected lines of a multi-line reply that is not complete yet.
    pending_reply: Vec<Vec<u8>>,
}

/// Rewrites a complete EHLO reply to advertise STARTTLS.
///
/// The backend does not offer it — it cannot perform it — so the capability is
/// added here, by the process that can. Inserted before the final line because
/// a reply's last line is the one with a space after the code, and a client
/// that stops reading at the first such line would otherwise miss it.
fn advertise_starttls(lines: &[Vec<u8>]) -> Vec<u8> {
    let already = lines
        .iter()
        .any(|l| trim_eol(l).len() > 4 && trim_eol(l)[4..].eq_ignore_ascii_case(b"STARTTLS"));
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !already && i + 1 == lines.len() {
            let code = reply_code(line).unwrap_or(250);
            out.extend_from_slice(format!("{code}-STARTTLS\r\n").as_bytes());
        }
        out.extend_from_slice(line);
    }
    out
}

async fn handle(
    client_tcp: TcpStream,
    peer: SocketAddr,
    backend_addr: SocketAddr,
    acceptor: TlsAcceptor,
) -> std::io::Result<()> {
    client_tcp.set_nodelay(true).ok();
    let mut backend = TcpStream::connect(backend_addr).await?;
    backend.set_nodelay(true).ok();

    let mut backend_buf: Vec<u8> = Vec::new();
    // The backend greets us; that greeting is discarded, because XCLIENT makes
    // it produce another one addressed to the real client.
    read_reply(&mut backend, &mut backend_buf).await?;
    let greeting = send_xclient(
        &mut backend,
        &mut backend_buf,
        Some(&peer.ip().to_string()),
        "SMTP",
    )
    .await?;

    let mut client = Client::Plain(client_tcp);
    client.write_all(&greeting).await?;
    client.flush().await?;

    let mut state = Session {
        secure: false,
        awaiting_ehlo_reply: false,
        pending_reply: Vec::new(),
    };
    let mut client_buf: Vec<u8> = Vec::new();
    let mut from_client = [0u8; 8192];
    let mut from_backend = [0u8; 8192];

    loop {
        tokio::select! {
            read = client.read(&mut from_client) => {
                let n = read?;
                if n == 0 { break }
                client_buf.extend_from_slice(&from_client[..n]);
                if client_buf.len() > MAX_LINE * 4 && !state.secure {
                    // Before TLS the only traffic is commands. A flood of them
                    // without a terminator is not a client.
                    break
                }

                while let Some(line) = take_line(&mut client_buf) {
                    if !state.secure && is_command(&line, "STARTTLS") {
                        client.write_all(b"220 2.0.0 Ready to start TLS\r\n").await?;
                        client.flush().await?;

                        let plain = match std::mem::replace(&mut client, Client::Swapping) {
                            Client::Plain(s) => s,
                            other => { client = other; break }
                        };
                        let upgraded = acceptor.accept(plain).await?;
                        client = Client::Tls(Box::new(upgraded));
                        state.secure = true;
                        state.awaiting_ehlo_reply = false;
                        state.pending_reply.clear();

                        // RFC 3207: the client discards everything learned
                        // before the upgrade and starts again with EHLO. Tell
                        // the backend the same, and that the session is now
                        // encrypted so it will offer AUTH.
                        send_xclient(&mut backend, &mut backend_buf, None, "ESMTPS").await?;
                        continue
                    }

                    if !state.secure && is_command(&line, "EHLO") {
                        state.awaiting_ehlo_reply = true;
                    }
                    // XCLIENT from a real client is not relayed: the backend
                    // trusts this connection, and forwarding the command would
                    // let any sender claim any address.
                    if is_command(&line, "XCLIENT") {
                        client.write_all(b"550 5.7.0 Not permitted.\r\n").await?;
                        client.flush().await?;
                        continue
                    }
                    backend.write_all(&line).await?;
                }
                backend.flush().await?;

                if state.secure && !client_buf.is_empty() {
                    // After the upgrade the payload is message data, not lines
                    // to inspect; hand on whatever is buffered.
                    backend.write_all(&client_buf).await?;
                    backend.flush().await?;
                    client_buf.clear();
                }
            }

            read = backend.read(&mut from_backend) => {
                let n = read?;
                if n == 0 { break }
                backend_buf.extend_from_slice(&from_backend[..n]);

                let mut out: Vec<u8> = Vec::new();
                while let Some(line) = take_line(&mut backend_buf) {
                    let last = is_final_reply(&line);
                    if state.awaiting_ehlo_reply && !state.secure {
                        state.pending_reply.push(line);
                        if last {
                            out.extend_from_slice(&advertise_starttls(&state.pending_reply));
                            state.pending_reply.clear();
                            state.awaiting_ehlo_reply = false;
                        }
                    } else {
                        out.extend_from_slice(&line);
                    }
                }
                if !out.is_empty() {
                    client.write_all(&out).await?;
                    client.flush().await?;
                }
            }
        }
    }

    let _ = client.shutdown().await;
    let _ = backend.shutdown().await;
    Ok(())
}

// ------------------------------------------------------------------- setup --

fn load_tls(cert_path: &str, key_path: &str) -> std::io::Result<Arc<ServerConfig>> {
    let cert_file = std::fs::read(cert_path)?;
    let key_file = std::fs::read(key_path)?;

    let certs: Vec<CertificateDer<'static>> =
        rustls_pemfile::certs(&mut cert_file.as_slice()).collect::<Result<_, _>>()?;
    if certs.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("no certificate in {cert_path}"),
        ));
    }
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_file.as_slice())?
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("no private key in {key_path}"),
            )
        })?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    Ok(Arc::new(config))
}

/// `0.0.0.0:25=127.0.0.1:2525,0.0.0.0:587=127.0.0.1:2587`
fn parse_routes(spec: &str) -> Result<Vec<(SocketAddr, SocketAddr)>, String> {
    let mut routes = Vec::new();
    for entry in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (listen, backend) = entry
            .split_once('=')
            .ok_or_else(|| format!("route {entry:?} is not listen=backend"))?;
        routes.push((
            listen
                .parse()
                .map_err(|_| format!("{listen:?} is not an address"))?,
            backend
                .parse()
                .map_err(|_| format!("{backend:?} is not an address"))?,
        ));
    }
    if routes.is_empty() {
        return Err("no routes configured".into());
    }
    Ok(routes)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> std::io::Result<()> {
    let cert = std::env::var("MXFRONT_CERT").unwrap_or_else(|_| {
        "/etc/corsair/certs/fullchain.pem".into()
    });
    let key =
        std::env::var("MXFRONT_KEY").unwrap_or_else(|_| "/etc/corsair/certs/privkey.pem".into());
    let routes = std::env::var("MXFRONT_ROUTES")
        .unwrap_or_else(|_| "0.0.0.0:25=127.0.0.1:2525,0.0.0.0:587=127.0.0.1:2587".into());

    let routes = parse_routes(&routes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let tls = load_tls(&cert, &key)?;
    let acceptor = TlsAcceptor::from(tls);

    let mut tasks = Vec::new();
    for (listen, backend) in routes {
        let listener = TcpListener::bind(listen).await?;
        println!("[mxfront] {listen} -> {backend}");
        let acceptor = acceptor.clone();
        tasks.push(tokio::spawn(async move {
            loop {
                let (stream, peer) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(e) => {
                        eprintln!("[mxfront] accept on {listen}: {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    // A failed session is one connection, not an outage. The
                    // common cases are a client hanging up mid-handshake and a
                    // scanner sending garbage.
                    if let Err(e) = handle(stream, peer, backend, acceptor).await {
                        if e.kind() != std::io::ErrorKind::UnexpectedEof {
                            eprintln!("[mxfront] {peer}: {e}");
                        }
                    }
                });
            }
        }));
    }

    for task in tasks {
        let _ = task.await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_final_reply_is_the_one_with_a_space() {
        assert!(is_final_reply(b"250 OK\r\n"));
        assert!(!is_final_reply(b"250-SIZE 100\r\n"));
        assert!(!is_final_reply(b"not a reply\r\n"));
    }

    #[test]
    fn commands_match_on_a_whole_verb() {
        assert!(is_command(b"STARTTLS\r\n", "STARTTLS"));
        assert!(is_command(b"starttls\r\n", "STARTTLS"));
        assert!(is_command(b"EHLO host.example\r\n", "EHLO"));
        // The bug this guards: a prefix match would upgrade on a command that
        // merely starts the same way.
        assert!(!is_command(b"STARTTLSX\r\n", "STARTTLS"));
        assert!(!is_command(b"EHLOX\r\n", "EHLO"));
    }

    #[test]
    fn starttls_is_added_before_the_final_line() {
        let lines = vec![
            b"250-mx.example\r\n".to_vec(),
            b"250-SIZE 1000\r\n".to_vec(),
            b"250 HELP\r\n".to_vec(),
        ];
        let out = String::from_utf8(advertise_starttls(&lines)).unwrap();
        assert_eq!(
            out,
            "250-mx.example\r\n250-SIZE 1000\r\n250-STARTTLS\r\n250 HELP\r\n"
        );
    }

    #[test]
    fn starttls_is_not_advertised_twice() {
        let lines = vec![b"250-STARTTLS\r\n".to_vec(), b"250 HELP\r\n".to_vec()];
        let out = String::from_utf8(advertise_starttls(&lines)).unwrap();
        assert_eq!(out, "250-STARTTLS\r\n250 HELP\r\n");
    }

    #[test]
    fn a_single_line_reply_still_gains_the_capability() {
        let lines = vec![b"250 mx.example\r\n".to_vec()];
        let out = String::from_utf8(advertise_starttls(&lines)).unwrap();
        assert_eq!(out, "250-STARTTLS\r\n250 mx.example\r\n");
    }

    #[test]
    fn routes_parse_as_pairs() {
        let routes = parse_routes("0.0.0.0:25=127.0.0.1:2525, 0.0.0.0:587=127.0.0.1:2587").unwrap();
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].0.port(), 25);
        assert_eq!(routes[0].1.port(), 2525);
        assert!(parse_routes("nonsense").is_err());
        assert!(parse_routes("").is_err());
    }

    #[test]
    fn lines_come_out_whole_and_unmodified() {
        let mut buf = b"EHLO a\r\nMAIL FROM:<x>\r\npartial".to_vec();
        assert_eq!(take_line(&mut buf).unwrap(), b"EHLO a\r\n");
        assert_eq!(take_line(&mut buf).unwrap(), b"MAIL FROM:<x>\r\n");
        assert!(take_line(&mut buf).is_none());
        assert_eq!(buf, b"partial");
    }
}
