use std::fs;

use rusqlite::params;

use crate::db::{get_db, queries};
use crate::ia::types::Session;
use crate::sessions::manager::get_session;
use crate::tools::wechat_db::{find_account_dir, find_wechat_pid};

fn fallback_account_dir() -> Option<String> {
    let base_paths = [
        "/home/wechat/xwechat_files",
        "/home/wechat/Documents/xwechat_files",
    ];

    let mut candidates: Vec<String> = Vec::new();
    for base in base_paths {
        let Ok(entries) = fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "all_users" || name == "WMPF" || name.starts_with('.') {
                continue;
            }
            candidates.push(name);
        }
    }

    candidates.sort();
    candidates.pop()
}

pub fn ensure_default_session_ready() -> Option<Session> {
    let session = get_session("default")?;
    if session.logged_in_user.is_some() {
        return Some(session);
    }

    let pid = session.wechat_pid.or_else(find_wechat_pid);
    let account_dir = pid.and_then(find_account_dir).or_else(fallback_account_dir);

    let Some(account_dir) = account_dir else {
        return Some(session);
    };

    let db = get_db();
    let previous = queries::get_session_logged_in_user(&db, &session.id);
    if previous.as_ref().filter(|p| *p != &account_dir).is_some() {
        queries::clear_session_data(&db, &session.id);
    }
    queries::update_session_logged_in_user(&db, &session.id, Some(&account_dir));

    if let Some(pid) = pid {
        let now = chrono::Utc::now().to_rfc3339();
        let _ = db.execute(
            "UPDATE sessions SET wechat_pid = ?1, updated_at = ?2 WHERE id = ?3",
            params![pid, now, session.id],
        );
    }

    get_session(&session.id)
}
