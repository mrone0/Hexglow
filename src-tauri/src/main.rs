// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            lol_augment_assistant_lib::desktop::show_main(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                lol_augment_assistant_lib::app_icon::apply(&window)?;
            }
            lol_augment_assistant_lib::desktop::setup(app)?;
            lol_augment_assistant_lib::ocr::start_warmup(app.handle());
            Ok(())
        })
        .on_window_event(lol_augment_assistant_lib::desktop::on_window_event)
        .invoke_handler(tauri::generate_handler![
            lol_augment_assistant_lib::desktop::desktop_ready,
            lol_augment_assistant_lib::desktop::desktop_request_exit,
            lol_augment_assistant_lib::desktop::desktop_exit_ready,
            lol_augment_assistant_lib::backend::fetch_live,
            lol_augment_assistant_lib::backend::save_session,
            lol_augment_assistant_lib::backend::list_sessions,
            lol_augment_assistant_lib::backend::analyze,
            lol_augment_assistant_lib::backend::test_model,
            lol_augment_assistant_lib::decision::analyze_structured,
            lol_augment_assistant_lib::decision::test_provider,
            lol_augment_assistant_lib::credentials::model_key_load,
            lol_augment_assistant_lib::credentials::model_key_save,
            lol_augment_assistant_lib::knowledge::knowledge_list,
            lol_augment_assistant_lib::knowledge::knowledge_read,
            lol_augment_assistant_lib::knowledge::knowledge_validate,
            lol_augment_assistant_lib::knowledge::knowledge_save,
            lol_augment_assistant_lib::knowledge::knowledge_delete,
            lol_augment_assistant_lib::knowledge::knowledge_retrieve,
            lol_augment_assistant_lib::storage::storage_stats,
            lol_augment_assistant_lib::storage::delete_session,
            lol_augment_assistant_lib::storage::delete_analysis,
            lol_augment_assistant_lib::storage::maintain_storage,
            lol_augment_assistant_lib::storage::list_sessions_light,
            lol_augment_assistant_lib::storage::history_similarity,
            lol_augment_assistant_lib::storage::get_session,
            lol_augment_assistant_lib::storage::get_session_by_match,
            lol_augment_assistant_lib::storage::export_session,
            lol_augment_assistant_lib::storage::export_history,
            lol_augment_assistant_lib::collector::collector_snapshot,
            lol_augment_assistant_lib::collector::diagnostics,
            lol_augment_assistant_lib::collector::postgame_entries,
            lol_augment_assistant_lib::collector::postgame_rescan,
            lol_augment_assistant_lib::collector::ocr_stats,
            lol_augment_assistant_lib::overlay::overlay_open,
            lol_augment_assistant_lib::overlay::overlay_ready,
            lol_augment_assistant_lib::overlay::overlay_publish,
            lol_augment_assistant_lib::overlay::overlay_close,
            lol_augment_assistant_lib::overlay::overlay_set_collapsed,
            lol_augment_assistant_lib::ocr::ocr_scan,
            lol_augment_assistant_lib::scoring::score_candidates
        ])
        .run(tauri::generate_context!())
        .unwrap()
}
