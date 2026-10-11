This directory holds the pinned Obscura engine that the release CI bundles
into the installers (tauri.conf.json -> bundle.resources).

The workflow (.github/workflows/ci.yml) downloads
  https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.4/obscura-x86_64-windows.zip
verifies SHA-256 8e5428bf8c101f1439c53a9dcb52d7d09bb22599206b49f6420028d93d01189b
(the pin recorded in docs/DEPENDENCIES.md), and extracts obscura.exe plus
obscura-worker.exe here. They ship to <install dir>/resources/engine/ next
to ritam-browser.exe; the runtime looks there first (src-tauri/src/main.rs,
engine_binary_path), then falls back to the dev-checkout path.

The .exe files are gitignored — this README keeps the resource glob matched
in a fresh clone. For a local `cargo tauri build`, copy them here first.
