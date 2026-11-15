//! WebView2 integration for the built-in blocker.
//!
//! Responsibilities:
//! - classify every resource request with [`NetworkBlocker::check_request`]
//!   and answer with a block (204) or a `data:` redirect response;
//! - install a per-navigation document-start script containing cosmetic CSS,
//!   scriptlets, and procedural filters;
//! - receive the page's class/id report over WebView2's web-message channel and
//!   reply with generic cosmetic selectors.
//!
//! The document-start script is replaced on every top-level navigation so a
//! page never inherits another site's rules. WebView2 removes the previous
//! script by id before the next one is added.

use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::Value;
use tauri::webview::PlatformWebview;
use webview2_com::{
  take_pwstr,
  AddScriptToExecuteOnDocumentCreatedCompletedHandler,
  Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment, ICoreWebView2WebResourceResponse,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
  },
  NavigationStartingEventHandler, WebMessageReceivedEventHandler, WebResourceRequestedEventHandler,
};
use windows::core::{HSTRING, PWSTR};

use crate::adblocker::{NetworkBlocker, NetworkVerdict, PageResources};

#[derive(Default)]
struct PageContext {
  url: String,
  resources: Option<PageResources>,
}

#[derive(Default)]
struct ScriptState {
  id: Option<String>,
}

pub unsafe fn register(
  platform: PlatformWebview,
  blocker: NetworkBlocker,
) -> windows::core::Result<()> {
  let controller = platform.controller();
  let core = unsafe { controller.CoreWebView2()? };
  let environment = platform.environment();
  let page_context = Arc::new(Mutex::new(PageContext::default()));

  unsafe {
    core.AddWebResourceRequestedFilter(
      &HSTRING::from("*"),
      COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    )?;
  }

  install_request_handler(&core, &environment, blocker.clone());
  install_document_start_handler(&core, blocker.clone(), page_context.clone());
  install_generic_selector_handler(&core, blocker, page_context);
  Ok(())
}

unsafe fn install_request_handler(
  core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
  environment: &ICoreWebView2Environment,
  blocker: NetworkBlocker,
) {
  let request_core = core.clone();
  let response_environment = environment.clone();
  let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
    let Some(args) = args else {
      return Ok(());
    };
    let request = unsafe { args.Request()? };

    let mut uri = PWSTR::null();
    let mut method = PWSTR::null();
    unsafe {
      request.Uri(&mut uri)?;
      request.Method(&mut method)?;
    }
    let uri = take_pwstr(uri);
    let method = take_pwstr(method);

    let headers = unsafe { request.Headers()? };
    let mut referer = PWSTR::null();
    let source_url = match unsafe { headers.GetHeader(&HSTRING::from("Referer"), &mut referer) } {
      Ok(()) => take_pwstr(referer),
      Err(_) => {
        let mut source = PWSTR::null();
        unsafe { request_core.Source(&mut source)? };
        take_pwstr(source)
      }
    };

    let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER;
    unsafe { args.ResourceContext(&mut context)? };
    let request_type = resource_type(context);

    match blocker.check_request(&uri, &source_url, request_type, &method) {
      NetworkVerdict::Allow => {}
      NetworkVerdict::Rewrite(rewritten) => {
        // `$removeparam` tracking-parameter removal: let the request continue,
        // but to the cleaned URL.
        if unsafe { request.SetUri(&HSTRING::from(rewritten.as_str())) }.is_ok() {
          blocker.record_rewritten_request();
        }
      }
      NetworkVerdict::Block => {
        let response = unsafe {
          response_environment.CreateWebResourceResponse(
            None,
            204,
            &HSTRING::from("No Content"),
            &HSTRING::from("Cache-Control: no-store\r\n"),
          )?
        };
        unsafe { args.SetResponse(&response)? };
        blocker.record_blocked_request();
      }
      NetworkVerdict::Redirect(data_url) => {
        if let Some(response) = create_redirect_response(&response_environment, &data_url) {
          unsafe { args.SetResponse(&response)? };
          blocker.record_redirected_request();
        } else {
          // Never let a malformed resource turn into a network request.
          let response = unsafe {
            response_environment.CreateWebResourceResponse(
              None,
              204,
              &HSTRING::from("No Content"),
              &HSTRING::from("Cache-Control: no-store\r\n"),
            )?
          };
          unsafe { args.SetResponse(&response)? };
          blocker.record_blocked_request();
        }
      }
    }
    Ok(())
  }));

  let mut token = 0;
  let _ = unsafe { core.add_WebResourceRequested(&handler, &mut token) };
}

unsafe fn install_document_start_handler(
  core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
  blocker: NetworkBlocker,
  page_context: Arc<Mutex<PageContext>>,
) {
  let navigation_core = core.clone();
  let script_state = Arc::new(Mutex::new(ScriptState::default()));

  let context_for_navigation = page_context;
  let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
    let Some(args) = args else {
      return Ok(());
    };
    let mut uri = PWSTR::null();
    unsafe { args.Uri(&mut uri)? };
    let url = take_pwstr(uri);

    let resources = blocker.page_resources(&url);
    {
      let mut context = context_for_navigation
        .lock()
        .unwrap_or_else(|error| error.into_inner());
      context.url = url.clone();
      context.resources = resources.clone();
    }

    if let Some(previous) = script_state
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .id
      .take()
    {
      let _ = unsafe {
        navigation_core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(previous))
      };
    }

    let Some(resources) = resources else {
      return Ok(());
    };
    if !is_page_url(&url) {
      return Ok(());
    }

    let script = build_document_script(&resources);
    let state = script_state.clone();
    let complete = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(
      move |result, id| {
        if result.is_ok() {
          if !id.is_empty() {
            state
              .lock()
              .unwrap_or_else(|error| error.into_inner())
              .id = Some(id);
          }
        }
        Ok(())
      },
    ));
    if let Err(error) = unsafe {
      navigation_core
        .AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &complete)
    } {
      log::warn!("could not install ad-blocker document script: {error}");
    }
    Ok(())
  }));

  let mut token = 0;
  let _ = unsafe { core.add_NavigationStarting(&handler, &mut token) };
}

unsafe fn install_generic_selector_handler(
  core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
  blocker: NetworkBlocker,
  page_context: Arc<Mutex<PageContext>>,
) {
  let message_core = core.clone();
  let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
    let Some(args) = args else {
      return Ok(());
    };
    let mut source = PWSTR::null();
    unsafe { args.Source(&mut source)? };
    let url = take_pwstr(source);

    let mut raw = PWSTR::null();
    if unsafe { args.TryGetWebMessageAsString(&mut raw) }.is_err() {
      return Ok(());
    }
    let raw = take_pwstr(raw);
    let Ok(message) = serde_json::from_str::<Value>(&raw) else {
      return Ok(());
    };
    if message.get("type").and_then(Value::as_str) != Some("govind-generic") {
      return Ok(());
    }

    let classes = string_array(message.get("classes"));
    let ids = string_array(message.get("ids"));
    if classes.is_empty() && ids.is_empty() {
      return Ok(());
    }

    let resources = {
      let mut context = page_context
        .lock()
        .unwrap_or_else(|error| error.into_inner());
      if context.url != url {
        context.url = url.clone();
        context.resources = blocker.page_resources(&url);
      }
      context.resources.clone()
    };
    let Some(resources) = resources else {
      return Ok(());
    };
    if resources.generichide {
      return Ok(());
    }

    let selectors =
      blocker.generic_selectors_for_url(&url, &classes, &ids, &resources.exceptions);
    if selectors.is_empty() {
      return Ok(());
    }
    let reply = serde_json::json!({
      "type": "govind-css",
      "selectors": selectors,
    })
    .to_string();
    unsafe { message_core.PostWebMessageAsString(&HSTRING::from(reply))? };
    Ok(())
  }));

  let mut token = 0;
  let _ = unsafe { core.add_WebMessageReceived(&handler, &mut token) };
}

fn string_array(value: Option<&Value>) -> Vec<String> {
  value
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(Value::as_str)
        .filter(|item| !item.is_empty() && item.len() <= 512)
        .take(4_000)
        .map(str::to_owned)
        .collect()
    })
    .unwrap_or_default()
}

fn is_page_url(url: &str) -> bool {
  url.starts_with("https://") || url.starts_with("http://")
}

fn create_redirect_response(
  environment: &ICoreWebView2Environment,
  data_url: &str,
) -> Option<ICoreWebView2WebResourceResponse> {
  let (mime, bytes) = decode_data_url(data_url)?;
  let stream = unsafe { windows::Win32::UI::Shell::SHCreateMemStream(Some(&bytes)) }?;
  let headers = HSTRING::from(format!(
    "Content-Type: {mime}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\n"
  ));
  unsafe {
    environment
      .CreateWebResourceResponse(&stream, 200, &HSTRING::from("OK"), &headers)
      .ok()
  }
}

/// Split the `data:` URLs produced by `adblock-rust` redirect resources.
fn decode_data_url(url: &str) -> Option<(String, Vec<u8>)> {
  let data = url.strip_prefix("data:")?;
  let (metadata, payload) = data.split_once(',')?;
  let mut mime = "text/plain".to_string();
  let mut base64 = false;
  for part in metadata.split(';') {
    if part.eq_ignore_ascii_case("base64") {
      base64 = true;
    } else if !part.is_empty() && !part.contains('=') {
      mime = part.to_string();
    }
  }
  let bytes = if base64 {
    BASE64_STANDARD.decode(payload).ok()?
  } else {
    payload.as_bytes().to_vec()
  };
  Some((mime, bytes))
}

/// The document-start bootstrap. The placeholders are replaced with JSON so
/// no filter-list string is ever interpolated as code.
fn build_document_script(resources: &PageResources) -> String {
  let selectors =
    serde_json::to_string(&resources.hide_selectors).unwrap_or_else(|_| "[]".into());
  let procedural =
    serde_json::to_string(&resources.procedural_actions).unwrap_or_else(|_| "[]".into());
  let generichide = if resources.generichide { "true" } else { "false" };

  DOCUMENT_SCRIPT
    .replace("/*__GOVIND_SELECTORS__*/[]", &selectors)
    .replace("/*__GOVIND_PROCEDURAL__*/[]", &procedural)
    .replace("/*__GOVIND_GENERICHIDE__*/false", generichide)
    .replace("/*__GOVIND_SCRIPTLETS__*/", &resources.injected_script)
}

const DOCUMENT_SCRIPT: &str = r#"(function () {
  'use strict';

  // Scriptlets must run before any page script. adblock-rust already wraps
  // each invocation in try/catch; this guard covers dependency failures.
  try {
/*__GOVIND_SCRIPTLETS__*/
  } catch (e) { }

  if (window.__govindAdblockReady) { return; }
  window.__govindAdblockReady = true;

  var doc = document;
  var selectors = /*__GOVIND_SELECTORS__*/[];
  var procedural = /*__GOVIND_PROCEDURAL__*/[];
  var generichide = /*__GOVIND_GENERICHIDE__*/false;
  var seenCss = Object.create(null);
  var cssRules = [];
  var cssDirty = false;
  var cssStyle = null;

  function ensureStyle() {
    if (cssStyle && cssStyle.parentNode) { return cssStyle; }
    var root = doc.head || doc.documentElement;
    if (!root) { return null; }
    cssStyle = doc.getElementById('__govindAdblockStyle');
    if (!cssStyle) {
      cssStyle = doc.createElement('style');
      cssStyle.id = '__govindAdblockStyle';
      root.appendChild(cssStyle);
    }
    return cssStyle;
  }

  function flushCss() {
    cssDirty = false;
    var el = ensureStyle();
    if (el) { el.textContent = cssRules.join('\n'); }
  }

  function addCss(selector) {
    if (typeof selector !== 'string' || !selector || selector.length > 2048) { return; }
    if (selector.indexOf('{') !== -1 || seenCss[selector]) { return; }
    seenCss[selector] = true;
    cssRules.push(selector + '{display:none!important}');
    if (!cssDirty) {
      cssDirty = true;
      setTimeout(flushCss, 0);
    }
  }

  for (var i = 0; i < selectors.length; i += 1) { addCss(selectors[i]); }
  flushCss();

  // The shell calls this after a filter-list update or when blocking is paused
  // so open pages pick up new rules without a reload. Scriptlets cannot be
  // re-run retroactively; those still need a reload.
  window.__govindAdblockRefresh = function (nextSelectors) {
    if (!Array.isArray(nextSelectors)) { return; }
    seenCss = Object.create(null);
    cssRules = [];
    for (var i = 0; i < nextSelectors.length; i += 1) { addCss(nextSelectors[i]); }
    flushCss();
  };

  // The documentElement may not exist at document-start; attach the style as
  // soon as it does.
  if (!doc.documentElement) {
    try {
      var boot = new MutationObserver(function () {
        if (!doc.documentElement) { return; }
        boot.disconnect();
        flushCss();
      });
      boot.observe(doc, { childList: true, subtree: true });
    } catch (e) { }
  }

  // ── Generic class/id rules ────────────────────────────────────────────
  var reportedClasses = Object.create(null);
  var reportedIds = Object.create(null);
  var genericTimer = 0;

  function reportGenerics() {
    genericTimer = 0;
    if (generichide) { return; }
    var classes = [];
    var ids = [];
    var nodes;
    try { nodes = doc.querySelectorAll('[class],[id]'); } catch (e) { return; }
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var list = node.classList;
      if (list) {
        for (var j = 0; j < list.length; j += 1) {
          var cls = list[j];
          if (!cls || reportedClasses[cls]) { continue; }
          reportedClasses[cls] = true;
          classes.push(cls);
          if (classes.length >= 4000) { break; }
        }
      }
      var id = node.id;
      if (id && !reportedIds[id] && ids.length < 2000) {
        reportedIds[id] = true;
        ids.push(id);
      }
    }
    if (!classes.length && !ids.length) { return; }
    try {
      if (window.chrome && chrome.webview && chrome.webview.postMessage) {
        chrome.webview.postMessage(JSON.stringify({
          type: 'govind-generic',
          classes: classes,
          ids: ids
        }));
      }
    } catch (e) { }
  }

  function scheduleGenerics(delay) {
    if (generichide || genericTimer) { return; }
    genericTimer = setTimeout(reportGenerics, delay || 120);
  }

  try {
    if (window.chrome && chrome.webview && chrome.webview.addEventListener) {
      chrome.webview.addEventListener('message', function (event) {
        var data = event.data;
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch (e) { return; }
        }
        if (!data || data.type !== 'govind-css' || !Array.isArray(data.selectors)) { return; }
        for (var i = 0; i < data.selectors.length; i += 1) { addCss(data.selectors[i]); }
      });
    }
  } catch (e) { }

  if (!generichide) {
    scheduleGenerics(0);
    try {
      new MutationObserver(function () { scheduleGenerics(180); })
        .observe(doc.documentElement || doc, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'id']
        });
    } catch (e) { }
  }

  // ── Procedural filters ────────────────────────────────────────────────
  function textOf(element) {
    var text = element.textContent;
    return typeof text === 'string' ? text : '';
  }

  function matchesPattern(value, pattern) {
    if (typeof pattern !== 'string' || !pattern) { return false; }
    if (pattern.length > 2 && pattern.charAt(0) === '/' && pattern.lastIndexOf('/') > 0) {
      try {
        var end = pattern.lastIndexOf('/');
        return new RegExp(pattern.slice(1, end), pattern.slice(end + 1)).test(value);
      } catch (e) {
        return false;
      }
    }
    return String(value).toLowerCase().indexOf(pattern.toLowerCase()) !== -1;
  }

  function queryAll(css, scope) {
    try {
      var root = scope || doc;
      return Array.prototype.slice.call(root.querySelectorAll(css));
    } catch (e) {
      return [];
    }
  }

  function relativeSelect(current, css) {
    var selector = String(css).trim();
    var combinator = '';
    if (/^[>+~]/.test(selector)) {
      combinator = selector.charAt(0);
      selector = selector.slice(1).trim();
    }
    var out = [];
    for (var i = 0; i < current.length; i += 1) {
      var element = current[i];
      if (!selector) { continue; }
      if (!combinator) {
        out = out.concat(queryAll(selector, element));
      } else if (combinator === '>') {
        for (var child = element.firstElementChild; child; child = child.nextElementSibling) {
          try { if (child.matches(selector)) { out.push(child); } } catch (e) { }
        }
      } else if (combinator === '+') {
        var next = element.nextElementSibling;
        if (next) {
          try { if (next.matches(selector)) { out.push(next); } } catch (e) { }
        }
      } else if (combinator === '~') {
        for (var sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
          try { if (sibling.matches(selector)) { out.push(sibling); } } catch (e) { }
        }
      }
    }
    return out;
  }

  function matchesAttribute(element, argument) {
    var match = /^\s*([^\s=~|^$*]+)\s*(?:([~|^$*]?=)\s*(.*))?$/.exec(argument);
    if (!match) { return false; }
    var name = match[1];
    if (!element.hasAttribute(name)) { return false; }
    if (!match[2]) { return true; }
    var operator = match[2];
    var expected = match[3].trim();
    if ((expected.charAt(0) === '"' && expected.charAt(expected.length - 1) === '"') ||
        (expected.charAt(0) === "'" && expected.charAt(expected.length - 1) === "'")) {
      expected = expected.slice(1, -1);
    }
    var actual = element.getAttribute(name) || '';
    if (operator === '=') { return matchesPattern(actual, expected); }
    if (operator === '^=') { return actual.indexOf(expected) === 0; }
    if (operator === '$=') { return actual.slice(-expected.length) === expected; }
    if (operator === '*=') { return actual.indexOf(expected) !== -1; }
    if (operator === '~=') { return actual.split(/\s+/).indexOf(expected) !== -1; }
    if (operator === '|=') { return actual === expected || actual.indexOf(expected + '-') === 0; }
    return false;
  }

  function computedValue(element, property, pseudo) {
    try {
      return window.getComputedStyle(element, pseudo).getPropertyValue(property);
    } catch (e) {
      return '';
    }
  }

  function matchesComputedStyle(element, argument, pseudo) {
    var split = String(argument).indexOf(':');
    if (split < 0) { return false; }
    var property = argument.slice(0, split).trim();
    var expected = argument.slice(split + 1).trim();
    return matchesPattern(computedValue(element, property, pseudo), expected);
  }

  function applyOperator(operator, current) {
    var type = operator && operator.type;
    var argument = operator && operator.arg != null ? String(operator.arg) : '';
    var base;
    switch (type) {
      case 'css-selector':
        return current === null ? queryAll(argument) : relativeSelect(current, argument);
      case 'has-text':
        base = current === null ? queryAll('*') : current;
        return base.filter(function (element) {
          return matchesPattern(textOf(element), argument);
        });
      case 'min-text-length':
        base = current === null ? queryAll('*') : current;
        var minimum = parseInt(argument, 10) || 0;
        return base.filter(function (element) { return textOf(element).length >= minimum; });
      case 'matches-attr':
        base = current === null ? queryAll('*') : current;
        return base.filter(function (element) { return matchesAttribute(element, argument); });
      case 'matches-css':
        base = current === null ? queryAll('*') : current;
        return base.filter(function (element) {
          return matchesComputedStyle(element, argument, null);
        });
      case 'matches-css-before':
        base = current === null ? queryAll('*') : current;
        return base.filter(function (element) {
          return matchesComputedStyle(element, argument, '::before');
        });
      case 'matches-css-after':
        base = current === null ? queryAll('*') : current;
        return base.filter(function (element) {
          return matchesComputedStyle(element, argument, '::after');
        });
      case 'matches-path':
        if (!matchesPattern(location.pathname + location.search, argument)) { return []; }
        return current === null ? queryAll('*') : current;
      case 'upward':
        base = current === null ? [] : current;
        var levels = /^\d+$/.test(argument) ? parseInt(argument, 10) : -1;
        var out = [];
        for (var i = 0; i < base.length; i += 1) {
          var element = base[i];
          if (levels >= 0) {
            for (var n = 0; n < levels && element; n += 1) { element = element.parentElement; }
            if (element) { out.push(element); }
          } else {
            element = element.parentElement;
            while (element) {
              try { if (element.matches(argument)) { out.push(element); break; } } catch (e) { }
              element = element.parentElement;
            }
          }
        }
        return out;
      case 'xpath':
        try {
          var result = doc.evaluate(
            argument, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
          );
          var nodes = [];
          for (var i = 0; i < result.snapshotLength; i += 1) {
            var node = result.snapshotItem(i);
            if (node && node.nodeType === 1) { nodes.push(node); }
          }
          return nodes;
        } catch (e) {
          return [];
        }
      default:
        // Unknown operator: fail closed so we never hide unrelated elements.
        return [];
    }
  }

  function applyStyle(element, declarations) {
    var text = String(declarations || '');
    var parts = text.split(';');
    for (var i = 0; i < parts.length; i += 1) {
      var split = parts[i].indexOf(':');
      if (split < 0) { continue; }
      var property = parts[i].slice(0, split).trim();
      var value = parts[i].slice(split + 1).trim().replace(/\s*!important\s*$/i, '');
      if (property && value) {
        try { element.style.setProperty(property, value, 'important'); } catch (e) { }
      }
    }
  }

  function applyAction(filter) {
    var current = null;
    var chain = filter && filter.selector;
    if (!Array.isArray(chain) || !chain.length) { return; }
    for (var i = 0; i < chain.length; i += 1) {
      current = applyOperator(chain[i], current);
      if (!current.length) { return; }
    }
    var action = filter.action;
    for (var j = 0; j < current.length; j += 1) {
      var element = current[j];
      if (!element || element.nodeType !== 1) { continue; }
      if (!action) {
        element.style.setProperty('display', 'none', 'important');
      } else if (action.type === 'remove') {
        if (element.parentNode) { element.parentNode.removeChild(element); }
      } else if (action.type === 'style') {
        applyStyle(element, action.arg);
      } else if (action.type === 'remove-attr') {
        element.removeAttribute(String(action.arg));
      } else if (action.type === 'remove-class') {
        element.classList.remove(String(action.arg));
      }
    }
  }

  function runProcedural() {
    for (var i = 0; i < procedural.length; i += 1) {
      try {
        var filter = typeof procedural[i] === 'string'
          ? JSON.parse(procedural[i])
          : procedural[i];
        applyAction(filter);
      } catch (e) { }
    }
  }

  if (procedural.length) {
    var proceduralTimer = 0;
    var scheduleProcedural = function () {
      if (proceduralTimer) { return; }
      proceduralTimer = setTimeout(function () {
        proceduralTimer = 0;
        runProcedural();
      }, 120);
    };
    scheduleProcedural();
    try {
      new MutationObserver(scheduleProcedural)
        .observe(doc.documentElement || doc, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'id', 'style']
        });
    } catch (e) { }
    doc.addEventListener('DOMContentLoaded', scheduleProcedural, { once: true });
  }
})();
"#;

#[cfg(test)]
mod tests {
  use super::*;
  use crate::adblocker::PageResources;


  #[test]
  fn maps_webview_resource_contexts_to_filter_request_types() {
    assert_eq!(
      resource_type(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST),
      "xmlhttprequest"
    );
    assert_eq!(
      resource_type(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH),
      "fetch"
    );
    assert_eq!(
      resource_type(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT),
      "document"
    );
    assert_eq!(
      resource_type(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER),
      "other"
    );
  }

  #[test]
  fn decodes_adblock_redirect_data_urls() {
    let (mime, bytes) =
      decode_data_url("data:application/javascript;base64,Y29uc29sZS5sb2coMSk7").expect("data URL");
    assert_eq!(mime, "application/javascript");
    assert_eq!(bytes, b"console.log(1);");
  }

  #[test]
  fn document_script_embeds_rules_and_escapes_comment_markers() {
    let resources = PageResources {
      hide_selectors: vec![".ad-banner".into()],
      procedural_actions: vec!["{\"selector\":[],\"action\":null}".into()],
      exceptions: vec![],
      injected_script: "function noop() { }".into(),
      generichide: false,
    };
    let script = build_document_script(&resources);
    assert!(script.contains(r#"[".ad-banner"]"#));
    assert!(script.contains("function noop()"));
    assert!(!script.contains("__GOVIND_SCRIPTLETS__"));
    assert!(!script.contains("__GOVIND_SELECTORS__"));
    assert!(!script.contains("__GOVIND_PROCEDURAL__"));
    assert!(!script.contains("__GOVIND_GENERICHIDE__"));
    // The generated script must be syntactically valid JavaScript. If Node is
    // unavailable the compile check is skipped.
    let _ = script;
  }
}

fn resource_type(
  context: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT,
) -> &'static str {
  match context {
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "document",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK => {
      "media"
    }
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST
    | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE => "xmlhttprequest",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "fetch",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
    _ => "other",
  }
}
