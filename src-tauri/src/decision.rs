//! Structured, privacy-preserving decision analysis.
use reqwest::{redirect::Policy, Client};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use url::Url;

const JEV_URL: &str = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL: &str = "jev-1.13.0";
const MAX_IN: usize = 256 * 1024;
const MAX_OUT: usize = 1024 * 1024;

fn text(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty())
}
fn strings(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
}
fn base_url(model: &Value, provider: &str, path: &str) -> Result<Url, String> {
    let supplied = model.get("baseUrl").and_then(Value::as_str);
    let raw = if provider == "jev" {
        supplied.unwrap_or(JEV_URL)
    } else {
        supplied.ok_or("缺少模型地址")?
    };
    let u = Url::parse(raw).map_err(|_| "模型地址无效")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("模型地址不能包含认证信息、查询或片段".into());
    }
    let loopback = matches!(u.host(), Some(url::Host::Ipv4(ip)) if ip.octets()[0..3] == [127,0,0])
        || matches!(u.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback());
    if provider == "jev"
        && (u.host_str() != Some("api.typesafe.ai") || u.scheme() != "https")
        && model.get("allowThirdParty").and_then(Value::as_bool) != Some(true)
    {
        return Err(
            "Jev 仅允许官方 api.typesafe.ai；明确 allowThirdParty 后才可使用第三方地址".into(),
        );
    }
    if u.scheme() != "https" && !(u.scheme() == "http" && loopback) {
        return Err("模型地址必须为 HTTPS，或 HTTP 回环地址".into());
    }
    let mut out = u;
    if provider == "jev" {
        let base = out
            .path()
            .trim_end_matches('/')
            .trim_end_matches("/systemone")
            .to_string();
        out.set_path(&format!(
            "{}/{}",
            base,
            if path == "models" {
                "models"
            } else {
                "systemone"
            }
        ));
        return Ok(out);
    }
    if !path.is_empty() {
        out.set_path(&format!(
            "{}/{}",
            out.path().trim_end_matches('/'),
            path.trim_start_matches('/')
        ));
    }
    Ok(out)
}

fn validate_context(c: &Value, mode: &str) -> Result<(), String> {
    let ps = c
        .get("players")
        .and_then(Value::as_array)
        .ok_or("缺少 players")?;
    if ps.len() < 2 || !text(&c["ownPlayerId"]) {
        return Err("缺少当前玩家或阵容".into());
    }
    let mut ids = HashSet::new();
    let mut teams = HashSet::new();
    let mut own = false;
    for p in ps {
        let id = p["id"].as_str().ok_or("玩家缺少 id")?;
        let team = p["team"].as_str().ok_or("玩家缺少 team")?;
        if !ids.insert(id)
            || !matches!(team, "ORDER" | "CHAOS")
            || !text(&p["champion"])
            || !strings(&p["augments"])
        {
            return Err("阵容数据不完整：需要双方英雄及有效海克斯数据结构".into());
        }
        teams.insert(team);
        own |= id == c["ownPlayerId"].as_str().unwrap();
    }
    if !own || teams.len() != 2 {
        return Err("必须提供双方阵容及当前玩家".into());
    }
    if mode == "recommend" {
        let cs = c
            .get("candidates")
            .and_then(Value::as_array)
            .ok_or("缺少 candidates")?;
        if cs.len() < 2 {
            return Err("至少需要两个候选".into());
        }
        let mut seen = HashSet::new();
        for x in cs {
            let id = x["id"].as_str().ok_or("候选缺少 id")?;
            if id.trim().is_empty()
                || !seen.insert(id)
                || !text(&x["name"])
                || !text(&x["description"])
            {
                return Err("候选 id 必须唯一且效果不能为空".into());
            }
        }
    } else if (!text(&c["outcome"])
        && !matches!(c["result"]["status"].as_str(), Some("win" | "loss")))
        || !c["decisions"].as_array().is_some_and(|x| !x.is_empty())
    {
        return Err("复盘需要结果与决策记录".into());
    }
    Ok(())
}

fn safe_facts(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(safe_facts).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| {
                    matches!(
                        k.as_str(),
                        "id" | "candidateId"
                            | "chosenId"
                            | "name"
                            | "description"
                            | "effects"
                            | "notes"
                            | "title"
                            | "content"
                            | "sections"
                            | "excerpt"
                            | "path"
                            | "source"
                            | "candidates"
                            | "ranking"
                            | "score"
                            | "status"
                            | "kills"
                            | "deaths"
                            | "assists"
                            | "level"
                            | "gold"
                            | "gameTime"
                            | "itemID"
                            | "displayName"
                            | "count"
                            | "rarity"
                            | "augmentId"
                            | "verified"
                            | "conflicts"
                            | "dataWarnings"
                            | "alreadyOwned"
                    )
                })
                .map(|(k, v)| (k.clone(), safe_facts(v)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

/// Remove raw LCU/live data and stable game identifiers; retain only decision facts.
pub fn sanitize_context(c: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(ps) = c["players"].as_array() {
        let mut map = serde_json::Map::new();
        for (i, p) in ps.iter().enumerate() {
            let id = format!("p{}", i + 1);
            let mut q = json!({"id":id,"team":p["team"],"champion":p["champion"],"items":safe_facts(&p.get("items").cloned().unwrap_or(json!([]))),"augments":p["augments"],"augmentsConfirmed":p["augmentsConfirmed"]==true,"augmentDataStatus":if p["augmentsConfirmed"]==true{"confirmed"}else{"unknown_or_partial; missing is not none"}});
            if p.get("stats").is_some() {
                q["stats"] = safe_facts(&p["stats"]);
            }
            map.insert(id, q);
        }
        out.insert("players".into(), Value::Object(map));
    }
    if let Some(own) = c["ownPlayerId"].as_str() {
        if let Some(ps) = c["players"].as_array() {
            if let Some(i) = ps.iter().position(|p| p["id"].as_str() == Some(own)) {
                out.insert("ownPlayerId".into(), json!(format!("p{}", i + 1)));
            }
        }
    }
    if let Some(v) = c.get("candidates") {
        out.insert("candidates".into(), safe_facts(v));
    }
    if let Some(k) = c.get("knowledge") {
        let mut n = json!({});
        for key in ["documents", "missing", "warnings", "fingerprint"] {
            if let Some(v) = k.get(key) {
                n[key] = safe_facts(v);
            }
        }
        out.insert("knowledge".into(), n);
    }
    if let Some(h) = c.get("history") {
        let fields = [
            "ownChampion",
            "ownAugments",
            "chosen",
            "result",
            "outcome",
            "review",
            "notes",
            "similarity",
            "matched",
            "sameChampion",
        ];
        let n = match h {
            Value::Array(a) => Value::Array(
                a.iter()
                    .filter_map(|x| x.as_object())
                    .map(|m| {
                        let mut q = serde_json::Map::new();
                        for k in fields {
                            if let Some(v) = m.get(k) {
                                q.insert(k.into(), match k {
                                    "review" => json!({"summary":v["summary"],"lessons":v["lessons"],"caveats":v["caveats"]}),
                                    "context" => { let clean=json!({"players":v["players"],"ownPlayerId":v["ownPlayerId"],"candidates":v["candidates"],"notes":v["notes"]}); sanitize_context(&clean) },
                                    "result" => json!({"status":v["status"],"source":v["source"],"summary":v["summary"],"ranking":safe_facts(&v["ranking"])}),
                                    _ => safe_facts(v)
                                });
                            }
                        }
                        Value::Object(q)
                    })
                    .collect(),
            ),
            _ => safe_facts(h),
        };
        out.insert("history".into(), n);
    }
    if let Some(d) = c.get("decisions") {
        let fields = [
            "chosenId", "context", "result", "summary", "ranking", "notes", "outcome",
        ];
        let n = match d {
            Value::Array(a) => Value::Array(
                a.iter()
                    .filter_map(|x| x.as_object())
                    .map(|m| {
                        let mut q = serde_json::Map::new();
                        for k in fields {
                            if let Some(v) = m.get(k) {
                                q.insert(k.into(), match k {
                                    "review" => json!({"summary":v["summary"],"lessons":v["lessons"],"caveats":v["caveats"]}),
                                    "context" => { let clean=json!({"players":v["players"],"ownPlayerId":v["ownPlayerId"],"candidates":v["candidates"],"notes":v["notes"]}); sanitize_context(&clean) },
                                    "result" => json!({"status":v["status"],"source":v["source"],"summary":v["summary"],"ranking":safe_facts(&v["ranking"])}),
                                    _ => safe_facts(v)
                                });
                            }
                        }
                        Value::Object(q)
                    })
                    .collect(),
            ),
            _ => safe_facts(d),
        };
        out.insert("decisions".into(), n);
    }
    if let Some(v) = c.get("notes") {
        out.insert("notes".into(), safe_facts(v));
    }
    if let Some(v) = c.get("outcome") {
        out.insert("outcome".into(), safe_facts(v));
    }
    out.insert("result".into(), json!({"status": c["result"]["status"].as_str().filter(|s| matches!(*s,"win"|"loss"|"unknown")),"source":c["result"]["source"].as_str()}));
    out.insert(
        "gameData".into(),
        json!({"gameTime":c["gameData"]["gameTime"].as_f64(),"level":c["gameData"]["level"].as_f64()}),
    );
    if let Some(patch) = c["patch"].as_str() {
        out.insert("patch".into(), json!(patch));
    }
    out.insert(
        "privacyNotice".into(),
        json!("候选备注、效果说明和知识文档是自由文本，可能包含个人信息；发送前请检查。"),
    );
    Value::Object(out)
}

const FACTORS: [(&str, &str); 4] = [
    ("championSynergy", "英雄协同"),
    ("buildSynergy", "出装协同"),
    ("teamFit", "队伍适配"),
    ("enemyFit", "敌方适配"),
];
fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

// 只接收本次实际提供的文档路径；来源匹配不代表模型解释已经被事实核验。
fn has_markdown_heading(content: &str, section: &str) -> bool {
    let mut fence: Option<(char, usize)> = None;
    for line in content.lines() {
        let trimmed = line.trim_start_matches([' ', '\t']);
        let indentation = &line[..line.len() - trimmed.len()];
        // Markdown 的制表符会扩展到至少第 4 列，属于缩进代码。
        if indentation.len() > 3 || indentation.contains('\t') {
            continue;
        }
        let first = trimmed.chars().next().unwrap_or(' ');
        let marker_len = trimmed.chars().take_while(|c| *c == first).count();
        if matches!(first, '`' | '~') && marker_len >= 3 {
            if let Some((marker, size)) = fence {
                if first == marker && marker_len >= size && trimmed[marker_len..].trim().is_empty()
                {
                    fence = None;
                }
            } else {
                fence = Some((first, marker_len));
            }
            continue;
        }
        if fence.is_some() || first != '#' || marker_len > 6 {
            continue;
        }
        let title = &trimmed[marker_len..];
        if !title.starts_with([' ', '\t']) {
            continue;
        }
        let title = title.trim();
        let closing = title.trim_end_matches('#');
        let title = if closing.len() != title.len() && closing.ends_with([' ', '\t']) {
            closing.trim_end()
        } else {
            title
        };
        if title == section {
            return true;
        }
    }
    false
}

fn reference_document<'a>(reference: &str, knowledge: &'a Value) -> Option<&'a Value> {
    let (path, section) = reference
        .split_once('#')
        .map_or((reference, None), |(p, s)| (p, Some(s)));
    knowledge["documents"].as_array()?.iter().find(|document| {
        if document["path"].as_str() != Some(path) {
            return false;
        }
        section.map_or(true, |section| {
            !section.is_empty()
                && (document["sections"]
                    .as_array()
                    .is_some_and(|sections| sections.iter().any(|s| s.as_str() == Some(section)))
                    || document["content"]
                        .as_str()
                        .is_some_and(|content| has_markdown_heading(content, section)))
        })
    })
}

/// 四项因素按置信度加权，模型总占比同时随整体置信度降低；未知回退到中性分。
/// 同时给出因素明细、证据引用与风险提示，界面直接展示“凭什么这么排”。
fn evaluate(id: &str, answers: &Value, candidate: &Value, knowledge: &Value) -> Value {
    let mut weighted = 0.0_f64;
    let mut weight_total = 0.0_f64;
    let mut conf_sum = 0.0_f64;
    let mut conf_n = 0.0_f64;
    let mut factors = Vec::new();
    let mut explanations = Vec::new();
    let mut references = Vec::new();
    let mut risks: Vec<String> = Vec::new();
    let mut best: Option<(f64, &str)> = None;
    let mut worst: Option<(f64, &str)> = None;
    for (key, label) in FACTORS {
        let node = &answers[key];
        let score = node["score"].as_f64().unwrap_or(0.0).clamp(0.0, 4.0);
        let confidence = node["confidence"].as_f64().map(|c| c.clamp(0.0, 1.0));
        // 置信度为零的未知因素不参与均值；整体置信度仍因这些缺失项降低。
        let weight = confidence.unwrap_or(0.0);
        weighted += score * weight;
        weight_total += weight;
        conf_sum += confidence.unwrap_or(0.0);
        conf_n += 1.0;
        if confidence.unwrap_or(0.0) < 0.5 {
            risks.push(format!(
                "{label} 证据不足（置信 {}）；未知不等于没有",
                confidence
                    .map(|c| format!("{c:.2}"))
                    .unwrap_or_else(|| "未提供".into())
            ));
        }
        if weight >= 0.5 && best.map_or(true, |(s, _)| score > s) {
            best = Some((score, label));
        }
        if weight >= 0.5 && worst.map_or(true, |(s, _)| score < s) {
            worst = Some((score, label));
        }
        let mut factor =
            json!({"key": key, "label": label, "score": round1(score), "confidence": confidence});
        if weight > 0.0 {
            if let Some(reason) = node["reason"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                factor["reason"] = json!(reason);
                explanations.push(format!("{label}：{reason}"));
            }
            let mut accepted = Vec::new();
            for reference in node["references"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if reference_document(reference, knowledge).is_some() {
                    accepted.push(reference.to_owned());
                    if !references.iter().any(|s| s == reference) {
                        references.push(reference.to_owned());
                    }
                } else {
                    risks.push(format!(
                        "{label} 的模型引用未在本次提供的文档中找到，已忽略：{reference}"
                    ));
                }
            }
            if !accepted.is_empty() {
                factor["references"] = json!(accepted);
            }
        }
        factors.push(factor);
    }
    let model = if weight_total > 0.0 {
        weighted / weight_total * 25.0
    } else {
        50.0
    };
    let confidence = if conf_n > 0.0 {
        Some(conf_sum / conf_n)
    } else {
        None
    };
    // No compiled or caller-supplied hero/augment prior participates in new decisions.
    // Uncertain model evidence shrinks only toward neutral, never toward a fixed fit score.
    let model_weight = confidence.unwrap_or(0.0);
    let mut score = model * model_weight + 50.0 * (1.0 - model_weight);
    for warning in candidate["dataWarnings"].as_array().into_iter().flatten() {
        if let Some(warning) = warning.as_str() {
            risks.push(warning.into());
        }
    }
    if candidate["alreadyOwned"] == true {
        score = 0.0;
        risks.push("该海克斯已经选取过，不作为可选方案".into());
    }
    let name = candidate["name"].as_str().unwrap_or(id);
    let mut parts = Vec::new();
    if !explanations.is_empty() {
        parts.push(format!("模型解释：{}", explanations.join("；")));
        risks.push("模型解释尚未经过事实核验；引用路径匹配不代表机制判断正确".into());
    } else if let (Some((best_score, best_label)), Some((worst_score, worst_label))) = (best, worst)
    {
        if best_score == worst_score {
            parts.push(format!("模型已知因素评分 {best_score:.1}/4"));
        } else {
            parts.push(format!(
                "模型较高评分 {best_label} {best_score:.1}/4，较低评分 {worst_label} {worst_score:.1}/4"
            ));
        }
    } else {
        parts.push("模型因素证据不足，向中性分收缩；未使用固定适配规则".into());
    }
    let reason = if parts.is_empty() {
        "缺少可验证因素".to_string()
    } else {
        parts.join("；")
    };
    let mut evidence = Vec::new();
    for reference in &references {
        let document = reference_document(reference, knowledge).unwrap();
        evidence.push(format!(
            "模型引用：{}（{reference}）；路径属于本次参考资料，解释仍需核验",
            document["title"].as_str().unwrap_or("文档")
        ));
    }
    if knowledge["missing"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|m| m.as_str().is_some_and(|m| m.contains(name)))
    }) {
        evidence.push(format!(
            "知识库缺少 {name} 的文档；缺失不代表该海克斯不存在"
        ));
    }
    let mut cited = false;
    if let Some(documents) = knowledge["documents"].as_array() {
        for document in documents {
            let path = document["path"].as_str().unwrap_or("");
            let title = document["title"].as_str().unwrap_or("");
            let stem = path
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .trim_end_matches(".md");
            if stem == candidate["augmentId"].as_str().unwrap_or(id)
                || (!title.is_empty() && title == name)
            {
                cited = true;
                if references
                    .iter()
                    .any(|reference| reference.split('#').next() == Some(path))
                {
                    continue;
                }
                let anchor = document["sections"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join("、")
                    })
                    .unwrap_or_default();
                if anchor.is_empty() {
                    evidence.push(format!(
                        "提供给模型的参考文档：{title}（{path}）；模型未返回逐项引用"
                    ));
                } else {
                    evidence.push(format!(
                        "提供给模型的参考文档：{title}（{path}）；提供章节：{anchor}；模型未返回逐项引用"
                    ));
                }
            }
        }
    }
    if !cited {
        evidence.push(format!("知识库暂无 {name} 的专属条目，候选交互仍需核验"));
    }
    let factor_line = factors
        .iter()
        .map(|f| {
            format!(
                "{} {:.1}",
                f["label"].as_str().unwrap_or(""),
                f["score"].as_f64().unwrap_or(0.0)
            )
        })
        .collect::<Vec<_>>()
        .join(" · ");
    evidence.push(format!("模型四项（置信度加权）：{factor_line}"));
    json!({
        "score": round1(score.clamp(0.0, 100.0)),
        "modelScore": round1(model.clamp(0.0, 100.0)),
        // Keep the nullable legacy field so existing archive readers remain compatible.
        "localScore": null,
        "alreadyOwned": candidate["alreadyOwned"] == true,
        "modelWeight": model_weight,
        "confidence": confidence.map(|c| (c * 100.0).round() / 100.0),
        "factors": factors,
        "evidence": evidence,
        "reason": reason,
        "risks": risks,
    })
}
fn validate_answers(ans: &Value, ids: &[String]) -> Result<(), String> {
    let candidates = ans.as_object().ok_or("模型结果必须为候选 ID 对象")?;
    if candidates.len() != ids.len() || candidates.keys().any(|id| !ids.contains(id)) {
        return Err("模型结果候选 ID 必须与本次请求完全一致".into());
    }
    for id in ids {
        let a = &ans[id];
        for f in ["championSynergy", "buildSynergy", "teamFit", "enemyFit"] {
            let x = &a[f];
            let s = x["score"].as_f64().ok_or("Jev score 缺失")?;
            if !(0.0..=4.0).contains(&s) {
                return Err("score 范围无效".into());
            }
            if let Some(value) = x.get("confidence") {
                let conf = value.as_f64().ok_or("confidence 必须为数字")?;
                if !(0.0..=1.0).contains(&conf) {
                    return Err("confidence 范围无效".into());
                }
            }
            if let Some(value) = x.get("reason") {
                if !value
                    .as_str()
                    .is_some_and(|reason| reason.chars().count() <= 400)
                {
                    return Err("模型因素解释必须为不超过 400 字的文本".into());
                }
            }
            if let Some(value) = x.get("references") {
                if !value.as_array().is_some_and(|references| {
                    references.len() <= 8
                        && references
                            .iter()
                            .all(|r| r.as_str().is_some_and(|r| r.chars().count() <= 256))
                }) {
                    return Err("模型引用必须为最多 8 个有效路径文本".into());
                }
            }
        }
    }
    Ok(())
}

fn confidence_kind(provider: &str, answers: &Value, ids: &[String]) -> &'static str {
    let reported = ids.iter().any(|id| {
        FACTORS
            .iter()
            .any(|(factor, _)| answers[id][*factor]["confidence"].is_number())
    });
    if !reported {
        "unavailable"
    } else if provider == "jev" {
        "provider"
    } else {
        "self_reported"
    }
}

async fn bounded(mut r: reqwest::Response) -> Result<Value, String> {
    let mut b = Vec::new();
    while let Some(c) = r.chunk().await.map_err(|_| "响应读取失败")? {
        if b.len() + c.len() > MAX_OUT {
            return Err("模型响应超过 1 MiB".into());
        }
        b.extend_from_slice(&c)
    }
    serde_json::from_slice(&b).map_err(|_| "模型服务返回无效 JSON".into())
}
fn client(secs: u64) -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(secs))
        .build()
        .map_err(|e| e.to_string())
}

/// 仅补精确身份与已拥有标记，以及观测到的等级/时间。
/// 基础字典只解析名称/别名，不读取英雄适配分，也不覆盖本次候选效果。
fn enrich_context(c: &mut Value) {
    let pairs: Vec<(String, String)> = c["candidates"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|x| {
                    Some((
                        x["id"].as_str()?.to_string(),
                        crate::scoring::canonical_augment_exact(x["name"].as_str()?)?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let own = c["ownPlayerId"].as_str().map(str::to_string);
    let own_player = own.and_then(|id| {
        c["players"].as_array().and_then(|players| {
            players
                .iter()
                .find(|p| p["id"].as_str() == Some(id.as_str()))
                .cloned()
        })
    });
    let owned: Vec<String> = own_player
        .as_ref()
        .and_then(|p| p["augments"].as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let owned_ids: HashSet<String> = owned
        .iter()
        .filter_map(|raw| crate::scoring::canonical_augment_exact(raw))
        .collect();
    if let Some(items) = c["candidates"].as_array_mut() {
        for candidate in items.iter_mut() {
            // Discard stale or caller-injected heuristic fields, including alreadyOwned.
            // Only the current player's observed choices may establish ownership.
            let mut facts = serde_json::Map::new();
            for key in ["id", "name", "description", "source", "notes"] {
                if let Some(value) = candidate.get(key) {
                    facts.insert(key.into(), value.clone());
                }
            }
            *candidate = Value::Object(facts);
            let mut already_owned = owned.iter().any(|raw| {
                raw.trim()
                    .eq_ignore_ascii_case(candidate["name"].as_str().unwrap_or("").trim())
            });
            let id = candidate["id"].as_str().unwrap_or("");
            if let Some((_, canonical)) = pairs.iter().find(|(slot, _)| slot == id) {
                candidate["augmentId"] = json!(canonical);
                already_owned |= owned_ids.contains(canonical);
            }
            candidate["alreadyOwned"] = json!(already_owned);
        }
    }
    let mut game = json!({});
    if let Some(t) = c["liveData"]["gameData"]["gameTime"].as_f64() {
        game["gameTime"] = json!(t);
    }
    if let Some(level) = c["liveData"]["activePlayer"]["level"].as_f64() {
        game["level"] = json!(level);
    }
    c["gameData"] = game;
    if let Some(version) = c["liveData"]["gameData"]["gameVersion"].as_str() {
        c["patch"] = json!(version.split('.').take(2).collect::<Vec<_>>().join("."));
    }
}

fn prepare_state(c: &Value, mode: &str) -> Result<(Value, Value, usize), String> {
    if serde_json::to_vec(c).map_err(|_| "上下文无效")?.len() > 8 * 1024 * 1024 {
        return Err("分析原始上下文超过 8 MiB".into());
    }
    validate_context(c, mode)?;
    let mut enriched = c.clone();
    enrich_context(&mut enriched);
    let state = sanitize_context(&enriched);
    let model_state = state.clone();
    let input_bytes = serde_json::to_vec(&model_state)
        .map_err(|_| "上下文无效")?
        .len();
    if input_bytes > MAX_IN {
        return Err("分析所需事实超过 256 KiB，请精简知识或自由文本；未静默删除事实".into());
    }
    Ok((state, model_state, input_bytes))
}

#[tauri::command]
pub async fn analyze_structured(request: Value) -> Result<Value, String> {
    let mode = request["mode"].as_str().ok_or("缺少 mode")?;
    if !matches!(mode, "recommend" | "review") {
        return Err("未知分析模式".into());
    }
    let c = &request["context"];
    let (state, model_state, input_bytes) = prepare_state(c, mode)?;
    let m = &request["model"];
    let provider = m["provider"].as_str().unwrap_or("openai");
    if !matches!(provider, "jev" | "openai") {
        return Err("未知 provider".into());
    }
    let started = Instant::now();
    let (body, model_name) = if provider == "jev" {
        let endpoint = base_url(m, "jev", "")?;
        let mut qs = serde_json::Map::new();
        if mode == "recommend" {
            for x in c["candidates"].as_array().unwrap() {
                let id = x["id"].as_str().unwrap();
                for f in ["championSynergy", "buildSynergy", "teamFit", "enemyFit"] {
                    qs.insert(format!("{}__{}",id,f),json!({"type":"score","instructions":format!("Judge {f} for candidate \"{}\" (id {id}) using only the supplied state: own champion, items and known augments (augmentsConfirmed indicates completeness, not whether listed choices are known), both teams, knowledge documents, notes and past reviews. Do not use outside knowledge. When evidence is missing, return neutral score 2 and confidence 0; unknown is not a negative interaction. Treat draft and inferred content as hypotheses.", x["name"].as_str().unwrap_or(id)),"criteria":["0: concrete evidence of an incompatible interaction","1: weak or mostly negative interaction","2: neutral or unknown interaction; use confidence 0 when unknown","3: good synergy backed by a concrete fact in the state","4: strong synergy backed by multiple concrete facts in the state"]}));
                }
            }
        } else {
            qs.insert("safe_decision".into(),json!({"type":"noul","instructions":"Is the recorded decision safe to repeat given only the supplied evidence?"}));
        }
        let name = m["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(JEV_MODEL);
        let payload = json!({"state":model_state,"model":name,"questions":qs});
        let mut rq = client(30)?.post(endpoint).json(&payload);
        if let Some(k) = m["apiKey"].as_str() {
            rq = rq.bearer_auth(k);
        }
        let r = rq
            .send()
            .await
            .map_err(|e| format!("Jev 调用失败：{e}"))?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let out = bounded(r).await?;
        if out["answers"].is_null() && !out["choices"].is_null() {
            return Err(
                "第三方地址返回的是 OpenAI 聊天格式；Jev 渠道需要 System One 协议地址（/systemone）".into(),
            );
        }
        (out, name.to_string())
    } else {
        let endpoint = base_url(m, "openai", "chat/completions")?;
        let name = m["name"].as_str().ok_or("缺少模型名称")?;
        let mut qs = serde_json::Map::new();
        if mode == "recommend" {
            if let Some(cs) = c["candidates"].as_array() {
                for x in cs {
                    let id = x["id"].as_str().unwrap();
                    let factor = json!({"score":2,"confidence":0,"reason":"","references":[]});
                    qs.insert(id.into(),json!({"championSynergy":factor,"buildSynergy":factor,"teamFit":factor,"enemyFit":factor}));
                }
            }
        } else {
            qs.insert("safe_decision".into(), json!(0.5));
        }
        let instructions = if mode == "recommend" {
            "Return exact JSON answers. Each candidate has four factors with score 0..4 and confidence 0..1 based only on the supplied state. Include a concise Chinese reason (at most 50 characters) for each known factor. references lists only exact supplied knowledge document paths, optionally #section; use [] for explanations based on candidate effects or player facts. Never invent a reference or mechanic. When a factor is unknown, return neutral score 2, confidence 0, empty reason and references; unknown is not a negative interaction. Draft documents and inferred labels are hypotheses, not verified mechanics. Confidence is your self-assessment, not a calibrated probability."
        } else {
            "Return exact JSON with safe_decision as a number 0..1: whether the recorded choice is supported for reuse under similar conditions, using only the supplied decisions and outcome. Use 0.5 if evidence is insufficient. A single outcome does not prove causation. Do not return candidate factor scores."
        };
        let prompt = json!({"state":model_state,"questions":instructions,"expected":qs});
        let mut payload = json!({"model":name,"temperature":0,"max_tokens":m["maxTokens"].as_u64().unwrap_or(1800).clamp(256,4096),"messages":[{"role":"system","content":"Output only validated JSON."},{"role":"user","content":prompt.to_string()}]});
        if m["jsonMode"].as_bool().unwrap_or(true) {
            payload["response_format"] = json!({"type":"json_object"});
        }
        let mut rq = client(30)?.post(endpoint).json(&payload);
        if let Some(k) = m["apiKey"].as_str() {
            rq = rq.bearer_auth(k);
        }
        let r = rq
            .send()
            .await
            .map_err(|e| format!("模型调用失败：{e}"))?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        (bounded(r).await?, name.to_string())
    };
    if mode == "review" {
        let p = if provider == "jev" {
            body["answers"]["safe_decision"]
                .as_f64()
                .or_else(|| body["answers"]["safe_decision"]["noul"].as_f64())
                .ok_or("Jev noul answer 缺失")?
        } else {
            let s = body["choices"][0]["message"]["content"]
                .as_str()
                .ok_or("模型未返回文本")?;
            let v: Value = serde_json::from_str(s).map_err(|_| "模型 JSON 无效")?;
            v["safe_decision"]
                .as_f64()
                .or_else(|| v.as_f64())
                .ok_or("复盘 safe_decision 无效")?
        };
        if !(0.0..=1.0).contains(&p) {
            return Err("复盘概率超出范围".into());
        }
        let lesson = if p >= 0.7 {
            "记录支持在相似条件下复用该决策；需用更多对局验证"
        } else {
            "记录不足以支持复用该决策；先验证关键条件"
        };
        return Ok(
            json!({"summary":if p>=0.5{"结构化证据对该决策重复使用的支持有限，不能据此断言因果"}else{"结构化证据不支持直接重复该决策，不能据此断言因果"},"lessons":[lesson],"caveats":["样本量、混杂因素与未记录信息"],"engine":{"provider":provider,"model":model_name,"latencyMs":started.elapsed().as_millis(),"inputBytes":input_bytes,"confidenceKind":"unavailable"}}),
        );
    }
    let ids: Vec<String> = c["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap().to_string())
        .collect();
    let answers = if provider == "jev" {
        let raw = &body["answers"];
        let mut nested = serde_json::Map::new();
        for id in &ids {
            let mut q = serde_json::Map::new();
            for f in ["championSynergy", "buildSynergy", "teamFit", "enemyFit"] {
                let key = format!("{}__{}", id, f);
                q.insert(f.into(), raw[&key].clone());
            }
            nested.insert(id.clone(), Value::Object(q));
        }
        Value::Object(nested)
    } else {
        let s = body["choices"][0]["message"]["content"]
            .as_str()
            .ok_or("模型未返回文本")?;
        serde_json::from_str(s).map_err(|_| "模型 JSON 无效")?
    };
    validate_answers(&answers, &ids)?;
    let mut ranking = Vec::new();
    for id in &ids {
        let candidate = state["candidates"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["id"].as_str() == Some(id.as_str()))
                    .cloned()
            })
            .unwrap_or_else(|| json!({"id": id}));
        let evaluated = evaluate(id, &answers[id], &candidate, &state["knowledge"]);
        ranking.push(json!({
            "candidateId": id,
            "score": evaluated["score"],
            "modelScore": evaluated["modelScore"],
            "localScore": evaluated["localScore"],
            "alreadyOwned": evaluated["alreadyOwned"],
            "modelWeight": evaluated["modelWeight"],
            "confidence": evaluated["confidence"],
            "factors": evaluated["factors"],
            "evidence": evaluated["evidence"],
            "reason": evaluated["reason"],
            "risks": evaluated["risks"],
        }));
    }
    ranking.sort_by(|a, b| {
        (a["alreadyOwned"] == true)
            .cmp(&(b["alreadyOwned"] == true))
            .then_with(|| {
                b["score"]
                    .as_f64()
                    .partial_cmp(&a["score"].as_f64())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let confidences: Vec<f64> = ranking
        .iter()
        .filter_map(|item| item["confidence"].as_f64())
        .collect();
    let overall = (!confidences.is_empty())
        .then(|| confidences.iter().sum::<f64>() / confidences.len() as f64);
    let summary = format!(
        "本次模型依据对局、知识与历史动态比较；四项因素按置信度加权，证据不足向中性 50 分收缩，不叠加固定英雄或海克斯适配分{}；分数是相对契合度，不是胜率。",
        overall
            .map(|c| format!("，综合置信度 {c:.2}"))
            .unwrap_or_default()
    );
    Ok(
        json!({"ranking":ranking,"summary":summary,"missingInformation":({ let mut missing=c["knowledge"]["missing"].as_array().cloned().unwrap_or_default(); if c["players"].as_array().unwrap().iter().any(|p| p["augmentsConfirmed"]!=true) { missing.push(json!("部分玩家的已选海克斯未识别，建议仅基于已知信息；缺失不代表没有。")); } missing }),"engine":{"provider":provider,"model":model_name,"latencyMs":started.elapsed().as_millis(),"inputBytes":input_bytes,"confidenceKind":confidence_kind(provider,&answers,&ids),"scoringMode":"dynamic-model-v1"}}),
    )
}

#[tauri::command]
pub async fn test_provider(model: Value) -> Result<Value, String> {
    let provider = model["provider"].as_str().unwrap_or("openai");
    let endpoint = base_url(&model, provider, "models")?;
    let mut rq = client(8)?.get(endpoint);
    if let Some(k) = model["apiKey"].as_str() {
        rq = rq.bearer_auth(k);
    }
    let started = Instant::now();
    let body = bounded(
        rq.send()
            .await
            .map_err(|_| "无法连接模型服务")?
            .error_for_status()
            .map_err(|e| e.to_string())?,
    )
    .await?;
    let arr = if provider == "jev" {
        body["models"]
            .as_array()
            .or_else(|| body["data"].as_array())
            .ok_or_else(|| {
                let keys = body
                    .as_object()
                    .map(|m| m.keys().cloned().collect::<Vec<_>>().join("、"))
                    .unwrap_or_default();
                format!("Jev models 格式无效：返回缺少 models/data 数组（顶层字段：{keys}）")
            })?
    } else {
        body["data"].as_array().ok_or("OpenAI models 格式无效")?
    };
    let models = arr
        .iter()
        .take(100)
        .filter_map(|x| x["name"].as_str().or_else(|| x["id"].as_str()))
        .map(str::to_string)
        .collect::<Vec<_>>();
    Ok(
        json!({"models":models,"latencyMs":started.elapsed().as_millis(),"note":"已验证模型列表接口"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ctx() -> Value {
        json!({"ownPlayerId":"abc","players":[{"id":"abc","team":"ORDER","champion":"A","augments":[],"augmentsConfirmed":true},{"id":"x","team":"CHAOS","champion":"B","augments":[],"augmentsConfirmed":true}],"candidates":[{"id":"c1","name":"One","description":"effect"},{"id":"c2","name":"Two","description":"effect"}]})
    }
    #[test]
    fn frontend_context_survives_without_player_identity() {
        let mut c = ctx();
        c["players"][0]["name"] = json!("PRIVATE_PLAYER");
        c["notes"] = json!("打法说明");
        c["outcome"] = json!("结算观察");
        c["knowledge"] = json!({"documents":[{"path":"champions/a.md","title":"A","content":"关键机制","hash":"h"}],"warnings":["版本未知"],"missing":[]});
        c["history"] = json!([{ "ownChampion":"A","ownAugments":["泰坦的坚决"],"chosen":"One","review":{"summary":"历史观察","lessons":["条件"],"caveats":["反例"]},"result":{"status":"win","gameId":"SECRET_GAME"}}]);
        c["decisions"] = json!([{ "chosenId":"c1","context":{"players":c["players"],"ownPlayerId":"abc","candidates":c["candidates"]},"result":{"summary":"先前比较","ranking":[]}}]);
        let v = sanitize_context(&c);
        assert_eq!(v["knowledge"]["documents"][0]["content"], "关键机制");
        assert_eq!(v["history"][0]["review"]["summary"], "历史观察");
        assert_eq!(v["history"][0]["ownAugments"][0], "泰坦的坚决");
        assert_eq!(v["history"][0]["chosen"], "One");
        assert_eq!(
            v["decisions"][0]["context"]["players"]["p1"]["champion"],
            "A"
        );
        assert_eq!(v["notes"], "打法说明");
        assert_eq!(v["outcome"], "结算观察");
        assert!(!v.to_string().contains("PRIVATE_PLAYER"));
        assert!(!v.to_string().contains("SECRET_GAME"));
    }
    #[test]
    fn url_rules() {
        assert!(base_url(&json!({"provider":"jev"}), "jev", "").is_ok());
        assert!(base_url(
            &json!({"baseUrl":"https://x.test?a=1","allowThirdParty":true}),
            "jev",
            ""
        )
        .is_err());
        assert!(base_url(
            &json!({"baseUrl":"http://127.0.0.1:1"}),
            "openai",
            "chat/completions"
        )
        .is_ok());
    }
    #[test]
    fn strips_ids() {
        let mut c = ctx();
        c["liveData"] = json!({"secret":1});
        c["gameId"] = json!("bad");
        let s = sanitize_context(&c);
        assert!(s["players"]["p1"].is_object());
        assert!(s.get("liveData").is_none());
        assert!(s.get("gameId").is_none());
    }
    #[test]
    fn context_gates() {
        let c = ctx();
        assert!(validate_context(&c, "recommend").is_ok());
        let mut x = c.clone();
        x["players"][0]["augmentsConfirmed"] = json!(false);
        assert!(validate_context(&x, "recommend").is_ok());
        assert_eq!(
            sanitize_context(&x)["players"]["p1"]["augmentsConfirmed"],
            false
        );
        assert!(sanitize_context(&x)["players"]["p1"]["augmentDataStatus"]
            .as_str()
            .unwrap()
            .contains("unknown"));
        let mut x = c.clone();
        x["candidates"] = json!([{"id":"c1","name":"One","description":"effect"}]);
        assert!(validate_context(&x, "recommend").is_err());
        let mut x = c.clone();
        x["players"][1]["team"] = json!("ORDER");
        assert!(validate_context(&x, "recommend").is_err());
        let mut x = c;
        x["candidates"][0]["id"] = json!("  ");
        assert!(validate_context(&x, "recommend").is_err());
    }
    #[test]
    fn answer_schema() {
        let ids = vec!["c1".into()];
        let good = json!({"c1":{"championSynergy":{"score":2.0,"confidence":0.5},"buildSynergy":{"score":3.0,"confidence":1.0},"teamFit":{"score":1.0,"confidence":0.0},"enemyFit":{"score":4.0,"confidence":0.9}}});
        assert!(validate_answers(&good, &ids).is_ok());
        let mut bad = good.clone();
        bad["c1"]["enemyFit"]["score"] = json!(5);
        assert!(validate_answers(&bad, &ids).is_err());
        let mut extra = good.clone();
        extra["invented-candidate"] = good["c1"].clone();
        assert!(validate_answers(&extra, &ids).is_err());
        assert!(validate_answers(&json!({}), &ids).is_err());
    }
    #[test]
    fn dynamic_result_ignores_legacy_and_injected_local_priors() {
        let mut answers = json!({});
        for (key, _) in FACTORS {
            answers[key] = json!({"score":3,"confidence":0.8});
        }
        let plain = evaluate("1068", &answers, &json!({"name":"循环往复"}), &json!({}));
        for local_score in [0.0, 30.0, 100.0] {
            let legacy = json!({"name":"循环往复","localScore":local_score,"priorReliability":1,"localReason":"固定最优","profileWarnings":["旧画像"]});
            let actual = evaluate("1068", &answers, &legacy, &json!({}));
            assert_eq!(actual, plain);
            assert_eq!(actual["score"], 70.0);
            assert!(actual["localScore"].is_null());
        }
    }
    #[test]
    fn evaluate_weights_confidence_and_shrinks_only_toward_neutral() {
        let answers = json!({
            "championSynergy": {"score": 4.0, "confidence": 1.0},
            "buildSynergy": {"score": 4.0, "confidence": 1.0},
            "teamFit": {"score": 4.0, "confidence": 1.0},
            "enemyFit": {"score": 0.0, "confidence": 0.0},
        });
        let candidate =
            json!({"id":"1068","name":"循环往复","localScore":60.0,"localReason":"标签契合"});
        let out = evaluate("1068", &answers, &candidate, &json!({}));
        let model = out["modelScore"].as_f64().unwrap();
        // 未知的 enemyFit 完全不参与已知因素均值，但降低模型总占比。
        assert_eq!(model, 100.0);
        let score = out["score"].as_f64().unwrap();
        assert_eq!(score, model * 0.75 + 50.0 * 0.25);
        assert_eq!(out["modelWeight"], 0.75);
        assert!(out["localScore"].is_null());
        let risks = out["risks"].as_array().unwrap();
        assert!(!risks.iter().any(|r| r.as_str().unwrap().contains("分歧")));
        assert!(risks
            .iter()
            .any(|r| r.as_str().unwrap().contains("证据不足")));
        assert_eq!(out["factors"].as_array().unwrap().len(), 4);
        assert!(out["evidence"].as_array().unwrap().len() >= 2);
        assert!(out["confidence"].as_f64().unwrap() < 1.0);
    }
    #[test]
    fn evaluate_cites_knowledge_documents_and_flags_missing_docs() {
        let answers = json!({"championSynergy":{"score":2.0},"buildSynergy":{"score":2.0},"teamFit":{"score":2.0},"enemyFit":{"score":2.0}});
        let candidate =
            json!({"id":"1068","name":"循环往复","localScore":50.0,"localReason":"中性"});
        let knowledge = json!({"documents":[{"path":"augments/1068.md","title":"循环往复","content":"x"}],"missing":["Augment: 某某海克斯"]});
        let out = evaluate("1068", &answers, &candidate, &knowledge);
        let evidence: Vec<String> = out["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e.as_str().unwrap_or("").to_string())
            .collect();
        assert!(
            evidence.iter().any(|e| e.contains("augments/1068.md")),
            "{evidence:?}"
        );
        assert!(
            evidence.iter().any(|e| e.contains("模型四项")),
            "{evidence:?}"
        );
        let absent = json!({"documents":[],"missing":["Augment: 循环往复"]});
        let flagged = evaluate("1068", &answers, &candidate, &absent);
        assert!(
            flagged["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e.as_str().unwrap_or("").contains("知识库缺少")),
            "{flagged}"
        );
    }
    #[test]
    fn enrich_context_adds_only_identity_ownership_and_observed_level() {
        let mut c = ctx();
        c["candidates"] = json!([
            {"id":"1068","name":"循环往复","description":"获得60技能急速。"},
            {"id":"1388","name":"无限循环往复","description":"获得60技能急速，外加每次参与击杀3技能急速。"}
        ]);
        c["liveData"] = json!({"gameData":{"gameTime":123.0},"activePlayer":{"level":7}});
        enrich_context(&mut c);
        assert_eq!(c["candidates"][0]["augmentId"], "1068");
        assert!(c["candidates"][0]["rarity"].is_null());
        assert!(c["candidates"][0]["localScore"].is_null());
        assert_eq!(c["gameData"]["level"], 7.0);
        let state = sanitize_context(&c);
        assert_eq!(state["gameData"]["level"], 7.0);
        assert_eq!(state["candidates"][0]["description"], "获得60技能急速。");
        assert_eq!(state["gameData"]["gameTime"], 123.0);
    }

    #[test]
    fn observed_equipment_is_sent_as_facts_not_converted_into_fixed_points() {
        let mut c = ctx();
        c["players"][0]["champion"] = json!("Ekko");
        c["players"][0]["items"] = json!([{"itemID": 3115, "count": 1}]);
        c["candidates"] = json!([
            {"id":"slot-1","name":"虚幻武器","description":"你的技能可施加攻击特效。每个目标有1秒冷却时间。"},
            {"id":"slot-2","name":"超强大脑","description":"获得基于法术强度的护盾。"}
        ]);
        let (with_items, sent, _) = prepare_state(&c, "recommend").unwrap();
        c["players"][0]["items"] = json!([]);
        let (without_items, _, _) = prepare_state(&c, "recommend").unwrap();
        assert_eq!(with_items["candidates"], without_items["candidates"]);
        assert_eq!(with_items["candidates"][0]["alreadyOwned"], false);
        assert_eq!(sent["players"]["p1"]["items"][0]["itemID"], 3115);
        assert!(sent["candidates"][0]["localScore"].is_null());
        assert!(sent["candidates"][0]["mechanismContributions"].is_null());
    }

    #[test]
    fn low_or_absent_confidence_reduces_total_model_influence() {
        let mut answers = json!({});
        for (key, _) in FACTORS {
            answers[key] = json!({"score":4.0,"confidence":0.1});
        }
        let candidate = json!({"name":"example","localScore":60.0});
        let low = evaluate("example", &answers, &candidate, &json!({}));
        assert_eq!(low["score"], 55.0);
        for (key, _) in FACTORS {
            answers[key] = json!({"score":4.0});
        }
        let absent = evaluate("example", &answers, &candidate, &json!({}));
        assert_eq!(absent["score"], 50.0);
        assert_eq!(
            evaluate("example", &answers, &json!({}), &json!({}))["score"],
            50.0
        );
        answers["enemyFit"]["confidence"] = json!("high");
        assert!(validate_answers(&json!({"example":answers}), &["example".into()]).is_err());
    }

    #[test]
    fn manual_slots_resolve_by_name_and_owned_choices_stay_unavailable() {
        let mut c = ctx();
        c["players"][0]["champion"] = json!("Ahri");
        c["players"][0]["augments"] = json!(["循环往复"]);
        c["candidates"] = json!([
            {"id":"1","name":"循环往复","description":"effect"},
            {"id":"2","name":"未知手填","description":"effect"}
        ]);
        enrich_context(&mut c);
        assert_eq!(c["candidates"][0]["id"], "1");
        assert_eq!(c["candidates"][0]["augmentId"], "1068");
        assert_eq!(c["candidates"][0]["alreadyOwned"], true);
        assert!(c["candidates"][0]["localScore"].is_null());
        assert!(c["candidates"][1]["localScore"].is_null());
        let mut answers = json!({});
        for (key, _) in FACTORS {
            answers[key] = json!({"score":4.0,"confidence":1.0});
        }
        assert_eq!(
            evaluate("1", &answers, &c["candidates"][0], &json!({}))["score"],
            0.0
        );
    }

    #[test]
    fn request_budget_counts_sanitized_facts_and_prior_scores_are_not_sent() {
        let mut c = ctx();
        c["candidates"] = json!([
            {"id":"1","name":"循环往复","description":"effect"},
            {"id":"2","name":"无限循环往复","description":"effect"}
        ]);
        c["liveData"] = json!({"private":"x".repeat(MAX_IN+1)});
        let (state, sent, bytes) = prepare_state(&c, "recommend").unwrap();
        assert!(state["candidates"][0]["localScore"].is_null());
        assert!(sent["candidates"][0]["localScore"].is_null());
        assert!(sent["liveData"].is_null());
        assert_eq!(bytes, serde_json::to_vec(&sent).unwrap().len());
        c["notes"] = json!("x".repeat(MAX_IN + 1));
        assert!(prepare_state(&c, "recommend").is_err());
    }

    #[test]
    fn preparation_strips_heuristics_preserves_current_facts_and_does_not_rewrite_archive() {
        let mut c = ctx();
        c["players"][0]["champion"] = json!("Qiyana");
        c["candidates"][0] = json!({
            "id":"slot-1", "name":"终极刷新", "description":"本次完整效果及现场条件",
            "localScore":99, "localReason":"固定英雄最优", "priorReliability":1,
            "category":"damage", "tags":["ultimate"], "traits":["damage-ultimate"],
            "mechanismContributions":[{"points":40}], "profileWarnings":["旧画像"],
            "alreadyOwned":true, "augmentId":"wrong-id"
        });
        c["knowledge"] = json!({"documents":[{"path":"champions/qiyana.md","content":"实际维护的英雄机制"}],"fingerprint":"current-knowledge"});
        c["history"] = json!([{"ownChampion":"Qiyana","notes":"过去条件不同，仅为观察"}]);
        c["decisions"] = json!([{"result":{"ranking":[{"candidateId":"slot-1","score":87,"localScore":99,"priorReliability":1}]}}]);
        let original = c.clone();
        let (state, sent, _) = prepare_state(&c, "recommend").unwrap();
        assert_eq!(
            c, original,
            "Reading legacy contexts must not migrate saved decisions"
        );
        assert_eq!(
            state, sent,
            "There is no hidden local prior for postprocessing"
        );
        assert_eq!(sent["candidates"][0]["id"], "slot-1");
        assert_eq!(sent["candidates"][0]["augmentId"], "1088");
        assert_eq!(
            sent["candidates"][0]["description"],
            "本次完整效果及现场条件"
        );
        assert_eq!(sent["candidates"][0]["alreadyOwned"], false);
        assert_eq!(
            sent["knowledge"]["documents"][0]["content"],
            "实际维护的英雄机制"
        );
        assert_eq!(sent["history"][0]["notes"], "过去条件不同，仅为观察");
        for field in [
            "localScore",
            "localReason",
            "priorReliability",
            "tags",
            "traits",
            "category",
            "profileWarnings",
            "mechanismContributions",
        ] {
            assert!(sent["candidates"][0].get(field).is_none(), "{field}");
        }
        assert!(sent["decisions"][0]["result"]["ranking"][0]
            .get("localScore")
            .is_none());
        assert_eq!(sent["decisions"][0]["result"]["ranking"][0]["score"], 87);
    }

    #[test]
    fn exact_owned_aliases_are_excluded_but_unrelated_unknown_names_are_not() {
        for owned in ["1068", "循环往复", "  Recursion  "] {
            let mut c = ctx();
            c["players"][0]["augments"] = json!([owned]);
            c["candidates"][0] =
                json!({"id":"manual-slot","name":"循环往复","description":"user supplied effect"});
            let (state, _, _) = prepare_state(&c, "recommend").unwrap();
            assert_eq!(state["candidates"][0]["alreadyOwned"], true, "{owned}");
        }
        let mut c = ctx();
        c["players"][0]["augments"] = json!(["复盘提到循环往复而非实际名称"]);
        c["candidates"][0] = json!({"id":"manual-slot","name":"循环往复","description":"effect"});
        let (state, _, _) = prepare_state(&c, "recommend").unwrap();
        assert_eq!(state["candidates"][0]["alreadyOwned"], false);
    }

    #[test]
    fn unknown_factors_never_change_known_scores_or_become_weaknesses() {
        let mut answers = json!({});
        for (key, _) in FACTORS {
            answers[key] = json!({"score":4,"confidence":0});
        }
        answers["championSynergy"]["confidence"] = json!(1);
        let known = evaluate("a", &answers, &json!({"name":"A"}), &json!({}));
        answers["enemyFit"]["score"] = json!(0);
        answers["buildSynergy"]["score"] = json!(1);
        let changed = evaluate("a", &answers, &json!({"name":"A"}), &json!({}));
        assert_eq!(known["modelScore"], 100.0);
        assert_eq!(known["score"], changed["score"]);
        assert_eq!(known["score"], 62.5);
        assert_eq!(
            evaluate(
                "a",
                &answers,
                &json!({"name":"A","localScore":60}),
                &json!({})
            )["score"],
            62.5
        );
        assert!(!changed["reason"].as_str().unwrap().contains("敌方"));
    }

    #[test]
    fn explanations_keep_only_supplied_document_paths_and_sections() {
        let mut answers = json!({});
        for (key, _) in FACTORS {
            answers[key] = json!({"score":2,"confidence":0});
        }
        answers["championSynergy"] = json!({"score":3,"confidence":0.8,"reason":"效果提供技能急速，配合当前技能使用。","references":["augments/1068.md#完整效果","champions/ahri.md","invented.md","augments/1068.md#不存在的章节"]});
        let knowledge = json!({"documents":[{"path":"augments/1068.md","title":"循环往复","content":"# 循环往复\n## 完整效果\n获得急速。"},{"path":"champions/ahri.md","title":"阿狸","content":"reference"}]});
        assert!(validate_answers(&json!({"1":answers}), &["1".into()]).is_ok());
        let out = evaluate(
            "1",
            &answers,
            &json!({"name":"循环往复","augmentId":"1068"}),
            &knowledge,
        );
        assert!(out["reason"].as_str().unwrap().contains("技能急速"));
        assert_eq!(
            out["factors"][0]["references"],
            json!(["augments/1068.md#完整效果", "champions/ahri.md"])
        );
        assert!(out["risks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|risk| risk.as_str().unwrap().contains("invented.md")));
        assert!(out["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap().contains("模型引用：阿狸")));
        assert!(!out["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str().unwrap().contains("模型未返回逐项引用")));
    }

    #[test]
    fn optional_explanation_shape_is_bounded_and_zero_confidence_text_is_ignored() {
        let mut answers = json!({});
        for (key, _) in FACTORS {
            answers[key] = json!({"score":4,"confidence":0,"reason":"unsupported claim","references":["invented.md"]});
        }
        let out = evaluate("1", &answers, &json!({"name":"A"}), &json!({}));
        assert_eq!(out["modelScore"], 50.0);
        assert!(!out["reason"].as_str().unwrap().contains("unsupported"));
        answers["teamFit"]["reason"] = json!("x".repeat(401));
        assert!(validate_answers(&json!({"1":answers}), &["1".into()]).is_err());
        answers["teamFit"]["reason"] = json!("");
        answers["teamFit"]["references"] = json!("invalid");
        assert!(validate_answers(&json!({"1":answers}), &["1".into()]).is_err());
    }

    #[test]
    fn confidence_origin_and_observed_patch_are_preserved() {
        let mut c = ctx();
        c["patch"] = json!("26.20");
        assert_eq!(sanitize_context(&c)["patch"], "26.20");
        let answers = json!({"1":{"championSynergy":{"score":3,"confidence":0.8}}});
        assert_eq!(
            confidence_kind("openai", &answers, &["1".into()]),
            "self_reported"
        );
        assert_eq!(confidence_kind("jev", &answers, &["1".into()]), "provider");
        assert_eq!(
            confidence_kind(
                "openai",
                &json!({"1":{"championSynergy":{"score":3}},"hallucinated":{"championSynergy":{"score":3,"confidence":1}}}),
                &["1".into()]
            ),
            "unavailable"
        );
    }

    #[test]
    fn section_references_ignore_code_fences_and_invalid_headings() {
        let knowledge = json!({"documents":[{"path":"doc.md","content":"#foo\n```md\n## 假标题\n```\n~~~\n## 另一个假标题\n~~~\n  ## 真实标题 ##\n    ## 缩进代码\n\t## 制表缩进\n \t## 混合缩进\n\u{a0}## 非标准缩进"}]});
        assert!(reference_document("doc.md#真实标题", &knowledge).is_some());
        for section in [
            "foo",
            "假标题",
            "另一个假标题",
            "缩进代码",
            "制表缩进",
            "混合缩进",
            "非标准缩进",
        ] {
            assert!(reference_document(&format!("doc.md#{section}"), &knowledge).is_none());
        }
    }
}
