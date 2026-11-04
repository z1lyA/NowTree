use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

use crate::db::Db;
use crate::models::Transaction;

// ---- 入参 DTO ----

#[derive(Debug, Deserialize)]
pub struct TransactionQuery {
    pub status: Option<String>,
    pub category: Option<Option<String>>,
    pub parent_id: Option<Option<i64>>,
}

#[derive(Debug, Deserialize)]
pub struct NewTransactionInput {
    pub title: String,
    pub note: Option<String>,
    pub category: Option<String>,
    pub status: Option<String>,
    pub deadline_type: Option<String>,
    pub deadline_date: Option<String>,
    pub priority: Option<i64>,
    pub reminder_time: Option<String>,
    pub parent_id: Option<i64>,
    pub time_slot: Option<String>,
    pub sync_id: Option<String>, // 0.1.19：可前端带；缺省时后端生成 UUID
}

#[derive(Debug, Deserialize)]
pub struct PatchInput {
    pub title: Option<String>,
    pub note: Option<String>,
    pub category: Option<String>,
    pub status: Option<String>,
    pub deadline_type: Option<String>,
    pub deadline_date: Option<String>,
    pub priority: Option<i64>,
    pub parent_id: Option<i64>,
    // 清空父事务：传 true 时把 parent_id 置 NULL（脱离 Project）。
    // 注意：JSON 下 Option<Option<i64>> 无法表达 Some(None)，故用独立布尔标志。
    pub clear_parent: Option<bool>,
    // 清空提醒：传 true 时把 reminder_time 置 NULL。
    // 注意：JSON 下 Option<Option<String>> 无法表达 Some(None)，故用独立布尔标志（同 clear_parent）。
    pub clear_reminder: Option<bool>,
    // 清空备注：传 true 时把 note 置 NULL（与 clear_reminder 同一范式；
    // 否则 JSON 里 note=null 会被反序列化为 None，导致「不更新该列」而清不掉）。
    pub clear_note: Option<bool>,
    pub time_slot: Option<String>,
    pub show_in_next: Option<i64>,
    pub order_index: Option<i64>,
    pub completed_time: Option<String>,
    pub reminder_time: Option<String>,
    pub reminder_done: Option<i64>,
    pub wait_auto_next: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ConvertInput {
    pub title: String,
    pub note: Option<String>,
    pub category: String,
    pub deadline_type: Option<String>,
    pub deadline_date: Option<String>,
    pub priority: Option<i64>,
    pub reminder_time: Option<String>,
}

// ---- 行映射 ----

const SELECT_COLS: &str = "id, title, note, category, status, deadline_type, \
deadline_date, priority, created_time, completed_time, updated_time, \
parent_id, show_in_next, deleted, order_index, reminder_time, reminder_done, time_slot, \
sync_id, deleted_at, wait_auto_next";

fn row_to_tx(row: &rusqlite::Row) -> Transaction {
    Transaction {
        id: row.get(0).unwrap(),
        title: row.get(1).unwrap(),
        note: row.get(2).unwrap(),
        category: row.get(3).unwrap(),
        status: row.get(4).unwrap(),
        deadline_type: row.get(5).unwrap(),
        deadline_date: row.get(6).unwrap(),
        priority: row.get(7).unwrap(),
        created_time: row.get(8).unwrap(),
        completed_time: row.get(9).unwrap(),
        updated_time: row.get(10).unwrap(),
        parent_id: row.get(11).unwrap(),
        show_in_next: row.get(12).unwrap(),
        deleted: row.get(13).unwrap(),
        order_index: row.get(14).unwrap(),
        reminder_time: row.get(15).unwrap(),
        reminder_done: row.get(16).unwrap(),
        time_slot: row.get(17).unwrap(),
        sync_id: row.get(18).unwrap(),
        deleted_at: row.get(19).unwrap(),
        wait_auto_next: row.get(20).unwrap(),
    }
}

fn get_by_id(conn: &Connection, id: i64) -> Result<Transaction, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {SELECT_COLS} FROM transactions WHERE id = ? AND deleted = 0"))
        .map_err(|e| e.to_string())?;
    let tx = stmt
        .query_row(rusqlite::params![id], |row| Ok(row_to_tx(row)))
        .map_err(|e| e.to_string())?;
    Ok(tx)
}

// ---- Tauri 命令 ----

#[tauri::command]
pub fn list_transactions(
    state: State<Db>,
    query: Option<TransactionQuery>,
) -> Result<Vec<Transaction>, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut sql = format!("SELECT {SELECT_COLS} FROM transactions WHERE deleted = 0");
    let mut conds: Vec<String> = Vec::new();
    let q = query.unwrap_or(TransactionQuery {
        status: None,
        category: None,
        parent_id: None,
    });
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(s) = q.status {
        conds.push("status = ?".into());
        params.push(Box::new(s));
    }
    if let Some(c) = q.category {
        match c {
            Some(cat) => {
                conds.push("category = ?".into());
                params.push(Box::new(cat));
            }
            None => conds.push("category IS NULL".into()),
        }
    }
    if let Some(p) = q.parent_id {
        match p {
            Some(pid) => {
                conds.push("parent_id = ?".into());
                params.push(Box::new(pid));
            }
            None => conds.push("parent_id IS NULL".into()),
        }
    }
    if !conds.is_empty() {
        sql.push_str(" AND ");
        sql.push_str(&conds.join(" AND "));
    }
    sql.push_str(" ORDER BY created_time DESC");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(param_refs), |row| Ok(row_to_tx(row)))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn get_transaction(state: State<Db>, id: i64) -> Result<Transaction, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    get_by_id(&conn, id)
}

#[tauri::command]
pub fn create_transaction(
    state: State<Db>,
    input: NewTransactionInput,
) -> Result<Transaction, String> {
    // 0.1.19：后端校验标题——前端已拦，此为兜底：空标题（去空格）或超长都拒绝。
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    if title.chars().count() > 200 {
        return Err("标题过长（最多 200 字）".into());
    }
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now().to_rfc3339();
    let status = input.status.unwrap_or_else(|| "inbox".into());
    let deadline_type = input.deadline_type.unwrap_or_else(|| "none".into());
    let time_slot = input.time_slot.unwrap_or_else(|| "none".into());
    // 0.1.19：sync_id——前端带来则用（理论上不应），否则后端生成 UUID v4
    let sync_id = input.sync_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    conn.execute(
        "INSERT INTO transactions \
         (title, note, category, status, deadline_type, deadline_date, priority, reminder_time, time_slot, sync_id, created_time, parent_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            title,
            input.note,
            input.category,
            status,
            deadline_type,
            input.deadline_date,
            input.priority,
            input.reminder_time,
            time_slot,
            sync_id,
            now,
            input.parent_id
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    get_by_id(&conn, id)
}

#[tauri::command]
pub fn update_transaction(
    state: State<Db>,
    id: i64,
    patch: PatchInput,
) -> Result<Transaction, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut sets: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    macro_rules! add {
        ($col:expr, $val:expr) => {
            sets.push(format!("{} = ?", $col));
            params.push(Box::new($val));
        };
    }
    if let Some(v) = patch.title {
        // 0.1.19：后端兜底校验标题——清空（去空格）或超长都拒绝改写。
        let t = v.trim().to_string();
        if t.is_empty() {
            return Err("标题不能为空".into());
        }
        if t.chars().count() > 200 {
            return Err("标题过长（最多 200 字）".into());
        }
        add!("title", t);
    }
    // 0.1.20：清空备注用独立布尔标志 clear_note（JSON 无法表达 Some(None)）。
    // clear_note=true → 置 NULL；否则 patch.note 为 Some(v) 时照常写入（含 Some("") 空串）。
    if let Some(true) = patch.clear_note {
        add!("note", Option::<String>::None);
    } else if let Some(v) = patch.note {
        add!("note", v);
    }
    if let Some(v) = patch.category {
        add!("category", v);
    }
    if let Some(v) = patch.status {
        add!("status", v);
    }
    if let Some(v) = patch.deadline_type {
        add!("deadline_type", v);
    }
    if let Some(v) = patch.deadline_date {
        add!("deadline_date", v);
    }
    if let Some(v) = patch.priority {
        add!("priority", v);
    }
    if let Some(true) = patch.clear_parent {
        add!("parent_id", Option::<i64>::None);
    } else if let Some(v) = patch.parent_id {
        add!("parent_id", v);
    }
    if let Some(v) = patch.time_slot {
        add!("time_slot", v);
    }
    if let Some(v) = patch.show_in_next {
        add!("show_in_next", v);
    }
    if let Some(v) = patch.order_index {
        add!("order_index", v);
    }
    if let Some(v) = patch.completed_time {
        add!("completed_time", v);
    }
    if let Some(true) = patch.clear_reminder {
        add!("reminder_time", Option::<String>::None);
    } else if let Some(v) = patch.reminder_time {
        add!("reminder_time", v);
    }
    if let Some(v) = patch.reminder_done {
        add!("reminder_done", v);
    }
    if let Some(v) = patch.wait_auto_next {
        add!("wait_auto_next", v);
    }
    add!("updated_time", chrono::Utc::now().to_rfc3339());

    if sets.is_empty() {
        return get_by_id(&conn, id);
    }
    let sql = format!("UPDATE transactions SET {} WHERE id = ?", sets.join(", "));
    params.push(Box::new(id));
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, rusqlite::params_from_iter(param_refs))
        .map_err(|e| e.to_string())?;
    get_by_id(&conn, id)
}

// 软删除（连带子树）
#[tauri::command]
pub fn delete_transaction(state: State<Db>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now().to_rfc3339();
    // 0.1.20：删除父事务时，连带其全部子事务（任意层级）一起软删除进回收站，
    // 避免子项滞留为「孤儿」——既不在回收站（deleted=0）、又因父被删而不在 Project 视图，凭空消失。
    // 用递归 CTE 收集「id 自身 + 所有后代」，再统一置 deleted=1。
    conn.execute(
        r#"WITH RECURSIVE sub(id) AS (
            SELECT id FROM transactions WHERE id = ?1
            UNION ALL
            SELECT t.id FROM transactions t JOIN sub ON t.parent_id = sub.id
        )
        UPDATE transactions SET deleted = 1, deleted_at = ?2, updated_time = ?3
        WHERE id IN (SELECT id FROM sub)"#,
        params![id, now.clone(), now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// Inbox 原地转换：强制重填标题/备注并写入分类，status 置 active
#[tauri::command]
pub fn convert_inbox(
    state: State<Db>,
    id: i64,
    input: ConvertInput,
) -> Result<Transaction, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now().to_rfc3339();
    let deadline_type = input.deadline_type.unwrap_or_else(|| "none".into());
    conn.execute(
        "UPDATE transactions SET title = ?1, note = ?2, category = ?3, status = 'active', \
         deadline_type = ?4, deadline_date = ?5, priority = ?6, reminder_time = ?7, \
         reminder_done = 0, updated_time = ?8 WHERE id = ?9",
        params![
            input.title,
            input.note,
            input.category,
            deadline_type,
            input.deadline_date,
            input.priority,
            input.reminder_time,
            now,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    get_by_id(&conn, id)
}

// ---- 回收站（管理软删除内容） ----

// 列出所有已软删除（deleted=1）的事务，按最近删除时间倒序
#[tauri::command]
pub fn list_deleted(state: State<Db>) -> Result<Vec<Transaction>, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLS} FROM transactions WHERE deleted = 1 ORDER BY updated_time DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok(row_to_tx(row)))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// 恢复（只连带「自身 + 所有祖先（向上到根）」；后代（子/孙）不动，留在回收站由用户自行决定）
#[tauri::command]
pub fn restore_transaction(state: State<Db>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    // 0.1.20：恢复时只拉「自身 + 所有祖先（up，向上到根）」。
    // 这样恢复父事务不会把子/孙一并拉回；恢复子事务仍会把它到根的所有祖先一并拉回（保持可见、不产生孤儿）。
    // 后代（down）不再自动恢复，由用户在回收站里逐个自行恢复。
    conn.execute(
        r#"WITH RECURSIVE up(id, parent_id) AS (
            SELECT id, parent_id FROM transactions WHERE id = ?1
            UNION ALL
            SELECT p.id, p.parent_id FROM transactions p JOIN up ON p.id = up.parent_id
        )
        UPDATE transactions SET deleted = 0, deleted_at = NULL, updated_time = ?2
        WHERE id IN (SELECT id FROM up)"#,
        params![id, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// 彻底删除（连带子树）
#[tauri::command]
pub fn purge_transaction(state: State<Db>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    // 0.1.20：彻底删除父事务时，物理移除其全部子事务（任意层级）。
    // 不再需要先解除子项 parent_id 引用——递归 CTE 直接收集整棵子树一并删除；
    // 旧的「活子项提升顶层」逻辑在此场景下已无必要（子项随父一起进回收站、一起被清）。
    conn.execute(
        r#"WITH RECURSIVE sub(id) AS (
            SELECT id FROM transactions WHERE id = ?1
            UNION ALL
            SELECT t.id FROM transactions t JOIN sub ON t.parent_id = sub.id
        )
        DELETE FROM transactions WHERE id IN (SELECT id FROM sub)"#,
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// 清空所有数据：物理删除全部事务，回到空库（卸载前清理或重置用）。
// 0.2.0：两步确认由前端负责，后端只执行删除。
#[tauri::command]
pub fn reset_all_data(state: State<Db>) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute("DELETE FROM transactions", [])
        .map_err(|e| e.to_string())?;
    // 重置自增序列（若存在），让新记录 id 从 1 开始。
    let _ = conn.execute("DELETE FROM sqlite_sequence WHERE name = 'transactions'", []);
    Ok(())
}

// 清空回收站：删除全部已软删除的记录
#[tauri::command]
pub fn empty_trash(state: State<Db>) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    // 0.1.20：递归收集所有 deleted=1 事务的子树（含历史遗留的孤儿活子项），一并物理删除，
    // 不再需要「先提升活子项为顶层」的预处理。
    conn.execute(
        r#"WITH RECURSIVE sub(id) AS (
            SELECT id FROM transactions WHERE deleted = 1
            UNION ALL
            SELECT t.id FROM transactions t JOIN sub ON t.parent_id = sub.id
        )
        DELETE FROM transactions WHERE id IN (SELECT id FROM sub)"#,
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- 数据导出 / 导入（备份与迁移，0.1.13） ----
// 导入行结构：与 transactions 表列一一对应（含 id，便于 upsert 保留父子关系）
#[derive(Debug, Deserialize)]
pub struct ImportRow {
    pub id: i64,
    pub title: String,
    pub note: Option<String>,
    pub category: Option<String>,
    pub status: String,
    pub deadline_type: String,
    pub deadline_date: Option<String>,
    pub priority: Option<i64>,
    pub created_time: String,
    pub completed_time: Option<String>,
    pub updated_time: Option<String>,
    pub parent_id: Option<i64>,
    pub show_in_next: i64,
    pub deleted: i64,
    pub order_index: Option<i64>,
    pub reminder_time: Option<String>,
    pub reminder_done: i64,
    pub time_slot: String,
    pub sync_id: Option<String>,   // 0.1.19
    pub deleted_at: Option<String>, // 0.1.19
    pub wait_auto_next: Option<i64>, // 1.0.2
}

// 导入文件信封：0.2.0 起导出为 { exported_at, transactions }，便于导入时显示真实备份日期。
// 旧版纯数组备份无信封，读取时回退到「最新记录的 updated_time」。
#[derive(Debug, Deserialize)]
pub struct BackupEnvelope {
    pub exported_at: Option<String>,
    pub transactions: Vec<ImportRow>,
}

// 读取备份元信息（供前端确认弹窗显示「哪天备份 / 多少条」）。
#[derive(Debug, Serialize)]
pub struct BackupMeta {
    pub path: String,
    pub exported_at: Option<String>,
    pub count: usize,
    pub latest_updated: Option<String>,
}

// 导出：把所有事务（含已软删除）序列化为 JSON，经系统「保存文件」对话框写出。
// 返回 "ok" / "cancelled"（用户取消）。
#[tauri::command]
pub fn export_data(app: tauri::AppHandle, state: State<Db>) -> Result<String, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLS} FROM transactions ORDER BY id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok(row_to_tx(row)))
        .map_err(|e| e.to_string())?;
    let mut out: Vec<Transaction> = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    // query_map 的迭代器与 stmt 仍借用 conn，需先释放 stmt 再释放 conn
    drop(stmt);
    drop(conn);

    // 0.2.0：导出包成信封 { exported_at, transactions }，exported_at 为真实备份时间（本地时区），
    // 而非各记录里最新的 updated_time；文件名默认带日期，便于区分多次备份。
    let exported_at = chrono::Local::now().to_rfc3339();
    let envelope = serde_json::json!({ "exported_at": exported_at, "transactions": out });
    let json = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let path = app
        .dialog()
        .file()
        .set_file_name(&format!("nowtree-backup-{}.json", date))
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    match path {
        Some(p) => {
            // FilePath 不实现 AsRef<Path>，需先 into_path() 转成 PathBuf
            let pbuf = p.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&pbuf, json).map_err(|e| e.to_string())?;
            Ok("ok".into())
        }
        None => Ok("cancelled".into()),
    }
}

// 解析导入内容：优先信封 { exported_at, transactions }，失败回退旧版纯数组。
fn parse_import_rows(content: &str) -> Result<Vec<ImportRow>, String> {
    if let Ok(env) = serde_json::from_str::<BackupEnvelope>(content) {
        return Ok(env.transactions);
    }
    serde_json::from_str::<Vec<ImportRow>>(content).map_err(|e| e.to_string())
}

// 读取备份元信息：经系统「打开文件」对话框选文件，解析后返回日期/条数供前端确认弹窗。
// 用户取消返回 None。路径一并带回，确认后由 import_data 直接读取该路径。
#[tauri::command]
pub fn read_backup_meta(app: tauri::AppHandle) -> Result<Option<BackupMeta>, String> {
    let path = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(p) = path else {
        return Ok(None);
    };
    let pbuf = p.into_path().map_err(|e| e.to_string())?;
    let content = std::fs::read_to_string(&pbuf).map_err(|e| e.to_string())?;
    let (exported_at, rows) = if let Ok(env) = serde_json::from_str::<BackupEnvelope>(&content) {
        (env.exported_at, env.transactions)
    } else {
        let rows = serde_json::from_str::<Vec<ImportRow>>(&content).map_err(|e| e.to_string())?;
        (None, rows)
    };
    // 旧版无信封时，用最新记录的 updated_time 近似「备份日期」。
    let latest = rows.iter().filter_map(|r| r.updated_time.clone()).max();
    Ok(Some(BackupMeta {
        path: pbuf.to_string_lossy().to_string(),
        exported_at,
        count: rows.len(),
        latest_updated: latest,
    }))
}

// 导入：接收已选文件路径，逐行 upsert（同 id 覆盖，新 id 插入），保留父子关系。
// 返回结构化 { count }（C10：替代原先 "imported N" 字符串，前端不再靠正则抠数字）。
// 文件选择由 read_backup_meta 先行完成（以便确认弹窗）。
#[derive(Serialize)]
pub struct ImportResult {
    pub count: usize,
}
#[tauri::command]
pub fn import_data(state: State<Db>, path: String) -> Result<ImportResult, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let rows = parse_import_rows(&content)?;
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    for r in &rows {
        conn.execute(
            "INSERT OR REPLACE INTO transactions \
             (id, title, note, category, status, deadline_type, deadline_date, priority, \
              created_time, completed_time, updated_time, parent_id, show_in_next, deleted, \
              order_index, reminder_time, reminder_done, time_slot, sync_id, deleted_at, wait_auto_next) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![
                r.id,
                r.title,
                r.note,
                r.category,
                r.status,
                r.deadline_type,
                r.deadline_date,
                r.priority,
                r.created_time,
                r.completed_time,
                r.updated_time,
                r.parent_id,
                r.show_in_next,
                r.deleted,
                r.order_index,
                r.reminder_time,
                r.reminder_done,
                r.time_slot,
                r.sync_id,
                r.deleted_at,
                r.wait_auto_next.unwrap_or(0)
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    drop(conn);
    Ok(ImportResult { count: rows.len() })
}

// ---- 开机自启动（0.1.13，借助 tauri-plugin-autostart） ----
// 注意：tauri-plugin-autostart 2.5.x 的 trait 方法名为 autolaunch()（非 autostart()），
// 返回 State<AutoLaunchManager>，其自带 enable()/disable()/is_enabled()。
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enable: bool) -> Result<bool, String> {
    let m = app.autolaunch();
    if enable {
        m.enable().map_err(|e| e.to_string())?;
    } else {
        m.disable().map_err(|e| e.to_string())?;
    }
    m.is_enabled().map_err(|e| e.to_string())
}

// ---- 最小化到托盘 / 退出（0.2.0 关闭确认框使用） ----
// 关闭窗口时不再由 Rust 直接 hide，而是 emit 事件给前端弹确认框；
// 用户选「最小化到托盘」→ invoke 此命令真正隐藏；选「退出」→ invoke quit_app 真正退出。
#[tauri::command]
pub fn minimize_to_tray(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // 1.1.5：关闭确认时窗口会被临时置顶，隐藏前先复位，避免下次显示仍压在最上层。
        let _ = w.set_always_on_top(false);
        #[cfg(target_os = "windows")]
        let _ = w.set_skip_taskbar(true);
        let _ = w.hide();
    }
}

// 1.1.5：关闭确认框弹出前，把主窗口强制提到最前（含从最小化 / 托盘隐藏恢复）。
// 只发事件不激活窗口时，窗口压在其它程序下面，用户看不到确认框、还得先手动调出窗口。
#[tauri::command]
pub fn bring_main_to_front(app: tauri::AppHandle) {
    crate::bring_main_front_topmost(&app);
}

// 1.1.5：取消 / 选择关闭方式后解除临时置顶，恢复正常窗口层级。
#[tauri::command]
pub fn release_main_topmost(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(false);
    }
}

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

