//! The Obscura engine adapter (`contracts/ipc.md` §6).
//!
//! One narrow trait, two interchangeable implementations over the *same*
//! pinned binary, so owner rule 3 (UI path == CLI path, byte-for-byte) can
//! be proven rather than asserted:
//!
//! * [`CliEngine`] drives `obscura fetch … --eval …` as a subprocess — the
//!   engine truth-source.
//! * [`CdpEngine`] drives a long-lived `obscura serve` over CDP — the
//!   transport the runtime uses for agent-context operations.
//!
//! Neither patches, reconfigures, or reinterprets engine behaviour. A
//! divergence between them is an integration bug in *this* layer (rule 3),
//! fixed here — never by touching `obscura/`.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::cdp::{fetch_server_version, Cdp};

/// Post-load settle floor, mirroring the obstacle-course wait policy that
/// `scripts/parity-check.mjs` uses so both paths observe the same page state.
pub const CLI_WAIT_SECS: u64 = 3;
pub const CDP_SETTLE_MS: u64 = 3500;
pub const CDP_POLL_MS: u64 = 8000;
/// The expression both engines run. Kept byte-identical between paths by
/// construction — it is a single constant.
pub const PROBE_EXPRESSION: &str = "JSON.stringify({title:document.title,url:location.href,text:(document.body&&document.body.innerText||'').trim().slice(0,400)})";

/// Serializable engine state for the UI (`EngineStatus` in the contract).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EngineStatus {
    Ready {
        version: String,
        endpoint: String,
        pid: u32,
        detail: Option<String>,
    },
    Starting {
        version: Option<String>,
        endpoint: Option<String>,
        pid: Option<u32>,
        detail: Option<String>,
    },
    Unavailable {
        version: Option<String>,
        endpoint: Option<String>,
        pid: Option<u32>,
        detail: String,
    },
}

/// One engine operation's observable result (`EngineEval` in the contract).
#[derive(Debug, Clone, Serialize)]
pub struct EngineEval {
    pub ok: bool,
    pub value: Option<String>,
    pub bytes: usize,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// `engine_verify` report: both paths, byte-compared (rule 3).
#[derive(Debug, Clone, Serialize)]
pub struct EngineVerify {
    pub url: String,
    pub identical: bool,
    pub cli: EngineEval,
    pub cdp: EngineEval,
    pub checked_at: String,
}

/// The narrow adapter surface. Implementations must be safe to call from a
/// worker thread; the runtime serializes access internally.
pub trait ObscuraEngine: Send + Sync {
    fn status(&self) -> EngineStatus;
    /// Run `expression` in a fresh page at `url` and return the result.
    fn eval(&self, url: &str, expression: &str) -> EngineEval;
}

/// The engine truth-source: the pinned CLI binary as a subprocess.
pub struct CliEngine {
    bin: PathBuf,
    allow_private_network: bool,
}

impl CliEngine {
    pub fn new(bin: PathBuf, allow_private_network: bool) -> Self {
        Self {
            bin,
            allow_private_network,
        }
    }

    pub fn version(&self) -> Result<String, String> {
        let out = Command::new(&self.bin)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("spawn {}: {}", self.bin.display(), e))?;
        if !out.status.success() {
            return Err(format!(
                "obscura --version exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

impl ObscuraEngine for CliEngine {
    fn status(&self) -> EngineStatus {
        match self.version() {
            Ok(v) => EngineStatus::Ready {
                version: v,
                endpoint: self.bin.display().to_string(),
                pid: std::process::id(),
                detail: Some("cli (subprocess per operation)".into()),
            },
            Err(e) => EngineStatus::Unavailable {
                version: None,
                endpoint: None,
                pid: None,
                detail: e,
            },
        }
    }

    fn eval(&self, url: &str, expression: &str) -> EngineEval {
        let started = std::time::Instant::now();
        let mut cmd = Command::new(&self.bin);
        cmd.args([
            "fetch",
            url,
            "--quiet",
            "--timeout",
            "20",
            "--wait",
            &CLI_WAIT_SECS.to_string(),
            "--eval",
            expression,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        if self.allow_private_network {
            cmd.arg("--allow-private-network");
        }
        let result = cmd.output();
        let duration_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(out) => {
                let stdout = out.stdout;
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                // The CLI prints the eval result to stdout; trim trailing
                // whitespace so the byte comparison with the CDP value is
                // meaningful (parity-check.mjs does the same).
                let value = String::from_utf8_lossy(&stdout).trim().to_string();
                let ok = out.status.success();
                EngineEval {
                    ok,
                    bytes: value.len(),
                    value: if value.is_empty() { None } else { Some(value) },
                    duration_ms,
                    error: if ok {
                        None
                    } else {
                        Some(if stderr.is_empty() {
                            format!("exit {}", out.status)
                        } else {
                            stderr
                        })
                    },
                }
            }
            Err(e) => EngineEval {
                ok: false,
                value: None,
                bytes: 0,
                duration_ms,
                error: Some(format!("spawn failed: {e}")),
            },
        }
    }
}

/// The transport the runtime uses: a managed `obscura serve` process plus one
/// CDP connection.
pub struct CdpEngine {
    port: u16,
    pid: Option<u32>,
    version: Option<String>,
    endpoint: String,
    /// Guards the single CDP socket; `None` when the connection is down.
    conn: std::sync::Mutex<Option<Cdp>>,
}

impl CdpEngine {
    /// Pick a free loopback port, spawn `obscura serve`, poll `/json/version`
    /// until ready, then open the CDP socket. Returns a ready engine or a
    /// typed failure — never a half-started engine that lies about status.
    pub fn start(bin: PathBuf, allow_private_network: bool) -> Result<Self, String> {
        if !bin.exists() {
            return Err(format!("binary not found at {}", bin.display()));
        }
        let port = free_port().ok_or("could not allocate a loopback port")?;
        let mut cmd = Command::new(&bin);
        cmd.arg("serve")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if allow_private_network {
            cmd.arg("--allow-private-network");
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn serve: {e}"))?;
        let pid = child.id();

        // Wait for the HTTP endpoint, then open CDP. Bounded: a wedged engine
        // must not block startup forever.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let version = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| format!("wait serve: {e}"))?
            {
                return Err(format!(
                    "obscura serve exited early with {status}: {}",
                    String::from_utf8_lossy(&child_stderr(&mut child)).trim()
                ));
            }
            if let Ok(v) = fetch_server_version("127.0.0.1", port, Duration::from_secs(2)) {
                break Some(v);
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                return Err("obscura serve did not become ready within 30s".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        };

        let endpoint = format!("http://127.0.0.1:{port}");
        // The CDP socket is opened lazily on first use (eval), so a slow V8
        // init cannot fail the whole engine unnecessarily. But we do probe it
        // once here so `Ready` is truthful.
        let conn = Cdp::connect("127.0.0.1", port, Duration::from_secs(30)).map_err(|e| {
            let _ = child.kill();
            format!("cdp connect: {e}")
        })?;

        Ok(Self {
            port,
            pid: Some(pid),
            version,
            endpoint,
            conn: std::sync::Mutex::new(Some(conn)),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Create a target at `url`, evaluate, close the target. Mirrors the
    /// sequence `scripts/parity-check.mjs` uses so results are comparable.
    fn eval_cdp(&self, url: &str, expression: &str) -> EngineEval {
        let started = std::time::Instant::now();
        let outcome = self.eval_cdp_inner(url, expression);
        let duration_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Ok(value) => EngineEval {
                ok: true,
                bytes: value.len(),
                value: Some(value),
                duration_ms,
                error: None,
            },
            Err(e) => EngineEval {
                ok: false,
                value: None,
                bytes: 0,
                duration_ms,
                error: Some(e),
            },
        }
    }

    fn eval_cdp_inner(&self, url: &str, expression: &str) -> Result<String, String> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| "cdp lock poisoned".to_string())?;
        let cdp = guard
            .as_mut()
            .ok_or_else(|| "cdp connection is down".to_string())?;
        let io = Duration::from_secs(30);

        let created = cdp
            .call("Target.createTarget", serde_json::json!({ "url": url }), None, io)
            .map_err(|e| e.to_string())?;
        let target_id = created
            .get("targetId")
            .and_then(|v| v.as_str())
            .ok_or("no targetId")?
            .to_string();
        let attached = cdp
            .call(
                "Target.attachToTarget",
                serde_json::json!({ "targetId": target_id, "flatten": true }),
                None,
                io,
            )
            .map_err(|e| e.to_string())?;
        let session = attached
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or("no sessionId")?
            .to_string();

        let result = (|| -> Result<String, String> {
            cdp.call("Page.enable", serde_json::json!({}), Some(&session), io)
                .map_err(|e| e.to_string())?;
            // Poll for the result, then apply the settle floor so both paths
            // observe the same post-load window.
            let poll_deadline =
                std::time::Instant::now() + Duration::from_millis(CDP_POLL_MS);
            let t0 = std::time::Instant::now();
            let mut value: Option<String> = None;
            while std::time::Instant::now() < poll_deadline {
                let ev = cdp
                    .evaluate(&session, expression, io)
                    .map_err(|e| e.to_string())?;
                if let Some(exc) = ev.exception {
                    return Err(exc);
                }
                if let Some(v) = ev.value {
                    if !v.is_empty() {
                        value = Some(v);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            let settle_remaining = (Duration::from_millis(CDP_SETTLE_MS))
                .saturating_sub(t0.elapsed());
            if !settle_remaining.is_zero() {
                std::thread::sleep(settle_remaining);
            }
            let fin = cdp
                .evaluate(&session, expression, io)
                .map_err(|e| e.to_string())?;
            if let Some(exc) = fin.exception {
                return Err(exc);
            }
            Ok(fin
                .value
                .or(value)
                .ok_or("engine returned no value")?)
        })();

        let _ = cdp.call(
            "Target.closeTarget",
            serde_json::json!({ "targetId": target_id }),
            None,
            io,
        );
        result
    }
}

impl Drop for CdpEngine {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            kill_pid(pid);
        }
    }
}

impl ObscuraEngine for CdpEngine {
    fn status(&self) -> EngineStatus {
        match (&self.version, self.pid) {
            (Some(v), Some(pid)) => EngineStatus::Ready {
                version: v.clone(),
                endpoint: self.endpoint.clone(),
                pid,
                detail: Some(format!("cdp on 127.0.0.1:{}", self.port)),
            },
            _ => EngineStatus::Unavailable {
                version: self.version.clone(),
                endpoint: Some(self.endpoint.clone()),
                pid: self.pid,
                detail: "serve process not running".into(),
            },
        }
    }

    fn eval(&self, url: &str, expression: &str) -> EngineEval {
        self.eval_cdp(url, expression)
    }
}

/// Prove rule 3 for one URL: the same expression through the CLI and through
/// CDP must return byte-identical values.
pub fn verify_parity(cli: &CliEngine, cdp: &CdpEngine, url: &str) -> EngineVerify {
    let cli_eval = cli.eval(url, PROBE_EXPRESSION);
    let cdp_eval = cdp.eval(url, PROBE_EXPRESSION);
    let identical = match (&cli_eval.value, &cdp_eval.value) {
        (Some(a), Some(b)) => a.as_bytes() == b.as_bytes(),
        (None, None) => cli_eval.ok == cdp_eval.ok,
        _ => false,
    };
    EngineVerify {
        url: url.to_string(),
        identical,
        cli: cli_eval,
        cdp: cdp_eval,
        checked_at: iso8601_now(),
    }
}

/// RFC 3339 / ISO 8601 UTC timestamp, dependency-free (civil-from-days).
pub fn iso8601_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso8601_from_unix(secs)
}

fn iso8601_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn free_port() -> Option<u16> {
    use std::net::TcpListener;
    (0..20)
        .filter_map(|_| {
            let l = TcpListener::bind("127.0.0.1:0").ok()?;
            Some(l.local_addr().ok()?.port())
        })
        .next()
}

fn child_stderr(child: &mut std::process::Child) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_end(&mut buf);
    }
    buf
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_epoch_and_known_instants() {
        assert_eq!(iso8601_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_from_unix(1_791_000_000), "2026-10-03T04:00:00Z");
        assert_eq!(iso8601_from_unix(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn probe_expression_is_a_json_producer() {
        // Guard against accidental edits that would break the parity compare.
        assert!(PROBE_EXPRESSION.starts_with("JSON.stringify("));
        assert!(PROBE_EXPRESSION.contains("document.title"));
        assert!(PROBE_EXPRESSION.contains("location.href"));
    }

    /// Live test, off by default: needs the real binary and network access.
    /// Run with `OBSCURA_LIVE=1 cargo nextest run -p ritam-browser-core`.
    /// Proves the CLI and CDP paths return byte-identical bytes (rule 3).
    #[test]
    fn live_cli_and_cdp_are_byte_identical() {
        if std::env::var("OBSCURA_LIVE").as_deref() != Ok("1") {
            eprintln!("skipped: set OBSCURA_LIVE=1 to run the live parity test");
            return;
        }
        let bin = PathBuf::from(
            std::env::var("OBSCURA_BIN")
                .unwrap_or_else(|_| "../tools/obscura-bin/obscura.exe".into()),
        );
        let cli = CliEngine::new(bin.clone(), false);
        let cdp = CdpEngine::start(bin, false).expect("obscura serve must start");
        let report = verify_parity(&cli, &cdp, "https://example.com");
        assert!(report.cli.ok, "cli failed: {:?}", report.cli.error);
        assert!(report.cdp.ok, "cdp failed: {:?}", report.cdp.error);
        assert!(report.identical, "rule-3 violation: cli={:?} cdp={:?}", report.cli.value, report.cdp.value);
        assert!(report.cli.value.as_deref().unwrap_or("").contains("Example Domain"));
    }
}
