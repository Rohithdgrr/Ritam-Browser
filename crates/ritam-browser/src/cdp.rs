//! Minimal blocking CDP client for `obscura serve` (`obscura serve` exposes
//! a standard Chrome DevTools Protocol endpoint on loopback).
//!
//! Deliberately blocking + hand-rolled rather than an async runtime: engine
//! operations are infrequent (agent-context fetches, parity checks) and run
//! on their own thread behind the runtime's bounded command surface. This
//! keeps `ritam-browser-core` free of tokio so the crate stays small and
//! testable. No engine behaviour is reimplemented here — we only speak the
//! documented CDP surface of the pinned binary (AGENTS.md §7).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::protocol::WebSocket;
use tungstenite::Message;

/// One CDP connection. Not `Sync`; callers serialize access (the runtime
/// holds it behind a mutex).
pub struct Cdp {
    socket: WebSocket<TcpStream>,
    next_id: u64,
}

#[derive(Debug)]
pub enum CdpError {
    Connect(String),
    Timeout(String),
    Protocol(String),
    Closed,
}

impl std::fmt::Display for CdpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CdpError::Connect(m) => write!(f, "cdp connect failed: {m}"),
            CdpError::Timeout(m) => write!(f, "cdp timeout: {m}"),
            CdpError::Protocol(m) => write!(f, "cdp protocol error: {m}"),
            CdpError::Closed => write!(f, "cdp connection closed"),
        }
    }
}

impl std::error::Error for CdpError {}

/// Outcome of a `Runtime.evaluate` that produced a JS value.
#[derive(Debug, Clone)]
pub struct EvalValue {
    /// The value as a string (CDP `returnByValue`), or `None` when the
    /// result was not a plain value (e.g. an unserializable handle).
    pub value: Option<String>,
    /// The engine's own exception text, when the expression threw.
    pub exception: Option<String>,
}

impl Cdp {
    /// Connect to `ws://<host>:<port>/devtools/browser` with read/write
    /// timeouts so a wedged server can never hang the runtime thread.
    pub fn connect(host: &str, port: u16, io_timeout: Duration) -> Result<Self, CdpError> {
        use std::net::ToSocketAddrs;
        let addrs = (host, port)
            .to_socket_addrs()
            .map_err(|e| CdpError::Connect(format!("{host}:{port}: {e}")))?
            .collect::<Vec<_>>();
        let addr = addrs
            .first()
            .ok_or_else(|| CdpError::Connect(format!("{host}:{port}: no addresses")))?;
        let stream = TcpStream::connect_timeout(addr, Duration::from_secs(5))
            .map_err(|e| CdpError::Connect(format!("{host}:{port}: {e}")))?;
        stream
            .set_read_timeout(Some(io_timeout))
            .map_err(|e| CdpError::Connect(format!("set_read_timeout: {e}")))?;
        stream
            .set_write_timeout(Some(io_timeout))
            .map_err(|e| CdpError::Connect(format!("set_write_timeout: {e}")))?;
        let (socket, _resp) = tungstenite::client(
            format!("ws://{host}:{port}/devtools/browser"),
            stream.try_clone().map_err(|e| CdpError::Connect(e.to_string()))?,
        )
        .map_err(|e| CdpError::Connect(e.to_string()))?;
        Ok(Self { socket, next_id: 0 })
    }

    /// Send a CDP command and await its response, skipping unrelated events.
    /// `session_id` scopes the call to an attached target (flat session).
    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        self.next_id += 1;
        let id = self.next_id;
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = session_id {
            msg["sessionId"] = json!(sid);
        }
        let payload = serde_json::to_string(&msg).map_err(|e| CdpError::Protocol(e.to_string()))?;
        self.socket
            .send(Message::Text(payload.into()))
            .map_err(map_send_err)?;

        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CdpError::Timeout(format!("{method}")));
            }
            let frame = match self.socket.read() {
                Ok(f) => f,
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    return Err(CdpError::Timeout(format!("{method}")))
                }
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Err(CdpError::Closed)
                }
                Err(e) => return Err(CdpError::Protocol(e.to_string())),
            };
            let text: String = match frame {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => match String::from_utf8(b.to_vec()) {
                    Ok(t) => t,
                    Err(_) => continue,
                },
                _ => continue, // ping/pong/close frames handled by tungstenite
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                continue; // ignore non-JSON noise
            };
            // CDP responses carry `id`; events do not.
            if parsed.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(err) = parsed.get("error") {
                    let m = err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown cdp error");
                    return Err(CdpError::Protocol(format!("{method}: {m}")));
                }
                return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    /// `Runtime.evaluate` on a session, returning the JS value as a string.
    pub fn evaluate(
        &mut self,
        session_id: &str,
        expression: &str,
        timeout: Duration,
    ) -> Result<EvalValue, CdpError> {
        let result = self.call(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
                "userGesture": true
            }),
            Some(session_id),
            timeout,
        )?;
        let exception = result
            .get("exceptionDetails")
            .and_then(|d| d.get("exception"))
            .and_then(|e| e.get("description").or_else(|| e.get("value")))
            .and_then(Value::as_str)
            .map(str::to_string);
        let value = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok(EvalValue { value, exception })
    }
}

fn map_send_err(e: tungstenite::Error) -> CdpError {
    match e {
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => CdpError::Closed,
        other => CdpError::Protocol(other.to_string()),
    }
}

/// Read the CDP `Browser` version string from `GET /json/version` over plain
/// HTTP on loopback (no HTTP client dependency; the endpoint is loopback
/// only and returns a single JSON object).
pub fn fetch_server_version(host: &str, port: u16, timeout: Duration) -> Result<String, String> {
    use std::net::ToSocketAddrs;
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .collect::<Vec<_>>();
    let addr = addrs.first().ok_or("no addresses")?;
    let mut stream =
        TcpStream::connect_timeout(addr, Duration::from_secs(5)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    let req = format!(
        "GET /json/version HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    let json_start = body.find('{').ok_or("no JSON body")?;
    let parsed: Value =
        serde_json::from_str(&body[json_start..]).map_err(|e| format!("bad json: {e}"))?;
    parsed
        .get("Browser")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "no Browser field".to_string())
}
