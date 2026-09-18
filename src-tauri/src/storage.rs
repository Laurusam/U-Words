use crate::config::app_data_dir;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, State};

pub struct Store(pub Mutex<Connection>);

impl Store {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let dir = app_data_dir(app)?;
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let conn = Connection::open(dir.join("uwords.sqlite3")).map_err(|error| error.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
              CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
              CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
              PRAGMA user_version=1;",
        )
        .map_err(|error| error.to_string())?;
        Ok(Self(Mutex::new(conn)))
    }
}

#[tauri::command]
pub fn storage_read(store: State<'_, Store>, key: String) -> Result<Option<Value>, String> {
    let conn = store.0.lock().map_err(|_| "存储繁忙")?;
    let mut stmt = conn
        .prepare("SELECT value FROM kv WHERE key=?1")
        .map_err(|error| error.to_string())?;
    let result = stmt.query_row([key], |row| row.get::<_, String>(0));
    match result {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|error| error.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn storage_write(store: State<'_, Store>, key: String, value: Value) -> Result<(), String> {
    if !["history", "usage", "tools", "onboarding", "corrections", "dictionary"]
        .contains(&key.as_str())
    {
        return Err("无效存储键".into());
    }
    let mut conn = store.0.lock().map_err(|_| "存储繁忙")?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value.to_string()],
    )
    .map_err(|error| error.to_string())?;
    if key == "history" {
        tx.execute("DELETE FROM records WHERE kind='dictation'", [])
            .map_err(|error| error.to_string())?;
        if let Some(items) = value.as_array() {
            for item in items {
                if let Some(id) = item["id"].as_str() {
                    tx.execute(
                        "INSERT INTO records(id,kind,body) VALUES(?1,'dictation',?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
                        params![id, item.to_string()],
                    )
                    .map_err(|error| error.to_string())?;
                }
            }
        }
    }
    tx.commit().map_err(|error| error.to_string())
}
