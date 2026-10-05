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
            if !seen.insert(id) || !text(&x["name"]) || !text(&x["description"]) {
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
                            | "category"
                            | "tags"
                            | "localScore"
                            | "localReason"
                            | "localRisks"
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

/// 四项因素按置信度加权（低置信因素权重更低），再与本地规则先验按 70/30 融合。
/// 同时给出因素明细、证据引用与风险提示，界面直接展示“凭什么这么排”。
fn evaluate(id: &str, answers: &Value, candidate: &Value, knowledge: &Value) -> Value {
    let mut weighted = 0.0_f64;
    let mut weight_total = 0.0_f64;
    let mut conf_sum = 0.0_f64;
    let mut conf_n = 0.0_f64;
    let mut factors = Vec::new();
    let mut risks: Vec<String> = Vec::new();
    let mut best: Option<(f64, &str)> = None;
    let mut worst: Option<(f64, &str)> = None;
    for (key, label) in FACTORS {
        let node = &answers[key];
        let score = node["score"].as_f64().unwrap_or(0.0).clamp(0.0, 4.0);
        let confidence = node["confidence"].as_f64().map(|c| c.clamp(0.0, 1.0));
        let weight = confidence.map(|c| c.clamp(0.25, 1.0)).unwrap_or(1.0);
        weighted += score * weight;
        weight_total += weight;
        if let Some(c) = confidence {
            conf_sum += c;
            conf_n += 1.0;
            if c < 0.5 {
                risks.push(format!("{label} 证据不足（置信 {c:.2}）；未知不等于没有"));
            }
        }
        if best.map_or(true, |(s, _)| score > s) {
            best = Some((score, label));
        }
        if worst.map_or(true, |(s, _)| score < s) {
            worst = Some((score, label));
        }
        factors.push(
            json!({"key": key, "label": label, "score": round1(score), "confidence": confidence}),
        );
    }
    let model = if weight_total > 0.0 {
        weighted / weight_total * 25.0
    } else {
        0.0
    };
    let confidence = if conf_n > 0.0 {
        Some(conf_sum / conf_n)
    } else {
        None
    };
    let local = candidate["localScore"]
        .as_f64()
        .map(|v| v.clamp(0.0, 100.0));
    let mut score = model;
    if let Some(l) = local {
        score = model * 0.7 + l * 0.3;
        if (model - l).abs() >= 20.0 {
            risks.push(format!(
                "模型 {model:.0} 与本地规则 {l:.0} 分歧较大，建议自行复核"
            ));
        }
    }
    let name = candidate["name"].as_str().unwrap_or(id);
    let mut parts = Vec::new();
    if let (Some((best_score, best_label)), Some((worst_score, worst_label))) = (best, worst) {
        parts.push(format!(
            "模型强项 {best_label} {best_score:.1}/4，弱项 {worst_label} {worst_score:.1}/4"
        ));
    }
    if let Some(reason) = candidate["localReason"].as_str() {
        parts.push(format!("本地规则：{reason}"));
    }
    let reason = if parts.is_empty() {
        "缺少可验证因素".to_string()
    } else {
        parts.join("；")
    };
    let mut evidence = Vec::new();
    if let Some(local_score) = local {
        evidence.push(format!(
            "本地规则先验 {local_score:.0}/100：静态标签匹配，非模型判断"
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
            if stem == id || (!title.is_empty() && title == name) {
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
                    evidence.push(format!("知识库依据：{title}（{path}）"));
                } else {
                    evidence.push(format!("知识库依据：{title}（{path}#{anchor}）"));
                }
                cited = true;
            }
        }
    }
    if !cited {
        evidence.push(format!("知识库暂无 {name} 的条目，本次仅依据对局事实"));
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
        "localScore": local.map(round1),
        "confidence": confidence.map(round1),
        "factors": factors,
        "evidence": evidence,
        "reason": reason,
        "risks": risks,
    })
}
fn validate_answers(ans: &Value, ids: &[String]) -> Result<(), String> {
    for id in ids {
        let a = &ans[id];
        for f in ["championSynergy", "buildSynergy", "teamFit", "enemyFit"] {
            let x = &a[f];
            let s = x["score"].as_f64().ok_or("Jev score 缺失")?;
            if !(0.0..=4.0).contains(&s) {
                return Err("score 范围无效".into());
            }
            if let Some(conf) = x["confidence"].as_f64() {
                if !(0.0..=1.0).contains(&conf) {
                    return Err("confidence 范围无效".into());
                }
            }
        }
    }
    Ok(())
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

/// 发给模型之前补充本地事实：候选的静态元数据与本地规则先验、当前等级与对局时间。
/// 只补事实，不改候选本身；模型看不到这些字段时按缺失处理。
fn enrich_context(c: &mut Value) {
    let ids: Vec<String> = c["candidates"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|x| x["id"].as_str().map(str::to_string))
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
    let champion = own_player
        .as_ref()
        .and_then(|p| p["champion"].as_str())
        .map(str::to_string);
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
    let prior = crate::scoring::prior(&ids, champion.as_deref(), &owned);
    if let Some(items) = c["candidates"].as_array_mut() {
        for candidate in items.iter_mut() {
            let id = candidate["id"].as_str().unwrap_or("");
            if let Some(entry) = prior[id].as_object() {
                for (key, value) in entry {
                    candidate[key.clone()] = value.clone();
                }
            }
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
}

#[tauri::command]
pub async fn analyze_structured(request: Value) -> Result<Value, String> {
    let mode = request["mode"].as_str().ok_or("缺少 mode")?;
    if !matches!(mode, "recommend" | "review") {
        return Err("未知分析模式".into());
    }
    let c = &request["context"];
    if serde_json::to_vec(c).map_err(|_| "上下文无效")?.len() > MAX_IN {
        return Err("分析上下文超过 256 KiB".into());
    }
    validate_context(c, mode)?;
    let mut enriched = c.clone();
    enrich_context(&mut enriched);
    let state = sanitize_context(&enriched);
    let input_bytes = serde_json::to_vec(&state).map_err(|_| "上下文无效")?.len();
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
                    qs.insert(format!("{}__{}",id,f),json!({"type":"score","instructions":format!("Judge {f} for candidate \"{}\" (id {id}) using only the supplied state: own champion, items and confirmed augments, both teams, knowledge documents, notes and past reviews. Do not use outside knowledge. When the state has no evidence for this factor, keep the score low and lower the confidence instead of guessing.", x["name"].as_str().unwrap_or(id)),"criteria":["0: no meaningful interaction, or the state contains no evidence for it","1: weak or mostly negative interaction","2: mixed, uncertain, or thinly evidenced interaction","3: good synergy backed by a concrete fact in the state","4: strong synergy backed by multiple concrete facts in the state"]}));
                }
            }
        } else {
            qs.insert("safe_decision".into(),json!({"type":"noul","instructions":"Is the recorded decision safe to repeat given only the supplied evidence?"}));
        }
        let name = m["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(JEV_MODEL);
        let payload = json!({"state":state,"model":name,"questions":qs});
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
                    qs.insert(id.into(),json!({"championSynergy":{"score":0,"confidence":0},"buildSynergy":{"score":0,"confidence":0},"teamFit":{"score":0,"confidence":0},"enemyFit":{"score":0,"confidence":0}}));
                }
            }
        } else {
            qs.insert("safe_decision".into(), json!(0.5));
        }
        let prompt = json!({"state":state,"questions":"Return exact JSON answers, each candidate has four factors score 0..4 and confidence 0..1 based only on the supplied state; no prose. When the state lacks evidence, keep the score low and lower the confidence instead of guessing.","expected":qs});
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
            json!({"summary":if p>=0.5{"结构化证据对该决策重复使用的支持有限，不能据此断言因果"}else{"结构化证据不支持直接重复该决策，不能据此断言因果"},"lessons":[lesson],"caveats":["样本量、混杂因素与未记录信息"],"engine":{"provider":provider,"model":model_name,"latencyMs":started.elapsed().as_millis(),"inputBytes":input_bytes,"confidenceKind":if provider=="jev"{"provider"}else{"unavailable"}}}),
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
            "confidence": evaluated["confidence"],
            "factors": evaluated["factors"],
            "evidence": evaluated["evidence"],
            "reason": evaluated["reason"],
            "risks": evaluated["risks"],
        }));
    }
    ranking.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .partial_cmp(&a["score"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let confidences: Vec<f64> = ranking
        .iter()
        .filter_map(|item| item["confidence"].as_f64())
        .collect();
    let overall = (!confidences.is_empty())
        .then(|| confidences.iter().sum::<f64>() / confidences.len() as f64);
    let summary = format!(
        "四项因素按置信度加权，并与本地规则先验按 70/30 融合{}；分数是相对契合度，不是胜率。",
        overall
            .map(|c| format!("，综合置信度 {c:.2}"))
            .unwrap_or_default()
    );
    Ok(
        json!({"ranking":ranking,"summary":summary,"missingInformation":({ let mut missing=c["knowledge"]["missing"].as_array().cloned().unwrap_or_default(); if c["players"].as_array().unwrap().iter().any(|p| p["augmentsConfirmed"]!=true) { missing.push(json!("部分玩家的已选海克斯未识别，建议仅基于已知信息；缺失不代表没有。")); } missing }),"engine":{"provider":provider,"model":model_name,"latencyMs":started.elapsed().as_millis(),"inputBytes":input_bytes,"confidenceKind":if provider=="jev"{"provider"}else{"unavailable"}}}),
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
    }
    #[test]
    fn answer_schema() {
        let ids = vec!["c1".into()];
        let good = json!({"c1":{"championSynergy":{"score":2.0,"confidence":0.5},"buildSynergy":{"score":3.0,"confidence":1.0},"teamFit":{"score":1.0,"confidence":0.0},"enemyFit":{"score":4.0,"confidence":0.9}}});
        assert!(validate_answers(&good, &ids).is_ok());
        let mut bad = good.clone();
        bad["c1"]["enemyFit"]["score"] = json!(5);
        assert!(validate_answers(&bad, &ids).is_err());
    }
    #[test]
    fn prior_ships_local_rules_and_metadata() {
        let ids = vec!["1068".to_string(), "1388".to_string()];
        let prior = crate::scoring::prior(&ids, Some("Ahri"), &[]);
        assert_eq!(prior["1068"]["rarity"], "gold");
        assert_eq!(prior["1388"]["rarity"], "prismatic");
        assert!(prior["1068"]["localScore"].as_f64().is_some());
        assert!(prior["1068"]["localReason"].as_str().is_some());
    }
    #[test]
    fn evaluate_weights_confidence_and_blends_local_prior() {
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
        // 低置信的 enemyFit 权重被压到 0.25，而不是被当成等权的 0 分。
        assert!((model - 92.3).abs() < 0.6, "model={model}");
        let score = out["score"].as_f64().unwrap();
        assert!((score - (model * 0.7 + 60.0 * 0.3)).abs() < 0.05);
        let risks = out["risks"].as_array().unwrap();
        assert!(risks.iter().any(|r| r.as_str().unwrap().contains("分歧")));
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
    fn enrich_context_adds_prior_and_level() {
        let mut c = ctx();
        c["candidates"] = json!([
            {"id":"1068","name":"循环往复","description":"获得60技能急速。"},
            {"id":"1388","name":"无限循环往复","description":"获得60技能急速，外加每次参与击杀3技能急速。"}
        ]);
        c["liveData"] = json!({"gameData":{"gameTime":123.0},"activePlayer":{"level":7}});
        enrich_context(&mut c);
        assert_eq!(c["candidates"][0]["rarity"], "gold");
        assert!(c["candidates"][0]["localScore"].as_f64().is_some());
        assert_eq!(c["gameData"]["level"], 7.0);
        let state = sanitize_context(&c);
        assert_eq!(state["gameData"]["level"], 7.0);
        assert_eq!(state["candidates"][0]["rarity"], "gold");
        assert_eq!(state["gameData"]["gameTime"], 123.0);
    }
}
