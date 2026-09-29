//! 本地规则打分：把 OCR 识别出的文本匹配到海克斯，再按当前英雄做契合度排序。
//! 只使用打包的静态数据，不调用模型，不展示任何胜率 / 选取率 / 强度分级。
use crate::ocr::TextLine;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

const AUGMENTS_JSON: &str = include_str!("../data/augments.json");
const CHAMPIONS_JSON: &str = include_str!("../data/champions.json");

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
}

#[derive(Debug, Clone)]
struct Champion {
    id: String,
    tags: Vec<String>,
    ranged: bool,
    damage: &'static str,
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
                            aliases: string_list(&item["aliases"]),
                            effect: item["effect"].as_str().unwrap_or("").to_string(),
                            rarity: item["rarity"].as_str().unwrap_or("").to_string(),
                            category: item["category"].as_str().unwrap_or("").to_string(),
                            tags: string_list(&item["tags"]),
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
        let items = value.as_array().cloned().unwrap_or_else(|| {
            value["champions"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        });
        items
            .iter()
            .filter_map(|item| {
                let id = item["id"].as_str()?.to_string();
                let ranged = item["stats"]["attackrange"].as_f64().unwrap_or(0.0) >= 500.0;
                let attack = item["info"]["attack"].as_f64().unwrap_or(0.0);
                let magic = item["info"]["magic"].as_f64().unwrap_or(0.0);
                let damage = if attack >= magic + 2.0 {
                    "physical"
                } else if magic >= attack + 2.0 {
                    "magic"
                } else {
                    "mixed"
                };
                Some(Champion {
                    id,
                    tags: string_list(&item["tags"]),
                    ranged,
                    damage,
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

/// OCR 文本行 -> 屏幕上出现的海克斯，按出现顺序（上到下、左到右）返回。
pub fn match_augments(lines: &[TextLine]) -> Vec<MatchedCandidate> {
    let mut hits: Vec<(u32, u32, &Augment)> = Vec::new();
    for augment in augments() {
        let mut best: Option<(u32, u32)> = None;
        let names = std::iter::once(augment.name.as_str())
            .chain(augment.aliases.iter().map(String::as_str));
        for line in lines {
            if names.clone().any(|name| matches_needle(&line.text, name)) {
                let position = (line.y, line.x);
                best = match best {
                    Some(current) if current <= position => Some(current),
                    _ => Some(position),
                };
            }
        }
        if let Some(position) = best {
            hits.push((position.0, position.1, augment));
        }
    }
    hits.sort_by_key(|(y, x, _)| (*y, *x));
    hits
        .into_iter()
        .take(6)
        .map(|(_, _, augment)| MatchedCandidate {
            id: augment.id.clone(),
            name: augment.name.clone(),
            description: augment.effect.clone(),
            rarity: augment.rarity.clone(),
            category: augment.category.clone(),
            score: 0,
            reason: String::new(),
            risks: Vec::new(),
        })
        .collect()
}

#[derive(Debug, Clone, Default)]
struct Profile {
    role: Option<&'static str>,
    ranged: Option<bool>,
    damage: &'static str,
}

fn profile(champion: Option<&str>) -> Profile {
    let Some(key) = champion else {
        return Profile::default();
    };
    let Some(found) = champions().iter().find(|c| c.id.eq_ignore_ascii_case(key)) else {
        return Profile::default();
    };
    let role = ["Marksman", "Tank", "Mage", "Assassin", "Fighter", "Support"]
        .into_iter()
        .find(|role| found.tags.iter().any(|tag| tag == role));
    Profile {
        role,
        ranged: Some(found.ranged),
        damage: found.damage,
    }
}

fn role_tag_score(role: Option<&str>, tags: &[String]) -> i32 {
    let affinity: &[(&str, &[&str], i32)] = &[
        ("Marksman", &["crit", "as", "onhit", "ad", "range"], 12),
        ("Mage", &["ap", "ultimate", "mana", "haste", "cc"], 11),
        ("Tank", &["tank", "hp", "sustain", "cc"], 13),
        ("Assassin", &["ad", "mobility", "ultimate", "haste"], 11),
        ("Fighter", &["ad", "sustain", "as", "hp"], 10),
        ("Support", &["cc", "summoner", "haste", "utility"], 11),
    ];
    let Some(role) = role else {
        return 0;
    };
    let Some((_, wanted, weight)) = affinity.iter().find(|(name, _, _)| *name == role) else {
        return 0;
    };
    tags.iter()
        .filter(|tag| wanted.contains(&tag.as_str()))
        .map(|_| *weight)
        .sum()
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

/// 当前上下文下的本地契合度打分：0-100 相对契合度，与胜率无关。
pub fn rank(
    ids: &[String],
    champion: Option<&str>,
    owned: &[String],
) -> Result<Value, String> {
    if ids.is_empty() {
        return Ok(json!({"ranking": [], "summary": "未识别到候选海克斯"}));
    }
    let profile = profile(champion);
    let owned: Vec<String> = owned.iter().map(|name| normalize(name)).collect();
    let mut ranking = Vec::new();
    for id in ids {
        let Some(augment) = augment_by_id(id) else {
            continue;
        };
        let mut score: i32 = 50;
        let mut reasons = Vec::new();
        let mut risks: Vec<String> = Vec::new();
        let role = profile.role;
        let tag_score = role_tag_score(role, &augment.tags);
        if tag_score > 0 {
            score += tag_score.min(26);
            reasons.push(format!(
                "{}契合{}",
                role.unwrap_or("英雄"),
                augment.tags.join("、")
            ));
        }
        let category_points = category_score(role, &augment.category);
        score += category_points;
        if category_points >= 8 {
            reasons.push(format!("分类{}补强", augment.category));
        }
        if let Some(ranged) = profile.ranged {
            if augment.tags.iter().any(|tag| tag == "range") {
                if ranged {
                    score += 8;
                    reasons.push("远程收益更高".into());
                } else {
                    score -= 12;
                    risks.push("近战使用远程向海克斯收益下降".into());
                }
            } else if !ranged && augment.tags.iter().any(|tag| tag == "crit" || tag == "as") {
                score -= 4;
            }
        }
        match profile.damage {
            "physical" if augment.tags.iter().any(|tag| tag == "ap") => {
                score -= 4;
                risks.push("与当前物理向英雄的主要属性不一致".into());
            }
            "magic" if augment.tags.iter().any(|tag| tag == "ad") => {
                score -= 4;
                risks.push("与当前法术向英雄的主要属性不一致".into());
            }
            _ => {}
        }
        score += rarity_score(&augment.rarity);
        if owned.iter().any(|name| {
            *name == normalize(&augment.name) || augment.aliases.iter().any(|a| normalize(a) == *name)
        }) {
            score = 0;
            risks.push("该海克斯已经选取过".into());
        }
        if augment.effect.trim().is_empty() {
            risks.push("本地数据缺少完整效果".into());
        }
        if reasons.is_empty() {
            reasons.push("缺少英雄标签，按基础强度给出中性分".into());
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
        });
    }
    ranking.sort_by(|left, right| right.score.cmp(&left.score).then(left.id.cmp(&right.id)));
    Ok(json!({
        "ranking": ranking,
        "summary": format!(
            "本地规则排序 {} 个候选（{}）",
            ranking.len(),
            match champion {
                Some(key) => key,
                None => "未识别当前英雄",
            }
        ),
        "profile": {
            "champion": champion.unwrap_or(""),
            "role": profile.role.unwrap_or(""),
            "ranged": profile.ranged,
            "damage": profile.damage,
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
) -> Result<Value, String> {
    let mut ranked = rank(&ids, champion.as_deref(), &owned)?;
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
    fn matches_real_augment_names_in_reading_order() {
        let lines = vec![
            line("万用瞄准镜", 200, 93),
            line("亮出你的剑", 202, 594),
            line("巨像的勇气", 202, 1094),
            line("银色海克斯", 273, 96),
        ];
        let matched = match_augments(&lines);
        let names: Vec<&str> = matched.iter().map(|candidate| candidate.name.as_str()).collect();
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
    fn normalization_survives_ocr_punctuation_loss() {
        assert_eq!(normalize("万用 瞄准镜，"), normalize("万用瞄准镜"));
        assert!(matches_needle("获得75攻击距离如果你是远程", "获得75攻击距离"));
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
        assert!(ranking.iter().all(|item| item["score"].as_u64().unwrap() <= 100));
        assert!(ranking.iter().all(|item| item["reason"].as_str().is_some_and(|r| !r.is_empty())));
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
        assert!(risks.iter().any(|risk| risk.as_str().unwrap().contains("已经选取过")));
    }

    #[test]
    fn melee_penalises_range_tag() {
        let ranged = rank(&["1170".into()], Some("Jinx"), &[]).unwrap();
        let melee = rank(&["1170".into()], Some("Garen"), &[]).unwrap();
        assert!(
            ranged["ranking"][0]["score"].as_u64().unwrap()
                > melee["ranking"][0]["score"].as_u64().unwrap()
        );
    }

    #[test]
    fn empty_input_is_not_an_error() {
        let ranked = rank(&[], None, &[]).unwrap();
        assert!(ranking_is_empty(&ranked));
    }

    fn ranking_is_empty(value: &Value) -> bool {
        value["ranking"].as_array().is_some_and(|items| items.is_empty())
    }
}
