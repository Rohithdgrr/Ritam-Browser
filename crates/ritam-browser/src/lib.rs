//! Ritam Browser core runtime library (Rohan, `agents/ROHAN.md`).
//!
//! Two things live here, deliberately free of any Tauri/WebView2 types so
//! they can be tested without a window:
//!
//! * [`nav`] — the single URL-vs-search classification and the scheme policy
//!   that backs both the omnibox and the webview navigation handler
//!   (`contracts/ipc.md` §4). One implementation, so the two cannot disagree.
//! * [`engine`] — the Obscura adapter: a narrow [`engine::ObscuraEngine`]
//!   trait with a CLI implementation and a CDP implementation over
//!   `obscura serve`, plus the byte-equality check that owner rule 3
//!   requires. The engine is never patched or reimplemented here.

pub mod cdp;
pub mod engine;
pub mod nav;
