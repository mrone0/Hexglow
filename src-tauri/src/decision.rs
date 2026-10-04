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
        json!({"gameTime":c["gameData"]["gameTime"].as_f64()}),
    );
    out.insert(
        "privacyNotice".into(),
        json!("候选备注、效果说明和知识文档是自由文本，可能包含个人信息；发送前请检查。"),
    );
    Value::Object(out)
}

fn reason(id: &str, a: &Value) -> (f64, String, Vec<String>) {
    let mut vals = Vec::new();
    let mut risks = Vec::new();
    for f in ["championSynergy", "buildSynergy", "teamFit", "enemyFit"] {
        if let Some(x) = a
            .get(f)
            .and_then(|v| v.get("score"))
            .and_then(Value::as_f64)
        {
            vals.push(x);
        }
        if a.get(f)
            .and_then(|v| v.get("confidence"))
            .and_then(Value::as_f64)
            .is_some_and(|x| x < 0.5)
        {
            risks.push(format!("{} 信息不确定；请勿将未知当作没有", f));
        }
    }
    let score =
        ((vals.iter().sum::<f64>() / vals.len().max(1) as f64) * 100.0 / 4.0).clamp(0.0, 100.0);
    let labels: String = if vals.is_empty() {
        "缺少可验证因素".into()
    } else {
        "基于英雄协同、出装协同、队伍适配与敌方适配的结构化评分".into()
    };
    (score, format!("候选 {}：{}。", id, labels), risks)
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
    let state = sanitize_context(c);
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
                    qs.insert(format!("{}__{}",id,f),json!({"type":"score","instructions":format!("Evaluate {} for candidate {} in this game.",f,id),"criteria":["0: no meaningful synergy or evidence","1: weak or mostly negative interaction","2: mixed or uncertain interaction","3: good synergy supported by supplied facts","4: excellent synergy with clear, relevant evidence"]}));
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
        let prompt = json!({"state":state,"questions":"Return exact JSON answers, each candidate has four factors score 0..4 and confidence 0..1; no prose.","expected":qs});
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
            json!({"summary":if p>=0.5{"结构化证据对该决策重复使用的支持有限，不能据此断言因果"}else{"结构化证据不支持直接重复该决策，不能据此断言因果"},"lessons":[lesson],"caveats":["样本量、混杂因素与未记录信息"],"engine":{"provider":provider,"model":model_name,"latencyMs":started.elapsed().as_millis(),"confidenceKind":if provider=="jev"{"provider"}else{"unavailable"}}}),
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
        let (score, risk, risks) = reason(id, &answers[id]);
        ranking.push(json!({"candidateId":id,"score":score,"reason":risk,"risks":risks}));
    }
    ranking.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .partial_cmp(&a["score"].as_f64())
            .unwrap()
    });
    Ok(
        json!({"ranking":ranking,"summary":"按四项结构化因素比较；分数是相对契合度而非胜率。","missingInformation":({ let mut missing=c["knowledge"]["missing"].as_array().cloned().unwrap_or_default(); if c["players"].as_array().unwrap().iter().any(|p| p["augmentsConfirmed"]!=true) { missing.push(json!("部分玩家的已选海克斯未识别，建议仅基于已知信息；缺失不代表没有。")); } missing }),"engine":{"provider":provider,"model":model_name,"latencyMs":started.elapsed().as_millis(),"confidenceKind":if provider=="jev"{"provider"}else{"unavailable"}}}),
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
        body["models"].as_array().or_else(|| body["data"].as_array()).ok_or_else(|| {
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
        let mut c=ctx(); c["players"][0]["name"]=json!("PRIVATE_PLAYER");c["notes"]=json!("打法说明");c["outcome"]=json!("结算观察");
        c["knowledge"]=json!({"documents":[{"path":"champions/a.md","title":"A","content":"关键机制","hash":"h"}],"warnings":["版本未知"],"missing":[]});
        c["history"]=json!([{ "ownChampion":"A","ownAugments":["泰坦的坚决"],"chosen":"One","review":{"summary":"历史观察","lessons":["条件"],"caveats":["反例"]},"result":{"status":"win","gameId":"SECRET_GAME"}}]);
        c["decisions"]=json!([{ "chosenId":"c1","context":{"players":c["players"],"ownPlayerId":"abc","candidates":c["candidates"]},"result":{"summary":"先前比较","ranking":[]}}]);
        let v=sanitize_context(&c);
        assert_eq!(v["knowledge"]["documents"][0]["content"],"关键机制");
        assert_eq!(v["history"][0]["review"]["summary"],"历史观察");
        assert_eq!(v["history"][0]["ownAugments"][0],"泰坦的坚决");
        assert_eq!(v["history"][0]["chosen"],"One");
        assert_eq!(v["decisions"][0]["context"]["players"]["p1"]["champion"],"A");
        assert_eq!(v["notes"],"打法说明");assert_eq!(v["outcome"],"结算观察");
        assert!(!v.to_string().contains("PRIVATE_PLAYER"));assert!(!v.to_string().contains("SECRET_GAME"));
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
        assert_eq!(sanitize_context(&x)["players"]["p1"]["augmentsConfirmed"], false);
        assert!(sanitize_context(&x)["players"]["p1"]["augmentDataStatus"].as_str().unwrap().contains("unknown"));
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
}
