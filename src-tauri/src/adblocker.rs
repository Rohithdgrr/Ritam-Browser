//! Built-in network and cosmetic ad blocker.
//!
//! The engine is [`adblock-rust`], loaded with public EasyList/EasyPrivacy and
//! uBlock Origin filter lists. Full list snapshots and the uBlock scriptlet /
//! redirect resources are compiled into the binary, so a fresh install blocks
//! before it makes a single update request. A background updater refreshes the
//! cached lists and rebuilds the engine only when something changed.
//!
//! Runtime flow:
//! - [`NetworkBlocker::check_request`] classifies a WebView2 resource request
//!   as allowed, blocked, or redirected.
//! - [`NetworkBlocker::page_resources`] returns everything needed to prepare a
//!   document at document-start: hide selectors, scriptlets, procedural
//!   actions, exceptions, and `$generichide` state.
//! - [`NetworkBlocker::generic_selectors_for_url`] resolves generic class/id
//!   rules once the page reports which classes and ids actually exist.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime};

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::resources::{PermissionMask, Resource};
use adblock::Engine;

/// Fallback staleness for cached lists whose header has no `Expires:` value.
const DEFAULT_REFRESH_INTERVAL: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// Upstream `Expires:` values are clamped to this range. uBlock Origin's quick
/// fixes list expires every 12 hours; EasyList every 4 days.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);
const MAX_REFRESH_INTERVAL: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// Updater wake-up cadence (the list staleness check itself is cheap).
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
const MAX_LIST_BYTES: u64 = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = MAX_LIST_BYTES + 1;
const MAX_ENGINE_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const ENGINE_CACHE_VERSION: u32 = 2;
const ADBLOCK_ENGINE_VERSION: &str = "adblock-rust 0.13.5";
const ENGINE_CACHE_FILE: &str = "engine.dat";
const ENGINE_CACHE_KEY_FILE: &str = "engine.key";

/// Only the uBlock Origin lists are allowed to inject trusted scriptlets
/// (`trusted-set-cookie`, `trusted-edit-inbound-object`, …). EasyList and
/// EasyPrivacy are parsed without any permission bits.
const TRUSTED_PERMISSION: PermissionMask = PermissionMask::from_bits(1);

const BUNDLED_RESOURCES_JSON: &str = include_str!("../filter-assets/resources.json");

struct FilterList {
  filename: &'static str,
  url: &'static str,
  /// Lower-case marker expected in the list's `! Title:` header.
  needle: &'static str,
  /// Minimum number of non-comment rules accepted for this list.
  min_rules: usize,
  trusted: bool,
  bundled: &'static str,
}

const LISTS: &[FilterList] = &[
  FilterList {
    filename: "easylist.txt",
    url: "https://easylist.to/easylist/easylist.txt",
    needle: "easylist",
    min_rules: 100,
    trusted: false,
    bundled: include_str!("../filter-assets/easylist.txt"),
  },
  FilterList {
    filename: "easyprivacy.txt",
    url: "https://easylist.to/easylist/easyprivacy.txt",
    needle: "easyprivacy",
    min_rules: 100,
    trusted: false,
    bundled: include_str!("../filter-assets/easyprivacy.txt"),
  },
  FilterList {
    filename: "ublock-filters.txt",
    url: "https://ublockorigin.github.io/uAssetsCDN/filters/filters.min.txt",
    needle: "ublock filters",
    min_rules: 100,
    trusted: true,
    bundled: include_str!("../filter-assets/ublock-filters.txt"),
  },
  FilterList {
    filename: "ublock-quick-fixes.txt",
    url: "https://ublockorigin.github.io/uAssetsCDN/filters/quick-fixes.min.txt",
    needle: "quick fixes",
    min_rules: 100,
    trusted: true,
    bundled: include_str!("../filter-assets/ublock-quick-fixes.txt"),
  },
  FilterList {
    filename: "ublock-unbreak.txt",
    url: "https://ublockorigin.github.io/uAssetsCDN/filters/unbreak.min.txt",
    needle: "unbreak",
    min_rules: 100,
    trusted: true,
    bundled: include_str!("../filter-assets/ublock-unbreak.txt"),
  },
  FilterList {
    filename: "ublock-badware.txt",
    url: "https://ublockorigin.github.io/uAssetsCDN/filters/badware.min.txt",
    needle: "badware",
    min_rules: 100,
    trusted: true,
    bundled: include_str!("../filter-assets/ublock-badware.txt"),
  },
  FilterList {
    filename: "ublock-privacy.txt",
    url: "https://ublockorigin.github.io/uAssetsCDN/filters/privacy.min.txt",
    needle: "privacy",
    min_rules: 100,
    trusted: true,
    bundled: include_str!("../filter-assets/ublock-privacy.txt"),
  },
  FilterList {
    filename: "ublock-resource-abuse.txt",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt",
    needle: "resource abuse",
    min_rules: 40,
    trusted: true,
    bundled: include_str!("../filter-assets/ublock-resource-abuse.txt"),
  },
];

/// What WebView2 should do with a resource request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkVerdict {
  Allow,
  Block,
  /// Serve this `data:` URL instead of contacting the network.
  Redirect(String),
  /// Fetch this URL instead of the original one (`$removeparam`).
  Rewrite(String),
}

/// Cosmetic and scriptlet work for one document.
#[derive(Debug, Clone, Default)]
pub struct PageResources {
  /// Selectors that should be hidden with `display: none !important`.
  pub hide_selectors: Vec<String>,
  /// JSON-encoded procedural filters or filters with an action.
  pub procedural_actions: Vec<String>,
  /// Class/id selectors exempted from generic rules on this page.
  pub exceptions: Vec<String>,
  /// Scriptlet code to run at document-start.
  pub injected_script: String,
  /// True when the page has a `$generichide` exception.
  pub generichide: bool,
}

#[derive(Debug, Clone)]
pub struct BlockerStatus {
  pub enabled: bool,
  pub ready: bool,
  pub loaded_lists: usize,
  pub resource_count: usize,
  pub allowlist_count: usize,
  pub blocked_requests: u64,
  pub redirected_requests: u64,
  pub rewritten_requests: u64,
}

#[derive(Clone)]
pub struct NetworkBlocker {
  engine: Arc<RwLock<Arc<Engine>>>,
  enabled: Arc<AtomicBool>,
  ready: Arc<AtomicBool>,
  loaded_lists: Arc<AtomicUsize>,
  resource_count: Arc<AtomicUsize>,
  blocked_requests: Arc<AtomicU64>,
  redirected_requests: Arc<AtomicU64>,
  rewritten_requests: Arc<AtomicU64>,
  allowlist: Arc<RwLock<HashSet<String>>>,
}

impl NetworkBlocker {
  pub fn new() -> Self {
    Self {
      engine: Arc::new(RwLock::new(Arc::new(Engine::default()))),
      enabled: Arc::new(AtomicBool::new(true)),
      ready: Arc::new(AtomicBool::new(false)),
      loaded_lists: Arc::new(AtomicUsize::new(0)),
      resource_count: Arc::new(AtomicUsize::new(0)),
      blocked_requests: Arc::new(AtomicU64::new(0)),
      redirected_requests: Arc::new(AtomicU64::new(0)),
      rewritten_requests: Arc::new(AtomicU64::new(0)),
      allowlist: Arc::new(RwLock::new(HashSet::new())),
    }
  }

  pub fn set_enabled(&self, enabled: bool) {
    self.enabled.store(enabled, Ordering::Relaxed);
  }

  /// Replace the per-site allowlist. Entries are hostnames, optionally with a
  /// leading `*.` or `.`; subdomains are always included.
  pub fn set_allowlist(&self, text: &str) {
    let entries = text
      .lines()
      .filter_map(normalize_allowlist_entry)
      .collect::<HashSet<_>>();
    *self.allowlist.write().unwrap_or_else(|error| error.into_inner()) = entries;
  }

  pub fn allowlist_count(&self) -> usize {
    self
      .allowlist
      .read()
      .unwrap_or_else(|error| error.into_inner())
      .len()
  }

  /// True when `url`'s hostname matches an allowlist entry.
  pub fn is_page_allowed(&self, url: &str) -> bool {
    let allowlist = self
      .allowlist
      .read()
      .unwrap_or_else(|error| error.into_inner());
    if allowlist.is_empty() {
      return false;
    }
    let Ok(request) = Request::new(url, url, "document", "GET") else {
      return false;
    };
    hostname_allowed(&allowlist, &request.hostname)
  }

  /// Classify one WebView2 resource request.
  pub fn check_request(
    &self,
    url: &str,
    source_url: &str,
    request_type: &str,
    method: &str,
  ) -> NetworkVerdict {
    if !self.enabled.load(Ordering::Relaxed) {
      return NetworkVerdict::Allow;
    }
    // Allowing a site must also stop subresource blocking for that site.
    if self.is_page_allowed(source_url) || self.is_page_allowed(url) {
      return NetworkVerdict::Allow;
    }
    let Ok(request) = Request::new(url, source_url, request_type, method) else {
      return NetworkVerdict::Allow;
    };
    let engine = self
      .engine
      .read()
      .unwrap_or_else(|error| error.into_inner())
      .clone();
    let result = engine.check_network_request(&request);
    if !result.should_block() {
      // `$removeparam` rules only rewrite; they never block. The engine
      // returns the cleaned URL so the caller can substitute it.
      return match result.rewritten_url {
        Some(rewritten) => NetworkVerdict::Rewrite(rewritten),
        None => NetworkVerdict::Allow,
      };
    }
    match result.redirect {
      Some(data_url) => NetworkVerdict::Redirect(data_url),
      None => NetworkVerdict::Block,
    }
  }

  pub fn record_blocked_request(&self) {
    self.blocked_requests.fetch_add(1, Ordering::Relaxed);
  }

  pub fn record_redirected_request(&self) {
    self.redirected_requests.fetch_add(1, Ordering::Relaxed);
  }

  pub fn record_rewritten_request(&self) {
    self.rewritten_requests.fetch_add(1, Ordering::Relaxed);
  }

  /// Everything needed to prepare `url` at document-start. Returns `None` when
  /// blocking is off or the page is allowlisted.
  pub fn page_resources(&self, url: &str) -> Option<PageResources> {
    if !self.enabled.load(Ordering::Relaxed) || self.is_page_allowed(url) {
      return None;
    }
    let engine = self
      .engine
      .read()
      .unwrap_or_else(|error| error.into_inner())
      .clone();
    let resources = engine.url_cosmetic_resources(url);
    Some(PageResources {
      hide_selectors: sorted(resources.hide_selectors),
      procedural_actions: sorted(resources.procedural_actions),
      exceptions: sorted(resources.exceptions),
      injected_script: resources.injected_script,
      generichide: resources.generichide,
    })
  }

  /// Resolve generic class/id cosmetic rules for the classes and ids that a
  /// page has reported. `exceptions` should come from [`PageResources`].
  pub fn generic_selectors_for_url(
    &self,
    url: &str,
    classes: &[String],
    ids: &[String],
    exceptions: &[String],
  ) -> Vec<String> {
    if !self.enabled.load(Ordering::Relaxed) || self.is_page_allowed(url) {
      return Vec::new();
    }
    let ignored = exceptions.iter().cloned().collect::<HashSet<_>>();
    let engine = self
      .engine
      .read()
      .unwrap_or_else(|error| error.into_inner())
      .clone();
    let mut selectors = engine.hidden_class_id_selectors(classes, ids, &ignored);
    selectors.sort_unstable();
    selectors.dedup();
    selectors
  }

  /// Host-specific cosmetic selectors. Kept for the settings/status path and
  /// tests; the document-start script uses [`Self::page_resources`].
  #[cfg(test)]
  pub fn cosmetic_selectors_for_url(&self, url: &str) -> Vec<String> {
    self
      .page_resources(url)
      .map(|resources| resources.hide_selectors)
      .unwrap_or_default()
  }

  pub fn status(&self) -> BlockerStatus {
    BlockerStatus {
      enabled: self.enabled.load(Ordering::Relaxed),
      ready: self.ready.load(Ordering::Relaxed),
      loaded_lists: self.loaded_lists.load(Ordering::Relaxed),
      resource_count: self.resource_count.load(Ordering::Relaxed),
      allowlist_count: self.allowlist_count(),
      blocked_requests: self.blocked_requests.load(Ordering::Relaxed),
      redirected_requests: self.redirected_requests.load(Ordering::Relaxed),
      rewritten_requests: self.rewritten_requests.load(Ordering::Relaxed),
    }
  }

  /// Seed the cache with the compiled-in list snapshots (when missing or
  /// invalid) and build the engine from the cache.
  pub fn load_cache(&self, directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory)
      .map_err(|error| format!("create filter-list cache: {error}"))?;

    for list in LISTS {
      let path = directory.join(list.filename);
      let valid = read_cached_list(&path)
        .and_then(|contents| validate_list(&contents, list))
        .is_ok();
      if !valid {
        let temporary = path.with_extension("txt.tmp");
        if let Err(error) = fs::write(&temporary, list.bundled)
          .map_err(|error| error.to_string())
          .and_then(|()| replace_cache_file(&temporary, &path))
        {
          let _ = fs::remove_file(&temporary);
          log::warn!("could not seed {} from bundled list: {error}", list.filename);
        }
      }
    }

    self.rebuild_engine(directory)
  }

  /// Refresh only stale/invalid lists. Returns `true` when the engine was
  /// rebuilt (i.e. after at least one list changed).
  pub fn refresh_stale_lists(&self, directory: &Path) -> Result<bool, String> {
    fs::create_dir_all(directory)
      .map_err(|error| format!("create filter-list cache: {error}"))?;
    let client = reqwest::blocking::Client::builder()
      .user_agent("RitamBrowser/0.1 (filter-list updater)")
      .timeout(Duration::from_secs(30))
      .redirect(reqwest::redirect::Policy::none())
      .build()
      .map_err(|error| format!("create filter-list HTTP client: {error}"))?;
    let mut errors = Vec::new();
    let mut changed = false;

    for list in LISTS {
      let path = directory.join(list.filename);
      if !is_stale(&path, list) {
        continue;
      }
      match fetch_list(&client, list) {
        Ok(contents) => {
          let temporary_path = path.with_extension("txt.tmp");
          if let Err(error) = fs::write(&temporary_path, contents)
            .map_err(|error| error.to_string())
            .and_then(|()| replace_cache_file(&temporary_path, &path))
          {
            let _ = fs::remove_file(temporary_path);
            errors.push(format!("write {} cache: {error}", list.filename));
          } else {
            changed = true;
          }
        }
        Err(error) => errors.push(error),
      }
    }

    let rebuilt = if changed || !self.ready.load(Ordering::Relaxed) {
      self.rebuild_engine(directory)?;
      true
    } else {
      false
    };

    if errors.is_empty() {
      Ok(rebuilt)
    } else {
      Err(errors.join("; "))
    }
  }

  fn rebuild_engine(&self, directory: &Path) -> Result<(), String> {
    let mut lists = Vec::with_capacity(LISTS.len());

    for list in LISTS {
      let path = directory.join(list.filename);
      let contents = match read_cached_list(&path) {
        Ok(contents) if validate_list(&contents, list).is_ok() => contents,
        Ok(_) => list.bundled.to_string(),
        Err(_) if !path.exists() => list.bundled.to_string(),
        Err(error) => {
          log::warn!("could not read {} cache: {error}", list.filename);
          list.bundled.to_string()
        }
      };
      lists.push((list, contents));
    }

    let resources = bundled_resources()?;
    let resource_count = resources.len();
    let key = cache_key(&lists, resources);

    if let Some(engine) = load_engine_cache(directory, &key, resources) {
      self.install_engine(engine, LISTS.len(), resource_count);
      return Ok(());
    }

    let mut filter_set = FilterSet::new(false);
    for (list, contents) in &lists {
      let options = if list.trusted {
        ParseOptions {
          permissions: TRUSTED_PERMISSION,
          ..ParseOptions::default()
        }
      } else {
        ParseOptions::default()
      };
      filter_set.add_filter_list(contents.clone(), options);
    }

    let mut engine = Engine::new_with_filter_set(filter_set);
    engine.use_resources(resources.iter().cloned());

    if let Err(error) = write_engine_cache(directory, &key, &engine) {
      log::warn!("{error}");
    }

    self.install_engine(engine, lists.len(), resource_count);
    Ok(())
  }

  fn install_engine(&self, engine: Engine, loaded_lists: usize, resource_count: usize) {
    *self
      .engine
      .write()
      .unwrap_or_else(|error| error.into_inner()) = Arc::new(engine);
    self.loaded_lists.store(loaded_lists, Ordering::Relaxed);
    self.resource_count.store(resource_count, Ordering::Relaxed);
    self.ready.store(true, Ordering::Relaxed);
  }
}

fn sorted(values: HashSet<String>) -> Vec<String> {
  let mut values: Vec<_> = values.into_iter().collect();
  values.sort_unstable();
  values
}

fn normalize_allowlist_entry(entry: &str) -> Option<String> {
  let entry = entry.trim().trim_start_matches("*.").trim_start_matches('.').trim_end_matches('.');
  if entry.is_empty()
    || entry.len() > 253
    || !entry
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
  {
    return None;
  }
  Some(entry.to_ascii_lowercase())
}

fn hostname_allowed(allowlist: &HashSet<String>, hostname: &str) -> bool {
  let hostname = hostname.trim_end_matches('.').to_ascii_lowercase();
  allowlist.iter().any(|entry| {
    hostname == *entry || hostname.ends_with(&format!(".{entry}"))
  })
}

fn read_cached_list(path: &Path) -> Result<String, String> {
  let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
  if metadata.len() > MAX_LIST_BYTES {
    return Err("cached list exceeds the size limit".into());
  }
  fs::read_to_string(path).map_err(|error| error.to_string())
}

fn is_stale(path: &Path, list: &FilterList) -> bool {
  let Ok(metadata) = fs::metadata(path) else {
    return true;
  };
  let Ok(modified) = metadata.modified() else {
    return true;
  };
  let Ok(contents) = read_cached_list(path) else {
    return true;
  };
  if validate_list(&contents, list).is_err() {
    return true;
  }
  SystemTime::now()
    .duration_since(modified)
    .unwrap_or_default()
    >= declared_refresh_interval(&contents)
}

/// How long a list snapshot stays fresh, taken from its `! Expires:` header.
/// This keeps uBlock Origin's quick fixes (12 hours) current instead of
/// waiting for the multi-day default that the ad lists use.
fn declared_refresh_interval(contents: &str) -> Duration {
  contents
    .lines()
    .take(80)
    .find_map(|line| {
      let metadata = line.trim().strip_prefix('!')?.trim();
      let lower = metadata.to_ascii_lowercase();
      let value = lower.strip_prefix("expires:")?.trim();
      parse_expires(value)
    })
    .map(|interval| interval.clamp(MIN_REFRESH_INTERVAL, MAX_REFRESH_INTERVAL))
    .unwrap_or(DEFAULT_REFRESH_INTERVAL)
}

fn parse_expires(value: &str) -> Option<Duration> {
  let mut parts = value.split_whitespace();
  let count = parts.next()?.parse::<u64>().ok()?;
  let unit = parts.next()?.trim_end_matches(',').to_ascii_lowercase();
  let seconds = match unit.trim_end_matches('s') {
    "second" => 1,
    "minute" => 60,
    "hour" => 60 * 60,
    "day" => 24 * 60 * 60,
    "week" => 7 * 24 * 60 * 60,
    _ => return None,
  };
  Some(Duration::from_secs(count.saturating_mul(seconds)))
}

fn replace_cache_file(temporary_path: &Path, path: &Path) -> Result<(), String> {
  #[cfg(windows)]
  {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
      MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary: Vec<u16> = temporary_path
      .as_os_str()
      .encode_wide()
      .chain([0])
      .collect();
    let destination: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    unsafe {
      MoveFileExW(
        PCWSTR(temporary.as_ptr()),
        PCWSTR(destination.as_ptr()),
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
      )
    }
    .map_err(|error| format!("replace filter-list cache: {error}"))
  }
  #[cfg(not(windows))]
  {
    fs::rename(temporary_path, path)
      .map_err(|error| format!("replace filter-list cache: {error}"))
  }
}

fn fetch_list(client: &reqwest::blocking::Client, list: &FilterList) -> Result<String, String> {
  let mut response = client
    .get(list.url)
    .send()
    .map_err(|error| format!("download {}: {error}", list.filename))?
    .error_for_status()
    .map_err(|error| format!("download {}: {error}", list.filename))?;
  if response
    .content_length()
    .is_some_and(|length| length > MAX_LIST_BYTES)
  {
    return Err(format!("{} exceeds the size limit", list.filename));
  }
  let mut bytes = Vec::new();
  response
    .by_ref()
    .take(MAX_RESPONSE_BYTES)
    .read_to_end(&mut bytes)
    .map_err(|error| format!("read {} response: {error}", list.filename))?;
  if bytes.len() as u64 > MAX_LIST_BYTES {
    return Err(format!("{} exceeds the size limit", list.filename));
  }
  let contents =
    String::from_utf8(bytes).map_err(|_| format!("{} is not valid UTF-8", list.filename))?;
  validate_list(&contents, list)?;
  Ok(contents)
}

fn validate_list(contents: &str, list: &FilterList) -> Result<(), String> {
  let header = contents
    .char_indices()
    .take_while(|(index, _)| *index < 8_000)
    .map(|(_, character)| character)
    .collect::<String>()
    .to_ascii_lowercase();
  let has_title = header
    .lines()
    .take(80)
    .any(|line| line.starts_with("! title:") && line.contains(list.needle));
  let rules = contents
    .lines()
    .filter(|line| {
      let line = line.trim();
      !line.is_empty() && !line.starts_with('!')
    })
    .count();
  if contents.len() > MAX_LIST_BYTES as usize || !has_title || rules < list.min_rules {
    return Err(format!("{} failed filter-list validation", list.filename));
  }
  Ok(())
}

fn bundled_resources() -> Result<&'static Vec<Resource>, String> {
  static RESOURCES: OnceLock<Result<Vec<Resource>, String>> = OnceLock::new();
  match RESOURCES.get_or_init(|| {
    serde_json::from_str::<Vec<Resource>>(BUNDLED_RESOURCES_JSON)
      .map_err(|error| format!("parse bundled blocker resources: {error}"))
  }) {
    Ok(resources) => Ok(resources),
    Err(error) => Err(error.clone()),
  }
}

fn cache_key(lists: &[(&FilterList, String)], resources: &[Resource]) -> String {
  // FNV-1a over list contents + resource names/dependencies. The cache is
  // disposable; the key only needs to change when the inputs change.
  let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
  let mut feed = |bytes: &[u8]| {
    for byte in bytes {
      hash ^= u64::from(*byte);
      hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash ^= 0xff;
    hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
  };

  for (list, contents) in lists {
    feed(list.filename.as_bytes());
    feed(&(contents.len() as u64).to_le_bytes());
    feed(contents.as_bytes());
  }
  for resource in resources {
    feed(resource.name.as_bytes());
    for alias in &resource.aliases {
      feed(alias.as_bytes());
    }
    for dependency in &resource.dependencies {
      feed(dependency.as_bytes());
    }
    feed(&[resource.permission.to_bits()]);
    // Scriptlet and redirect bodies change independently of the lists.
    feed(resource.content.as_bytes());
  }

  format!("{ENGINE_CACHE_VERSION}:{ADBLOCK_ENGINE_VERSION}:{hash:016x}")
}

fn load_engine_cache(directory: &Path, key: &str, resources: &[Resource]) -> Option<Engine> {
  let cached_key = fs::read_to_string(directory.join(ENGINE_CACHE_KEY_FILE)).ok()?;
  if cached_key.trim() != key {
    return None;
  }
  let metadata = fs::metadata(directory.join(ENGINE_CACHE_FILE)).ok()?;
  if metadata.len() > MAX_ENGINE_CACHE_BYTES {
    return None;
  }
  let bytes = fs::read(directory.join(ENGINE_CACHE_FILE)).ok()?;
  let mut engine = Engine::default();
  engine.deserialize(&bytes).ok()?;
  engine.use_resources(resources.iter().cloned());
  Some(engine)
}

fn write_engine_cache(directory: &Path, key: &str, engine: &Engine) -> Result<(), String> {
  let cache_path = directory.join(ENGINE_CACHE_FILE);
  let temporary = cache_path.with_extension("dat.tmp");
  if let Err(error) = fs::write(&temporary, engine.serialize())
    .map_err(|error| error.to_string())
    .and_then(|()| replace_cache_file(&temporary, &cache_path))
  {
    let _ = fs::remove_file(&temporary);
    return Err(format!("write engine cache: {error}"));
  }

  let key_path = directory.join(ENGINE_CACHE_KEY_FILE);
  let temporary = key_path.with_extension("key.tmp");
  if let Err(error) = fs::write(&temporary, key)
    .map_err(|error| error.to_string())
    .and_then(|()| replace_cache_file(&temporary, &key_path))
  {
    let _ = fs::remove_file(&temporary);
    return Err(format!("write engine cache key: {error}"));
  }
  Ok(())
}

pub fn start_updater(
  blocker: NetworkBlocker,
  directory: PathBuf,
  on_update: impl Fn() + Send + 'static,
) {
  std::thread::spawn(move || loop {
    match blocker.refresh_stale_lists(&directory) {
      Ok(true) => on_update(),
      Ok(false) => {}
      Err(error) => log::warn!("network blocker list update failed: {error}"),
    }
    std::thread::sleep(UPDATE_CHECK_INTERVAL);
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  const TEST_LIST: &str =
    "! Title: EasyList test\n||ads.example^\n@@||ads.example/allowed.js^\nexample.com##.ad-banner\n";

  fn blocker_with_lists(lists: &[(&str, bool)]) -> NetworkBlocker {
    let blocker = NetworkBlocker::new();
    let resources = bundled_resources().expect("bundled resources");
    let mut filter_set = FilterSet::new(false);
    for (contents, trusted) in lists {
      filter_set.add_filter_list(
        (*contents).to_string(),
        if *trusted {
          ParseOptions {
            permissions: TRUSTED_PERMISSION,
            ..ParseOptions::default()
          }
        } else {
          ParseOptions::default()
        },
      );
    }
    let mut engine = Engine::new_with_filter_set(filter_set);
    engine.use_resources(resources.iter().cloned());
    blocker.install_engine(engine, lists.len(), resources.len());
    blocker
  }

  fn blocker_with_test_list() -> NetworkBlocker {
    blocker_with_lists(&[(TEST_LIST, false)])
  }

  #[test]
  fn blocks_matching_network_requests_and_honors_exceptions() {
    let blocker = blocker_with_test_list();
    assert_eq!(
      blocker.check_request(
        "https://ads.example/banner.js",
        "https://publisher.example/",
        "script",
        "GET",
      ),
      NetworkVerdict::Block
    );
    assert_eq!(blocker.status().blocked_requests, 0);
    blocker.record_blocked_request();
    assert_eq!(blocker.status().blocked_requests, 1);
    assert_eq!(
      blocker.check_request(
        "https://ads.example/allowed.js",
        "https://publisher.example/",
        "script",
        "GET",
      ),
      NetworkVerdict::Allow
    );
    assert_eq!(
      blocker.check_request(
        "https://cdn.example/banner.js",
        "https://publisher.example/",
        "script",
        "GET",
      ),
      NetworkVerdict::Allow
    );
  }

  #[test]
  fn disabled_blocker_allows_matching_requests() {
    let blocker = blocker_with_test_list();
    blocker.set_enabled(false);
    assert_eq!(
      blocker.check_request(
        "https://ads.example/banner.js",
        "https://publisher.example/",
        "script",
        "GET",
      ),
      NetworkVerdict::Allow
    );
    assert!(blocker
      .cosmetic_selectors_for_url("https://example.com")
      .is_empty());
  }

  #[test]
  fn returns_host_specific_cosmetic_filters() {
    let blocker = blocker_with_test_list();
    assert_eq!(
      blocker.cosmetic_selectors_for_url("https://example.com"),
      vec![".ad-banner"]
    );
    assert_eq!(blocker.status().loaded_lists, 1);
    assert!(blocker
      .cosmetic_selectors_for_url("https://other.example")
      .is_empty());
  }

  #[test]
  fn allowlisted_pages_skip_network_and_cosmetic_blocking() {
    let blocker = blocker_with_test_list();
    blocker.set_allowlist("*.example.com\nother.test");
    assert_eq!(blocker.allowlist_count(), 2);
    assert!(blocker.is_page_allowed("https://www.example.com/page"));
    assert_eq!(
      blocker.check_request(
        "https://ads.example/banner.js",
        "https://www.example.com/page",
        "script",
        "GET",
      ),
      NetworkVerdict::Allow
    );
    assert!(blocker.page_resources("https://example.com").is_none());
    assert!(blocker
      .generic_selectors_for_url(
        "https://example.com",
        &["ad-banner".into()],
        &[],
        &[]
      )
      .is_empty());
    assert!(!blocker.is_page_allowed("https://notexample.com"));
  }

  #[test]
  fn resolves_redirect_rules_to_data_urls() {
    let blocker = blocker_with_lists(&[
      (
        "! Title: EasyList test\n||ads.example/redirect.js$redirect=noop.js\n",
        false,
      ),
    ]);
    match blocker.check_request(
      "https://ads.example/redirect.js",
      "https://publisher.example/",
      "script",
      "GET",
    ) {
      NetworkVerdict::Redirect(url) => {
        assert!(url.starts_with("data:application/javascript;base64,"));
      }
      verdict => panic!("expected redirect, got {verdict:?}"),
    }
  }

  #[test]
  fn injects_scriptlets_and_their_class_dependencies() {
    let blocker = blocker_with_lists(&[(
      "! Title: uBlock filters test\n\
       example.com##+js(set-constant, adFlag, true)\n\
       example.com##+js(trusted-edit-inbound-object, JSON.stringify, 0, [?.x]+={\"a\":1})\n",
      true,
    )]);
    let resources = blocker
      .page_resources("https://example.com/page")
      .expect("page resources");
    assert!(
      resources.injected_script.contains("setConstant"),
      "set-constant scriptlet missing: {}",
      resources.injected_script
    );
    assert!(
      resources.injected_script.contains("class JSONPath"),
      "jsonpath class dependency missing"
    );
    assert!(
      resources.injected_script.contains("editInboundObject"),
      "trusted scriptlet missing"
    );
  }

  #[test]
  fn serializes_procedural_filters_for_the_page_script() {
    // adblock-rust only supports procedural filters with a hostname
    // constraint; generic ones are silently ignored. Page scripts therefore
    // receive the host-specific set only. `#?#` is the extended-selector
    // marker used by the lists for uBO/ABP procedural operators.
    let blocker = blocker_with_lists(&[(
      "! Title: EasyList test\n\
       example.com#?#.ad-box:has-text(Sponsored)\n\
       example.com#?#.promo:upward(2):remove()\n",
      false,
    )]);
    let resources = blocker
      .page_resources("https://example.com/page")
      .expect("page resources");
    assert!(
      resources
        .procedural_actions
        .iter()
        .any(|action| action.contains("\"type\":\"has-text\"") && action.contains("Sponsored")),
      "procedural actions: {:?}",
      resources.procedural_actions
    );
    assert!(resources
      .procedural_actions
      .iter()
      .any(|action| action.contains("\"type\":\"upward\"") && action.contains("\"type\":\"remove\"")));
  }

  #[test]
  fn resolves_generic_class_rules_from_page_report() {
    let blocker = blocker_with_lists(&[(
      "! Title: EasyList test\n##.sponsored-box\n##div[class^=\"ad-\"]\n",
      false,
    )]);
    let resources = blocker
      .page_resources("https://example.com")
      .expect("page resources");
    let selectors = blocker.generic_selectors_for_url(
      "https://example.com",
      &["sponsored-box".to_string()],
      &[],
      &resources.exceptions,
    );
    assert!(selectors.iter().any(|selector| selector == ".sponsored-box"));
  }

  #[test]
  fn rewrites_requests_matched_by_removeparam_rules() {
    // Real uBlock privacy rules use the `$doc,removeparam=` form.
    let blocker = blocker_with_lists(&[(
      "! Title: EasyPrivacy test\n||reddit.com^$doc,removeparam=utm_content\n",
      false,
    )]);
    match blocker.check_request(
      "https://www.reddit.com/r/rust?utm_content=abc&keep=1",
      "https://news.example/",
      "document",
      "GET",
    ) {
      NetworkVerdict::Rewrite(url) => {
        assert_eq!(url, "https://www.reddit.com/r/rust?keep=1")
      }
      verdict => panic!("expected rewrite, got {verdict:?}"),
    }
    blocker.record_rewritten_request();
    assert_eq!(blocker.status().rewritten_requests, 1);
  }

  #[test]
  fn follows_each_lists_declared_expiry() {
    assert_eq!(
      declared_refresh_interval("! Expires: 12 hours\n"),
      Duration::from_secs(12 * 60 * 60)
    );
    assert_eq!(
      declared_refresh_interval("[Adblock Plus 2.0]\n! Title: EasyList\n! Expires: 4 days (update frequency)\n"),
      Duration::from_secs(4 * 24 * 60 * 60)
    );
    // Clamped to a sane range; missing headers fall back to the default.
    assert_eq!(
      declared_refresh_interval("! Expires: 1 second\n"),
      MIN_REFRESH_INTERVAL
    );
    assert_eq!(
      declared_refresh_interval("! Expires: 365 days\n"),
      MAX_REFRESH_INTERVAL
    );
    assert_eq!(
      declared_refresh_interval("! Title: No expiry\n"),
      DEFAULT_REFRESH_INTERVAL
    );
    for list in LISTS {
      assert!(
        list
          .bundled
          .lines()
          .take(80)
          .any(|line| line.trim().to_ascii_lowercase().starts_with("! expires:")),
        "{} has no declared expiry",
        list.filename
      );
    }
  }


  /// Guards the shipped snapshots: the engine is built through the same path
  /// the shell uses at startup, then exercised against requests and pages the
  /// bundled lists are expected to cover.
  #[test]
  fn bundled_lists_block_known_advertising_hosts() {
    let directory = std::env::temp_dir().join(format!(
      "govind-adblock-test-{}-{}",
      std::process::id(),
      SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
    ));
    fs::create_dir_all(&directory).expect("temp filter directory");

    let blocker = NetworkBlocker::new();
    blocker
      .rebuild_engine(&directory)
      .expect("build engine from bundled lists");
    let status = blocker.status();
    assert!(status.ready, "engine did not become ready");
    assert_eq!(status.loaded_lists, LISTS.len());

    for (uri, request_type) in [
      ("https://securepubads.g.doubleclick.net/tag/js/gpt.js", "script"),
      ("https://www.google-analytics.com/analytics.js", "script"),
      ("https://www.googletagmanager.com/gtag/js?id=UA-1", "script"),
      ("https://cdn.taboola.com/libtrc/loader.js", "script"),
      ("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "script"),
    ] {
      match blocker.check_request(uri, "https://www.example-news.com/", request_type, "GET") {
        NetworkVerdict::Block | NetworkVerdict::Redirect(_) => {}
        verdict => panic!("{uri} should be blocked, got {verdict:?}"),
      }
    }

    // Ordinary first-party resources must never be caught by the lists.
    assert_eq!(
      blocker.check_request(
        "https://example.com/site.css",
        "https://example.com/",
        "stylesheet",
        "GET",
      ),
      NetworkVerdict::Allow
    );

    let news = blocker
      .page_resources("https://www.cnn.com/")
      .expect("cnn page resources");
    assert!(
      news.hide_selectors.len() > 50,
      "only {} cosmetic selectors for cnn.com",
      news.hide_selectors.len()
    );
    assert!(!news.generichide);
    let generic = blocker.generic_selectors_for_url(
      "https://www.cnn.com/",
      &["ad-slot".to_string()],
      &[],
      &news.exceptions,
    );
    assert!(
      generic.iter().any(|selector| selector.contains("ad-slot")),
      "generic .ad-slot rule did not resolve: {generic:?}"
    );

    // YouTube is only partially covered by these lists: the player rewrites
    // come from uBlock scriptlets, so those must be present and non-trivial.
    let youtube = blocker
      .page_resources("https://www.youtube.com/watch?v=abc")
      .expect("youtube page resources");
    assert!(!youtube.hide_selectors.is_empty());
    assert!(
      youtube.injected_script.contains("jsonPrune"),
      "youtube scriptlets missing ({} bytes)",
      youtube.injected_script.len()
    );

    let _ = fs::remove_dir_all(&directory);
  }

  #[test]
  fn rejects_html_or_wrong_list_responses() {
    assert!(validate_list("<html>error</html>", &LISTS[0]).is_err());
    assert!(validate_list(TEST_LIST, &LISTS[1]).is_err());
  }

  #[test]
  fn bundled_lists_and_resources_are_valid() {
    for list in LISTS {
      validate_list(list.bundled, list).unwrap_or_else(|error| panic!("{error}"));
    }
    let resources = bundled_resources().expect("bundled resources parse");
    assert!(resources.len() >= 190);
    assert!(resources.iter().any(|resource| resource.name == "jsonpath.fn"));
    assert!(resources.iter().any(|resource| resource.name == "noop.js"));
    assert!(resources
      .iter()
      .any(|resource| resource.aliases.iter().any(|alias| alias == "set.js")));
  }
}
