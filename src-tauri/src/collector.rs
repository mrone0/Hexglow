//! Read-only, bounded local Riot lifecycle collection. No game automation.
use chrono::Utc;
use reqwest::{redirect::Policy, Client};
use serde_json::{json, Map as JsonObject, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const MAX_BODY: usize = 4 * 1024 * 1024;
const LOG_LIMIT: u64 = 512 * 1024; // Each of two files; strict 1 MiB total.
const LOG_ENTRY_LIMIT: usize = 2 * 1024; // Serialized JSON plus newline.
const LOG_READ_LIMIT: usize = 64 * 1024; // Combined tail bytes per query.
const LOG_RATE_LIMIT: usize = 6;
const LOG_RATE_WINDOW: Duration = Duration::from_secs(60);
const DISCOVERY_IDLE_TTL: Duration = Duration::from_secs(15);
const DISCOVERY_SUCCESS_TTL: Duration = Duration::from_secs(30);
const POLL_BUDGET: Duration = Duration::from_secs(11);

// Deliberately no Debug/Serialize: these must never enter diagnostics or IPC.
#[derive(Clone)]
struct Credentials {
    port: u16,
    password: String,
}
#[derive(Default)]
struct State {
    discovery: Option<(Instant, Option<Credentials>)>,
    transition: Option<(String, String)>,
    errors: BTreeSet<String>,
    log_times: VecDeque<Instant>,
}
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| Mutex::new(State::default()))
}
fn now() -> String {
    Utc::now().to_rfc3339()
}

fn valid_secret(s: &str) -> bool {
    !s.is_empty() && s.len() <= 4096 && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}
fn parse_lockfile(text: &str) -> Result<Credentials, &'static str> {
    let fields: Vec<_> = text.trim_end_matches(['\r', '\n']).split(':').collect();
    if fields.len() != 5
        || fields[0] != "LeagueClient"
        || fields[4] != "https"
        || fields[1].parse::<u32>().ok().filter(|id| *id > 0).is_none()
        || !valid_secret(fields[3])
    {
        return Err("Invalid League lockfile format");
    }
    let port = fields[2]
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or("Invalid League lockfile port")?;
    Ok(Credentials {
        port,
        password: fields[3].into(),
    })
}

// Riot switches are simple quoted/unquoted tokens, not arbitrary shell input.
#[cfg(any(target_os = "windows", test))]
fn command_tokens(line: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in line.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if quoted {
        return None;
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Some(tokens)
}
#[cfg(any(target_os = "windows", test))]
fn parse_commandline(line: &str) -> Option<Credentials> {
    let tokens = command_tokens(line)?;
    let switch = |name: &str| -> Option<String> {
        let prefix = format!("{name}=");
        let mut values = Vec::new();
        for (i, token) in tokens.iter().enumerate() {
            if let Some(value) = token.strip_prefix(&prefix) {
                values.push(value.to_owned());
            } else if token == name {
                values.push(tokens.get(i + 1)?.clone());
            }
        }
        if values.len() == 1 {
            values.pop()
        } else {
            None
        }
    };
    let port = switch("--app-port")?
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)?;
    let password = switch("--remoting-auth-token")?;
    if !valid_secret(&password) {
        return None;
    }
    Some(Credentials { port, password })
}

#[cfg(target_os = "windows")]
fn discover_windows() -> Option<Credentials> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    // Never pass this output to errors, tracing, or the UI. The script is constant.
    let mut child = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name = 'LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"])
        .creation_flags(0x08000000)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().ok()?;
    let output = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = output.take(128 * 1024).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let started = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() < Duration::from_millis(1500) => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    // Do not join a potentially inherited pipe on failure: keep discovery bounded.
    if !success {
        return None;
    }
    let bytes = receiver.recv_timeout(Duration::from_millis(100)).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    text.lines().find_map(parse_commandline)
}
#[cfg(not(target_os = "windows"))]
fn discover_windows() -> Option<Credentials> {
    None
}

fn discovery_ttl(found: bool) -> Duration {
    if found {
        DISCOVERY_SUCCESS_TTL
    } else {
        DISCOVERY_IDLE_TTL
    }
}

fn discover(manual: Option<&str>) -> (Option<Credentials>, Vec<String>) {
    let mut warnings = Vec::new();
    // Development only: lets a mock Live Client API stand in for the game during local testing.
    #[cfg(debug_assertions)]
    let env_lockfile = std::env::var("HEXGLOW_LOCKFILE").ok();
    #[cfg(debug_assertions)]
    let manual = manual
        .filter(|s| !s.is_empty())
        .or_else(|| env_lockfile.as_deref().filter(|s| !s.is_empty()));
    if cfg!(target_os = "windows") {
        let cached = state()
            .lock()
            .ok()
            .and_then(|s| s.discovery.clone())
            .filter(|(at, credentials)| at.elapsed() < discovery_ttl(credentials.is_some()));
        let found = match cached {
            Some((_, credentials)) => credentials,
            None => {
                let credentials = discover_windows();
                if let Ok(mut s) = state().lock() {
                    s.discovery = Some((Instant::now(), credentials.clone()));
                }
                credentials
            }
        };
        if found.is_some() {
            return (found, warnings);
        }
    }
    if let Some(path) = manual.filter(|s| !s.is_empty()) {
        if !Path::new(path).is_absolute() {
            warnings.push("Manual lockfile path must be absolute".into());
        } else {
            let read = fs::metadata(path).and_then(|metadata| {
                if !metadata.is_file() || metadata.len() > 8192 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "not a bounded regular file",
                    ));
                }
                let file = fs::File::open(path)?;
                let mut text = String::new();
                file.take(8193).read_to_string(&mut text)?;
                Ok(text)
            });
            match read {
                Ok(text) if text.len() <= 8192 => match parse_lockfile(&text) {
                    Ok(credentials) => return (Some(credentials), warnings),
                    Err(message) => warnings.push(message.into()),
                },
                _ => warnings.push("Manual lockfile could not be read safely".into()),
            }
        }
    }
    (None, warnings)
}

fn riot_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .danger_accept_invalid_certs(true)
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "Local Riot API client initialization failed".into())
}
async fn get_json(
    client: &Client,
    credentials: Option<&Credentials>,
    path: &str,
    deadline: Instant,
) -> Result<Value, &'static str> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("poll-budget-exhausted");
    }
    let port = credentials.map_or(2999, |c| c.port);
    // All callers supply compile-time endpoint paths; no host/URL from external data.
    let mut request = client
        .get(format!("https://127.0.0.1:{port}{path}"))
        .timeout(remaining.min(Duration::from_secs(2)));
    if let Some(c) = credentials {
        request = request.basic_auth("riot", Some(&c.password));
    }
    let mut response = request.send().await.map_err(|_| "unavailable")?;
    if !response.status().is_success() {
        return Err("http-error");
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err("oversized-response");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "read-error")? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err("oversized-response");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid-json")
}
fn id(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => n.as_u64().filter(|n| *n > 0).map(|n| n.to_string()),
        Value::String(s) => s
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .map(|n| n.to_string()),
        _ => None,
    }
}
fn game_id(v: &Value) -> Option<String> {
    id(&v["gameId"]).or_else(|| id(&v["gameData"]["gameId"]))
}
fn phase_name(v: &Value) -> &'static str {
    match v.as_str().unwrap_or("") {
        "None" => "None",
        "Lobby" => "Lobby",
        "Matchmaking" => "Matchmaking",
        "ReadyCheck" => "ReadyCheck",
        "ChampSelect" => "ChampSelect",
        "GameStart" => "GameStart",
        "InProgress" => "InProgress",
        "WaitingForStats" => "WaitingForStats",
        "PreEndOfGame" => "PreEndOfGame",
        "EndOfGame" => "EndOfGame",
        "Reconnect" => "Reconnect",
        _ => "Unknown",
    }
}
fn end_phase(phase: &str) -> bool {
    matches!(phase, "WaitingForStats" | "PreEndOfGame" | "EndOfGame")
}
// A successful session request does not establish a usable lifecycle phase.
// Preserve Live access on phase failure, but never borrow that session's identity.
fn degrade_unknown_phase(
    phase: &str,
    lcu_connected: &mut bool,
    session: &mut Value,
    eog: &mut Value,
    warnings: &mut Vec<String>,
) {
    if phase == "Unknown" && *lcu_connected {
        *session = Value::Null;
        *eog = Value::Null;
        *lcu_connected = false;
        warnings.push(
            "LCU phase unknown: session association withheld; Live API remains independent".into(),
        );
    }
}
// Reconcile independently fetched endpoints before either IPC or outcome inference.
// A live response without an ID is usable beside LCU only during coherent game phases.
fn correlate_payloads(
    phase: &str,
    lcu_connected: bool,
    session: &Value,
    live: &mut Value,
    eog: &mut Value,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let session_id = game_id(session);
    let live_id = game_id(live);
    let coherent_phase = matches!(phase, "InProgress" | "Reconnect") || end_phase(phase);
    let ids_conflict = matches!((&session_id, &live_id), (Some(a), Some(b)) if a != b);
    if !live.is_null() && (ids_conflict || (lcu_connected && !coherent_phase)) {
        *live = Value::Null;
        warnings.push("Live data withheld: lifecycle or game ID does not match LCU".into());
    }
    let game = session_id
        .or_else(|| game_id(live))
        .or_else(|| game_id(eog));
    if !eog.is_null() {
        let eog_id = game_id(eog);
        if eog_id.is_none() || eog_id != game {
            *eog = Value::Null;
            warnings.push("End-of-game data withheld: missing or mismatched game ID".into());
        }
    }
    game
}
fn unknown(at: &str) -> Value {
    json!({"status":"unknown","source":"unknown","observedAt":at,"evidence":{}})
}
fn result_value(
    status: &str,
    source: &str,
    game: Option<&str>,
    at: &str,
    evidence: Value,
) -> Value {
    let mut result = json!({"status":status,"source":source,"observedAt":at,"evidence":evidence});
    if let Some(game) = game {
        result["gameId"] = json!(game);
    }
    result
}
fn outcome(live: &Value, session: &Value, eog: &Value, summoner: &Value, at: &str) -> Value {
    let session_id = game_id(session);
    let live_id = game_id(live);
    let live_matches = !matches!((&session_id, &live_id), (Some(a), Some(b)) if a != b);
    let active = &live["activePlayer"];
    let identity = |p: &Value| -> Option<String> {
        if let Some(riot) = p["riotId"].as_str().filter(|s| !s.is_empty()) {
            return Some(format!("riot:{riot}"));
        }
        if let (Some(name), Some(tag)) = (p["riotIdGameName"].as_str(), p["riotIdTagLine"].as_str())
        {
            if !name.is_empty() && !tag.is_empty() {
                return Some(format!("riot:{name}#{tag}"));
            }
        }
        p["summonerName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| format!("summoner:{s}"))
    };
    let own = identity(active);
    let matched: Vec<_> = live["allPlayers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| own.is_some() && identity(p) == own)
        .collect();
    if live_matches && matched.len() == 1 {
        let ends: Vec<_> = live["events"]["Events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|event| event["EventName"] == "GameEnd")
            .collect();
        if let Some(event) = ends.last() {
            let status = match event["Result"].as_str() {
                Some("Win") => Some("win"),
                Some("Lose") => Some("loss"),
                _ => None,
            };
            if let Some(status) = status {
                // GameEnd.Result is the active player's perspective, never a team ID.
                return result_value(
                    status,
                    "live-game-end",
                    live_id.as_deref(),
                    at,
                    json!({"event":"GameEnd","result":event["Result"],"activePlayerMatched":true}),
                );
            }
        }
    }
    // An EOG block without its own ID is never correlated, even if a session exists.
    let Some(eog_id) = game_id(eog) else {
        return unknown(at);
    };
    if session_id.as_ref().is_some_and(|known| known != &eog_id) {
        return unknown(at);
    }
    let Some(own_id) = id(&summoner["summonerId"]) else {
        return unknown(at);
    };
    let mut matches = Vec::new();
    for team in eog["teams"].as_array().into_iter().flatten() {
        for player in team["players"].as_array().into_iter().flatten() {
            if id(&player["summonerId"]).as_ref() == Some(&own_id) {
                matches.push(team);
            }
        }
    }
    if matches.len() != 1 {
        return unknown(at);
    }
    let team = matches[0];
    let win = team["isWinningTeam"]
        .as_bool()
        .or_else(|| team["win"].as_bool());
    match win {
        Some(win) => result_value(
            if win { "win" } else { "loss" },
            "lcu-eog",
            Some(&eog_id),
            at,
            json!({"currentSummonerMatched":true,"eogGameIdPresent":true,"sessionGameIdMatched":session_id.is_some(),"isWinningTeam":win}),
        ),
        None => unknown(at),
    }
}

// 身份之外还要带上英雄与阵营：被遮蔽的玩家在实时接口里拿不到可用的身份键，
// 赛后只能靠「英雄 + 阵营」这组唯一组合把海克斯认回去。
#[derive(Clone, Default)]
struct Whereabouts {
    identity: Option<String>,
    champion: Option<String>,
    team: Option<String>,
}

// 一个身份名下的赛后证据：海克斯集合 + 可用于兜底匹配的归属信息。
#[derive(Default)]
struct PlayerEvidence {
    augments: BTreeSet<String>,
    champion: Option<String>,
    team: Option<String>,
}

// 赛后补录：EOG / 比赛历史的字段结构由客户端版本决定，先递归扫描含 augment 的字段
// 并记录路径，再按记录自身（或父记录）的身份键把海克斯归到玩家名下。
fn postgame_augments(eog: &Value, history: &Value, game: Option<&str>) -> Value {
    let mut fields = BTreeSet::new();
    let mut players: BTreeMap<String, PlayerEvidence> = BTreeMap::new();
    scan_augments(eog, "", Whereabouts::default(), &mut fields, &mut players);
    // 比赛历史可能混着旧局：没有可核对的对局 ID 就不采信，避免张冠李戴。
    if let Some(game) = game {
        let mut matches = Vec::new();
        collect_history_games(history, game, &mut matches);
        for entry in matches {
            scan_augments(entry, "", Whereabouts::default(), &mut fields, &mut players);
        }
    }
    let identified: Vec<(&String, &PlayerEvidence)> = players
        .iter()
        .filter(|(key, _)| key.as_str() != "unknown")
        .collect();
    if identified.is_empty() {
        return Value::Null;
    }
    json!({
        "players":identified.iter()
            .map(|(key, entry)| {
                let mut item = json!({"key":key,"augments":&entry.augments});
                if let Some(champion) = &entry.champion {
                    item["champion"] = Value::String(champion.clone());
                }
                if let Some(team) = &entry.team {
                    item["team"] = Value::String(team.clone());
                }
                item
            })
            .collect::<Vec<_>>(),
        "fields":fields,
    })
}

// 旧档案的本地补录：把保存下来的赛后证据按当前扫描规则重新归属，不联网、不改库，
// 由前端决定是否写回。没有存下证据时返回 null。
#[tauri::command]
pub fn postgame_entries(session: Value) -> Value {
    match session.get("endOfGame") {
        Some(eog) if !eog.is_null() => postgame_augments(eog, &Value::Null, None),
        _ => Value::Null,
    }
}

// 两份赛后证据并集：同一玩家取海克斯更多的一份（并补齐缺失的英雄/阵营），字段路径取并集。
fn merge_postgame_entries(left: &Value, right: &Value) -> Value {
    let mut players: BTreeMap<String, Value> = BTreeMap::new();
    let mut fields: BTreeSet<String> = BTreeSet::new();
    for source in [left, right] {
        let Some(map) = source.as_object() else {
            continue;
        };
        if let Some(items) = map.get("players").and_then(Value::as_array) {
            for item in items {
                let Some(key) = item.get("key").and_then(Value::as_str) else {
                    continue;
                };
                match players.get_mut(key) {
                    None => {
                        players.insert(key.to_string(), item.clone());
                    }
                    Some(existing) => {
                        let have = existing["augments"].as_array().map(Vec::len).unwrap_or(0);
                        let next = item["augments"].as_array().map(Vec::len).unwrap_or(0);
                        if next > have {
                            *existing = item.clone();
                        } else {
                            for field in ["champion", "team"] {
                                if existing.get(field).map_or(true, Value::is_null) {
                                    if let Some(value) = item.get(field) {
                                        existing[field] = value.clone();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(items) = map.get("fields").and_then(Value::as_array) {
            for item in items {
                if let Some(text) = item.as_str() {
                    fields.insert(text.to_string());
                }
            }
        }
    }
    if players.is_empty() {
        return Value::Null;
    }
    json!({
        "players": players.into_values().collect::<Vec<_>>(),
        "fields": fields,
    })
}

// 打开档案时现场补录：客户端在线就重新拉 EOG 与最近比赛历史（按本局 gameId 归属），
// 客户端不可用或已超窗时回落到档案里存下的 EOG 证据。返回 {players, fields} 或 null。
#[tauri::command]
pub async fn postgame_rescan(
    app: AppHandle,
    session: Value,
    lockfile_path: Option<String>,
) -> Value {
    let game = session
        .get("matchId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let stored = session
        .get("endOfGame")
        .cloned()
        .filter(|value| !value.is_null());
    let mut merged = stored
        .as_ref()
        .map(|eog| postgame_augments(eog, &Value::Null, game.as_deref()))
        .unwrap_or(Value::Null);
    let deadline = Instant::now() + Duration::from_secs(6);
    let credentials =
        tauri::async_runtime::spawn_blocking(move || discover(lockfile_path.as_deref()).0)
            .await
            .unwrap_or(None);
    if let (Some(credentials), Ok(client)) = (credentials.as_ref(), riot_client()) {
        let eog = get_json(
            &client,
            Some(credentials),
            "/lol-end-of-game/v1/eog-stats-block",
            deadline,
        )
        .await
        .unwrap_or(Value::Null);
        let history = get_json(
            &client,
            Some(credentials),
            "/lol-match-history/v1/products/lol/current-summoner/matches?begin=0&count=10",
            deadline,
        )
        .await
        .unwrap_or(Value::Null);
        merged =
            merge_postgame_entries(&merged, &postgame_augments(&eog, &history, game.as_deref()));
        // 最近几局里没有本局时，按 gameId 直接问这一局（只接受纯数字，避免拼进 URL）。
        let direct = game
            .as_deref()
            .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()));
        if direct.is_some()
            && merged.as_object().map_or(true, |map| {
                map.get("players")
                    .and_then(Value::as_array)
                    .map_or(true, Vec::is_empty)
            })
        {
            if let Ok(value) = get_json(
                &client,
                Some(credentials),
                &format!("/lol-match-history/v1/games/{}", direct.unwrap()),
                deadline,
            )
            .await
            {
                merged = merge_postgame_entries(
                    &merged,
                    &postgame_augments(&Value::Null, &value, game.as_deref()),
                );
            }
        }
    }
    if merged.as_object().map_or(true, |map| map.is_empty()) {
        return Value::Null;
    }
    log_postgame_scan(&app, &merged);
    merged
}

// 旧 v4 结构是 {games:{games:[{gameId,participants:[…]}]}}；按 gameId 只认这一局。
fn collect_history_games<'a>(node: &'a Value, game: &str, out: &mut Vec<&'a Value>) {
    match node {
        Value::Object(map) => {
            for (key, value) in map {
                if key.eq_ignore_ascii_case("games") {
                    if let Value::Array(items) = value {
                        for item in items {
                            if game_id(item).as_deref() == Some(game) {
                                out.push(item);
                            }
                        }
                    }
                }
                collect_history_games(value, game, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_history_games(item, game, out);
            }
        }
        _ => {}
    }
}

// EOG 自己能不能给出挂到人身上的海克斯；拿不到就去比赛历史补。
fn has_identified_augments(eog: &Value) -> bool {
    !postgame_augments(eog, &Value::Null, None).is_null()
}

fn scan_augments(
    node: &Value,
    path: &str,
    parent: Whereabouts,
    fields: &mut BTreeSet<String>,
    players: &mut BTreeMap<String, PlayerEvidence>,
) {
    match node {
        Value::Object(map) => {
            let champion = champion_of(map).or(parent.champion.clone());
            let team = team_of(map).or(parent.team.clone());
            let identity = identity_of(map)
                .or(parent.identity.clone())
                // 身份被遮蔽时用记录自身的路径当临时键：同一条记录的嵌套字段仍归到
                // 一起，不同玩家不会互相串号，前端再按「英雄 + 阵营」唯一匹配认回去。
                .or_else(|| champion.as_ref().map(|_| format!("path:{path}")));
            let here = Whereabouts {
                identity: identity.clone(),
                champion: champion.clone(),
                team: team.clone(),
            };
            for (key, value) in map {
                if !key.to_ascii_lowercase().contains("augment") {
                    continue;
                }
                let mut found = Vec::new();
                collect_scalar_leaves(value, &mut found);
                if found.is_empty() {
                    continue;
                }
                fields.insert(format!("{path}/{key}"));
                let who = identity.clone().unwrap_or_else(|| "unknown".to_string());
                let slot = players.entry(who).or_default();
                slot.augments.extend(found);
                if slot.champion.is_none() {
                    slot.champion = champion.clone();
                }
                if slot.team.is_none() {
                    slot.team = team.clone();
                }
            }
            for (key, value) in map {
                scan_augments(
                    value,
                    &format!("{path}/{key}"),
                    here.clone(),
                    fields,
                    players,
                );
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                scan_augments(
                    item,
                    &format!("{path}[{index}]"),
                    parent.clone(),
                    fields,
                    players,
                );
            }
        }
        _ => {}
    }
}

// 把数据挂到哪个人名下：优先记录自身的身份键，嵌套字段沿用父记录的身份。
fn identity_of(map: &JsonObject<String, Value>) -> Option<String> {
    let text = |key: &str| -> Option<String> {
        map.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            // 遮蔽标记（"#"、"***"）不是身份：认作没有身份，免得多个玩家串到同一个键。
            .filter(|value| value.chars().any(|c| c.is_alphanumeric()))
            .map(str::to_string)
    };
    if let Some(name) = text("summonerName") {
        return Some(name.to_ascii_lowercase());
    }
    if let Some(riot) = text("riotId") {
        return Some(riot.to_ascii_lowercase());
    }
    let game = text("riotIdGameName").or_else(|| text("gameName"));
    let tag = text("riotIdTagLine").or_else(|| text("tagLine"));
    match (game, tag) {
        (Some(game), Some(tag)) => Some(format!("{game}#{tag}").to_ascii_lowercase()),
        (Some(game), None) => Some(game.to_ascii_lowercase()),
        (None, _) => text("playerName").map(|name| name.to_ascii_lowercase()),
    }
}

// 英雄名：EOG / 历史给的是 championName，实时接口同名；认不出的数字 id 不猜。
fn champion_of(map: &JsonObject<String, Value>) -> Option<String> {
    ["championName", "champion"]
        .into_iter()
        .find_map(|key| map.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

// 阵营：EOG 用 100/200，实时接口用 ORDER/CHAOS；两种写法都归一到 ORDER/CHAOS。
fn team_of(map: &JsonObject<String, Value>) -> Option<String> {
    match map.get("teamId") {
        Some(Value::Number(id)) => match id.as_i64() {
            Some(100) => Some("ORDER".into()),
            Some(200) => Some("CHAOS".into()),
            _ => None,
        },
        _ => ["teamId", "team", "teamName"]
            .into_iter()
            .find_map(|key| map.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .and_then(|value| match value.to_ascii_uppercase().as_str() {
                "ORDER" | "100" => Some("ORDER".into()),
                "CHAOS" | "200" => Some("CHAOS".into()),
                _ => None,
            }),
    }
}

// 数字只收认得出的 id，文本保留客户端原话；都不编造名称。
fn collect_scalar_leaves(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            if let Some(label) = crate::scoring::augment_label(text) {
                if plausible_augment(&label) {
                    out.push(label);
                }
            }
        }
        Value::Number(number) => {
            if let Some(label) = crate::scoring::augment_label(&number.to_string()) {
                out.push(label);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_scalar_leaves(item, out);
            }
        }
        Value::Object(map) => {
            for value in map.values() {
                collect_scalar_leaves(value, out);
            }
        }
        _ => {}
    }
}

// 拒绝明显不是名称的词（统计字段、枚举值），避免把元数据当海克斯。
fn plausible_augment(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "silver"
            | "gold"
            | "prismatic"
            | "rarity"
            | "legendary"
            | "none"
            | "null"
            | "true"
            | "false"
            | "unknown"
            | "augment"
            | "augments"
            | "inventory"
    )
}

// 真实字段名未知：把扫描到的路径写进日志，拿到真实对局样本后照这条日志对结构。
fn log_postgame_scan(app: &AppHandle, post: &Value) {
    let Ok((_, logs)) = directories(app) else {
        return;
    };
    let Ok(mut state) = state().lock() else {
        return;
    };
    if !log_slot(&mut state, Instant::now()) {
        return;
    }
    let fields = post["fields"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .take(8)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let players = post["players"].as_array().map(Vec::len).unwrap_or(0);
    let _ = append_log(
        &logs,
        "info",
        "postgame-augment-scan",
        &format!("players={players}; fields={fields}"),
    );
}

// Raw API objects remain useful for records, but auth-like fields and known secrets
// never cross IPC. Logs never receive these objects at all.
fn sanitize(value: &mut Value, secret: Option<&str>) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| {
                let key = key.to_ascii_lowercase().replace(['-', '_'], "");
                ![
                    "password",
                    "token",
                    "authorization",
                    "credential",
                    "commandline",
                    "lockfile",
                ]
                .iter()
                .any(|s| key.contains(s))
            });
            for value in map.values_mut() {
                sanitize(value, secret);
            }
        }
        Value::Array(values) => {
            for value in values {
                sanitize(value, secret);
            }
        }
        Value::String(text) => {
            if let Some(secret) = secret.filter(|s| !s.is_empty()) {
                if text.contains(secret) {
                    *text = text.replace(secret, "[redacted]");
                }
            }
        }
        _ => {}
    }
}
pub(crate) fn directories(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application data directory unavailable")?;
    let logs = data.join("logs");
    fs::create_dir_all(&logs).map_err(|_| "Diagnostics directory unavailable")?;
    Ok((data, logs))
}
fn bounded_text(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn log_entry(level: &str, event: &str, message: &str) -> Vec<u8> {
    // Bound allocations before serialization, including JSON's worst-case escaping.
    let level = bounded_text(level, 32);
    let event = bounded_text(event, 64);
    let mut message = bounded_text(message, LOG_ENTRY_LIMIT);
    let at = now();
    loop {
        let mut bytes =
            serde_json::to_vec(&json!({"at":at,"level":level,"event":event,"message":message}))
                .expect("string-only log entry serializes");
        if bytes.len() < LOG_ENTRY_LIMIT {
            bytes.push(b'\n');
            return bytes;
        }
        // Removing this many UTF-8 bytes removes at least as many encoded bytes.
        let excess = bytes.len() + 1 - LOG_ENTRY_LIMIT;
        message = bounded_text(message, message.len().saturating_sub(excess));
    }
}

fn cap_existing_log(path: &Path) -> std::io::Result<u64> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.len() > LOG_LIMIT => {
            // Legacy oversized files are discarded, never copied into a third file.
            OpenOptions::new().write(true).open(path)?.set_len(0)?;
            Ok(0)
        }
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

// Production callers hold STATE across rotation/write/read (single-process logger).
pub(crate) fn append_log(
    logs: &Path,
    level: &str,
    event: &str,
    message: &str,
) -> std::io::Result<()> {
    let bytes = log_entry(level, event, message);
    let path = logs.join("collector.jsonl");
    let previous = logs.join("collector.previous.jsonl");
    cap_existing_log(&previous)?;
    let current_size = cap_existing_log(&path)?;
    if current_size + bytes.len() as u64 > LOG_LIMIT {
        match fs::remove_file(&previous) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(&path, previous)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(&bytes)
}

fn log_slot(state: &mut State, at: Instant) -> bool {
    while state
        .log_times
        .front()
        .is_some_and(|time| at.duration_since(*time) >= LOG_RATE_WINDOW)
    {
        state.log_times.pop_front();
    }
    if state.log_times.len() == LOG_RATE_LIMIT {
        return false;
    }
    // Count attempted writes too: a broken filesystem must not cause a retry storm.
    state.log_times.push_back(at);
    true
}

fn expected_idle_warning(connection: &str, warning: &str) -> bool {
    warning == "League client was not discovered"
        || (connection != "lcu-and-live" && warning == "Live API: unavailable")
        || (connection == "disconnected"
            && matches!(
                warning,
                "LCU phase: unavailable" | "LCU session: unavailable"
            ))
}

fn log_poll_at(
    logs: &Path,
    state: &mut State,
    connection: &str,
    phase: &str,
    warnings: &[String],
    at: Instant,
) -> std::io::Result<()> {
    let transition = (connection.to_owned(), phase.to_owned());
    let changed = state.transition.as_ref() != Some(&transition);
    // Remember observed state even if throttled or disk writes fail; no backlog.
    state.transition = Some(transition);
    let errors: BTreeSet<_> = warnings.iter().cloned().collect();
    let previous_errors = std::mem::replace(&mut state.errors, errors);
    let new_errors: Vec<_> = state.errors.difference(&previous_errors).cloned().collect();
    let mut result = Ok(());
    // Lifecycle transitions get first claim on the remaining global budget.
    if changed && log_slot(state, at) {
        result = append_log(
            logs,
            "info",
            "lifecycle-transition",
            &format!("connection={connection}; phase={phase}"),
        );
    }
    for error in new_errors {
        if !expected_idle_warning(connection, &error) && log_slot(state, at) {
            let written = append_log(logs, "warn", "collector-error", &error);
            if result.is_ok() {
                result = written;
            }
        }
    }
    result
}

fn log_poll(
    app: &AppHandle,
    connection: &str,
    phase: &str,
    warnings: &[String],
) -> Result<(), String> {
    let (_, logs) = directories(app)?;
    let mut state = state().lock().map_err(|_| "Collector state unavailable")?;
    log_poll_at(
        &logs,
        &mut state,
        connection,
        phase,
        warnings,
        Instant::now(),
    )
    .map_err(|_| "Diagnostics write failed".into())
}

#[tauri::command]
pub async fn collector_snapshot(
    app: AppHandle,
    lockfile_path: Option<String>,
) -> Result<Value, String> {
    let deadline = Instant::now() + POLL_BUDGET;
    let (credentials, mut warnings) =
        tauri::async_runtime::spawn_blocking(move || discover(lockfile_path.as_deref()))
            .await
            .map_err(|_| "Local discovery task failed")?;
    let client = riot_client()?;
    let mut live = Value::Null;
    let mut session = Value::Null;
    let mut eog = Value::Null;
    let mut history = Value::Null;
    let mut summoner = Value::Null;
    let mut phase = "Unknown";
    let mut lcu_connected = false;
    // Always try Live API, including when HexLens starts during an existing game.
    match get_json(&client, None, "/liveclientdata/allgamedata", deadline).await {
        Ok(value) => live = value,
        Err(error) => warnings.push(format!("Live API: {error}")),
    }
    if let Some(c) = credentials.as_ref() {
        match get_json(
            &client,
            Some(c),
            "/lol-gameflow/v1/gameflow-phase",
            deadline,
        )
        .await
        {
            Ok(value) => {
                phase = phase_name(&value);
                lcu_connected = true;
            }
            Err(error) => {
                warnings.push(format!("LCU phase: {error}"));
                if let Ok(mut state) = state().lock() {
                    // A failed endpoint must not spawn PowerShell on every HTTP poll.
                    // Keep discovery's original timestamp; retry after the idle TTL.
                    if let Some((_, cached)) = state.discovery.as_mut() {
                        *cached = None;
                    }
                }
            }
        }
        match get_json(&client, Some(c), "/lol-gameflow/v1/session", deadline).await {
            Ok(value) => {
                session = value;
                lcu_connected = true;
            }
            Err(error) => warnings.push(format!("LCU session: {error}")),
        }
        // 赛后窗口可能在两次轮询之间滑过：进入赛后大厅也继续补录，
        // 换局后由 gameId 关联把关，绝不会把旧局的海克斯挂到新局。
        let capture_phase =
            end_phase(phase) || matches!(phase, "Lobby" | "None" | "Matchmaking" | "ReadyCheck");
        let quiet = !end_phase(phase);
        if capture_phase {
            match get_json(
                &client,
                Some(c),
                "/lol-end-of-game/v1/eog-stats-block",
                deadline,
            )
            .await
            {
                Ok(value) => eog = value,
                // 客户端不在赛后窗口时 404 属正常，不算错误。
                Err(_) if quiet => {}
                Err(error) => warnings.push(format!("LCU end-of-game: {error}")),
            }
            if !eog.is_null() {
                match get_json(
                    &client,
                    Some(c),
                    "/lol-summoner/v1/current-summoner",
                    deadline,
                )
                .await
                {
                    Ok(value) => summoner = value,
                    Err(_) if quiet => {}
                    Err(error) => warnings.push(format!("LCU current summoner: {error}")),
                }
            }
            // 赛后补录：EOG 里读不到挂到人身上的海克斯时，改从客户端比赛历史取本局的。
            if (end_phase(phase) || !eog.is_null()) && !has_identified_augments(&eog) {
                match get_json(
                    &client,
                    Some(c),
                    "/lol-match-history/v1/products/lol/current-summoner/matches?begin=0&count=5",
                    deadline,
                )
                .await
                {
                    Ok(value) => history = value,
                    Err(_) if quiet => {}
                    Err(error) => warnings.push(format!("LCU match history: {error}")),
                }
            }
        }
    } else if !cfg!(target_os = "windows") {
        warnings.push(
            "LCU auto-discovery requires Windows; an explicit lockfile enables developer testing"
                .into(),
        );
    } else {
        warnings.push("League client was not discovered".into());
    }
    degrade_unknown_phase(
        phase,
        &mut lcu_connected,
        &mut session,
        &mut eog,
        &mut warnings,
    );
    let game = correlate_payloads(
        phase,
        lcu_connected,
        &session,
        &mut live,
        &mut eog,
        &mut warnings,
    );
    if phase == "Unknown" && !live.is_null() {
        phase = "InProgress";
    }
    let connection = match (lcu_connected, !live.is_null()) {
        (true, true) => "lcu-and-live",
        (true, false) => "lcu",
        (false, true) => "live-only",
        (false, false) => "disconnected",
    };
    let observed_at = now();
    let result = outcome(&live, &session, &eog, &summoner, &observed_at);
    // 结束阶段自动补上一局：把 EOG / 比赛历史读到的海克斯按身份归到玩家名下。
    let post_game = postgame_augments(&eog, &history, game.as_deref());
    if !post_game.is_null() {
        log_postgame_scan(&app, &post_game);
    }
    if let Err(message) = log_poll(&app, connection, phase, &warnings) {
        warnings.push(message);
    }
    let mut snapshot = json!({
        "platformSupported":cfg!(target_os = "windows"),"connection":connection,"phase":phase,
        "gameId":game,"liveData":live,"lcuSession":session,"endOfGame":eog,
        "postGameAugments":post_game,
        "result":result,"observedAt":observed_at,"warnings":warnings
    });
    sanitize(
        &mut snapshot,
        credentials.as_ref().map(|c| c.password.as_str()),
    );
    Ok(snapshot)
}

fn read_log_tail(logs: &Path) -> std::io::Result<VecDeque<Value>> {
    let mut entries = VecDeque::with_capacity(100);
    let mut remaining = LOG_READ_LIMIT;
    // Spend the shared read budget on newest bytes first, not the previous file.
    for name in ["collector.jsonl", "collector.previous.jsonl"] {
        if remaining == 0 || entries.len() == 100 {
            break;
        }
        let mut file = match fs::File::open(logs.join(name)) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let len = file.metadata()?.len();
        let count = len.min(remaining as u64) as usize;
        let start = len - count as u64;
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::with_capacity(count);
        file.take(count as u64).read_to_end(&mut bytes)?;
        remaining -= count;
        // Without reading an extra byte, conservatively discard the first partial line.
        let first = if start > 0 {
            bytes
                .iter()
                .position(|b| *b == b'\n')
                .map_or(bytes.len(), |i| i + 1)
        } else {
            0
        };
        let last = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        if first >= last {
            continue;
        }
        for line in bytes[first..last].split(|b| *b == b'\n').rev() {
            if line.is_empty() || line.len() >= LOG_ENTRY_LIMIT {
                continue;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(line) {
                if ["at", "level", "event", "message"]
                    .iter()
                    .all(|key| value[*key].is_string())
                {
                    entries.push_front(json!({"at":value["at"],"level":value["level"],"event":value["event"],"message":value["message"]}));
                    if entries.len() == 100 {
                        break;
                    }
                }
            }
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn diagnostics(app: AppHandle) -> Result<Value, String> {
    let (data, logs) = directories(&app)?;
    let _guard = state().lock().map_err(|_| "Collector state unavailable")?;
    let entries = read_log_tail(&logs).map_err(|_| "Diagnostics could not be read")?;
    Ok(
        json!({"entries":entries,"logDirectory":logs.to_string_lossy(),"dataDirectory":data.to_string_lossy()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rescan_merges_stored_and_live_evidence() {
        let stored = json!({"players":[{"key":"me","augments":["A"]}], "fields":["/stored"]});
        let live = json!({
            "players":[
                {"key":"me","augments":["A","B"],"champion":"Ahri"},
                {"key":"other","augments":["C"],"team":"CHAOS"}
            ],
            "fields":["/live"]
        });
        let merged = merge_postgame_entries(&stored, &live);
        let players = merged["players"].as_array().unwrap();
        assert_eq!(players.len(), 2);
        let me = players.iter().find(|p| p["key"] == "me").unwrap();
        assert_eq!(me["augments"].as_array().unwrap().len(), 2);
        assert_eq!(me["champion"], "Ahri");
        assert!(players.iter().any(|p| p["key"] == "other"));
        let fields = merged["fields"].as_array().unwrap();
        assert!(fields.iter().any(|f| f == "/stored"));
        assert!(fields.iter().any(|f| f == "/live"));
        // 只有一份证据时原样返回；两份都空时返回 null。
        assert_eq!(merge_postgame_entries(&Value::Null, &live), live);
        assert!(merge_postgame_entries(&Value::Null, &Value::Null).is_null());
    }

    struct TempLogs(PathBuf);
    impl TempLogs {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "hexlens-collector-{}-{}-{}",
                std::process::id(),
                Utc::now().timestamp_nanos_opt().unwrap(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempLogs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn postgame_scan_maps_ids_and_inherits_parent_identity() {
        let eog = json!({
            "gameId": 4242424242_i64,
            "playerStatSummaries": [
                {"summonerName":"HexglowTest","augments":[1001,1067,9999]},
                {"summonerName":"EnemyMid","augmentSlots":{"augmentIds":[1002]}},
                {"teams":[{"players":[{"riotId":"Riot#KR1","augments":["旧版文本效果"]}]}]}
            ]
        });
        let post = postgame_augments(&eog, &Value::Null, Some("4242424242"));
        let players = post["players"].as_array().unwrap();
        assert_eq!(players.len(), 3);
        let by_key: std::collections::BTreeMap<&str, Vec<String>> = players
            .iter()
            .map(|entry| {
                (
                    entry["key"].as_str().unwrap(),
                    entry["augments"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                )
            })
            .collect();
        assert_eq!(by_key["hexglowtest"], vec!["泰坦的坚决", "活力焕发"]);
        assert_eq!(by_key["enemymid"], vec!["尖端发明家"]);
        assert_eq!(by_key["riot#kr1"], vec!["旧版文本效果"]);
        let fields = post["fields"].as_array().unwrap();
        assert!(fields
            .iter()
            .any(|field| field.as_str().unwrap().ends_with("/augments")));
        // 认不出的数字 id 不猜名字，只留能核对的字段路径。
        assert!(!post["players"].to_string().contains("9999"));
    }

    #[test]
    fn postgame_scan_carries_champion_and_team_back_to_the_session() {
        let eog = json!({"teams":[
            {"teamId":100,"players":[
                {"summonerName":"HexglowTest","championName":"Ahri","stats":{"PLAYER_AUGMENT_1":1001}},
                {"summonerName":"TopLane","championName":"Garen","team":"order","augments":[1002]}
            ]},
            {"teamId":200,"players":[
                {"riotIdGameName":"EnemyMid","riotIdTagLine":"KR1","championName":"Jinx","teamId":200,"augments":[1067]}
            ]}
        ]});
        let post = postgame_augments(&eog, &Value::Null, None);
        let players = post["players"].as_array().unwrap();
        let meta: std::collections::BTreeMap<&str, (Option<&str>, Option<&str>)> = players
            .iter()
            .map(|entry| {
                (
                    entry["key"].as_str().unwrap(),
                    (entry["champion"].as_str(), entry["team"].as_str()),
                )
            })
            .collect();
        assert_eq!(meta.len(), 3);
        // 阵营从 team 级 teamId 继承，英雄来自记录自身。
        assert_eq!(meta["hexglowtest"], (Some("Ahri"), Some("ORDER")));
        assert_eq!(meta["toplane"], (Some("Garen"), Some("ORDER")));
        assert_eq!(meta["enemymid#kr1"], (Some("Jinx"), Some("CHAOS")));
        assert!(post["players"].to_string().contains("泰坦的坚决"));
        // 没有英雄与阵营的记录不编造归属信息。
        let plain = postgame_augments(
            &json!({"playerStatSummaries":[{"summonerName":"Solo","augments":[1001]}]}),
            &Value::Null,
            None,
        );
        assert!(plain["players"][0].get("champion").is_none());
        assert!(plain["players"][0].get("team").is_none());
    }

    #[test]
    fn postgame_scan_keeps_masked_players_separate_and_attributable() {
        let eog = json!({"teams":[
            {"teamId":100,"players":[{"summonerName":"#","championName":"Ahri","augments":[1001]}]},
            {"teamId":200,"players":[{"summonerName":"#","championName":"Jinx","augments":[1067]}]}
        ]});
        let post = postgame_augments(&eog, &Value::Null, None);
        let players = post["players"].as_array().unwrap();
        // 遮蔽标记不是身份：两条记录各归各的键，不会串成一条。
        assert_eq!(players.len(), 2);
        let meta: std::collections::BTreeMap<&str, (&str, &str, Vec<String>)> = players
            .iter()
            .map(|entry| {
                (
                    entry["key"].as_str().unwrap(),
                    (
                        entry["champion"].as_str().unwrap(),
                        entry["team"].as_str().unwrap(),
                        entry["augments"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect(),
                    ),
                )
            })
            .collect();
        assert_eq!(
            meta["path:/teams[0]/players[0]"],
            ("Ahri", "ORDER", vec!["泰坦的坚决".to_string()])
        );
        assert_eq!(
            meta["path:/teams[1]/players[0]"],
            ("Jinx", "CHAOS", vec!["活力焕发".to_string()])
        );
    }

    #[test]
    fn archived_sessions_rescan_their_own_stored_evidence() {
        let session = json!({"matchId":"1","endOfGame":{"teams":[{"teamId":100,"players":[
            {"summonerName":"#","championName":"Ahri","augments":[1001]}
        ]}]}});
        let entries = postgame_entries(session);
        let players = entries["players"].as_array().unwrap();
        assert_eq!(players.len(), 1);
        assert_eq!(players[0]["champion"], "Ahri");
        assert_eq!(players[0]["team"], "ORDER");
        // 没有存下赛后证据的旧档案不编造条目。
        assert_eq!(postgame_entries(json!({"matchId":"1"})), Value::Null);
        assert_eq!(
            postgame_entries(json!({"matchId":"1","endOfGame":null})),
            Value::Null
        );
    }

    #[test]
    fn postgame_history_is_only_trusted_for_the_correlated_match() {
        let history = json!({"games":{"games":[
            {"gameId":111,"participants":[{"summonerName":"A","augments":[1001]}]},
            {"gameId":222,"participants":[{"summonerName":"B","augments":[1002]}]}
        ]}});
        let post = postgame_augments(&Value::Null, &history, Some("222"));
        let players = post["players"].as_array().unwrap();
        assert_eq!(players.len(), 1);
        assert_eq!(players[0]["key"], "b");
        assert_eq!(players[0]["augments"], json!(["尖端发明家"]));
        // 没有可核对的对局 ID 就不采信历史，避免挂错人。
        assert_eq!(postgame_augments(&Value::Null, &history, None), Value::Null);
        assert_eq!(
            postgame_augments(&Value::Null, &history, Some("333")),
            Value::Null
        );
    }

    #[test]
    fn postgame_scan_keeps_client_text_and_rejects_stat_words() {
        let eog = json!({"teams":[{"players":[
            {"summonerName":"A","augmentRarity":"silver","augments":["旧版文本效果","Silver"]},
            {"summonerName":"B","augmentStats":{"stacks":12}}
        ]}]});
        let post = postgame_augments(&eog, &Value::Null, None);
        let players = post["players"].as_array().unwrap();
        assert_eq!(players.len(), 1);
        assert_eq!(players[0]["key"], "a");
        assert_eq!(players[0]["augments"], json!(["旧版文本效果"]));
        assert!(has_identified_augments(&eog));
        assert!(!has_identified_augments(&json!({"gameId":1,"teams":[]})));
        // 有海克斯但挂不到人身上时，同样需要比赛历史来补身份。
        assert!(!has_identified_augments(&json!({"augments":[1001]})));
    }

    #[test]
    fn augment_labels_resolve_packaged_ids_aliases_and_reject_unknown_numbers() {
        assert_eq!(
            crate::scoring::augment_label("1001"),
            Some("泰坦的坚决".into())
        );
        assert_eq!(
            crate::scoring::augment_label("古式佳酿"),
            Some("活力焕发".into())
        );
        assert_eq!(
            crate::scoring::augment_label("泰坦的坚决"),
            Some("泰坦的坚决".into())
        );
        assert_eq!(crate::scoring::augment_label("9999"), None);
        assert_eq!(crate::scoring::augment_label("  "), None);
    }

    #[test]
    fn logger_strict_entry_rotation_and_legacy_limits() {
        let logs = TempLogs::new();
        let long = "x".repeat(10000);
        let entry = log_entry("info", "test", &long);
        assert_eq!(entry.len(), LOG_ENTRY_LIMIT);
        for message in ["界🙂".repeat(2000), "\n\t\"\\".repeat(2000)] {
            let bytes = log_entry("info", "test", &message);
            assert!(bytes.len() <= LOG_ENTRY_LIMIT);
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(message.starts_with(value["message"].as_str().unwrap()));
        }
        for _ in 0..256 {
            append_log(&logs.0, "info", "test", &long).unwrap();
        }
        let current = logs.0.join("collector.jsonl");
        let previous = logs.0.join("collector.previous.jsonl");
        assert_eq!(fs::metadata(&current).unwrap().len(), LOG_LIMIT);
        assert!(!previous.exists());
        append_log(&logs.0, "info", "test", &long).unwrap();
        assert_eq!(fs::metadata(&previous).unwrap().len(), LOG_LIMIT);
        assert_eq!(
            fs::metadata(&current).unwrap().len(),
            LOG_ENTRY_LIMIT as u64
        );
        for _ in 0..511 {
            append_log(&logs.0, "info", "test", &long).unwrap();
        }
        assert_eq!(
            fs::metadata(&current).unwrap().len() + fs::metadata(&previous).unwrap().len(),
            1024 * 1024
        );
        for path in [&current, &previous] {
            OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_len(LOG_LIMIT * 4)
                .unwrap();
        }
        append_log(&logs.0, "info", "test", "new").unwrap();
        assert!(fs::metadata(&current).unwrap().len() <= LOG_LIMIT);
        assert_eq!(fs::metadata(&previous).unwrap().len(), 0);
    }

    #[test]
    fn diagnostics_reads_only_shared_tail_and_last_hundred() {
        let logs = TempLogs::new();
        for i in 0..120 {
            append_log(&logs.0, "info", "test", &i.to_string()).unwrap();
        }
        let entries = read_log_tail(&logs.0).unwrap();
        assert_eq!(entries.len(), 100);
        assert_eq!(entries.front().unwrap()["message"], "20");
        assert_eq!(entries.back().unwrap()["message"], "119");
        fs::rename(
            logs.0.join("collector.jsonl"),
            logs.0.join("collector.previous.jsonl"),
        )
        .unwrap();
        append_log(&logs.0, "info", "test", "current").unwrap();
        let entries = read_log_tail(&logs.0).unwrap();
        assert_eq!(entries.len(), 100);
        assert_eq!(entries.front().unwrap()["message"], "21");
        assert_eq!(entries.back().unwrap()["message"], "current");
        // Exactly 64 KiB of newest entries consumes the entire shared budget.
        fs::remove_file(logs.0.join("collector.jsonl")).unwrap();
        for _ in 0..32 {
            append_log(&logs.0, "info", "test", &"z".repeat(4000)).unwrap();
        }
        let entries = read_log_tail(&logs.0).unwrap();
        assert_eq!(entries.len(), 32);
        assert!(entries
            .iter()
            .all(|v| v["message"].as_str().unwrap().starts_with('z')));
        // A legacy huge file must be sought from its end; partial/trailing records ignored.
        let path = logs.0.join("collector.jsonl");
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        file.set_len(4 * 1024 * 1024).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(b"\n").unwrap();
        file.write_all(&log_entry("info", "test", "tail")).unwrap();
        file.write_all(b"{\"partial\":").unwrap();
        let entries = read_log_tail(&logs.0).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["message"], "tail");
    }

    #[test]
    fn throttle_is_rolling_global_and_remembers_suppression() {
        let logs = TempLogs::new();
        let mut state = State::default();
        let at = Instant::now();
        let errors: Vec<_> = (0..10).map(|i| format!("warning {i}")).collect();
        log_poll_at(&logs.0, &mut state, "lcu", "Lobby", &errors, at).unwrap();
        assert_eq!(read_log_tail(&logs.0).unwrap().len(), 6);
        assert_eq!(state.errors.len(), 10);
        log_poll_at(
            &logs.0,
            &mut state,
            "lcu",
            "ChampSelect",
            &errors,
            at + Duration::from_secs(59),
        )
        .unwrap();
        assert_eq!(state.transition.as_ref().unwrap().1, "ChampSelect");
        log_poll_at(
            &logs.0,
            &mut state,
            "lcu",
            "ChampSelect",
            &errors,
            at + Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(read_log_tail(&logs.0).unwrap().len(), 6); // No deferred backlog.
        log_poll_at(
            &logs.0,
            &mut state,
            "disconnected",
            "Unknown",
            &[
                "Live API: unavailable".into(),
                "League client was not discovered".into(),
                "LCU phase: unavailable".into(),
            ],
            at + Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(read_log_tail(&logs.0).unwrap().len(), 7); // Transition only.
        let mut rate = State::default();
        for _ in 0..6 {
            assert!(log_slot(&mut rate, at));
        }
        assert!(!log_slot(&mut rate, at + Duration::from_secs(59)));
        assert!(log_slot(&mut rate, at + Duration::from_secs(60)));
        assert_eq!(discovery_ttl(false), Duration::from_secs(15));
        assert_eq!(discovery_ttl(true), Duration::from_secs(30));
    }

    #[test]
    fn lockfiles_are_strict() {
        let c = parse_lockfile("LeagueClient:42:12345:secret:https\n").unwrap();
        assert_eq!(c.port, 12345);
        for bad in [
            "",
            "LeagueClient:0:123:a:https",
            "LeagueClient:42:0:a:https",
            "LeagueClient:42:65536:a:https",
            "LeagueClient:42:abc:a:https",
            "LeagueClient:42:123::https",
            "LeagueClient:42:123:a:http",
            "LeagueClient:42:123:a:https:extra",
            "Other:42:123:a:https",
            "LeagueClient:42:123:a b:https",
        ] {
            assert!(parse_lockfile(bad).is_err(), "accepted {bad}");
        }
    }
    #[test]
    fn parses_riot_commandline_without_shell() {
        let c = parse_commandline(r#""C:\Riot Games\LeagueClientUx.exe" "--app-port=12345" --remoting-auth-token="a-b_c""#).unwrap();
        assert_eq!(c.port, 12345);
        assert_eq!(c.password, "a-b_c");
        assert!(
            parse_commandline("LeagueClientUx.exe --app-port 123 --remoting-auth-token abc")
                .is_some()
        );
        for bad in [
            "--app-port=12",
            "--app-port=0 --remoting-auth-token=x",
            "--app-port=12 --app-port=13 --remoting-auth-token=x",
            "--app-port=12 --remoting-auth-token=\"x",
        ] {
            assert!(parse_commandline(bad).is_none());
        }
    }
    fn live(result: &str) -> Value {
        json!({"activePlayer":{"riotId":"Player#TAG"},"allPlayers":[{"riotId":"Player#TAG"}],"events":{"Events":[{"EventName":"GameEnd","Result":result}]}})
    }
    fn eog() -> Value {
        json!({"gameId":123,"teams":[{"isWinningTeam":true,"players":[{"summonerId":7}]}]})
    }
    #[test]
    fn live_results_require_exact_unique_active_identity() {
        assert_eq!(
            outcome(
                &live("Win"),
                &Value::Null,
                &Value::Null,
                &Value::Null,
                "now"
            )["status"],
            "win"
        );
        assert_eq!(
            outcome(
                &live("Lose"),
                &Value::Null,
                &Value::Null,
                &Value::Null,
                "now"
            )["status"],
            "loss"
        );
        for result in ["ORDER", "CHAOS", "Victory", "", "win"] {
            assert_eq!(
                outcome(
                    &live(result),
                    &Value::Null,
                    &Value::Null,
                    &Value::Null,
                    "now"
                )["status"],
                "unknown"
            );
        }
        let mut data = live("Win");
        data["activePlayer"] = Value::Null;
        assert_eq!(
            outcome(&data, &Value::Null, &Value::Null, &Value::Null, "now")["status"],
            "unknown"
        );
        data = live("Win");
        data["allPlayers"] = json!([{"riotId":"other#TAG"}]);
        assert_eq!(
            outcome(&data, &Value::Null, &Value::Null, &Value::Null, "now")["status"],
            "unknown"
        );
        data = live("Win");
        data["allPlayers"] = json!([{"riotId":"Player#TAG"},{"riotId":"Player#TAG"}]);
        assert_eq!(
            outcome(&data, &Value::Null, &Value::Null, &Value::Null, "now")["status"],
            "unknown"
        );
    }
    #[test]
    fn eog_requires_game_and_current_summoner_correlation() {
        let current = json!({"summonerId":7});
        let session = json!({"gameData":{"gameId":123}});
        assert_eq!(
            outcome(&Value::Null, &session, &eog(), &current, "now")["status"],
            "win"
        );
        let mut loss = eog();
        loss["teams"][0]["isWinningTeam"] = json!(false);
        assert_eq!(
            outcome(&Value::Null, &session, &loss, &current, "now")["status"],
            "loss"
        );
        assert_eq!(
            outcome(
                &Value::Null,
                &json!({"gameId":124}),
                &eog(),
                &current,
                "now"
            )["status"],
            "unknown"
        );
        assert_eq!(
            outcome(
                &Value::Null,
                &session,
                &eog(),
                &json!({"summonerId":8}),
                "now"
            )["status"],
            "unknown"
        );
        let mut missing = eog();
        missing.as_object_mut().unwrap().remove("gameId");
        assert_eq!(
            outcome(&Value::Null, &session, &missing, &current, "now")["status"],
            "unknown"
        );
    }
    #[test]
    fn no_result_from_phase_or_disconnect() {
        for phase in ["InProgress", "EndOfGame", "PreEndOfGame", "None"] {
            assert_eq!(
                outcome(
                    &Value::Null,
                    &json!({"phase":phase,"gameId":123}),
                    &Value::Null,
                    &Value::Null,
                    "now"
                )["status"],
                "unknown"
            );
        }
        let mut data = live("Win");
        data["gameData"] = json!({"gameId":124});
        assert_eq!(
            outcome(
                &data,
                &json!({"gameId":123}),
                &Value::Null,
                &Value::Null,
                "now"
            )["status"],
            "unknown"
        );
    }
    #[test]
    fn sanitization_removes_credentials_but_preserves_stats() {
        let mut value = json!({"authorization":"Basic abc","nested":{"remoting-auth-token":"secret","score":42,"text":"prefix secret suffix"}});
        sanitize(&mut value, Some("secret"));
        assert!(value.get("authorization").is_none());
        assert!(value["nested"].get("remoting-auth-token").is_none());
        assert_eq!(value["nested"]["score"], 42);
        assert!(!value.to_string().contains("secret"));
    }
    #[test]
    fn stale_live_end_is_withheld_during_new_lcu_lifecycle() {
        let session = json!({"gameData":{"gameId":456}});
        for phase in [
            "ChampSelect",
            "GameStart",
            "Lobby",
            "Matchmaking",
            "Unknown",
            "None",
        ] {
            let mut data = live("Win");
            let mut end = Value::Null;
            let mut warnings = Vec::new();
            let game =
                correlate_payloads(phase, true, &session, &mut data, &mut end, &mut warnings);
            assert_eq!(game.as_deref(), Some("456"));
            assert!(data.is_null());
            assert!(!warnings.is_empty());
            assert_eq!(
                outcome(&data, &session, &end, &Value::Null, "now")["status"],
                "unknown"
            );
        }
    }
    #[test]
    fn phase_failure_preserves_live_without_borrowing_session_identity() {
        let mut session = json!({"gameData":{"gameId":456}});
        let mut data = live("Win");
        let mut end = eog();
        let mut connected = true;
        let mut warnings = Vec::new();
        degrade_unknown_phase(
            "Unknown",
            &mut connected,
            &mut session,
            &mut end,
            &mut warnings,
        );
        let game = correlate_payloads(
            "Unknown",
            connected,
            &session,
            &mut data,
            &mut end,
            &mut warnings,
        );
        assert!(!connected);
        assert!(session.is_null());
        assert!(end.is_null());
        assert!(!data.is_null());
        assert!(game.is_none());
        let result = outcome(&data, &session, &end, &Value::Null, "now");
        assert_eq!(result["status"], "win");
        assert!(result.get("gameId").is_none());
        assert!(!warnings.is_empty());
    }
    #[test]
    fn coherent_live_and_live_only_remain_available() {
        for (phase, connected) in [
            ("InProgress", true),
            ("Reconnect", true),
            ("EndOfGame", true),
            ("Unknown", false),
        ] {
            let mut data = live("Win");
            let mut end = Value::Null;
            let mut warnings = Vec::new();
            correlate_payloads(
                phase,
                connected,
                &Value::Null,
                &mut data,
                &mut end,
                &mut warnings,
            );
            assert!(!data.is_null());
            assert!(warnings.is_empty());
        }
    }
    #[test]
    fn raw_eog_and_live_cannot_escape_with_mismatched_ids() {
        let session = json!({"gameId":456});
        let mut data = live("Win");
        data["gameId"] = json!(123);
        let mut end = eog();
        let mut warnings = Vec::new();
        let game = correlate_payloads(
            "EndOfGame",
            true,
            &session,
            &mut data,
            &mut end,
            &mut warnings,
        );
        assert_eq!(game.as_deref(), Some("456"));
        assert!(data.is_null());
        assert!(end.is_null());
        let mut end = eog();
        end.as_object_mut().unwrap().remove("gameId");
        correlate_payloads(
            "EndOfGame",
            true,
            &session,
            &mut data,
            &mut end,
            &mut warnings,
        );
        assert!(end.is_null());
        let mut end = eog();
        end["gameId"] = json!(456);
        correlate_payloads(
            "EndOfGame",
            true,
            &session,
            &mut data,
            &mut end,
            &mut warnings,
        );
        assert!(!end.is_null());
    }
    #[test]
    fn game_ids_do_not_accept_floats_zero_or_arbitrary_strings() {
        for value in [json!(0), json!(-1), json!(12.5), json!("abc"), Value::Null] {
            assert!(id(&value).is_none());
        }
        assert_eq!(id(&json!("123")), Some("123".into()));
    }
}
