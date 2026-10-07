//! 本地规则打分：把 OCR 识别出的文本匹配到海克斯，再按当前英雄做契合度排序。
//! 使用打包资料与只读对局上下文，不调用模型，不展示任何胜率 / 选取率 / 强度分级。
use crate::ocr::TextLine;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

const AUGMENTS_JSON: &str = include_str!("../data/augments.json");
const CHAMPIONS_JSON: &str = include_str!("../data/champions.json");
const MECHANICS_JSON: &str = include_str!("../data/scoring-mechanics.json");

#[derive(Debug, Clone, Serialize)]
pub struct MatchedCandidate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub rarity: String,
    pub category: String,
    pub score: u8,
    pub reason: String,
    pub risks: Vec<String>,
    #[serde(
        rename = "mechanismContributions",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub mechanism_contributions: Vec<MechanismContribution>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MechanismContribution {
    pub key: String,
    pub points: i32,
    pub reason: String,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone)]
struct Augment {
    id: String,
    name: String,
    aliases: Vec<String>,
    effect: String,
    rarity: String,
    category: String,
    tags: Vec<String>,
    verified: bool,
    conflicts: Vec<String>,
    normalized_names: Vec<String>,
}

#[derive(Debug, Clone)]
struct Champion {
    id: String,
    aliases: Vec<String>,
    tags: Vec<String>,
    ranged: bool,
    resource: Option<String>,
    damage: &'static str,
    mechanics: Vec<String>,
    mechanism_source: String,
    mechanism_limits: Vec<String>,
}

fn augments() -> &'static [Augment] {
    static CACHE: OnceLock<Vec<Augment>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let value: Value = serde_json::from_str(AUGMENTS_JSON).unwrap_or(Value::Null);
        value["augments"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(Augment {
                            id: item["id"].to_string().trim_matches('"').to_string(),
                            name: item["name"].as_str()?.to_string(),
                            aliases: string_list(&item["aliases"])
                                .into_iter()
                                .chain(item["nameEn"].as_str().map(str::to_owned))
                                .collect(),
                            effect: item["effect"].as_str().unwrap_or("").to_string(),
                            rarity: item["rarity"].as_str().unwrap_or("").to_string(),
                            category: item["category"].as_str().unwrap_or("").to_string(),
                            tags: string_list(&item["tags"]),
                            verified: item["verified"].as_bool().unwrap_or(false),
                            conflicts: string_list(&item["conflicts"]),
                            normalized_names: std::iter::once(item["name"].as_str()?)
                                .chain(item["nameEn"].as_str())
                                .chain(
                                    item["aliases"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .filter_map(Value::as_str),
                                )
                                .map(normalize)
                                .filter(|name| !name.is_empty())
                                .collect(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

fn champions() -> &'static [Champion] {
    static CACHE: OnceLock<Vec<Champion>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let value: Value = serde_json::from_str(CHAMPIONS_JSON).unwrap_or(Value::Null);
        let items = value
            .as_array()
            .cloned()
            .unwrap_or_else(|| value["champions"].as_array().cloned().unwrap_or_default());
        items
            .iter()
            .filter_map(|item| {
                let id = item["id"].as_str()?.to_string();
                let ranged = item["stats"]["attackrange"].as_f64().unwrap_or(0.0) >= 500.0;
                // info 是资料展示评分，不是技能伤害或属性收益；这里只保留低精度启发式。
                let damage = match (
                    item["info"]["attack"].as_f64(),
                    item["info"]["magic"].as_f64(),
                ) {
                    (Some(attack), Some(magic)) if attack >= magic + 2.0 => "physical",
                    (Some(attack), Some(magic)) if magic >= attack + 2.0 => "magic",
                    (Some(_), Some(_)) => "mixed",
                    _ => "",
                };
                Some(Champion {
                    id,
                    aliases: ["name", "nameZh", "titleZh"]
                        .into_iter()
                        .filter_map(|key| item[key].as_str().map(normalize))
                        .chain(string_list(&item["aliases"]).iter().map(|s| normalize(s)))
                        .filter(|alias| !alias.is_empty())
                        .collect(),
                    tags: string_list(&item["tags"]),
                    ranged,
                    resource: item["partype"]
                        .as_str()
                        .map(str::trim)
                        .filter(|resource| !resource.is_empty())
                        .map(str::to_owned),
                    damage,
                    mechanics: string_list(&item["mechanics"]["traits"]),
                    mechanism_source: item["abilitySource"].as_str().unwrap_or("").to_owned(),
                    mechanism_limits: string_list(&item["mechanics"]["limitations"]),
                })
            })
            .collect()
    })
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 匹配用归一化：忽略大小写、空白与中英文标点，OCR 常把标点识别丢或错。
fn normalize(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .map(|character| character.to_lowercase().next().unwrap_or(character))
        .collect()
}

#[cfg(test)]
fn matches_needle(haystack: &str, needle: &str) -> bool {
    let haystack = normalize(haystack);
    let needle = normalize(needle);
    if needle.is_empty() {
        return false;
    }
    // 精确匹配永远可信；只有较长的名称才允许被更长的行包含，避免把
    // “银色海克斯”这类界面标签误判成名称为“海克斯”的海克斯。
    haystack == needle || (needle.chars().count() >= 4 && haystack.contains(&needle))
}

/// 把任意文本归一到打包数据里的海克斯 ID：候选名/候选 ID、手填海克斯行、OCR 行都走这里。
/// 认不出来返回 None —— 宁可丢掉，也不要制造假重叠（候选槽位 ID "1"/"2"/"3" 就是这样被挡掉的）。
pub fn canonical_augment(raw: &str) -> Option<String> {
    let needle = normalize(raw);
    if needle.is_empty() {
        return None;
    }
    if let Some(augment) = augments().iter().find(|augment| augment.id == needle) {
        return Some(augment.id.clone());
    }
    let exact: Vec<&Augment> = augments()
        .iter()
        .filter(|augment| augment.normalized_names.contains(&needle))
        .collect();
    if !exact.is_empty() {
        return (exact.len() == 1).then(|| exact[0].id.clone());
    }
    let mut best: Option<(usize, String)> = None;
    let mut ambiguous = false;
    for augment in augments() {
        for token in &augment.normalized_names {
            let len = token.chars().count();
            if len >= 4 && needle.contains(token) {
                match &best {
                    Some((longest, id)) if len == *longest && id != &augment.id => {
                        ambiguous = true;
                    }
                    Some((longest, _)) if len <= *longest => {}
                    _ => {
                        best = Some((len, augment.id.clone()));
                        ambiguous = false;
                    }
                }
            }
        }
    }
    best.filter(|_| !ambiguous).map(|(_, id)| id)
}

/// 手填候选只允许精确名称/别名/标准 ID；不能把描述中的子串当成候选身份。
pub fn canonical_augment_exact(raw: &str) -> Option<String> {
    let token = normalize(raw);
    if token.is_empty() {
        return None;
    }
    if let Some(augment) = augment_by_id(&token) {
        return Some(augment.id.clone());
    }
    let matched: Vec<&Augment> = augments()
        .iter()
        .filter(|augment| augment.normalized_names.contains(&token))
        .collect();
    (matched.len() == 1).then(|| matched[0].id.clone())
}

pub fn data_patch() -> &'static str {
    static PATCH: OnceLock<String> = OnceLock::new();
    PATCH.get_or_init(|| {
        serde_json::from_str::<Value>(AUGMENTS_JSON)
            .ok()
            .and_then(|v| v["meta"]["patch"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "unknown".into())
    })
}

/// OCR 文本行 -> 同一行候选卡片上的海克斯，按左到右返回。
/// 名称本身不证明选择面板存在：已选列表、效果说明也会出现海克斯名称。
pub fn match_augments(lines: &[TextLine]) -> Vec<MatchedCandidate> {
    let mut hits: Vec<TitleHit<'_>> = lines
        .iter()
        .filter(|line| line.width > 0 && line.height > 0)
        .filter_map(|line| {
            match_title(line, augments()).map(|(augment, distance)| TitleHit {
                line,
                augment,
                exact: distance == 0,
            })
        })
        .collect();
    hits.sort_by_key(|hit| {
        (
            u64::from(hit.line.x) * 2 + u64::from(hit.line.width),
            hit.line.y,
        )
    });

    let mut groups = Vec::new();
    for left in 0..hits.len() {
        for middle in left + 1..hits.len() {
            for right in middle + 1..hits.len() {
                let group = [left, middle, right];
                let titles = group.map(|index| &hits[index]);
                if titles.iter().any(|hit| hit.exact) && title_row(&titles) {
                    groups.push(group.to_vec());
                }
            }
        }
    }
    if groups.is_empty() {
        // 部分识别必须有选择面板标记，且两个名字都精确匹配；不能用两个
        // 模糊命中或计分板上零散的已选名称拼成一轮新候选。
        for left in 0..hits.len() {
            for right in left + 1..hits.len() {
                let titles = [&hits[left], &hits[right]];
                if titles.iter().all(|hit| hit.exact)
                    && title_row(&titles)
                    && has_panel_marker(lines, &titles)
                {
                    groups.push(vec![left, right]);
                }
            }
        }
    }
    // 多组布局同时成立时不能任意截取前三个，这常见于计分板/已选详情。
    if groups.len() != 1 {
        return Vec::new();
    }
    groups[0]
        .iter()
        .map(|index| hits[*index].augment)
        .map(|augment| MatchedCandidate {
            id: augment.id.clone(),
            name: augment.name.clone(),
            description: augment.effect.clone(),
            rarity: augment.rarity.clone(),
            category: augment.category.clone(),
            score: 0,
            reason: String::new(),
            risks: Vec::new(),
            mechanism_contributions: Vec::new(),
        })
        .collect()
}

struct TitleHit<'a> {
    line: &'a TextLine,
    augment: &'a Augment,
    exact: bool,
}

fn match_title<'a>(line: &TextLine, catalog: &'a [Augment]) -> Option<(&'a Augment, usize)> {
    if !line.score.is_finite() || line.score < 0.6 {
        return None;
    }
    let text = normalize(&line.text);
    let mut best: Option<(&Augment, usize)> = None;
    let mut ambiguous = false;
    for augment in catalog {
        for name in &augment.normalized_names {
            // 整行精确匹配，不能把「获得泰坦的坚决效果」中的名称当成标题。
            let distance = if text == *name {
                Some(0)
            } else if line.score >= 0.75 {
                fuzzy_augment_distance(&text, name)
            } else {
                None
            };
            let Some(distance) = distance else { continue };
            match best {
                Some((seen, previous)) if distance == previous && seen.id != augment.id => {
                    ambiguous = true;
                }
                Some((_, previous)) if distance >= previous => {}
                _ => {
                    best = Some((augment, distance));
                    ambiguous = false;
                }
            }
        }
    }
    best.filter(|_| !ambiguous)
}

fn fuzzy_augment_distance(text: &str, name: &str) -> Option<usize> {
    let text: Vec<char> = text.chars().collect();
    let name: Vec<char> = name.chars().collect();
    // 短词/英文的一个字符变化容易变成完全不同的普通词；只放宽中文标题。
    let chinese = |characters: &[char]| {
        characters
            .iter()
            .all(|character| ('\u{3400}'..='\u{9fff}').contains(character))
    };
    if text.len() < 4 || text.len() > name.len() || !chinese(&text) || !chinese(&name) {
        return None;
    }
    let allowance = match name.len() {
        0..=3 => return None,
        4..=7 => 1,
        _ => 2,
    };
    bounded_edit_distance(&text, &name, allowance)
}

fn title_row(titles: &[&TitleHit<'_>]) -> bool {
    let min_height = titles.iter().map(|hit| hit.line.height).min().unwrap_or(0) as f64;
    let max_height = titles.iter().map(|hit| hit.line.height).max().unwrap_or(0) as f64;
    if min_height == 0.0 || max_height > min_height * 1.6 {
        return false;
    }
    let centers: Vec<(f64, f64)> = titles
        .iter()
        .map(|hit| {
            (
                hit.line.x as f64 + hit.line.width as f64 / 2.0,
                hit.line.y as f64 + hit.line.height as f64 / 2.0,
            )
        })
        .collect();
    let min_y = centers
        .iter()
        .map(|(_, y)| *y)
        .fold(f64::INFINITY, f64::min);
    let max_y = centers.iter().map(|(_, y)| *y).fold(0.0, f64::max);
    if max_y - min_y > max_height * 0.65 {
        return false;
    }
    for (index, adjacent) in titles.windows(2).enumerate() {
        if adjacent[0].augment.id == adjacent[1].augment.id
            || centers[index + 1].0 - centers[index].0 < max_height * 3.0
            || adjacent[1].line.x as f64
                - (adjacent[0].line.x as f64 + adjacent[0].line.width as f64)
                < max_height
        {
            return false;
        }
    }
    if titles.len() == 3 {
        let left_gap = centers[1].0 - centers[0].0;
        let right_gap = centers[2].0 - centers[1].0;
        if titles[0].augment.id == titles[2].augment.id
            || (left_gap - right_gap).abs() > left_gap.max(right_gap) * 0.35
        {
            return false;
        }
    }
    true
}

fn has_panel_marker(lines: &[TextLine], titles: &[&TitleHit<'_>]) -> bool {
    let first = titles[0].line;
    let last = titles[titles.len() - 1].line;
    let spacing =
        (last.x as f64 + last.width as f64 / 2.0) - (first.x as f64 + first.width as f64 / 2.0);
    lines.iter().any(|line| {
        if !line.score.is_finite() || line.score < 0.6 {
            return false;
        }
        let text = normalize(&line.text);
        if [
            "银色海克斯",
            "金色海克斯",
            "棱彩海克斯",
            "银色强化",
            "金色强化",
            "棱彩强化",
            "silveraugment",
            "goldaugment",
            "prismaticaugment",
        ]
        .contains(&text.as_str())
        {
            return titles.iter().any(|title| {
                let title = title.line;
                let delta_y = line.y as f64 - title.y as f64;
                let delta_x = (line.x as f64 + line.width as f64 / 2.0)
                    - (title.x as f64 + title.width as f64 / 2.0);
                delta_y >= title.height as f64 * 0.6
                    && delta_y <= title.height as f64 * 4.0
                    && delta_x.abs() <= spacing * 0.4
            });
        }
        [
            "选择一个强化符文",
            "选择强化符文",
            "选择海克斯",
            "选择一个海克斯",
            "选择你的强化符文",
            "chooseanaugment",
            "selectanaugment",
        ]
        .contains(&text.as_str())
            && line.y < first.y
            && first.y - line.y <= first.height.saturating_mul(12)
            && line.x as f64 + line.width as f64 / 2.0 >= first.x as f64 - spacing * 0.5
            && line.x as f64 <= last.x as f64 + last.width as f64 + spacing * 0.5
    })
}

fn bounded_edit_distance(left: &[char], right: &[char], limit: usize) -> Option<usize> {
    if left.len().abs_diff(right.len()) > limit {
        return None;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0; right.len() + 1];
    for (i, left_char) in left.iter().enumerate() {
        current[0] = i + 1;
        let mut row_min = current[0];
        for (j, right_char) in right.iter().enumerate() {
            current[j + 1] = (previous[j + 1] + 1)
                .min(current[j] + 1)
                .min(previous[j] + usize::from(left_char != right_char));
            row_min = row_min.min(current[j + 1]);
        }
        if row_min > limit {
            return None;
        }
        std::mem::swap(&mut previous, &mut current);
    }
    (previous[right.len()] <= limit).then_some(previous[right.len()])
}

#[derive(Debug, Clone, Default)]
struct Profile {
    role: Option<&'static str>,
    ranged: Option<bool>,
    resource: Option<&'static str>,
    uses_mana: Option<bool>,
    damage: &'static str,
    mechanics: Vec<String>,
    mechanism_source: String,
    mechanism_limits: Vec<String>,
}

fn profile(champion: Option<&str>) -> Profile {
    let Some(key) = champion else {
        return Profile::default();
    };
    let normalized = normalize(key);
    if normalized.is_empty() {
        return Profile::default();
    }
    let Some(found) = champions()
        .iter()
        .find(|c| normalize(&c.id) == normalized || c.aliases.contains(&normalized))
    else {
        return Profile::default();
    };
    // 尊重数据源的主职业顺序，而不是把所有多职业英雄强行套入统一优先级。
    let role = found.tags.iter().find_map(|tag| {
        ["Marksman", "Tank", "Mage", "Assassin", "Fighter", "Support"]
            .into_iter()
            .find(|role| *role == tag)
    });
    let resource = found.resource.as_deref();
    Profile {
        role,
        ranged: Some(found.ranged),
        resource,
        uses_mana: resource
            .map(|resource| resource == "法力" || resource.eq_ignore_ascii_case("mana")),
        damage: found.damage,
        mechanics: found.mechanics.clone(),
        mechanism_source: found.mechanism_source.clone(),
        mechanism_limits: found.mechanism_limits.clone(),
    }
}

fn role_tag_affinity<'a>(
    role: Option<&str>,
    tags: &'a [String],
    uses_mana: Option<bool>,
) -> (i32, Vec<&'a str>) {
    let affinity: &[(&str, &[&str], i32)] = &[
        ("Marksman", &["crit", "as", "onhit", "ad"], 12),
        ("Mage", &["ap", "ultimate", "mana", "haste", "cc"], 11),
        ("Tank", &["tank", "hp", "sustain", "cc"], 13),
        (
            "Assassin",
            &["ad", "ap", "mobility", "ultimate", "haste"],
            11,
        ),
        ("Fighter", &["ad", "sustain", "as", "hp"], 10),
        ("Support", &["cc", "summoner", "haste", "utility"], 11),
    ];
    let Some(role) = role else {
        return (0, Vec::new());
    };
    let Some((_, wanted, weight)) = affinity.iter().find(|(name, _, _)| *name == role) else {
        return (0, Vec::new());
    };
    let matched: Vec<&str> = tags
        .iter()
        .map(String::as_str)
        .filter(|tag| wanted.contains(tag) && (*tag != "mana" || uses_mana == Some(true)))
        .collect();
    (matched.len() as i32 * *weight, matched)
}

fn category_score(role: Option<&str>, category: &str) -> i32 {
    match (role, category) {
        (Some("Marksman"), "damage") => 8,
        (Some("Marksman"), "utility") => 4,
        (Some("Mage"), "damage") => 8,
        (Some("Mage"), "utility") => 6,
        (Some("Tank"), "defense") => 12,
        (Some("Fighter"), "defense") => 6,
        (Some("Fighter"), "damage") => 6,
        (Some("Support"), "utility") => 12,
        (Some("Assassin"), "damage") => 10,
        (_, "economy") => 4,
        _ => 2,
    }
}

fn rarity_score(rarity: &str) -> i32 {
    match rarity {
        "prismatic" => 5,
        "gold" => 3,
        "silver" => 1,
        _ => 0,
    }
}

fn augment_by_id(id: &str) -> Option<&'static Augment> {
    augments().iter().find(|augment| augment.id == id)
}

/// 客户端给的海克斯 id / 名称 / 别名 → 打包数据里的标准名称。
/// 认不出的纯数字 id 返回 None：宁可缺一条，也不编造名称。
pub fn augment_label(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Some(augment) = augment_by_id(text) {
        return Some(augment.name.clone());
    }
    if let Some(augment) = augments()
        .iter()
        .find(|augment| augment.name.eq_ignore_ascii_case(text))
    {
        return Some(augment.name.clone());
    }
    let lower = text.to_ascii_lowercase();
    if let Some(augment) = augments().iter().find(|augment| {
        augment
            .aliases
            .iter()
            .any(|alias| alias.to_ascii_lowercase() == lower)
    }) {
        return Some(augment.name.clone());
    }
    if text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // 客户端给的本体文本（可能比打包数据新）按原样保留，属于真实观测。
    Some(text.to_string())
}

/// 当前上下文下的本地契合度打分：0-100 相对契合度，与胜率无关。
/// 给结构化决策分析用的本地先验：候选的静态元数据 + 本地规则打分与理由。
/// 只作为发给模型的补充事实，不替代模型判断。
pub fn prior(ids: &[String], champion: Option<&str>, owned: &[String]) -> Value {
    prior_with_context(ids, champion, owned, &[])
}

pub fn prior_with_context(
    ids: &[String],
    champion: Option<&str>,
    owned: &[String],
    items: &[Value],
) -> Value {
    let ranked =
        rank_with_context(ids, champion, owned, items).unwrap_or_else(|_| json!({"ranking": []}));
    let profile = profile(champion);
    let by_id: std::collections::HashMap<&str, &Value> = ranked["ranking"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| Some((item["id"].as_str()?, item)))
                .collect()
        })
        .unwrap_or_default();
    let mut out = serde_json::Map::new();
    for id in ids {
        let Some(augment) = augment_by_id(id) else {
            continue;
        };
        let mut entry = json!({
            "rarity": augment.rarity,
            "category": augment.category,
            "tags": augment.tags,
            "verified": augment.verified,
            "conflicts": augment.conflicts,
            "priorReliability": prior_reliability(augment),
            "dataWarnings": data_warnings(augment),
            "profileWarnings": profile_warnings(&profile, augment),
            "alreadyOwned": owned.iter().any(|raw| canonical_augment(raw).as_deref() == Some(id.as_str())),
            "mechanics": reviewed_mechanics(augment),
            "contextCoverage": ranked["profile"]["contextCoverage"].clone(),
        });
        if let Some(item) = by_id.get(id.as_str()) {
            entry["localScore"] = item["score"].clone();
            entry["localReason"] = item["reason"].clone();
            entry["localRisks"] = item["risks"].clone();
            entry["mechanismContributions"] = item["mechanismContributions"].clone();
        }
        out.insert(id.clone(), entry);
    }
    Value::Object(out)
}

fn data_warnings(augment: &Augment) -> Vec<String> {
    let mut warnings = Vec::new();
    if !augment.verified {
        warnings.push("效果与推导标签未经游戏内核验".into());
    }
    if !augment.conflicts.is_empty() {
        warnings.push("效果或稀有度存在来源分歧，请核对游戏内描述".into());
    }
    if augment.effect.contains(['?', '？']) {
        warnings.push("本地效果含未解析数值占位符，请补充真实数值".into());
    }
    if augment.effect.trim().is_empty() {
        warnings.push("本地数据缺少完整效果".into());
    }
    if !mechanics()["augments"][&augment.id].is_null() && reviewed_mechanics(augment).is_none() {
        warnings
            .push("机制目录与当前数据版本或完整效果不一致，旧机制已停用并回退，需重新核实".into());
    }
    warnings
}

fn prior_reliability(augment: &Augment) -> f64 {
    if augment.effect.trim().is_empty() {
        0.0
    } else if augment.effect.contains(['?', '？']) {
        0.25
    } else if !augment.conflicts.is_empty() {
        0.5
    } else if !augment.verified {
        0.75
    } else {
        1.0
    }
}

fn profile_warnings(profile: &Profile, augment: &Augment) -> Vec<String> {
    let mut warnings = Vec::new();
    if profile.role.is_none() {
        warnings.push("未匹配英雄资料，未评估职业、资源与技能适配".into());
    }
    if augment.effect.contains("不能使用你的终极技能") {
        warnings.push("本地描述明确禁用终极技能，不计入终极技能契合收益".into());
    }
    if augment.tags.iter().any(|tag| tag == "range") {
        // 此标签同时涵盖加射程、变为近战、指定技能触发；不能据此统一奖励远程或惩罚近战。
        warnings.push("攻击距离标签不代表远程专用，实际收益需核对效果原文与英雄普攻方式".into());
    }
    if augment.tags.iter().any(|tag| tag == "mana") {
        match profile.uses_mana {
            Some(false) => warnings.push(format!(
                "英雄资源为{}，不计入法力标签加分；请核对游戏内对非法力英雄的效果",
                profile.resource.unwrap_or("未知")
            )),
            None => warnings.push("英雄资源类型未知，不计入法力标签加分".into()),
            Some(true) => {}
        }
    }
    if !profile.damage.is_empty() {
        warnings
            .push("伤害倾向仅由 Data Dragon 的 attack/magic 评分粗略推断，不代表技能伤害占比或当前出装收益".into());
    }
    if profile.mechanics.is_empty() {
        warnings.push("英雄技能机制资料未收录，技能协同项不加分；职业标签仅作低精度参考".into());
    }
    warnings
}

pub fn rank(ids: &[String], champion: Option<&str>, owned: &[String]) -> Result<Value, String> {
    rank_with_context(ids, champion, owned, &[])
}

fn mechanics() -> &'static Value {
    static CACHE: OnceLock<Value> = OnceLock::new();
    CACHE.get_or_init(|| {
        serde_json::from_str(MECHANICS_JSON).expect("bundled mechanism data is valid JSON")
    })
}

fn reviewed_rules_in<'a>(augment: &Augment, catalog: &'a Value, patch: &str) -> Option<&'a Value> {
    let rules = &catalog["augments"][&augment.id];
    // ID 会跨版本沿用，不能据此把旧效果规则套在更新后的同名海克斯上。
    (catalog["patch"].as_str() == Some(patch)
        && !augment.effect.trim().is_empty()
        && rules["evidence"].as_str() == Some(augment.effect.as_str())
        && rules["grants"]
            .as_array()
            .is_some_and(|facts| !facts.is_empty()))
    .then_some(rules)
}

fn reviewed_mechanics(augment: &Augment) -> Option<&'static Value> {
    reviewed_rules_in(augment, mechanics(), data_patch())
}

#[derive(Default)]
struct Equipment {
    flat_ap: f64,
    unconditional: Vec<String>,
    spellblade: Vec<String>,
    observed: usize,
    known_stats: usize,
    unknown_ids: Vec<String>,
}

fn item_id(item: &Value) -> Option<String> {
    let raw = item
        .get("itemID")
        .or_else(|| item.get("itemId"))
        .or_else(|| item.get("id"))
        .unwrap_or(item);
    let id = raw
        .as_u64()
        .or_else(|| raw.as_str().and_then(|raw| raw.parse::<u64>().ok()))?;
    (id > 0).then(|| id.to_string())
}

fn equipment(items: &[Value]) -> Equipment {
    let data = mechanics();
    let mut out = Equipment::default();
    for item in items {
        let Some(id) = item_id(item) else { continue };
        // Live Client Data 的 count 表示同一格中的数量；零数量不代表仍装备。
        let count = item
            .get("count")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .min(6);
        if count == 0 {
            continue;
        }
        out.observed += 1;
        let known = data["knownStatItems"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|known| known.to_string() == id));
        if known {
            out.known_stats += 1;
            out.flat_ap += data["flatAbilityPower"][&id].as_f64().unwrap_or(0.0) * count as f64;
        } else if !out.unknown_ids.contains(&id) {
            out.unknown_ids.push(id.clone());
        }
        let target = match data["items"][&id]["onHit"].as_str() {
            Some("unconditional") => &mut out.unconditional,
            Some("spellblade") => &mut out.spellblade,
            _ => continue,
        };
        // 同类装备重复只计一次触发机制，不假设唯一被动可叠加。
        if !target.contains(&id) {
            target.push(id);
        }
    }
    out
}

fn has_fact(value: &Value, key: &str, fact: &str) -> bool {
    value[key]
        .as_array()
        .is_some_and(|facts| facts.iter().any(|value| value.as_str() == Some(fact)))
}

fn mechanism_points(
    augment: &Augment,
    profile: &Profile,
    equipment: &Equipment,
    owned: &[String],
) -> (Vec<MechanismContribution>, Vec<String>) {
    let data = mechanics();
    let rules = reviewed_mechanics(augment).unwrap_or(&Value::Null);
    let mut contributions = Vec::new();
    let mut risks = string_list(&rules["limitations"]);
    let source = format!("knowledge:augments/{}", augment.id);
    let item_source = data["itemSource"].as_str().unwrap_or("").to_string();
    let mut add = |key: &str, points: i32, reason: String, sources: Vec<String>| {
        contributions.push(MechanismContribution {
            key: key.into(),
            points,
            reason,
            sources,
        });
    };
    let resource_allowed = !has_fact(rules, "requires", "mana") || profile.uses_mana == Some(true);
    if has_fact(rules, "requires", "mana") && !resource_allowed {
        risks.push("该机制需要法力，当前资源不满足或未知，不计攻击特效协同加分".into());
    }
    if has_fact(rules, "grants", "spell-on-hit") {
        if profile.mechanics.iter().any(|fact| fact == "spell-damage") {
            add(
                "spell-delivery",
                5,
                "官方技能资料确认有伤害技能，可提供攻击特效的技能命中入口".into(),
                vec![source.clone(), profile.mechanism_source.clone()],
            );
        }
        if profile
            .mechanics
            .iter()
            .any(|fact| fact == "returning-projectile")
        {
            add(
                "repeat-spell-opportunity",
                3,
                "技能含去程/回程伤害，提供再次命中的机会；仍受每目标触发间隔限制".into(),
                vec![source.clone(), profile.mechanism_source.clone()],
            );
        }
        if !equipment.unconditional.is_empty() {
            let names: Vec<&str> = equipment
                .unconditional
                .iter()
                .filter_map(|id| data["items"][id]["name"].as_str())
                .collect();
            add(
                "item-on-hit",
                (16 + (names.len() as i32 - 1) * 3).min(22),
                format!(
                    "已装备{}，官方描述含攻击特效，技能施加攻击特效有明确收益来源",
                    names.join("、")
                ),
                vec![source.clone(), item_source.clone()],
            );
        }
        if !equipment.spellblade.is_empty() {
            let names: Vec<&str> = equipment
                .spellblade
                .iter()
                .filter_map(|id| data["items"][id]["name"].as_str())
                .collect();
            add(
                "conditional-item-on-hit",
                6,
                format!(
                    "{}含施法后强化下次攻击的攻击特效，仅计有条件的协同机会",
                    names.join("、")
                ),
                vec![source.clone(), item_source.clone()],
            );
            risks.push(
                "咒刃需满足先施法、强化攻击及自身触发限制，不能视作每次技能命中都触发".into(),
            );
        }
        let compatible: Vec<&Augment> = owned
            .iter()
            .filter_map(|id| {
                let augment = augment_by_id(id)?;
                let owned_rules = reviewed_mechanics(augment)?;
                (has_fact(owned_rules, "grants", "on-hit-payload")
                    && (!has_fact(owned_rules, "requires", "mana")
                        || profile.uses_mana == Some(true)))
                .then_some(augment)
            })
            .collect();
        if !compatible.is_empty() {
            let names: Vec<&str> = compatible
                .iter()
                .map(|augment| augment.name.as_str())
                .collect();
            let sources = std::iter::once(source.clone())
                .chain(
                    compatible
                        .iter()
                        .map(|augment| format!("knowledge:augments/{}", augment.id)),
                )
                .collect();
            add(
                "owned-on-hit",
                (compatible.len() as i32 * 10).min(20),
                format!(
                    "已选{}的原文明确提供攻击特效收益，可与技能施加攻击特效形成候选协同",
                    names.join("、")
                ),
                sources,
            );
            risks.push(
                "已选海克斯协同依据本地效果原文，不推断特殊递归、无限循环或实际触发次数".into(),
            );
        }
        if equipment.unconditional.is_empty()
            && equipment.spellblade.is_empty()
            && compatible.is_empty()
        {
            risks.push(
                "未核实可转移的攻击特效来源；不把三环、强化普攻或职业标签当作已证实的特殊联动"
                    .into(),
            );
        }
        risks.extend(profile.mechanism_limits.clone());
    }
    if resource_allowed && has_fact(rules, "grants", "on-hit-payload") {
        if let Some(converter) = owned.iter().find(|id| {
            augment_by_id(id)
                .and_then(reviewed_mechanics)
                .is_some_and(|rules| has_fact(rules, "grants", "spell-on-hit"))
        }) {
            add(
                "owned-spell-delivery",
                12,
                "已选海克斯可让技能施加攻击特效，为此效果增加触发入口".into(),
                vec![source.clone(), format!("knowledge:augments/{converter}")],
            );
        }
        if profile
            .mechanics
            .iter()
            .any(|fact| fact == "empowered-attack")
        {
            add(
                "attack-pattern",
                4,
                "英雄技能包含强化普攻，具有使用攻击特效的攻击场景；特殊交互仍未知".into(),
                vec![source.clone(), profile.mechanism_source.clone()],
            );
        }
    }
    if has_fact(rules, "grants", "shield") && has_fact(rules, "scalesWith", "ap") {
        if equipment.flat_ap > 0.0 {
            add(
                "equipment-ap-shield",
                (4 + (equipment.flat_ap / 20.0).floor() as i32).min(16),
                format!(
                    "已装备物品的官方基础 AP 合计约 {:.0}，可支持按 AP 缩放的护盾收益",
                    equipment.flat_ap
                ),
                vec![source, item_source],
            );
        } else {
            risks.push("未取得已装备物品的基础 AP 支持，不根据法师/刺客标签虚构护盾量".into());
        }
        risks.push(
            "装备基础 AP 不等于当前面板 AP；未计被动乘区、层数、符文和模式修正，不估算最终护盾量"
                .into(),
        );
    }
    if !rules.is_null() && !equipment.unknown_ids.is_empty() {
        risks.push(format!(
            "装备 ID {} 未收录，未推断其属性或攻击特效",
            equipment.unknown_ids.join("、")
        ));
    }
    (contributions, risks)
}

pub fn rank_with_context(
    ids: &[String],
    champion: Option<&str>,
    owned: &[String],
    items: &[Value],
) -> Result<Value, String> {
    if ids.is_empty() {
        return Ok(json!({"ranking": [], "summary": "未识别到候选海克斯"}));
    }
    let profile = profile(champion);
    let equipment = equipment(items);
    let mut owned: Vec<String> = owned
        .iter()
        .filter_map(|name| canonical_augment(name))
        .collect();
    owned.sort();
    owned.dedup();
    let mut ranking = Vec::new();
    for id in ids {
        let Some(augment) = augment_by_id(id) else {
            continue;
        };
        let mut score: i32 = 50;
        let mut reasons = Vec::new();
        let mut risks = data_warnings(augment);
        risks.extend(profile_warnings(&profile, augment));
        let role = profile.role;
        // 有定向机制资料时不再把“施加攻击特效”或“按 AP 缩放”当作获得属性。
        let reviewed = reviewed_mechanics(augment).is_some();
        let (tag_score, matched_tags) = if reviewed {
            (0, Vec::new())
        } else {
            role_tag_affinity(role, &augment.tags, profile.uses_mana)
        };
        if tag_score > 0 {
            score += tag_score.min(26);
            reasons.push(format!(
                "{}契合{}",
                role.unwrap_or("英雄"),
                matched_tags.join("、")
            ));
        }
        let category_points = category_score(role, &augment.category);
        score += category_points;
        if category_points >= 8 {
            reasons.push(format!("分类{}补强", augment.category));
        }
        score += rarity_score(&augment.rarity);
        let (mut mechanism_contributions, mechanism_risks) =
            mechanism_points(augment, &profile, &equipment, &owned);
        let mut mechanism_budget = 40;
        for contribution in &mut mechanism_contributions {
            contribution.points = contribution.points.min(mechanism_budget);
            mechanism_budget -= contribution.points;
        }
        mechanism_contributions.retain(|contribution| contribution.points > 0);
        score += 40 - mechanism_budget;
        reasons.extend(
            mechanism_contributions
                .iter()
                .map(|contribution| contribution.reason.clone()),
        );
        risks.extend(mechanism_risks);
        if owned.contains(&augment.id) {
            score = 0;
            mechanism_contributions.clear();
            reasons.clear();
            reasons.push("已选取过的海克斯不作为新候选推荐".into());
            risks.push("该海克斯已经选取过".into());
        }
        if reasons.is_empty() {
            reasons.push(if reviewed {
                "没有足够的已核实机制上下文，按基础分类回退，不猜测联动".into()
            } else {
                "未命中明确的职业标签契合，按基础契合度与分类给分".into()
            });
        }
        ranking.push(MatchedCandidate {
            id: augment.id.clone(),
            name: augment.name.clone(),
            description: augment.effect.clone(),
            rarity: augment.rarity.clone(),
            category: augment.category.clone(),
            score: score.clamp(0, 100) as u8,
            reason: reasons.join(" · "),
            risks,
            mechanism_contributions,
        });
    }
    ranking.sort_by(|left, right| right.score.cmp(&left.score).then(left.id.cmp(&right.id)));
    Ok(json!({
        "ranking": ranking,
        "summary": format!(
            "本地规则排序 {} 个候选（{}）· 非 AI，结合已收录机制、当前装备与已选海克斯；缺失项回退",
            ranking.len(), match champion { Some(key) => key, None => "未识别当前英雄", }
        ),
        "profile": {
            "champion": champion.unwrap_or(""), "role": profile.role.unwrap_or(""),
            "ranged": profile.ranged, "resource": profile.resource.unwrap_or(""),
            "usesMana": profile.uses_mana, "damage": profile.damage,
            "damageSource": if profile.damage.is_empty() { "" } else { "ddragon-info-heuristic" },
            "mechanisms": profile.mechanics, "mechanismSource": profile.mechanism_source,
            "contextCoverage": {
                "championMechanismsKnown": !profile.mechanics.is_empty(),
                "observedItemEntries": equipment.observed, "knownItemStats": equipment.known_stats,
                "unknownItemIds": equipment.unknown_ids, "equipmentBaseAbilityPower": equipment.flat_ap,
                "itemSource": mechanics()["itemSource"], "mechanismCatalogPatch": mechanics()["patch"],
                "mechanismCatalogMatchesDataPatch": mechanics()["patch"].as_str() == Some(data_patch()),
                "onHitItemCoverage": "curated-partial",
            },
        },
    }))
}

#[tauri::command(async)]
pub fn score_candidates(
    app: tauri::AppHandle,
    ids: Vec<String>,
    champion: Option<String>,
    level: Option<u32>,
    owned: Vec<String>,
    items: Option<Vec<Value>>,
) -> Result<Value, String> {
    let mut ranked = rank_with_context(
        &ids,
        champion.as_deref(),
        &owned,
        items.as_deref().unwrap_or(&[]),
    )?;
    if let Some(level) = level {
        ranked["level"] = json!(level);
    }
    if let Ok((_, logs)) = crate::collector::directories(&app) {
        let summary = ranked["ranking"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .take(3)
                    .map(|item| {
                        format!(
                            "{}:{}",
                            item["name"].as_str().unwrap_or("?"),
                            item["score"].as_u64().unwrap_or(0)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let _ = crate::collector::append_log(
            &logs,
            "info",
            "score-candidates",
            &format!(
                "ids={} level={} champion={} top=[{summary}]",
                ids.len(),
                level.unwrap_or(0),
                champion.as_deref().unwrap_or("-")
            ),
        );
    }
    Ok(ranked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn champion_aliases_and_primary_role_are_used() {
        assert_eq!(profile(Some("Garen")).role, Some("Fighter"));
        assert_eq!(profile(Some("MasterYi")).role, Some("Fighter"));
        assert_eq!(
            profile(Some("Wukong")).role,
            profile(Some("MonkeyKing")).role
        );
        assert!(profile(Some("Wukong")).role.is_some());
        assert_eq!(profile(Some("Kai'Sa")).role, profile(Some("Kaisa")).role);
    }

    #[test]
    fn resource_profile_uses_bundled_partype_and_keeps_missing_resource_unknown() {
        let mana = profile(Some("Ahri"));
        assert_eq!(mana.resource, Some("法力"));
        assert_eq!(mana.uses_mana, Some(true));
        for champion in ["Kennen", "Akali", "Garen", "Vladimir", "Rumble"] {
            assert_eq!(profile(Some(champion)).uses_mana, Some(false), "{champion}");
        }
        // 打包的 Belveth partype 为空；mp 数值不应被当成法力机制证据。
        assert_eq!(profile(Some("Belveth")).uses_mana, None);
        assert_eq!(profile(Some("unknown champion")).uses_mana, None);
        assert_eq!(profile(None).uses_mana, None);
    }

    #[test]
    fn mana_affinity_requires_mana_and_preserves_other_effects() {
        // 由心及物只对同为 Mage 的阿狸增加 mana 契合分，凯南和弗拉基米尔不加。
        let mana = rank(&["1056".into()], Some("Ahri"), &[]).unwrap();
        assert_eq!(mana["ranking"][0]["score"], 64);
        assert_eq!(mana["profile"]["usesMana"], true);
        for champion in ["Kennen", "Vladimir"] {
            let non_mana = rank(&["1056".into()], Some(champion), &[]).unwrap();
            assert_eq!(non_mana["ranking"][0]["score"], 53, "{champion}");
            assert_eq!(non_mana["profile"]["usesMana"], false);
            assert!(non_mana["ranking"][0]["risks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|risk| risk.as_str().unwrap().contains("不计入法力标签加分")));
        }

        // 注魔有 mana 之外的 ap/crit/onhit 标签；非法力英雄不会整条归零或丢掉其他匹配。
        let energy = rank(&["2016".into()], Some("Kennen"), &[]).unwrap();
        assert_eq!(energy["ranking"][0]["score"], 59);
        assert!(!energy["ranking"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("Mage契合ap"));
        assert!(!energy["ranking"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("mana"));
        let unknown = rank(&["2016".into()], Some("Belveth"), &[]).unwrap();
        assert!(unknown["profile"]["usesMana"].is_null());
        assert!(unknown["ranking"][0]["risks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|risk| risk.as_str().unwrap().contains("英雄资源类型未知")));

        let owned = prior(&["2016".into()], Some("Kennen"), &["注魔".into()]);
        assert_eq!(owned["2016"]["localScore"], 0);
        assert_eq!(owned["2016"]["alreadyOwned"], true);
        assert_eq!(owned["2016"]["verified"], false);
        assert_eq!(owned["2016"]["priorReliability"], 0.75);
        assert!(!owned["2016"]["dataWarnings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn melee_attack_speed_and_crit_have_no_universal_penalty() {
        let ranked = rank(&["1022".into(), "1047".into()], Some("MasterYi"), &[]).unwrap();
        let by_id: std::collections::HashMap<&str, u64> = ranked["ranking"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["id"].as_str().unwrap(),
                    item["score"].as_u64().unwrap(),
                )
            })
            .collect();
        // 灵巧保留 Fighter 的攻速契合；关键暴击没有仅因近战而被额外扣 4 分。
        assert_eq!(by_id["1022"], 67);
        assert_eq!(by_id["1047"], 59);
    }

    #[test]
    fn damage_heuristic_is_explicitly_uncertain_in_rank_and_prior() {
        for champion in ["Garen", "Ahri", "Kennen"] {
            let ranked = rank(&["2009".into()], Some(champion), &[]).unwrap();
            assert_eq!(ranked["profile"]["damageSource"], "ddragon-info-heuristic");
            let risks = ranked["ranking"][0]["risks"].as_array().unwrap();
            assert!(risks.iter().any(|risk| risk
                .as_str()
                .unwrap()
                .contains("评分粗略推断，不代表技能伤害占比或当前出装收益")));
            let prior = prior(&["2009".into()], Some(champion), &[]);
            assert_eq!(prior["2009"]["localRisks"], ranked["ranking"][0]["risks"]);
            assert_eq!(prior["2009"]["priorReliability"], 0.5);
            assert_eq!(prior["2009"]["conflicts"], json!(["effect"]));
        }
        let unknown = rank(&["2009".into()], None, &[]).unwrap();
        assert_eq!(unknown["profile"]["damage"], "");
        assert_eq!(unknown["profile"]["damageSource"], "");
    }

    #[test]
    fn low_confidence_lines_do_not_create_candidates_and_owned_ids_are_supported() {
        let mut weak = line("万用瞄准镜", 10, 20);
        weak.score = 0.2;
        assert!(match_augments(&[weak]).is_empty());
        assert_eq!(
            rank(&["1170".into()], Some("Jinx"), &["1170".into()]).unwrap()["ranking"][0]["score"],
            0
        );
        assert!(canonical_augment_exact("获得循环往复效果").is_none());
    }

    #[test]
    fn matching_recovers_small_ocr_errors_without_guessing_short_or_ambiguous_names() {
        let matched = match_augments(&[
            line("万用喵准镜", 200, 93),
            line("亮出你剑", 202, 594),
            line("巨像的勇气", 202, 1094),
        ]);
        let names: Vec<&str> = matched
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect();
        assert_eq!(names, vec!["万用瞄准镜", "亮出你的剑", "巨像的勇气"]);

        assert!(match_augments(&[line("胜力", 100, 100), line("海克土", 120, 100)]).is_empty());
        let mut weak_typo = line("万用喵准镜", 200, 93);
        weak_typo.score = 0.5;
        assert!(match_augments(&[weak_typo]).is_empty());
    }

    #[test]
    fn fuzzy_matching_uses_nearest_name_and_rejects_equal_distance() {
        let mut close = augment_by_id("1170").unwrap().clone();
        close.normalized_names = vec!["甲乙丙丁戊己庚辛".into()];
        let mut longer = augment_by_id("1018").unwrap().clone();
        longer.normalized_names = vec!["甲乙丙丁戊己庚壬癸".into()];
        let catalog = [longer, close];
        assert_eq!(
            match_title(&line("甲乙丙丁戊己庚子", 100, 100), &catalog)
                .map(|(augment, distance)| (augment.id.as_str(), distance)),
            Some(("1170", 1)),
        );
        let mut tied = catalog[0].clone();
        tied.normalized_names = vec!["甲乙丙丁戊己庚壬".into()];
        assert!(match_title(
            &line("甲乙丙丁戊己庚子", 100, 100),
            &[tied, catalog[1].clone()],
        )
        .is_none());
        assert_eq!(
            match_title(&line("甲乙丙丁戊己庚辛", 100, 100), &catalog)
                .map(|(augment, distance)| (augment.id.as_str(), distance)),
            Some(("1170", 0)),
        );
    }

    #[test]
    fn standalone_name_matching_rejects_descriptions_and_weak_or_short_typos() {
        for text in [
            "获得万用瞄准镜效果",
            "泰坦的坚决：受击后叠加护甲",
            "获得属性叠属性叠属性",
            "胜力",
            "海克土",
        ] {
            assert!(
                match_title(&line(text, 100, 100), augments()).is_none(),
                "{text}"
            );
        }
        let mut weak = line("万用喵准镜", 100, 100);
        weak.score = 0.74;
        assert!(match_title(&weak, augments()).is_none());
        weak.text = "万用瞄准镜".into();
        assert!(match_title(&weak, augments()).is_some());
        weak.score = f32::NAN;
        assert!(match_title(&weak, augments()).is_none());
        assert_eq!(fuzzy_augment_distance("mindtomater", "mindtomatter"), None);
    }

    #[test]
    fn candidate_panel_requires_spatial_evidence_and_an_exact_anchor() {
        let all_typos = [
            line("万用喵准镜", 200, 93),
            line("亮出你剑", 202, 594),
            line("巨像的勇汽", 202, 1094),
        ];
        assert!(match_augments(&all_typos).is_empty());
        let vertical = [
            line("万用瞄准镜", 100, 100),
            line("亮出你的剑", 150, 100),
            line("巨像的勇气", 200, 100),
        ];
        assert!(match_augments(&vertical).is_empty());
        let scattered = [
            line("万用瞄准镜", 100, 100),
            line("亮出你的剑", 180, 600),
            line("巨像的勇气", 260, 1100),
        ];
        assert!(match_augments(&scattered).is_empty());
        let adjacent = [
            line("万用瞄准镜", 100, 100),
            line("亮出你的剑", 100, 220),
            line("巨像的勇气", 100, 340),
        ];
        assert!(match_augments(&adjacent).is_empty());
        let mut title_and_small_text = [
            line("万用瞄准镜", 100, 100),
            line("亮出你的剑", 100, 600),
            line("巨像的勇气", 100, 1100),
        ];
        title_and_small_text[2].height = 12;
        assert!(match_augments(&title_and_small_text).is_empty());
    }

    #[test]
    fn partial_panel_requires_exact_names_and_nearby_panel_marker() {
        let mut lines = vec![line("万用瞄准镜", 200, 93), line("巨像的勇气", 202, 1094)];
        assert!(match_augments(&lines).is_empty());
        lines.push(line("银色海克斯", 273, 96));
        assert_eq!(match_augments(&lines).len(), 2);
        lines[0].text = "万用喵准镜".into();
        assert!(match_augments(&lines).is_empty());
        lines[0].text = "万用瞄准镜".into();
        lines[2].y = 500;
        assert!(match_augments(&lines).is_empty());
    }

    #[test]
    fn ambiguous_rows_and_duplicate_names_do_not_create_a_panel() {
        let mut lines = vec![
            line("万用瞄准镜", 200, 93),
            line("亮出你的剑", 202, 594),
            line("巨像的勇气", 202, 1094),
            line("珠光护手", 200, 1594),
        ];
        assert!(match_augments(&lines).is_empty());
        lines.pop();
        lines[2].text = "万用瞄准镜".into();
        assert!(match_augments(&lines).is_empty());
    }

    fn line(text: &str, y: u32, x: u32) -> TextLine {
        TextLine {
            text: text.to_string(),
            score: 0.99,
            x,
            y,
            width: 100,
            height: 30,
        }
    }

    #[test]
    fn canonical_augment_maps_ids_names_and_lines() {
        assert_eq!(canonical_augment("1001").as_deref(), Some("1001"));
        assert_eq!(canonical_augment("泰坦的坚决").as_deref(), Some("1001"));
        assert_eq!(
            canonical_augment("泰坦的坚决：受击后叠加护甲").as_deref(),
            Some("1001")
        );
        // 候选槽位 ID、空串与无关文本一律认不出，避免制造假重叠
        assert_eq!(canonical_augment("1"), None);
        assert_eq!(canonical_augment("  "), None);
        assert_eq!(canonical_augment("随便写的一行无关文本"), None);
    }

    #[test]
    fn canonical_names_include_english_and_reject_ambiguous_lines() {
        assert_eq!(canonical_augment("Mind to Matter").as_deref(), Some("1056"));
        assert_eq!(
            canonical_augment_exact("Mind to Matter").as_deref(),
            Some("1056")
        );
        assert_eq!(augment_label("Mind to Matter").as_deref(), Some("由心及物"));
        // 一条混合行同时包含两个等长名称，不能随意把首个命中当成唯一已选海克斯。
        assert_eq!(canonical_augment("已选：泰坦的坚决、巨像的勇气"), None);
        assert_eq!(canonical_augment_exact("泰坦的坚决、巨像的勇气"), None);
        assert!(match_augments(&[line("泰坦的坚决、巨像的勇气", 10, 10)]).is_empty());
        assert_eq!(
            canonical_augment("属性叠属性叠属性！").as_deref(),
            Some("1402")
        );
        assert_eq!(canonical_augment("属性叠属性！").as_deref(), Some("1403"));
        assert_eq!(canonical_augment("1403").as_deref(), Some("1403"));

        let ids = vec!["1402".into(), "1403".into()];
        let named = prior(&ids, Some("Ahri"), &["属性叠属性！".into()]);
        assert_eq!(named["1402"]["alreadyOwned"], false);
        assert_eq!(named["1403"]["alreadyOwned"], true);
        let ambiguous = prior(
            &["1001".into(), "1018".into()],
            Some("Ahri"),
            &["泰坦的坚决、巨像的勇气".into()],
        );
        assert_eq!(ambiguous["1001"]["alreadyOwned"], false);
        assert_eq!(ambiguous["1018"]["alreadyOwned"], false);
        let precise = prior(&ids, Some("Ahri"), &["1403".into()]);
        assert_eq!(precise["1402"]["alreadyOwned"], false);
        assert_eq!(precise["1403"]["alreadyOwned"], true);
        assert_eq!(precise["1403"]["localScore"], 0);
    }

    #[test]
    fn missing_champion_is_neutral_and_profile_warnings_reach_the_prior() {
        let ids = vec!["1022".into()];
        let missing = rank(&ids, None, &[]).unwrap();
        let unknown = rank(&ids, Some("unknown champion"), &[]).unwrap();
        let blank = rank(&ids, Some("， "), &[]).unwrap();
        assert_eq!(missing["ranking"], unknown["ranking"]);
        assert_eq!(missing["ranking"], blank["ranking"]);
        assert!(unknown["profile"]["ranged"].is_null());
        assert_eq!(unknown["profile"]["role"], "");
        assert_eq!(unknown["ranking"][0]["score"], 53);
        let unknown_prior = prior(&ids, Some("unknown champion"), &[]);
        assert!(unknown_prior["1022"]["profileWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap().contains("未匹配英雄资料")));
        assert_eq!(unknown_prior["1022"]["verified"], false);
    }

    #[test]
    fn explicit_costs_do_not_claim_positive_stat_or_ultimate_affinity() {
        let disabled = rank(&["1004".into()], Some("Ahri"), &[]).unwrap();
        assert!(!disabled["ranking"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("ultimate"));
        assert!(disabled["ranking"][0]["risks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap().contains("明确禁用终极技能")));
        let glass_cannon = prior(&["1325".into()], Some("Garen"), &[]);
        assert_eq!(glass_cannon["1325"]["tags"], json!([]));
        let erosion = prior(&["1028".into()], Some("Garen"), &[]);
        assert_eq!(erosion["1028"]["category"], "damage");
        assert_eq!(erosion["1028"]["tags"], json!(["ad", "ap", "stack"]));
    }

    #[test]
    fn fixed_damage_tags_do_not_imply_attribute_mismatch_penalties() {
        // 点亮他们：原文自带魔法伤害攻击特效，不能仅因英雄画像偏物理就扣分。
        let ranked = rank(&["1051".into()], Some("MasterYi"), &[]).unwrap();
        assert_eq!(ranked["ranking"][0]["score"], 57);
        assert!(ranked["ranking"][0]["risks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|risk| !risk.as_str().unwrap().contains("属性不一致")));
        let placeholder = prior(&["2138".into()], Some("Ahri"), &[]);
        assert_eq!(placeholder["2138"]["priorReliability"], 0.25);
        let mut missing = augment_by_id("2138").unwrap().clone();
        missing.effect.clear();
        assert_eq!(prior_reliability(&missing), 0.0);
        assert!(data_warnings(&missing)
            .iter()
            .any(|warning| warning.contains("缺少完整效果")));
    }

    #[test]
    fn matches_real_augment_names_in_reading_order() {
        let lines = vec![
            line("万用瞄准镜", 200, 93),
            line("亮出你的剑", 202, 594),
            line("巨像的勇气", 202, 1094),
            line("银色海克斯", 273, 96),
        ];
        let matched = match_augments(&lines);
        let names: Vec<&str> = matched
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect();
        assert_eq!(names, vec!["万用瞄准镜", "亮出你的剑", "巨像的勇气"]);
        let expected = augments().iter().find(|a| a.name == "万用瞄准镜").unwrap();
        assert_eq!(matched[0].id, expected.id);
        assert_eq!(matched[0].description, expected.effect);
    }

    #[test]
    fn ignores_unrelated_screen_text() {
        let matched = match_augments(&[
            line("胜利", 100, 100),
            line("银色海克斯", 273, 96),
            line("开始游戏", 500, 500),
        ]);
        assert!(matched.is_empty(), "{matched:?}");
    }

    #[test]
    fn longer_name_shadows_its_substring_on_the_same_line() {
        let matched = match_augments(&[
            line("珠光护手", 200, 93),
            line("科学狂人", 200, 594),
            line("无限循环往复", 200, 1094),
        ]);
        let names: Vec<&str> = matched.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["珠光护手", "科学狂人", "无限循环往复"]);
        assert!(
            !names.contains(&"循环往复"),
            "子串名字不该凭空成为候选：{names:?}"
        );
    }

    #[test]
    fn normalization_survives_ocr_punctuation_loss() {
        assert_eq!(normalize("万用 瞄准镜，"), normalize("万用瞄准镜"));
        assert!(matches_needle(
            "获得75攻击距离如果你是远程",
            "获得75攻击距离"
        ));
        assert!(!matches_needle("银色海克斯", "海克斯"));
    }

    #[test]
    fn scoring_is_deterministic_and_ordered() {
        let ids: Vec<String> = vec!["1170".into(), "1018".into(), "2009".into()];
        let first = rank(&ids, Some("Jinx"), &[]).unwrap();
        let second = rank(&ids, Some("Jinx"), &[]).unwrap();
        assert_eq!(first["ranking"], second["ranking"]);
        let ranking = first["ranking"].as_array().unwrap();
        assert_eq!(ranking.len(), 3);
        let scores: Vec<u8> = ranking
            .iter()
            .map(|item| item["score"].as_u64().unwrap() as u8)
            .collect();
        let mut descending = scores.clone();
        descending.sort_by(|a, b| b.cmp(a));
        assert_eq!(scores, descending);
        assert!(ranking
            .iter()
            .all(|item| item["score"].as_u64().unwrap() <= 100));
        assert!(ranking
            .iter()
            .all(|item| item["reason"].as_str().is_some_and(|r| !r.is_empty())));
    }

    #[test]
    fn never_exposes_win_rate_fields() {
        let ranked = rank(&["1170".into()], Some("Garen"), &[]).unwrap();
        let text = ranked.to_string();
        for forbidden in ["winRate", "pickRate", "tier", "hexScore", "胜率"] {
            assert!(!text.contains(forbidden), "found {forbidden} in {text}");
        }
    }

    #[test]
    fn already_owned_augment_scores_zero() {
        let ranked = rank(&["1170".into()], Some("Jinx"), &["万用瞄准镜".into()]).unwrap();
        assert_eq!(ranked["ranking"][0]["score"], 0);
        let risks = ranked["ranking"][0]["risks"].as_array().unwrap();
        assert!(risks
            .iter()
            .any(|risk| risk.as_str().unwrap().contains("已经选取过")));
    }

    #[test]
    fn range_tag_does_not_imply_ranged_benefit_or_melee_penalty() {
        // 瞄准镜原文给近战的射程增量更大，不能标注“远程收益更高”或统一扣近战分。
        for (id, melee_score, ranged_score) in [("1170", 53, 55), ("1071", 55, 57)] {
            let melee = rank(&[id.into()], Some("Garen"), &[]).unwrap();
            let ranged = rank(&[id.into()], Some("Jinx"), &[]).unwrap();
            assert_eq!(melee["ranking"][0]["score"], melee_score);
            assert_eq!(ranged["ranking"][0]["score"], ranged_score);
            for ranked in [melee, ranged] {
                assert!(!ranked["ranking"][0]["reason"]
                    .as_str()
                    .unwrap()
                    .contains("远程收益更高"));
                assert!(!ranked["ranking"][0]["risks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|risk| risk.as_str().unwrap().contains("近战使用远程向")));
            }
        }
        // 同一 range 标签还用于“亮出你的剑”等转近战、指定技能触发效果。
        for id in ["1134", "2096", "2133"] {
            let ranked = rank(&[id.into()], Some("Jinx"), &[]).unwrap();
            assert!(ranked["ranking"][0]["risks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|risk| risk
                    .as_str()
                    .unwrap()
                    .contains("攻击距离标签不代表远程专用")));
        }
    }

    fn scored_item(result: &Value, id: &str) -> Value {
        result["ranking"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
            .clone()
    }

    #[test]
    fn effect_limits_and_ap_shield_inputs_are_not_offensive_stat_bonuses() {
        let weapon = augment_by_id("1029").unwrap();
        assert_eq!(weapon.tags, vec!["onhit"]);
        assert_eq!(augment_by_id("1180").unwrap().category, "defense");
        let result = rank(&["1029".into(), "1180".into()], Some("Ekko"), &[]).unwrap();
        let weapon = scored_item(&result, "1029");
        let brain = scored_item(&result, "1180");
        assert!(!weapon["reason"].as_str().unwrap().contains("haste"));
        assert!(!brain["reason"].as_str().unwrap().contains("分类damage"));
        assert!(!brain["reason"].as_str().unwrap().contains("契合ap"));
        assert!(brain["risks"].as_array().unwrap().iter().any(|risk| risk
            .as_str()
            .unwrap()
            .contains("不根据法师/刺客标签虚构护盾量")));
    }

    #[test]
    fn ekko_skills_have_official_evidence_without_claiming_special_on_hit_interactions() {
        let data: Value = serde_json::from_str(CHAMPIONS_JSON).unwrap();
        let ekko = data["champions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|champion| champion["id"] == "Ekko")
            .unwrap();
        assert_eq!(ekko["passive"]["name"], "Z型驱动共振");
        assert_eq!(ekko["spells"].as_array().unwrap().len(), 4);
        assert!(ekko["abilitySource"]
            .as_str()
            .unwrap()
            .starts_with("https://ddragon.leagueoflegends.com/"));
        let result = rank(&["1029".into()], Some("艾克"), &[]).unwrap();
        assert_eq!(
            result["profile"]["contextCoverage"]["championMechanismsKnown"],
            true
        );
        let weapon = scored_item(&result, "1029");
        assert!(weapon["mechanismContributions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["key"] == "spell-delivery"));
        assert!(!weapon["mechanismContributions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["key"] == "owned-on-hit" || entry["key"] == "item-on-hit"));
        assert!(weapon["risks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|risk| risk.as_str().unwrap().contains("未核实虚幻武器与三环被动")));
    }

    #[test]
    fn swapping_real_equipment_changes_mechanism_ranking_instead_of_fixing_a_champion_combo() {
        let ids = ["1029".into(), "1180".into()];
        let on_hit =
            rank_with_context(&ids, Some("Ekko"), &[], &[json!({"itemID":3115,"count":1})])
                .unwrap();
        assert_eq!(on_hit["ranking"][0]["id"], "1029");
        assert!(scored_item(&on_hit, "1029")["reason"]
            .as_str()
            .unwrap()
            .contains("纳什之牙"));
        let ap = rank_with_context(&ids, Some("Ekko"), &[], &[json!({"itemID":3089,"count":1})])
            .unwrap();
        assert_eq!(ap["ranking"][0]["id"], "1180");
        assert_eq!(
            ap["profile"]["contextCoverage"]["equipmentBaseAbilityPower"],
            130.0
        );
        assert!(scored_item(&ap, "1180")["reason"]
            .as_str()
            .unwrap()
            .contains("基础 AP 合计约 130"));
        // 未知英雄没有艾克技能加分，但真实的装备攻击特效仍可提供通用依据。
        let unknown =
            rank_with_context(&ids, Some("unknown"), &[], &[json!({"itemID":3115})]).unwrap();
        assert_eq!(
            unknown["profile"]["contextCoverage"]["championMechanismsKnown"],
            false
        );
        assert!(scored_item(&unknown, "1029")["mechanismContributions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["key"] != "spell-delivery"));
        assert!(scored_item(&unknown, "1029")["reason"]
            .as_str()
            .unwrap()
            .contains("纳什之牙"));
    }

    #[test]
    fn owned_effect_synergy_requires_an_explicit_compatible_mechanism_and_deduplicates_aliases() {
        let id = ["1029".into()];
        let plain = rank(&id, Some("Ekko"), &[]).unwrap();
        let synergy = rank(&id, Some("Ekko"), &["1036".into()]).unwrap();
        let repeated = rank(&id, Some("Ekko"), &["1036".into(), "火上浇油".into()]).unwrap();
        assert_eq!(synergy["ranking"], repeated["ranking"]);
        assert!(synergy["ranking"][0]["score"].as_u64() > plain["ranking"][0]["score"].as_u64());
        assert!(synergy["ranking"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("已选火上浇油"));
        // 点亮他们依赖“每第4次攻击”，不能只因 onhit 标签就断言技能增加攻击计数。
        assert_eq!(
            rank(&id, Some("Ekko"), &["1051".into()]).unwrap()["ranking"],
            plain["ranking"]
        );
        let mana_missing = rank(&id, Some("Kennen"), &["2016".into()]).unwrap();
        assert_eq!(
            mana_missing["ranking"],
            rank(&id, Some("Kennen"), &[]).unwrap()["ranking"]
        );
        let reverse = rank(&["1036".into()], Some("Ekko"), &["1029".into()]).unwrap();
        assert!(reverse["ranking"][0]["mechanismContributions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["key"] == "owned-spell-delivery"));
    }

    #[test]
    fn conditional_item_triggers_unknown_items_and_empty_slots_do_not_invent_synergy() {
        let id = ["1029".into()];
        let unconditional =
            rank_with_context(&id, Some("Ekko"), &[], &[json!({"itemID":3115})]).unwrap();
        let conditional =
            rank_with_context(&id, Some("Ekko"), &[], &[json!({"itemID":3100})]).unwrap();
        assert!(
            conditional["ranking"][0]["score"].as_u64()
                < unconditional["ranking"][0]["score"].as_u64()
        );
        assert!(conditional["ranking"][0]["risks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|risk| risk
                .as_str()
                .unwrap()
                .contains("不能视作每次技能命中都触发")));
        let unknown = rank_with_context(&id, Some("Ekko"), &[], &[json!({"itemID":999999,"displayName":"纳什之牙","stats":{"FlatMagicDamageMod":9999}})]).unwrap();
        let plain = rank(&id, Some("Ekko"), &[]).unwrap();
        assert_eq!(unknown["ranking"][0]["score"], plain["ranking"][0]["score"]);
        assert_eq!(
            unknown["profile"]["contextCoverage"]["unknownItemIds"],
            json!(["999999"])
        );
        let empty = rank_with_context(
            &id,
            Some("Ekko"),
            &[],
            &[json!({"itemID":3115,"count":0}), json!({"itemID":0})],
        )
        .unwrap();
        assert_eq!(empty["ranking"], plain["ranking"]);
    }

    #[test]
    fn mechanism_contributions_are_bounded_and_the_model_prior_uses_the_same_equipment() {
        let ids = ["1029".into(), "1180".into()];
        let items = [
            json!({"itemID":3115}),
            json!({"itemID":3153}),
            json!({"itemID":3100}),
        ];
        let owned = ["1036".into(), "1058".into(), "2016".into()];
        let ranked = rank_with_context(&ids, Some("Ekko"), &owned, &items).unwrap();
        let prior = prior_with_context(&ids, Some("Ekko"), &owned, &items);
        for id in ["1029", "1180"] {
            let item = scored_item(&ranked, id);
            assert_eq!(prior[id]["localScore"], item["score"]);
            assert_eq!(
                prior[id]["mechanismContributions"],
                item["mechanismContributions"]
            );
            let points: i64 = item["mechanismContributions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["points"].as_i64().unwrap())
                .sum();
            assert!(points <= 40);
            assert!(item["mechanismContributions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| !entry["sources"].as_array().unwrap().is_empty()));
        }
        let already_owned =
            rank_with_context(&["1029".into()], Some("Ekko"), &["1029".into()], &items).unwrap();
        assert_eq!(already_owned["ranking"][0]["score"], 0);
        assert!(already_owned["ranking"][0]["mechanismContributions"].is_null());
    }

    #[test]
    fn reviewed_rules_require_current_patch_and_the_entire_original_effect() {
        let weapon = augment_by_id("1029").unwrap();
        assert!(reviewed_rules_in(weapon, mechanics(), data_patch()).is_some());
        assert!(reviewed_rules_in(weapon, mechanics(), "16.20.1").is_none());
        let mut changed = weapon.clone();
        changed.effect.push_str(" 新增限制。");
        assert!(reviewed_mechanics(&changed).is_none());
        let (contributions, _) = mechanism_points(
            &changed,
            &profile(Some("Ekko")),
            &equipment(&[json!({"itemID":3115})]),
            &["1036".into()],
        );
        assert!(contributions.is_empty());
        assert!(data_warnings(&changed)
            .iter()
            .any(|warning| warning.contains("旧机制已停用并回退")));
    }

    #[test]
    fn owned_and_candidate_mechanisms_share_the_same_evidence_gate() {
        let mut altered_catalog = mechanics().clone();
        for id in ["1029", "1036", "1058", "1180", "2016"] {
            let augment = augment_by_id(id).unwrap();
            assert!(reviewed_rules_in(augment, &altered_catalog, data_patch()).is_some());
            altered_catalog["augments"][id]["evidence"] = json!("同 ID 但不匹配的效果");
            assert!(reviewed_rules_in(augment, &altered_catalog, data_patch()).is_none());
        }
        altered_catalog["patch"] = json!("unreviewed");
        for id in ["1029", "1036", "1180"] {
            assert!(
                reviewed_rules_in(augment_by_id(id).unwrap(), &altered_catalog, data_patch())
                    .is_none()
            );
        }
    }

    #[test]
    fn empty_input_is_not_an_error() {
        let ranked = rank(&[], None, &[]).unwrap();
        assert!(ranking_is_empty(&ranked));
    }

    fn ranking_is_empty(value: &Value) -> bool {
        value["ranking"]
            .as_array()
            .is_some_and(|items| items.is_empty())
    }
}
