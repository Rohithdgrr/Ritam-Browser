// Ritam Browser - application host.
//
// Ownership note: this tree (`src-tauri/**`) belongs to Rohan per AGENTS.md §3.
// The owner (2026-10-10) commanded the ROT agent to implement this stage
// end-to-end; the cross-boundary authorization is recorded in PLAN.md.

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running Ritam Browser");
}
