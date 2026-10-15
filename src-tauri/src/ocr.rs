//! 海克斯卡片 OCR：Small 检测 + Tiny 快速识别，不可靠时回退 Small 识别。
//! 模型随安装包分发；启动时在后台预热，运行期间不下载模型。
use image::RgbImage;
use oar_ocr::core::config::{OrtExecutionProvider, OrtSessionConfig};
use oar_ocr::oarocr::{OAROCRBuilder, OAROCR};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
#[cfg(not(any(debug_assertions, test)))]
use tauri::Manager;

const DET_MODEL: &str = "pp-ocrv6_small_det.onnx";
const REC_MODEL: &str = "pp-ocrv6_small_rec.onnx";
const DICT_FILE: &str = "ppocrv6_dict.txt";
const FAST_REC_MODEL: &str = "pp-ocrv6_tiny_rec.onnx";
const FAST_DICT_FILE: &str = "ppocrv6_tiny_dict.txt";
const FAST_TITLE_CONFIDENCE: f32 = 0.95;
const MAX_OCR_THREADS: usize = 1;

// Sizes are pinned alongside SHA-256 in resources/ocr/manifest.json. The build
// script verifies hashes; checking file sizes here catches incomplete installs
// before ONNX Runtime produces an opaque model-loading error.
const MODEL_FILES: [(&str, u64); 5] = [
    (DET_MODEL, 9_880_512),
    (REC_MODEL, 21_159_378),
    (DICT_FILE, 74_947),
    (FAST_REC_MODEL, 4_462_639),
    (FAST_DICT_FILE, 27_156),
];
static MODEL_DIRECTORY: OnceLock<Result<PathBuf, String>> = OnceLock::new();

fn model_directory() -> Result<PathBuf, String> {
    if let Some(directory) = MODEL_DIRECTORY.get() {
        return directory.clone();
    }
    #[cfg(any(debug_assertions, test))]
    {
        Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ocr"))
    }
    #[cfg(not(any(debug_assertions, test)))]
    {
        Err("海克斯识别尚未初始化，请重启 Hexglow。".into())
    }
}

#[cfg(test)]
fn validate_model_files(directory: &Path) -> Result<(), String> {
    validate_files(directory, &MODEL_FILES)
}

fn validate_files(directory: &Path, files: &[(&str, u64)]) -> Result<(), String> {
    for &(name, expected_size) in files {
        let path = directory.join(name);
        let metadata = std::fs::metadata(&path).map_err(|error| {
            format!(
                "内置海克斯识别模型缺失或无法读取（{name}）：{error}。请重新安装完整安装包，个人数据会保留。"
            )
        })?;
        if !metadata.is_file() || metadata.len() != expected_size {
            return Err(format!(
                "内置海克斯识别模型不完整（{name}）。请重新安装完整安装包，个人数据会保留。"
            ));
        }
    }
    Ok(())
}

/// 在 setup 阶段调用一次。先固定安装资源路径，再异步加载模型；扫描和预热
/// 共用同一管线锁，不会同时创建两份模型，也不会阻塞主窗口的显示。
pub fn start_warmup(app: &tauri::AppHandle) {
    #[cfg(any(debug_assertions, test))]
    let directory = Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ocr"));
    #[cfg(not(any(debug_assertions, test)))]
    let directory = app
        .path()
        .resolve("resources/ocr", tauri::path::BaseDirectory::Resource)
        .map_err(|error| format!("无法定位内置海克斯识别模型：{error}"));
    if MODEL_DIRECTORY.set(directory).is_err() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _priority = crate::game_worker::GameWorkerPriority::enter();
        let started = Instant::now();
        crate::scoring::warmup_catalog();
        let result = with_pipeline(|pipeline| {
            if !INFERENCE_READY.load(Ordering::Acquire) {
                prime_pipeline(pipeline)?;
                INFERENCE_READY.store(true, Ordering::Release);
            }
            Ok(pipeline.fast.is_some())
        });
        WARMUP_FAILED.store(result.is_err(), Ordering::Release);
        if let Ok((_, logs)) = crate::collector::directories(&app) {
            let (level, message) = match result {
                Ok(fast_ready) => (
                    if fast_ready { "info" } else { "warn" },
                    format!(
                        "bundled models inference-ready fast={fast_ready} elapsed={}ms provider=cpu cpuThreads={} intraSpin=false interSpin=false shapes=2",
                        started.elapsed().as_millis(), available_ocr_threads()
                    ),
                ),
                Err(error) => ("error", error),
            };
            let _ = crate::collector::append_log(&logs, level, "ocr-warmup", &message);
        }
    });
}

#[derive(Debug, Clone, Serialize)]
pub struct TextLine {
    pub text: String,
    pub score: f32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

struct Pipelines {
    fast: Option<OAROCR>,
    fallback: OAROCR,
}
static PIPELINE: Mutex<Option<Pipelines>> = Mutex::new(None);
static INFERENCE_READY: AtomicBool = AtomicBool::new(false);
static WARMUP_FAILED: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct CaptureDiagnostics {
    last_skip: Option<&'static str>,
    logged_at: Option<Instant>,
}

impl CaptureDiagnostics {
    fn observe(&mut self, reason: Option<&'static str>, at: Instant) -> bool {
        if reason.is_none() {
            self.last_skip = None;
            return false;
        }
        if self.last_skip == reason
            || self.logged_at.is_some_and(|previous| {
                at.checked_duration_since(previous)
                    .is_none_or(|age| age < Duration::from_secs(10))
            })
        {
            return false;
        }
        self.last_skip = reason;
        self.logged_at = Some(at);
        true
    }
}
static CAPTURE_DIAGNOSTICS: Mutex<CaptureDiagnostics> = Mutex::new(CaptureDiagnostics {
    last_skip: None,
    logged_at: None,
});

fn capture_reason(value: &str) -> Option<&'static str> {
    match value {
        "game-window-not-found" => Some("game-window-not-found"),
        "game-window-hidden" => Some("game-window-hidden"),
        "game-window-minimized" => Some("game-window-minimized"),
        "game-not-foreground" => Some("game-not-foreground"),
        "unsupported-platform" => Some("unsupported-platform"),
        "ocr-warming-up" => Some("ocr-warming-up"),
        "ocr-initialization-failed" => Some("ocr-initialization-failed"),
        _ => None,
    }
}

/// Loading-time readiness check/retry; never queues warmup behind an active scan.
#[tauri::command]
pub async fn ocr_warmup() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _priority = crate::game_worker::GameWorkerPriority::enter();
        crate::scoring::warmup_catalog();
        if INFERENCE_READY.load(Ordering::Acquire) {
            return Ok(serde_json::json!({"status":"ready"}));
        }
        let mut guard = match PIPELINE.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Ok(serde_json::json!({"status":"busy"}))
            }
            Err(_) => {
                WARMUP_FAILED.store(true, Ordering::Release);
                return Err("OCR 管线状态异常".to_string());
            }
        };
        WARMUP_FAILED.store(false, Ordering::Release);
        let prepared = (|| {
            initialize_pipeline(&mut guard)?;
            if !INFERENCE_READY.load(Ordering::Acquire) {
                prime_pipeline(guard.as_ref().expect("pipeline initialized"))?;
                INFERENCE_READY.store(true, Ordering::Release);
            }
            Ok(serde_json::json!({"status":"ready"}))
        })();
        WARMUP_FAILED.store(prepared.is_err(), Ordering::Release);
        prepared
    })
    .await
    .map_err(|_| {
        WARMUP_FAILED.store(true, Ordering::Release);
        "OCR 预热任务失败".to_string()
    })?
}

#[derive(Clone)]
struct Recognition {
    lines: Vec<TextLine>,
    engine: &'static str,
    fallback_reason: &'static str,
    fast_ms: u128,
    fallback_ms: u128,
}
#[derive(Clone)]
struct FrameCache {
    image: RgbImage,
    result: Recognition,
    recognized: Instant,
}
static FRAME: Mutex<Option<FrameCache>> = Mutex::new(None);
static OCR_CPU_POOL: OnceLock<Result<rayon::ThreadPool, String>> = OnceLock::new();

/// 画面完全相同时复用识别结果，最多五秒；刷新后的新画面立即重识别。
fn recognize_capture_scoped(
    image: RgbImage,
    empty_fallback_due: bool,
    scope: Option<&str>,
    region: &crate::choice_region::ChoiceRegion,
) -> Result<(Recognition, bool), String> {
    let mut cache = FRAME.lock().map_err(|_| "OCR 截屏缓存异常")?;
    if let Some(result) = cache
        .as_ref()
        .and_then(|frame| cached_frame_result(frame, &image, Instant::now()))
    {
        observe_titles(scope, &image, &result, false);
        return Ok((result, true));
    }
    let result = with_pipeline(|pipeline| {
        recognize_choice_region(pipeline, &image, region, empty_fallback_due)
    })?;
    observe_titles(scope, &image, &result, true);
    *cache = Some(FrameCache {
        image,
        result: result.clone(),
        recognized: Instant::now(),
    });
    Ok((result, false))
}

fn cached_frame_result(frame: &FrameCache, image: &RgbImage, now: Instant) -> Option<Recognition> {
    let age = now.checked_duration_since(frame.recognized)?;
    // A deferred result must be freshly checked and must not suppress the
    // periodic Small safety pass even when every pixel stays unchanged.
    if frame.result.fallback_reason == "empty-fallback-deferred"
        || age >= Duration::from_secs(5)
        || &frame.image != image
    {
        return None;
    }
    let mut result = frame.result.clone();
    result.fast_ms = 0;
    result.fallback_ms = 0;
    Some(result)
}

fn build_pipeline(directory: &Path, fast: bool) -> Result<OAROCR, String> {
    OAROCRBuilder::new(
        directory.join(DET_MODEL),
        directory.join(if fast { FAST_REC_MODEL } else { REC_MODEL }),
        directory.join(if fast { FAST_DICT_FILE } else { DICT_FILE }),
    )
    .ort_session(ocr_session_config(available_ocr_threads()))
    .image_batch_size(1)
    // Keep the upstream CPU batch choices, but do not let every detector and
    // recognizer create a full-machine spinning pool while a game is running.
    .region_batch_size(if fast { 16 } else { 4 })
    .build()
    .map_err(|error| format!("OCR 模型加载失败：{error}"))
}

fn ocr_thread_budget(available: usize) -> usize {
    // Reserve CPU capacity for the game even on dual-core/low-quota machines.
    (available / 2).clamp(1, MAX_OCR_THREADS)
}

fn available_ocr_threads() -> usize {
    ocr_thread_budget(
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
    )
}

fn ocr_session_config(threads: usize) -> OrtSessionConfig {
    OrtSessionConfig::new()
        // Make the intended device explicit rather than relying on a dependency
        // default. CPU thread limits alone would not constrain an accelerator.
        .with_execution_providers(vec![OrtExecutionProvider::CPU])
        .with_intra_threads(threads.clamp(1, MAX_OCR_THREADS))
        .with_inter_threads(1)
        .with_parallel_execution(false)
        .add_config_entry("session.intra_op.allow_spinning", "0")
        .add_config_entry("session.inter_op.allow_spinning", "0")
}

fn ocr_cpu_pool() -> Result<&'static rayon::ThreadPool, String> {
    OCR_CPU_POOL
        .get_or_init(|| {
            // oar-ocr's resize/normalization/CTC decode also use Rayon. install()
            // keeps their nested parallel iterators in this private bounded pool;
            // no process-global Rayon settings or unrelated app tasks are changed.
            rayon::ThreadPoolBuilder::new()
                .num_threads(available_ocr_threads())
                .start_handler(|_| crate::game_worker::prepare_private_thread())
                .thread_name(|index| format!("hexglow-ocr-{index}"))
                .build()
                .map_err(|error| format!("OCR 工作线程初始化失败：{error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn with_pipeline<T>(run: impl FnOnce(&Pipelines) -> Result<T, String>) -> Result<T, String> {
    let mut guard = PIPELINE
        .lock()
        .map_err(|_| "OCR 管线状态异常".to_string())?;
    initialize_pipeline(&mut guard)?;
    let pipeline = guard.as_ref().expect("pipeline initialized above");
    run(pipeline)
}

fn initialize_pipeline(guard: &mut Option<Pipelines>) -> Result<(), String> {
    if guard.is_none() {
        let directory = model_directory()?;
        // Small remains usable if the optional fast recognizer cannot load.
        // Build/release verification still requires all five pinned resources.
        validate_files(&directory, &MODEL_FILES[..3])?;
        let fallback = build_pipeline(&directory, false)?;
        let fast = validate_files(&directory, &MODEL_FILES[3..])
            .and_then(|_| build_pipeline(&directory, true))
            .ok();
        *guard = Some(Pipelines { fast, fallback });
    }
    Ok(())
}

pub fn recognize_image(image: RgbImage) -> Result<Vec<TextLine>, String> {
    recognize_timed(image).map(|result| result.lines)
}

// Warm both detection AND recognition with bundled, synthetic text. A blank
// image only warms detection. This does not capture, publish, update FRAME,
// record candidates or invoke the recommendation service.
fn prime_pipeline(pipeline: &Pipelines) -> Result<(), String> {
    let image = image::load_from_memory(include_bytes!("../tests/fixtures/augment-card.png"))
        .map_err(|_| "OCR 预热样本无法读取".to_string())?
        .to_rgb8();
    // Warm the detector at the common 16:9 capture aspect as well as the small
    // fixture. A small-only warmup leaves the first real panel tensor shape cold.
    let panel = image::imageops::resize(&image, 2304, 748, image::imageops::FilterType::Nearest);
    for input in [image, panel] {
        for ocr in std::iter::once(&pipeline.fallback).chain(pipeline.fast.iter()) {
            let lines = predict_lines(ocr, input.clone())?;
            if lines.is_empty() {
                return Err("OCR 预热未产生文字结果".to_string());
            }
        }
    }
    Ok(())
}

/// Tiny may return only when the complete, unchanged panel matcher accepts
/// exactly the same three candidates from high-confidence exact title lines.
/// Never hide competing rows by cropping or truncating the original OCR input.
pub fn fast_panel_is_reliable(lines: &[TextLine]) -> bool {
    let candidates = crate::scoring::match_augments(lines);
    if candidates.len() != 3 {
        return false;
    }
    let exact: Vec<TextLine> = lines
        .iter()
        .filter(|line| {
            line.score.is_finite()
                && line.score >= FAST_TITLE_CONFIDENCE
                && crate::scoring::canonical_augment_exact(&line.text).is_some()
        })
        .cloned()
        .collect();
    let reliable = crate::scoring::match_augments(&exact);
    reliable.len() == 3 && candidates.iter().zip(&reliable).all(|(a, b)| a.id == b.id)
}

fn recognize_timed(image: RgbImage) -> Result<Recognition, String> {
    with_pipeline(|pipeline| recognize_with_pipeline(pipeline, image))
}

fn recognize_with_pipeline(pipeline: &Pipelines, image: RgbImage) -> Result<Recognition, String> {
    recognize_with_policy(pipeline, image, true)
}

fn recognize_with_policy(
    pipeline: &Pipelines,
    image: RgbImage,
    empty_fallback_due: bool,
) -> Result<Recognition, String> {
    if let Some(fast) = &pipeline.fast {
        recognize_with_fallback_policy(
            || predict_lines(fast, image.clone()),
            || predict_lines(&pipeline.fallback, image.clone()),
            empty_fallback_due,
        )
    } else {
        let started = Instant::now();
        let lines = predict_lines(&pipeline.fallback, image)?;
        Ok(Recognition {
            lines,
            engine: "small-det-small-rec",
            fallback_reason: "fast-unavailable",
            fast_ms: 0,
            fallback_ms: started.elapsed().as_millis(),
        })
    }
}

fn predict_region(
    ocr: &OAROCR,
    image: &RgbImage,
    region: &crate::choice_region::ChoiceRegion,
) -> Result<Vec<TextLine>, String> {
    let mut lines = predict_lines(ocr, region.input(image))?;
    for line in &mut lines {
        line.x += region.roi.x;
        line.y += region.roi.y;
    }
    Ok(lines)
}
fn recognize_choice_region(
    pipeline: &Pipelines,
    image: &RgbImage,
    region: &crate::choice_region::ChoiceRegion,
    empty_fallback_due: bool,
) -> Result<Recognition, String> {
    let body = region.full_cards();
    if let Some(fast) = &pipeline.fast {
        let located = std::cell::Cell::new(false);
        recognize_with_fallback_policy(
            || {
                let lines = predict_region(fast, image, region)?;
                located.set(crate::scoring::match_augments(&lines).len() == 3);
                Ok(lines)
            },
            || {
                predict_region(
                    &pipeline.fallback,
                    image,
                    if located.get() { region } else { &body },
                )
            },
            empty_fallback_due,
        )
    } else {
        let started = Instant::now();
        Ok(Recognition {
            lines: predict_region(&pipeline.fallback, image, &body)?,
            engine: "small-det-small-rec",
            fallback_reason: "fast-unavailable",
            fast_ms: 0,
            fallback_ms: started.elapsed().as_millis(),
        })
    }
}

#[cfg(test)]
fn recognize_with_fallback(
    fast: impl FnOnce() -> Result<Vec<TextLine>, String>,
    fallback: impl FnOnce() -> Result<Vec<TextLine>, String>,
) -> Result<Recognition, String> {
    recognize_with_fallback_policy(fast, fallback, true)
}

fn recognize_with_fallback_policy(
    fast: impl FnOnce() -> Result<Vec<TextLine>, String>,
    fallback: impl FnOnce() -> Result<Vec<TextLine>, String>,
    empty_fallback_due: bool,
) -> Result<Recognition, String> {
    let started = Instant::now();
    let fast_result = fast();
    let fast_ms = started.elapsed().as_millis();
    let reason = match fast_result {
        Ok(lines) if fast_panel_is_reliable(&lines) => {
            return Ok(Recognition {
                lines,
                engine: "small-det-tiny-rec",
                fallback_reason: "none",
                fast_ms,
                fallback_ms: 0,
            });
        }
        Ok(lines) if !empty_fallback_due && !crate::scoring::has_augment_title_hint(&lines) => {
            // Do not publish uncertain Tiny text or a partial/guessed panel.
            // The next capture remains fresh; periodic full fallback is kept.
            return Ok(Recognition {
                lines: Vec::new(),
                engine: "small-det-tiny-rec",
                fallback_reason: "empty-fallback-deferred",
                fast_ms,
                fallback_ms: 0,
            });
        }
        Ok(_) => "uncertain-panel",
        Err(_) => "fast-error",
    };
    let started = Instant::now();
    // Discard the entire fast result; never merge two passes into a false panel.
    let lines = fallback()?;
    Ok(Recognition {
        lines,
        engine: "small-det-small-rec",
        fallback_reason: reason,
        fast_ms,
        fallback_ms: started.elapsed().as_millis(),
    })
}

fn predict_lines(ocr: &OAROCR, image: RgbImage) -> Result<Vec<TextLine>, String> {
    let results = ocr_cpu_pool()?
        .install(|| ocr.predict(vec![image]))
        .map_err(|error| format!("OCR 识别失败：{error}"))?;
    let mut lines = Vec::new();
    for region in results.iter().flat_map(|result| result.text_regions.iter()) {
        let Some(text) = region.text.as_deref() else {
            continue;
        };
        let text = normalize(text);
        if text.is_empty() {
            continue;
        }
        let (x, y, width, height) = rect_of(region);
        lines.push(TextLine {
            text,
            score: region.confidence.unwrap_or(0.0),
            x,
            y,
            width,
            height,
        });
    }
    lines.sort_by(|left, right| (left.y, left.x).cmp(&(right.y, right.x)));
    Ok(lines)
}

pub fn recognize_png(png: &[u8]) -> Result<Vec<TextLine>, String> {
    let image = image::load_from_memory(png)
        .map_err(|error| format!("截图解码失败：{error}"))?
        .to_rgb8();
    recognize_image(image)
}

/// OCR 常见的零宽与方向控制字符，会打断名称匹配。
const OPAQUE: [char; 7] = [
    '\u{200b}', '\u{200c}', '\u{200d}', '\u{200e}', '\u{200f}', '\u{2060}', '\u{feff}',
];

fn normalize(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control() && !OPAQUE.contains(character))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn rect_of(region: &oar_ocr::oarocr::TextRegion) -> (u32, u32, u32, u32) {
    let points = &region.bounding_box.points;
    let Some((first, rest)) = points.split_first() else {
        return (0, 0, 0, 0);
    };
    let (mut min_x, mut max_x) = (first.x, first.x);
    let (mut min_y, mut max_y) = (first.y, first.y);
    for point in rest {
        min_x = min_x.min(point.x);
        max_x = max_x.max(point.x);
        min_y = min_y.min(point.y);
        max_y = max_y.max(point.y);
    }
    let x = min_x.max(0.0) as u32;
    let y = min_y.max(0.0) as u32;
    (
        x,
        y,
        max_x.max(min_x) as u32 - x,
        max_y.max(min_y) as u32 - y,
    )
}

#[tauri::command]
pub async fn ocr_scan(
    app: tauri::AppHandle,
    image_path: Option<String>,
    round_key: Option<String>,
    watch_candidate_ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _priority = crate::game_worker::GameWorkerPriority::enter();
        scan_and_log(app, image_path, round_key, watch_candidate_ids)
    })
    .await
    .map_err(|_| "OCR 后台任务异常".to_string())?
}

fn scan_and_log(
    app: tauri::AppHandle,
    image_path: Option<String>,
    round_key: Option<String>,
    watch_candidate_ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let image_path = image_path.or_else(|| {
        // 开发期用本地图片验证识别链路：release 构建不读取该变量。
        #[cfg(debug_assertions)]
        {
            std::env::var("HEXGLOW_OCR_IMAGE").ok()
        }
        #[cfg(not(debug_assertions))]
        {
            None
        }
    });
    let result = perform_scan_watched(
        image_path,
        round_key.as_deref(),
        watch_candidate_ids.as_deref(),
    )?;
    // 跳过不加载模型、不改变帧缓存、不计扫描。只限速记录安全的状态变化，
    // 便于区分首轮在等待前台、等待面板还是实际识别很慢。
    if result["skipped"] == true {
        if let Some(reason) = result["reason"].as_str().and_then(capture_reason) {
            let changed = CAPTURE_DIAGNOSTICS
                .lock()
                .map(|mut state| state.observe(Some(reason), Instant::now()))
                .unwrap_or(false);
            if changed {
                if let Ok((_, logs)) = crate::collector::directories(&app) {
                    let _ = crate::collector::append_log(
                        &logs,
                        "info",
                        if reason.starts_with("ocr-") {
                            "ocr-state"
                        } else {
                            "capture-state"
                        },
                        &format!(
                            "reason={reason} elapsed={}ms",
                            result["elapsedMs"].as_u64().unwrap_or(0)
                        ),
                    );
                }
            }
        }
        return Ok(result);
    }
    let cached = result["cached"] == true;
    let source = result["source"].as_str().unwrap_or("capture");
    if source == "capture" {
        if let Ok(mut state) = CAPTURE_DIAGNOSTICS.lock() {
            state.observe(None, Instant::now());
        }
    }
    let lines = result["lines"].as_array().map_or(0, Vec::len);
    let candidates = result["candidates"].as_array().map_or(0, Vec::len);
    let bytes = result["imageBytes"].as_u64().unwrap_or(0);
    let elapsed_ms = result["elapsedMs"].as_u64().unwrap_or(0);
    if let Ok((_, logs)) = crate::collector::directories(&app) {
        if let Some(hint) = result["panelState"].as_str() {
            crate::collector::record_panel_probe(
                &logs,
                hint,
                result["probeOnly"] != true && !cached,
                candidates == 3 && !cached,
                cached,
            );
        }
        if result["probeOnly"] == true {
            let hint = result["panelState"].as_str().unwrap_or("uncertain");
            let reason = if result["reason"] == "choice-region-unavailable" {
                "choice-region-unavailable"
            } else if result["unchangedPanel"] == true {
                "panel-unchanged"
            } else {
                "waiting-panel"
            };
            let region_reason = result["regionReason"].as_str().unwrap_or("none");
            let probe_key = format!("{hint}:{reason}:{region_reason}");
            let at = Instant::now();
            let log = PROBE_LOG
                .lock()
                .map(|mut previous| {
                    let due = previous.as_ref().is_none_or(|(state, last)| {
                        state != &probe_key || at.duration_since(*last) >= Duration::from_secs(10)
                    });
                    if due {
                        *previous = Some((probe_key, at));
                    }
                    due
                })
                .unwrap_or(false);
            if log {
                let _ = crate::collector::append_log(&logs,"info","panel-probe",&format!(
                    "state={hint} reason={reason} regionReason={region_reason} ocr=false band={} elapsed={elapsed_ms}ms acquisition={}ms probe={}ms",
                    result["band"].as_u64().unwrap_or(0),
                    result["acquisitionMs"].as_u64().unwrap_or(0),result["probeMs"].as_u64().unwrap_or(0)));
            }
            return Ok(result);
        }
        // 计数先于写日志：统计文件缺失时会回读现有日志补齐，避免把本次扫描算两遍。
        if !cached {
            crate::collector::record_ocr_scan(&logs, source, candidates);
        }
        let _ = crate::collector::append_log(
            &logs,
            "info",
            if cached { "ocr-cache" } else { "ocr-scan" },
            &format!(
                "source={} cached={cached} lines={} matched={} bytes={} elapsed={elapsed_ms}ms acquisition={}ms recognition={}ms matching={}ms fast={}ms fallback={}ms engine={} reason={} probeState={} band={} roi={}x{} roiMode={} roiOrigin={} regionReason={}",
                if cached { "cache" } else { source },
                lines,
                candidates,
                bytes,
                result["acquisitionMs"].as_u64().unwrap_or(0),
                result["recognitionMs"].as_u64().unwrap_or(0),
                result["matchingMs"].as_u64().unwrap_or(0),
                result["fastMs"].as_u64().unwrap_or(0),
                result["fallbackMs"].as_u64().unwrap_or(0),
                result["engine"].as_str().unwrap_or("unknown"),
                result["fallbackReason"].as_str().unwrap_or("unknown"),
                result["panelState"].as_str().unwrap_or("manual"),
                result["band"].as_u64().unwrap_or(0),
                result["ocrRegion"]["width"].as_u64().unwrap_or(0),result["ocrRegion"]["height"].as_u64().unwrap_or(0),
                result["ocrRegion"]["mode"].as_str().unwrap_or("file"),
                result["ocrRegion"]["origin"].as_str().unwrap_or("file"),result["regionReason"].as_str().unwrap_or("none"),
            ),
        );
    }
    Ok(result)
}

fn skipped_scan(reason: crate::capture::CaptureSkip, elapsed_ms: u128) -> serde_json::Value {
    serde_json::json!({
        "lines": [],
        "candidates": [],
        "elapsedMs": elapsed_ms,
        "source": "capture-skipped",
        "reason": reason.code(),
        "message": reason.message(),
        "skipped": true,
        "cached": false,
        "model": format!("{DET_MODEL} + {REC_MODEL}"),
    })
}

// 不依赖 AppHandle，真实只读验收也能覆盖与命令完全相同的获取/跳过/识别路径。
#[cfg(test)]
pub(crate) fn perform_scan(image_path: Option<String>) -> Result<serde_json::Value, String> {
    perform_scan_scoped(image_path, None)
}

static PANEL_GATE: OnceLock<Mutex<crate::panel_probe::ProbeGate>> = OnceLock::new();
static EMPTY_FALLBACK: OnceLock<Mutex<crate::panel_probe::EmptyFallbackBudget>> = OnceLock::new();
static PROBE_LOG: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static TITLE_WATCH: OnceLock<Mutex<crate::title_watch::TitleWatch>> = OnceLock::new();

fn observe_titles(scope: Option<&str>, image: &RgbImage, result: &Recognition, fresh: bool) {
    let Some(scope) = scope else {
        return;
    };
    let candidates = crate::scoring::match_augments(&result.lines);
    let mut titles = Vec::new();
    for candidate in &candidates {
        let lines: Vec<_> = result
            .lines
            .iter()
            .filter(|line| {
                crate::scoring::canonical_augment_exact(&line.text).as_deref()
                    == Some(candidate.id.as_str())
            })
            .collect();
        if lines.len() != 1 {
            titles.clear();
            break;
        }
        titles.push(lines[0]);
    }
    titles.sort_by_key(|line| line.x);
    let regions = if titles.len() == 3 {
        let centers: Vec<_> = titles
            .iter()
            .map(|line| line.x.saturating_add(line.width / 2))
            .collect();
        let radius = (centers[1]
            .saturating_sub(centers[0])
            .min(centers[2].saturating_sub(centers[1]))
            .saturating_mul(2)
            / 5)
        .min(image.width() / 3);
        titles
            .iter()
            .zip(centers)
            .map(|(line, center)| {
                let x = center.saturating_sub(radius);
                let y = line.y.saturating_sub(8);
                crate::title_watch::TitleRegion {
                    x,
                    y,
                    width: center
                        .saturating_add(radius)
                        .min(image.width())
                        .saturating_sub(x),
                    height: line
                        .y
                        .saturating_add(line.height)
                        .saturating_add(8)
                        .min(image.height())
                        .saturating_sub(y),
                }
            })
            .collect()
    } else {
        Vec::new()
    };
    if let Ok(mut watch) = TITLE_WATCH.get_or_init(Default::default).lock() {
        watch.observe(
            scope,
            image,
            candidates.into_iter().map(|c| c.id).collect(),
            regions,
            fresh,
            Instant::now(),
        );
    }
}

fn automatic_scan_band(round_key: Option<&str>) -> Option<u64> {
    round_key
        .filter(|key| !key.is_empty() && key.len() <= 128)
        .and_then(|key| serde_json::from_str::<serde_json::Value>(key).ok())
        .and_then(|value| {
            value
                .as_array()
                .filter(|items| {
                    items.len() == 3
                        && items[0].as_str().is_some_and(|id| !id.trim().is_empty())
                        && items[1].as_str().is_some_and(|id| !id.trim().is_empty())
                })
                .and_then(|items| items[2].as_u64())
        })
        .filter(|band| matches!(band, 1 | 7 | 11 | 15))
}

#[cfg(test)]
fn perform_scan_scoped(
    image_path: Option<String>,
    round_key: Option<&str>,
) -> Result<serde_json::Value, String> {
    perform_scan_watched(image_path, round_key, None)
}
fn perform_scan_watched(
    image_path: Option<String>,
    round_key: Option<&str>,
    watch_candidate_ids: Option<&[String]>,
) -> Result<serde_json::Value, String> {
    let started = Instant::now();
    let band = automatic_scan_band(round_key);
    // Cold automatic scans must neither capture a loading frame nor queue on
    // the pipeline held by preheating. Manual/file paths remain explicit work.
    if image_path.is_none() && band.is_some() && !INFERENCE_READY.load(Ordering::Acquire) {
        let failed = WARMUP_FAILED.load(Ordering::Acquire);
        return Ok(
            serde_json::json!({"lines":[],"candidates":[],"elapsedMs":started.elapsed().as_millis(),
            "source":"capture-skipped","skipped":true,"cached":false,"waitingForReady":!failed,
            "reason":if failed {"ocr-initialization-failed"} else {"ocr-warming-up"},
            "message":if failed {"OCR 初始化失败，请查看主窗口诊断；尚未截屏或调用模型。"} else {"OCR 正在预热，就绪后继续本轮识别。"},
            "model":format!("{DET_MODEL} + {FAST_REC_MODEL}")}),
        );
    }
    let (image, source, masked) = match image_path {
        Some(path) => (load_png(Path::new(&path))?, "file", Vec::new()),
        None => match crate::capture::try_grab_center_image()? {
            crate::capture::CaptureAttempt::Captured { image, masked } => {
                (image, "capture", masked)
            }
            crate::capture::CaptureAttempt::Skipped(reason) => {
                return Ok(skipped_scan(reason, started.elapsed().as_millis()))
            }
        },
    };
    process_scan_image(
        image,
        source,
        round_key,
        watch_candidate_ids,
        started,
        &masked,
    )
}

// The screen path and offline replay share everything AFTER acquiring pixels.
// This seam does not bypass localization, gating, inference, matching or cache.
fn process_scan_image(
    image: RgbImage,
    source: &str,
    round_key: Option<&str>,
    watch_candidate_ids: Option<&[String]>,
    started: Instant,
    masked: &[crate::capture::MaskRect],
) -> Result<serde_json::Value, String> {
    let band = automatic_scan_band(round_key);
    let bytes = image.as_raw().len();
    let (width, height) = image.dimensions();
    let acquisition_ms = started.elapsed().as_millis();
    let probe_started = Instant::now();
    let (mut region, region_reason) = if source == "capture" {
        crate::choice_region::locate_masked(&image, masked)
    } else {
        (None, "file")
    };
    let hint = (source == "capture").then(|| {
        if region.is_some() {
            crate::panel_probe::PanelHint::Likely
        } else {
            crate::panel_probe::inspect(&image)
        }
    });
    let probe_ms = probe_started.elapsed().as_millis();
    if source == "capture" && region.is_none() {
        return Ok(
            serde_json::json!({"lines":[],"candidates":[],"elapsedMs":started.elapsed().as_millis(),
            "source":"capture","cached":false,"skipped":false,"probeOnly":true,"reason":"choice-region-unavailable",
            "panelState":hint.map(|hint|hint.code()),"probeMs":probe_ms,"band":band,
            "regionReason":region_reason,
            "imageBytes":bytes,"imageWidth":width,"imageHeight":height,"acquisitionMs":acquisition_ms,
            "recognitionMs":0,"matchingMs":0,"fastMs":0,"fallbackMs":0,"engine":"choice-region","model":"pixel-only"}),
        );
    }
    // File fixtures retain their original image path; manual captures also
    // require a localized card region, but do not defer an empty Small pass.
    // The opaque scope is not logged or sent to a model; invalid scopes fail open.
    let scope = round_key.filter(|_| band.is_some());
    if let (Some(scope), Some(region)) = (scope, region.as_mut()) {
        if let Some((top, bottom)) = TITLE_WATCH
            .get_or_init(Default::default)
            .lock()
            .ok()
            .and_then(|watch| watch.observed_row(scope, image.dimensions(), Instant::now()))
        {
            region.use_observed_row(top, bottom);
        }
    }
    if let (Some(scope), Some(expected), Some(_)) = (scope, watch_candidate_ids, hint) {
        if TITLE_WATCH
            .get_or_init(Default::default)
            .lock()
            .map(|mut watch| watch.defer(scope, &image, expected, Instant::now()))
            .unwrap_or(false)
        {
            return Ok(
                serde_json::json!({"lines":[],"candidates":[],"elapsedMs":started.elapsed().as_millis(),
                "source":"capture","cached":false,"skipped":false,"probeOnly":true,"unchangedPanel":true,
                "watchCandidateIds":expected,"reason":"panel-unchanged","band":band,
                "panelState":hint.map(|hint|hint.code()),"acquisitionMs":acquisition_ms,
                "recognitionMs":0,"matchingMs":0,"fastMs":0,"fallbackMs":0,"engine":"title-watch","model":"pixel-only"}),
            );
        }
    }
    let gate = PANEL_GATE.get_or_init(|| Mutex::new(crate::panel_probe::ProbeGate::default()));
    let full = match (scope, hint) {
        (Some(key), Some(hint)) => gate
            .lock()
            .map(|mut gate| gate.allow(key, hint, Instant::now()))
            .unwrap_or(true),
        _ => true,
    };
    if !full {
        return Ok(serde_json::json!({
            "lines":[],"candidates":[],"elapsedMs":started.elapsed().as_millis(),
            "source":"capture","cached":false,"skipped":false,"probeOnly":true,
            "panelState":hint.map(|hint|hint.code()),"probeMs":probe_ms,
            "band":band,
            "imageBytes":bytes,"imageWidth":width,"imageHeight":height,
            "acquisitionMs":acquisition_ms,"recognitionMs":0,"matchingMs":0,
            "fastMs":0,"fallbackMs":0,"engine":"pixel-probe","model":"pixel-only"
        }));
    }
    let fallback_budget = EMPTY_FALLBACK
        .get_or_init(|| Mutex::new(crate::panel_probe::EmptyFallbackBudget::default()));
    // Only valid automatic capture scopes use deferred empty fallback. Manual
    // scans, fixtures and unknown scopes retain immediate complete fallback;
    // screen fallback is still bounded by the current three card interiors.
    let empty_fallback_due = match (scope, hint) {
        (Some(key), Some(_)) => fallback_budget
            .lock()
            .map(|mut budget| budget.due(key, Instant::now()))
            .unwrap_or(true),
        _ => true,
    };
    let recognition_started = Instant::now();
    let (recognition, cached) = if source == "capture" {
        recognize_capture_scoped(
            image,
            empty_fallback_due,
            scope,
            region.as_ref().expect("capture ROI validated"),
        )?
    } else {
        (recognize_timed(image)?, false)
    };
    let recognition_ms = recognition_started.elapsed().as_millis();
    if !cached && recognition.engine == "small-det-small-rec" {
        if let (Some(key), Some(_)) = (scope, hint) {
            if let Ok(mut budget) = fallback_budget.lock() {
                budget.completed(key, Instant::now());
            }
        }
    }
    let matching_started = Instant::now();
    let candidates = crate::scoring::match_augments(&recognition.lines);
    let matching_ms = matching_started.elapsed().as_millis();
    if let (Some(key), Some(_)) = (scope, hint) {
        if let Ok(mut gate) = gate.lock() {
            gate.observe(key, candidates.len(), Instant::now());
        }
    }
    Ok(serde_json::json!({
        "lines": recognition.lines,
        "candidates": candidates,
        "elapsedMs": started.elapsed().as_millis(),
        "source": source,
        "cached": cached,
        "skipped": false,
        "probeOnly":false,
        "probeNext":hint.is_some() && candidates.len()<2,
        "panelState":hint.map(|hint|hint.code()),
        "band":band,
        "probeMs":probe_ms,
        "regionReason":region_reason,
        "ocrRegion":region.as_ref().map(|r|serde_json::json!({"x":r.roi.x,"y":r.roi.y,"width":r.roi.width,"height":r.roi.height,"mode":if r.titles_only {"titles"} else {"card-body"},"origin":r.origin})),
        "imageBytes": bytes,
        "imageWidth": width,
        "imageHeight": height,
        "acquisitionMs": acquisition_ms,
        "recognitionMs": recognition_ms,
        "matchingMs": matching_ms,
        "fastMs": recognition.fast_ms,
        "fallbackMs": recognition.fallback_ms,
        "engine": recognition.engine,
        "fallbackReason": recognition.fallback_reason,
        "model": format!("{DET_MODEL} + {FAST_REC_MODEL} (fallback {REC_MODEL})"),
    }))
}

pub fn load_png(path: &Path) -> Result<RgbImage, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("读取图片失败：{error}"))?;
    image::load_from_memory(&bytes)
        .map_err(|error| format!("图片解码失败：{error}"))
        .map(|image| image.to_rgb8())
}

#[cfg(test)]
#[path = "ocr_screen_entry_tests.rs"]
mod screen_entry_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use oar_ocr::processors::BoundingBox;

    #[test]
    fn capture_wait_diagnostics_are_changed_only_bounded_and_do_not_accept_payload_text() {
        let mut state = CaptureDiagnostics::default();
        let at = Instant::now();
        assert!(state.observe(capture_reason("game-not-foreground"), at));
        assert!(!state.observe(
            capture_reason("game-not-foreground"),
            at + Duration::from_secs(30)
        ));
        assert!(!state.observe(
            capture_reason("game-window-not-found"),
            at + Duration::from_secs(1)
        ));
        assert!(state.observe(
            capture_reason("game-window-not-found"),
            at + Duration::from_secs(10)
        ));
        assert!(!state.observe(None, at + Duration::from_secs(11)));
        assert!(!state.observe(
            capture_reason("game-window-not-found"),
            at + Duration::from_secs(12)
        ));
        assert!(state.observe(
            capture_reason("game-window-not-found"),
            at + Duration::from_secs(20)
        ));
        assert!(capture_reason("unexpected identity or request payload").is_none());
    }

    #[test]
    fn loading_warmup_does_not_queue_behind_an_active_scanner() {
        let guard = PIPELINE.lock().unwrap();
        let previously_ready = INFERENCE_READY.swap(false, Ordering::AcqRel);
        let result = tauri::async_runtime::block_on(ocr_warmup());
        INFERENCE_READY.store(previously_ready, Ordering::Release);
        drop(guard);
        assert_eq!(result.unwrap()["status"], "busy");
    }

    #[test]
    fn cold_automatic_scan_never_captures_or_queues_on_the_held_pipeline() {
        let guard = PIPELINE.lock().unwrap();
        let ready = INFERENCE_READY.swap(false, Ordering::AcqRel);
        let failed = WARMUP_FAILED.swap(false, Ordering::AcqRel);
        let result = perform_scan_scoped(None, Some("[\"session\",\"123\",1]"));
        INFERENCE_READY.store(ready, Ordering::Release);
        WARMUP_FAILED.store(failed, Ordering::Release);
        drop(guard);
        let result = result.unwrap();
        assert_eq!(result["waitingForReady"], true);
        assert_eq!(result["skipped"], true);
        assert_eq!(result["candidates"], serde_json::json!([]));
        assert_eq!(result["reason"], "ocr-warming-up");
    }

    #[test]
    fn failed_preparation_is_reported_without_fake_candidates_or_a_capture() {
        let guard = PIPELINE.lock().unwrap();
        let ready = INFERENCE_READY.swap(false, Ordering::AcqRel);
        let failed = WARMUP_FAILED.swap(true, Ordering::AcqRel);
        let result = perform_scan_scoped(None, Some("[\"session\",\"123\",7]"));
        INFERENCE_READY.store(ready, Ordering::Release);
        WARMUP_FAILED.store(failed, Ordering::Release);
        drop(guard);
        let result = result.unwrap();
        assert_eq!(result["waitingForReady"], false);
        assert_eq!(result["reason"], "ocr-initialization-failed");
        assert_eq!(result["lines"], serde_json::json!([]));
    }

    #[test]
    fn automatic_scope_accepts_only_exact_nonempty_match_round_keys() {
        assert_eq!(
            automatic_scan_band(Some("[\"session\",\"123\",15]")),
            Some(15)
        );
        for value in [
            "[]",
            "invalid",
            "[\"\",\"123\",1]",
            "[\"session\",\"\",1]",
            "[\"session\",123,1]",
            "[\"session\",\"123\",3]",
        ] {
            assert_eq!(automatic_scan_band(Some(value)), None);
        }
        assert_eq!(automatic_scan_band(None), None);
    }

    #[test]
    fn game_first_cpu_budget_is_bounded_and_idle_workers_do_not_spin() {
        for (available, expected) in [(0, 1), (1, 1), (2, 1), (3, 1), (4, 1), (8, 1), (256, 1)] {
            assert_eq!(ocr_thread_budget(available), expected);
            let config = ocr_session_config(ocr_thread_budget(available));
            assert!(matches!(
                config.execution_providers.as_deref(),
                Some([OrtExecutionProvider::CPU])
            ));
            assert_eq!(config.intra_threads, Some(expected));
            assert_eq!(config.inter_threads, Some(1));
            assert_eq!(config.parallel_execution, Some(false));
            let entries = config.session_config_entries.unwrap();
            assert_eq!(
                entries
                    .get("session.intra_op.allow_spinning")
                    .map(String::as_str),
                Some("0")
            );
            assert_eq!(
                entries
                    .get("session.inter_op.allow_spinning")
                    .map(String::as_str),
                Some("0")
            );
        }
        assert_eq!(ocr_session_config(0).intra_threads, Some(1));
        assert_eq!(ocr_session_config(usize::MAX).intra_threads, Some(1));
    }

    #[test]
    fn preprocessing_pool_is_reused_and_nested_parallelism_is_local() {
        let first = ocr_cpu_pool().unwrap();
        let second = ocr_cpu_pool().unwrap();
        assert!(std::ptr::eq(first, second));
        let actual = first.install(rayon::current_num_threads);
        assert_eq!(actual, available_ocr_threads());
        #[cfg(target_os = "windows")]
        first.install(|| {
            use windows::Win32::System::Threading::{
                GetCurrentThread, GetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
            };
            assert!(
                unsafe { GetThreadPriority(GetCurrentThread()) } <= THREAD_PRIORITY_BELOW_NORMAL.0
            );
        });
        assert!((1..=MAX_OCR_THREADS).contains(&actual));
        let nested = first.install(|| {
            use rayon::prelude::*;
            (0..8)
                .into_par_iter()
                .map(|_| rayon::current_num_threads())
                .collect::<Vec<_>>()
        });
        assert!(nested.iter().all(|&count| count == actual));
    }

    fn region(text: &str) -> oar_ocr::oarocr::TextRegion {
        let mut region =
            oar_ocr::oarocr::TextRegion::new(BoundingBox::from_coords(10.0, 20.0, 110.0, 60.0));
        region.text = Some(text.into());
        region.confidence = Some(0.97);
        region
    }

    fn title(name: &str, x: u32, y: u32, score: f32) -> TextLine {
        TextLine {
            text: name.into(),
            score,
            x,
            y,
            width: 150,
            height: 30,
        }
    }

    fn panel() -> Vec<TextLine> {
        ["万用瞄准镜", "亮出你的剑", "巨像的勇气"]
            .into_iter()
            .enumerate()
            .map(|(index, name)| title(name, 50 + index as u32 * 350, 50, 0.99))
            .collect()
    }

    #[test]
    fn fast_path_requires_three_exact_high_confidence_spatial_titles() {
        let valid = panel();
        assert!(fast_panel_is_reliable(&valid));
        assert!(!fast_panel_is_reliable(&valid[..2]));
        for score in [0.949, 0.6, f32::NAN, f32::INFINITY] {
            let mut weak = valid.clone();
            weak[1].score = score;
            assert!(!fast_panel_is_reliable(&weak));
        }
        let mut fuzzy = valid.clone();
        fuzzy[0].text = "万用喵准镜".into();
        assert_eq!(crate::scoring::match_augments(&fuzzy).len(), 3);
        assert!(!fast_panel_is_reliable(&fuzzy));
        let mut wrong_row = valid.clone();
        wrong_row[1].y += 100;
        assert!(!fast_panel_is_reliable(&wrong_row));
    }

    #[test]
    fn fast_path_does_not_hide_ambiguous_rows_or_duplicate_titles() {
        let mut four = panel();
        four.push(title("珠光护手", 1100, 50, 0.99));
        assert!(!fast_panel_is_reliable(&four));
        let mut rows = panel();
        rows.extend([
            title("科学狂人", 50, 250, 0.99),
            title("珠光护手", 400, 250, 0.99),
            title("无限循环往复", 750, 250, 0.99),
        ]);
        assert!(!fast_panel_is_reliable(&rows));
        let mut duplicate = panel();
        duplicate[2].text = duplicate[0].text.clone();
        assert!(!fast_panel_is_reliable(&duplicate));
    }

    #[test]
    fn fallback_replaces_uncertain_result_instead_of_merging_passes() {
        let valid = panel();
        let result = recognize_with_fallback(
            || Ok(valid.clone()),
            || panic!("no fallback for reliable panel"),
        )
        .unwrap();
        assert_eq!(result.engine, "small-det-tiny-rec");
        assert_eq!(result.fallback_reason, "none");
        let result =
            recognize_with_fallback(|| Ok(valid[..2].to_vec()), || Ok(vec![valid[2].clone()]))
                .unwrap();
        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.engine, "small-det-small-rec");
        assert_eq!(result.fallback_reason, "uncertain-panel");
        assert!(crate::scoring::match_augments(&result.lines).is_empty());
        let result =
            recognize_with_fallback(|| Err("synthetic failure".into()), || Ok(valid)).unwrap();
        assert_eq!(result.fallback_reason, "fast-error");
        let failure = recognize_with_fallback(|| Ok(Vec::new()), || Err("fallback failed".into()));
        assert!(failure.is_err());
    }

    #[test]
    fn empty_automatic_frames_defer_small_without_publishing_tiny_text() {
        let result = recognize_with_fallback_policy(
            || Ok(vec![title("普通战斗文字", 50, 50, 0.99)]),
            || panic!("empty automatic frame must not invoke Small before safety deadline"),
            false,
        )
        .unwrap();
        assert!(result.lines.is_empty());
        assert_eq!(result.fallback_reason, "empty-fallback-deferred");
        assert_eq!(result.fallback_ms, 0);
        let safety =
            recognize_with_fallback_policy(|| Ok(Vec::new()), || Ok(panel()), true).unwrap();
        assert_eq!(safety.engine, "small-det-small-rec");
        assert_eq!(crate::scoring::match_augments(&safety.lines).len(), 3);
    }

    #[test]
    fn candidate_hints_and_errors_override_empty_fallback_budget_without_weakening_fast_guard() {
        for lines in [
            panel()[..1].to_vec(),
            vec![title("万用喵准镜", 50, 50, 0.99)],
            vec![title("万用瞄准镜", 50, 50, 0.6)],
            {
                let mut lines = panel();
                lines[0].score = 0.949;
                lines
            },
            {
                let mut lines = panel();
                lines.push(title("珠光护手", 1100, 50, 0.99));
                lines
            },
        ] {
            assert!(!fast_panel_is_reliable(&lines));
            let result =
                recognize_with_fallback_policy(|| Ok(lines), || Ok(panel()), false).unwrap();
            assert_eq!(result.engine, "small-det-small-rec");
            assert_eq!(result.fallback_reason, "uncertain-panel");
        }
        let error = recognize_with_fallback_policy(
            || Err("synthetic Tiny error".into()),
            || Ok(panel()),
            false,
        )
        .unwrap();
        assert_eq!(error.fallback_reason, "fast-error");
        let fast = recognize_with_fallback_policy(
            || Ok(panel()),
            || panic!("reliable three-title panel needs no Small pass"),
            false,
        )
        .unwrap();
        assert_eq!(fast.fallback_reason, "none");
    }

    #[test]
    fn deferred_empty_frames_never_reuse_a_cached_miss() {
        let now = Instant::now();
        let image = RgbImage::new(2, 2);
        let frame = FrameCache {
            image: image.clone(),
            recognized: now,
            result: Recognition {
                lines: Vec::new(),
                engine: "small-det-tiny-rec",
                fallback_reason: "empty-fallback-deferred",
                fast_ms: 40,
                fallback_ms: 0,
            },
        };
        assert!(cached_frame_result(&frame, &image, now + Duration::from_millis(1)).is_none());
    }

    #[test]
    #[ignore = "Optional offline inference of an explicitly supplied panel reference"]
    fn supplied_reference_preserves_candidates_under_empty_fallback_policy() {
        let path = std::env::var("HEXGLOW_PANEL_PROBE_REFERENCE")
            .expect("explicit reference path required");
        let image = image::open(path).unwrap().to_rgb8();
        let (w, h) = image.dimensions();
        let old_crop = image::imageops::crop_imm(
            &image,
            w * 19 / 100,
            h * 24 / 100,
            w * 62 / 100,
            h * 52 / 100,
        )
        .to_image();
        let region = crate::capture::center_region(crate::capture::ScreenRect {
            x: 0,
            y: 0,
            width: w,
            height: h,
        })
        .unwrap();
        let mut crop = image::imageops::crop_imm(
            &image,
            region.x as u32,
            region.y as u32,
            region.width,
            region.height,
        )
        .to_image();
        // Reference-only overlay rectangle, never a runtime screenshot guess.
        crate::capture::mask_region(
            &mut crop,
            region,
            crate::capture::ScreenRect {
                x: (w * 84 / 100) as i32,
                y: (h * 38 / 100) as i32,
                width: w * 16 / 100 + 1,
                height: h * 62 / 100 + 1,
            },
        );
        with_pipeline(|pipeline| {
            let old = recognize_with_policy(pipeline, old_crop, true)?;
            let baseline = recognize_with_policy(pipeline, crop.clone(), true)?;
            let optimized = recognize_with_policy(pipeline, crop, false)?;
            let ids = |result: &Recognition| {
                crate::scoring::match_augments(&result.lines)
                    .into_iter()
                    .map(|c| c.id)
                    .collect::<Vec<_>>()
            };
            assert_eq!(ids(&old).len(), 0, "old ROI cuts the left title in this supplied reference");
            assert_eq!(ids(&baseline).len(), 3);
            assert_eq!(ids(&baseline), ids(&optimized));
            let expected: Vec<_> = ["你摸不到", "位面转移", "无限循环往复"].into_iter()
                .map(|name| crate::scoring::canonical_augment_exact(name).unwrap()).collect();
            assert_eq!(ids(&optimized), expected);
            eprintln!("reference old matched=0; wider masked ROI matched=3; optimized matched=3; engine={}", optimized.engine);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn real_inference_warmup_does_not_touch_capture_cache() {
        // prime_pipeline has no FRAME/AppHandle argument; it cannot capture,
        // publish candidates, save a session or count a recommendation.
        with_pipeline(|pipeline| {
            prime_pipeline(pipeline)?;
            let image = load_png(
                &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/augment-card.png"),
            )?;
            assert!(fast_panel_is_reliable(&predict_lines(
                pipeline.fast.as_ref().unwrap(),
                image
            )?));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn unavailable_fast_engine_keeps_original_ocr_working() {
        let pipeline = Pipelines {
            fast: None,
            fallback: build_pipeline(&model_directory().unwrap(), false).unwrap(),
        };
        prime_pipeline(&pipeline).unwrap();
        let image = load_png(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/augment-card.png"),
        )
        .unwrap();
        let result = recognize_with_pipeline(&pipeline, image).unwrap();
        assert_eq!(result.fallback_reason, "fast-unavailable");
        assert_eq!(result.fast_ms, 0);
        assert_eq!(crate::scoring::match_augments(&result.lines).len(), 3);
    }

    #[test]
    fn cache_requires_identical_fresh_pixels_and_does_not_recount_inference_time() {
        let now = Instant::now();
        let image = RgbImage::new(2, 2);
        let frame = FrameCache {
            image: image.clone(),
            recognized: now,
            result: Recognition {
                lines: panel(),
                engine: "small-det-small-rec",
                fallback_reason: "uncertain-panel",
                fast_ms: 70,
                fallback_ms: 130,
            },
        };
        let cached =
            cached_frame_result(&frame, &image, now + Duration::from_millis(4999)).unwrap();
        assert_eq!(cached.lines.len(), 3);
        assert_eq!((cached.fast_ms, cached.fallback_ms), (0, 0));
        assert_eq!((frame.result.fast_ms, frame.result.fallback_ms), (70, 130));
        assert!(cached_frame_result(&frame, &image, now + Duration::from_secs(5)).is_none());
        let mut changed = image;
        changed.put_pixel(1, 1, image::Rgb([1, 0, 0]));
        assert!(cached_frame_result(&frame, &changed, now).is_none());
        assert!(cached_frame_result(&frame, &RgbImage::new(3, 2), now).is_none());
    }

    #[test]
    #[ignore = "offline synthetic corpus benchmark; generate corpus first and run alone in release mode"]
    fn benchmark_production_corpus() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/ocr-benchmark-corpus");
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("manifest.json"))
                .expect("run scripts/make-ocr-benchmark-corpus.py first"),
        )
        .unwrap();
        let cases = manifest["cases"].as_array().unwrap();
        // Run the pre-change pipeline separately, then drop its sessions before
        // timing production. Synthetic small-font limitations must stay visible,
        // not be hidden by changing the expected labels to whatever OCR returns.
        let directory = model_directory().unwrap();
        let baseline = OAROCRBuilder::new(
            directory.join(DET_MODEL),
            directory.join(REC_MODEL),
            directory.join(DICT_FILE),
        )
        .image_batch_size(1)
        .region_batch_size(8)
        .build()
        .unwrap();
        let mut baseline_missed = Vec::new();
        let mut baseline_times = Vec::new();
        for case in cases {
            let input = load_png(&root.join(case["file"].as_str().unwrap())).unwrap();
            let started = Instant::now();
            let lines = predict_lines(&baseline, input).unwrap();
            let actual: Vec<String> = crate::scoring::match_augments(&lines)
                .iter()
                .map(|c| c.id.clone())
                .collect();
            baseline_times.push(started.elapsed().as_micros() as f64 / 1000.0);
            let expected: Vec<String> = case["expectedIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            if actual != expected {
                baseline_missed.push(case["id"].clone());
            }
        }
        drop(baseline);
        baseline_times.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"profile":"previous-small-batch8","cases":cases.len(),"correct":cases.len()-baseline_missed.len(),"p50Ms":baseline_times[cases.len()/2],"p95Ms":baseline_times[(cases.len() as f64*0.95).ceil() as usize-1],"missed":baseline_missed})
        );
        with_pipeline(prime_pipeline).unwrap();
        let mut durations = Vec::new();
        let mut fallback_count = 0;
        let mut missed = Vec::new();
        let mut false_panels = 0;
        let mut wrong_fast_accepted = 0;
        for case in cases {
            let input = load_png(&root.join(case["file"].as_str().unwrap())).unwrap();
            let start = Instant::now();
            let result = recognize_timed(input).unwrap();
            let actual: Vec<String> = crate::scoring::match_augments(&result.lines)
                .iter()
                .map(|c| c.id.clone())
                .collect();
            let expected: Vec<String> = case["expectedIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            durations.push(start.elapsed().as_micros() as f64 / 1000.0);
            if result.fallback_reason != "none" {
                fallback_count += 1;
            }
            if actual != expected {
                missed.push(case["id"].clone());
                if result.fallback_reason == "none" {
                    wrong_fast_accepted += 1;
                }
            }
            if case["shouldMatch"] == false && !actual.is_empty() {
                false_panels += 1;
            }
        }
        durations.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"profile":"production-hybrid","cases":cases.len(),"correct":cases.len()-missed.len(),"fallbackCount":fallback_count,"falsePanels":false_panels,"wrongFastAccepted":wrong_fast_accepted,"p50Ms":durations[durations.len()/2],"p95Ms":durations[(durations.len() as f64*0.95).ceil() as usize-1],"missed":missed})
        );
        assert_eq!(false_panels, 0);
        assert_eq!(wrong_fast_accepted, 0);
        let regressions: Vec<_> = missed
            .iter()
            .filter(|id| !baseline_missed.contains(id))
            .collect();
        assert!(
            regressions.is_empty(),
            "new failures versus baseline: {regressions:?}"
        );
    }

    #[test]
    fn normalize_keeps_text_readable() {
        assert_eq!(normalize("  万用  瞄准镜 \n"), "万用 瞄准镜");
        assert_eq!(normalize("获得\u{200b}75攻击距离"), "获得75攻击距离");
        assert_eq!(normalize("   \t "), "");
    }

    #[test]
    fn skipped_captures_return_empty_explicit_uncached_results() {
        for reason in [
            crate::capture::CaptureSkip::NoGameWindow,
            crate::capture::CaptureSkip::GameHidden,
            crate::capture::CaptureSkip::GameMinimized,
            crate::capture::CaptureSkip::GameNotForeground,
        ] {
            let result = skipped_scan(reason, 7);
            assert_eq!(result["skipped"], true);
            assert_eq!(result["source"], "capture-skipped");
            assert_eq!(result["reason"], reason.code());
            assert_eq!(result["lines"], serde_json::json!([]));
            assert_eq!(result["candidates"], serde_json::json!([]));
            assert_eq!(result["cached"], false);
            assert!(result["imageBytes"].is_null());
        }
    }

    #[test]
    fn file_scan_is_independent_of_game_foreground_status() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/augment-card.png");
        let result = perform_scan(Some(fixture.to_string_lossy().into_owned())).unwrap();
        assert_eq!(result["source"], "file");
        assert_eq!(result["skipped"], false);
        assert_eq!(result["cached"], false);
        assert_eq!(result["candidates"].as_array().unwrap().len(), 3);
        for key in [
            "acquisitionMs",
            "recognitionMs",
            "matchingMs",
            "fastMs",
            "fallbackMs",
        ] {
            assert!(result[key].is_number(), "missing timing: {key}");
        }
        assert!(result["engine"].is_string());
        assert!(result["fallbackReason"].is_string());
    }

    #[test]
    fn rect_from_points_is_normalized() {
        let text_region = region("亮出你的剑");
        assert_eq!(rect_of(&text_region), (10, 20, 100, 40));
    }

    #[test]
    fn empty_regions_are_skipped() {
        let mut text_region = region("");
        text_region.confidence = None;
        assert_eq!(text_region.confidence, None);
        assert!(normalize(text_region.text.as_deref().unwrap_or("")).is_empty());
    }

    #[test]
    fn localized_cards_keep_three_ids_and_recover_a_mislocated_title_row() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/augment-card.png");
        let image = load_png(&fixture).unwrap();
        let region = crate::choice_region::locate(&image).expect("fixture card geometry");
        let expected: Vec<_> = ["万用瞄准镜", "亮出你的剑", "巨像的勇气"]
            .iter()
            .map(|name| crate::scoring::canonical_augment_exact(name).unwrap())
            .collect();
        let check = |result: &Recognition| {
            let candidates = crate::scoring::match_augments(&result.lines);
            assert_eq!(
                candidates.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
                expected
            );
            let body = region.full_cards().roi;
            assert!(result.lines.iter().all(|l| l.x >= body.x
                && l.y >= body.y
                && l.x + l.width <= body.x + body.width
                && l.y + l.height <= body.y + body.height));
        };
        with_pipeline(|pipeline| {
            let result = recognize_choice_region(pipeline, &image, &region, true)?;
            check(&result);
            // Wrong pixel-only title hint must recover inside the SAME three
            // cards, never by reading HUD/gameplay outside their interiors.
            let mut wrong_row = region.clone();
            let body = region.full_cards().roi;
            wrong_row.roi = crate::choice_region::Rect {
                y: body.y + body.height - 28,
                height: 20,
                ..body
            };
            wrong_row.titles_only = true;
            let recovered = recognize_choice_region(pipeline, &image, &wrong_row, true)?;
            assert_ne!(recovered.fallback_reason, "none");
            check(&recovered);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn reads_augment_card_fixture() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/augment-card.png");
        let lines = recognize_image(load_png(&fixture).unwrap()).unwrap();
        for line in &lines {
            println!(
                "{:>4},{:<4} {:>3}% {}",
                line.x,
                line.y,
                (line.score * 100.0) as i32,
                line.text
            );
        }
        let joined = lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("|");
        assert!(joined.contains("万用瞄准镜"), "OCR output: {joined:?}");
        assert!(joined.contains("亮出你的剑"), "OCR output: {joined:?}");
        assert!(
            lines.iter().any(|line| line.text.contains("攻击距离")),
            "OCR output: {joined:?}"
        );
        let candidates = crate::scoring::match_augments(&lines);
        for name in ["万用瞄准镜", "亮出你的剑", "巨像的勇气"] {
            assert!(
                candidates.iter().any(|c| c.name == name),
                "missing {name}: {candidates:?}"
            );
        }
    }

    #[test]
    fn missing_models_request_reinstall_without_falling_back_to_download() {
        let absent = std::env::temp_dir().join(format!("hexglow-absent-{}", uuid::Uuid::new_v4()));
        let error = validate_model_files(&absent).unwrap_err();
        assert!(error.contains(DET_MODEL), "{error}");
        assert!(error.contains("重新安装完整安装包"), "{error}");
        assert!(!absent.exists());
    }

    #[test]
    fn incomplete_models_have_actionable_error() {
        let directory =
            std::env::temp_dir().join(format!("hexglow-model-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let model = directory.join(DET_MODEL);
        std::fs::write(&model, b"incomplete model").unwrap();
        let error = validate_model_files(&directory).unwrap_err();
        std::fs::remove_file(&model).unwrap();
        std::fs::remove_dir(&directory).unwrap();
        assert!(error.contains("模型不完整"), "{error}");
        assert!(error.contains(DET_MODEL), "{error}");
        assert!(error.contains("个人数据会保留"), "{error}");
    }

    #[test]
    fn bundled_manifest_matches_runtime_models() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../resources/ocr/manifest.json")).unwrap();
        let files = manifest["files"].as_array().unwrap();
        assert_eq!(files.len(), MODEL_FILES.len());
        for (name, size) in MODEL_FILES {
            let entry = files.iter().find(|file| file["name"] == name).unwrap();
            assert_eq!(entry["size"], size);
            assert_eq!(entry["sha256"].as_str().unwrap().len(), 64);
        }
        let directory = model_directory().unwrap();
        assert!(directory.is_absolute());
        validate_model_files(&directory).unwrap();
    }
}
