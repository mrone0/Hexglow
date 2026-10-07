//! Lazy, local OKF 0.2 knowledge store. Markdown is data, never executable.
//! FNV-1a fingerprints are deterministic cache keys, NOT cryptographic integrity proofs.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

const MAX_FILE: usize = 256 * 1024;
const MAX_DOCS: usize = 2000;
const MAX_RETRIEVAL: usize = 64 * 1024;
// 章节级裁剪的优先级：整篇放不下时按该顺序保留对当前请求最重要的章节。
const CHAMPION_SECTIONS: [&str; 4] = ["海克斯搭配", "基础机制", "常见打法", "注意事项"];
const AUGMENT_SECTIONS: [&str; 4] = ["完整效果", "相关交互", "限制与例外", "触发条件"];
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
fn registry() -> &'static Value {
    static REGISTRY_CACHE: OnceLock<Value> = OnceLock::new();
    REGISTRY_CACHE
        .get_or_init(|| serde_json::from_str(REGISTRY).expect("bundled champion registry"))
}
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
        for (path, content) in crate::seed_generated::AUGMENT_SEEDS {
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
    // v3：增量补齐英雄 OKF 种子（除人工维护的 ahri/garen 外）。同样只补缺失，不覆盖不复活。
    let marker_v3 = data.join(".knowledge-seeded-v3");
    no_link(&marker_v3)?;
    if !marker_v3.exists() {
        let mut added = 0usize;
        for (path, content) in crate::seed_generated::CHAMPION_SEEDS {
            let target = confined(&root, path)?;
            if target.exists() {
                continue;
            }
            atomic(&target, content)?;
            added += 1;
        }
        atomic(&marker_v3, "seed attempted v3\n")?;
        if added > 0 {
            indexes(&root)?;
        }
    }
    // v4：旧版本在种子尚未打进二进制时就写下了 v2/v3 标记，导致生成件一个都没落地。
    // 一次性补齐（只补缺失），补完写标记，之后用户删除的文档依旧不会复活。
    let marker_v4 = data.join(".knowledge-seeded-v4");
    no_link(&marker_v4)?;
    if !marker_v4.exists() {
        let mut added = 0usize;
        for (path, content) in crate::seed_generated::AUGMENT_SEEDS
            .iter()
            .copied()
            .chain(crate::seed_generated::CHAMPION_SEEDS.iter().copied())
        {
            let target = confined(&root, path)?;
            if target.exists() {
                continue;
            }
            atomic(&target, content)?;
            added += 1;
        }
        atomic(&marker_v4, "seed attempted v4\n")?;
        if added > 0 {
            indexes(&root)?;
        }
    }
    // 仅修复与旧版生成种子完全一致的文档，用户修改过的条目保持原样。
    // v2 包含否定/防御条件误判修复及关联搭配；v1 安装也必须执行这次精确匹配修复。
    repair_generated_seeds(
        &root,
        data,
        ".knowledge-tag-repair-v2",
        include_str!("../data/seed-repair-hashes.json"),
    )?;
    // 独立于已发布的 v2 标记，已升级过标签的安装也能收到这次机制资料修正。
    repair_generated_seeds(
        &root,
        data,
        ".knowledge-mechanics-repair-v1",
        include_str!("../data/seed-mechanics-repair-hashes.json"),
    )?;
    if seed || !root.join("index.md").exists() {
        indexes(&root)?;
    }
    Ok(root)
}

fn repair_generated_seeds(
    root: &Path,
    data: &Path,
    marker: &str,
    manifest: &str,
) -> Result<(), String> {
    let repair_marker = data.join(marker);
    no_link(&repair_marker)?;
    if !repair_marker.exists() {
        let hashes: Value = serde_json::from_str(manifest).map_err(err)?;
        let mut repaired = false;
        for (path, expected) in hashes.as_object().ok_or("Invalid seed repair hashes")? {
            let target = confined(root, path)?;
            if !target.exists() {
                continue;
            }
            let Ok(old) = read_bounded(&target) else {
                continue;
            };
            let old_hash = hash(&old.replace("\r\n", "\n"));
            let matches = expected.as_str() == Some(old_hash.as_str())
                || expected.as_array().is_some_and(|values| {
                    values.iter().any(|v| v.as_str() == Some(old_hash.as_str()))
                });
            if !matches {
                continue;
            }
            if let Some((_, replacement)) = crate::seed_generated::AUGMENT_SEEDS
                .iter()
                .chain(crate::seed_generated::CHAMPION_SEEDS.iter())
                .find(|(p, _)| *p == path)
            {
                backup(root, path, &old)?;
                atomic(&target, replacement)?;
                repaired = true;
            }
        }
        if repaired {
            indexes(root)?;
        }
        atomic(&repair_marker, "exact generated seed repair attempted\n")?;
    }
    Ok(())
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
    registry()["champions"]
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
                errors.push("Champion ID is not in the bundled champion registry".into());
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
            let r = registry();
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
struct ScanCache {
    root: PathBuf,
    stamps: Vec<(String, String)>,
    docs: Vec<Doc>,
    warnings: Vec<String>,
}
// 每次有界读取内容，缓存 YAML 解析；同长度、保留 mtime 的外部编辑也必须及时生效。
static SCAN_CACHE: Mutex<Option<ScanCache>> = Mutex::new(None);
fn scan(root: &Path) -> Result<Vec<Doc>, String> {
    scan_with_warnings(root).map(|(docs, _)| docs)
}
fn scan_with_warnings(root: &Path) -> Result<(Vec<Doc>, Vec<String>), String> {
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
    let mut contents = Vec::new();
    let mut warnings = Vec::new();
    for path in &paths {
        // 目录/链接保护仍为硬错误；单份文档损坏不影响其余可用资料。
        let target = confined(root, path)?;
        match read_bounded(&target) {
            Ok(content) => contents.push((path.clone(), hash(&content), Some(content))),
            Err(error) => {
                warnings.push(format!("Invalid document excluded: {path}: {error}"));
                contents.push((path.clone(), format!("unreadable:{}", hash(&error)), None));
            }
        }
    }
    let stamps: Vec<_> = contents
        .iter()
        .map(|(path, hash, _)| (path.clone(), hash.clone()))
        .collect();
    let previous;
    {
        let cache = SCAN_CACHE.lock().map_err(err)?;
        if let Some(cached) = cache
            .as_ref()
            .filter(|c| c.root == root && c.stamps == stamps)
        {
            return Ok((cached.docs.clone(), cached.warnings.clone()));
        }
        previous = cache
            .as_ref()
            .filter(|c| c.root == root)
            .map(|c| {
                let stamps: BTreeMap<_, _> =
                    c.stamps.iter().map(|(path, hash)| (path, hash)).collect();
                c.docs
                    .iter()
                    .filter_map(|doc| {
                        Some((
                            doc.path.clone(),
                            ((*stamps.get(&doc.path)?).clone(), doc.clone()),
                        ))
                    })
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
    }
    let mut docs = Vec::new();
    for (path, stamp, content) in contents {
        let Some(content) = content else { continue };
        if let Some((_, doc)) = previous.get(&path).filter(|(hash, _)| hash == &stamp) {
            docs.push(doc.clone());
            continue;
        }
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
        } else {
            warnings.push(format!(
                "Invalid document excluded: {path}: invalid YAML frontmatter"
            ));
        }
    }
    *SCAN_CACHE.lock().map_err(err)? = Some(ScanCache {
        root: root.to_path_buf(),
        stamps,
        docs: docs.clone(),
        warnings: warnings.clone(),
    });
    Ok((docs, warnings))
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
#[tauri::command(async)]
pub fn knowledge_validate(kind: String, path: String, content: String) -> Value {
    validate(&kind, &path, &content)
}
#[tauri::command(async)]
pub fn knowledge_list(app: AppHandle, kind: String) -> ResultV {
    let _guard = LOCK.lock().map_err(err)?;
    folder(&kind)?;
    let root = root(&app)?;
    let (docs, warnings) = scan_with_warnings(&root)?;
    let documents: Vec<_> = docs.iter().filter(|d| d.kind() == kind).map(|d| json!({"path":d.path,"title":d.title(),"kind":d.kind(),"status":d.meta["status"],"patch":d.meta["hexglow"]["patch"]})).collect();
    Ok(json!({"documents":documents,"root":root.to_string_lossy(),"warnings":warnings}))
}
#[tauri::command(async)]
pub fn knowledge_read(app: AppHandle, path: String) -> ResultV {
    let _guard = LOCK.lock().map_err(err)?;
    let root = root(&app)?;
    if !scan(&root)?.iter().any(|d| d.path == path) {
        return Err("Unregistered knowledge document".into());
    }
    Ok(json!({"path":path,"content":read_bounded(&confined(&root,&path)?)?}))
}
#[tauri::command(async)]
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
#[tauri::command(async)]
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
/// 按 #/## 标题把文档切段。第 0 段是首个标题之前的部分（含 YAML frontmatter），heading 为空。
/// 代码块里的 # 行不算标题；### 及更深层级保持在所属章节内。
fn split_sections(content: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut fence = false;
    for line in content.split_inclusive('\n') {
        let plain = line.trim_end_matches(['\r', '\n']);
        if plain.trim_start().starts_with("```") {
            fence = !fence;
        }
        let heading = (!fence)
            .then(|| {
                plain
                    .trim_start()
                    .strip_prefix("# ")
                    .or_else(|| plain.trim_start().strip_prefix("## "))
                    .map(|h| h.trim().to_string())
            })
            .flatten();
        match heading {
            Some(h) => out.push((h, line.to_string())),
            None => match out.last_mut() {
                Some((_, buf)) => buf.push_str(line),
                None => out.push((String::new(), line.to_string())),
            },
        }
    }
    out
}
/// 整篇超过剩余预算时按章节裁剪：前言（frontmatter + 标题）必留，正文按 kind 的优先级
/// 顺序填充，装不下的整段跳过，自定义章节排在最后。放不下任何正文章节时返回 None。
fn trim_doc(content: &str, kind: &str, budget: usize) -> Option<(String, Vec<String>)> {
    if budget == 0 {
        return None;
    }
    let sections = split_sections(content);
    let priority: &[&str] = if kind == "Champion" {
        &CHAMPION_SECTIONS
    } else {
        &AUGMENT_SECTIONS
    };
    let mut order: Vec<usize> = (0..sections.len()).collect();
    order.sort_by_key(|i| {
        if *i == 0 {
            (0u32, *i)
        } else {
            let title = sections[*i].0.as_str();
            let rank = priority
                .iter()
                .position(|h| *h == title)
                .map(|p| (p + 1) as u32)
                .unwrap_or(u32::MAX);
            (rank, *i)
        }
    });
    let mut keep = vec![false; sections.len()];
    let mut used = 0usize;
    for i in order {
        let len = sections[i].1.len();
        if used + len > budget {
            continue;
        }
        keep[i] = true;
        used += len;
    }
    if !keep[0] {
        return None;
    }
    // 输出按文档顺序，和 content 的章节顺序一致。
    let mut text = String::new();
    let mut kept_titles = Vec::new();
    for (i, (title, body)) in sections.iter().enumerate() {
        if !keep[i] {
            continue;
        }
        text.push_str(body);
        if i > 0 && !title.is_empty() {
            kept_titles.push(title.clone());
        }
    }
    if kept_titles.is_empty() {
        return None;
    }
    Some((text, kept_titles))
}
fn retrieve_at(root: &Path, context: &Value) -> ResultV {
    let observed = [
        context["patch"].as_str(),
        context["liveData"]["gameData"]["gameVersion"].as_str(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|p| !p.is_empty() && !p.eq_ignore_ascii_case("unknown"));
    let patch = observed.unwrap_or(crate::scoring::data_patch());
    let (docs, excluded) = scan_with_warnings(root)?;
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
    let mut warnings: BTreeSet<_> = excluded.into_iter().collect();
    if observed.is_none() {
        warnings.insert(format!(
            "当前游戏版本未知；知识检索暂按打包版本 {} 检查，不代表已确认适用",
            crate::scoring::data_patch()
        ));
    }
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
        if documents.len() >= 16 {
            warnings.insert(
                "Retrieval limited to 16 documents / 64 KiB; omitted documents are not evidence"
                    .into(),
            );
            if mandatory.contains(&p) {
                missing.insert(p);
            }
            continue;
        }
        // 整篇放不下时退化为章节裁剪；连一个正文章节都放不下才算省略。
        let (content, sections) = if bytes + d.content.len() <= MAX_RETRIEVAL {
            (d.content.clone(), Vec::<String>::new())
        } else if let Some(t) = trim_doc(&d.content, d.kind(), MAX_RETRIEVAL - bytes) {
            t
        } else {
            warnings.insert(
                "Retrieval limited to 16 documents / 64 KiB; omitted documents are not evidence"
                    .into(),
            );
            if mandatory.contains(&p) {
                missing.insert(p);
            }
            continue;
        };
        for w in report["warnings"].as_array().unwrap() {
            warnings.insert(format!("{p}: {}", w.as_str().unwrap_or("")));
        }
        let family = |v: &str| v.split('.').take(2).collect::<Vec<_>>().join(".");
        if family(d.meta["hexglow"]["patch"].as_str().unwrap_or("unknown")) != family(patch) {
            warnings.insert(format!("{p}: patch does not match requested {patch}"));
        }
        if !sections.is_empty() {
            warnings.insert(format!(
                "{p}: 文档超出 64 KiB 预算，按章节裁剪保留 {}",
                sections.join("、")
            ));
        }
        bytes += content.len();
        let h = hash(&content);
        fingerprint_data.insert(p.clone(), h.clone());
        let mut doc = json!({"path":p,"title":d.title(),"content":content,"hash":h});
        if !sections.is_empty() {
            doc["sections"] = json!(sections);
        }
        documents.push(doc);
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
#[tauri::command(async)]
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
    fn tag_repair_only_updates_untouched_old_generated_documents() {
        let temp = Temp::new();
        let root = temp.root();
        let target = root.join("augments/1084.md");
        let current = read_bounded(&target).unwrap();
        let fixtures: Value =
            serde_json::from_str(include_str!("../tests/fixtures/seed-repair-before-v2.json"))
                .unwrap();
        let hashes: Value =
            serde_json::from_str(include_str!("../data/seed-repair-hashes.json")).unwrap();
        // 已完成 v1 的安装仍执行 v2；两个已发布的 1084 内容版本均可准确识别。
        atomic(&temp.0.join(".knowledge-tag-repair-v1"), "completed v1\n").unwrap();
        for old in fixtures["augments/1084.md"].as_array().unwrap() {
            let old = old.as_str().unwrap();
            assert!(hashes["augments/1084.md"]
                .as_array()
                .unwrap()
                .contains(&json!(hash(old))));
            atomic(&target, &old.replace('\n', "\r\n")).unwrap();
            fs::remove_file(temp.0.join(".knowledge-tag-repair-v2")).unwrap();
            temp.root();
            assert_eq!(read_bounded(&target).unwrap(), current);
        }
        let edited = format!(
            "{}\n用户核验补充\n",
            fixtures["augments/1084.md"][0].as_str().unwrap()
        );
        atomic(&target, &edited).unwrap();
        fs::remove_file(temp.0.join(".knowledge-tag-repair-v2")).unwrap();
        temp.root();
        assert_eq!(read_bounded(&target).unwrap(), edited);
    }

    #[test]
    fn tag_repair_updates_related_augments_and_champions_without_restoring_deletions() {
        let temp = Temp::new();
        let root = temp.root();
        let fixtures: Value =
            serde_json::from_str(include_str!("../tests/fixtures/seed-repair-before-v2.json"))
                .unwrap();
        let hashes: Value =
            serde_json::from_str(include_str!("../data/seed-repair-hashes.json")).unwrap();
        let mut current = BTreeMap::new();
        for path in ["augments/1004.md", "champions/nocturne.md"] {
            current.insert(path, read_bounded(&root.join(path)).unwrap());
            let old = fixtures[path][0].as_str().unwrap();
            assert!(hashes[path].as_array().unwrap().contains(&json!(hash(old))));
            atomic(&root.join(path), old).unwrap();
        }
        let deleted = root.join("augments/1005.md");
        fs::remove_file(&deleted).unwrap();
        let edited = root.join("augments/1011.md");
        atomic(&edited, "用户编辑：待核验\n").unwrap();
        atomic(&temp.0.join(".knowledge-tag-repair-v1"), "completed v1\n").unwrap();
        fs::remove_file(temp.0.join(".knowledge-tag-repair-v2")).unwrap();
        temp.root();
        for (path, expected) in current {
            assert_eq!(read_bounded(&root.join(path)).unwrap(), expected);
        }
        assert!(!deleted.exists());
        assert_eq!(read_bounded(&edited).unwrap(), "用户编辑：待核验\n");
        assert!(temp.0.join(".knowledge-tag-repair-v2").exists());
    }

    #[test]
    fn mechanics_repair_upgrades_exact_seeds_after_v2_and_keeps_backups() {
        let temp = Temp::new();
        let root = temp.root();
        let fixtures: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/seed-repair-before-mechanics.json"
        ))
        .unwrap();
        let hashes: Value =
            serde_json::from_str(include_str!("../data/seed-mechanics-repair-hashes.json"))
                .unwrap();
        let mut expected = BTreeMap::new();
        for (path, fixture) in fixtures.as_object().unwrap() {
            expected.insert(path, read_bounded(&root.join(path)).unwrap());
            let old = fixture["raw"].as_str().unwrap();
            assert_eq!(hashes[path], hash(&old.replace("\r\n", "\n")));
            assert_ne!(
                old.replace("\r\n", "\n"),
                expected[path].replace("\r\n", "\n")
            );
            atomic(&root.join(path), old).unwrap();
        }
        assert!(temp.0.join(".knowledge-tag-repair-v2").exists());
        fs::remove_file(temp.0.join(".knowledge-mechanics-repair-v1")).unwrap();
        temp.root();
        for (path, current) in expected {
            assert_eq!(read_bounded(&root.join(path)).unwrap(), current);
            let backup = root
                .join(".backups")
                .join(format!("{}.1", path.replace('/', "--")));
            assert_eq!(
                read_bounded(&backup).unwrap(),
                fixtures[path]["raw"].as_str().unwrap()
            );
        }
        // Completed migration is not replayed on ordinary reads.
        let backup_count = fs::read_dir(root.join(".backups")).unwrap().count();
        temp.root();
        assert_eq!(
            fs::read_dir(root.join(".backups")).unwrap().count(),
            backup_count
        );
    }

    #[test]
    fn mechanics_repair_preserves_user_edits_deletions_and_accepts_lf() {
        let temp = Temp::new();
        let root = temp.root();
        let fixtures: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/seed-repair-before-mechanics.json"
        ))
        .unwrap();
        let edited_path = root.join("augments/1029.md");
        let edited = format!(
            "{}\n用户自行核验的备注\n",
            fixtures["augments/1029.md"]["raw"].as_str().unwrap()
        );
        atomic(&edited_path, &edited).unwrap();
        let deleted = root.join("augments/1180.md");
        fs::remove_file(&deleted).unwrap();
        let ekko = root.join("champions/ekko.md");
        let expected = read_bounded(&ekko).unwrap();
        atomic(
            &ekko,
            &fixtures["champions/ekko.md"]["raw"]
                .as_str()
                .unwrap()
                .replace("\r\n", "\n"),
        )
        .unwrap();
        fs::remove_file(temp.0.join(".knowledge-mechanics-repair-v1")).unwrap();
        temp.root();
        assert_eq!(read_bounded(&edited_path).unwrap(), edited);
        assert!(!deleted.exists());
        assert_eq!(read_bounded(&ekko).unwrap(), expected);
        assert!(temp.0.join(".knowledge-mechanics-repair-v1").exists());
    }

    #[test]
    fn cached_documents_refresh_on_external_edits_and_deletion() {
        let temp = Temp::new();
        let root = temp.root();
        let target = root.join("augments/1084.md");
        let original = read_bounded(&target).unwrap();
        assert!(scan(&root)
            .unwrap()
            .iter()
            .any(|d| d.path == "augments/1084.md"));
        let changed = format!("{original}\n外部编辑后的交互观察\n");
        atomic(&target, &changed).unwrap();
        let docs = scan(&root).unwrap();
        assert_eq!(
            docs.iter()
                .find(|d| d.path == "augments/1084.md")
                .unwrap()
                .content,
            changed
        );
        fs::remove_file(&target).unwrap();
        assert!(!scan(&root)
            .unwrap()
            .iter()
            .any(|d| d.path == "augments/1084.md"));
    }
    #[test]
    fn cache_detects_same_length_external_edits_with_preserved_mtime() {
        let temp = Temp::new();
        let root = temp.root();
        let target = root.join("augments/1084.md");
        let original = read_bounded(&target).unwrap();
        let modified = fs::metadata(&target).unwrap().modified().unwrap();
        scan(&root).unwrap();
        let changed = original.replace("18%", "28%");
        assert_ne!(changed, original);
        assert_eq!(changed.len(), original.len());
        fs::write(&target, &changed).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), modified);
        let docs = scan(&root).unwrap();
        assert_eq!(
            docs.iter()
                .find(|d| d.path == "augments/1084.md")
                .unwrap()
                .content,
            changed
        );
    }
    #[test]
    fn unreadable_documents_are_reported_without_blocking_valid_knowledge() {
        let temp = Temp::new();
        let root = temp.root();
        let bad = root.join("augments/custom-example.md");
        fs::write(&bad, [0xff, 0xfe]).unwrap();
        for _ in 0..2 {
            let result = retrieve_at(
                &root,
                &json!({"champion":"Ahri","candidates":["custom-example"]}),
            )
            .unwrap();
            assert_eq!(result["documents"].as_array().unwrap().len(), 1);
            assert!(result["warnings"].as_array().unwrap().iter().any(|w| w
                .as_str()
                .unwrap()
                .contains("Invalid document excluded: augments/custom-example.md")));
            assert!(result["missing"]
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w.as_str().unwrap().contains("custom-example")));
        }
        fs::write(&bad, "x".repeat(MAX_FILE + 1)).unwrap();
        assert!(scan(&root)
            .unwrap()
            .iter()
            .any(|d| d.path == "champions/ahri.md"));
        fs::write(&bad, SEEDS[2].1).unwrap();
        let restored = retrieve_at(
            &root,
            &json!({"champion":"Ahri","candidates":["custom-example"]}),
        )
        .unwrap();
        assert_eq!(restored["documents"].as_array().unwrap().len(), 2);
        assert!(!restored["warnings"].as_array().unwrap().iter().any(|w| w
            .as_str()
            .unwrap()
            .contains("Invalid document excluded: augments/custom-example.md")));
    }

    #[test]
    fn retrieval_fingerprint_includes_unknown_version_warning_and_live_fallback() {
        let temp = Temp::new();
        let root = temp.root();
        let unknown = retrieve_at(&root, &json!({"champion":"Ahri"})).unwrap();
        let known = retrieve_at(
            &root,
            &json!({"champion":"Ahri","patch":crate::scoring::data_patch()}),
        )
        .unwrap();
        assert_eq!(unknown["documents"], known["documents"]);
        assert_eq!(unknown["missing"], known["missing"]);
        assert_ne!(unknown["warnings"], known["warnings"]);
        assert_ne!(unknown["fingerprint"], known["fingerprint"]);
        let fallback = retrieve_at(&root, &json!({"champion":"Ahri","patch":"unknown","liveData":{"gameData":{"gameVersion":crate::scoring::data_patch()}}})).unwrap();
        assert_eq!(fallback["fingerprint"], known["fingerprint"]);
        for result in [unknown, known, fallback] {
            let hashes: BTreeMap<_, _> = result["documents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| (d["path"].as_str().unwrap(), d["hash"].as_str().unwrap()))
                .collect();
            let expected = hash(&json!({"documents":hashes,"missing":result["missing"],"warnings":result["warnings"]}).to_string());
            assert_eq!(result["fingerprint"], expected);
        }
        assert!(retrieve_at(&root, &Value::Null).is_ok());
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
    fn v2_v3_seeds_are_incremental_and_preserve_user_edits() {
        let temp = Temp::new();
        let root = temp.root();
        let target = root.join("augments/1170.md");
        assert!(target.exists(), "v2 seed must add generated augment docs");
        fs::write(&target, "手工编辑\n").unwrap();
        let removed = root.join("augments/1134.md");
        fs::remove_file(&removed).unwrap();
        let champ_edited = root.join("champions/jinx.md");
        assert!(
            champ_edited.exists(),
            "v3 seed must add generated champion docs"
        );
        fs::write(&champ_edited, "英雄编辑\n").unwrap();
        let champ_removed = root.join("champions/yasuo.md");
        fs::remove_file(&champ_removed).unwrap();
        let root = root_at(&temp.0).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("augments/1170.md")).unwrap(),
            "手工编辑\n"
        );
        assert_eq!(
            fs::read_to_string(champ_edited).unwrap(),
            "英雄编辑\n",
            "champion seeds must never overwrite user edits"
        );
        assert!(!removed.exists(), "deleted documents must not come back");
        assert!(
            !champ_removed.exists(),
            "deleted champions must not come back"
        );
        assert!(root.join("augments/custom-example.md").exists());
        assert!(root.join("champions/ahri.md").exists());
        let champion_docs = fs::read_dir(root.join("champions"))
            .unwrap()
            .filter(|e| {
                let name = e.as_ref().unwrap().file_name();
                name != std::ffi::OsStr::new("index.md")
            })
            .count();
        assert_eq!(
            champion_docs, 172,
            "173 seeded champions minus the deleted yasuo, index.md excluded"
        );
    }

    #[test]
    fn v4_backfills_generated_docs_when_older_markers_preexisted() {
        let temp = Temp::new();
        fs::create_dir_all(temp.0.join("knowledge/champions")).unwrap();
        fs::create_dir_all(temp.0.join("knowledge/augments")).unwrap();
        for marker in [
            ".knowledge-seeded-v1",
            ".knowledge-seeded-v2",
            ".knowledge-seeded-v3",
        ] {
            fs::write(temp.0.join(marker), "seed attempted\n").unwrap();
        }
        let root = root_at(&temp.0).unwrap();
        assert!(
            root.join("augments/1170.md").exists(),
            "v4 must backfill generated augments left behind by stale markers"
        );
        assert!(
            root.join("champions/jinx.md").exists(),
            "v4 must backfill generated champions left behind by stale markers"
        );
        assert!(temp.0.join(".knowledge-seeded-v4").exists());
        // 补种之后，用户删除的文档不会因为再次运行而复活。
        let removed = root.join("champions/yasuo.md");
        assert!(removed.exists());
        fs::remove_file(&removed).unwrap();
        let edited = root.join("augments/1170.md");
        fs::write(&edited, "手工编辑\n").unwrap();
        let root = root_at(&temp.0).unwrap();
        assert!(!root.join("champions/yasuo.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("augments/1170.md")).unwrap(),
            "手工编辑\n"
        );
    }

    #[test]
    fn augment_seed_module_covers_generated_docs() {
        assert!(crate::seed_generated::AUGMENT_SEEDS.len() >= 211);
        for (path, content) in crate::seed_generated::AUGMENT_SEEDS {
            assert!(path.starts_with("augments/"), "{path}");
            assert_eq!(validate("Augment", path, content)["valid"], true, "{path}");
        }
    }

    #[test]
    fn champion_seed_module_covers_generated_docs() {
        // ahri/garen 是人工种子，其余英雄全部由脚本生成并内嵌。
        assert!(crate::seed_generated::CHAMPION_SEEDS.len() >= 171);
        for (path, content) in crate::seed_generated::CHAMPION_SEEDS {
            assert!(path.starts_with("champions/"), "{path}");
            assert!(!path.contains("ahri") && !path.contains("garen"), "{path}");
            assert_eq!(validate("Champion", path, content)["valid"], true, "{path}");
        }
    }

    #[test]
    fn generated_champion_seeds_validate() {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../knowledge-seed/champions");
        let mut checked = 0usize;
        let mut failures = Vec::<String>::new();
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let name = path.file_name().unwrap().to_str().unwrap().to_string();
            let content = fs::read_to_string(&path).unwrap();
            checked += 1;
            if validate("Champion", &format!("champions/{name}"), &content)["valid"] != true {
                failures.push(name);
            }
        }
        assert!(checked >= 173, "expected the full roster, found {checked}");
        assert!(failures.is_empty(), "invalid champion docs: {failures:?}");
    }

    #[test]
    fn roster_covers_packed_champions() {
        let packed: Value =
            serde_json::from_str(include_str!("../../src-tauri/data/champions.json")).unwrap();
        for row in packed["champions"].as_array().unwrap() {
            let id = row["id"].as_str().unwrap().to_lowercase();
            assert!(known_champion(&id), "{id} must pass champion validation");
        }
    }

    #[test]
    fn generated_augment_seeds_validate() {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../knowledge-seed/augments");
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
        assert!(
            checked >= 211,
            "expected at least 211 seed docs, got {checked}"
        );
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
        // 整篇放不下时按章节裁剪而不是整篇省略：两份文档都进结果，超大那份带 sections。
        assert_eq!(r["documents"].as_array().unwrap().len(), 2);
        assert!(r["missing"].as_array().unwrap().is_empty());
        let trimmed = r["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["path"] == json!(SEEDS[2].0))
            .unwrap();
        assert!(trimmed["sections"]
            .as_array()
            .is_some_and(|s| !s.is_empty()));
        assert!(trimmed["content"].as_str().unwrap().len() < huge.len());
        assert!(r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("按章节裁剪")));
        let ahri = format!("{}\n[x](../augments/example-0.md)", SEEDS[0].1);
        save_at(&root, "Champion", SEEDS[0].0, &ahri).unwrap();
        let first = root.join("augments/example-0.md");
        let text = format!("{}\n[x](example-1.md)", read_bounded(&first).unwrap());
        atomic(&first, &text).unwrap();
        let r = retrieve_at(&root, &json!({"champion":"Ahri"})).unwrap();
        assert_eq!(r["documents"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn section_split_and_priority_trim() {
        let doc = "---\ntitle: t\n---\n# 标题\n前言\n## 注意事项\nNOTE\n## 海克斯搭配\nSYN\n";
        let all = split_sections(doc);
        assert_eq!(all.len(), 4);
        let preamble = all[0].1.len();
        let (text, kept) = trim_doc(doc, "Champion", doc.len()).unwrap();
        assert_eq!(text, doc);
        assert_eq!(kept, vec!["标题", "注意事项", "海克斯搭配"]);
        let syn = all.iter().find(|(h, _)| h == "海克斯搭配").unwrap().1.len();
        let (text, kept) = trim_doc(doc, "Champion", preamble + syn).unwrap();
        assert_eq!(kept, vec!["海克斯搭配"]);
        assert!(text.starts_with("---"));
        assert!(!text.contains("NOTE"));
        assert!(trim_doc(doc, "Champion", preamble - 1).is_none());
        assert!(trim_doc(doc, "Champion", 0).is_none());
        let custom = format!("{doc}## 自定义\nCUSTOM\n");
        let (_, kept) = trim_doc(&custom, "Champion", custom.len()).unwrap();
        assert_eq!(kept, vec!["标题", "注意事项", "海克斯搭配", "自定义"]);
        // 海克斯文档用另一套优先级
        let aug = "---\ntitle: t\n---\n## 触发条件\nTRG\n## 完整效果\nEFF\n";
        let (text, kept) = trim_doc(aug, "Augment", 60).unwrap();
        assert!(kept.contains(&"完整效果".to_string()));
        assert!(text.starts_with("---"));
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
