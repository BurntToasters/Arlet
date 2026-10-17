//! Library metadata cache in SQLite, behind fixed commands. The webview gets
//! no generic SQL access, and the schema carries its own version.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub items: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub updated_at: i64,
}

/// What reads return: stored payloads go to the webview as they were written,
/// so a read does not parse and re-serialize every item.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPageView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub items: Vec<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMeta {
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storefront: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_refresh_at: Option<i64>,
}

pub const SCHEMA_VERSION: i64 = 2;
/// Apple pages hold a few hundred items; this bounds a hostile write.
pub const MAX_PAGE_ITEMS: usize = 10_000;
pub const MAX_KEY_LENGTH: usize = 2048;
pub const DATABASE_FILE: &str = "arlet-library.db";

/// Version 1 matches the tables the former SQL plugin created, so an
/// existing cache migrates in place. Add later versions as new steps.
const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS music_resources (
  scope TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
  payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, resource_type, resource_id));
CREATE TABLE IF NOT EXISTS music_pages (
  scope TEXT NOT NULL, section TEXT NOT NULL, cursor TEXT NOT NULL,
  next_cursor TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, section, cursor));
CREATE TABLE IF NOT EXISTS music_page_items (
  scope TEXT NOT NULL, section TEXT NOT NULL, cursor TEXT NOT NULL,
  position INTEGER NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
  PRIMARY KEY (scope, section, cursor, position));
CREATE TABLE IF NOT EXISTS cache_meta (
  scope TEXT PRIMARY KEY, storefront TEXT, last_refresh_at INTEGER);
";

/// Version 2 indexes item links by resource so unreferenced resources can be
/// found cheaply, and drops the orphans earlier builds left behind.
const SCHEMA_V2: &str = "
CREATE INDEX IF NOT EXISTS music_page_items_resource
  ON music_page_items(scope, resource_type, resource_id);
DELETE FROM music_resources WHERE NOT EXISTS (
  SELECT 1 FROM music_page_items i WHERE i.scope = music_resources.scope
    AND i.resource_type = music_resources.resource_type
    AND i.resource_id = music_resources.resource_id);
";

/// Deletes a resource once no page links to it.
const DELETE_IF_ORPHAN: &str = "DELETE FROM music_resources
  WHERE scope = ?1 AND resource_type = ?2 AND resource_id = ?3
    AND NOT EXISTS (SELECT 1 FROM music_page_items
      WHERE scope = ?1 AND resource_type = ?2 AND resource_id = ?3)";

/// Free pages above this share of the file trigger a VACUUM on open.
const VACUUM_FREE_RATIO: f64 = 0.25;

fn sql_error(error: rusqlite::Error) -> String {
    format!("Library cache error: {error}")
}

fn check_key(name: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_KEY_LENGTH {
        return Err(format!("Library cache {name} is too long"));
    }
    Ok(())
}

pub fn migrate(conn: &mut Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "Library cache schema {version} is newer than this build ({SCHEMA_VERSION})"
        ));
    }
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    if version < 1 {
        tx.execute_batch(SCHEMA_V1).map_err(sql_error)?;
    }
    if version < 2 {
        tx.execute_batch(SCHEMA_V2).map_err(sql_error)?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(sql_error)?;
    tx.commit().map_err(sql_error)
}

struct OpenError {
    message: String,
    /// Only a corrupt file or one from a newer build may be deleted. A
    /// transient error (busy, disk full) keeps the cache for the next try.
    disposable: bool,
}

fn is_corruption(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
    )
}

/// How long a cache write waits for the deferred VACUUM, which holds the write
/// lock for its whole run. Waiting is preferred over holding the app's
/// connection mutex: that would also block reads and the first command, while
/// a busy timeout leaves the lock free for readers and only delays writers.
/// Cache commands are async and off the UI thread, so the wait is harmless.
const WRITE_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

fn open_and_migrate(path: &std::path::Path) -> Result<Connection, OpenError> {
    let sqlite = |error: rusqlite::Error| OpenError {
        disposable: is_corruption(&error),
        message: sql_error(error),
    };
    let mut conn = Connection::open(path).map_err(sqlite)?;
    conn.busy_timeout(WRITE_BUSY_TIMEOUT).map_err(sqlite)?;
    tune_journal(&conn);
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sqlite)?;
    if version > SCHEMA_VERSION {
        return Err(OpenError {
            message: format!(
                "Library cache schema {version} is newer than this build ({SCHEMA_VERSION})"
            ),
            disposable: true,
        });
    }
    migrate(&mut conn).map_err(|message| OpenError {
        disposable: message.contains("malformed") || message.contains("not a database"),
        message,
    })?;
    Ok(conn)
}

/// WAL keeps readers from waiting on the writer, and NORMAL sync cannot corrupt
/// a WAL database (a power loss may drop the last commits). If WAL cannot be
/// enabled the rollback journal still works, so this logs and continues.
/// Synchronous is per connection, so it is set on every open.
fn tune_journal(conn: &Connection) {
    match conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
        row.get::<_, String>(0)
    }) {
        Ok(mode) if mode.eq_ignore_ascii_case("wal") => {}
        Ok(mode) => eprintln!("Library cache WAL unavailable, journal mode is {mode}"),
        Err(error) => eprintln!("Library cache WAL unavailable: {error}"),
    }
    if let Err(error) = conn.pragma_update(None, "synchronous", "NORMAL") {
        eprintln!("Library cache synchronous setting failed: {error}");
    }
}

/// Deleted rows leave free pages behind; reclaim them once they make up a
/// large share of the file. Runs on its own connection after the first
/// command, so the shared connection is not held while it works. VACUUM is
/// transactional, so an exit mid-run leaves the file intact.
fn compact_if_sparse(path: &std::path::Path) {
    let Ok(conn) = Connection::open(path) else {
        return;
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    let pragma =
        |name: &str| conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get::<_, i64>(0));
    if let (Ok(pages), Ok(free)) = (pragma("page_count"), pragma("freelist_count")) {
        if pages > 0 && free as f64 / pages as f64 > VACUUM_FREE_RATIO {
            if let Err(error) = conn.execute_batch("VACUUM") {
                eprintln!("Library cache VACUUM failed: {error}");
            }
        }
    }
}

fn database_files(path: &std::path::Path) -> Vec<std::path::PathBuf> {
    ["", "-journal", "-wal", "-shm"]
        .iter()
        .map(|suffix| {
            let mut file = path.as_os_str().to_owned();
            file.push(suffix);
            std::path::PathBuf::from(file)
        })
        .collect()
}

/// The cache is disposable: a corrupt file or one from a newer build is
/// deleted and recreated instead of blocking the library.
pub fn open_at(path: &std::path::Path) -> Result<Connection, String> {
    match open_and_migrate(path) {
        Ok(conn) => Ok(conn),
        Err(first) if first.disposable => {
            // Side files go first: a leftover WAL would be replayed onto the
            // fresh database and bring the deleted rows back.
            for file in database_files(path).into_iter().rev() {
                let _ = std::fs::remove_file(file);
            }
            open_and_migrate(path)
                .map_err(|second| format!("{}; reset failed: {}", first.message, second.message))
        }
        Err(first) => Err(first.message),
    }
}

/// Moves a cache from the roaming config dir (where the former SQL plugin
/// kept it) to the local data dir, so a large disposable file does not roam
/// with domain profiles. A failed move just starts a fresh cache.
fn move_legacy_cache(legacy: &std::path::Path, target: &std::path::Path) {
    // Side files without their database would be replayed onto the next one.
    if !target.exists() {
        for file in database_files(target).into_iter().skip(1) {
            let _ = std::fs::remove_file(file);
        }
    }
    if !legacy.exists() {
        return;
    }
    // A target from an earlier upgrade wins; leftover legacy files would
    // otherwise linger forever after a downgrade and re-upgrade.
    let target_exists = target.exists();
    for (from, to) in database_files(legacy)
        .into_iter()
        .zip(database_files(target))
    {
        if !from.exists() {
            continue;
        }
        if target_exists || std::fs::rename(&from, &to).is_err() {
            let _ = std::fs::remove_file(&from);
        }
    }
}

fn resource_type(item: &Value) -> String {
    ["resourceType", "type"]
        .iter()
        .find_map(|key| item.get(*key)?.as_str().filter(|value| !value.is_empty()))
        .unwrap_or("resource")
        .to_string()
}

fn resource_id(item: &Value) -> Option<String> {
    item.get("id")?
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Clone)]
struct PageRow {
    cursor: String,
    next: Option<String>,
    updated_at: i64,
}

fn page_rows(
    conn: &Connection,
    scope: &str,
    section: &str,
    cursor: Option<&str>,
) -> Result<Vec<PageRow>, String> {
    let map = |row: &rusqlite::Row<'_>| {
        Ok(PageRow {
            cursor: row.get(0)?,
            next: row
                .get::<_, Option<String>>(1)?
                .filter(|value| !value.is_empty()),
            updated_at: row.get(2)?,
        })
    };
    let rows = match cursor {
        Some(cursor) => conn
            .prepare_cached(
                "SELECT cursor, next_cursor, updated_at FROM music_pages
                 WHERE scope = ?1 AND section = ?2 AND cursor = ?3",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([scope, section, cursor], map)?
                    .collect::<rusqlite::Result<Vec<_>>>()
            }),
        None => conn
            .prepare_cached(
                "SELECT cursor, next_cursor, updated_at FROM music_pages
                 WHERE scope = ?1 AND section = ?2 ORDER BY updated_at ASC",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([scope, section], map)?
                    .collect::<rusqlite::Result<Vec<_>>>()
            }),
    };
    rows.map_err(sql_error)
}

/// One joined query per read, ordered by page then position.
fn read_items(
    conn: &Connection,
    scope: &str,
    section: &str,
    pages: &[PageRow],
) -> Result<Vec<Box<RawValue>>, String> {
    if pages.is_empty() {
        return Ok(Vec::new());
    }
    let map = |row: &rusqlite::Row<'_>| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?));
    let base = "SELECT i.cursor, r.payload FROM music_page_items i
         JOIN music_resources r ON r.scope = i.scope
           AND r.resource_type = i.resource_type AND r.resource_id = i.resource_id
         WHERE i.scope = ?1 AND i.section = ?2";
    let rows = if pages.len() == 1 {
        conn.prepare_cached(&format!("{base} AND i.cursor = ?3 ORDER BY i.position"))
            .and_then(|mut statement| {
                statement
                    .query_map([scope, section, pages[0].cursor.as_str()], map)?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
    } else {
        conn.prepare_cached(&format!("{base} ORDER BY i.cursor, i.position"))
            .and_then(|mut statement| {
                statement
                    .query_map([scope, section], map)?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
    }
    .map_err(sql_error)?;
    let mut by_cursor: std::collections::HashMap<String, Vec<Box<RawValue>>> = Default::default();
    for (cursor, payload) in rows {
        // Validates the stored JSON without building a Value tree; bad rows
        // are skipped as before.
        if let Ok(value) = RawValue::from_string(payload) {
            by_cursor.entry(cursor).or_default().push(value);
        }
    }
    Ok(pages
        .iter()
        .flat_map(|page| by_cursor.remove(&page.cursor).unwrap_or_default())
        .collect())
}

pub fn read_page(
    conn: &Connection,
    scope: &str,
    section: &str,
    cursor: Option<&str>,
) -> Result<Option<CachedPageView>, String> {
    check_key("scope", scope)?;
    check_key("section", section)?;
    let key = cursor.unwrap_or("");
    let pages = page_rows(conn, scope, section, Some(key))?;
    let Some(page) = pages.first() else {
        return Ok(None);
    };
    Ok(Some(CachedPageView {
        cursor: (!key.is_empty()).then(|| key.to_string()),
        items: read_items(conn, scope, section, &pages)?,
        next: page.next.clone(),
        updated_at: page.updated_at,
    }))
}

/// All pages of a section in chain order from the first page; falls back to
/// update order when the chain is broken.
pub fn read_section(
    conn: &Connection,
    scope: &str,
    section: &str,
) -> Result<Option<CachedPageView>, String> {
    check_key("scope", scope)?;
    check_key("section", section)?;
    let pages = page_rows(conn, scope, section, None)?;
    if pages.is_empty() {
        return Ok(None);
    }
    let by_cursor: std::collections::HashMap<&str, &PageRow> = pages
        .iter()
        .map(|page| (page.cursor.as_str(), page))
        .collect();
    let mut chain: Vec<PageRow> = Vec::new();
    let mut visited = std::collections::HashSet::new();
    let mut cursor = "";
    while visited.insert(cursor) {
        let Some(page) = by_cursor.get(cursor) else {
            break;
        };
        chain.push((*page).clone());
        match page.next.as_deref() {
            Some(next) => cursor = next,
            None => break,
        }
    }
    let ordered = if chain.len() == pages.len() {
        chain
    } else {
        pages
    };
    let newest = ordered.last().cloned().expect("non-empty pages");
    Ok(Some(CachedPageView {
        cursor: None,
        items: read_items(conn, scope, section, &ordered)?,
        next: newest.next,
        updated_at: newest.updated_at,
    }))
}

pub fn write_page(
    conn: &mut Connection,
    scope: &str,
    section: &str,
    page: &CachedPage,
) -> Result<(), String> {
    check_key("scope", scope)?;
    check_key("section", section)?;
    let cursor = page.cursor.as_deref().unwrap_or("");
    check_key("cursor", cursor)?;
    if page.items.len() > MAX_PAGE_ITEMS {
        return Err(format!(
            "Library cache page has {} items (max {MAX_PAGE_ITEMS})",
            page.items.len()
        ));
    }
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    tx.prepare_cached(
        "INSERT INTO music_pages(scope, section, cursor, next_cursor, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(scope, section, cursor) DO UPDATE SET
           next_cursor = excluded.next_cursor, updated_at = excluded.updated_at",
    )
    .map_err(sql_error)?
    .execute(rusqlite::params![
        scope,
        section,
        cursor,
        page.next,
        page.updated_at
    ])
    .map_err(sql_error)?;
    let previous = linked_resources(
        &tx,
        "SELECT resource_type, resource_id FROM music_page_items
         WHERE scope = ?1 AND section = ?2 AND cursor = ?3",
        &[scope, section, cursor],
    )?;
    tx.prepare_cached(
        "DELETE FROM music_page_items WHERE scope = ?1 AND section = ?2 AND cursor = ?3",
    )
    .map_err(sql_error)?
    .execute([scope, section, cursor])
    .map_err(sql_error)?;
    {
        let mut upsert = tx
            .prepare_cached(
                "INSERT INTO music_resources(scope, resource_type, resource_id, payload, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(scope, resource_type, resource_id) DO UPDATE SET
                   payload = excluded.payload, updated_at = excluded.updated_at",
            )
            .map_err(sql_error)?;
        let mut link = tx
            .prepare_cached(
                "INSERT INTO music_page_items(scope, section, cursor, position, resource_type, resource_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(sql_error)?;
        for (position, item) in page.items.iter().enumerate() {
            let kind = resource_type(item);
            // Id-less items get a slot-scoped key so they cannot collide.
            let id =
                resource_id(item).unwrap_or_else(|| format!("slot:{section}:{cursor}:{position}"));
            upsert
                .execute(rusqlite::params![
                    scope,
                    kind,
                    id,
                    item.to_string(),
                    page.updated_at
                ])
                .map_err(sql_error)?;
            link.execute(rusqlite::params![
                scope,
                section,
                cursor,
                position as i64,
                kind,
                id
            ])
            .map_err(sql_error)?;
        }
    }
    delete_orphans(&tx, scope, &previous)?;
    tx.commit().map_err(sql_error)
}

fn linked_resources(
    conn: &Connection,
    query: &str,
    params: &[&str],
) -> Result<Vec<(String, String)>, String> {
    conn.prepare_cached(query)
        .and_then(|mut statement| {
            statement
                .query_map(rusqlite::params_from_iter(params), |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(sql_error)
}

/// Drops resources that lost their last page link, or the table grows
/// with every refresh that removes items.
fn delete_orphans(
    conn: &Connection,
    scope: &str,
    candidates: &[(String, String)],
) -> Result<(), String> {
    let mut statement = conn.prepare_cached(DELETE_IF_ORPHAN).map_err(sql_error)?;
    for (kind, id) in candidates {
        statement
            .execute(rusqlite::params![scope, kind, id])
            .map_err(sql_error)?;
    }
    Ok(())
}

pub fn clear_section(conn: &mut Connection, scope: &str, section: &str) -> Result<(), String> {
    check_key("scope", scope)?;
    check_key("section", section)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    let previous = linked_resources(
        &tx,
        "SELECT DISTINCT resource_type, resource_id FROM music_page_items
         WHERE scope = ?1 AND section = ?2",
        &[scope, section],
    )?;
    for table in ["music_page_items", "music_pages"] {
        tx.prepare_cached(&format!(
            "DELETE FROM {table} WHERE scope = ?1 AND section = ?2"
        ))
        .map_err(sql_error)?
        .execute([scope, section])
        .map_err(sql_error)?;
    }
    delete_orphans(&tx, scope, &previous)?;
    tx.commit().map_err(sql_error)
}

pub fn set_meta(conn: &Connection, meta: &CacheMeta) -> Result<(), String> {
    check_key("scope", &meta.scope)?;
    conn.prepare_cached(
        "INSERT INTO cache_meta(scope, storefront, last_refresh_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(scope) DO UPDATE SET
           storefront = excluded.storefront, last_refresh_at = excluded.last_refresh_at",
    )
    .and_then(|mut statement| {
        statement.execute(rusqlite::params![
            meta.scope,
            meta.storefront,
            meta.last_refresh_at
        ])
    })
    .map(|_| ())
    .map_err(sql_error)
}

pub fn get_meta(conn: &Connection, scope: &str) -> Result<Option<CacheMeta>, String> {
    check_key("scope", scope)?;
    conn.prepare_cached(
        "SELECT scope, storefront, last_refresh_at FROM cache_meta WHERE scope = ?1",
    )
    .and_then(|mut statement| {
        statement
            .query_map([scope], |row| {
                Ok(CacheMeta {
                    scope: row.get(0)?,
                    storefront: row
                        .get::<_, Option<String>>(1)?
                        .filter(|value| !value.is_empty()),
                    last_refresh_at: row.get(2)?,
                })
            })?
            .next()
            .transpose()
    })
    .map_err(sql_error)
}

pub fn clear(conn: &mut Connection, scope: &str) -> Result<(), String> {
    check_key("scope", scope)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    for table in [
        "music_page_items",
        "music_pages",
        "music_resources",
        "cache_meta",
    ] {
        tx.prepare_cached(&format!("DELETE FROM {table} WHERE scope = ?1"))
            .map_err(sql_error)?
            .execute([scope])
            .map_err(sql_error)?;
    }
    tx.commit().map_err(sql_error)
}

/// Lazily opened connection in the local app data dir; a cache in the former
/// roaming location is moved there on first open.
#[derive(Default)]
pub struct LibraryCacheState {
    connection: std::sync::Mutex<Option<Connection>>,
    /// Set once the deferred VACUUM check is queued, so it runs once per launch.
    compaction_queued: std::sync::atomic::AtomicBool,
}

fn database_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(DATABASE_FILE))
}

fn with_conn<T>(
    app: &tauri::AppHandle,
    run: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    use tauri::Manager;
    let state = app.state::<LibraryCacheState>();
    let mut guard = state
        .connection
        .lock()
        .map_err(|_| "Library cache lock poisoned".to_string())?;
    if guard.is_none() {
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(DATABASE_FILE);
        if let Ok(legacy_dir) = app.path().app_config_dir() {
            move_legacy_cache(&legacy_dir.join(DATABASE_FILE), &path);
        }
        *guard = Some(open_at(&path)?);
    }
    let result = run(guard.as_mut().expect("connection opened above"));
    if result.is_ok()
        && !state
            .compaction_queued
            .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        if let Ok(path) = database_path(app) {
            std::thread::spawn(move || compact_if_sparse(&path));
        }
    }
    result
}

#[tauri::command(async)]
pub fn library_cache_read_page(
    app: tauri::AppHandle,
    scope: String,
    section: String,
    cursor: Option<String>,
) -> Result<Option<CachedPageView>, String> {
    with_conn(&app, |conn| {
        read_page(conn, &scope, &section, cursor.as_deref())
    })
}

#[tauri::command(async)]
pub fn library_cache_read_section(
    app: tauri::AppHandle,
    scope: String,
    section: String,
) -> Result<Option<CachedPageView>, String> {
    with_conn(&app, |conn| read_section(conn, &scope, &section))
}

#[tauri::command(async)]
pub fn library_cache_write_page(
    app: tauri::AppHandle,
    scope: String,
    section: String,
    page: CachedPage,
) -> Result<(), String> {
    with_conn(&app, |conn| write_page(conn, &scope, &section, &page))
}

#[tauri::command(async)]
pub fn library_cache_clear_section(
    app: tauri::AppHandle,
    scope: String,
    section: String,
) -> Result<(), String> {
    with_conn(&app, |conn| clear_section(conn, &scope, &section))
}

#[tauri::command(async)]
pub fn library_cache_set_meta(app: tauri::AppHandle, meta: CacheMeta) -> Result<(), String> {
    with_conn(&app, |conn| set_meta(conn, &meta))
}

#[tauri::command(async)]
pub fn library_cache_get_meta(
    app: tauri::AppHandle,
    scope: String,
) -> Result<Option<CacheMeta>, String> {
    with_conn(&app, |conn| get_meta(conn, &scope))
}

#[tauri::command(async)]
pub fn library_cache_clear(app: tauri::AppHandle, scope: String) -> Result<(), String> {
    with_conn(&app, |conn| clear(conn, &scope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn memory() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn
    }

    fn songs(prefix: &str, count: usize) -> Vec<Value> {
        (0..count)
            .map(|i| json!({ "id": format!("{prefix}-{i}"), "type": "library-songs", "title": i }))
            .collect()
    }

    fn page(cursor: Option<&str>, items: Vec<Value>, next: Option<&str>, at: i64) -> CachedPage {
        CachedPage {
            cursor: cursor.map(str::to_string),
            items,
            next: next.map(str::to_string),
            updated_at: at,
        }
    }

    fn ids(page: &CachedPage) -> Vec<String> {
        page.items
            .iter()
            .map(|item| item["id"].as_str().unwrap_or("").to_string())
            .collect()
    }

    fn parsed(item: &RawValue) -> Value {
        serde_json::from_str(item.get()).unwrap()
    }

    fn read_ids(items: &[Box<RawValue>]) -> Vec<String> {
        items
            .iter()
            .map(|item| parsed(item)["id"].as_str().unwrap_or("").to_string())
            .collect()
    }

    fn scoped_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("arlet-cache-{name}-{}", std::process::id()))
    }

    // Failure modes: section reads lose page or position order; id-less
    // items collapse onto one row; duplicate ids break the write; pages over
    // SQLite's parameter limits fail; rewriting leaves stale items; one scope
    // clears another; reading an unknown page errors instead of missing.
    #[test]
    fn section_reads_follow_page_chain_and_positions() {
        let mut conn = memory();
        write_page(
            &mut conn,
            "s",
            "songs",
            &page(None, songs("a", 300), Some("p2"), 1),
        )
        .unwrap();
        write_page(
            &mut conn,
            "s",
            "songs",
            &page(Some("p2"), songs("b", 300), None, 2),
        )
        .unwrap();
        let section = read_section(&conn, "s", "songs").unwrap().unwrap();
        let all = read_ids(&section.items);
        assert_eq!(all.len(), 600);
        assert_eq!(all[0], "a-0");
        assert_eq!(all[299], "a-299");
        assert_eq!(all[300], "b-0");
        assert_eq!(all[599], "b-299");
        assert_eq!(section.updated_at, 2);
        let second = read_page(&conn, "s", "songs", Some("p2")).unwrap().unwrap();
        assert_eq!(second.cursor.as_deref(), Some("p2"));
        assert_eq!(
            read_ids(&second.items),
            ids(&page(None, songs("b", 300), None, 0))
        );
        assert!(read_page(&conn, "s", "songs", Some("missing"))
            .unwrap()
            .is_none());
        assert!(read_section(&conn, "s", "albums").unwrap().is_none());
    }

    #[test]
    fn id_less_items_stay_distinct_and_duplicates_last_win() {
        let mut conn = memory();
        let items = vec![
            json!({ "title": "No id one" }),
            json!({ "id": "dup", "type": "songs", "title": "First" }),
            json!({ "title": "No id two" }),
            json!({ "id": "dup", "type": "songs", "title": "Second" }),
        ];
        write_page(&mut conn, "s", "mixed", &page(None, items, None, 1)).unwrap();
        let read = read_page(&conn, "s", "mixed", None).unwrap().unwrap();
        let titles: Vec<String> = read
            .items
            .iter()
            .map(|item| parsed(item)["title"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(titles, ["No id one", "Second", "No id two", "Second"]);
    }

    #[test]
    fn large_pages_round_trip() {
        let mut conn = memory();
        write_page(
            &mut conn,
            "s",
            "songs",
            &page(None, songs("big", 7000), None, 1),
        )
        .unwrap();
        let read = read_page(&conn, "s", "songs", None).unwrap().unwrap();
        assert_eq!(read.items.len(), 7000);
        assert_eq!(read_ids(&read.items)[6999], "big-6999");
    }

    #[test]
    fn rewrite_replaces_and_scopes_are_isolated() {
        let mut conn = memory();
        write_page(
            &mut conn,
            "a",
            "songs",
            &page(None, songs("old", 5), None, 1),
        )
        .unwrap();
        write_page(
            &mut conn,
            "b",
            "songs",
            &page(None, songs("other", 2), None, 1),
        )
        .unwrap();
        write_page(
            &mut conn,
            "a",
            "songs",
            &page(None, songs("new", 2), None, 2),
        )
        .unwrap();
        assert_eq!(
            read_ids(&read_page(&conn, "a", "songs", None).unwrap().unwrap().items),
            ["new-0", "new-1"]
        );
        clear_section(&mut conn, "b", "albums").unwrap();
        clear(&mut conn, "a").unwrap();
        assert!(read_section(&conn, "a", "songs").unwrap().is_none());
        assert_eq!(
            read_ids(&read_section(&conn, "b", "songs").unwrap().unwrap().items),
            ["other-0", "other-1"]
        );
    }

    #[test]
    fn meta_round_trips_and_clears() {
        let mut conn = memory();
        assert!(get_meta(&conn, "s").unwrap().is_none());
        let meta = CacheMeta {
            scope: "s".into(),
            storefront: Some("us".into()),
            last_refresh_at: Some(42),
        };
        set_meta(&conn, &meta).unwrap();
        assert_eq!(get_meta(&conn, "s").unwrap(), Some(meta));
        clear(&mut conn, "s").unwrap();
        assert!(get_meta(&conn, "s").unwrap().is_none());
    }

    // Failure modes: a database written by the old SQL plugin (same tables,
    // user_version 0) loses its data or fails to open; a newer or corrupt
    // database (downgrade, disk damage) blocks startup instead of resetting
    // the disposable cache.
    #[test]
    fn migrates_plugin_era_database_in_place() {
        let dir = scoped_dir("legacy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("arlet-library.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE music_resources (scope TEXT NOT NULL, resource_type TEXT NOT NULL,
                   resource_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
                   PRIMARY KEY (scope, resource_type, resource_id));
                 CREATE TABLE music_pages (scope TEXT NOT NULL, section TEXT NOT NULL,
                   cursor TEXT NOT NULL, next_cursor TEXT, updated_at INTEGER NOT NULL,
                   PRIMARY KEY (scope, section, cursor));
                 CREATE TABLE music_page_items (scope TEXT NOT NULL, section TEXT NOT NULL,
                   cursor TEXT NOT NULL, position INTEGER NOT NULL, resource_type TEXT NOT NULL,
                   resource_id TEXT NOT NULL, PRIMARY KEY (scope, section, cursor, position));
                 CREATE TABLE cache_meta (scope TEXT PRIMARY KEY, storefront TEXT, last_refresh_at INTEGER);
                 INSERT INTO music_resources VALUES ('s','songs','x','{\"id\":\"x\"}',1);
                 INSERT INTO music_pages VALUES ('s','songs','',NULL,1);
                 INSERT INTO music_page_items VALUES ('s','songs','',0,'songs','x');",
            )
            .unwrap();
        }
        let conn = open_at(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(
            read_ids(&read_section(&conn, "s", "songs").unwrap().unwrap().items),
            ["x"]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn newer_or_corrupt_database_is_reset() {
        let dir = scoped_dir("reset");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let newer = dir.join("newer.db");
        {
            let conn = Connection::open(&newer).unwrap();
            conn.execute_batch("CREATE TABLE future (x); PRAGMA user_version = 99;")
                .unwrap();
        }
        let conn = open_at(&newer).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(read_section(&conn, "s", "songs").unwrap().is_none());
        drop(conn);

        let corrupt = dir.join("corrupt.db");
        std::fs::write(
            &corrupt,
            b"this is not a sqlite database at all, not even close",
        )
        .unwrap();
        let conn = open_at(&corrupt).unwrap();
        assert!(read_section(&conn, "s", "songs").unwrap().is_none());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Failure modes: the webview writes unbounded pages or keys and grows
    // the database without limit.
    #[test]
    fn rejects_oversized_inputs() {
        let mut conn = memory();
        let too_many = page(None, songs("x", MAX_PAGE_ITEMS + 1), None, 1);
        assert!(write_page(&mut conn, "s", "songs", &too_many).is_err());
        let long = "k".repeat(MAX_KEY_LENGTH + 1);
        assert!(write_page(&mut conn, &long, "songs", &page(None, vec![], None, 1)).is_err());
        assert!(read_section(&conn, "s", &long).is_err());
    }
}
