//! Offline acceptance of the actual post-capture screen path, NOT the file path.
//! No desktop capture, client API, window operations, user DB or paid model.
use super::*;
use image::{imageops, Rgb};
use serde_json::{json, Value};

struct Case {
    id: String,
    frame: RgbImage,
    band: u64,
    expected: Vec<String>,
    overlay: Option<crate::capture::ScreenRect>,
}
fn ids(names: &[&str]) -> Vec<String> {
    names
        .iter()
        .map(|name| {
            crate::scoring::canonical_augment_exact(name)
                .expect("expectations must be known names, never derived from actual OCR")
        })
        .collect()
}
fn full_frame_fixture(borderless: bool) -> RgbImage {
    let mut fixture =
        load_png(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/augment-card.png"))
            .unwrap();
    if borderless {
        // Synthetic fault injection: remove only the frame's exact colour.
        // Preserve every title/description pixel. This is NOT a recorded animation.
        let border = *fixture.get_pixel(70, 170);
        let interior = *fixture.get_pixel(75, 175);
        for pixel in fixture.pixels_mut() {
            if *pixel == border {
                *pixel = interior;
            }
        }
    }
    let mut screen = RgbImage::from_pixel(1920, 1080, Rgb([24, 39, 62]));
    imageops::overlay(&mut screen, &fixture, 160, 90);
    screen
}
fn competing_cards(two_rows: bool) -> RgbImage {
    let fixture =
        load_png(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/augment-card.png"))
            .unwrap();
    let mut screen = RgbImage::from_pixel(
        if two_rows { 1920 } else { 2400 },
        if two_rows { 1440 } else { 1350 },
        Rgb([24, 39, 62]),
    );
    for row in 0..if two_rows { 2 } else { 1 } {
        for column in 0..if two_rows { 3 } else { 4 } {
            let card =
                imageops::crop_imm(&fixture, 70 + (column % 3) * 500, 170, 460, 560).to_image();
            let card = imageops::resize(
                &card,
                if two_rows { 460 } else { 430 },
                if two_rows { 310 } else { 560 },
                imageops::FilterType::Triangle,
            );
            imageops::overlay(
                &mut screen,
                &card,
                if two_rows {
                    230 + column as i64 * 500
                } else {
                    160 + column as i64 * 520
                },
                if two_rows {
                    360 + row as i64 * 370
                } else {
                    350
                },
            );
        }
    }
    screen
}
fn reset_pixel_state() {
    *FRAME.lock().unwrap() = None;
    *TITLE_WATCH.get_or_init(Default::default).lock().unwrap() = Default::default();
    *PANEL_GATE.get_or_init(Default::default).lock().unwrap() = Default::default();
    *EMPTY_FALLBACK.get_or_init(Default::default).lock().unwrap() = Default::default();
}
fn replay(case: &Case) -> Value {
    reset_pixel_state();
    let (w, h) = case.frame.dimensions();
    // EXACT runtime rectangle math; do not replace it with hand-cut title strips.
    let region = crate::capture::center_region(crate::capture::ScreenRect {
        x: 0,
        y: 0,
        width: w,
        height: h,
    })
    .unwrap();
    let mut started = Instant::now();
    let mut captured = imageops::crop_imm(
        &case.frame,
        region.x as u32,
        region.y as u32,
        region.width,
        region.height,
    )
    .to_image();
    let mut masked = Vec::new();
    if let Some(overlay) = case.overlay {
        if let Some(rect) = crate::capture::mask_region(&mut captured, region, overlay) {
            masked.push(rect);
        }
    }
    let control_ids = if case.id == "synthetic-readable-titles-without-border" {
        // Control ONLY: the recognizer can read the same input. Never substitute
        // these IDs for the acceptance result of the actual screen entry.
        let control_started = Instant::now();
        let lines = recognize_timed(captured.clone()).unwrap().lines;
        let control: Vec<_> = crate::scoring::match_augments(&lines)
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(
            control, case.expected,
            "The synthetic control must really be readable"
        );
        started += control_started.elapsed(); // control work is not screen-path latency
        Some(control)
    } else {
        None
    };
    let scope = json!(["offline-replay", case.id, case.band]).to_string();
    let mut scan = process_scan_image(captured, "capture", Some(&scope), None, started, &masked)
        .expect("actual screen processing must return a structured result");
    // Only canonical candidates and numeric/status diagnostics leave this test.
    // Never export raw OCR text, screenshot pixels, player names or payloads.
    scan["lines"] = json!([]);
    json!({"id":case.id,"band":case.band,"expectedIds":case.expected,
        "clientSize":[w,h],"controlIds":control_ids,"scan":scan})
}

#[test]
fn offline_screen_entry_replay_acceptance() {
    let _priority = crate::game_worker::GameWorkerPriority::enter();
    let expected = ids(&["万用瞄准镜", "亮出你的剑", "巨像的勇气"]);
    let mut cases = Vec::new();
    for band in [1, 7, 11, 15] {
        cases.push(Case {
            id: format!("synthetic-framed-band-{band}"),
            frame: full_frame_fixture(false),
            band,
            expected: expected.clone(),
            overlay: None,
        });
    }
    for (w, h) in [(1280, 720), (2560, 1440)] {
        cases.push(Case {
            id: format!("synthetic-scale-{w}x{h}"),
            frame: imageops::resize(
                &full_frame_fixture(false),
                w,
                h,
                imageops::FilterType::Triangle,
            ),
            band: 11,
            expected: expected.clone(),
            overlay: None,
        });
    }
    // The formerly RED acceptance case keeps its original THREE expected IDs.
    cases.push(Case {
        id: "synthetic-readable-titles-without-border".into(),
        frame: full_frame_fixture(true),
        band: 11,
        expected: expected.clone(),
        overlay: None,
    });
    for two_rows in [false, true] {
        cases.push(Case {
            id: if two_rows {
                "negative-competing-two-rows"
            } else {
                "negative-four-cards"
            }
            .into(),
            frame: competing_cards(two_rows),
            band: 11,
            expected: vec![],
            overlay: None,
        });
    }
    cases.push(Case {
        id: "negative-blank-full-frame".into(),
        frame: RgbImage::new(1920, 1080),
        band: 11,
        expected: vec![],
        overlay: None,
    });
    cases.push(Case {
        id: "negative-textured-full-frame".into(),
        frame: RgbImage::from_fn(1920, 1080, |x, y| {
            Rgb([
                (x ^ y) as u8,
                (x.wrapping_mul(71) + y.wrapping_mul(37)) as u8,
                190,
            ])
        }),
        band: 11,
        expected: vec![],
        overlay: None,
    });
    let mut no_cards = full_frame_fixture(false);
    for pixel in no_cards.pixels_mut() {
        if *pixel.0.iter().max().unwrap() < 145 {
            *pixel = Rgb([24, 39, 62]);
        }
    }
    cases.push(Case {
        id: "negative-readable-names-without-card-surfaces".into(),
        frame: no_cards,
        band: 11,
        expected: vec![],
        overlay: None,
    });

    // Supplied images stay outside Git. Explicit opt-in only; no screenshot files
    // are captured/copied into the repository, and absent references are reported.
    for (env, id, names, sidebar) in [
        (
            "HEXGLOW_OCR_REFERENCE_PRISMATIC",
            "supplied-prismatic",
            ["你摸不到", "位面转移", "无限循环往复"],
            true,
        ),
        (
            "HEXGLOW_OCR_REFERENCE_SILVER",
            "supplied-silver",
            ["狂热者", "台风", "双生火焰"],
            false,
        ),
    ] {
        if let Ok(path) = std::env::var(env) {
            let frame = load_png(Path::new(&path)).expect("explicit reference must be readable");
            let (w, h) = frame.dimensions();
            // Recorded reference-only sidebar geometry, NOT runtime heuristics.
            let overlay = sidebar.then_some(crate::capture::ScreenRect {
                x: (w * 84 / 100) as i32,
                y: (h * 39 / 100) as i32,
                width: w * 16 / 100,
                height: h * 61 / 100,
            });
            // Small synthetic pixel-grid phase changes, NOT recorded animation.
            // All three title strings remain intact; expected IDs do not change.
            for (dx, dy) in [
                (-2, 0),
                (2, 0),
                (0, -2),
                (0, 2),
                (-4, 0),
                (-3, 0),
                (-1, 0),
                (1, 0),
                (3, 0),
                (4, 0),
                (0, -4),
                (0, 4),
            ] {
                let mut shifted = RgbImage::from_pixel(w, h, Rgb([24, 39, 62]));
                imageops::overlay(&mut shifted, &frame, dx, dy);
                cases.push(Case {
                    id: format!("{id}-shift-{dx}-{dy}"),
                    frame: shifted,
                    band: 11,
                    expected: ids(&names),
                    overlay: overlay.map(|r| crate::capture::ScreenRect {
                        x: r.x + dx as i32,
                        y: r.y + dy as i32,
                        ..r
                    }),
                });
            }
            cases.push(Case {
                id: id.into(),
                frame,
                band: 11,
                expected: ids(&names),
                overlay,
            });
        } else {
            println!("REFERENCE_NOT_RUN {id}: explicit image path not provided");
        }
    }
    let records: Vec<_> = cases.iter().map(replay).collect();
    let report = json!({"schema":1,"kind":"native-screen-entry-replay","cases":records});
    if let Ok(path) = std::env::var("HEXGLOW_OCR_REPLAY_OUTPUT") {
        // Only a NEW generated JSON under this checkout's ignored target/ tree.
        // Refuse user-data paths, symlink escapes and existing artifacts.
        use std::io::Write;
        let path = PathBuf::from(path);
        let target = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .canonicalize()
            .unwrap();
        assert!(
            path.parent()
                .unwrap()
                .canonicalize()
                .unwrap()
                .starts_with(&target)
                && path
                    .extension()
                    .is_some_and(|extension| extension == "json"),
            "Replay output must be a fresh JSON inside src-tauri/target"
        );
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap()
            .write_all(&serde_json::to_vec_pretty(&report).unwrap())
            .unwrap();
    }
    let mut failures = Vec::new();
    for record in report["cases"].as_array().unwrap() {
        let actual: Vec<_> = record["scan"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap().to_owned())
            .collect();
        let expected: Vec<_> = record["expectedIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_owned())
            .collect();
        println!(
            "REPLAY_CASE {}",
            json!({"id":record["id"],"band":record["band"],
            "expectedIds":expected,"actualIds":actual,"reason":record["scan"]["reason"],
                "controlIds":record["controlIds"],
            "roi":record["scan"]["ocrRegion"],"engine":record["scan"]["engine"],
            "elapsedMs":record["scan"]["elapsedMs"]})
        );
        if actual != expected {
            failures.push(record["id"].as_str().unwrap().to_owned());
        }
    }
    assert!(
        failures.is_empty(),
        "Screen-entry acceptance failures (do NOT change expected IDs): {failures:?}"
    );
}
