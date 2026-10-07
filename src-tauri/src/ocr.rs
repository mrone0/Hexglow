//! 海克斯卡片 OCR：PP-OCRv6 Small（oar-ocr + ONNX Runtime）。
//! 模型随安装包分发；启动时在后台预热，运行期间不下载模型。
use image::RgbImage;
use oar_ocr::oarocr::{OAROCRBuilder, OAROCR};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
#[cfg(not(any(debug_assertions, test)))]
use tauri::Manager;

const DET_MODEL: &str = "pp-ocrv6_small_det.onnx";
const REC_MODEL: &str = "pp-ocrv6_small_rec.onnx";
const DICT_FILE: &str = "ppocrv6_dict.txt";

// Sizes are pinned alongside SHA-256 in resources/ocr/manifest.json. The build
// script verifies hashes; checking file sizes here catches incomplete installs
// before ONNX Runtime produces an opaque model-loading error.
const MODEL_FILES: [(&str, u64); 3] = [
    (DET_MODEL, 9_880_512),
    (REC_MODEL, 21_159_378),
    (DICT_FILE, 74_947),
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

fn validate_model_files(directory: &Path) -> Result<(), String> {
    for (name, expected_size) in MODEL_FILES {
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
        let started = Instant::now();
        let result = with_pipeline(|_| Ok(()));
        if let Ok((_, logs)) = crate::collector::directories(&app) {
            let (level, message) = match result {
                Ok(()) => (
                    "info",
                    format!(
                        "bundled models ready elapsed={}ms",
                        started.elapsed().as_millis()
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

static PIPELINE: Mutex<Option<OAROCR>> = Mutex::new(None);
#[derive(Clone)]
struct FrameCache {
    image: RgbImage,
    lines: Vec<TextLine>,
    recognized: Instant,
}
static FRAME: Mutex<Option<FrameCache>> = Mutex::new(None);

/// 画面完全相同时复用识别结果，最多五秒；刷新后的新画面立即重识别。
fn recognize_capture(image: RgbImage) -> Result<(Vec<TextLine>, bool), String> {
    let mut cache = FRAME.lock().map_err(|_| "OCR 截屏缓存异常")?;
    if let Some(frame) = cache
        .as_ref()
        .filter(|f| f.recognized.elapsed() < Duration::from_secs(5) && f.image == image)
    {
        return Ok((frame.lines.clone(), true));
    }
    let lines = recognize_image(image.clone())?;
    *cache = Some(FrameCache {
        image,
        lines: lines.clone(),
        recognized: Instant::now(),
    });
    Ok((lines, false))
}

fn with_pipeline<T>(run: impl FnOnce(&OAROCR) -> Result<T, String>) -> Result<T, String> {
    let mut guard = PIPELINE
        .lock()
        .map_err(|_| "OCR 管线状态异常".to_string())?;
    if guard.is_none() {
        let directory = model_directory()?;
        validate_model_files(&directory)?;
        let pipeline = OAROCRBuilder::new(
            directory.join(DET_MODEL),
            directory.join(REC_MODEL),
            directory.join(DICT_FILE),
        )
        .image_batch_size(1)
        .region_batch_size(8)
        .build()
        .map_err(|error| format!("OCR 模型加载失败：{error}"))?;
        *guard = Some(pipeline);
    }
    let pipeline = guard.as_ref().expect("pipeline initialized above");
    run(pipeline)
}

pub fn recognize_image(image: RgbImage) -> Result<Vec<TextLine>, String> {
    with_pipeline(|ocr| {
        let results = ocr
            .predict(vec![image])
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
    })
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

#[tauri::command(async)]
pub fn ocr_scan(
    app: tauri::AppHandle,
    image_path: Option<String>,
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
    let result = perform_scan(image_path)?;
    // 预期的非前台/不可见状态静默跳过；不加载模型、不改变帧缓存、不计扫描或写周期日志。
    if result["skipped"] == true {
        return Ok(result);
    }
    let cached = result["cached"] == true;
    let source = result["source"].as_str().unwrap_or("capture");
    let lines = result["lines"].as_array().map_or(0, Vec::len);
    let candidates = result["candidates"].as_array().map_or(0, Vec::len);
    let bytes = result["imageBytes"].as_u64().unwrap_or(0);
    let elapsed_ms = result["elapsedMs"].as_u64().unwrap_or(0);
    if let Ok((_, logs)) = crate::collector::directories(&app) {
        // 计数先于写日志：统计文件缺失时会回读现有日志补齐，避免把本次扫描算两遍。
        if !cached {
            crate::collector::record_ocr_scan(&logs, source, candidates);
        }
        let _ = crate::collector::append_log(
            &logs,
            "info",
            if cached { "ocr-cache" } else { "ocr-scan" },
            &format!(
                "source={} cached={cached} lines={} matched={} bytes={} elapsed={elapsed_ms}ms",
                if cached { "cache" } else { source },
                lines,
                candidates,
                bytes
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
pub(crate) fn perform_scan(image_path: Option<String>) -> Result<serde_json::Value, String> {
    let started = Instant::now();
    let (image, source) = match image_path {
        Some(path) => (load_png(Path::new(&path))?, "file"),
        None => match crate::capture::try_grab_center_image()? {
            crate::capture::CaptureAttempt::Captured(image) => (image, "capture"),
            crate::capture::CaptureAttempt::Skipped(reason) => {
                return Ok(skipped_scan(reason, started.elapsed().as_millis()))
            }
        },
    };
    let bytes = image.as_raw().len();
    let (width, height) = image.dimensions();
    let acquisition_ms = started.elapsed().as_millis();
    let (lines, cached) = if source == "capture" {
        recognize_capture(image)?
    } else {
        (recognize_image(image)?, false)
    };
    let candidates = crate::scoring::match_augments(&lines);
    Ok(serde_json::json!({
        "lines": lines,
        "candidates": candidates,
        "elapsedMs": started.elapsed().as_millis(),
        "source": source,
        "cached": cached,
        "skipped": false,
        "imageBytes": bytes,
        "imageWidth": width,
        "imageHeight": height,
        "acquisitionMs": acquisition_ms,
        "model": format!("{DET_MODEL} + {REC_MODEL}"),
    }))
}

pub fn load_png(path: &Path) -> Result<RgbImage, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("读取图片失败：{error}"))?;
    image::load_from_memory(&bytes)
        .map_err(|error| format!("图片解码失败：{error}"))
        .map(|image| image.to_rgb8())
}

#[cfg(test)]
mod tests {
    use super::*;
    use oar_ocr::processors::BoundingBox;

    fn region(text: &str) -> oar_ocr::oarocr::TextRegion {
        let mut region =
            oar_ocr::oarocr::TextRegion::new(BoundingBox::from_coords(10.0, 20.0, 110.0, 60.0));
        region.text = Some(text.into());
        region.confidence = Some(0.97);
        region
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
