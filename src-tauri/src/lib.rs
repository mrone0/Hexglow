pub mod app_icon;
pub mod capture;
pub mod collector;
pub mod decision;
pub mod desktop;
pub mod knowledge;
pub mod ocr;
pub mod overlay;
pub mod scoring;
mod seed_generated;
pub mod storage;

/// Compatibility commands retained for older clients. Analysis uses the same
/// validation, privacy filtering and scoring as the current command names.
pub mod backend {
    use reqwest::{redirect::Policy, Client};
    use rusqlite::Connection;
    use serde_json::Value;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    const LIVE: &str = "https://127.0.0.1:2999/liveclientdata/allgamedata";
    fn database(app: &AppHandle) -> Result<Connection, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let db = Connection::open(dir.join("sessions.sqlite3")).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at DESC,id DESC)")
            .map_err(|e| e.to_string())?;
        Ok(db)
    }

    // The old command returns the Live API object rather than a lifecycle
    // snapshot. Keep that contract until a shared collector primitive exists.
    #[tauri::command]
    pub async fn fetch_live() -> Result<Value, String> {
        Client::builder()
            .danger_accept_invalid_certs(true)
            .redirect(Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?
            .get(LIVE)
            .send()
            .await
            .map_err(|e| format!("无法连接本机游戏 API：{e}"))?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    #[tauri::command(async)]
    pub fn save_session(app: AppHandle, session: Value) -> Result<String, String> {
        crate::storage::save(&app, &session)
    }

    // Unlike list_sessions_light, this legacy API includes complete records
    // and empty drafts. Preserve its 100-record contract for older clients.
    #[tauri::command(async)]
    pub fn list_sessions(app: AppHandle) -> Result<Vec<Value>, String> {
        let db = database(&app)?;
        let mut query = db
            .prepare("SELECT data FROM sessions ORDER BY updated_at DESC,id DESC LIMIT 100")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }

    #[tauri::command]
    pub async fn analyze(request: Value) -> Result<Value, String> {
        crate::decision::analyze_structured(request).await
    }

    #[tauri::command]
    pub async fn test_model(model: Value) -> Result<Value, String> {
        crate::decision::test_provider(model).await
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread::{self, JoinHandle},
            time::Instant,
        };

        fn context() -> Value {
            json!({
                "ownPlayerId":"PRIVATE_PLAYER",
                "players":[
                    {"id":"PRIVATE_PLAYER","champion":"Ahri","team":"ORDER","augments":[],"augmentsConfirmed":false},
                    {"id":"other","champion":"Garen","team":"CHAOS","augments":[],"augmentsConfirmed":false}
                ],
                "candidates":[
                    {"id":"1","name":"unlisted-a","description":"first effect"},
                    {"id":"2","name":"unlisted-b","description":"second effect"}
                ],
                "liveData":{"private":"PRIVATE_LIVE_DATA"}
            })
        }

        // One bounded local HTTP exchange exercises the public command adapter
        // without requiring a real model service or an additional async crate.
        fn model_server(response: Value) -> (String, JoinHandle<(String, Value)>) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let handle = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "adapter never called model service"
                            );
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(e) => panic!("mock accept failed: {e}"),
                    }
                };
                // Windows 的 accept 可能继承监听器的 nonblocking 模式；
                // 后续读取使用明确的阻塞模式及超时，避免测试偶发 WouldBlock。
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                let header_end = loop {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0, "missing request headers");
                    bytes.extend_from_slice(&chunk[..n]);
                    assert!(bytes.len() < 1024 * 1024, "test request exceeds bound");
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                assert!(length < 1024 * 1024);
                while bytes.len() - header_end < length {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0, "missing request body");
                    bytes.extend_from_slice(&chunk[..n]);
                }
                let body = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
                };
                let serialized = response.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", serialized.len(), serialized).unwrap();
                (headers.lines().next().unwrap().to_owned(), body)
            });
            (base, handle)
        }

        fn chat_response(content: Value) -> Value {
            json!({"choices":[{"message":{"content":content.to_string()}}]})
        }

        #[test]
        fn legacy_recommendation_uses_structured_scores_and_private_context_filter() {
            let mut answers = json!({});
            for id in ["1", "2"] {
                for factor in ["championSynergy", "buildSynergy", "teamFit", "enemyFit"] {
                    answers[id][factor] = json!({"score":if id=="1"{4}else{0},"confidence":1});
                }
            }
            let (base, server) = model_server(chat_response(answers));
            let result = tauri::async_runtime::block_on(analyze(json!({
                "mode":"recommend","context":context(),"model":{"baseUrl":base,"name":"local"}
            })))
            .unwrap();
            let (method, sent) = server.join().unwrap();
            assert_eq!(method, "POST /v1/chat/completions HTTP/1.1");
            assert_eq!(result["ranking"][0]["candidateId"], "1");
            assert_eq!(result["ranking"][0]["score"], 100.0);
            assert_eq!(result["ranking"][1]["score"], 0.0);
            assert_eq!(result["ranking"][0]["factors"].as_array().unwrap().len(), 4);
            assert!(result["summary"].is_string());
            assert!(result["missingInformation"].as_array().unwrap().len() > 0);
            let prompt: Value =
                serde_json::from_str(sent["messages"][1]["content"].as_str().unwrap()).unwrap();
            assert_eq!(prompt["state"]["ownPlayerId"], "p1");
            assert_eq!(prompt["state"]["players"]["p1"]["augmentsConfirmed"], false);
            assert!(!sent.to_string().contains("PRIVATE_PLAYER"));
            assert!(!sent.to_string().contains("PRIVATE_LIVE_DATA"));
        }

        #[test]
        fn legacy_review_keeps_summary_lessons_and_caveats() {
            let (base, server) = model_server(chat_response(json!({"safe_decision":0.8})));
            let mut ctx = context();
            ctx["result"] = json!({"status":"win"});
            ctx["decisions"] = json!([{"chosenId":"1","context":context()}]);
            let result = tauri::async_runtime::block_on(analyze(json!({
                "mode":"review","context":ctx,"model":{"baseUrl":base,"name":"local"}
            })))
            .unwrap();
            server.join().unwrap();
            assert!(result["summary"].is_string());
            assert!(result["lessons"].is_array());
            assert!(result["caveats"].is_array());
        }

        #[test]
        fn legacy_model_test_defaults_to_openai_and_keeps_model_list_shape() {
            let (base, server) = model_server(json!({"data":[{"id":"local-a"},{"id":"local-b"}]}));
            let result =
                tauri::async_runtime::block_on(test_model(json!({"baseUrl":base}))).unwrap();
            let (method, _) = server.join().unwrap();
            assert_eq!(method, "GET /v1/models HTTP/1.1");
            assert_eq!(result["models"], json!(["local-a", "local-b"]));
            assert!(result["latencyMs"].is_number());
            assert!(result["note"].is_string());
        }

        #[test]
        fn legacy_commands_share_current_request_validation() {
            let requests = [
                json!({}),
                json!({"mode":"unsupported"}),
                json!({"mode":"recommend","context":{}}),
                json!({"mode":"recommend","context":context(),"model":{"provider":"unsupported"}}),
            ];
            for request in requests {
                let legacy = tauri::async_runtime::block_on(analyze(request.clone()));
                let current =
                    tauri::async_runtime::block_on(crate::decision::analyze_structured(request));
                assert!(legacy.is_err());
                assert_eq!(legacy, current);
            }
            let model = json!({"baseUrl":"http://example.test/v1"});
            let legacy = tauri::async_runtime::block_on(test_model(model.clone()));
            let current = tauri::async_runtime::block_on(crate::decision::test_provider(model));
            assert!(legacy.is_err());
            assert_eq!(legacy, current);
        }
    }
}
