//! Bounded pixel-only screen triage. A hint is never a candidate or proof of a choice.
use image::RgbImage;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PanelHint {
    Likely,
    Uncertain,
    Unlikely,
}
impl PanelHint {
    pub fn code(self) -> &'static str {
        match self {
            Self::Likely => "likely",
            Self::Uncertain => "uncertain",
            Self::Unlikely => "unlikely",
        }
    }
}

/// Sample at most 128x80 pixels, without resizing, OCR, allocation of a full image,
/// template names, rarity colours or game/player data. Two broad flat dark runs
/// allow a partially cropped card. Unsupported geometry remains uncertain.
pub(crate) fn inspect(image: &RgbImage) -> PanelHint {
    let (width, height) = image.dimensions();
    if width < 320 || height < 160 {
        return PanelHint::Uncertain;
    }
    const COLS: usize = 128;
    const ROWS: usize = 80;
    let mut flat_dark = [0usize; COLS];
    let mut textured = 0usize;
    let mut lo = 255u8;
    let mut hi = 0u8;
    for (col, count) in flat_dark.iter_mut().enumerate() {
        let x = ((col as u64 * u64::from(width)) / COLS as u64) as u32;
        for row in 0..ROWS {
            let y = ((row as u64 * u64::from(height)) / ROWS as u64) as u32;
            let p = image.get_pixel(x, y).0;
            let q = image
                .get_pixel((x + (width / COLS as u32).max(1)).min(width - 1), y)
                .0;
            let r = image
                .get_pixel(x, (y + (height / ROWS as u32).max(1)).min(height - 1))
                .0;
            let delta = (0..3)
                .map(|c| p[c].abs_diff(q[c]).max(p[c].abs_diff(r[c])))
                .max()
                .unwrap_or(0);
            let value = *p.iter().max().unwrap();
            lo = lo.min(value);
            hi = hi.max(value);
            if value < 110 && delta < 24 {
                *count += 1;
            }
            if delta > 38 {
                textured += 1;
            }
        }
    }
    let mut runs = 0;
    let mut span = 0;
    let mut broad = 0;
    for count in flat_dark.into_iter().chain(std::iter::once(0)) {
        if count * 100 >= ROWS * 52 {
            span += 1;
        } else {
            if (7..=70).contains(&span) {
                runs += 1;
                broad += span;
            }
            span = 0;
        }
    }
    let flat = flat_dark.iter().sum::<usize>();
    // A dark scene with HUD text is not card geometry. Joined/unknown dark
    // themes remain uncertain and use bounded full-OCR fallback instead.
    if runs >= 2 && broad >= 30 {
        return PanelHint::Likely;
    }
    if hi.saturating_sub(lo) < 12
        || flat * 100 < COLS * ROWS * 15 && textured * 100 > COLS * ROWS * 30
    {
        return PanelHint::Unlikely;
    }
    PanelHint::Uncertain
}

#[derive(Default)]
pub(crate) struct ProbeGate {
    scope: Option<String>,
    began: Option<Instant>,
    last_full: Option<Instant>,
    last_panel: Option<Instant>,
}
impl ProbeGate {
    /// Reserve before inference; changing the match/level scope discards old timing.
    pub fn allow(&mut self, scope: &str, hint: PanelHint, now: Instant) -> bool {
        if self.scope.as_deref() != Some(scope) {
            self.scope = Some(scope.to_owned());
            self.began = Some(now);
            self.last_full = None;
            self.last_panel = None;
        }
        let age = |at: Option<Instant>| at.and_then(|at| now.checked_duration_since(at));
        let recent = age(self.last_panel).is_some_and(|age| age <= Duration::from_secs(12));
        let due = match hint {
            PanelHint::Likely => true,
            PanelHint::Uncertain => {
                self.last_full.is_none()
                    || age(self.last_full).is_some_and(|age| age >= Duration::from_secs(2))
            }
            PanelHint::Unlikely => match self.last_full {
                None => age(self.began).is_some_and(|age| age >= Duration::from_secs(3)),
                Some(_) => age(self.last_full).is_some_and(|age| age >= Duration::from_secs(20)),
            },
        };
        if recent || due {
            self.last_full = Some(now);
            true
        } else {
            false
        }
    }
    pub fn observe(&mut self, scope: &str, matched: usize, now: Instant) {
        if self.scope.as_deref() == Some(scope) {
            // Cooldown is completion-to-next-inference, not start-to-start;
            // a slow empty frame cannot continuously retrigger full inference.
            self.last_full = Some(now);
            if matched >= 2 {
                self.last_panel = Some(now);
            }
        }
    }
}

/// Empty Tiny frames must not run Small on every observation. This budget only
/// defers an empty-result fallback; an actual title hint or Tiny error overrides
/// it. No image or candidate identity is retained, and each level starts fresh.
#[derive(Default)]
pub(crate) struct EmptyFallbackBudget {
    scope: Option<String>,
    last_small: Option<Instant>,
}
impl EmptyFallbackBudget {
    pub fn due(&mut self, scope: &str, now: Instant) -> bool {
        if self.scope.as_deref() != Some(scope) {
            self.scope = Some(scope.to_owned());
            self.last_small = None;
        }
        self.last_small.is_none_or(|at| {
            now.checked_duration_since(at)
                .is_some_and(|age| age >= Duration::from_secs(6))
        })
    }
    pub fn completed(&mut self, scope: &str, now: Instant) {
        if self.scope.as_deref() == Some(scope) {
            self.last_small = Some(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;
    fn cards(width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, y| {
            let in_card = (0..3)
                .any(|i| x > width * (3 + i * 32) / 100 && x < width * (29 + i * 32) / 100)
                && y > height / 8
                && y < height * 7 / 8;
            if in_card {
                Rgb([6, 20, 25])
            } else {
                Rgb([65, 80, 120])
            }
        })
    }
    #[test]
    fn supports_three_cards_scaled_and_partly_cropped_without_rarity_colours() {
        for (w, h) in [(800, 450), (1600, 900), (2400, 1350)] {
            let image = cards(w, h);
            assert_eq!(inspect(&image), PanelHint::Likely);
            let crop =
                image::imageops::crop_imm(&image, w / 5, h / 5, w * 3 / 5, h * 3 / 5).to_image();
            assert_eq!(inspect(&crop), PanelHint::Likely);
        }
        let fixture = image::load_from_memory(include_bytes!("../tests/fixtures/augment-card.png"))
            .unwrap()
            .to_rgb8();
        // Fixtures bypass the gate; an unknown dark theme must not be rejected.
        assert_ne!(inspect(&fixture), PanelHint::Unlikely);
    }
    #[test]
    fn blank_and_textured_scenes_do_not_look_like_cards_but_unknown_styles_stay_uncertain() {
        assert_eq!(inspect(&RgbImage::new(800, 450)), PanelHint::Unlikely);
        let noise = RgbImage::from_fn(800, 450, |x, y| {
            Rgb([
                (x.wrapping_mul(31) ^ y.wrapping_mul(73)) as u8,
                (x.wrapping_mul(63) ^ y.wrapping_mul(17)) as u8,
                (x.wrapping_mul(97) ^ y.wrapping_mul(101)) as u8,
            ])
        });
        assert_eq!(inspect(&noise), PanelHint::Unlikely);
        assert_eq!(inspect(&RgbImage::new(100, 100)), PanelHint::Uncertain);
    }

    #[test]
    fn dark_backdrop_with_bright_hud_is_not_enough_to_claim_card_geometry() {
        let scene = RgbImage::from_fn(800, 450, |x, y| {
            if y < 35 && x > 50 && x < 750 {
                Rgb([230, 230, 210])
            } else {
                Rgb([8, 20, 30])
            }
        });
        assert_eq!(inspect(&scene), PanelHint::Uncertain);
        let mut gate = ProbeGate::default();
        let at = Instant::now();
        assert!(gate.allow("round-7", PanelHint::Uncertain, at));
        gate.observe("round-7", 0, at + Duration::from_secs(5));
        assert!(!gate.allow("round-7", PanelHint::Uncertain, at + Duration::from_secs(6)));
        assert!(gate.allow("round-7", PanelHint::Uncertain, at + Duration::from_secs(7)));
    }
    #[test]
    fn empty_fallback_budget_resets_by_level_and_uses_completion_not_start() {
        let mut budget = EmptyFallbackBudget::default();
        let at = Instant::now();
        assert!(budget.due("match-round-7", at));
        budget.completed("match-round-7", at + Duration::from_secs(4));
        assert!(!budget.due("match-round-7", at + Duration::from_secs(5)));
        assert!(!budget.due("match-round-7", at + Duration::from_secs(9)));
        assert!(budget.due("match-round-7", at + Duration::from_secs(10)));
        assert!(budget.due("match-round-11", at + Duration::from_secs(10)));
        budget.completed("match-round-7", at + Duration::from_secs(11));
        assert!(budget.due("match-round-11", at + Duration::from_secs(11)));
        budget.completed("match-round-11", at + Duration::from_secs(11));
        assert!(!budget.due("match-round-11", at + Duration::from_secs(10)));
    }
    #[test]
    fn bounded_fallback_recent_panel_and_new_level_never_create_candidate_evidence() {
        let mut gate = ProbeGate::default();
        let at = Instant::now();
        assert!(!gate.allow("round-7", PanelHint::Unlikely, at));
        assert!(gate.allow("round-7", PanelHint::Unlikely, at + Duration::from_secs(3)));
        assert!(!gate.allow("round-7", PanelHint::Unlikely, at + Duration::from_secs(4)));
        assert!(gate.allow("round-7", PanelHint::Unlikely, at + Duration::from_secs(23)));
        assert!(gate.allow(
            "round-11",
            PanelHint::Uncertain,
            at + Duration::from_secs(24)
        ));
        assert!(!gate.allow(
            "round-11",
            PanelHint::Uncertain,
            at + Duration::from_secs(25)
        ));
        assert!(gate.allow("round-11", PanelHint::Likely, at + Duration::from_secs(25)));
        gate.observe("round-7", 3, at + Duration::from_secs(25));
        assert!(!gate.allow(
            "round-11",
            PanelHint::Unlikely,
            at + Duration::from_secs(26)
        ));
        gate.observe("round-11", 3, at + Duration::from_secs(26));
        assert!(gate.allow(
            "round-11",
            PanelHint::Unlikely,
            at + Duration::from_secs(27)
        ));
        assert!(!gate.allow(
            "round-15",
            PanelHint::Unlikely,
            at + Duration::from_secs(28)
        ));
    }
    #[test]
    #[ignore = "Optional read-only check of an explicitly supplied reference image"]
    fn supplied_reference_is_not_suppressed() {
        let path = std::env::var("HEXGLOW_PANEL_PROBE_REFERENCE")
            .expect("explicit reference path required");
        let image = image::open(path).unwrap().to_rgb8();
        let (w, h) = image.dimensions();
        assert_eq!(inspect(&image), PanelHint::Likely);
        let (x, y, width, height) = crate::capture::center_rect(w, h);
        let mut crop = image::imageops::crop_imm(&image, x, y, width, height).to_image();
        crate::capture::mask_region(
            &mut crop,
            crate::capture::ScreenRect {
                x: x as i32,
                y: y as i32,
                width,
                height,
            },
            crate::capture::ScreenRect {
                x: (w * 84 / 100) as i32,
                y: (h * 38 / 100) as i32,
                width: w * 16 / 100 + 1,
                height: h * 62 / 100 + 1,
            },
        );
        assert_eq!(inspect(&crop), PanelHint::Likely);
    }
}
