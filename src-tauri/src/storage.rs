//! Sessions remain schema-compatible. Budget enforcement uses projected UTF-8 logical
//! bytes plus SQLite overhead, not file length (freelist pages are reusable).
use crate::scoring::canonical_augment;
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
const MAX_SESSION: usize = 8 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL)";
fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let p = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
fn db(app: &AppHandle) -> Result<Connection, String> {
    let c = Connection::open(dir(app)?.join("sessions.sqlite3")).map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    c.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(c)
}
fn sanitized_settings(v: &Value) -> (u64, u64) {
    (
        v["budgetMb"].as_u64().unwrap_or(128).clamp(32, 2048),
        v["retentionDays"].as_u64().unwrap_or(7).clamp(1, 365),
    )
}
fn settings(app: &AppHandle) -> Result<(u64, u64), String> {
    let p = dir(app)?.join("storage-settings.json");
    match fs::read_to_string(p) {
        Ok(s) => Ok(sanitized_settings(
            &serde_json::from_str(&s).unwrap_or(Value::Null),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((128, 7)),
        Err(e) => Err(e.to_string()),
    }
}
fn save_settings(app: &AppHandle, b: u64, d: u64) -> Result<(), String> {
    let p = dir(app)?.join("storage-settings.json");
    let tmp = p.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(
        &tmp,
        serde_json::to_vec(&json!({"version":1,"budgetMb":b,"retentionDays":d}))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(tmp);
        e.to_string()
    })
}
fn parse(s: &str) -> Result<Value, String> {
    serde_json::from_str(s).map_err(|e| format!("Invalid stored session JSON: {e}"))
}
fn logical_bytes(c: &Connection) -> Result<u64, String> {
    c.query_row(
        "SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM sessions",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn db_bytes(c: &Connection) -> Result<u64, String> {
    c.query_row(
        "SELECT page_count*page_size FROM pragma_page_count(),pragma_page_size()",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn sample_count(v: &Value) -> u64 {
    match v {
        Value::Object(o) => o
            .iter()
            .map(|(k, v)| {
                if k == "samples" {
                    v.as_array().map_or(0, |a| a.len() as u64)
                } else {
                    sample_count(v)
                }
            })
            .sum(),
        Value::Array(a) => a.iter().map(sample_count).sum(),
        _ => 0,
    }
}
fn timestamp(v: &Value) -> Option<DateTime<Utc>> {
    v.as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}
// Only decision snapshots lose redundant samples and recursive histories. Facts,
// recommendation results, chosen IDs, and raw decision evidence are retained.
fn strip_context(v: &mut Value) {
    match v {
        Value::Object(o) => {
            o.remove("samples");
            o.remove("decisions");
            for x in o.values_mut() {
                strip_context(x)
            }
        }
        Value::Array(a) => {
            for x in a {
                strip_context(x)
            }
        }
        _ => {}
    }
}
fn sanitize(v: &mut Value) {
    if let Some(ds) = v.get_mut("decisions").and_then(Value::as_array_mut) {
        for d in ds {
            if let Some(c) = d.get_mut("context") {
                strip_context(c)
            }
        }
    }
    cap_samples(v);
}
fn cap_samples(v: &mut Value) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                if k == "samples" {
                    if let Some(a) = x.as_array_mut() {
                        if a.len() > 30 {
                            a.drain(..a.len() - 30);
                        }
                    }
                }
                cap_samples(x)
            }
        }
        Value::Array(a) => {
            for x in a {
                cap_samples(x)
            }
        }
        _ => {}
    }
}
fn prune_samples(v: &mut Value, cutoff: DateTime<Utc>, fallback: Option<DateTime<Utc>>, all: bool) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                if k == "samples" {
                    if let Some(a) = x.as_array_mut() {
                        a.retain(|s| {
                            !all && !s
                                .get("at")
                                .or_else(|| s.get("timestamp"))
                                .or_else(|| s.get("capturedAt"))
                                .and_then(timestamp)
                                .or(fallback)
                                .is_some_and(|t| t < cutoff)
                        });
                    }
                }
                prune_samples(x, cutoff, fallback, all)
            }
        }
        Value::Array(a) => {
            for x in a {
                prune_samples(x, cutoff, fallback, all)
            }
        }
        _ => {}
    }
}
fn stats(c: &Connection, b: u64, d: u64) -> Result<Value, String> {
    let count: u64 = c
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut q = c
        .prepare("SELECT data FROM sessions")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut samples = 0;
    for r in rows {
        samples += sample_count(&parse(&r.map_err(|e| e.to_string())?)?);
    }
    Ok(
        json!({"databaseBytes":db_bytes(c)?,"sessionCount":count,"sampleCount":samples,"budgetMb":b,"retentionDays":d}),
    )
}
#[tauri::command]
pub fn storage_stats(app: AppHandle) -> Result<Value, String> {
    let (b, d) = settings(&app)?;
    stats(&db(&app)?, b, d)
}
#[tauri::command]
pub fn delete_session(app: AppHandle, id: String) -> Result<(), String> {
    let mut c = db(&app)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sessions WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
fn remove_analysis(v: &mut Value, at: &str) {
    if let Some(a) = v.get_mut("decisions").and_then(Value::as_array_mut) {
        a.retain(|d| d["at"].as_str() != Some(at));
    }
    if let Some(o) = v.as_object_mut() {
        o.insert("review".into(), Value::Null);
    }
}
#[tauri::command]
pub fn delete_analysis(app: AppHandle, session_id: String, at: String) -> Result<Value, String> {
    let mut c = db(&app)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let raw: String = tx
        .query_row(
            "SELECT data FROM sessions WHERE id=?1",
            params![session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut v = parse(&raw)?;
    remove_analysis(&mut v, &at);
    tx.execute(
        "UPDATE sessions SET data=?1,updated_at=?2 WHERE id=?3",
        params![v.to_string(), Utc::now().to_rfc3339(), session_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(v)
}
fn maintain(c: &mut Connection, budget: u64, days: u64) -> Result<u64, String> {
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String)> = {
        let mut q = tx
            .prepare("SELECT id,'',updated_at FROM sessions ORDER BY updated_at ASC,id ASC")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let cutoff = Utc::now() - Duration::days(days as i64);
    let mut removed = 0;
    for (id, _, updated) in &rows {
        let raw: String = tx
            .query_row("SELECT data FROM sessions WHERE id=?1", params![id], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let mut v = parse(&raw)?;
        let before = sample_count(&v);
        prune_samples(&mut v, cutoff, timestamp(&json!(updated)), false);
        sanitize(&mut v);
        removed += before.saturating_sub(sample_count(&v));
        let next = v.to_string();
        if next != raw {
            tx.execute("UPDATE sessions SET data=?1 WHERE id=?2", params![next, id])
                .map_err(|e| e.to_string())?;
        }
    }
    // Finite oldest-record-first pass. No core decision/review deletion, ever.
    for (id, _, updated) in &rows {
        if logical_bytes(&tx)? + 16384 <= budget {
            break;
        }
        let raw: String = tx
            .query_row("SELECT data FROM sessions WHERE id=?1", params![id], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        let mut v = parse(&raw)?;
        let before = sample_count(&v);
        prune_samples(&mut v, cutoff, None, true);
        removed += before.saturating_sub(sample_count(&v));
        let archived = v["archived"].as_bool() == Some(true)
            || v["status"].as_str() == Some("archived")
            || v["result"]["status"]
                .as_str()
                .is_some_and(|s| matches!(s, "win" | "loss"))
            || v["endedAt"].is_string();
        if archived && timestamp(&json!(updated)).is_some_and(|t| t < cutoff) {
            if let Some(o) = v.as_object_mut() {
                for k in ["liveData", "lcuSession", "endOfGame"] {
                    o.remove(k);
                }
            }
        }
        let next=v.to_string();
        if next != raw {
            tx.execute("UPDATE sessions SET data=?1 WHERE id=?2", params![next, id])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    // Do not rewrite the whole database on every maintenance tick.
    let pages: u64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let free: u64 = c.query_row("PRAGMA freelist_count", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let page_size: u64 = c.query_row("PRAGMA page_size", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if free * page_size >= 4 * MIB && free * 4 >= pages {
        c.execute_batch("VACUUM").map_err(|e| e.to_string())?;
    }
    Ok(removed)
}
#[tauri::command]
pub fn maintain_storage(
    app: AppHandle,
    budget_mb: u64,
    retention_days: u64,
) -> Result<Value, String> {
    if !(32..=2048).contains(&budget_mb) || !(1..=365).contains(&retention_days) {
        return Err("budget_mb must be 32..2048; retention_days must be 1..365".into());
    }
    let mut c = db(&app)?;
    let removed = maintain(&mut c, budget_mb * MIB, retention_days)?;
    save_settings(&app, budget_mb, retention_days)?;
    let mut out = stats(&c, budget_mb, retention_days)?;
    out["budgetReached"] = json!(db_bytes(&c)? <= budget_mb * MIB);
    out["removedSamples"] = json!(removed);
    Ok(out)
}
fn light(mut v: Value) -> Value {
    let count = sample_count(&v);
    if let Some(o) = v.as_object_mut() {
        for k in ["liveData", "samples", "lcuSession", "endOfGame"] {
            o.remove(k);
        }
        o.insert("sampleCount".into(), json!(count));
        if let Some(ds) = o.get_mut("decisions").and_then(Value::as_array_mut) {
            for d in ds {
                let at = d["at"].clone();
                let chosen = d["chosenId"].clone();
                *d = json!({"at":at,"chosenId":chosen});
            }
        }
    }
    v
}
// 档案页只列有内容的记录：对局结束重新排队时出现的空壳（无玩家、无分析、也没有任何
// 手动补充）以及存量的同类空行都不进列表；它们仍留在库里，等待被复用。
const ARCHIVE_CONTENT: &str = "CASE WHEN json_valid(data) THEN \
 CASE json_type(data,'$.players') WHEN 'array' THEN json_array_length(data,'$.players') ELSE 0 END>0 \
 OR CASE json_type(data,'$.decisions') WHEN 'array' THEN json_array_length(data,'$.decisions') ELSE 0 END>0 \
 OR COALESCE(json_extract(data,'$.notes'),'')<>'' \
 OR COALESCE(json_extract(data,'$.outcome'),'')<>'' \
 OR json_extract(data,'$.review') IS NOT NULL \
 OR (json_extract(data,'$.result.status') IS NOT NULL AND json_extract(data,'$.result.status')<>'unknown') \
 ELSE 1 END";
fn light_page(c: &Connection, offset: i64) -> Result<Vec<Value>, String> {
    let mut q = c
        .prepare(&format!(
            "SELECT data FROM sessions WHERE {ARCHIVE_CONTENT} ORDER BY updated_at DESC,id DESC LIMIT 50 OFFSET ?1"
        ))
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map(params![offset], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| parse(&r.map_err(|e| e.to_string())?).map(light)).collect()
}
#[tauri::command]
pub fn list_sessions_light(app: AppHandle, offset: Option<u64>) -> Result<Vec<Value>, String> {
    light_page(&db(&app)?, offset.unwrap_or(0).min(i64::MAX as u64) as i64)
}
// 同英雄历史相似度：本地规则，不调模型。集合是「候选/已选海克斯归一后的 ID」，
// 相似度 = Jaccard(本局候选∪本局已选, 那局实际选择∪那局已选)，认不出的文本不进集合。
const SIM_SCAN: i64 = 200;
const SIM_LIMIT: u64 = 5;
fn own_player(s: &Value) -> Option<&Value> {
    let own = s["ownPlayerId"].as_str()?;
    if own.is_empty() {
        return None;
    }
    s["players"]
        .as_array()?
        .iter()
        .find(|p| p["id"].as_str() == Some(own))
}
fn collect_ids<'a>(items: impl Iterator<Item = &'a str>, out: &mut BTreeSet<String>) {
    for raw in items {
        if let Some(id) = canonical_augment(raw) {
            out.insert(id);
        }
    }
}
fn player_augments(s: &Value) -> Vec<String> {
    own_player(s)
        .and_then(|p| p["augments"].as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .take(6)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
/// 本局视角：候选海克斯（id 与名字都试）+ 自己已选海克斯。
fn current_set(s: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for c in s["candidates"].as_array().into_iter().flatten() {
        for key in ["id", "name"] {
            if let Some(v) = c[key].as_str() {
                if let Some(id) = canonical_augment(v) {
                    out.insert(id);
                }
            }
        }
    }
    let own = player_augments(s);
    collect_ids(own.iter().map(String::as_str), &mut out);
    out
}
/// 历史视角：当时实际选择过的 + 那局已选海克斯，不带当时没选中的候选。
fn past_set(s: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let chosen = chosen_names(s);
    collect_ids(chosen.iter().map(String::as_str), &mut out);
    let own = player_augments(s);
    collect_ids(own.iter().map(String::as_str), &mut out);
    out
}
/// decisions[].chosenId 是候选槽位 ID，先映射回候选名字（认不出来时退回 ID 本身）。
fn chosen_names(s: &Value) -> Vec<String> {
    let Some(ds) = s["decisions"].as_array() else {
        return Vec::new();
    };
    let candidates = s["candidates"].as_array();
    ds.iter()
        .filter_map(|d| {
            let id = d["chosenId"].as_str()?;
            let name = candidates
                .and_then(|cs| {
                    cs.iter()
                        .find(|c| c["id"].as_str() == Some(id))
                        .and_then(|c| c["name"].as_str())
                })
                .filter(|n| !n.trim().is_empty())
                .unwrap_or(id);
            Some(name.to_string())
        })
        .collect()
}
fn overlap(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count();
    let union = a.len() + b.len() - inter;
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}
/// 归一 ID -> 展示名（用本局与历史局的候选名，先到先得，剩下的退回 ID）。
fn collect_display(s: &Value, map: &mut BTreeMap<String, String>) {
    for c in s["candidates"].as_array().into_iter().flatten() {
        let name = c["name"].as_str().unwrap_or("");
        if name.trim().is_empty() {
            continue;
        }
        for raw in [c["id"].as_str().unwrap_or(""), name] {
            if let Some(id) = canonical_augment(raw) {
                map.entry(id).or_insert_with(|| name.to_string());
            }
        }
    }
}
fn clip(v: &Value, max: usize) -> String {
    v.as_str().unwrap_or("").chars().take(max).collect()
}
fn clip_list(v: &Value, n: usize, max: usize) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|x| clip(x, max)).take(n).collect())
        .unwrap_or_default()
}
fn sim_entry(
    current: &Value,
    past: &Value,
    cur_set: &BTreeSet<String>,
    display: &BTreeMap<String, String>,
) -> Value {
    let p = past_set(past);
    let champ = own_player(past)
        .and_then(|p| p["champion"].as_str())
        .unwrap_or("");
    let sim = overlap(cur_set, &p);
    let matched: Vec<String> = cur_set
        .intersection(&p)
        .map(|id| display.get(id).cloned().unwrap_or_else(|| id.clone()))
        .take(6)
        .collect();
    let same = {
        let cur = own_player(current)
            .and_then(|p| p["champion"].as_str())
            .unwrap_or("");
        !cur.is_empty() && !champ.is_empty() && cur == champ
    };
    let mut chosen = chosen_names(past);
    let chosen = chosen.pop();
    let id = past["id"].as_str().unwrap_or("");
    let mut e = serde_json::Map::new();
    e.insert("id".into(), json!(id));
    if let Some(v) = past.get("createdAt") {
        e.insert("createdAt".into(), v.clone());
    }
    if let Some(v) = past.get("updatedAt") {
        e.insert("updatedAt".into(), v.clone());
    }
    e.insert("ownChampion".into(), json!(champ));
    e.insert("ownAugments".into(), json!(player_augments(past)));
    if let Some(c) = chosen.filter(|c| !c.trim().is_empty()) {
        e.insert("chosen".into(), json!(c));
    }
    if !past["result"].is_null() {
        e.insert("result".into(), past["result"].clone());
    }
    if !past["outcome"].as_str().unwrap_or("").is_empty() {
        e.insert("outcome".into(), json!(clip(&past["outcome"], 1000)));
    }
    if past["review"].is_object() {
        e.insert(
            "review".into(),
            json!({
                "summary": clip(&past["review"]["summary"], 1500),
                "lessons": clip_list(&past["review"]["lessons"], 5, 400),
                "caveats": clip_list(&past["review"]["caveats"], 3, 300),
            }),
        );
    }
    e.insert("similarity".into(), json!((sim * 100.0).round() / 100.0));
    e.insert("matched".into(), json!(matched));
    e.insert("sameChampion".into(), json!(same));
    Value::Object(e)
}
/// 最近 SIM_SCAN 条档案里挑最像的 limit 条：同英雄优先，其次相似度，再按时间倒序。
pub fn similar_sessions(
    c: &Connection,
    current: &Value,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let cur_set = current_set(current);
    let cur_id = current["id"].as_str().unwrap_or("");
    let cur_champ = own_player(current)
        .and_then(|p| p["champion"].as_str())
        .unwrap_or("");
    let mut display = BTreeMap::new();
    collect_display(current, &mut display);
    let mut rows = Vec::new();
    {
        let mut q = c
            .prepare(&format!(
                "SELECT data FROM sessions WHERE {ARCHIVE_CONTENT} AND id<>?1 \
                 ORDER BY updated_at DESC,id DESC LIMIT ?2"
            ))
            .map_err(|e| e.to_string())?;
        let mapped = q
            .query_map(params![cur_id, SIM_SCAN], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in mapped {
            let raw = row.map_err(|e| e.to_string())?;
            if let Ok(v) = parse(&raw) {
                rows.push(v);
            }
        }
    }
    let mut scored: Vec<(bool, f64, String, Value)> = Vec::new();
    for row in rows {
        if row["id"].as_str() == Some(cur_id) {
            continue;
        }
        // 有重叠、同英雄或写过复盘才算参考；三条都不占的对局不进模型也不进界面。
        let champ = own_player(&row)
            .and_then(|p| p["champion"].as_str())
            .unwrap_or("");
        let same = !cur_champ.is_empty() && !champ.is_empty() && cur_champ == champ;
        let past = past_set(&row);
        let sim = overlap(&cur_set, &past);
        if !(same || sim > 0.0 || row["review"].is_object()) {
            continue;
        }
        collect_display(&row, &mut display);
        let stamp = row["updatedAt"]
            .as_str()
            .or_else(|| row["createdAt"].as_str())
            .unwrap_or("")
            .to_string();
        let entry = sim_entry(current, &row, &cur_set, &display);
        scored.push((same, sim, stamp, entry));
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(
                b.1.partial_cmp(&a.1)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(b.2.cmp(&a.2))
    });
    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(_, _, _, e)| e)
        .collect())
}
#[tauri::command]
pub fn history_similarity(
    app: AppHandle,
    session: Value,
    limit: Option<u64>,
) -> Result<Value, String> {
    Ok(json!(similar_sessions(
        &db(&app)?,
        &session,
        limit.unwrap_or(SIM_LIMIT).min(20) as usize
    )?))
}
#[tauri::command]
pub fn get_session(app: AppHandle, id: String) -> Result<Value, String> {
    let raw: String = db(&app)?
        .query_row("SELECT data FROM sessions WHERE id=?1", params![id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    parse(&raw)
}
fn by_match(c: &Connection, id: &str) -> Result<Option<Value>, String> {
    let raw:Option<String>=c.query_row("SELECT data FROM sessions WHERE CASE WHEN json_valid(data) THEN CAST(json_extract(data,'$.matchId') AS TEXT)=?1 OR CAST(json_extract(data,'$.match.id') AS TEXT)=?1 ELSE 0 END ORDER BY updated_at DESC LIMIT 1",params![id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|s| parse(&s)).transpose()
}
#[tauri::command]
pub fn get_session_by_match(app: AppHandle, match_id: String) -> Result<Option<Value>, String> {
    let out = by_match(&db(&app)?, &match_id);
    out
}
fn export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let p = dir(app)?.join("exports");
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
fn export_file_name(prefix: &str, id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if (c as u32) < 0x20 => '-',
            c => c,
        })
        .collect();
    let trimmed = safe.trim().trim_matches('-');
    let stem: String = if trimmed.is_empty() {
        "unknown".into()
    } else {
        trimmed.chars().take(80).collect()
    };
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    format!("{prefix}-{stem}-{stamp}.json")
}
#[tauri::command]
pub fn export_session(app: AppHandle, session: Value) -> Result<String, String> {
    let id = session
        .get("matchId")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| session.get("id").and_then(Value::as_str))
        .unwrap_or("unknown");
    let path = export_dir(&app)?.join(export_file_name("对局", id));
    let text = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn export_history(app: AppHandle) -> Result<Value, String> {
    let c = db(&app)?;
    let mut q = c
        .prepare("SELECT data FROM sessions ORDER BY updated_at DESC,id DESC")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut sessions: Vec<Value> = Vec::new();
    let mut unreadable = 0usize;
    for row in rows {
        match serde_json::from_str::<Value>(&row.map_err(|e| e.to_string())?) {
            Ok(v) => sessions.push(v),
            Err(_) => unreadable += 1,
        }
    }
    let exported_at = chrono::Local::now().to_rfc3339();
    let payload = json!({
        "app": "Hexglow",
        "schema": 1,
        "exportedAt": exported_at,
        "sessionCount": sessions.len(),
        "unreadable": unreadable,
        "sessions": sessions
    });
    let stamp = chrono::Local::now().format("%Y%m%d");
    let path = export_dir(&app)?.join(export_file_name("全部对局", &stamp.to_string()));
    let text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let bytes = text.len();
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "count": sessions.len(),
        "bytes": bytes,
        "unreadable": unreadable
    }))
}
fn prepared(session: &Value) -> Result<(String, String), String> {
    let mut v = session.clone();
    let o = v.as_object_mut().ok_or("session must be object")?;
    let id = match o.get("id") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.clone(),
        None | Some(Value::Null) => Uuid::new_v4().to_string(),
        _ => return Err("session id must be a nonempty string".into()),
    };
    o.insert("id".into(), json!(id));
    sanitize(&mut v);
    let raw = serde_json::to_string(&v).map_err(|e| e.to_string())?;
    if raw.len() > MAX_SESSION {
        return Err("Session exceeds 8 MiB; remove raw samples before saving".into());
    }
    Ok((id, raw))
}
fn write_session(c: &mut Connection, session: &Value, budget: u64) -> Result<String, String> {
    let (id, raw) = prepared(session)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let old: u64 = tx
        .query_row(
            "SELECT length(CAST(data AS BLOB)) FROM sessions WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let logical = logical_bytes(&tx)?;
    let projected = logical.saturating_sub(old) + raw.len() as u64;
    // Reserve per-record pages plus 10% for B-tree/index overhead. This is a
    // logical budget guard, not a guarantee about transient journal/disk bytes.
    let count: u64 = tx
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let estimate = projected
        .saturating_add(projected / 10)
        .saturating_add((count + 1) * 4096)
        .saturating_add(16384);
    if estimate > budget {
        return Err("Storage budget exceeded. Run storage cleanup, delete unwanted sessions, or increase the budget before saving.".into());
    }
    tx.execute("INSERT INTO sessions(id,data,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",params![id,raw,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}
pub fn save(app: &AppHandle, session: &Value) -> Result<String, String> {
    let (b, _) = settings(app)?;
    write_session(&mut db(app)?, session, b * MIB)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn memory() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }
    #[test]
    fn preserves_decision_evidence() {
        let mut v = json!({"liveData":{"x":1},"samples":[1],"decisions":[{"at":"x","context":{"samples":[1],"decisions":[{"context":{}}],"liveData":{"hp":4}},"result":{"ranking":[1]},"chosenId":"c"}],"review":{"summary":"keep"}});
        sanitize(&mut v);
        assert_eq!(v["samples"], json!([1]));
        assert_eq!(v["decisions"][0]["context"]["liveData"]["hp"], 4);
        assert!(v["decisions"][0]["context"].get("decisions").is_none());
        assert_eq!(v["decisions"][0]["result"]["ranking"], json!([1]));
        assert_eq!(v["review"]["summary"], "keep");
    }
    #[test]
    fn caps_and_expires() {
        let mut v = json!({"samples":(0..50).map(|i|json!({"at":if i<25{"2000-01-01T00:00:00Z"}else{"2099-01-01T00:00:00Z"},"i":i})).collect::<Vec<_>>()});
        cap_samples(&mut v);
        assert_eq!(sample_count(&v), 30);
        assert_eq!(v["samples"][0]["i"], 20);
        prune_samples(&mut v, Utc::now(), None, false);
        assert_eq!(sample_count(&v), 25);
    }
    #[test]
    fn settings_and_validation() {
        assert_eq!(sanitized_settings(&Value::Null), (128, 7));
        assert_eq!(
            sanitized_settings(&json!({"budgetMb":9999,"retentionDays":0})),
            (2048, 1)
        );
        assert!(prepared(&json!([])).is_err());
        assert!(prepared(&json!({"id":2})).is_err());
        assert!(prepared(&json!({"payload":"x".repeat(MAX_SESSION)})).is_err());
    }
    #[test]
    fn sqlite_budget_and_unicode() {
        let mut c = memory();
        write_session(&mut c, &json!({"id":"a","matchId":123,"text":"中文"}), MIB).unwrap();
        assert_eq!(by_match(&c, "123").unwrap().unwrap()["id"], "a");
        let before = logical_bytes(&c).unwrap();
        assert!(write_session(&mut c, &json!({"id":"a","text":"x".repeat(10000)}), 100).is_err());
        assert_eq!(logical_bytes(&c).unwrap(), before);
    }
    #[test]
    fn history_similarity_prefers_same_champion_then_overlap() {
        let mut c = memory();
        let mk = |id: &str, champ: &str, aug: &str, chosen: &str, at: &str| {
            json!({
                "id": id, "createdAt": at, "updatedAt": at,
                "ownPlayerId": "me",
                "players": [{"id":"me","champion":champ,"augments":aug}],
                "candidates": [{"id":"1001","name":"泰坦的坚决"},{"id":"1002","name":"尖端发明家"}],
                "decisions": [{"at": at, "chosenId": chosen}],
                "result": {"status":"win","source":"manual"},
                "outcome": "按计划成型",
                "review": {"summary":"先手装更稳","lessons":["早做前排"],"caveats":[]}
            })
        };
        write_session(&mut c, &mk("a", "阿狸", "1001", "1001", "2026-01-03T00:00:00Z"), MIB).unwrap();
        write_session(&mut c, &mk("b", "阿狸", "", "1002", "2026-01-02T00:00:00Z"), MIB).unwrap();
        write_session(&mut c, &mk("c", "盖伦", "1001", "1001", "2026-01-01T00:00:00Z"), MIB).unwrap();
        write_session(&mut c, &mk("cur", "阿狸", "", "", "2026-01-04T00:00:00Z"), MIB).unwrap();
        // 异英雄 + 无重叠 + 没复盘：不构成参考，不进结果
        write_session(
            &mut c,
            &json!({"id":"d","createdAt":"2026-01-05T00:00:00Z","updatedAt":"2026-01-05T00:00:00Z",
                "ownPlayerId":"me","players":[{"id":"me","champion":"盖伦","augments":[]}],
                "candidates":[{"id":"1004","name":"回归基本功"}],"decisions":[],
                "result":{"status":"unknown","source":"unknown"},"outcome":""}),
            MIB,
        )
        .unwrap();
        let cur = json!({
            "id": "cur", "ownPlayerId": "me",
            "players": [{"id":"me","champion":"阿狸","augments":[]}],
            "candidates": [{"id":"1001","name":"泰坦的坚决"},{"id":"1002","name":"尖端发明家"}]
        });
        let out = similar_sessions(&c, &cur, 5).unwrap();
        let ids: Vec<&str> = out.iter().filter_map(|e| e["id"].as_str()).collect();
        // 同英雄优先，其次相似度，最后按时间倒序；自己不参与
        assert_eq!(ids, vec!["a", "b", "c"]);
        assert_eq!(out[0]["sameChampion"], json!(true));
        assert_eq!(out[2]["sameChampion"], json!(false));
        // 重叠显示名来自候选名，而不是槽位 ID
        assert_eq!(out[0]["matched"], json!(["泰坦的坚决"]));
        assert_eq!(out[0]["chosen"], json!("泰坦的坚决"));
        assert_eq!(out[0]["review"]["summary"], json!("先手装更稳"));
        assert_eq!(out[0]["outcome"], json!("按计划成型"));
        assert_eq!(out[0]["similarity"], json!(0.5));
        // 槽位 ID 与空名字认不出海克斯，不制造假重叠；排序仍按同英雄+时间
        let weak = json!({
            "id":"cur","ownPlayerId":"me",
            "players":[{"id":"me","champion":"阿狸","augments":[]}],
            "candidates":[{"id":"1","name":""},{"id":"2","name":""}]
        });
        let out2 = similar_sessions(&c, &weak, 5).unwrap();
        assert!(out2.iter().all(|e| e["similarity"].as_f64() == Some(0.0)));
        assert_eq!(out2[0]["id"], json!("a"));
        // limit 生效
        assert_eq!(similar_sessions(&c, &cur, 1).unwrap().len(), 1);
    }
    #[test]
    fn maintenance_keeps_core_and_persists_caps() {
        let mut c = memory();
        let v = json!({"id":"a","samples":(0..50).map(|_|json!({"at":"2099-01-01T00:00:00Z","raw":"x"})).collect::<Vec<_>>(),"decisions":[{"at":"core","context":{"liveData":{"hp":4}}}],"review":{"summary":"core"}});
        c.execute(
            "INSERT INTO sessions VALUES('a',?1,'2000-01-01T00:00:00Z')",
            params![v.to_string()],
        )
        .unwrap();
        maintain(&mut c, MIB, 7).unwrap();
        let raw: String = c
            .query_row("SELECT data FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sample_count(&parse(&raw).unwrap()), 30);
        maintain(&mut c, 1, 7).unwrap();
        let raw: String = c
            .query_row("SELECT data FROM sessions", [], |r| r.get(0))
            .unwrap();
        let v = parse(&raw).unwrap();
        assert_eq!(sample_count(&v), 0);
        assert_eq!(v["decisions"][0]["context"]["liveData"]["hp"], 4);
        assert_eq!(v["review"]["summary"], "core");
        assert!(db_bytes(&c).unwrap() > 1);
    }
    #[test]
    fn light_and_delete() {
        let mut v = json!({"samples":[1,2],"liveData":{"big":true},"decisions":[{"at":"a","context":{},"result":{},"chosenId":"c"},{"at":"b"}],"review":{"summary":"keep"}});
        let l = light(v.clone());
        assert_eq!(l["sampleCount"], 2);
        assert_eq!(l["decisions"][0], json!({"at":"a","chosenId":"c"}));
        assert_eq!(l["review"]["summary"], "keep");
        remove_analysis(&mut v, "a");
        assert_eq!(v["decisions"].as_array().unwrap().len(), 1);
        assert!(v["review"].is_null());
    }
    #[test]
    fn archive_listing_hides_empty_shells_but_keeps_them_stored() {
        let c = memory();
        let rows = [
            ("real", json!({"id":"real","matchId":"100","players":[{"id":"me","champion":"Ahri"}],"decisions":[],"notes":"","outcome":"","result":{"status":"win"}})),
            ("shell", json!({"id":"shell","matchId":"100","players":[],"decisions":[],"notes":"","outcome":"","result":{"status":"unknown"}})),
            ("notes", json!({"id":"notes","matchId":"","players":[],"decisions":[],"notes":"思路","outcome":"","result":{"status":"unknown"}})),
            ("decision", json!({"id":"decision","matchId":"","players":[],"decisions":[{"at":"x"}],"notes":"","outcome":"","result":{"status":"unknown"}})),
            ("review", json!({"id":"review","matchId":"","players":[],"decisions":[],"notes":"","outcome":"","review":{"summary":"复盘"},"result":{"status":"unknown"}})),
            ("odd", json!({"id":"odd","matchId":"1","players":"not-an-array","decisions":[],"notes":"","outcome":"","result":{"status":"unknown"}})),
        ];
        for (index, (id, value)) in rows.iter().enumerate() {
            c.execute(
                "INSERT INTO sessions VALUES(?1,?2,?3)",
                params![id, value.to_string(), format!("2026-01-01T00:{index:02}:00Z")],
            )
            .unwrap();
        }
        let page = light_page(&c, 0).unwrap();
        let listed: Vec<&str> = page
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        // players 不是数组的畸形行不会让整页查询报错，只会被当成没有内容。
        assert_eq!(listed, vec!["review", "decision", "notes", "real"]);
        // 空壳只是不进列表，仍留在库里等待被下一条快照复用。
        let stored: i64 = c
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, rows.len() as i64);
    }
    #[test]
    fn export_file_names_stay_windows_safe() {
        let clean = export_file_name("对局", "500904965221");
        assert!(clean.starts_with("对局-500904965221-"));
        assert!(clean.ends_with(".json"));
        let dirty = export_file_name("对局", "a/b\\c:d*e?\"f<>|g");
        assert!(dirty
            .chars()
            .all(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')));
        assert!(dirty.ends_with(".json"));
        assert!(export_file_name("对局", "   ").contains("unknown"));
        assert!(export_file_name("全部对局", "20261005").contains("全部对局-20261005-"));
    }
}
