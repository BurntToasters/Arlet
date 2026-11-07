//! Clipboard text for the context-menu Paste action.
//!
//! The page is not granted the generic clipboard-manager read permission. This
//! single command is the only read path; the Paste menu invokes it after
//! checking that the click was trusted and the focused element is editable.

use tauri_plugin_clipboard_manager::ClipboardExt;

#[tauri::command(async)]
pub fn paste_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    app.clipboard()
        .read_text()
        .map_err(|error| error.to_string())
}
