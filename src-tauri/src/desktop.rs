use crate::{
    api::{dispatch, Request},
    database::{self, Database},
    services::session_usage::SourceRoots,
};
use std::sync::Arc;
use tauri::Manager;

struct State {
    db: Arc<Database>,
    roots: SourceRoots,
}

#[tauri::command]
async fn usage_request(
    state: tauri::State<'_, State>,
    request: Request,
) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    let roots = state.roots.clone();
    tauri::async_runtime::spawn_blocking(move || dispatch(&db, &roots, request))
        .await
        .map_err(|_| "Usage task failed".to_string())?
        .map_err(|_| "Usage request failed; check the local source status".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db = Database::open(&database::default_directory()?)?;
            let home = dirs::home_dir().ok_or("Home directory unavailable")?;
            app.manage(State {
                db: Arc::new(db),
                roots: SourceRoots::from_home(&home),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![usage_request])
        .run(tauri::generate_context!())
        .expect("Token Usage Lab could not start");
}
