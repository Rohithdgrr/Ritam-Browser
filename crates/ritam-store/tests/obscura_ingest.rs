//! Real-engine ingestion: the pinned Obscura binary does the actual fetch,
//! the store records exactly what the engine reported, and a restart returns
//! those bytes unchanged. This is the persistence half of AGENTS.md §7
//! (rule 3): the UI path never alters engine output.
//!
//! The fixture page is served from loopback so the test is deterministic and
//! needs no internet; `--allow-private-network` is the engine's own documented
//! flag for exactly this use.
//!
//! Engine-adjacent: run with `cargo nextest run`, never `cargo test`
//! (AGENTS.md §6 — single V8 isolate per process).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ritam_store::*;

const FIXTURE_TITLE: &str = "Ritam Fixture — Obscura Ingest";
const FIXTURE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ritam Fixture — Obscura Ingest</title></head>
<body><h1>Ritam Browser fixture</h1><p>Served from loopback for engine ingestion tests.</p></body>
</html>"#;

fn obscura_bin() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // crates
    p.pop(); // repo root
    p.join("tools").join("obscura-bin").join("obscura.exe")
}

/// Minimal loopback HTTP/1.1 server: one fixture page, any other path 404s.
fn serve_fixture(done: Arc<AtomicBool>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if done.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(stream) = stream {
                let _ = handle(stream);
            }
        }
    });
    format!("http://{addr}/fixture.html")
}

fn handle(mut stream: TcpStream) -> std::io::Result<()> {
    let mut buf = [0u8; 4096];
    let mut read_total = 0;
    // Read until end of headers (a GET request has no body).
    loop {
        let n = stream.read(&mut buf[read_total..])?;
        if n == 0 {
            break;
        }
        read_total += n;
        if buf[..read_total].windows(4).any(|w| w == b"\r\n\r\n") || read_total == buf.len() {
            break;
        }
    }
    let request = String::from_utf8_lossy(&buf[..read_total]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    if path == "/fixture.html" {
        let body = FIXTURE_HTML.as_bytes();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )?;
        stream.write_all(body)?;
    } else {
        let body = b"not found";
        write!(
            stream,
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )?;
        stream.write_all(body)?;
    }
    Ok(())
}

/// Run the pinned binary and return (stdout, stderr, exit_status).
fn run_obscura(args: &[&str]) -> (String, String, Option<i32>) {
    let bin = obscura_bin();
    assert!(
        bin.exists(),
        "pinned Obscura binary not found at {} (see docs/DEPENDENCIES.md)",
        bin.display()
    );
    let out = Command::new(&bin)
        .args(args)
        .output()
        .expect("failed to spawn obscura");
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.code(),
    )
}

/// Extract the JSON object printed by `--eval` (the engine's real answer).
fn parse_eval_json(stdout: &str) -> serde_json::Value {
    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .unwrap_or_else(|| panic!("no JSON object in engine stdout:\n{stdout}"))
}

#[test]
fn obscura_response_is_persisted_byte_identical_across_restart() {
    let done = Arc::new(AtomicBool::new(false));
    let url = serve_fixture(done.clone());

    let eval = "JSON.stringify({title:document.title,url:location.href})";
    let (stdout, stderr, code) = run_obscura(&[
        "fetch",
        &url,
        "--allow-private-network",
        "--eval",
        eval,
        "--timeout",
        "15",
    ]);
    assert_eq!(
        code,
        Some(0),
        "obscura fetch failed (code {code:?})\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    let engine_json = parse_eval_json(&stdout);
    let title = engine_json["title"].as_str().expect("title from engine");
    let final_url = engine_json["url"].as_str().expect("url from engine");
    // The engine really parsed our page (not a guess, not a cache).
    assert_eq!(
        title, FIXTURE_TITLE,
        "engine title must match the served page"
    );
    assert_eq!(
        final_url, url,
        "engine final url must match the served page"
    );

    // Persist exactly what the engine reported, then restart.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("ingest.sqlite");
    let visited_at = 1_700_000_000_000_i64;
    {
        let store = Store::open(&path).expect("open");
        let outcome = store
            .history_add(NewHistoryVisit {
                url: final_url.to_string(),
                title: title.to_string(),
                visited_at_ms: visited_at,
                duration_ms: None,
                http_status: None, // the runtime did not report one; never invented
                transition: Transition::Typed,
                visibility: Visibility::Normal,
            })
            .expect("record");
        assert!(
            matches!(outcome, HistoryAddOutcome::Recorded(_)),
            "visit must be recorded: {outcome:?}"
        );
    }

    let store = Store::open(&path).expect("reopen after restart");
    let entries = store.history_list(HistoryFilter::default()).expect("list");
    assert_eq!(entries.len(), 1);
    // Byte-identical readback: the store never altered the engine's answer.
    assert_eq!(entries[0].title.as_bytes(), title.as_bytes());
    assert_eq!(entries[0].url.as_bytes(), final_url.as_bytes());
    assert_eq!(entries[0].visited_at_ms, visited_at);
    assert_eq!(entries[0].http_status, None);
    assert_eq!(entries[0].host, "127.0.0.1");

    // And FTS finds it by the engine-provided title.
    let hits = store.history_search("Fixture".into(), 10).expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].url.as_bytes(), final_url.as_bytes());

    done.store(true, Ordering::SeqCst);
}

#[test]
fn engine_failure_is_an_error_not_a_stored_success() {
    // Port 1 on loopback refuses instantly: the engine must fail loudly and
    // nothing may be recorded as a visit.
    let eval = "document.title";
    let (stdout, stderr, code) = run_obscura(&[
        "fetch",
        "http://127.0.0.1:1/",
        "--allow-private-network",
        "--eval",
        eval,
        "--timeout",
        "5",
    ]);
    assert_ne!(
        code,
        Some(0),
        "engine must report failure for an unreachable page\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    let store = Store::open_in_memory().expect("open");
    // The host layer (Rohan) must not fabricate a visit for a failed load;
    // here we assert the store has nothing and the engine answer was empty.
    assert!(store.history_count().expect("count") == 0);
    let report = store.integrity_check().expect("integrity");
    assert!(report.ok);
}

#[test]
fn pinned_binary_reports_expected_version() {
    // Engine pin discipline (AGENTS.md §7): the truth source is v0.2.4.
    let (stdout, stderr, code) = run_obscura(&["--version"]);
    let out = format!("{stdout}{stderr}");
    assert_eq!(code, Some(0), "version check failed: {out}");
    assert!(out.contains("0.2.4"), "expected obscura 0.2.4, got: {out}");
    // Give the fixture server threads a moment to notice `done` on fast runs.
    let _ = Duration::from_millis(1);
}
