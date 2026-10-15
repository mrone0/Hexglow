//! Offline, deterministic CPU OCR benchmark. Never captures the desktop or calls a service.
//! cargo run --release --offline --locked --example ocr_benchmark -- small small 4 4 12
use image::{imageops::FilterType, RgbImage};
use lol_augment_assistant_lib::{ocr::TextLine, scoring::match_augments};
use oar_ocr::{core::config::OrtSessionConfig, oarocr::OAROCRBuilder};
use std::{path::Path, time::Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let detector = args.get(1).map(String::as_str).unwrap_or("small");
    let recognizer = args.get(2).map(String::as_str).unwrap_or("small");
    let threads: usize = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(0);
    let batch: usize = args.get(4).map(|s| s.parse().unwrap()).unwrap_or(8);
    let runs: usize = args.get(5).map(|s| s.parse().unwrap()).unwrap_or(12);
    assert!(runs >= 2);
    assert!(["small", "tiny"].contains(&detector));
    assert!(["small", "tiny"].contains(&recognizer));
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let directory = root.join("resources/ocr");
    let experimental = root.join("target/ocr-benchmark-models");
    let fixture = image::open(root.join("tests/fixtures/augment-card.png"))
        .unwrap()
        .to_rgb8();
    let load = Instant::now();
    let mut builder = OAROCRBuilder::new(
        (if detector == "tiny" {
            &experimental
        } else {
            &directory
        })
        .join(format!("pp-ocrv6_{detector}_det.onnx")),
        directory.join(format!("pp-ocrv6_{recognizer}_rec.onnx")),
        if recognizer == "tiny" {
            directory.join("ppocrv6_tiny_dict.txt")
        } else {
            directory.join("ppocrv6_dict.txt")
        },
    )
    .image_batch_size(1)
    .region_batch_size(batch);
    if threads > 0 {
        builder = builder.ort_session(
            OrtSessionConfig::new()
                .with_intra_threads(threads)
                .with_inter_threads(1),
        );
    }
    let pipeline = builder.build().unwrap();
    let load_ms = load.elapsed().as_millis();
    if let Some(corpus_path) = args.get(6) {
        let manifest_path = Path::new(corpus_path).join("manifest.json");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
        let mut correct = 0;
        let mut false_panels = 0;
        let mut fast_accepted = 0;
        let mut wrong_fast_accepted = 0;
        let mut durations = Vec::new();
        let cases = manifest["cases"].as_array().unwrap();
        let mut failures = Vec::new();
        for case in cases {
            let input = image::open(Path::new(corpus_path).join(case["file"].as_str().unwrap()))
                .unwrap()
                .to_rgb8();
            let start = Instant::now();
            let results = pipeline.predict(vec![input]).unwrap();
            let lines = to_lines(&results);
            let actual: Vec<String> = match_augments(&lines)
                .iter()
                .map(|c| c.id.clone())
                .collect();
            let expected: Vec<String> = case["expectedIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            if lol_augment_assistant_lib::ocr::fast_panel_is_reliable(&lines) {
                fast_accepted += 1;
                if actual != expected {
                    wrong_fast_accepted += 1;
                }
            }
            durations.push(start.elapsed().as_micros() as f64 / 1000.0);
            if actual == expected {
                correct += 1;
            } else {
                failures
                    .push(serde_json::json!({"id":case["id"],"expected":expected,"actual":actual}));
            }
            if case["shouldMatch"] == false && !actual.is_empty() {
                false_panels += 1;
            }
        }
        durations.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"det":detector,"rec":recognizer,"threads":threads,"batch":batch,"cases":cases.len(),"correct":correct,"falsePanels":false_panels,"fastAccepted":fast_accepted,"wrongFastAccepted":wrong_fast_accepted,"p50Ms":durations[durations.len()/2],"p95Ms":durations[(durations.len() as f64 * 0.95).ceil() as usize-1],"failures":failures})
        );
        return;
    }
    let images: Vec<(&str, RgbImage)> = vec![
        ("native", fixture.clone()),
        (
            "75pct",
            image::imageops::resize(&fixture, 1200, 675, FilterType::Triangle),
        ),
        (
            "50pct",
            image::imageops::resize(&fixture, 800, 450, FilterType::Triangle),
        ),
    ];
    for (variant, image) in images {
        let mut durations = Vec::new();
        let mut correct = 0;
        let mut cold_ms = 0;
        let mut count = 0;
        for run in 0..=runs {
            let input = image.clone();
            let start = Instant::now();
            let results = pipeline.predict(vec![input]).unwrap();
            let elapsed = start.elapsed().as_micros() as f64 / 1000.0;
            let lines = to_lines(&results);
            let matched = match_augments(&lines);
            let expected = ["万用瞄准镜", "亮出你的剑", "巨像的勇气"];
            if matched.len() == 3
                && expected
                    .iter()
                    .zip(&matched)
                    .all(|(name, c)| *name == c.name)
            {
                correct += 1;
            }
            count = lines.len();
            if run == 0 {
                cold_ms = elapsed as u64;
            } else {
                durations.push(elapsed);
            }
        }
        durations.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"det":detector,"rec":recognizer,"threads":threads,"batch":batch,"variant":variant,"runs":runs,"loadMs":load_ms,"firstShapeMs":cold_ms,"p50Ms":durations[runs/2],"p95Ms":durations[((runs as f64 * 0.95).ceil() as usize - 1).min(runs-1)],"correctPanels":correct,"totalPanels":runs+1,"lines":count})
        );
    }
}

fn to_lines(results: &[oar_ocr::oarocr::OAROCRResult]) -> Vec<TextLine> {
    results
        .iter()
        .flat_map(|r| &r.text_regions)
        .filter_map(|r| {
            let text = r.text.as_deref()?.to_owned();
            let min_x = r
                .bounding_box
                .points
                .iter()
                .map(|p| p.x)
                .fold(f32::INFINITY, f32::min)
                .max(0.0) as u32;
            let min_y = r
                .bounding_box
                .points
                .iter()
                .map(|p| p.y)
                .fold(f32::INFINITY, f32::min)
                .max(0.0) as u32;
            let max_x = r
                .bounding_box
                .points
                .iter()
                .map(|p| p.x)
                .fold(0.0, f32::max) as u32;
            let max_y = r
                .bounding_box
                .points
                .iter()
                .map(|p| p.y)
                .fold(0.0, f32::max) as u32;
            Some(TextLine {
                text,
                score: r.confidence.unwrap_or(0.0),
                x: min_x,
                y: min_y,
                width: max_x.saturating_sub(min_x),
                height: max_y.saturating_sub(min_y),
            })
        })
        .collect()
}
