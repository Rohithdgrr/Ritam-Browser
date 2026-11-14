//! Tab webview management — the browser core.
//!
//! Every tab owns one **child webview** that lives inside the main window
//! (`Window::add_child`, Tauri 2 `unstable` feature) and is positioned over the
//! shell's web-content region. Switching tabs shows/hides those views, so the
//! whole browser is a single native window: no stray taskbar entries, no
//! focus traps between windows, and page state survives tab switches.
//!
//! Security: a child webview inherits the parent window's label, but Tauri's
//! ACL only grants the app's commands to *local* origins — a remote page can
//! never invoke a single Govind command (see `capabilities/default.json`).
//!
//! Windows note: creating a WebView2 controller from inside a webview message
//! handler deadlocks, so every command that creates a webview is `async` and
//! runs on Tauri's async runtime instead of the UI thread.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde_json::json;
use tauri::{
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl,
};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};

use crate::db::DbState;
use crate::error::AppError;

/// Region of the main window (client-area coordinates) covered by the webview.
#[derive(Debug, Clone)]
pub struct LayoutState {
  pub offset_x: f64,
  pub offset_y: f64,
  pub width: f64,
  pub height: f64,
  /// false → the shell shows a non-browser view (home, settings …): hide every webview.
  pub visible: bool,
  pub active: Option<String>,
}

impl Default for LayoutState {
  fn default() -> Self {
    Self {
      offset_x: 0.0,
      offset_y: 80.0,
      width: 1000.0,
      height: 700.0,
      visible: false,
      active: None,
    }
  }
}

/// Real page favicons: after a page finishes loading, this tiny script briefly
/// replaces the document title with the favicon URL — the only channel a
/// remote page has to reach us (it gets no IPC access).
/// WebView2 strips control characters from delivered titles, so the probe
/// result is recognized by *shape* in the title handler (an absolute URL),
/// not by a marker: `on_document_title_changed` reports it as a favicon and
/// never persists it as the tab title.
const FAVICON_PROBE_JS: &str = r#"
(function () {
  var link = document.querySelector('link[rel~="icon"]');
  document.title = (link && link.href) || location.origin + '/favicon.ico';
})();
"#;

const READER_MODE_JS: &str = r#"
(function (enabled) {
  var d = document;
  var original = window.__govindReaderOriginal;
  if (!enabled && original) {
    d.documentElement.replaceChild(original, d.body);
    delete window.__govindReaderOriginal;
    d.getElementById('__govindReaderStyle')?.remove();
    return true;
  }
  if (!enabled || original) return false;

  var source = d.querySelector('article, main, [role="main"]') || d.body;
  var body = d.createElement('body');
  var article = d.createElement('article');
  var heading = d.createElement('h1');
  heading.textContent = d.title;
  article.appendChild(heading);
  var nodes = source.querySelectorAll('h2, h3, p, blockquote, li');
  for (var i = 0; i < nodes.length && article.childElementCount < 120; i++) {
    var node = nodes[i];
    var text = (node.innerText || node.textContent || '').trim();
    if (text.length < 35) continue;
    var tag = /^(H2|H3|BLOCKQUOTE)$/.test(node.tagName) ? node.tagName.toLowerCase() : 'p';
    var block = d.createElement(tag);
    block.textContent = text.slice(0, 10000);
    article.appendChild(block);
  }
  if (article.childElementCount < 2) return false;

  window.__govindReaderOriginal = d.body;
  body.appendChild(article);
  d.documentElement.replaceChild(body, d.body);
  var style = d.createElement('style');
  style.id = '__govindReaderStyle';
  style.textContent = 'body{margin:0!important;background:#f7f5f0!important;color:#292821!important;font:18px/1.75 Georgia,serif!important}article{max-width:720px;margin:48px auto;padding:0 24px}h1{font:600 36px/1.2 Georgia,serif;margin:0 0 32px}h2{font-size:25px;margin-top:32px}h3{font-size:21px}p,blockquote{margin:0 0 1.4em}';
  d.head.appendChild(style);
  return true;
})(__ENABLED__);
"#;

const PAGE_FEATURES_JS: &str = r#"
(function () {
  var d = document, muted = __INITIAL_MUTED__, contexts = new Set(), pipVideo = null, pipButton, lastAudioState = null;
  __PASSWORD_GENERATOR__
  function titleSignal(value) {
    var previous = d.title;
    d.title = value;
    setTimeout(function () { if (d.title === value) d.title = previous; }, 40);
  }
  function audioState() {
    var playing = Array.from(d.querySelectorAll('audio,video')).some(function (m) {
      return !m.paused && !m.ended;
    }) || Array.from(contexts).some(function (context) { return context.state === 'running'; })
      || !!(window.speechSynthesis && window.speechSynthesis.speaking);
    var state = (playing ? '1' : '0') + ':' + (muted ? '1' : '0');
    if (state === lastAudioState) return;
    lastAudioState = state;
    titleSignal('__GOVIND_AUDIO__:' + state);
  }
  function setMediaMuted(media) {
    if (muted) {
      if (!Object.prototype.hasOwnProperty.call(media, '__govindWasMuted')) {
        media.__govindWasMuted = media.muted;
      }
      media.muted = true;
    } else if (Object.prototype.hasOwnProperty.call(media, '__govindWasMuted')) {
      media.muted = media.__govindWasMuted;
      delete media.__govindWasMuted;
    }
  }
  window.__govindSetMuted = function (value) {
    muted = !!value;
    if (muted && window.__govindReadStop) window.__govindReadStop();
    d.querySelectorAll('audio,video').forEach(setMediaMuted);
    contexts.forEach(function (context) {
      var method = muted ? 'suspend' : 'resume';
      if (typeof context[method] === 'function') context[method]().catch(function () {});
    });
    audioState();
  };
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Original = window[name];
    if (!Original) return;
    try {
      window[name] = new Proxy(Original, {
        construct: function (target, args, newTarget) {
          var context = Reflect.construct(target, args, newTarget);
          contexts.add(context);
          context.addEventListener('statechange', audioState);
          if (muted) context.suspend().catch(function () {});
          audioState();
          return context;
        }
      });
    } catch (_) {}
  });
  d.addEventListener('playing', audioState, true);
  d.addEventListener('pause', audioState, true);
  d.addEventListener('ended', audioState, true);
  d.addEventListener('volumechange', audioState, true);
  function setupDocument() {
    if (!d.documentElement) {
      d.addEventListener('DOMContentLoaded', setupDocument, { once: true });
      return;
    }
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (muted) {
            if (node.matches && node.matches('audio,video')) setMediaMuted(node);
            node.querySelectorAll && node.querySelectorAll('audio,video').forEach(setMediaMuted);
          }
          if (spellcheckOn) {
            var mark = function (el) { if (!el.hasAttribute('spellcheck')) el.setAttribute('spellcheck', 'true'); };
            if (node.matches && node.matches('input, textarea, [contenteditable="true"]')) mark(node);
            node.querySelectorAll && node.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(mark);
          }
        });
      });
    }).observe(d.documentElement, { childList: true, subtree: true });
    applySpellcheck();

    window.__govindForceDark = function (enabled) {
      var id = '__govindForcedDarkStyle', style = d.getElementById(id);
      if (!enabled) { if (style) style.remove(); return; }
      if (!style) { style = d.createElement('style'); style.id = id; (d.head || d.documentElement).appendChild(style); }
      var bg = getComputedStyle(d.body || d.documentElement).backgroundColor;
      var rgb = bg.match(/\d+/g);
      var alpha = rgb && rgb.length > 3 ? Number(rgb[3]) : 1;
      var light = !rgb || alpha === 0 || Number(rgb[0]) * .299 + Number(rgb[1]) * .587 + Number(rgb[2]) * .114 > 145;
      style.textContent = 'html{color-scheme:dark!important}' +
        (light ? 'html{filter:invert(1) hue-rotate(180deg)!important;background:#111!important}' +
          'img,video,canvas,iframe,svg{filter:invert(1) hue-rotate(180deg)!important}' : '');
    };

    window.__govindSetDnt = function (enabled) {
      try {
        Object.defineProperty(navigator, 'doNotTrack', {
          get: function () { return enabled ? '1' : '0'; },
          configurable: true,
        });
      } catch (_) {}
    };
    window.__govindSetDnt(false);

    // Spell check: mark editable elements so the engine underlines misspellings.
    var spellcheckOn = true;
    function applySpellcheck() {
      d.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(function (el) {
        if (spellcheckOn) {
          if (!el.hasAttribute('spellcheck')) el.setAttribute('spellcheck', 'true');
        } else {
          el.setAttribute('spellcheck', 'false');
        }
      });
    }
    window.__govindSetSpellcheck = function (enabled) {
      spellcheckOn = !!enabled;
      applySpellcheck();
    };

    // Cosmetic content blocking: one `display:none` rule per user selector.
    window.__govindSetCosmetic = function (css) {
      var id = '__govindCosmeticStyle', style = d.getElementById(id);
      if (!css) { if (style) style.remove(); return; }
      if (!style) {
        style = d.createElement('style');
        style.id = id;
        (d.head || d.documentElement).appendChild(style);
      }
      style.textContent = String(css).split('\n')
        .map(function (s) { return s.trim(); })
        .filter(Boolean)
        .map(function (s) { return s + '{display:none!important}'; })
        .join('\n');
    };

    // ── Form autofill ──────────────────────────────────────────────────
    // Profiles arrive as a JSON array (stored in settings, entered by the
    // user). On focus of a recognisable field we offer the saved profiles in
    // a small dropdown; choosing one fills every detectable field.
    var autofillProfiles = [];
    var FIELD_KEYS = [
      ['cc-number', /cc-?number|card.?num|cardnumber/i],
      ['cc-csc', /cc-?csc|cvc|cvv|security.?code/i],
      ['cc-expiry', /cc-?exp|expiry|expiration/i],
      ['card_name', /cc-?name/i],
      ['email', /e-?mail/i],
      ['phone', /tel|phone|mobile/i],
      ['postal_code', /postal|zip|postcode/i],
      ['country', /country/i],
      ['address_line2', /address.?line.?2|apt|suite/i],
      ['city', /city|address.?level.?2|locality/i],
      ['region', /state|province|region|address.?level.?1/i],
      ['address_line1', /street|address.?line.?1|address1/i],
      ['full_name', /name|fullname/i],
    ];
    var PROFILE_LABELS = {
      full_name: 'Full name', email: 'Email', phone: 'Phone',
      address_line1: 'Address line 1', address_line2: 'Address line 2',
      city: 'City', region: 'State / region', postal_code: 'Postal code',
      country: 'Country', card_name: 'Name on card', card_number: 'Card number',
      card_expiry: 'Card expiry', card_csc: 'Security code',
    };
    function fieldKey(el) {
      var hay = [el.getAttribute && el.getAttribute('autocomplete'), el.name, el.id,
        el.getAttribute && el.getAttribute('placeholder'), el.getAttribute && el.getAttribute('aria-label')]
        .filter(Boolean).join(' ');
      for (var i = 0; i < FIELD_KEYS.length; i++) {
        if (FIELD_KEYS[i][1].test(hay)) return FIELD_KEYS[i][0];
      }
      return null;
    }
    function profileLabel(p) {
      return p.full_name || p.email || p.card_name || 'Saved profile';
    }
    function fillField(el, value) {
      if (value === undefined || value === null || value === '') return;
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function hidePasswordGenerator() {
      if (passwordGeneratorBox) { passwordGeneratorBox.remove(); passwordGeneratorBox = null; }
    }
    function showPasswordGenerator(target) {
      hideAutofill();
      hidePasswordGenerator();
      if (!target || !target.isConnected) return;
      var rect = target.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      passwordGeneratorBox = d.createElement('div');
      passwordGeneratorBox.setAttribute('role', 'group');
      passwordGeneratorBox.style.cssText = 'position:fixed;z-index:2147483647;background:#fff;color:#1c1c1e;' +
        'border:1px solid #d0d0d5;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.22);' +
        'font:13px/1.4 system-ui,sans-serif;padding:4px';
      var button = d.createElement('button');
      button.type = 'button';
      button.textContent = 'Generate strong password';
      button.setAttribute('aria-label', 'Generate and fill a strong password');
      button.style.cssText = 'border:0;border-radius:5px;background:transparent;color:inherit;' +
        'cursor:pointer;font:inherit;padding:8px 10px;text-align:left;width:100%';
      button.addEventListener('mousedown', function (event) { event.preventDefault(); });
      button.addEventListener('click', function () {
        if (!target.isConnected || (target.value && !window.confirm('Replace the current password?'))) return;
        try {
          fillField(target, generateStrongPassword());
          hidePasswordGenerator();
        } catch (_) {
          button.textContent = 'Secure password generation unavailable';
          button.disabled = true;
        }
      });
      passwordGeneratorBox.appendChild(button);
      d.documentElement.appendChild(passwordGeneratorBox);
      var boxRect = passwordGeneratorBox.getBoundingClientRect();
      passwordGeneratorBox.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - boxRect.width - 8)) + 'px';
      passwordGeneratorBox.style.top = (rect.bottom + boxRect.height + 8 > window.innerHeight
        ? Math.max(4, rect.top - boxRect.height - 4)
        : rect.bottom + 4) + 'px';
    }
    var autofillBox = null, autofillFor = null, passwordGeneratorBox = null;
    function hideAutofill() {
      if (autofillBox) { autofillBox.remove(); autofillBox = null; }
      autofillFor = null;
    }
    function showAutofill(target) {
      hideAutofill();
      if (!autofillProfiles.length || !target || !target.isConnected) return;
      var scope = target.form || d;
      var rect = target.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      autofillBox = d.createElement('div');
      autofillBox.setAttribute('role', 'listbox');
      autofillBox.style.cssText = 'position:fixed;z-index:2147483647;min-width:200px;max-width:320px;' +
        'background:#fff;color:#1c1c1e;border:1px solid #d0d0d5;border-radius:8px;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.22);font:13px/1.4 system-ui,sans-serif;overflow:hidden';
      autofillProfiles.forEach(function (profile, idx) {
        var row = d.createElement('button');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.textContent = profileLabel(profile);
        row.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 12px;border:0;' +
          'background:transparent;cursor:pointer;font:inherit;color:inherit';
        row.addEventListener('mouseenter', function () { row.style.background = '#f0f0f4'; });
        row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });
        row.addEventListener('mousedown', function (e) { e.preventDefault(); });
        row.addEventListener('click', function () {
          scope.querySelectorAll('input, textarea, select').forEach(function (el) {
            var key = fieldKey(el);
            if (key && profile[key]) fillField(el, profile[key]);
          });
          // Also fill the focused field directly if it had no form match.
          var focusedKey = fieldKey(d.activeElement);
          if (focusedKey && profile[focusedKey] && !scope.contains(d.activeElement)) {
            fillField(d.activeElement, profile[focusedKey]);
          }
          hideAutofill();
        });
        autofillBox.appendChild(row);
      });
      autofillFor = target;
      d.documentElement.appendChild(autofillBox);
      var boxRect = autofillBox.getBoundingClientRect();
      autofillBox.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - boxRect.width - 8)) + 'px';
      autofillBox.style.top = (rect.bottom + 4 > window.innerHeight - boxRect.height - 8
        ? Math.max(4, rect.top - boxRect.height - 4)
        : rect.bottom + 4) + 'px';
    }
    d.addEventListener('focusin', function (event) {
      var el = event.target;
      if (!el || !el.matches || !el.matches('input, textarea, select')) return;
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') { showPasswordGenerator(el); return; }
      hidePasswordGenerator();
      if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image'].indexOf(type) !== -1) return;
      if (!fieldKey(el)) { hideAutofill(); return; }
      showAutofill(el);
    }, true);
    d.addEventListener('focusout', function (event) {
      if (autofillBox && !autofillBox.contains(event.relatedTarget)) hideAutofill();
      if (passwordGeneratorBox && !passwordGeneratorBox.contains(event.relatedTarget)) hidePasswordGenerator();
    }, true);
    d.addEventListener('scroll', function () { hideAutofill(); hidePasswordGenerator(); }, true);
    window.addEventListener('resize', function () { hideAutofill(); hidePasswordGenerator(); });
    d.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { hideAutofill(); hidePasswordGenerator(); }
    }, true);
    window.__govindSetAutofill = function (json) {
      try {
        var parsed = JSON.parse(json || '[]');
        autofillProfiles = Array.isArray(parsed) ? parsed.slice(0, 50) : [];
      } catch (_) { autofillProfiles = []; }
      hideAutofill();
    };

    window.__govindReadAloud = function () {
      var synth = window.speechSynthesis;
      if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
        titleSignal('__GOVIND_NOTICE__:Read Aloud is unavailable in this webview.');
        return false;
      }
      if (window.__govindReadStop) {
        window.__govindReadStop();
        return false;
      }
      var nodes = [], parts = [], length = 0, lastBlock = null;
      var walker = d.createTreeWalker(d.body || d.documentElement, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode()) && length < 30000) {
        var parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,svg,button,input,textarea,select,[aria-hidden="true"]')) continue;
        var style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        var value = node.nodeValue || '';
        if (!value.trim()) continue;
        var block = parent.closest('address,article,blockquote,dd,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,li,main,nav,ol,p,pre,section,table,td,th,ul') || parent;
        if (nodes.length && block !== lastBlock && !/\s$/.test(parts[parts.length - 1])) {
          parts.push('\n');
          length++;
        }
        lastBlock = block;
        var available = Math.min(value.length, 30000 - length);
        nodes.push({ node: node, start: length, end: length + available });
        parts.push(value.slice(0, available));
        length += available;
      }
      var text = parts.join('');
      if (!text.trim()) {
        titleSignal('__GOVIND_NOTICE__:No readable page text was found.');
        return false;
      }
      var styleNode = d.createElement('style');
      styleNode.textContent = '::highlight(govind-read-aloud){background:#ffe27a;color:#171717}';
      (d.head || d.documentElement).appendChild(styleNode);
      var utterance = new SpeechSynthesisUtterance(text);
      window.__govindReadUtterance = utterance;
      function clear() {
        if (window.__govindReadUtterance !== utterance) return;
        window.__govindReadUtterance = null;
        window.__govindReadStop = null;
        if (window.CSS && CSS.highlights) CSS.highlights.delete('govind-read-aloud');
        styleNode.remove();
        d.removeEventListener('visibilitychange', stopWhenHidden);
        audioState();
      }
      window.__govindReadStop = function () {
        synth.cancel();
        clear();
      };
      function stopWhenHidden() {
        if (!d.hidden || window.__govindReadUtterance !== utterance) return;
        synth.cancel();
        clear();
      }
      utterance.onboundary = function (event) {
        if (!window.CSS || !CSS.highlights || typeof window.Highlight !== 'function') return;
        var start = Math.max(0, event.charIndex || 0);
        while (start < text.length && /\s/.test(text[start])) start++;
        var end = start;
        while (end < text.length && !/\s/.test(text[end])) end++;
        if (start === end) return;
        var first = nodes.find(function (item) { return item.start <= start && item.end > start; });
        var last = nodes.find(function (item) { return item.start < end && item.end >= end; });
        if (!first || !last) return;
        try {
          var range = d.createRange();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          CSS.highlights.set('govind-read-aloud', new Highlight(range));
        } catch (_) {}
      };
      utterance.onend = clear;
      utterance.onerror = clear;
      utterance.onstart = audioState;
      d.addEventListener('visibilitychange', stopWhenHidden);
      try { synth.speak(utterance); }
      catch (_) {
        clear();
        titleSignal('__GOVIND_NOTICE__:Speech could not be started.');
        return false;
      }
      return true;
    };

    function enterPip(video) {
      if (!video || !video.requestPictureInPicture) {
        titleSignal('__GOVIND_NOTICE__:Picture-in-Picture is unavailable for this video.');
        return;
      }
      try {
        video.requestPictureInPicture().catch(function () {
          titleSignal('__GOVIND_NOTICE__:Could not open Picture-in-Picture for this video.');
        });
      } catch (_) {
        titleSignal('__GOVIND_NOTICE__:Could not open Picture-in-Picture for this video.');
      }
    }
    pipButton = d.createElement('button');
    pipButton.type = 'button';
    pipButton.textContent = 'PiP';
    pipButton.setAttribute('aria-label', 'Open video in Picture-in-Picture');
    pipButton.style.cssText = 'position:fixed;z-index:2147483647;display:none;padding:6px 9px;border:0;border-radius:6px;background:#1f2937;color:#fff;font:600 12px sans-serif;cursor:pointer;box-shadow:0 2px 8px #0008';
    pipButton.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation(); enterPip(pipVideo);
    });
    d.documentElement.appendChild(pipButton);
    d.addEventListener('pointerover', function (event) {
      var video = event.target.closest && event.target.closest('video');
      if (!video || !video.requestPictureInPicture) return;
      pipVideo = video;
      var rect = video.getBoundingClientRect();
      pipButton.style.left = Math.max(0, rect.right - 58) + 'px';
      pipButton.style.top = Math.max(0, rect.top + 8) + 'px';
      pipButton.style.display = 'block';
    }, true);
    d.addEventListener('pointerout', function (event) {
      if (event.target === pipVideo && !pipButton.matches(':hover')) {
        setTimeout(function () { if (!pipButton.matches(':hover')) pipButton.style.display = 'none'; }, 120);
      }
    }, true);
    window.addEventListener('scroll', function () { pipButton.style.display = 'none'; }, true);
    d.addEventListener('keydown', function (event) {
      if (event.altKey && event.shiftKey && event.code === 'KeyP') {
        event.preventDefault(); event.stopPropagation();
        enterPip(pipVideo || Array.from(d.querySelectorAll('video')).find(function (v) {
          return !v.paused && !v.ended;
        }));
      }
    }, true);
    if (muted) window.__govindSetMuted(true);
    else audioState();
  }
  setupDocument();
})();
"#;

const PASSWORD_GENERATOR_JS: &str = include_str!("../../ui/js/lib/password-generator.js");

const REQUEST_TRANSLATION_JS: &str = r#"
(function (requestId) {
  var title = document.title, data = {
    requestId: requestId,
    title: title,
    url: location.href,
    text: (document.body && document.body.innerText || '').slice(0, 20000)
  };
  var marker = '__GOVIND_TRANSLATE__' + encodeURIComponent(JSON.stringify(data));
  document.title = marker;
  setTimeout(function () { if (document.title === marker) document.title = title; }, 250);
})
"#;

const APPLY_TRANSLATION_JS: &str = r#"
(function (title, text) {
  var d = document;
  if (window.__govindTranslatedOriginal) return;
  window.__govindTranslatedOriginal = d.body;
  var body = d.createElement('body'), article = d.createElement('article');
  var heading = d.createElement('h1');
  heading.textContent = title;
  article.appendChild(heading);
  text.split(/\n{2,}/).filter(Boolean).forEach(function (line) {
    var p = d.createElement('p'); p.textContent = line; article.appendChild(p);
  });
  body.appendChild(article);
  d.documentElement.replaceChild(body, d.body);
  var style = d.createElement('style');
  style.id = '__govindTranslationStyle';
  style.textContent = 'body{margin:0!important;background:#f7f5f0!important;color:#292821!important;font:18px/1.75 Georgia,serif!important}article{max-width:720px;margin:48px auto;padding:0 24px}h1{font:600 36px/1.2 Georgia,serif;margin:0 0 32px}p{margin:0 0 1.4em;white-space:pre-wrap}';
  d.head.appendChild(style);
})
"#;

const RESTORE_TRANSLATION_JS: &str = r#"
(function () {
  var original = window.__govindTranslatedOriginal;
  if (!original) return;
  document.documentElement.replaceChild(original, document.body);
  document.getElementById('__govindTranslationStyle')?.remove();
  delete window.__govindTranslatedOriginal;
})();
"#;

/// Offline page capture for the reading list: extracts the page's visible
/// text and reports it through the title channel (same trick as translation —
/// remote pages have no IPC access).
const SNAPSHOT_JS: &str = r#"
(function (requestId) {
  var title = document.title;
  var data = {
    requestId: requestId,
    title: title,
    url: location.href,
    text: (document.body && document.body.innerText || '').slice(0, 90000)
  };
  var marker = '__GOVIND_SNAPSHOT__' + encodeURIComponent(JSON.stringify(data));
  document.title = marker;
  setTimeout(function () { if (document.title === marker) document.title = title; }, 250);
})
"#;

/// "Clear site data" for the current page's origin: expires every cookie the
/// page can see and wipes origin storage. Best-effort — cookies set on parent
/// domains or httpOnly flags limit what page script can reach.
const CLEAR_SITE_DATA_JS: &str = r#"
(function () {
  var host = location.hostname;
  var bare = host.replace(/^www\./, '');
  var domains = [host, '.' + host, '.' + bare];
  document.cookie.split(';').forEach(function (c) {
    var name = c.split('=')[0].trim();
    if (!name) return;
    domains.forEach(function (d) {
      document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + d;
    });
    document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });
  try { localStorage.clear(); } catch (_) {}
  try { sessionStorage.clear(); } catch (_) {}
  try {
    if (indexedDB && indexedDB.databases) {
      indexedDB.databases().then(function (dbs) {
        dbs.forEach(function (d) { if (d.name) indexedDB.deleteDatabase(d.name); });
      });
    }
  } catch (_) {}
  return true;
})();
"#;

/// Find-in-page script. Placeholders: __QUERY__ (a JSON string literal) and
/// __FORWARD__ (true/false). Keeps match state in `window.__govindFind` so
/// repeated calls cycle through the matches.
const FIND_IN_PAGE_JS: &str = r#"
(function (q, forward) {
  var out = [];
  var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  while (walker.nextNode()) out.push(walker.currentNode);
  var hay = '', starts = [];
  for (var i = 0; i < out.length; i++) { starts[i] = hay.length; hay += out[i].nodeValue; }
  var lower = hay.toLowerCase(), needle = q.toLowerCase(), matches = [];
  var at = lower.indexOf(needle);
  while (at !== -1) { matches.push(at); at = lower.indexOf(needle, at + needle.length); }
  if (!matches.length) { window.__govindFind = null; return false; }
  var state = window.__govindFind || { idx: -1 };
  state.idx = forward
    ? (state.idx + 1) % matches.length
    : (state.idx <= 0 ? matches.length - 1 : state.idx - 1);
  window.__govindFind = state;
  var pos = matches[state.idx];
  var lo = 0, hi = starts.length - 1;
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
  var node = out[lo], off = pos - starts[lo];
  var range = document.createRange();
  range.setStart(node, off);
  range.setEnd(node, Math.min(off + q.length, node.nodeValue.length));
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  var el = range.startContainer.parentElement;
  if (el) el.scrollIntoView({ block: 'center' });
  return true;
})(__QUERY__, __FORWARD__);
"#;

/// Built-in safe-browsing entries. Kept deliberately tiny: Govind has no
/// threat-feed connection yet, so this list holds Google's public
/// Safe Browsing *test* host (so the warning flow can be exercised) plus
/// entries the user adds via the `safebrowsing_blocklist` setting.
const BUILTIN_BLOCKLIST: &[&str] = &["testsafebrowsing.appspot.com"];

pub struct TabWebviewManager {
  webviews: Mutex<HashMap<String, Webview>>,
  private_tabs: Mutex<HashSet<String>>,
  muted_tabs: Mutex<HashSet<String>>,
  force_dark_websites: Mutex<bool>,
  spellcheck: Mutex<bool>,
  do_not_track: Mutex<bool>,
  cosmetic_css: Mutex<String>,
  autofill_profiles: Mutex<String>,
  /// URLs the user explicitly chose to visit despite a safe-browsing hit
  /// (session-only bypass).
  unsafe_allowed: Mutex<HashSet<String>>,
  layout: Mutex<LayoutState>,
}

impl TabWebviewManager {
  pub fn new() -> Self {
    Self {
      webviews: Mutex::new(HashMap::new()),
      private_tabs: Mutex::new(HashSet::new()),
      muted_tabs: Mutex::new(HashSet::new()),
      force_dark_websites: Mutex::new(false),
      spellcheck: Mutex::new(true),
      do_not_track: Mutex::new(false),
      cosmetic_css: Mutex::new(String::new()),
      autofill_profiles: Mutex::new("[]".to_string()),
      unsafe_allowed: Mutex::new(HashSet::new()),
      layout: Mutex::new(LayoutState::default()),
    }
  }

  fn webviews(&self) -> MutexGuard<'_, HashMap<String, Webview>> {
    // A poisoned mutex still holds a valid map — keep serving.
    self.webviews.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn layout(&self) -> LayoutState {
    self.layout.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  fn is_private(&self, tab_id: &str) -> bool {
    self.private_tabs.lock().unwrap_or_else(|e| e.into_inner()).contains(tab_id)
  }

  fn is_muted(&self, tab_id: &str) -> bool {
    self.muted_tabs.lock().unwrap_or_else(|e| e.into_inner()).contains(tab_id)
  }

  fn force_dark_enabled(&self) -> bool {
    *self.force_dark_websites.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn spellcheck_enabled(&self) -> bool {
    *self.spellcheck.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn dnt_enabled(&self) -> bool {
    *self.do_not_track.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn cosmetic_css(&self) -> String {
    self.cosmetic_css.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  fn autofill_profiles(&self) -> String {
    self.autofill_profiles.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  /// Push the current page-feature state into every live webview. Called
  /// after a setting changes; new pages get the same values on load finish.
  fn push_page_features(&self) {
    let spell = self.spellcheck_enabled();
    let dnt = self.dnt_enabled();
    let css = self.cosmetic_css();
    let profiles = self.autofill_profiles();
    let css_json = serde_json::to_string(&css).unwrap_or_else(|_| "\"\"".into());
    let profiles_json = serde_json::to_string(&profiles).unwrap_or_else(|_| "\"[]\"".into());
    let views: Vec<Webview> = self.webviews().values().cloned().collect();
    for webview in views {
      let _ = webview.eval(&format!("window.__govindSetSpellcheck && window.__govindSetSpellcheck({spell});"));
      let _ = webview.eval(&format!("window.__govindSetDnt && window.__govindSetDnt({dnt});"));
      let _ = webview.eval(&format!("window.__govindSetCosmetic && window.__govindSetCosmetic({css_json});"));
      let _ = webview.eval(&format!("window.__govindSetAutofill && window.__govindSetAutofill({profiles_json});"));
    }
  }

  /// Store the new layout and re-apply bounds/visibility immediately.
  pub fn set_layout(&self, layout: LayoutState, _app: &AppHandle) {
    *self.layout.lock().unwrap_or_else(|e| e.into_inner()) = layout;
    self.apply();
  }

  /// Show the active tab's webview over the web region; hide the others.
  pub fn apply(&self) {
    let layout = self.layout();
    // Clone the handles first so the lock is not held across runtime calls.
    let views: Vec<(String, Webview)> = self
      .webviews()
      .iter()
      .map(|(id, webview)| (id.clone(), webview.clone()))
      .collect();

    for (tab_id, webview) in views {
      let active = layout.visible && layout.active.as_deref() == Some(tab_id.as_str());
      if active {
        let _ = webview.set_position(LogicalPosition::new(layout.offset_x, layout.offset_y));
        let _ = webview.set_size(LogicalSize::new(layout.width.max(1.0), layout.height.max(1.0)));
        let _ = webview.show();
      } else {
        let _ = webview.hide();
      }
    }
  }

  /// Navigate a tab.
  ///
  /// The existing webview is reused so page state (scroll position, form input)
  /// survives navigation; a new one is created on first use. Internal pages
  /// (`govind://home`) are rendered by the shell, so their webview is dropped.
  pub async fn navigate(
    &self,
    app: &AppHandle,
    tab_id: &str,
    url: &str,
    private: bool,
  ) -> Result<(), AppError> {
    if private {
      self.private_tabs.lock().unwrap_or_else(|e| e.into_inner()).insert(tab_id.to_string());
    }

    // Internal pages (govind://…) are rendered by the shell, so the tab's
    // webview is dropped and the shell takes over the content region.
    if crate::navigation::is_internal_url(url) || url.eq_ignore_ascii_case("about:blank") {
      self.close_view(tab_id);
      return Ok(());
    }

    let parsed =
      Url::parse(url).map_err(|e| AppError::InvalidInput(format!("invalid url: {e}")))?;

    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.navigate(parsed);
      return Ok(());
    }

    self.create_view(app, tab_id, parsed).await
  }

  /// Create the child webview for a tab.
  ///
  /// Runs on Tauri's async runtime (the caller is an `async` command) — on
  /// Windows this *must* not happen on the UI thread.
  async fn create_view(
    &self,
    app: &AppHandle,
    tab_id: &str,
    url: Url,
  ) -> Result<(), AppError> {
    // NOTE: `get_webview_window("main")` returns `None` as soon as the window
    // hosts child webviews (Tauri only exposes a *WebviewWindow* when all of
    // its webviews share the window label), so the raw `Window` is used here.
    let Some(window) = app.get_window("main") else {
      return Err(AppError::Window("main window not found".into()));
    };

    let layout = self.layout();
    let position = LogicalPosition::new(layout.offset_x, layout.offset_y);
    let size = LogicalSize::new(layout.width.max(1.0), layout.height.max(1.0));

    let nav_id = tab_id.to_string();
    let title_id = tab_id.to_string();
    let load_id = tab_id.to_string();
    let download_id = tab_id.to_string();
    let popup_id = tab_id.to_string();
    let is_private = self.is_private(tab_id);

    let nav_handle = app.clone();
    let title_handle = app.clone();
    let load_handle = app.clone();
    let download_handle = app.clone();
    let popup_handle = app.clone();
    let initial_script = PAGE_FEATURES_JS
      .replace(
        "__INITIAL_MUTED__",
        if self.is_muted(tab_id) { "true" } else { "false" },
      )
      .replace("__PASSWORD_GENERATOR__", PASSWORD_GENERATOR_JS);

    let builder = tauri::webview::WebviewBuilder::new(format!("tab-{tab_id}"), WebviewUrl::External(url))
      .incognito(self.is_private(tab_id))
      .initialization_script(initial_script)
      .on_navigation(move |url| {
        // Only real web pages may be loaded — no javascript:, file:, data:.
        if !is_page_url(url) {
          return false;
        }
        // Safe browsing: warn before navigating to a blocklisted host. The
        // shell shows an interstitial; "visit anyway" calls bypass_unsafe_url.
        if let Some(reason) = unsafe_reason(&nav_handle, url) {
          let _ = nav_handle.emit(
            "tab-unsafe-navigation",
            json!({ "tabId": nav_id, "url": url.to_string(), "reason": reason }),
          );
          return false;
        }
        let _ = nav_handle.emit(
          "tab-url-changed",
          json!({ "tabId": nav_id, "url": url.to_string() }),
        );
        true
      })
      .on_document_title_changed(move |_webview, title| {
        if let Some(state) = title.strip_prefix("__GOVIND_AUDIO__:") {
          let mut parts = state.split(':');
          let _ = title_handle.emit(
            "tab-audio-state",
            json!({
              "tabId": title_id,
              "playing": parts.next() == Some("1"),
              "muted": parts.next() == Some("1"),
            }),
          );
          return;
        }
        if let Some(data) = title.strip_prefix("__GOVIND_TRANSLATE__:") {
          let _ = title_handle.emit(
            "tab-translation-data",
            json!({ "tabId": title_id, "data": data }),
          );
          return;
        }
        if let Some(data) = title.strip_prefix("__GOVIND_SNAPSHOT__") {
          let _ = title_handle.emit(
            "tab-snapshot-data",
            json!({ "tabId": title_id, "data": data }),
          );
          return;
        }
        if let Some(message) = title.strip_prefix("__GOVIND_NOTICE__:") {
          let _ = title_handle.emit(
            "tab-feature-notice",
            json!({ "tabId": title_id, "message": message }),
          );
          return;
        }
        // The favicon probe (after page load) briefly replaces the document
        // title with the favicon URL. Absolute-URL titles are favicon probes,
        // never page titles — a real page is almost never titled like that.
        let lower = title.to_ascii_lowercase();
        let is_favicon_probe =
          lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("data:");
        if is_favicon_probe {
          let _ = title_handle.emit(
            "tab-favicon-changed",
            json!({ "tabId": title_id, "faviconUrl": title }),
          );
          return;
        }
        let _ = title_handle.emit(
          "tab-title-changed",
          json!({ "tabId": title_id, "title": title }),
        );
      })
      .on_page_load(move |webview, payload| {
        let event = match payload.event() {
          PageLoadEvent::Started => "tab-load-started",
          PageLoadEvent::Finished => "tab-load-finished",
        };
        let _ = load_handle.emit(
          event,
          json!({ "tabId": load_id, "url": payload.url().to_string() }),
        );
        // Ask the page for its favicon once it has fully loaded. Off-thread:
        // eval from a non-UI thread is dispatched to the event loop, while
        // doing heavy work inside this callback can wedge WebView2.
        if matches!(payload.event(), PageLoadEvent::Finished) {
          let mgr = load_handle.state::<TabWebviewManager>();
          let muted = mgr.is_muted(&load_id);
          let force_dark = mgr.force_dark_enabled();
          let spell = mgr.spellcheck_enabled();
          let dnt = mgr.dnt_enabled();
          let css = mgr.cosmetic_css();
          let profiles = mgr.autofill_profiles();
          let probe = webview.clone();
          std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            let _ = probe.eval(FAVICON_PROBE_JS);
            let _ = probe.eval(&format!("window.__govindSetMuted && window.__govindSetMuted({muted});"));
            let _ = probe.eval(&format!("window.__govindForceDark && window.__govindForceDark({force_dark});"));
            let _ = probe.eval(&format!("window.__govindSetSpellcheck && window.__govindSetSpellcheck({spell});"));
            let _ = probe.eval(&format!("window.__govindSetDnt && window.__govindSetDnt({dnt});"));
            let css_json = serde_json::to_string(&css).unwrap_or_else(|_| "\"\"".into());
            let profiles_json = serde_json::to_string(&profiles).unwrap_or_else(|_| "\"[]\"".into());
            let _ = probe.eval(&format!("window.__govindSetCosmetic && window.__govindSetCosmetic({css_json});"));
            let _ = probe.eval(&format!("window.__govindSetAutofill && window.__govindSetAutofill({profiles_json});"));
          });
        }
      })
      .on_download(move |_webview, event| {
        match event {
          DownloadEvent::Requested { url, destination } => {
            let _ = download_handle.emit(
              "download-started",
              json!({
                "tabId": download_id,
                "isPrivate": is_private,
                "url": url.to_string(),
                "filename": destination.file_name().map(|n| n.to_string_lossy().to_string()),
              }),
            );
            true // allow the download
          }
          DownloadEvent::Finished { url, path, success } => {
            let _ = download_handle.emit(
              "download-finished",
              json!({
                "tabId": download_id,
                "isPrivate": is_private,
                "url": url.to_string(),
                "path": path.map(|p| p.to_string_lossy().to_string()),
                "success": success,
              }),
            );
            true
          }
          _ => true,
        }
      })
      .on_new_window(move |url, _features| {
        // Pop-ups become new tabs in the UI instead of native windows.
        let _ = popup_handle.emit(
          "tab-new-window",
          json!({ "tabId": popup_id, "isPrivate": is_private, "url": url.to_string() }),
        );
        NewWindowResponse::Deny
      });

    let webview = window
      .add_child(builder, position, size)
      .map_err(|e| AppError::Window(e.to_string()))?;

    // Start hidden: the tab becomes visible when it is activated.
    let _ = webview.hide();
    self.webviews().insert(tab_id.to_string(), webview);
    self.apply();
    Ok(())
  }

  /// Destroy a tab's webview (tab closed, or the tab returned to the home page).
  pub fn close_view(&self, tab_id: &str) {
    if let Some(webview) = self.webviews().remove(tab_id) {
      let _ = webview.close();
    }
  }

  pub fn close_private_tab(&self, tab_id: &str) {
    self.close_view(tab_id);
    self.private_tabs.lock().unwrap_or_else(|e| e.into_inner()).remove(tab_id);
    self.remove_tab_state(tab_id);
  }

  pub fn remove_tab_state(&self, tab_id: &str) {
    self.muted_tabs.lock().unwrap_or_else(|e| e.into_inner()).remove(tab_id);
  }

  pub fn close_all(&self) {
    let drained: Vec<Webview> = self.webviews().drain().map(|(_, w)| w).collect();
    for webview in drained {
      let _ = webview.close();
    }
    self.private_tabs.lock().unwrap_or_else(|e| e.into_inner()).clear();
    self.muted_tabs.lock().unwrap_or_else(|e| e.into_inner()).clear();
  }

  /// Run JS inside a tab's webview (used for back/forward).
  pub fn eval_tab(&self, tab_id: &str, js: &str) {
    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.eval(js);
    }
  }

  /// Find text in a tab's page. Injected script walks the text nodes, selects
  /// the next/previous match and scrolls it into view. An empty query clears
  /// the selection. `ponytail:` matches never span two text nodes (a query
  /// crossing an element boundary is not found) — upgrade to a walker over
  /// concatenated text if that ever matters.
  pub fn find_tab(&self, tab_id: &str, query: &str, forward: bool) {
    if let Some(webview) = self.webviews().get(tab_id) {
      let js = if query.is_empty() {
        "(function(){var s=window.getSelection();s&&s.removeAllRanges();window.__govindFind=null;return true;})();".to_string()
      } else {
        let escaped = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".into());
        FIND_IN_PAGE_JS
          .replace("__QUERY__", &escaped)
          .replace("__FORWARD__", if forward { "true" } else { "false" })
      };
      let _ = webview.eval(&js);
    }
  }

  pub fn reader_mode(&self, tab_id: &str, enabled: bool) {
    if let Some(webview) = self.webviews().get(tab_id) {
      let js = READER_MODE_JS.replace("__ENABLED__", if enabled { "true" } else { "false" });
      let _ = webview.eval(&js);
    }
  }

  pub fn read_aloud(&self, tab_id: &str) -> bool {
    let Some(webview) = self.webviews().get(tab_id).cloned() else {
      return false;
    };
    let _ = webview.eval("window.__govindReadAloud && window.__govindReadAloud();");
    true
  }

  pub fn set_tab_muted(&self, tab_id: &str, muted: bool) -> bool {
    let Some(webview) = self.webviews().get(tab_id).cloned() else {
      return false;
    };
    let mut muted_tabs = self.muted_tabs.lock().unwrap_or_else(|e| e.into_inner());
    if muted { muted_tabs.insert(tab_id.to_string()); } else { muted_tabs.remove(tab_id); }
    drop(muted_tabs);
    let _ = webview.eval(&format!("window.__govindSetMuted && window.__govindSetMuted({muted});"));
    true
  }

  pub fn set_force_dark_websites(&self, enabled: bool) {
    *self.force_dark_websites.lock().unwrap_or_else(|e| e.into_inner()) = enabled;
    let views: Vec<Webview> = self.webviews().values().cloned().collect();
    for webview in views {
      let _ = webview.eval(&format!("window.__govindForceDark && window.__govindForceDark({enabled});"));
    }
  }

  pub fn set_spellcheck(&self, enabled: bool) {
    *self.spellcheck.lock().unwrap_or_else(|e| e.into_inner()) = enabled;
    self.push_page_features();
  }

  pub fn set_do_not_track(&self, enabled: bool) {
    *self.do_not_track.lock().unwrap_or_else(|e| e.into_inner()) = enabled;
    self.push_page_features();
  }

  /// `css` is the raw newline-separated selector list (already validated by
  /// the settings command); empty string disables cosmetic blocking.
  pub fn set_content_blocking(&self, css: String) {
    *self.cosmetic_css.lock().unwrap_or_else(|e| e.into_inner()) = css;
    self.push_page_features();
  }

  /// JSON array of autofill profiles, stored verbatim (validated upstream).
  pub fn set_autofill_profiles(&self, json: String) {
    *self.autofill_profiles.lock().unwrap_or_else(|e| e.into_inner()) = json;
    self.push_page_features();
  }

  /// Extract the page's visible text for an offline reading-list snapshot.
  /// The result arrives on the `tab-snapshot-data` event.
  pub fn request_page_snapshot(&self, tab_id: &str, request_id: &str) -> bool {
    let Some(webview) = self.webviews().get(tab_id).cloned() else {
      return false;
    };
    let escaped = serde_json::to_string(request_id).unwrap_or_else(|_| "\"\"".into());
    let _ = webview.eval(&format!("({SNAPSHOT_JS})({escaped});"));
    true
  }

  /// Expire cookies and clear origin storage for the page's site.
  pub fn clear_site_data(&self, tab_id: &str) -> bool {
    let Some(webview) = self.webviews().get(tab_id).cloned() else {
      return false;
    };
    let _ = webview.eval(CLEAR_SITE_DATA_JS);
    true
  }

  /// Record that the user chose to visit a blocklisted URL anyway.
  pub fn bypass_unsafe_url(&self, url: &str) {
    self.unsafe_allowed
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .insert(url.to_string());
  }

  pub fn request_page_translation(&self, tab_id: &str, request_id: &str) -> bool {
    let Some(webview) = self.webviews().get(tab_id).cloned() else {
      return false;
    };
    let escaped = serde_json::to_string(request_id).unwrap_or_else(|_| "\"\"".into());
    let _ = webview.eval(&format!("({REQUEST_TRANSLATION_JS})({escaped});"));
    true
  }

  pub fn show_translated_page(
    &self,
    tab_id: &str,
    expected_url: &str,
    title: &str,
    text: &str,
  ) -> bool {
    let Some(webview) = self.webviews().get(tab_id).cloned() else {
      return false;
    };
    if webview.url().ok().as_ref().map(Url::as_str) != Some(expected_url) {
      return false;
    }
    let title = serde_json::to_string(title).unwrap_or_else(|_| "\"\"".into());
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let script = format!("({APPLY_TRANSLATION_JS})({title}, {text});");
    let _ = webview.eval(&script);
    true
  }

  pub fn restore_translated_page(&self, tab_id: &str) {
    self.eval_tab(tab_id, RESTORE_TRANSLATION_JS);
  }

  /// Open the engine DevTools for a tab's page.
  ///
  /// Available in every build: the `devtools` feature is enabled on the tauri
  /// dependency (see Cargo.toml).
  pub fn inspect(&self, tab_id: &str) {
    if let Some(webview) = self.webviews().get(tab_id) {
      webview.open_devtools();
    }
  }

  /// Reload a tab's webview natively.
  pub fn reload_tab(&self, tab_id: &str) {
    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.reload();
    }
  }

  /// Print the page of a tab (not the shell chrome).
  pub fn print_tab(&self, tab_id: &str) {
    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.print();
    }
  }

  /// Set the zoom factor of a tab's page (1.0 = 100%).
  pub fn set_zoom(&self, tab_id: &str, factor: f64) {
    let factor = factor.clamp(0.25, 3.0);
    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.set_zoom(factor);
    }
  }

  /// The URL currently loaded in a tab (empty when the tab has no webview).
  #[allow(dead_code)]
  pub fn url_of(&self, tab_id: &str) -> Option<String> {
    self
      .webviews()
      .get(tab_id)
      .and_then(|webview| webview.url().ok())
      .map(|url| url.to_string())
  }
}

impl Default for TabWebviewManager {
  fn default() -> Self {
    Self::new()
  }
}

/// Only http(s) pages may be loaded in a tab webview.
fn is_page_url(url: &Url) -> bool {
  matches!(url.scheme(), "http" | "https")
}

/// Safe-browsing check for a navigation. Returns `Some(reason)` when the URL's
/// host matches the built-in list or the user's `safebrowsing_blocklist`
/// setting — unless the user already chose to visit that exact URL.
///
/// This is a *local* check only: Govind has no threat-feed connection, so the
/// built-in list is tiny (a test host) and real protection comes from the
/// user-managed list. Matching is by host suffix.
fn unsafe_reason(app: &AppHandle, url: &Url) -> Option<String> {
  let Some(manager) = app.try_state::<TabWebviewManager>() else {
    return None;
  };
  let raw = url.as_str();
  if manager
    .unsafe_allowed
    .lock()
    .unwrap_or_else(|e| e.into_inner())
    .contains(raw)
  {
    return None;
  }

  let Some(db) = app.try_state::<DbState>() else {
    return None;
  };
  let conn = db.conn();
  let setting = |key: &str| -> String {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
      .unwrap_or_default()
  };
  if setting("safe_browsing") != "true" {
    return None;
  }
  let user_list = setting("safebrowsing_blocklist");
  drop(conn);

  let host = url.host_str()?.trim_start_matches("www.").to_ascii_lowercase();
  if host.is_empty() {
    return None;
  }
  let entries = BUILTIN_BLOCKLIST
    .iter()
    .map(|s| s.to_string())
    .chain(user_list.lines().map(|l| l.trim().to_string()));
  for entry in entries {
    let e = entry.trim_start_matches("*.").trim().to_ascii_lowercase();
    if e.is_empty() {
      continue;
    }
    if host == e || host.ends_with(&format!(".{e}")) {
      return Some(format!("The site “{host}” is on Govind's blocklist."));
    }
  }
  None
}
