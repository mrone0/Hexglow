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
// Only a fixed error class and numeric status may leave the transport layer.
// reqwest's display error can contain URLs; response bodies may contain identities.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
enum ApiError {
    #[error("http-status-{0}")]
    Http(u16),
    #[error("poll-budget-exhausted")]
    Budget,
    #[error("unavailable")]
    Unavailable,
    #[error("oversized-response")]
    Oversized,
    #[error("read-error")]
    Read,
    #[error("invalid-json")]
    InvalidJson,
}

impl ApiError {
    fn stops_fallback(self) -> bool {
        matches!(self, Self::Http(401 | 403 | 429) | Self::Budget)
    }
}

async fn get_json(
    client: &Client,
    credentials: Option<&Credentials>,
    path: &str,
    deadline: Instant,
) -> Result<Value, ApiError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(ApiError::Budget);
    }
    let port = credentials.map_or(2999, |c| c.port);
    // All callers supply compile-time endpoint paths; no host/URL from external data.
    let mut request = client
        .get(format!("https://127.0.0.1:{port}{path}"))
        .timeout(remaining.min(Duration::from_secs(2)));
    if let Some(c) = credentials {
        request = request.basic_auth("riot", Some(&c.password));
    }
    let mut response = request.send().await.map_err(|_| ApiError::Unavailable)?;
    if !response.status().is_success() {
        return Err(ApiError::Http(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(ApiError::Oversized);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ApiError::Read)? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err(ApiError::Oversized);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::InvalidJson)
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
    match (
        v.get("gameId"),
        v.get("gameData").and_then(|data| data.get("gameId")),
    ) {
        (Some(top), Some(nested)) => {
            let top = id(top)?;
            let nested = id(nested)?;
            (top == nested).then_some(top)
        }
        (Some(value), None) | (None, Some(value)) => id(value),
        (None, None) => None,
    }
}
fn has_game_id_field(v: &Value) -> bool {
    v.get("gameId").is_some()
        || v.get("gameData")
            .and_then(|data| data.get("gameId"))
            .is_some()
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
    if has_game_id_field(session) && session_id.is_none() {
        *live = Value::Null;
        *eog = Value::Null;
        warnings.push("LCU session association withheld: invalid or conflicting game ID".into());
        return None;
    }
    let coherent_phase = matches!(phase, "InProgress" | "Reconnect") || end_phase(phase);
    let ids_conflict = matches!((&session_id, &live_id), (Some(a), Some(b)) if a != b);
    let live_id_invalid = has_game_id_field(live) && live_id.is_none();
    if !live.is_null() && (live_id_invalid || ids_conflict || (lcu_connected && !coherent_phase)) {
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
    let session_id_invalid = has_game_id_field(session) && session_id.is_none();
    let live_id_invalid = has_game_id_field(live) && live_id.is_none();
    let live_matches = !session_id_invalid
        && !live_id_invalid
        && !matches!((&session_id, &live_id), (Some(a), Some(b)) if a != b);
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
                    live_id.as_deref().or(session_id.as_deref()),
                    at,
                    json!({"event":"GameEnd","result":event["Result"],"activePlayerMatched":true}),
                );
            }
        }
    }
    // An EOG block without its own ID is never correlated, even if a session exists.
    if session_id_invalid {
        return unknown(at);
    }
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
    record_path: Option<String>,
}

// 一个身份名下的赛后证据：海克斯集合 + 可用于兜底匹配的归属信息。
#[derive(Default)]
struct PlayerEvidence {
    augments: BTreeSet<String>,
    champion: Option<String>,
    team: Option<String>,
    conflicted: bool,
}

fn complete_riot_id(value: &str) -> bool {
    value.split_once('#').is_some_and(|(name, tag)| {
        !name.trim().is_empty() && !tag.trim().is_empty() && !tag.contains('#')
    })
}

fn conflicting_metadata(left: Option<&str>, right: Option<&str>) -> bool {
    matches!((left, right), (Some(a), Some(b)) if !a.trim().eq_ignore_ascii_case(b.trim()))
}

// Keep each weakly identified player record separate until collisions are known.
// Nested stat fields retain the owning record path; a short name is not a unique ID.
fn scan_postgame_payload(value: &Value) -> Value {
    let mut fields = BTreeSet::new();
    let mut players: BTreeMap<(String, String), PlayerEvidence> = BTreeMap::new();
    let normalized = history_participants(value);
    scan_augments(
        &normalized,
        "",
        Whereabouts::default(),
        &mut fields,
        &mut players,
    );
    let mut occurrences: BTreeMap<&str, usize> = BTreeMap::new();
    let mut conflicted = BTreeSet::new();
    for ((identity, _), entry) in &players {
        *occurrences.entry(identity).or_default() += 1;
        if entry.conflicted {
            conflicted.insert(identity.as_str());
        }
    }
    let identified: Vec<_> = players
        .iter()
        .filter(|((identity, _), _)| {
            identity != "unknown" && !conflicted.contains(identity.as_str())
        })
        .map(|((identity, path), entry)| {
            let key = if !complete_riot_id(identity) && occurrences[identity.as_str()] > 1 {
                // The frontend may use only unique champion/team attribution for
                // these records, never the ambiguous short name.
                format!("path:{path}")
            } else {
                identity.clone()
            };
            let mut item = json!({"key":key,"augments":&entry.augments});
            if let Some(champion) = &entry.champion {
                item["champion"] = Value::String(champion.clone());
            }
            if let Some(team) = &entry.team {
                item["team"] = Value::String(team.clone());
            }
            item
        })
        .collect();
    merge_postgame_entries(&json!({"players":identified,"fields":fields}), &Value::Null)
}

// Scan EOG/history separately: identical array positions across responses do not
// establish player identity. Only already-correlated games reach this function.
fn postgame_augments(eog: &Value, history: &Value, game: Option<&str>) -> Value {
    let eog = scan_postgame_payload(eog);
    let history = game
        .and_then(|game| matching_history(history, game))
        .map(scan_postgame_payload)
        .unwrap_or(Value::Null);
    merge_postgame_entries(&eog, &history)
}

// 旧档案的本地补录：把保存下来的赛后证据按当前扫描规则重新归属，不联网、不改库，
// 由前端决定是否写回。没有存下证据时返回 null。
#[tauri::command]
pub fn postgame_entries(session: Value) -> Value {
    match (id(&session["matchId"]), session.get("endOfGame")) {
        (Some(game), Some(eog)) if game_id(eog).as_ref() == Some(&game) => {
            postgame_augments(eog, &Value::Null, None)
        }
        _ => Value::Null,
    }
}

// Correlated evidence for a trusted identity is a set union, not a longest-list
// contest. Conflicting metadata is withheld, and unanchored weak keys may only
// select an observed superset rather than inventing a cross-record union.
fn merge_postgame_entries(left: &Value, right: &Value) -> Value {
    merge_postgame_sources(&[left, right])
}

fn merge_postgame_sources(sources: &[&Value]) -> Value {
    let mut groups: BTreeMap<String, Vec<(&Value, &[Value])>> = BTreeMap::new();
    let mut fields: BTreeSet<String> = BTreeSet::new();
    for source in sources {
        let Some(map) = source.as_object() else {
            continue;
        };
        if let Some(items) = map.get("players").and_then(Value::as_array) {
            for item in items {
                let Some(key) = item.get("key").and_then(Value::as_str) else {
                    continue;
                };
                groups
                    .entry(key.to_string())
                    .or_default()
                    .push((item, items));
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
    let mut players = Vec::new();
    for (key, items) in groups {
        let metadata = |item: &Value, field: &str| {
            item[field]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let mut champion = None;
        let mut team = None;
        let mut conflict = false;
        for (item, _) in &items {
            let next_champion = metadata(item, "champion");
            let next_team = metadata(item, "team");
            conflict |= conflicting_metadata(champion.as_deref(), next_champion.as_deref())
                || conflicting_metadata(team.as_deref(), next_team.as_deref());
            champion = champion.or(next_champion);
            team = team.or(next_team);
        }
        if conflict {
            continue;
        }
        let sets: Vec<BTreeSet<String>> = items
            .iter()
            .map(|(item, _)| {
                item["augments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .collect();
        let anchored = items.iter().all(|(item, siblings)| {
            let (Some(champion), Some(team)) = (metadata(item, "champion"), metadata(item, "team"))
            else {
                return false;
            };
            siblings
                .iter()
                .filter(|sibling| {
                    metadata(sibling, "champion")
                        .is_some_and(|value| value.eq_ignore_ascii_case(&champion))
                        && metadata(sibling, "team")
                            .is_some_and(|value| value.eq_ignore_ascii_case(&team))
                })
                .count()
                == 1
        });
        let augments = if complete_riot_id(&key) || anchored {
            sets.iter()
                .flat_map(|set| set.iter().cloned())
                .collect::<BTreeSet<_>>()
        } else {
            // Array paths identify one payload's records, never a player across
            // payloads. Every source must independently supply a unique anchor.
            if key.starts_with("path:") && items.len() > 1 {
                continue;
            }
            // A lone weak record or an observed superset remains usable. Two
            // complementary lists with no identity/metadata anchor are ambiguous.
            let supersets: Vec<_> = sets
                .iter()
                .enumerate()
                .filter(|(_, set)| sets.iter().all(|other| other.is_subset(set)))
                .collect();
            let Some(&(index, superset)) = supersets.first() else {
                continue;
            };
            // Keep one actually observed row, not a synthetic identity assembled
            // from different weak records. Equal supersets with different
            // metadata cannot be selected safely or order-independently.
            champion = metadata(items[index].0, "champion");
            team = metadata(items[index].0, "team");
            if supersets.iter().any(|(index, _)| {
                metadata(items[*index].0, "champion") != champion
                    || metadata(items[*index].0, "team") != team
            }) {
                continue;
            }
            superset.clone()
        };
        if augments.is_empty() {
            continue;
        }
        let mut item = json!({"key":key,"augments":augments});
        if let Some(champion) = champion {
            item["champion"] = json!(champion);
        }
        if let Some(team) = team {
            item["team"] = json!(team);
        }
        players.push(item);
    }
    if players.is_empty() {
        return Value::Null;
    }
    json!({
        "players": players,
        "fields": fields,
    })
}

// Every endpoint is attempted at most once per bounded pass. The frontend owns
// delayed retries and persists results against the captured session/match ID.
#[tauri::command]
pub async fn postgame_rescan(
    app: AppHandle,
    session: Value,
    lockfile_path: Option<String>,
) -> Value {
    let mut warnings = Vec::new();
    let Some(game) = id(&session["matchId"]) else {
        return recovery_payload(
            &session,
            &Value::Null,
            &Value::Null,
            &Value::Null,
            &now(),
            vec!["Postgame recovery withheld: missing or invalid game ID".into()],
        );
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    let (credentials, discovered) =
        tauri::async_runtime::spawn_blocking(move || discover(lockfile_path.as_deref()))
            .await
            .unwrap_or_else(|_| (None, vec!["Local discovery task failed".into()]));
    warnings.extend(discovered);
    let (mut eog, mut history, mut summoner) = (Value::Null, Value::Null, Value::Null);
    match (credentials.as_ref(), riot_client()) {
        (Some(credentials), Ok(client)) => {
            let fetched = fetch_recovery(&game, &session["endOfGame"], |path| {
                let client = client.clone();
                let credentials = credentials.clone();
                async move { get_json(&client, Some(&credentials), &path, deadline).await }
            })
            .await;
            (eog, history, summoner) = (fetched.0, fetched.1, fetched.2);
            warnings.extend(fetched.3);
        }
        (None, _) => warnings.push("League client was not discovered".into()),
        (_, Err(error)) => warnings.push(error),
    }
    let mut payload = recovery_payload(&session, &eog, &history, &summoner, &now(), warnings);
    sanitize(
        &mut payload,
        credentials.as_ref().map(|c| c.password.as_str()),
    );
    log_postgame_scan(&app, &payload);
    let messages = payload["warnings"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default();
    log_event(
        &app,
        if messages.is_empty() { "info" } else { "warn" },
        "postgame-recovery",
        &format!(
            "evidence={}; result={}; {}",
            payload["evidenceSource"].as_str().unwrap_or("none"),
            payload["result"]["status"].as_str().unwrap_or("unknown"),
            messages
        ),
    );
    payload
}

async fn recovery_request<F, Fut>(
    fetch: &mut F,
    path: &str,
    label: &str,
    warnings: &mut Vec<String>,
    stopped: &mut bool,
) -> Value
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Value, ApiError>>,
{
    match fetch(path.to_owned()).await {
        Ok(value) => value,
        Err(error) => {
            *stopped = error.stops_fallback();
            warnings.push(format!("{label}: {error}"));
            Value::Null
        }
    }
}

async fn fetch_recovery<F, Fut>(
    game: &str,
    stored: &Value,
    mut fetch: F,
) -> (Value, Value, Value, Vec<String>)
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Value, ApiError>>,
{
    let mut warnings = Vec::new();
    let mut stopped = false;
    let eog = recovery_request(
        &mut fetch,
        "/lol-end-of-game/v1/eog-stats-block",
        "LCU end-of-game",
        &mut warnings,
        &mut stopped,
    )
    .await;
    let mut history = Value::Null;
    if !stopped {
        history = recovery_request(
            &mut fetch,
            &format!("/lol-match-history/v1/games/{game}"),
            "LCU match history direct",
            &mut warnings,
            &mut stopped,
        )
        .await;
    }
    if !stopped && matching_history(&history, game).is_none() {
        history = recovery_request(
            &mut fetch,
            "/lol-match-history/v1/products/lol/current-summoner/matches?begin=0&count=10",
            "LCU match history recent",
            &mut warnings,
            &mut stopped,
        )
        .await;
    }
    let mut summoner = Value::Null;
    if !stopped
        && (game_id(&eog).as_deref() == Some(game)
            || matching_history(&history, game).is_some()
            || game_id(stored).as_deref() == Some(game))
    {
        summoner = recovery_request(
            &mut fetch,
            "/lol-summoner/v1/current-summoner",
            "LCU current summoner",
            &mut warnings,
            &mut stopped,
        )
        .await;
    }
    (eog, history, summoner, warnings)
}

// 旧 v4 结构是 {games:{games:[{gameId,participants:[…]}]}}；按 gameId 只认这一局。
fn collect_history_games<'a>(node: &'a Value, game: &str, out: &mut Vec<&'a Value>) {
    match node {
        Value::Object(map) => {
            // Direct /games/{id} returns the game itself, not a games array.
            // Never descend through an explicitly different game's payload.
            if has_game_id_field(node) {
                if game_id(node).as_deref() == Some(game) {
                    out.push(node);
                }
                return;
            }
            for value in map.values() {
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

fn matching_history<'a>(history: &'a Value, game: &str) -> Option<&'a Value> {
    let mut matches = Vec::new();
    collect_history_games(history, game, &mut matches);
    // Identical duplicated wrappers are harmless; conflicting copies are not evidence.
    let first = *matches.first()?;
    matches.iter().all(|entry| *entry == first).then_some(first)
}

// Join the legacy history's separate identity table only via a unique participant ID.
// Keep the original history untouched for archive evidence.
fn history_participants(game: &Value) -> Value {
    let mut normalized = game.clone();
    let Some(participants) = normalized
        .get_mut("participants")
        .and_then(Value::as_array_mut)
    else {
        return normalized;
    };
    for participant in participants {
        let Some(participant_id) = id(&participant["participantId"]) else {
            continue;
        };
        let unique_participant = game["participants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| id(&p["participantId"]).as_ref() == Some(&participant_id))
            .count()
            == 1;
        let identities: Vec<_> = game["participantIdentities"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| id(&p["participantId"]).as_ref() == Some(&participant_id))
            .collect();
        if !unique_participant || identities.len() != 1 {
            continue;
        }
        if let (Some(identity), Some(target)) = (
            identities[0]["player"].as_object(),
            participant.as_object_mut(),
        ) {
            for key in [
                "summonerId",
                "summonerName",
                "riotId",
                "riotIdGameName",
                "riotIdTagLine",
                "gameName",
                "tagLine",
            ] {
                if let Some(value) = identity.get(key) {
                    target.entry(key).or_insert_with(|| value.clone());
                }
            }
        }
    }
    normalized
}

fn history_outcome(history: &Value, game: &str, summoner: &Value, at: &str) -> Value {
    let Some(entry) = matching_history(history, game) else {
        return unknown(at);
    };
    let Some(own_id) = id(&summoner["summonerId"]) else {
        return unknown(at);
    };
    let own: Vec<_> = if let Some(identities) = entry["participantIdentities"].as_array() {
        let own: Vec<_> = identities
            .iter()
            .filter(|p| id(&p["player"]["summonerId"]).as_ref() == Some(&own_id))
            .collect();
        if own.len() != 1 {
            return unknown(at);
        }
        let Some(participant_id) = id(&own[0]["participantId"]) else {
            return unknown(at);
        };
        if identities
            .iter()
            .filter(|p| id(&p["participantId"]).as_ref() == Some(&participant_id))
            .count()
            != 1
        {
            return unknown(at);
        }
        let participants: Vec<_> = entry["participants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| id(&p["participantId"]).as_ref() == Some(&participant_id))
            .collect();
        if participants
            .iter()
            .any(|p| id(&p["summonerId"]).is_some_and(|found| found != own_id))
        {
            return unknown(at);
        }
        participants
    } else {
        entry["participants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| id(&p["summonerId"]).as_ref() == Some(&own_id))
            .collect()
    };
    if own.len() != 1 {
        return unknown(at);
    }
    let stats_win = own[0]["stats"]["win"].as_bool();
    let direct_win = own[0]["win"].as_bool();
    if matches!((stats_win, direct_win), (Some(a), Some(b)) if a != b) {
        return unknown(at);
    }
    match stats_win.or(direct_win) {
        Some(win) => result_value(
            if win { "win" } else { "loss" },
            "lcu-history",
            Some(game),
            at,
            json!({"currentSummonerMatched":true,"historyGameIdMatched":true,"participantWin":win}),
        ),
        None => unknown(at),
    }
}

fn archive_owner_matches(session: &Value, summoner: &Value) -> bool {
    let Some(current) = summoner.as_object().and_then(identity_of) else {
        return false;
    };
    // Replaying another account's archive must not infer that account's perspective.
    // Masked/short/absent names are insufficient to establish the archived owner.
    if !current
        .split_once('#')
        .is_some_and(|(name, tag)| !name.is_empty() && !tag.is_empty())
    {
        return false;
    }
    match session["ownPlayerId"]
        .as_str()
        .filter(|own| !own.trim().is_empty())
    {
        Some(own) => own.trim().eq_ignore_ascii_case(&current),
        None => session["liveData"]["activePlayer"]
            .as_object()
            .and_then(identity_of)
            .is_some_and(|own| own == current),
    }
}

fn recovery_payload(
    session: &Value,
    eog: &Value,
    history: &Value,
    summoner: &Value,
    at: &str,
    mut warnings: Vec<String>,
) -> Value {
    let game = id(&session["matchId"]);
    let mut augment_sources = Vec::new();
    let mut evidence = Value::Null;
    let mut evidence_source = "none";
    let mut result = unknown(at);
    if let Some(game) = game.as_deref() {
        let own = if archive_owner_matches(session, summoner) {
            summoner
        } else {
            &Value::Null
        };
        for (value, source) in [(&session["endOfGame"], "stored"), (eog, "lcu-eog")] {
            if value.is_null() {
                continue;
            }
            if game_id(value).as_deref() != Some(game) {
                warnings.push(format!(
                    "Postgame {source} withheld: missing or mismatched game ID"
                ));
                continue;
            }
            augment_sources.push(postgame_augments(value, &Value::Null, None));
            evidence = value.clone();
            evidence_source = source;
            let candidate = outcome(&Value::Null, &json!({"gameId":game}), value, own, at);
            let candidate = if candidate["status"] == "unknown" {
                history_outcome(value, game, own, at)
            } else {
                candidate
            };
            if candidate["status"] != "unknown" {
                result = candidate;
            }
        }
        if let Some(entry) = matching_history(history, game) {
            augment_sources.push(postgame_augments(&Value::Null, entry, Some(game)));
            if evidence.is_null() {
                evidence = entry.clone();
                evidence_source = "lcu-match-history";
            }
            if result["status"] == "unknown" {
                result = history_outcome(entry, game, own, at);
            }
        } else if !history.is_null() {
            warnings.push("Postgame history withheld: target game missing or ambiguous".into());
        }
        if !evidence.is_null() && own.is_null() {
            warnings.push(
                "Postgame result withheld: archived owner not matched to current summoner".into(),
            );
        }
    }
    // Group all sources together: a conflict in the first two must not disappear
    // into null and let a third source resurrect the rejected player's evidence.
    let merged = merge_postgame_sources(&augment_sources.iter().collect::<Vec<_>>());
    json!({"gameId":game,"players":merged["players"].as_array().cloned().unwrap_or_default(),
        "fields":merged["fields"].as_array().cloned().unwrap_or_default(),
        "endOfGame":evidence,"evidenceSource":evidence_source,"result":result,"observedAt":at,"warnings":warnings})
}

// EOG 自己能不能给出挂到人身上的海克斯；拿不到就去比赛历史补。
fn has_identified_augments(eog: &Value) -> bool {
    !postgame_augments(eog, &Value::Null, None).is_null()
}

fn should_fetch_history(phase: &str, game: Option<&str>, eog: &Value) -> bool {
    let capture_phase =
        end_phase(phase) || matches!(phase, "Lobby" | "None" | "Matchmaking" | "ReadyCheck");
    capture_phase
        && game.is_some()
        && (game_id(eog).as_deref() != game || !has_identified_augments(eog))
}

fn scan_augments(
    node: &Value,
    path: &str,
    parent: Whereabouts,
    fields: &mut BTreeSet<String>,
    players: &mut BTreeMap<(String, String), PlayerEvidence>,
) {
    match node {
        Value::Object(map) => {
            let explicit_identity = identity_of(map);
            let explicit_champion = champion_of(map);
            let champion = explicit_champion.clone().or(parent.champion.clone());
            let team = team_of(map).or(parent.team.clone());
            let identity = explicit_identity
                .clone()
                .or(parent.identity.clone())
                // 身份被遮蔽时用记录自身的路径当临时键：同一条记录的嵌套字段仍归到
                // 一起，不同玩家不会互相串号，前端再按「英雄 + 阵营」唯一匹配认回去。
                .or_else(|| champion.as_ref().map(|_| format!("path:{path}")));
            let new_record = parent.record_path.is_none()
                || explicit_identity
                    .as_ref()
                    .is_some_and(|id| parent.identity.as_ref() != Some(id))
                || (explicit_champion.is_some() && parent.champion.is_none());
            let record_path = if new_record {
                path.to_string()
            } else {
                parent
                    .record_path
                    .clone()
                    .unwrap_or_else(|| path.to_string())
            };
            let here = Whereabouts {
                identity: identity.clone(),
                champion: champion.clone(),
                team: team.clone(),
                record_path: Some(record_path.clone()),
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
                let slot = players.entry((who, record_path.clone())).or_default();
                slot.conflicted |=
                    conflicting_metadata(slot.champion.as_deref(), champion.as_deref())
                        || conflicting_metadata(slot.team.as_deref(), team.as_deref());
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
    // Riot ID 的 gameName 可以重名，完整 gameName#tagLine 才是强身份。
    // 不让同名 summonerName 把不同玩家的赛后海克斯并到同一个集合。
    let riot = text("riotId");
    let complete_riot = riot.as_deref().filter(|value| {
        value
            .split_once('#')
            .is_some_and(|(game, tag)| !game.is_empty() && !tag.is_empty())
    });
    if let Some(riot) = complete_riot {
        return Some(riot.to_ascii_lowercase());
    }
    let game = text("riotIdGameName").or_else(|| text("gameName"));
    let tag = text("riotIdTagLine").or_else(|| text("tagLine"));
    match (game, tag) {
        (Some(game), Some(tag)) => Some(format!("{game}#{tag}").to_ascii_lowercase()),
        (game, _) => riot
            .or_else(|| text("summonerName"))
            .or(game)
            .or_else(|| text("playerName"))
            .map(|name| name.to_ascii_lowercase()),
    }
}

// Names use the same English labels as Live API. Numeric history IDs are resolved
// only against the bundled official catalogue, never guessed from player order.
fn champion_of(map: &JsonObject<String, Value>) -> Option<String> {
    ["championName", "champion"]
        .into_iter()
        .find_map(|key| map.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let key = id(map.get("championId")?)?;
            static CHAMPIONS: OnceLock<BTreeMap<String, String>> = OnceLock::new();
            CHAMPIONS
                .get_or_init(|| {
                    let data: Value = serde_json::from_str(include_str!("../data/champions.json"))
                        .unwrap_or(Value::Null);
                    data["champions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|champion| {
                            Some((
                                id(&champion["key"])?,
                                champion["name"].as_str()?.to_string(),
                            ))
                        })
                        .collect()
                })
                .get(&key)
                .cloned()
        })
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

/// Low-volume diagnostics from other modules share the collector's rotation lock.
pub(crate) fn log_event(app: &AppHandle, level: &str, event: &str, message: &str) {
    let Ok((_, logs)) = directories(app) else {
        return;
    };
    let Ok(_guard) = state().lock() else {
        return;
    };
    let _ = append_log(&logs, level, event, message);
}

const OCR_STATS_FILE: &str = "ocr-stats.json";

fn ocr_stats_empty() -> Value {
    json!({"schema":1,"scans":0,"hits":0,"names":0,"sources":{},"byDay":{},"lastAt":Value::Null})
}
fn ocr_bump(bucket: &mut Value, matched: usize) {
    bucket["scans"] = json!(bucket["scans"].as_u64().unwrap_or(0) + 1);
    if matched > 0 {
        bucket["hits"] = json!(bucket["hits"].as_u64().unwrap_or(0) + 1);
        bucket["names"] = json!(bucket["names"].as_u64().unwrap_or(0) + matched as u64);
    }
}
fn local_day(at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|stamp| {
            stamp
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|_| at.get(..10).unwrap_or("unknown").to_string())
}
fn ocr_record(v: &mut Value, source: &str, matched: usize, at: &str) {
    ocr_bump(v, matched);
    if let Some(sources) = v["sources"].as_object_mut() {
        let bucket = sources
            .entry(source.to_string())
            .or_insert_with(|| json!({"scans":0,"hits":0,"names":0}));
        ocr_bump(bucket, matched);
    }
    let day = local_day(at);
    if let Some(days) = v["byDay"].as_object_mut() {
        let bucket = days
            .entry(day)
            .or_insert_with(|| json!({"scans":0,"hits":0,"names":0}));
        ocr_bump(bucket, matched);
    }
    if !at.is_empty() {
        v["lastAt"] = json!(at);
    }
}
fn ocr_field<'a>(message: &'a str, key: &str) -> Option<&'a str> {
    let rest = message.get(message.find(key)? + key.len()..)?;
    let end = rest.find(' ').unwrap_or(rest.len());
    Some(&rest[..end])
}
// Logs rotate, so counts live in their own file; the first read seeds it from the
// retained logs, later reads only append to what is already counted.
fn ocr_backfill(logs: &Path) -> Value {
    let mut v = ocr_stats_empty();
    for name in ["collector.previous.jsonl", "collector.jsonl"] {
        let Ok(text) = fs::read_to_string(logs.join(name)) else {
            continue;
        };
        for line in text.lines() {
            if !line.contains("ocr-scan") {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if entry["event"] != "ocr-scan" {
                continue;
            }
            let message = entry["message"].as_str().unwrap_or_default();
            let source = ocr_field(message, "source=").unwrap_or("unknown");
            let matched = ocr_field(message, "matched=")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let at = entry["at"].as_str().unwrap_or_default();
            ocr_record(&mut v, source, matched, at);
        }
    }
    v
}
fn read_ocr_stats(logs: &Path) -> Value {
    let path = logs.join(OCR_STATS_FILE);
    if let Some(v) = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        if v.is_object() {
            return v;
        }
    }
    let v = ocr_backfill(logs);
    let _ = fs::write(
        &path,
        serde_json::to_string_pretty(&v).unwrap_or_else(|_| ocr_stats_empty().to_string()),
    );
    v
}
pub(crate) fn record_ocr_scan(logs: &Path, source: &str, matched: usize) {
    let mut v = read_ocr_stats(logs);
    ocr_record(&mut v, source, matched, &now());
    let text = serde_json::to_string_pretty(&v).unwrap_or_else(|_| ocr_stats_empty().to_string());
    let _ = fs::write(logs.join(OCR_STATS_FILE), text);
}
#[tauri::command]
pub fn ocr_stats(app: AppHandle) -> Result<Value, String> {
    let (_, logs) = directories(&app)?;
    Ok(read_ocr_stats(&logs))
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
                Err(ApiError::Http(404)) if quiet => {}
                Err(error) => warnings.push(format!("LCU end-of-game: {error}")),
            }
            // 赛后补录：EOG 里读不到挂到人身上的海克斯时，改从客户端比赛历史取本局的。
            // Lobby recovery must not depend on EOG still existing. An explicit
            // target ID is required; the frontend separately retries older archives.
            let target = game_id(&session).or_else(|| game_id(&eog));
            let matching_eog = target.is_some() && game_id(&eog) == target;
            if should_fetch_history(phase, target.as_deref(), &eog) {
                match get_json(
                    &client,
                    Some(c),
                    "/lol-match-history/v1/products/lol/current-summoner/matches?begin=0&count=5",
                    deadline,
                )
                .await
                {
                    Ok(value) => history = value,
                    Err(error) => warnings.push(format!("LCU match history: {error}")),
                }
            }
            if matching_eog
                || target
                    .as_deref()
                    .is_some_and(|game| matching_history(&history, game).is_some())
            {
                match get_json(
                    &client,
                    Some(c),
                    "/lol-summoner/v1/current-summoner",
                    deadline,
                )
                .await
                {
                    Ok(value) => summoner = value,
                    Err(error) => warnings.push(format!("LCU current summoner: {error}")),
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
    let mut result = outcome(&live, &session, &eog, &summoner, &observed_at);
    let matched_history = game
        .as_deref()
        .and_then(|game| matching_history(&history, game));
    if result["status"] == "unknown" {
        if let (Some(game), Some(history)) = (game.as_deref(), matched_history) {
            result = history_outcome(history, game, &summoner, &observed_at);
        }
    }
    // 结束阶段自动补上一局：把 EOG / 比赛历史读到的海克斯按身份归到玩家名下。
    let post_game = postgame_augments(&eog, &history, game.as_deref());
    // Preserve history-only evidence too, so local rescans remain useful offline.
    if eog.is_null() {
        if let Some(history) = matched_history {
            eog = history.clone();
        }
    }
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

    #[test]
    fn rescan_unions_equal_shorter_and_superset_evidence_for_trusted_players() {
        for key in ["Player#AA", "unique-weak-name", "path:/teams[0]/players[0]"] {
            let stored = json!({"players":[{"key":key,"champion":"Ahri","team":"ORDER","augments":["A","B"]}]});
            for observed in [json!(["A", "C"]), json!(["C"]), json!(["A", "B", "C", "C"])] {
                let fresh = json!({"players":[{"key":key,"champion":"Ahri","team":"ORDER","augments":observed}]});
                let merged = merge_postgame_entries(&stored, &fresh);
                assert_eq!(merged["players"].as_array().unwrap().len(), 1);
                assert_eq!(merged["players"][0]["augments"], json!(["A", "B", "C"]));
                assert_eq!(merge_postgame_entries(&fresh, &stored), merged);
            }
        }
        // A complete Riot ID remains a reliable anchor when metadata is missing.
        let stored = json!({"players":[{"key":"Player#AA","augments":["A","B"]}]});
        let fresh = json!({"players":[{"key":"Player#AA","augments":["C"]}]});
        assert_eq!(
            merge_postgame_entries(&stored, &fresh)["players"][0]["augments"],
            json!(["A", "B", "C"])
        );
    }

    #[test]
    fn rescan_withholds_identity_metadata_conflicts_and_unanchored_weak_unions() {
        for key in ["Player#AA", "duplicate", "path:/teams[0]/players[0]"] {
            let stored =
                json!({"players":[{"key":key,"champion":"Ahri","team":"ORDER","augments":["A"]}]});
            for (champion, team) in [("Jinx", "ORDER"), ("Ahri", "CHAOS")] {
                let conflicting = json!({"players":[{"key":key,"champion":champion,"team":team,"augments":["B"]}]});
                assert!(merge_postgame_entries(&stored, &conflicting).is_null());
                assert!(merge_postgame_entries(&conflicting, &stored).is_null());
            }
        }
        let stored = json!({"players":[{"key":"duplicate","augments":["A","B"]}]});
        let fresh = json!({"players":[{"key":"duplicate","augments":["A","C"]}]});
        assert!(merge_postgame_entries(&stored, &fresh).is_null());
        // Rejecting an unsafe identity does not drop a different safe player.
        let fresh = json!({"players":[{"key":"duplicate","augments":["C"]},{"key":"Other#AA","augments":["D"]}]});
        let merged = merge_postgame_entries(&stored, &fresh);
        assert_eq!(
            merged["players"],
            json!([{"key":"Other#AA","augments":["D"]}])
        );
    }

    #[test]
    fn rescan_paths_require_independent_complete_unique_metadata_in_every_source() {
        let key = "path:/teams[0]/players[0]";
        let stored =
            json!({"players":[{"key":key,"champion":"Ahri","team":"ORDER","augments":["A"]}]});
        for partial in [
            json!({"key":key,"champion":"Ahri","augments":["A","B"]}),
            json!({"key":key,"team":"ORDER","augments":["A","B"]}),
            json!({"key":key,"champion":"Ahri","team":"","augments":["A","B"]}),
        ] {
            let fresh = json!({"players":[partial]});
            assert!(merge_postgame_entries(&stored, &fresh).is_null());
            assert!(merge_postgame_entries(&fresh, &stored).is_null());
        }
        // Even matching metadata cannot make a path unique among twins in its
        // source. Preserve the independent sibling, but reject the merged path.
        let twins = json!({"players":[
            {"key":key,"champion":"Ahri","team":"ORDER","augments":["B"]},
            {"key":"path:/teams[0]/players[1]","champion":"Ahri","team":"ORDER","augments":["C"]}
        ]});
        let merged = merge_postgame_entries(&stored, &twins);
        assert_eq!(merged["players"].as_array().unwrap().len(), 1);
        assert_eq!(merged["players"][0]["key"], "path:/teams[0]/players[1]");
        assert_eq!(merge_postgame_entries(&twins, &stored), merged);

        // Exercise the raw scanner too: no team in the second response may not
        // inherit the first response's ORDER through the same array position.
        let eog = json!({"gameId":222,"teams":[{"teamId":100,"players":[
            {"summonerName":"#","championName":"Ahri","augments":[1001]}
        ]}]});
        let history = json!({"gameId":222,"teams":[{"players":[
            {"summonerName":"#","championName":"Ahri","augments":[1001,1002]}
        ]}]});
        assert!(postgame_augments(&eog, &history, Some("222")).is_null());
    }

    #[test]
    fn rescan_weak_supersets_never_borrow_metadata_from_another_record() {
        let stored = json!({"players":[{"key":"duplicate","champion":"Ahri","team":"ORDER","augments":["A"]}]});
        let fresh = json!({"players":[{"key":"duplicate","champion":"Ahri","augments":["A","B"]}]});
        let merged = merge_postgame_entries(&stored, &fresh);
        assert_eq!(merged["players"], fresh["players"]);
        assert!(merged["players"][0].get("team").is_none());
        assert_eq!(merge_postgame_entries(&fresh, &stored), merged);
        let equal = json!({"players":[{"key":"duplicate","champion":"Ahri","augments":["A"]}]});
        assert!(merge_postgame_entries(&stored, &equal).is_null());
        assert!(merge_postgame_entries(&equal, &stored).is_null());
    }

    #[test]
    fn rescan_groups_all_sources_before_union_or_conflict_rejection() {
        let first = json!({"players":[{"key":"Player#AA","champion":"Ahri","team":"ORDER","augments":["A"]}]});
        let second = json!({"players":[{"key":"Player#AA","champion":"Ahri","team":"ORDER","augments":["B"]}]});
        let third = json!({"players":[{"key":"Player#AA","champion":"Ahri","team":"ORDER","augments":["C"]}]});
        let conflict = json!({"players":[{"key":"Player#AA","champion":"Jinx","team":"CHAOS","augments":["B"]}]});
        for sources in [
            [&first, &second, &third],
            [&third, &first, &second],
            [&second, &third, &first],
        ] {
            assert_eq!(
                merge_postgame_sources(&sources)["players"][0]["augments"],
                json!(["A", "B", "C"])
            );
        }
        for sources in [
            [&first, &conflict, &third],
            [&third, &first, &conflict],
            [&conflict, &third, &first],
        ] {
            assert!(merge_postgame_sources(&sources).is_null());
        }

        let mut session = recovery_session();
        session["endOfGame"] = json!({"gameId":222,"players":[
            {"riotId":"Tester#AA","championName":"Ahri","teamId":100,"augments":[1001]}
        ]});
        let eog = json!({"gameId":222,"players":[
            {"riotId":"Tester#AA","championName":"Jinx","teamId":200,"augments":[1002]}
        ]});
        // The matching history is a third source for Tester#AA. It must not
        // resurrect the identity rejected by the stored/fresh EOG conflict.
        let recovered = recovery_payload(
            &session,
            &eog,
            &history_fixture(),
            &own_summoner(),
            "now",
            vec![],
        );
        assert!(recovered["players"].as_array().unwrap().is_empty());
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
    fn postgame_identity_prefers_complete_riot_ids_to_weak_names() {
        for (record, expected) in [
            (
                json!({"riotId":"Same#A","summonerName":"Same","riotIdGameName":"Other","riotIdTagLine":"B"}),
                "same#a",
            ),
            (
                json!({"riotId":"Same","summonerName":"Same","riotIdGameName":"Same","riotIdTagLine":"B"}),
                "same#b",
            ),
            (
                json!({"riotId":"#","summonerName":"Same","gameName":"Same","tagLine":"C"}),
                "same#c",
            ),
            (json!({"summonerName":"Unique"}), "unique"),
        ] {
            assert_eq!(
                identity_of(record.as_object().unwrap()).as_deref(),
                Some(expected)
            );
        }
    }

    #[test]
    fn postgame_scan_keeps_same_names_with_distinct_riot_ids_separate() {
        let eog = json!({"teams":[
            {"teamId":100,"players":[{"summonerName":"Same","riotId":"Same#A","championName":"Ahri","augments":[1001]}]},
            {"teamId":200,"players":[{"summonerName":"Same","riotIdGameName":"Same","riotIdTagLine":"B","championName":"Ahri","augments":[1002]}]}
        ]});
        let original = eog.clone();
        let post = postgame_augments(&eog, &Value::Null, None);
        let players = post["players"].as_array().unwrap();
        assert_eq!(players.len(), 2);
        let own = players
            .iter()
            .find(|entry| entry["key"] == "same#a")
            .unwrap();
        let enemy = players
            .iter()
            .find(|entry| entry["key"] == "same#b")
            .unwrap();
        assert_eq!(own["augments"], json!(["泰坦的坚决"]));
        assert_eq!(own["team"], "ORDER");
        assert_eq!(enemy["augments"], json!(["尖端发明家"]));
        assert_eq!(enemy["team"], "CHAOS");
        assert_eq!(eog, original);
    }

    #[test]
    fn postgame_duplicate_weak_names_remain_separate_for_masked_player_attribution() {
        let eog = json!({"teams":[
            {"teamId":100,"players":[{"summonerName":"Duplicate","championName":"Ahri","stats":{"PLAYER_AUGMENT_1":1001}}]},
            {"teamId":200,"players":[{"summonerName":"Duplicate","championName":"Jinx","stats":{"PLAYER_AUGMENT_1":1002}}]}
        ]});
        let post = postgame_augments(&eog, &Value::Null, None);
        let players = post["players"].as_array().unwrap();
        assert_eq!(players.len(), 2);
        let own = players
            .iter()
            .find(|entry| entry["team"] == "ORDER")
            .unwrap();
        let enemy = players
            .iter()
            .find(|entry| entry["team"] == "CHAOS")
            .unwrap();
        assert_eq!(own["key"], "path:/teams[0]/players[0]");
        assert_eq!(own["champion"], "Ahri");
        assert_eq!(own["augments"], json!(["泰坦的坚决"]));
        assert_eq!(enemy["key"], "path:/teams[1]/players[0]");
        assert_eq!(enemy["champion"], "Jinx");
        assert_eq!(enemy["augments"], json!(["尖端发明家"]));
        assert!(!players.iter().any(|entry| entry["key"] == "duplicate"));
        // Even identical metadata cannot justify collapsing distinct weak records:
        // the frontend must reject non-unique champion/team attribution instead.
        let mut twins = eog.clone();
        twins["teams"][1]["teamId"] = json!(100);
        twins["teams"][1]["players"][0]["championName"] = json!("Ahri");
        let post = postgame_augments(&twins, &Value::Null, None);
        assert_eq!(post["players"].as_array().unwrap().len(), 2);
        assert!(post["players"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["augments"].as_array().unwrap().len() == 1));
    }

    #[test]
    fn postgame_nested_fields_keep_the_same_record_and_strong_conflicts_are_withheld() {
        let eog = json!({"players":[{"summonerName":"Unique","championName":"Ahri","teamId":100,
            "augments":[1001],"stats":{"summonerName":"Unique","augments":[1002]}}]});
        let post = postgame_augments(&eog, &Value::Null, None);
        assert_eq!(post["players"].as_array().unwrap().len(), 1);
        assert_eq!(post["players"][0]["key"], "unique");
        assert_eq!(post["players"][0]["augments"].as_array().unwrap().len(), 2);
        for (champion, team) in [("Jinx", 100), ("Ahri", 200)] {
            let conflict = json!({"players":[
                {"riotId":"Player#AA","championName":"Ahri","teamId":100,"augments":[1001]},
                {"riotId":"Player#AA","championName":champion,"teamId":team,"augments":[1002]}
            ]});
            assert!(postgame_augments(&conflict, &Value::Null, None).is_null());
        }
        // Conflicting nested metadata must not be hidden by keeping the first value.
        let conflict = json!({"riotId":"Player#AA","championName":"Ahri","teamId":100,
            "augments":[1001],"stats":{"championName":"Jinx","augments":[1002]}});
        assert!(postgame_augments(&conflict, &Value::Null, None).is_null());
    }

    #[test]
    fn postgame_cross_source_array_positions_never_establish_player_identity() {
        let eog = json!({"gameId":222,"teams":[
            {"teamId":100,"players":[{"summonerName":"#","championName":"Ahri","augments":[1001]}]},
            {"teamId":200,"players":[{"summonerName":"#","championName":"Jinx","augments":[1002]}]}
        ]});
        let history = json!({"gameId":222,"teams":[
            {"teamId":200,"players":[{"summonerName":"#","championName":"Jinx","augments":[1067]}]},
            {"teamId":100,"players":[{"summonerName":"#","championName":"Ahri","augments":[1002]}]}
        ]});
        // Same temporary paths now mean different players. Withhold rather than
        // union their evidence under the first response's champion/team.
        assert!(postgame_augments(&eog, &history, Some("222")).is_null());
        let mut identified_eog = eog;
        identified_eog["teams"][0]["players"][0]["riotId"] = json!("First#AA");
        identified_eog["teams"][1]["players"][0]["riotId"] = json!("Second#AA");
        let mut identified_history = history;
        identified_history["teams"][0]["players"][0]["riotId"] = json!("Second#AA");
        identified_history["teams"][1]["players"][0]["riotId"] = json!("First#AA");
        let post = postgame_augments(&identified_eog, &identified_history, Some("222"));
        let players = post["players"].as_array().unwrap();
        assert_eq!(players.len(), 2);
        let first = players
            .iter()
            .find(|entry| entry["key"] == "first#aa")
            .unwrap();
        let second = players
            .iter()
            .find(|entry| entry["key"] == "second#aa")
            .unwrap();
        assert_eq!(first["champion"], "Ahri");
        assert_eq!(first["augments"], json!(["尖端发明家", "泰坦的坚决"]));
        assert_eq!(second["champion"], "Jinx");
        assert_eq!(second["augments"], json!(["尖端发明家", "活力焕发"]));
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
        let session = json!({"matchId":"1","endOfGame":{"gameId":1,"teams":[{"teamId":100,"players":[
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

    fn history_fixture() -> Value {
        json!({"gameId":222,
            "participantIdentities":[{"participantId":1,"player":{"summonerId":42,"gameName":"Tester","tagLine":"AA"}}],
            "participants":[{"participantId":1,"championId":103,"teamId":100,
                "stats":{"win":true,"playerAugment1":1001,"playerAugment2":1002}}]})
    }

    fn recovery_session() -> Value {
        json!({"matchId":"222","ownPlayerId":"Tester#AA"})
    }

    fn own_summoner() -> Value {
        json!({"summonerId":42,"gameName":"Tester","tagLine":"AA"})
    }

    #[test]
    fn direct_history_root_joins_unique_participants_and_resolves_official_champion_id() {
        let history = history_fixture();
        let payload = recovery_payload(
            &recovery_session(),
            &Value::Null,
            &history,
            &own_summoner(),
            "now",
            vec![],
        );
        assert_eq!(payload["gameId"], "222");
        assert_eq!(payload["endOfGame"], history);
        assert_eq!(payload["evidenceSource"], "lcu-match-history");
        assert_eq!(payload["result"]["status"], "win");
        assert_eq!(payload["result"]["source"], "lcu-history");
        assert_eq!(payload["players"][0]["key"], "tester#aa");
        assert_eq!(payload["players"][0]["champion"], "Ahri");
        assert_eq!(payload["players"][0]["team"], "ORDER");
        assert_eq!(
            payload["players"][0]["augments"].as_array().unwrap().len(),
            2
        );
        // Saving the original history also supports an offline rescan.
        let mut session = recovery_session();
        session["endOfGame"] = payload["endOfGame"].clone();
        assert_eq!(postgame_entries(session)["players"], payload["players"]);
    }

    #[test]
    fn malformed_success_responses_are_not_evidence_or_panics() {
        for malformed in [
            Value::Null,
            json!("unavailable"),
            json!(false),
            json!(42),
            json!([]),
            json!({"participants":"invalid"}),
        ] {
            assert_eq!(history_participants(&malformed), malformed);
            assert!(postgame_augments(&malformed, &Value::Null, None).is_null());
            let payload = recovery_payload(
                &recovery_session(),
                &malformed,
                &malformed,
                &Value::Null,
                "now",
                vec![],
            );
            assert!(payload["endOfGame"].is_null());
            assert_eq!(payload["players"], json!([]));
        }
    }

    #[test]
    fn recovery_rejects_new_game_eog_and_stored_mismatch_while_using_old_game_history() {
        let mut wrong = json!({"gameId":333,"teams":[{"players":[{"summonerName":"Wrong","augments":[1003]}]}]});
        let mut session = recovery_session();
        session["endOfGame"] = wrong.clone();
        let payload = recovery_payload(
            &session,
            &wrong,
            &history_fixture(),
            &own_summoner(),
            "now",
            vec![],
        );
        assert_eq!(payload["endOfGame"]["gameId"], 222);
        assert_eq!(payload["players"].as_array().unwrap().len(), 1);
        assert_eq!(payload["players"][0]["key"], "tester#aa");
        assert_eq!(payload["warnings"].as_array().unwrap().len(), 2);
        assert!(postgame_entries(session).is_null());
        wrong.as_object_mut().unwrap().remove("gameId");
        assert!(postgame_entries(json!({"matchId":"222","endOfGame":wrong})).is_null());
    }

    #[test]
    fn recovery_never_trusts_missing_invalid_or_conflicting_history_ids() {
        let history = history_fixture();
        let mut conflict = history.clone();
        conflict["participants"][0]["stats"]["win"] = json!(false);
        for value in [
            json!({"games":[history.clone(),conflict]}),
            json!({"gameId":333,"nested":history.clone()}),
            json!({"participants":history["participants"]}),
        ] {
            let payload = recovery_payload(
                &recovery_session(),
                &Value::Null,
                &value,
                &own_summoner(),
                "now",
                vec![],
            );
            assert!(payload["endOfGame"].is_null());
            assert_eq!(payload["players"], json!([]));
            assert_eq!(payload["result"]["status"], "unknown");
        }
        let payload = recovery_payload(
            &json!({"matchId":"../../other"}),
            &history,
            &history,
            &own_summoner(),
            "now",
            vec![],
        );
        assert!(payload["gameId"].is_null());
        assert_eq!(payload["players"], json!([]));
    }

    #[test]
    fn recovery_rejects_explicit_conflicting_or_invalid_game_id_fields() {
        for nested_id in [json!(333), json!(null), json!(0), json!("invalid")] {
            let mut evidence = history_fixture();
            evidence["gameData"] = json!({"gameId":nested_id});
            assert!(game_id(&evidence).is_none());
            assert!(matching_history(&evidence, "222").is_none());
            let session = json!({"matchId":"222","ownPlayerId":"Tester#AA","endOfGame":evidence});
            assert!(postgame_entries(session.clone()).is_null());
            let payload = recovery_payload(
                &session,
                &evidence,
                &evidence,
                &own_summoner(),
                "now",
                vec![],
            );
            assert!(payload["endOfGame"].is_null());
            assert_eq!(payload["players"], json!([]));
            assert_eq!(payload["result"]["status"], "unknown");
        }
        // A nested otherwise-valid game must not escape an invalid outer ID.
        let wrapper = json!({"gameId":"invalid","gameData":history_fixture()});
        assert!(matching_history(&wrapper, "222").is_none());
        assert_eq!(
            game_id(&json!({"gameId":"222","gameData":{"gameId":222}})).as_deref(),
            Some("222")
        );
    }

    #[test]
    fn history_result_requires_unique_identity_and_explicit_nonconflicting_boolean() {
        let original = history_fixture();
        assert_eq!(
            history_outcome(&original, "222", &own_summoner(), "now")["status"],
            "win"
        );
        let mut variants = Vec::new();
        let mut value = original.clone();
        value["participantIdentities"]
            .as_array_mut()
            .unwrap()
            .push(original["participantIdentities"][0].clone());
        variants.push(value);
        let mut value = original.clone();
        value["participants"]
            .as_array_mut()
            .unwrap()
            .push(original["participants"][0].clone());
        variants.push(value);
        let mut value = original.clone();
        value["participants"][0]["summonerId"] = json!(999);
        variants.push(value);
        let mut value = original.clone();
        value["participants"][0]["win"] = json!(false);
        variants.push(value);
        let mut value = original.clone();
        value["participants"][0]["stats"]["win"] = json!("Win");
        variants.push(value);
        let mut value = original.clone();
        value["participantIdentities"][0]["player"]["summonerId"] = json!(999);
        variants.push(value);
        for value in variants {
            assert_eq!(
                history_outcome(&value, "222", &own_summoner(), "now")["status"],
                "unknown"
            );
        }
        assert_eq!(
            history_outcome(&original, "333", &own_summoner(), "now")["status"],
            "unknown"
        );
    }

    #[test]
    fn archive_result_is_unknown_after_account_change_or_with_masked_owner() {
        for own in ["Different#AA", "masked:ORDER:0", "#", "Tester"] {
            let mut session = recovery_session();
            session["ownPlayerId"] = json!(own);
            // Even a visible activePlayer may not override an explicit archived owner.
            session["liveData"] = json!({"activePlayer":{"riotId":"Tester#AA"}});
            let payload = recovery_payload(
                &session,
                &Value::Null,
                &history_fixture(),
                &own_summoner(),
                "now",
                vec![],
            );
            assert_eq!(payload["result"]["status"], "unknown");
            assert_eq!(payload["players"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn lobby_history_recovery_does_not_depend_on_eog_being_available() {
        assert!(should_fetch_history("Lobby", Some("222"), &Value::Null));
        assert!(should_fetch_history("EndOfGame", Some("222"), &Value::Null));
        assert!(!should_fetch_history("Lobby", None, &Value::Null));
        assert!(!should_fetch_history(
            "InProgress",
            Some("222"),
            &Value::Null
        ));
        let eog = json!({"gameId":333,"players":[{"summonerName":"Other","augments":[1001]}]});
        assert!(should_fetch_history("Lobby", Some("222"), &eog));
        assert!(!should_fetch_history("Lobby", Some("333"), &eog));
    }

    #[test]
    fn recovery_endpoint_failures_keep_safe_statuses_and_retry_via_history_once() {
        let mut responses = VecDeque::from([
            Err(ApiError::Http(404)),
            Err(ApiError::Http(500)),
            Err(ApiError::Http(503)),
        ]);
        let mut paths = Vec::new();
        let fetched = tauri::async_runtime::block_on(fetch_recovery("222", &Value::Null, |path| {
            paths.push(path);
            std::future::ready(responses.pop_front().unwrap())
        }));
        assert_eq!(paths.len(), 3);
        assert!(paths[1].ends_with("/games/222"));
        assert!(paths[2].contains("current-summoner/matches"));
        assert_eq!(
            fetched.3,
            vec![
                "LCU end-of-game: http-status-404",
                "LCU match history direct: http-status-500",
                "LCU match history recent: http-status-503"
            ]
        );
        let payload = recovery_payload(
            &recovery_session(),
            &fetched.0,
            &fetched.1,
            &fetched.2,
            "now",
            fetched.3,
        );
        assert_eq!(payload["players"], json!([]));
        assert_eq!(payload["warnings"].as_array().unwrap().len(), 3);
        assert_eq!(payload["result"]["status"], "unknown");
    }

    #[test]
    fn recovery_direct_history_success_skips_recent_window_and_recovers_result() {
        let mut responses = VecDeque::from([
            Err(ApiError::Http(404)),
            Ok(history_fixture()),
            Ok(own_summoner()),
        ]);
        let mut paths = Vec::new();
        let fetched = tauri::async_runtime::block_on(fetch_recovery("222", &Value::Null, |path| {
            paths.push(path);
            std::future::ready(responses.pop_front().unwrap())
        }));
        assert_eq!(paths.len(), 3);
        assert!(paths[2].ends_with("/current-summoner"));
        let payload = recovery_payload(
            &recovery_session(),
            &fetched.0,
            &fetched.1,
            &fetched.2,
            "now",
            fetched.3,
        );
        assert_eq!(payload["result"]["status"], "win");
    }

    #[test]
    fn recovery_uses_recent_history_when_direct_endpoint_is_unavailable() {
        let mut responses = VecDeque::from([
            Err(ApiError::Http(404)),
            Err(ApiError::Http(404)),
            Ok(json!({"games":{"games":[{"gameId":999},history_fixture()]}})),
            Ok(own_summoner()),
        ]);
        let mut count = 0;
        let fetched = tauri::async_runtime::block_on(fetch_recovery("222", &Value::Null, |_| {
            count += 1;
            std::future::ready(responses.pop_front().unwrap())
        }));
        assert_eq!(count, 4);
        let payload = recovery_payload(
            &recovery_session(),
            &fetched.0,
            &fetched.1,
            &fetched.2,
            "now",
            fetched.3,
        );
        assert_eq!(payload["result"]["status"], "win");
    }

    #[test]
    fn recovery_does_not_retry_authorization_rate_limit_or_exhausted_budget() {
        for error in [
            ApiError::Http(401),
            ApiError::Http(403),
            ApiError::Http(429),
            ApiError::Budget,
        ] {
            let mut count = 0;
            let fetched =
                tauri::async_runtime::block_on(fetch_recovery("222", &Value::Null, |_| {
                    count += 1;
                    std::future::ready(Err(error))
                }));
            assert_eq!(count, 1);
            assert_eq!(fetched.3, vec![format!("LCU end-of-game: {error}")]);
        }
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
    fn correlated_live_game_end_retains_the_canonical_session_id() {
        let session = json!({"gameData":{"gameId":123}});
        for phase in ["InProgress", "EndOfGame"] {
            let mut live = live("Win");
            let mut eog = Value::Null;
            let mut warnings = Vec::new();
            assert_eq!(
                correlate_payloads(phase, true, &session, &mut live, &mut eog, &mut warnings)
                    .as_deref(),
                Some("123")
            );
            let result = outcome(&live, &session, &eog, &Value::Null, "now");
            assert_eq!(result["status"], "win");
            assert_eq!(result["gameId"], "123");
        }
        let mut wrong = live("Win");
        wrong["gameData"] = json!({"gameId":999});
        assert_eq!(
            outcome(&wrong, &session, &Value::Null, &Value::Null, "now")["status"],
            "unknown"
        );
        let mut eog = Value::Null;
        correlate_payloads(
            "EndOfGame",
            true,
            &session,
            &mut wrong,
            &mut eog,
            &mut Vec::new(),
        );
        assert!(wrong.is_null());
        assert_eq!(
            outcome(&wrong, &session, &eog, &Value::Null, "now")["status"],
            "unknown"
        );
    }

    #[test]
    fn live_result_does_not_borrow_an_unrelated_or_absent_game_id() {
        let session = json!({"gameId":123});
        let mut stale = live("Win");
        let mut eog = Value::Null;
        correlate_payloads(
            "Lobby",
            true,
            &session,
            &mut stale,
            &mut eog,
            &mut Vec::new(),
        );
        assert!(stale.is_null());
        assert_eq!(
            outcome(&stale, &session, &eog, &Value::Null, "now")["status"],
            "unknown"
        );
        let unassociated = outcome(
            &live("Win"),
            &Value::Null,
            &Value::Null,
            &Value::Null,
            "now",
        );
        assert_eq!(unassociated["status"], "win");
        assert!(unassociated.get("gameId").is_none());
        // Old-archive recovery supplies no live payload and must not invent a result.
        assert_eq!(
            outcome(&Value::Null, &session, &Value::Null, &Value::Null, "now")["status"],
            "unknown"
        );
    }

    #[test]
    fn explicit_invalid_ids_cannot_be_treated_as_missing_live_or_session_ids() {
        for invalid in [
            json!({"gameId":123,"gameData":{"gameId":999}}),
            json!({"gameId":123,"gameData":{"gameId":null}}),
            json!({"gameId":"invalid"}),
        ] {
            let session = json!({"gameId":123});
            let mut invalid_live = live("Win");
            invalid_live
                .as_object_mut()
                .unwrap()
                .extend(invalid.as_object().unwrap().clone());
            assert_eq!(
                outcome(&invalid_live, &session, &Value::Null, &Value::Null, "now")["status"],
                "unknown"
            );
            let mut eog = Value::Null;
            correlate_payloads(
                "EndOfGame",
                true,
                &session,
                &mut invalid_live,
                &mut eog,
                &mut Vec::new(),
            );
            assert!(invalid_live.is_null());

            let mut valid_live_without_id = live("Win");
            assert_eq!(
                outcome(
                    &valid_live_without_id,
                    &invalid,
                    &Value::Null,
                    &Value::Null,
                    "now"
                )["status"],
                "unknown"
            );
            let mut eog = json!({"gameId":123});
            assert!(correlate_payloads(
                "EndOfGame",
                true,
                &invalid,
                &mut valid_live_without_id,
                &mut eog,
                &mut Vec::new()
            )
            .is_none());
            assert!(valid_live_without_id.is_null());
            assert!(eog.is_null());
        }
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
    #[test]
    fn ocr_stats_backfill_counts_then_only_increment() {
        let logs = TempLogs::new();
        let line = |at: &str, event: &str, message: &str| {
            format!(
                "{}\n",
                json!({"at":at,"level":"info","event":event,"message":message})
            )
        };
        fs::write(
            logs.0.join("collector.previous.jsonl"),
            line(
                "2026-10-03T02:00:00Z",
                "ocr-scan",
                "source=capture lines=14 matched=0 bytes=100 elapsed=800ms",
            ),
        )
        .unwrap();
        fs::write(
            logs.0.join("collector.jsonl"),
            format!(
                "{}{}{}",
                line(
                    "2026-10-04T03:00:00Z",
                    "ocr-scan",
                    "source=capture lines=14 matched=3 bytes=100 elapsed=800ms"
                ),
                line(
                    "2026-10-04T04:00:00Z",
                    "ocr-scan",
                    "source=file lines=9 matched=2 bytes=50 elapsed=10ms"
                ),
                line(
                    "2026-10-04T05:00:00Z",
                    "score-candidates",
                    "ids=2 champion=影流之主"
                )
            ),
        )
        .unwrap();
        let seeded = read_ocr_stats(&logs.0);
        assert_eq!(seeded["scans"], json!(3));
        assert_eq!(seeded["hits"], json!(2));
        assert_eq!(seeded["names"], json!(5));
        assert_eq!(seeded["sources"]["capture"]["scans"], json!(2));
        assert_eq!(seeded["sources"]["capture"]["hits"], json!(1));
        assert_eq!(seeded["sources"]["file"]["hits"], json!(1));
        assert_eq!(seeded["byDay"]["2026-10-03"]["scans"], json!(1));
        assert_eq!(seeded["byDay"]["2026-10-04"]["scans"], json!(2));
        assert_eq!(seeded["lastAt"], json!("2026-10-04T04:00:00Z"));
        // 第二次读取直接用已写好的文件，不重复回填日志。
        assert_eq!(read_ocr_stats(&logs.0)["scans"], json!(3));
        record_ocr_scan(&logs.0, "capture", 1);
        let after = read_ocr_stats(&logs.0);
        assert_eq!(after["scans"], json!(4));
        assert_eq!(after["hits"], json!(3));
        assert_eq!(after["names"], json!(6));
        // 统计文件损坏时按日志重建，不会把已经统计过的扫描再加一遍。
        fs::write(logs.0.join(OCR_STATS_FILE), "{broken").unwrap();
        assert_eq!(read_ocr_stats(&logs.0)["scans"], json!(3));
    }
}
