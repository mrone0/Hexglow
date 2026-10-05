//! 海克斯卡片 OCR：PP-OCRv6 Small（oar-ocr + ONNX Runtime）。
//! 模型文件由 `auto-download` 特性按需下载到 `~/.oar` 并按 registry 校验 SHA-256。
use image::RgbImage;
use oar_ocr::oarocr::{OAROCR, OAROCRBuilder};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

const DET_MODEL: &str = "pp-ocrv6_small_det.onnx";
const REC_MODEL: &str = "pp-ocrv6_small_rec.onnx";
const DICT_FILE: &str = "ppocrv6_dict.txt";

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

fn with_pipeline<T>(run: impl FnOnce(&OAROCR) -> Result<T, String>) -> Result<T, String> {
    let mut guard = PIPELINE
        .lock()
        .map_err(|_| "OCR 管线状态异常".to_string())?;
    if guard.is_none() {
        let pipeline = OAROCRBuilder::new(DET_MODEL, REC_MODEL, DICT_FILE)
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
        for region in results
            .iter()
            .flat_map(|result| result.text_regions.iter())
        {
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
const OPAQUE: [char; 7] = ['\u{200b}', '\u{200c}', '\u{200d}', '\u{200e}', '\u{200f}', '\u{2060}', '\u{feff}'];

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
    (x, y, max_x.max(min_x) as u32 - x, max_y.max(min_y) as u32 - y)
}

#[tauri::command(async)]
pub fn ocr_scan(
    app: tauri::AppHandle,
    image_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let started = std::time::Instant::now();
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
    let (png, source) = match image_path {
        Some(path) => {
            let bytes = std::fs::read(&path).map_err(|error| format!("读取图片失败：{error}"))?;
            (bytes, "file")
        }
        None => (crate::capture::grab_center_png()?, "capture"),
    };
    let lines = recognize_png(&png)?;
    let candidates = crate::scoring::match_augments(&lines);
    let elapsed_ms = started.elapsed().as_millis();
    if let Ok((_, logs)) = crate::collector::directories(&app) {
        // 计数先于写日志：统计文件缺失时会回读现有日志补齐，避免把本次扫描算两遍。
        crate::collector::record_ocr_scan(&logs, &source, candidates.len());
        let _ = crate::collector::append_log(
            &logs,
            "info",
            "ocr-scan",
            &format!(
                "source={source} lines={} matched={} bytes={} elapsed={elapsed_ms}ms",
                lines.len(),
                candidates.len(),
                png.len()
            ),
        );
    }
    Ok(serde_json::json!({
        "lines": lines,
        "candidates": candidates,
        "elapsedMs": elapsed_ms,
        "source": source,
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
        let mut region = oar_ocr::oarocr::TextRegion::new(BoundingBox::from_coords(
            10.0, 20.0, 110.0, 60.0,
        ));
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
    #[ignore = "首次运行会下载 PP-OCRv6 模型（约 31MB）"]
    fn reads_augment_card_fixture() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/augment-card.png");
        let lines = recognize_image(load_png(&fixture).unwrap()).unwrap();
        for line in &lines {
            println!("{:>4},{:<4} {:>3}% {}", line.x, line.y, (line.score * 100.0) as i32, line.text);
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
    }
}
