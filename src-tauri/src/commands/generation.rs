//! WorkAny generation sidecar: lifecycle, SSE client, artifact staging and
//! atomic promotion into Ritam's data directory.
//!
//! The upstream WorkAny API is not safe to bundle unchanged: on `dev` it binds
//! every interface, has no authentication and allows any CORS origin. This
//! client therefore expects a hardened binary (loopback + bearer token) or an
//! already-running loopback service passed via `RITAM_WORKANY_URL` /
//! `RITAM_WORKANY_TOKEN`. When neither exists, generation reports unsupported
//! and the rest of the browser is unaffected.
//!
//! Final files are selected and written by Rust. The sidecar only writes into a
//! per-job staging directory.

use crate::atomic;
use crate::commands::settings::{
    stored_nvidia_api_key, stored_nvidia_model, NVIDIA_BASE_URL, NVIDIA_MODEL, NVIDIA_MODELS,
};
use crate::db::DbState;
use crate::error::AppError;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const ARTIFACT_TYPES: &[&str] = &["pptx", "xlsx", "docx", "website"];
const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SSE_LINE: usize = 64 * 1024;
const MAX_SSE_EVENTS: usize = 10_000;
const MAX_TREE_FILES: usize = 2_000;
const GENERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct GenerationState {
    inner: Mutex<GenerationInner>,
}

#[derive(Default)]
struct GenerationInner {
    child: Option<Child>,
    base_url: Option<String>,
    token: Option<String>,
    active: Option<ActiveJob>,
}

struct ActiveJob {
    job_id: String,
    session: Arc<Mutex<Option<String>>>,
    cancel: Arc<AtomicBool>,
}

impl GenerationState {
    fn lock(&self) -> Result<MutexGuard<'_, GenerationInner>, AppError> {
        self.inner
            .lock()
            .map_err(|_| AppError::Generation("generation state is unavailable".into()))
    }
}

#[derive(Debug, Serialize)]
pub struct GenerationInfo {
    pub supported: bool,
    pub binary: Option<String>,
    pub running: bool,
    pub active_job: Option<String>,
    pub provider: String,
    pub api_key_configured: bool,
    pub model: String,
    pub models: Vec<String>,
    pub detail: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct GenerationOptions {
    pub language: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GeneratedArtifact {
    pub path: String,
    pub mime_type: String,
    pub site_url: Option<String>,
}

#[tauri::command]
pub fn generation_info(app: AppHandle, db: State<'_, DbState>) -> GenerationInfo {
    let configured_url = loopback_url(std::env::var("RITAM_WORKANY_URL").ok());
    let binary = find_sidecar(&app);
    let api_key_configured = stored_nvidia_api_key(&db).is_some();
    let model = stored_nvidia_model(&db);
    let (running, active_job) = app
        .try_state::<GenerationState>()
        .and_then(|state| {
            state.lock().ok().map(|inner| {
                (
                    inner.active.is_some(),
                    inner.active.as_ref().map(|job| job.job_id.clone()),
                )
            })
        })
        .unwrap_or((false, None));
    let has_token = std::env::var("RITAM_WORKANY_TOKEN")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let engine_available = (configured_url.is_some() && has_token) || binary.is_some();
    let supported = engine_available && api_key_configured;
    let detail = if !engine_available {
        "WorkAny is not installed. Set RITAM_WORKANY_API to a hardened sidecar binary, or RITAM_WORKANY_URL and RITAM_WORKANY_TOKEN for an existing loopback service.".to_string()
    } else if !api_key_configured {
        "Add an NVIDIA API key in Settings to finish setting up generation.".to_string()
    } else {
        format!("NVIDIA NIM is ready via {model}.")
    };
    GenerationInfo {
        supported,
        binary: binary.map(|path| path.display().to_string()),
        running,
        active_job,
        provider: "NVIDIA NIM".to_string(),
        api_key_configured,
        model,
        models: NVIDIA_MODELS.iter().map(|item| item.to_string()).collect(),
        detail,
    }
}

#[tauri::command]
pub async fn generate_artifact(
    app: AppHandle,
    db: State<'_, DbState>,
    artifact_type: String,
    prompt: String,
    options: Option<GenerationOptions>,
) -> Result<GeneratedArtifact, AppError> {
    let api_key = stored_nvidia_api_key(&db).ok_or_else(|| {
        AppError::Generation("add an NVIDIA API key in Settings before generating".into())
    })?;
    let stored_model = stored_nvidia_model(&db);
    let kind = artifact_type.trim().to_ascii_lowercase();
    let extension = artifact_extension(&kind)
        .ok_or_else(|| AppError::InvalidInput("unsupported artifact type".into()))?;
    let prompt = clean_prompt(&prompt)?;
    let job_id = uuid::Uuid::new_v4().to_string();
    // Resolve paths before claiming the single active slot; any early return
    // below must not leave the dialog permanently "generating".
    let generation_root = app_data_dir(&app)?.join("generations");
    let job_dir = generation_root.join(&job_id);
    let staging = job_dir.join("staging");

    let session = Arc::new(Mutex::new(None));
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let state = app
            .try_state::<GenerationState>()
            .ok_or_else(|| AppError::Generation("generation is not initialised".into()))?;
        let mut inner = state.lock()?;
        if inner.active.is_some() {
            return Err(AppError::Generation(
                "another generation is already running".into(),
            ));
        }
        inner.active = Some(ActiveJob {
            job_id: job_id.clone(),
            session: session.clone(),
            cancel: cancel.clone(),
        });
    }

    // Tell the dialog its job id immediately so Cancel works during startup.
    emit_progress(&app, &job_id, "queued", "Preparing the generation engine");
    let options = options.unwrap_or_default();
    let model = options.model.unwrap_or(stored_model);

    let outcome = async {
        let (base_url, token) = ensure_sidecar(&app)?;
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Generation("generation was cancelled".into()));
        }
        fs::create_dir_all(&staging)?;
        let effective_prompt = generation_prompt(&prompt, &kind, extension, &staging);
        let language = options.language.unwrap_or_else(|| "en-US".into());
        let job = job_id.clone();
        let app_for_task = app.clone();
        let staging_for_task = staging.clone();
        let kind_for_task = kind.clone();
        let extension = extension.to_string();
        let session = session.clone();
        let cancel = cancel.clone();

        let joined = tauri::async_runtime::spawn_blocking(move || {
            run_job(
                &app_for_task,
                &job,
                &kind_for_task,
                &extension,
                &effective_prompt,
                &staging_for_task,
                &base_url,
                &token,
                &language,
                Some(model.as_str()),
                &api_key,
                session,
                cancel,
            )
        })
        .await
        .map_err(|error| AppError::Generation(format!("generation task failed: {error}")))?;
        joined
    }
    .await;

    finish_job(&app, &job_id);
    // The promoted artifact lives outside the job directory; staging is no
    // longer needed on success or failure.
    let _ = fs::remove_dir_all(&job_dir);
    outcome
}

#[tauri::command]
pub async fn cancel_generation(app: AppHandle, job_id: String) -> Result<bool, AppError> {
    let (cancel, session, base_url, token) = {
        let state = app
            .try_state::<GenerationState>()
            .ok_or_else(|| AppError::Generation("generation is not initialised".into()))?;
        let inner = state.lock()?;
        let Some(active) = inner.active.as_ref().filter(|job| job.job_id == job_id) else {
            return Ok(false);
        };
        active.cancel.store(true, Ordering::SeqCst);
        let session = active
            .session
            .lock()
            .map_err(|_| AppError::Generation("generation session is unavailable".into()))?
            .clone();
        (
            active.cancel.clone(),
            session,
            inner.base_url.clone(),
            inner.token.clone(),
        )
    };
    cancel.store(true, Ordering::SeqCst);
    // Free the single active slot immediately. The worker may still be
    // unwinding, but its cancel flag is set and a new job gets a different id,
    // so the old worker can no longer clear or overwrite the new job.
    finish_job(&app, &job_id);
    if let (Some(session), Some(base_url), Some(token)) = (session, base_url, token) {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            stop_session(&base_url, &token, &session);
        })
        .await;
    }
    Ok(true)
}

pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<GenerationState>() else {
        return;
    };
    let Ok(mut inner) = state.lock() else {
        return;
    };
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    inner.base_url = None;
    inner.token = None;
    if let Some(active) = inner.active.take() {
        active.cancel.store(true, Ordering::SeqCst);
    }
}

fn finish_job(app: &AppHandle, job_id: &str) {
    let Some(state) = app.try_state::<GenerationState>() else {
        return;
    };
    let Ok(mut inner) = state.lock() else {
        return;
    };
    if inner.active.as_ref().map(|job| job.job_id.as_str()) == Some(job_id) {
        inner.active = None;
    }
}

fn artifact_extension(kind: &str) -> Option<&'static str> {
    if !ARTIFACT_TYPES.contains(&kind) {
        return None;
    }
    match kind {
        "pptx" => Some("pptx"),
        "xlsx" => Some("xlsx"),
        "docx" => Some("docx"),
        "website" => Some("html"),
        _ => None,
    }
}

fn mime_for(kind: &str) -> &'static str {
    match kind {
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "website" => "text/html",
        _ => "application/octet-stream",
    }
}

fn clean_prompt(prompt: &str) -> Result<String, AppError> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("the prompt is empty".into()));
    }
    if trimmed.chars().count() > MAX_PROMPT_CHARS {
        return Err(AppError::InvalidInput(format!(
            "the prompt is longer than {MAX_PROMPT_CHARS} characters"
        )));
    }
    if trimmed.chars().any(|ch| ch == '\0') {
        return Err(AppError::InvalidInput("the prompt contains invalid characters".into()));
    }
    Ok(trimmed.to_string())
}

fn generation_prompt(user_prompt: &str, kind: &str, extension: &str, staging: &Path) -> String {
    let target = if kind == "website" {
        "a complete static website with an index.html entry point".to_string()
    } else {
        format!("exactly one .{extension} file")
    };
    let format_rule = if kind == "website" {
        "Build a working static site whose index.html opens without a server and whose local assets are inside the same directory."
    } else {
        "Create a genuine Office Open XML document using an installed library (for example python-pptx, python-docx or openpyxl). Never rename HTML, text or a hand-built archive to the requested extension. Reopen the finished file with that library and verify it is valid before you stop."
    };
    let content_rule = if kind == "pptx" {
        " Build a complete deck unless the user asks for a shorter one: title slide, agenda, at least six substantive content slides, and a closing slide. Use concise bullets (at most five per slide), consistent headings, and no placeholder text or empty slides."
    } else {
        ""
    };
    let tool_rule = if kind == "pptx" {
        " Runtime note: the agent shell may be Linux-like on Windows. Use the Write tool for files and run scripts with the available Node runtime. If you use pptxgenjs, call slide.addText(textString, {x,y,w,h,fontSize,...}); never pass an options object as the first argument."
    } else {
        ""
    };
    format!(
        "{user_prompt}\n\n---\nGeneration target: {target}.\n\
         {format_rule}{content_rule}{tool_rule}\n\
         Save every generated file inside this absolute directory:\n{}\n\
         Use only absolute paths under that directory. Do not write anywhere else. \
         Do not include credentials or global configuration changes. When finished, \
         make sure the requested artifact is present in that directory.",
        staging.display()
    )
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Generation(format!("could not resolve app data: {error}")))
}

fn loopback_url(raw: Option<String>) -> Option<String> {
    let raw = raw?.trim().trim_end_matches('/').to_string();
    let url = reqwest::Url::parse(&raw).ok()?;
    if url.scheme() != "http" {
        return None;
    }
    match url.host_str()? {
        "127.0.0.1" | "localhost" | "::1" => Some(raw),
        _ => None,
    }
}

fn find_sidecar(app: &AppHandle) -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("RITAM_WORKANY_API") {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir);
    }
    if let Ok(dir) = app.path().app_data_dir() {
        dirs.push(dir.join("workany"));
    }
    dirs.push(PathBuf::from("src-tauri/binaries"));
    dirs.push(PathBuf::from("binaries"));
    for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let right_name = if cfg!(windows) {
                name.starts_with("workany-api") && name.ends_with(".exe")
            } else {
                name.starts_with("workany-api")
            };
            if right_name && path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn ensure_sidecar(app: &AppHandle) -> Result<(String, String), AppError> {
    let state = app
        .try_state::<GenerationState>()
        .ok_or_else(|| AppError::Generation("generation is not initialised".into()))?;

    let cached = {
        let inner = state.lock()?;
        (inner.base_url.clone(), inner.token.clone())
    };
    if let (Some(base_url), Some(token)) = cached {
        if health_ok(&base_url, &token) {
            return Ok((base_url, token));
        }
    }
    // A cached endpoint that failed its health check — or a child whose
    // endpoint was never recorded — must not survive into the next spawn.
    {
        let mut inner = state.lock()?;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.base_url = None;
        inner.token = None;
    }

    if let (Some(url), Some(token)) = (
        loopback_url(std::env::var("RITAM_WORKANY_URL").ok()),
        std::env::var("RITAM_WORKANY_TOKEN").ok().filter(|value| !value.trim().is_empty()),
    ) {
        if !health_ok(&url, &token) {
            return Err(AppError::Generation(
                "the configured WorkAny service is not responding on its loopback address".into(),
            ));
        }
        let mut inner = state.lock()?;
        inner.base_url = Some(url.clone());
        inner.token = Some(token.clone());
        return Ok((url, token));
    }

    let binary = find_sidecar(app).ok_or_else(|| {
        AppError::Generation(
            "WorkAny is not installed. Set RITAM_WORKANY_API to a hardened sidecar binary."
                .into(),
        )
    })?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    let home = app_data_dir(app)?.join("workany");
    fs::create_dir_all(&home)?;

    let mut command = Command::new(&binary);
    command
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("WORKANY_TOKEN", &token)
        .env("WORKANY_HOME", &home)
        .env("RITAM_MODE", "1")
        .env("SANDBOX_API_URL", format!("http://127.0.0.1:{port}"))
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|error| {
        AppError::Generation(format!("could not start the WorkAny sidecar: {error}"))
    })?;

    let base_url = format!("http://127.0.0.1:{port}");
    let deadline = std::time::Instant::now() + HEALTH_TIMEOUT;
    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| AppError::Generation(format!("HTTP client error: {error}")))?;
    let mut ready = false;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(AppError::Generation(format!(
                "the WorkAny sidecar exited during startup ({status})"
            )));
        }
        if let Ok(response) = client
            .get(format!("{base_url}/health"))
            .bearer_auth(&token)
            .send()
        {
            if response.status().is_success() {
                ready = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError::Generation(
            "the WorkAny sidecar did not become ready within 30 seconds".into(),
        ));
    }

    let mut inner = state.lock()?;
    if let Some(mut old_child) = inner.child.take() {
        let _ = old_child.kill();
        let _ = old_child.wait();
    }
    inner.child = Some(child);
    inner.base_url = Some(base_url.clone());
    inner.token = Some(token.clone());
    Ok((base_url, token))
}

fn health_ok(base_url: &str, token: &str) -> bool {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()
        .and_then(|client| {
            client
                .get(format!("{base_url}/health"))
                .bearer_auth(token)
                .send()
                .ok()
        })
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn run_job(
    app: &AppHandle,
    job_id: &str,
    kind: &str,
    extension: &str,
    prompt: &str,
    staging: &Path,
    base_url: &str,
    token: &str,
    language: &str,
    model: Option<&str>,
    api_key: &str,
    session: Arc<Mutex<Option<String>>>,
    cancel: Arc<AtomicBool>,
) -> Result<GeneratedArtifact, AppError> {
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Generation("generation was cancelled".into()));
    }
    let client = Client::builder()
        .timeout(GENERATION_TIMEOUT)
        .build()
        .map_err(|error| AppError::Generation(format!("HTTP client error: {error}")))?;
    let body = json!({
        "prompt": prompt,
        "workDir": staging.to_string_lossy(),
        "language": language,
        "modelConfig": {
            "apiKey": api_key,
            "baseUrl": NVIDIA_BASE_URL,
            "apiType": "openai-completions",
            "providerId": "nvidia",
            "model": model.unwrap_or(NVIDIA_MODEL)
        },
        "sandboxConfig": { "enabled": false },
        "skillsConfig": {
            "enabled": false,
            "userDirEnabled": false,
            "appDirEnabled": false
        },
        "mcpConfig": {
            "enabled": false,
            "userDirEnabled": false,
            "appDirEnabled": true
        }
    });

    emit_progress(app, job_id, "starting", "Starting the WorkAny agent");
    let response = client
        .post(format!("{base_url}/agent"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(|error| {
            AppError::Generation(format!("WorkAny did not accept the request: {error}"))
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = limited_body(response, 2_000);
        let message = if status == reqwest::StatusCode::UNAUTHORIZED {
            "WorkAny rejected the session token".to_string()
        } else if detail.trim().is_empty() {
            format!("WorkAny returned HTTP {status}")
        } else {
            format!("WorkAny returned HTTP {status}: {detail}")
        };
        return Err(AppError::Generation(message));
    }

    emit_progress(app, job_id, "thinking", "Model is planning the artifact");
    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut events = 0usize;
    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line.len() > MAX_SSE_LINE {
            return Err(AppError::Generation(
                "WorkAny sent an oversized event stream line".into(),
            ));
        }
        let Some(event) = sse_value(&line) else {
            continue;
        };
        events += 1;
        if events > MAX_SSE_EVENTS {
            return Err(AppError::Generation(
                "WorkAny sent too many event stream messages".into(),
            ));
        }
        match event.get("type").and_then(Value::as_str).unwrap_or_default() {
            "session" => {
                if let Some(id) = event.get("sessionId").and_then(Value::as_str) {
                    if let Ok(mut slot) = session.lock() {
                        *slot = Some(id.to_string());
                    }
                    emit_progress(app, job_id, "thinking", "Agent session connected");
                }
            }
            "text" => {
                let text = event.get("content").and_then(Value::as_str).unwrap_or("");
                if !text.trim().is_empty() {
                    emit_progress(app, job_id, "thinking", &truncate(text, 300));
                }
            }
            "tool_use" => {
                let name = event.get("name").and_then(Value::as_str).unwrap_or("tool");
                let detail = tool_activity(event.get("input"));
                let message = if detail.is_empty() {
                    format!("Running {name}")
                } else {
                    format!("Running {name}: {detail}")
                };
                emit_progress(app, job_id, "tool", &truncate(&message, 320));
            }
            "tool_result" => {
                let failed = event
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                emit_progress(
                    app,
                    job_id,
                    "tool",
                    if failed {
                        "Tool failed; adjusting the approach"
                    } else {
                        "Tool finished"
                    },
                );
            }
            "error" => {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("WorkAny reported an error");
                return Err(AppError::Generation(truncate(message, 2_000)));
            }
            "result" => {
                let cost = event.get("cost").and_then(Value::as_f64);
                let duration = event.get("duration").and_then(Value::as_i64);
                if let Some(cost) = cost {
                    emit_progress(
                        app,
                        job_id,
                        "result",
                        &format!(
                            "Agent reported a cost of {cost:.4}{}",
                            duration
                                .map(|ms| format!(" and {:.1}s", ms as f64 / 1000.0))
                                .unwrap_or_default()
                        ),
                    );
                }
            }
            "done" => break,
            _ => {}
        }
    }

    if cancel.load(Ordering::SeqCst) {
        if let Ok(slot) = session.lock() {
            if let Some(id) = slot.as_deref() {
                stop_session(base_url, token, id);
            }
        }
        return Err(AppError::Generation("generation was cancelled".into()));
    }

    emit_progress(app, job_id, "writing", "Saving the generated file");
    let artifact = find_artifact(staging, kind, extension)?.ok_or_else(|| {
        AppError::Generation(
            "WorkAny finished without writing the requested file into the workspace".into(),
        )
    })?;
    let root = app_data_dir(app)?.join("generations");
    fs::create_dir_all(&root)?;
    let slug = slug_from(prompt);

    let final_path = if kind == "website" {
        let source = artifact.parent().unwrap_or(staging);
        let target = unique_dir(&root, &format!("{slug}-site"));
        copy_tree(source, &target)?;
        target.join("index.html")
    } else {
        let metadata = fs::metadata(&artifact)?;
        if metadata.len() > MAX_ARTIFACT_BYTES {
            return Err(AppError::Generation(format!(
                "the generated file is larger than {} MB",
                MAX_ARTIFACT_BYTES / (1024 * 1024)
            )));
        }
        let bytes = fs::read(&artifact)?;
        if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
            return Err(AppError::Generation(format!(
                "the generated file is larger than {} MB",
                MAX_ARTIFACT_BYTES / (1024 * 1024)
            )));
        }
        if !valid_office_container(kind, &bytes) {
            return Err(AppError::Generation(format!(
                "WorkAny wrote an invalid .{extension} file. The model must create a real Office document with an Office library, not a renamed text or HTML file."
            )));
        }
        let target = unique_file(&root, &slug, extension);
        atomic::write_atomic(&target, &bytes)?;
        target
    };

    emit_progress(app, job_id, "done", "Generation complete");
    Ok(GeneratedArtifact {
        path: final_path.display().to_string(),
        mime_type: mime_for(kind).to_string(),
        site_url: None,
    })
}

fn emit_progress(app: &AppHandle, job_id: &str, phase: &str, message: &str) {
    let _ = app.emit(
        "generation-progress",
        json!({
            "jobId": job_id,
            "phase": phase,
            "message": message,
            "at": crate::db::now_ms()
        }),
    );
}

fn sse_value(line: &str) -> Option<Value> {
    let data = line.trim_end_matches(['\r', '\n']);
    let data = data.strip_prefix("data:")?.trim();
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(data).ok()
}

fn limited_body(response: reqwest::blocking::Response, limit: usize) -> String {
    let mut bytes = Vec::new();
    let _ = response.take(limit as u64).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn stop_session(base_url: &str, token: &str, session: &str) {
    if let Ok(client) = Client::builder().timeout(Duration::from_secs(3)).build() {
        let _ = client
            .post(format!("{base_url}/agent/stop/{session}"))
            .bearer_auth(token)
            .send();
    }
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// A short, human-readable label for the tool currently running. This is shown
/// in the live generation panel; it deliberately ignores arbitrary tool input.
fn tool_activity(input: Option<&Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    for key in ["command", "file_path", "path", "query", "skill", "description"] {
        let Some(value) = input.get(key).and_then(Value::as_str) else {
            continue;
        };
        let first_line = value.lines().next().unwrap_or(value).trim();
        if !first_line.is_empty() {
            return truncate(first_line, 180);
        }
    }
    String::new()
}

fn is_artifact_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | ".svn"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".cache"
            | "target"
    )
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

/// Office Open XML files are ZIP containers with a content-types manifest and
/// a format-specific part. A plain-text or HTML file renamed to .pptx/.docx/
/// .xlsx must not be promoted as a generated document.
fn valid_office_container(kind: &str, bytes: &[u8]) -> bool {
    let marker = match kind {
        "pptx" => "ppt/presentation.xml",
        "docx" => "word/document.xml",
        "xlsx" => "xl/workbook.xml",
        _ => return true,
    };
    bytes.starts_with(b"PK")
        && contains_bytes(bytes, b"[Content_Types].xml")
        && contains_bytes(bytes, marker.as_bytes())
}

fn find_artifact(root: &Path, kind: &str, extension: &str) -> Result<Option<PathBuf>, AppError> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let mut files = 0usize;
    walk_artifacts(root, 0, kind, extension, &mut files, &mut best)?;
    Ok(best.map(|(_, path)| path))
}

fn walk_artifacts(
    dir: &Path,
    depth: usize,
    kind: &str,
    extension: &str,
    files: &mut usize,
    best: &mut Option<(SystemTime, PathBuf)>,
) -> Result<(), AppError> {
    if depth > 8 || *files >= MAX_TREE_FILES {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
            if is_artifact_ignored_dir(name) {
                continue;
            }
            walk_artifacts(&path, depth + 1, kind, extension, files, best)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        *files += 1;
        let matches = if kind == "website" {
            path.file_name().map(|name| name == "index.html").unwrap_or(false)
        } else {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case(extension))
                .unwrap_or(false)
        };
        if !matches {
            continue;
        }
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let replace = best
            .as_ref()
            .map(|(current, _)| modified > *current)
            .unwrap_or(true);
        if replace {
            *best = Some((modified, path));
        }
    }
    Ok(())
}

fn slug_from(prompt: &str) -> String {
    let cleaned: String = prompt
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == ' ' || ch == '-' {
                ch
            } else {
                ' '
            }
        })
        .collect();
    let slug = cleaned
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    let slug: String = slug.chars().take(48).collect();
    if slug.is_empty() {
        "generated-artifact".into()
    } else {
        slug
    }
}

fn unique_file(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    for index in 0..1_000 {
        let name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}.{extension}", uuid::Uuid::new_v4()))
}

fn unique_dir(dir: &Path, stem: &str) -> PathBuf {
    for index in 0..1_000 {
        let name = if index == 0 {
            stem.to_string()
        } else {
            format!("{stem} ({index})")
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}", uuid::Uuid::new_v4()))
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), AppError> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    copy_tree_inner(source, target, &mut files, &mut bytes, 0)
}

fn copy_tree_inner(
    source: &Path,
    target: &Path,
    files: &mut usize,
    bytes: &mut u64,
    depth: usize,
) -> Result<(), AppError> {
    if depth > 8 {
        return Err(AppError::Generation(
            "the generated website is nested too deeply to save".into(),
        ));
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)?.flatten() {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if is_artifact_ignored_dir(&name) {
                continue;
            }
            copy_tree_inner(&path, &destination, files, bytes, depth + 1)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        *files += 1;
        *bytes = bytes.saturating_add(metadata.len());
        if *files > MAX_TREE_FILES || *bytes > MAX_ARTIFACT_BYTES {
            return Err(AppError::Generation(
                "the generated website is too large to save".into(),
            ));
        }
        fs::copy(&path, &destination)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_types_are_allowlisted() {
        for kind in ARTIFACT_TYPES {
            assert!(artifact_extension(kind).is_some(), "{kind}");
        }
        assert!(artifact_extension("exe").is_none());
        assert!(artifact_extension("../docx").is_none());
    }

    #[test]
    fn prompts_are_trimmed_and_bounded() {
        assert_eq!(clean_prompt("  make a deck  ").unwrap(), "make a deck");
        assert!(clean_prompt("   ").is_err());
        assert!(clean_prompt(&"a".repeat(MAX_PROMPT_CHARS + 1)).is_err());
        assert!(clean_prompt("a\0b").is_err());
    }

    #[test]
    fn tool_activity_uses_a_short_safe_label() {
        assert_eq!(
            tool_activity(Some(&json!({"file_path": "C:\\out\\deck.pptx"}))),
            "C:\\out\\deck.pptx"
        );
        assert_eq!(
            tool_activity(Some(&json!({"command": "python build.py\nrm -rf /"}))),
            "python build.py"
        );
        assert_eq!(tool_activity(Some(&json!({"input": "unrelated"}))), "");
        assert_eq!(tool_activity(None), "");
    }

    #[test]
    fn dependency_directories_are_not_scanned_for_artifacts() {
        let root = std::env::temp_dir().join(format!("ritam-gen-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("node_modules").join("package")).unwrap();
        fs::write(root.join("node_modules").join("package").join("fake.pptx"), b"no")
            .unwrap();
        fs::write(root.join("real.pptx"), b"yes").unwrap();
        let found = find_artifact(&root, "pptx", "pptx").unwrap().unwrap();
        assert!(found.ends_with("real.pptx"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn office_artifacts_must_have_ooxml_markers() {
        assert!(!valid_office_container("pptx", b"<html>not a deck</html>"));
        assert!(!valid_office_container(
            "pptx",
            b"PK\x03\x04[Content_Types].xml"
        ));
        assert!(valid_office_container(
            "pptx",
            b"PK\x03\x04[Content_Types].xmlppt/presentation.xml"
        ));
        assert!(valid_office_container(
            "docx",
            b"PK\x03\x04[Content_Types].xmlword/document.xml"
        ));
        assert!(valid_office_container(
            "xlsx",
            b"PK\x03\x04[Content_Types].xmlxl/workbook.xml"
        ));
        assert!(valid_office_container("website", b"<html></html>"));
    }

    #[test]
    fn sse_json_is_extracted_and_malformed_lines_are_ignored() {
        let value = sse_value("data: {\"type\":\"session\",\"sessionId\":\"abc\"}\n").unwrap();
        assert_eq!(value["sessionId"], "abc");
        assert!(sse_value("event: message\n").is_none());
        assert!(sse_value("data: not-json\n").is_none());
        assert!(sse_value("data:\n").is_none());
    }

    #[test]
    fn the_newest_matching_artifact_wins() {
        let root = std::env::temp_dir().join(format!("ritam-gen-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("output")).unwrap();
        fs::write(root.join("older.docx"), b"old").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(root.join("output").join("newer.docx"), b"new").unwrap();
        fs::write(root.join("ignored.pptx"), b"no").unwrap();
        let found = find_artifact(&root, "docx", "docx").unwrap().unwrap();
        assert!(found.ends_with("newer.docx"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn slugs_and_unique_names_do_not_escape_the_directory() {
        let root = std::env::temp_dir().join(format!("ritam-gen-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let slug = slug_from("../../etc/passwd: a report");
        assert!(!slug.contains('/'));
        assert!(!slug.contains('\\'));
        let path = unique_file(&root, &slug, "docx");
        assert_eq!(path.parent(), Some(root.as_path()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn loopback_urls_only_accept_local_http() {
        assert!(loopback_url(Some("http://127.0.0.1:2620".into())).is_some());
        assert!(loopback_url(Some("http://localhost:2620/".into())).is_some());
        assert!(loopback_url(Some("https://127.0.0.1:2620".into())).is_none());
        assert!(loopback_url(Some("http://example.com:2620".into())).is_none());
        assert!(loopback_url(None).is_none());
    }
}
