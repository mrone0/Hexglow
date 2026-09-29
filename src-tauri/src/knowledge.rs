//! Lazy, local OKF 0.2 knowledge store. Markdown is data, never executable.
//! FNV-1a fingerprints are deterministic cache keys, NOT cryptographic integrity proofs.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

const MAX_FILE: usize = 256 * 1024;
const MAX_DOCS: usize = 2000;
const MAX_RETRIEVAL: usize = 64 * 1024;
static LOCK: Mutex<()> = Mutex::new(());
const SEEDS: &[(&str, &str)] = &[
    (
        "champions/ahri.md",
        include_str!("../../knowledge-seed/champions/ahri.md"),
    ),
    (
        "champions/garen.md",
        include_str!("../../knowledge-seed/champions/garen.md"),
    ),
    (
        "augments/custom-example.md",
        include_str!("../../knowledge-seed/augments/custom-example.md"),
    ),
];
const REGISTRY: &str = include_str!("../../knowledge-seed/champion-registry.json");
type ResultV = Result<Value, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn hash(s: &str) -> String {
    let mut h = 0xcbf29ce484222325u64;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{h:016x}")
}
fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}
fn folder(kind: &str) -> Result<&'static str, String> {
    match kind {
        "Champion" => Ok("champions"),
        "Augment" => Ok("augments"),
        _ => Err("kind must be Champion or Augment".into()),
    }
}
fn safe_path(path: &str) -> Result<&str, String> {
    let (dir, file) = path
        .split_once('/')
        .ok_or("Expected champions/name.md or augments/name.md")?;
    if !matches!(dir, "champions" | "augments") {
        return Err("Unsupported knowledge directory".into());
    }
    let stem = file.strip_suffix(".md").ok_or("Filename must end in .md")?;
    if stem.is_empty()
        || stem.len() > 100
        || !stem
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("Unsafe filename: use lowercase ASCII letters, digits and hyphens".into());
    }
    if matches!(stem, "con" | "prn" | "aux" | "nul" | "clock" | "index")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("Reserved Windows filename".into());
    }
    Ok(dir)
}
fn link_metadata(m: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points also bypass ordinary symlink checks.
        m.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        m.file_type().is_symlink()
    }
}
fn no_link(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(m) if link_metadata(&m) => Err(format!("Symlinks are forbidden: {}", path.display())),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(e)),
    }
}
fn confined(root: &Path, path: &str) -> Result<PathBuf, String> {
    let dir = safe_path(path)?;
    no_link(root)?;
    no_link(&root.join(dir))?;
    let target = root.join(path);
    no_link(&target)?;
    let canonical = root.canonicalize().map_err(err)?;
    if !target
        .parent()
        .ok_or("Missing parent")?
        .canonicalize()
        .map_err(err)?
        .starts_with(canonical)
    {
        return Err("Path escapes knowledge root".into());
    }
    Ok(target)
}
fn read_bounded(path: &Path) -> Result<String, String> {
    no_link(path)?;
    let f = fs::File::open(path).map_err(err)?;
    if !f.metadata().map_err(err)?.is_file() {
        return Err("Not a regular file".into());
    }
    let mut bytes = Vec::new();
    f.take((MAX_FILE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > MAX_FILE {
        return Err("File exceeds 256 KiB".into());
    }
    String::from_utf8(bytes).map_err(err)
}
fn atomic(path: &Path, text: &str) -> Result<(), String> {
    no_link(path)?;
    let temp = path.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(err)?;
        f.write_all(text.as_bytes()).map_err(err)?;
        f.sync_all().map_err(err)?;
        drop(f);
        fs::rename(&temp, path).map_err(err)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn root_at(data: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(data).map_err(err)?;
    let root = data.join("knowledge");
    let marker = data.join(".knowledge-seeded-v1");
    no_link(&root)?;
    no_link(&marker)?;
    let seed = !root.exists() && !marker.exists();
    // Record the one-shot decision before copying. Never resurrect deleted documents.
    if !marker.exists() {
        atomic(&marker, "seed attempted v1\n")?;
    }
    fs::create_dir_all(&root).map_err(err)?;
    for dir in ["champions", "augments"] {
        no_link(&root.join(dir))?;
        fs::create_dir_all(root.join(dir)).map_err(err)?;
    }
    if seed {
        for (path, content) in SEEDS {
            atomic(&confined(&root, path)?, content)?;
        }
    }
    // v2：增量补齐海克斯 OKF 种子。只新增缺失文件，不覆盖用户编辑，也不恢复用户删除的文件。
    let marker_v2 = data.join(".knowledge-seeded-v2");
    no_link(&marker_v2)?;
    if !marker_v2.exists() {
        let mut added = 0usize;
        for (path, content) in crate::seed_augments::AUGMENT_SEEDS {
            let target = confined(&root, path)?;
            if target.exists() {
                continue;
            }
            atomic(&target, content)?;
            added += 1;
        }
        atomic(&marker_v2, "seed attempted v2\n")?;
        if added > 0 {
            indexes(&root)?;
        }
    }
    if seed || !root.join("index.md").exists() {
        indexes(&root)?;
    }
    Ok(root)
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    root_at(&app.path().app_data_dir().map_err(err)?)
}
fn metadata(content: &str) -> Result<(Value, &str), String> {
    let mut lines = content.split_inclusive('\n');
    if lines.next().map(|s| s.trim_end_matches(['\r', '\n'])) != Some("---") {
        return Err("Missing YAML frontmatter".into());
    }
    let start = content.find('\n').ok_or("Unclosed YAML frontmatter")? + 1;
    let mut end = start;
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let yaml: serde_yaml::Value = serde_yaml::from_str(&content[start..end])
                .map_err(|e| format!("Invalid YAML: {e}"))?;
            let value = serde_json::to_value(yaml).map_err(err)?;
            if !value.is_object() {
                return Err("Frontmatter must be a mapping".into());
            }
            return Ok((value, &content[end + line.len()..]));
        }
        end += line.len();
    }
    Err("Unclosed YAML frontmatter".into())
}
fn nonempty(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty())
}
fn string_list(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(|s| nonempty(s)))
}
fn id_key(kind: &str) -> &'static str {
    if kind == "Champion" {
        "champion_id"
    } else {
        "augment_id"
    }
}
fn known_champion(id: &str) -> bool {
    serde_json::from_str::<Value>(REGISTRY).unwrap()["champions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == norm(id))
}
fn validate(kind: &str, path: &str, content: &str) -> Value {
    let mut errors = Vec::<String>::new();
    let mut warnings = Vec::<String>::new();
    match (folder(kind), safe_path(path)) {
        (Ok(a), Ok(b)) if a == b => (),
        (Err(e), _) | (_, Err(e)) => errors.push(e),
        _ => errors.push("kind does not match directory".into()),
    }
    if content.len() > MAX_FILE {
        errors.push("File exceeds 256 KiB".into());
        return json!({"valid":false,"errors":errors,"warnings":warnings});
    }
    match metadata(content) {
        Err(e) => errors.push(e),
        Ok((m, body)) => {
            for key in ["title", "description", "status"] {
                if !nonempty(&m[key]) {
                    errors.push(format!("Required string: {key}"));
                }
            }
            if !string_list(&m["tags"]) {
                errors.push("tags must be a string list".into());
            }
            if !matches!(
                m["status"].as_str(),
                Some("draft" | "stable" | "deprecated")
            ) {
                errors.push("Unsupported status".into());
            }
            let h = &m["hexglow"];
            if h["schema_version"] != 1 {
                errors.push("hexglow.schema_version must be 1".into());
            }
            if m["type"] != kind {
                errors.push("type must match kind (Champion/Augment)".into());
            }
            if h["mode"] != "hextech-aram" {
                errors.push("hexglow.mode must be hextech-aram".into());
            }
            if !nonempty(&h["patch"]) {
                errors.push("hexglow.patch must be a nonempty string".into());
            } else {
                warnings.push("Patch applicability is not independently verified".into());
            }
            if !string_list(&h["aliases"]) {
                errors.push("hexglow.aliases must be a string list".into());
            }
            // 扩展字段：类型校验，未知键原样保留（不报错）。
            for key in ["rarity", "category", "scaling", "name_en", "effect_source"] {
                if !h[key].is_null() && !nonempty(&h[key]) {
                    errors.push(format!("hexglow.{key} must be a nonempty string"));
                }
            }
            for key in ["tags", "sources", "source", "role_fit", "synergy_tags"] {
                if !h[key].is_null() && !string_list(&h[key]) {
                    errors.push(format!("hexglow.{key} must be a string list"));
                }
            }
            if !h["verified"].is_null() && !h["verified"].is_boolean() {
                errors.push("hexglow.verified must be a boolean".into());
            }
            if !h["game_id"].is_null() && !nonempty(&h["game_id"]) && !h["game_id"].is_u64() {
                errors.push("hexglow.game_id must be a string or unsigned integer".into());
            }
            let id = h[id_key(kind)].as_str().unwrap_or("");
            let expected = format!("{}/{}.md", folder(kind).unwrap_or("invalid"), norm(id));
            if id.is_empty() || expected != path {
                errors.push("Identity must exactly match the filename stem".into());
            }
            if kind == "Champion" && !known_champion(id) {
                errors.push(
                    "Champion ID is not in the bundled minimal registry (Ahri/Garen only)".into(),
                );
            }
            let headings: &[&str] = if kind == "Champion" {
                &["基础机制", "常见打法", "海克斯搭配", "注意事项"]
            } else {
                &["完整效果", "触发条件", "限制与例外", "相关交互"]
            };
            for heading in headings {
                if !body.lines().any(|l| {
                    l.trim() == format!("# {heading}") || l.trim() == format!("## {heading}")
                }) {
                    errors.push(format!("Missing required heading: {heading}"));
                }
            }
            if m["status"] == "draft" {
                warnings.push("Draft: content is not verified".into());
            }
            if !links(path, body).is_empty() {
                warnings.push(
                    "Local links are checked against the knowledge tree on save/retrieval".into(),
                );
            }
        }
    }
    json!({"valid": errors.is_empty(), "errors": errors, "warnings": warnings})
}
#[derive(Clone)]
struct Doc {
    path: String,
    meta: Value,
    content: String,
}
impl Doc {
    fn kind(&self) -> &str {
        self.meta["type"].as_str().unwrap_or("")
    }
    fn title(&self) -> &str {
        self.meta["title"].as_str().unwrap_or("")
    }
    fn names(&self) -> BTreeSet<String> {
        let h = &self.meta["hexglow"];
        let mut names = BTreeSet::from([
            norm(self.title()),
            norm(h[id_key(self.kind())].as_str().unwrap_or("")),
        ]);
        if let Some(a) = h["aliases"].as_array() {
            for v in a {
                if let Some(s) = v.as_str() {
                    names.insert(norm(s));
                }
            }
        }
        if let Some(s) = h["game_id"].as_str() {
            names.insert(norm(s));
        }
        if let Some(n) = h["game_id"].as_u64() {
            names.insert(n.to_string());
        }
        if self.kind() == "Champion" {
            let r: Value = serde_json::from_str(REGISTRY).unwrap();
            for c in r["champions"].as_array().unwrap() {
                if c["id"] == norm(h["champion_id"].as_str().unwrap_or("")) {
                    for k in ["id", "name", "game_id"] {
                        if let Some(s) = c[k].as_str() {
                            names.insert(norm(s));
                        }
                    }
                    for a in c["aliases"].as_array().unwrap() {
                        names.insert(norm(a.as_str().unwrap()));
                    }
                }
            }
        }
        names.remove("");
        names
    }
}
fn scan(root: &Path) -> Result<Vec<Doc>, String> {
    let mut paths = Vec::new();
    for dir in ["champions", "augments"] {
        no_link(&root.join(dir))?;
        for e in fs::read_dir(root.join(dir)).map_err(err)? {
            let e = e.map_err(err)?;
            let p = format!("{dir}/{}", e.file_name().to_string_lossy());
            if safe_path(&p).is_err() || p.ends_with("/index.md") {
                continue;
            }
            if e.file_type().map_err(err)?.is_symlink() {
                return Err("Knowledge contains a symlink".into());
            }
            paths.push(p);
            if paths.len() > MAX_DOCS {
                return Err("Knowledge exceeds 2000-document limit".into());
            }
        }
    }
    paths.sort();
    let mut docs = Vec::new();
    for path in paths {
        let content = read_bounded(&confined(root, &path)?)?;
        if let Ok((meta, _)) = metadata(&content) {
            let kind = meta["type"].as_str().unwrap_or("");
            // Only registered profile documents, not unrelated Markdown, enter the index.
            if folder(kind).ok() == safe_path(&path).ok()
                && meta["hexglow"]["schema_version"] == 1
                && meta["hexglow"]["mode"] == "hextech-aram"
                && meta["hexglow"][id_key(kind)].as_str().map(norm)
                    == path
                        .rsplit('/')
                        .next()
                        .and_then(|s| s.strip_suffix(".md"))
                        .map(str::to_owned)
                && (kind != "Champion"
                    || known_champion(meta["hexglow"]["champion_id"].as_str().unwrap_or("")))
            {
                docs.push(Doc {
                    path,
                    meta,
                    content,
                });
            }
        }
    }
    Ok(docs)
}
fn indexes(root: &Path) -> Result<(), String> {
    let docs = scan(root)?;
    atomic(&root.join("index.md"), "---\nokf_version: '0.2'\n---\n# Hexglow Knowledge\n\nMinimal local knowledge; drafts are not verified mechanics.\n\n- [Champions](champions/index.md)\n- [Augments](augments/index.md)\n")?;
    for dir in ["champions", "augments"] {
        let mut text = format!("# {dir}\n\n");
        for d in &docs {
            if d.path.starts_with(&format!("{dir}/")) {
                let title = d.title().replace(['\n', '\r', '[', ']'], " ");
                text.push_str(&format!(
                    "- [{}]({})\n",
                    title,
                    d.path.split('/').nth(1).unwrap()
                ));
            }
        }
        atomic(&root.join(dir).join("index.md"), &text)?;
    }
    Ok(())
}
// Bounded Markdown destination extraction; accepts only the two local namespaces.
fn links(from: &str, text: &str) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    for part in text.split("](").skip(1).take(256) {
        let Some(dest) = part.split(')').next() else {
            continue;
        };
        let dest = dest.split('#').next().unwrap_or("").trim();
        if !dest.ends_with(".md") {
            continue;
        }
        let p = if let Some(s) = dest.strip_prefix("../") {
            s.to_owned()
        } else if dest.starts_with("champions/") || dest.starts_with("augments/") {
            dest.to_owned()
        } else {
            format!(
                "{}/{}",
                from.split('/').next().unwrap_or(""),
                dest.trim_start_matches("./")
            )
        };
        if safe_path(&p).is_ok() && !p.ends_with("/index.md") {
            result.insert(p);
        }
    }
    result
}
fn backup(root: &Path, path: &str, old: &str) -> Result<(), String> {
    let dir = root.join(".backups");
    no_link(&dir)?;
    fs::create_dir_all(&dir).map_err(err)?;
    let key = path.replace('/', "--");
    for i in (1..3).rev() {
        let prev = dir.join(format!("{key}.{i}"));
        let next = dir.join(format!("{key}.{}", i + 1));
        no_link(&prev)?;
        no_link(&next)?;
        if prev.exists() {
            fs::rename(prev, next).map_err(err)?;
        }
    }
    atomic(&dir.join(format!("{key}.1")), old)
}
fn save_at(root: &Path, kind: &str, path: &str, content: &str) -> ResultV {
    let report = validate(kind, path, content);
    if report["valid"] != true {
        return Err(report["errors"].to_string());
    }
    let target = confined(root, path)?;
    let docs = scan(root)?;
    if !target.exists() && docs.len() >= MAX_DOCS {
        return Err("Knowledge exceeds 2000-document limit".into());
    }
    let (m, _) = metadata(content)?;
    let incoming = Doc {
        path: path.into(),
        meta: m.clone(),
        content: content.into(),
    };
    let names = incoming.names();
    for d in &docs {
        if d.path != path && d.kind() == kind && !names.is_disjoint(&d.names()) {
            return Err(format!("Duplicate title, ID or alias: {}", d.path));
        }
    }
    if target.exists() {
        let old = read_bounded(&target)?;
        let (previous, _) = metadata(&old)?;
        if previous["type"] != m["type"] {
            return Err("Existing type is immutable".into());
        }
        for key in ["champion_id", "augment_id", "game_id"] {
            let a = &previous["hexglow"][key];
            let b = &m["hexglow"][key];
            if a != b && !(key == "champion_id" && a.as_str().map(norm) == b.as_str().map(norm)) {
                return Err(format!("Existing identity is immutable: {key}"));
            }
        }
        backup(root, path, &old)?;
    }
    let mut warnings = report["warnings"].as_array().cloned().unwrap_or_default();
    for link in links(path, content) {
        if link != path && !docs.iter().any(|d| d.path == link) {
            warnings.push(json!(format!("Missing link: {link}")));
        }
    }
    atomic(&target, content)?;
    indexes(root)?;
    Ok(json!({"path":path,"valid":true,"warnings":warnings}))
}
#[tauri::command]
pub fn knowledge_validate(kind: String, path: String, content: String) -> Value {
    validate(&kind, &path, &content)
}
#[tauri::command]
pub fn knowledge_list(app: AppHandle, kind: String) -> ResultV {
    let _guard = LOCK.lock().map_err(err)?;
    folder(&kind)?;
    let root = root(&app)?;
    let documents: Vec<_> = scan(&root)?.iter().filter(|d| d.kind() == kind).map(|d| json!({"path":d.path,"title":d.title(),"kind":d.kind(),"status":d.meta["status"],"patch":d.meta["hexglow"]["patch"]})).collect();
    Ok(json!({"documents":documents,"root":root.to_string_lossy()}))
}
#[tauri::command]
pub fn knowledge_read(app: AppHandle, path: String) -> ResultV {
    let _guard = LOCK.lock().map_err(err)?;
    let root = root(&app)?;
    if !scan(&root)?.iter().any(|d| d.path == path) {
        return Err("Unregistered knowledge document".into());
    }
    Ok(json!({"path":path,"content":read_bounded(&confined(&root,&path)?)?}))
}
#[tauri::command]
pub fn knowledge_save(app: AppHandle, kind: String, path: String, content: String) -> ResultV {
    let _guard = LOCK.lock().map_err(err)?;
    save_at(&root(&app)?, &kind, &path, &content)
}
fn delete_at(root: &Path, path: &str) -> ResultV {
    if safe_path(path)? != "augments" {
        return Err("Champion deletion is forbidden".into());
    }
    let docs = scan(root)?;
    let d = docs
        .iter()
        .find(|d| d.path == path)
        .ok_or("Unregistered knowledge document")?;
    let references: Vec<_> = docs
        .iter()
        .filter(|d| d.path != path && links(&d.path, &d.content).contains(path))
        .map(|d| d.path.clone())
        .collect();
    backup(root, path, &d.content)?;
    fs::remove_file(confined(root, path)?).map_err(err)?;
    indexes(root)?;
    Ok(json!({"deleted":true,"warnings":references}))
}
#[tauri::command]
pub fn knowledge_delete(app: AppHandle, path: String) -> ResultV {
    let _guard = LOCK.lock().map_err(err)?;
    delete_at(&root(&app)?, &path)
}
fn query_names(v: &Value, champion: bool) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    if let Some(s) = v.as_str() {
        out.insert(norm(s));
    }
    if let Some(n) = v.as_u64() {
        out.insert(n.to_string());
    }
    let keys: &[&str] = if champion {
        &[
            "championName",
            "championId",
            "champion_id",
            "rawChampionName",
            "champion",
            "name",
            "id",
        ]
    } else {
        &["name", "title", "augment_id", "augmentId", "id"]
    };
    if v.is_object() {
        for key in keys {
            if let Some(s) = v[key].as_str() {
                out.insert(norm(s));
            } else if let Some(n) = v[key].as_u64() {
                out.insert(n.to_string());
            }
        }
    }
    if champion {
        for s in out.clone() {
            if let Some(raw) = s.strip_prefix("game_character_displayname_") {
                out.insert(raw.into());
            }
        }
    }
    out.remove("");
    out
}
fn retrieve_at(root: &Path, context: &Value) -> ResultV {
    let docs = scan(root)?;
    let mut requests: Vec<(&str, Value, bool)> = Vec::new();
    let own = context
        .get("ownChampion")
        .or_else(|| context.get("champion"))
        .or_else(|| context.get("own_champion"))
        .cloned()
        .or_else(|| {
            context["players"]
                .as_array()?
                .iter()
                .find(|p| {
                    !context["ownPlayerId"].is_null()
                        && (p["id"] == context["ownPlayerId"]
                            || p["playerId"] == context["ownPlayerId"])
                })
                .cloned()
        });
    let mut missing = BTreeSet::new();
    if let Some(own) = own {
        requests.push(("Champion", own, true));
    } else {
        missing.insert("Champion: own champion not provided".to_owned());
    }
    for key in [
        "candidates",
        "candidateAugments",
        "augments",
        "selectedAugments",
    ] {
        if let Some(a) = context[key].as_array() {
            for v in a.iter().take(MAX_DOCS) {
                requests.push(("Augment", v.clone(), true));
            }
        }
    }
    if let Some(players) = context["players"].as_array() {
        for player in players.iter().take(20) {
            let is_own = !context["ownPlayerId"].is_null()
                && (player["id"] == context["ownPlayerId"]
                    || player["playerId"] == context["ownPlayerId"]);
            if let Some(augments) = player["augments"].as_array() {
                for augment in augments.iter().take(32) {
                    requests.push(("Augment", augment.clone(), is_own));
                }
            }
            if !is_own {
                requests.push(("Champion", player.clone(), false));
            }
        }
    }
    requests.sort_by_key(|(_, _, required)| !*required);
    if let Some(a) = context["opponents"].as_array() {
        for v in a.iter().take(20) {
            requests.push(("Champion", v.clone(), false));
        }
    }
    let mut selected: Vec<String> = Vec::new();
    let mut mandatory = BTreeSet::new();
    let mut warnings = BTreeSet::new();
    // Mandatory requests are collected first, opponents are optional.
    for (kind, value, required) in requests {
        let names = query_names(&value, kind == "Champion");
        let matches: Vec<_> = docs
            .iter()
            .filter(|d| d.kind() == kind && !d.names().is_disjoint(&names))
            .collect();
        let label = format!(
            "{kind}: {}",
            names.iter().cloned().collect::<Vec<_>>().join(" / ")
        );
        if matches.len() != 1 {
            if required {
                missing.insert(label.clone());
            }
            if matches.len() > 1 {
                warnings.insert(format!("Ambiguous exact match: {label}"));
            }
            continue;
        }
        let d = matches[0];
        if required {
            mandatory.insert(d.path.clone());
        }
        if !selected.contains(&d.path) {
            selected.push(d.path.clone());
        }
    }
    let direct = selected.clone();
    for p in direct {
        if let Some(d) = docs.iter().find(|d| d.path == p) {
            for link in links(&p, &d.content) {
                if docs.iter().any(|d| d.path == link) {
                    if !selected.contains(&link) {
                        selected.push(link);
                    }
                } else {
                    warnings.insert(format!("Missing link: {link}"));
                }
            }
        }
    }
    let mut documents = Vec::new();
    let mut bytes = 0;
    let mut fingerprint_data = BTreeMap::new();
    for p in selected {
        let d = docs.iter().find(|d| d.path == p).unwrap();
        let report = validate(d.kind(), &p, &d.content);
        if report["valid"] != true {
            warnings.insert(format!("Invalid document excluded: {p}"));
            if mandatory.contains(&p) {
                missing.insert(p);
            }
            continue;
        }
        if documents.len() >= 16 || bytes + d.content.len() > MAX_RETRIEVAL {
            warnings.insert(
                "Retrieval limited to 16 documents / 64 KiB; omitted documents are not evidence"
                    .into(),
            );
            if mandatory.contains(&p) {
                missing.insert(p);
            }
            continue;
        }
        for w in report["warnings"].as_array().unwrap() {
            warnings.insert(format!("{p}: {}", w.as_str().unwrap_or("")));
        }
        if let Some(patch) = context["patch"].as_str() {
            if d.meta["hexglow"]["patch"] != patch {
                warnings.insert(format!("{p}: patch does not match requested {patch}"));
            }
        }
        bytes += d.content.len();
        let h = hash(&d.content);
        fingerprint_data.insert(p.clone(), h.clone());
        documents.push(json!({"path":p,"title":d.title(),"content":d.content,"hash":h}));
    }
    let fingerprint = hash(
        &serde_json::to_string(
            &json!({"documents":fingerprint_data,"missing":missing,"warnings":warnings}),
        )
        .map_err(err)?,
    );
    Ok(
        json!({"documents":documents,"missing":missing,"warnings":warnings,"fingerprint":fingerprint}),
    )
}
#[tauri::command]
pub fn knowledge_retrieve(app: AppHandle, context: Value) -> ResultV {
    let _guard = LOCK.lock().map_err(err)?;
    retrieve_at(&root(&app)?, &context)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("hexglow-knowledge-test-{}", uuid::Uuid::new_v4())),
            )
        }
        fn root(&self) -> PathBuf {
            root_at(&self.0).unwrap()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn seeds_validate() {
        for (path, text) in SEEDS {
            let kind = if path.starts_with("champions") {
                "Champion"
            } else {
                "Augment"
            };
            assert_eq!(
                validate(kind, path, text)["valid"],
                true,
                "{}",
                validate(kind, path, text)
            );
        }
    }
    #[test]
    fn v2_seed_is_incremental_and_preserves_user_edits() {
        let temp = Temp::new();
        let root = temp.root();
        let target = root.join("augments/1170.md");
        assert!(target.exists(), "v2 seed must add generated augment docs");
        fs::write(&target, "手工编辑\n").unwrap();
        let removed = root.join("augments/1134.md");
        fs::remove_file(&removed).unwrap();
        let root = root_at(&temp.0).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("augments/1170.md")).unwrap(),
            "手工编辑\n"
        );
        assert!(!removed.exists(), "deleted documents must not come back");
        assert!(root.join("augments/custom-example.md").exists());
        assert!(root.join("champions/ahri.md").exists());
    }

    #[test]
    fn augment_seed_module_covers_generated_docs() {
        assert!(crate::seed_augments::AUGMENT_SEEDS.len() >= 211);
        for (path, content) in crate::seed_augments::AUGMENT_SEEDS {
            assert!(path.starts_with("augments/"), "{path}");
            assert_eq!(validate("Augment", path, content)["valid"], true, "{path}");
        }
    }

    #[test]
    fn generated_augment_seeds_validate() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../knowledge-seed/augments");
        let mut checked = 0usize;
        let mut failures = Vec::<String>::new();
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let name = path.file_name().unwrap().to_str().unwrap().to_string();
            let rel = format!("augments/{name}");
            let text = fs::read_to_string(&path).unwrap();
            let result = validate("Augment", &rel, &text);
            checked += 1;
            if result["valid"] != true {
                failures.push(format!("{rel}: {result}"));
            }
        }
        assert!(checked >= 211, "expected at least 211 seed docs, got {checked}");
        assert!(
            failures.is_empty(),
            "{} invalid docs:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
    #[test]
    fn ui_template_and_okf_statuses() {
        // Actual KnowledgePanel create template: null game_id and level-one headings.
        let text = "---\ntype: Augment\ntitle: 新海克斯\ndescription: 请填写简短说明。\ntags: [海克斯]\nstatus: draft\nhexglow:\n  schema_version: 1\n  augment_id: custom-new\n  game_id: null\n  aliases: []\n  mode: hextech-aram\n  patch: unknown\n---\n\n# 完整效果\n请填写完整效果和数值。\n\n# 触发条件\n待确认。\n\n# 限制与例外\n待确认。\n\n# 相关交互\n暂无已确认资料。\n";
        let t = Temp::new();
        let root = t.root();
        for status in ["draft", "stable", "deprecated"] {
            let text = text.replace("status: draft", &format!("status: {status}"));
            assert_eq!(
                validate("Augment", "augments/custom-new.md", &text)["valid"],
                true
            );
            save_at(&root, "Augment", "augments/custom-new.md", &text).unwrap();
        }
        for status in ["verified", "published", "reviewed", "active"] {
            assert_eq!(
                validate(
                    "Augment",
                    "augments/custom-new.md",
                    &text.replace("status: draft", &format!("status: {status}"))
                )["valid"],
                false
            );
        }
        for (path, seed) in SEEDS {
            let kind = if path.starts_with("champions") {
                "Champion"
            } else {
                "Augment"
            };
            assert_eq!(
                validate(kind, path, &seed.replace("## ", "# "))["valid"],
                true
            );
        }
        let verified = text.replace("status: draft", "status: stable\nverified: false");
        save_at(&root, "Augment", "augments/custom-new.md", &verified).unwrap();
        assert_eq!(
            read_bounded(&root.join("augments/custom-new.md")).unwrap(),
            verified
        );
    }
    #[test]
    fn filenames() {
        for path in [
            "../ahri.md",
            "champions/../ahri.md",
            "champions/Ahri.md",
            "augments/con.md",
            "augments/lpt1.md",
            "augments/a.b.md",
            "augments/a\\b.md",
            "/champions/ahri.md",
            "augments/é.md",
        ] {
            assert!(safe_path(path).is_err(), "{path}");
        }
        assert!(safe_path("augments/custom-123.md").is_ok());
    }
    #[test]
    fn bad_yaml_and_template() {
        let text = SEEDS[0].1;
        assert_eq!(
            validate(
                "Champion",
                SEEDS[0].0,
                &text.replace("## 基础机制", "## wrong")
            )["valid"],
            false
        );
        assert!(metadata("---\na: [\n---\n").is_err());
        assert!(metadata("---\na: 1\na: 2\n---\n").is_err());
        assert_eq!(
            validate(
                "Champion",
                "champions/unknown.md",
                &text.replace("ahri", "unknown")
            )["valid"],
            false
        );
    }
    #[test]
    fn exact_matching_and_budget() {
        let t = Temp::new();
        let root = t.root();
        let r = retrieve_at(&root,&json!({"champion":"game_character_displayname_Ahri","candidates":["custom-example","自定义示例"]})).unwrap();
        assert_eq!(r["documents"].as_array().unwrap().len(), 2);
        assert_eq!(r["missing"].as_array().unwrap().len(), 1);
        assert_eq!(r["fingerprint"],retrieve_at(&root,&json!({"champion":"game_character_displayname_Ahri","candidates":["custom-example","自定义示例"]})).unwrap()["fingerprint"]);
    }
    #[test]
    fn save_preserves_text_duplicate_and_identity() {
        let t = Temp::new();
        let root = t.root();
        let text = SEEDS[2]
            .1
            .replace("status: draft", "status: draft\nunknown_extension: keep-me");
        save_at(&root, "Augment", SEEDS[2].0, &text).unwrap();
        assert_eq!(read_bounded(&root.join(SEEDS[2].0)).unwrap(), text);
        let dup = text.replace("augment_id: custom-example", "augment_id: other");
        assert!(save_at(&root, "Augment", "augments/other.md", &dup).is_err());
        assert!(save_at(
            &root,
            "Augment",
            SEEDS[2].0,
            &text.replace("  schema_version: 1", "  schema_version: 1\n  game_id: 123")
        )
        .is_err());
    }
    #[test]
    fn deletion_stays_deleted_and_champions_protected() {
        let t = Temp::new();
        let root = t.root();
        assert!(delete_at(&root, "champions/ahri.md").is_err());
        delete_at(&root, SEEDS[2].0).unwrap();
        assert!(!t.root().join(SEEDS[2].0).exists());
        fs::remove_dir_all(&root).unwrap();
        assert!(scan(&t.root()).unwrap().is_empty());
    }
    #[test]
    fn backups_bounded_and_links() {
        let t = Temp::new();
        let root = t.root();
        for _ in 0..5 {
            save_at(&root, "Augment", SEEDS[2].0, SEEDS[2].1).unwrap();
        }
        assert_eq!(fs::read_dir(root.join(".backups")).unwrap().count(), 3);
        assert!(
            links("champions/ahri.md", "[x](../augments/custom-example.md)")
                .contains("augments/custom-example.md")
        );
    }
    #[test]
    fn missing_links_and_delete_references() {
        let t = Temp::new();
        let root = t.root();
        let text = format!(
            "{}\n[x](../augments/custom-example.md)\n[y](../augments/missing.md)",
            SEEDS[0].1
        );
        let saved = save_at(&root, "Champion", SEEDS[0].0, &text).unwrap();
        assert!(saved["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("Missing link")));
        let deleted = delete_at(&root, SEEDS[2].0).unwrap();
        assert_eq!(deleted["warnings"], json!([SEEDS[0].0]));
        assert_eq!(
            validate("Augment", "augments/index.md", SEEDS[2].1)["valid"],
            false
        );
        assert_eq!(
            validate("Augment", SEEDS[2].0, &"a".repeat(MAX_FILE + 1))["valid"],
            false
        );
    }
    #[test]
    fn actual_budgets_and_one_hop() {
        let t = Temp::new();
        let root = t.root();
        let mut candidates = Vec::new();
        for i in 0..20 {
            let id = format!("example-{i}");
            let text = SEEDS[2]
                .1
                .replace("custom-example", &id)
                .replace("自定义示例（非真实海克斯）", &format!("Example {i}"));
            atomic(
                &confined(&root, &format!("augments/{id}.md")).unwrap(),
                &text,
            )
            .unwrap();
            candidates.push(id);
        }
        let r = retrieve_at(&root, &json!({"champion":"Ahri","candidates":candidates})).unwrap();
        assert_eq!(r["documents"].as_array().unwrap().len(), 16);
        assert_eq!(r["missing"].as_array().unwrap().len(), 5);
        let huge = format!("{}\n{}", SEEDS[2].1, "a".repeat(MAX_RETRIEVAL));
        save_at(&root, "Augment", SEEDS[2].0, &huge).unwrap();
        let r = retrieve_at(
            &root,
            &json!({"champion":"Ahri","candidates":["custom-example"]}),
        )
        .unwrap();
        assert_eq!(r["documents"].as_array().unwrap().len(), 1);
        assert!(r["missing"]
            .as_array()
            .unwrap()
            .contains(&json!(SEEDS[2].0)));
        let ahri = format!("{}\n[x](../augments/example-0.md)", SEEDS[0].1);
        save_at(&root, "Champion", SEEDS[0].0, &ahri).unwrap();
        let first = root.join("augments/example-0.md");
        let text = format!("{}\n[x](example-1.md)", read_bounded(&first).unwrap());
        atomic(&first, &text).unwrap();
        let r = retrieve_at(&root, &json!({"champion":"Ahri"})).unwrap();
        assert_eq!(r["documents"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn players_context_and_uppercase_id() {
        let t = Temp::new();
        let root = t.root();
        save_at(
            &root,
            "Champion",
            SEEDS[0].0,
            &SEEDS[0].1.replace("champion_id: ahri", "champion_id: Ahri"),
        )
        .unwrap();
        let r = retrieve_at(&root,&json!({"ownPlayerId":"me","players":[{"id":"me","champion":"Ahri","augments":["custom-example"]},{"id":"them","champion":"Garen","augments":["unknown"]}],"candidates":[{"name":"unknown-candidate","description":"custom-example"}]})).unwrap();
        assert_eq!(r["documents"].as_array().unwrap().len(), 3);
        assert_eq!(r["missing"].as_array().unwrap().len(), 1);
        assert!(!r["warnings"].as_array().unwrap().is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_rejected() {
        let t = Temp::new();
        let root = t.root();
        std::os::unix::fs::symlink(
            root.join("champions/ahri.md"),
            root.join("augments/evil.md"),
        )
        .unwrap();
        assert!(confined(&root, "augments/evil.md").is_err());
        assert!(scan(&root).is_err());
    }
}
