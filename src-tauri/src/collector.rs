//! Read-only, bounded local Riot lifecycle collection. No game automation.
use chrono::Utc;
use reqwest::{redirect::Policy, Client};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, VecDeque},
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
pub(crate) fn append_log(logs: &Path, level: &str, event: &str, message: &str) -> std::io::Result<()> {
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
        if end_phase(phase) {
            match get_json(
                &client,
                Some(c),
                "/lol-end-of-game/v1/eog-stats-block",
                deadline,
            )
            .await
            {
                Ok(value) => eog = value,
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
    let result = outcome(&live, &session, &eog, &summoner, &observed_at);
    if let Err(message) = log_poll(&app, connection, phase, &warnings) {
        warnings.push(message);
    }
    let mut snapshot = json!({
        "platformSupported":cfg!(target_os = "windows"),"connection":connection,"phase":phase,
        "gameId":game,"liveData":live,"lcuSession":session,"endOfGame":eog,
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
