//! Borders refine an area, they do not authorize recognition or select names.
//! Weak borders fall back to three aligned card interiors, never surrounding gameplay.
use image::RgbImage;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug)]
pub(crate) struct ChoiceRegion {
    pub roi: Rect,
    pub cards: Vec<Rect>,
    pub titles_only: bool,
    pub origin: &'static str,
}

fn masked(masked: &[crate::capture::MaskRect], left: u32, right: u32, y: u32) -> bool {
    masked
        .iter()
        .any(|r| y >= r.y && y < r.y + r.height && left < r.x + r.width && right >= r.x)
}
fn edge_strength(
    image: &RgbImage,
    left: u32,
    right: u32,
    y: u32,
    masks: &[crate::capture::MaskRect],
) -> u8 {
    // Include the whole edge band. Its midpoint can fall on flat border paint.
    // A known own-window mask boundary cannot supply evidence for a card edge.
    if masked(masks, left, right, y) {
        return 0;
    }
    let mut low = [255u8; 3];
    let mut high = [0u8; 3];
    for x in left..=right.min(image.width() - 1) {
        let pixel = image.get_pixel(x, y).0;
        for c in 0..3 {
            low[c] = low[c].min(pixel[c]);
            high[c] = high[c].max(pixel[c]);
        }
    }
    (0..3).map(|c| high[c] - low[c]).max().unwrap_or(0)
}
fn bands(bits: &[bool], gap: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut first = None;
    let mut last = 0;
    for (i, hit) in bits.iter().copied().enumerate() {
        if hit {
            if first.is_none() {
                first = Some(i);
            }
            last = i;
        } else if first.is_some() && i - last > gap {
            out.push((first.take().unwrap(), last + 1));
        }
    }
    if let Some(first) = first {
        out.push((first, last + 1));
    }
    out
}
#[cfg(test)]
pub(crate) fn locate(image: &RgbImage) -> Option<ChoiceRegion> {
    locate_masked(image, &[]).0
}
pub(crate) fn locate_masked(
    image: &RgbImage,
    masks: &[crate::capture::MaskRect],
) -> (Option<ChoiceRegion>, &'static str) {
    match framed_region(image, masks) {
        Ok(region) => (Some(region), "border-ready"),
        Err(border_reason) => match interior_region(image, masks) {
            Ok(region) => (Some(region), border_reason),
            Err(_) => (None, border_reason),
        },
    }
}
fn framed_region(
    image: &RgbImage,
    masks: &[crate::capture::MaskRect],
) -> Result<ChoiceRegion, &'static str> {
    let (w, h) = image.dimensions();
    if w < 320 || h < 160 {
        return Err("image-too-small");
    }
    const COLS: usize = 256;
    const ROWS: usize = 96;
    let step = (w / COLS as u32).max(1);
    let mut edge = [0usize; COLS];
    for (col, count) in edge.iter_mut().enumerate() {
        let x = col as u32 * w / COLS as u32;
        for row in 0..ROWS {
            let y = row as u32 * h / ROWS as u32;
            if edge_strength(image, x, x + step, y, masks) >= 35 {
                *count += 1;
            }
        }
    }
    let edge_bands: Vec<_> = bands(
        &edge
            .iter()
            .map(|n| n * 100 >= ROWS * 42)
            .collect::<Vec<_>>(),
        1,
    )
    .into_iter()
    .map(|(a, b)| {
        (
            a as u32 * w / COLS as u32,
            (((b - 1) as u32 * w / COLS as u32) + step).min(w - 1),
            // Preserve the previous crop anchor. Only edge VALIDATION
            // uses the entire band; changing OCR sampling phase is unnecessary.
            ((a + b - 1) / 2) as u32 * w / COLS as u32,
        )
    })
    .collect();
    let edges: Vec<_> = edge_bands.iter().map(|(_, _, anchor)| *anchor).collect();
    let candidates: Vec<_> = edges
        .windows(2)
        .enumerate()
        .filter_map(|(i, pair)| {
            let width = pair[1] - pair[0];
            (width >= w * 12 / 100 && width <= w * 35 / 100).then_some((i, pair[0], pair[1]))
        })
        .collect();
    if candidates.len() != 3 || candidates.windows(2).any(|p| p[0].2 >= p[1].1) {
        return Err("border-card-count");
    }
    let widths: Vec<_> = candidates.iter().map(|p| p.2 - p.1).collect();
    if widths.iter().max().unwrap() * 100 > widths.iter().min().unwrap() * 135 {
        return Err("border-card-widths");
    }
    let distances: Vec<_> = candidates.windows(2).map(|p| p[1].1 - p[0].1).collect();
    if distances[0].max(distances[1]) * 100 > distances[0].min(distances[1]) * 125 {
        return Err("border-card-spacing");
    }
    let borders: Vec<_> = candidates
        .iter()
        .flat_map(|p| [edge_bands[p.0], edge_bands[p.0 + 1]])
        .collect();
    let vertical: Vec<_> = (0..ROWS)
        .map(|row| {
            let y = row as u32 * h / ROWS as u32;
            borders
                .iter()
                .filter(|(a, b, _)| edge_strength(image, *a, *b, y, masks) >= 30)
                .count()
                >= 4
        })
        .collect();
    let bodies: Vec<_> = bands(&vertical, 2)
        .into_iter()
        .filter(|(a, b)| b - a >= ROWS / 7)
        .collect();
    if bodies.len() != 1 {
        return Err("border-body-runs");
    } // Two rows cannot be reduced to a convenient first row.
    let (top, bottom) = bodies[0];
    let y = top as u32 * h / ROWS as u32;
    let bottom = (bottom as u32 * h / ROWS as u32).min(h);
    let cards: Vec<_> = candidates
        .into_iter()
        .map(|(_, left, right)| {
            let x = left + step / 2;
            let right = right.saturating_sub(step / 2);
            Rect {
                x,
                y,
                width: right.saturating_sub(x),
                height: bottom - y,
            }
        })
        .collect();
    if cards.iter().any(|r| r.width < 80 || r.height < h / 3) {
        return Err("border-card-size");
    }
    Ok(title_region(image, cards, "border"))
}

fn colour_key(pixel: [u8; 3]) -> Option<u16> {
    (*pixel.iter().max().unwrap() <= 96).then(|| {
        (u16::from(pixel[0] / 8) << 8) | (u16::from(pixel[1] / 8) << 4) | u16::from(pixel[2] / 8)
    })
}
/// A weak-layout fallback based on broad uniform card interiors, not frame paint.
/// It only proposes an input region; real OCR/spatial/uniqueness guards are unchanged.
fn interior_region(
    image: &RgbImage,
    masks: &[crate::capture::MaskRect],
) -> Result<ChoiceRegion, &'static str> {
    let (w, h) = image.dimensions();
    if w < 320 || h < 160 {
        return Err("image-too-small");
    }
    const COLS: usize = 256;
    const ROWS: usize = 96;
    let mut columns = Vec::with_capacity(COLS);
    for col in 0..COLS {
        let x = col as u32 * w / COLS as u32;
        let mut counts = std::collections::BTreeMap::<u16, usize>::new();
        for row in 0..ROWS {
            let y = row as u32 * h / ROWS as u32;
            if !masked(masks, x, x, y) {
                if let Some(key) = colour_key(image.get_pixel(x, y).0) {
                    *counts.entry(key).or_default() += 1;
                }
            }
        }
        columns.push(
            counts
                .into_iter()
                .max_by_key(|(_, count)| *count)
                .filter(|(_, count)| count * 100 >= ROWS * 52)
                .map(|(key, _)| key),
        );
    }
    let mut runs = Vec::new();
    let mut begin = 0;
    while begin < COLS {
        let key = columns[begin];
        let mut end = begin + 1;
        while end < COLS && columns[end] == key {
            end += 1;
        }
        let left = begin as u32 * w / COLS as u32;
        let right = end as u32 * w / COLS as u32;
        if let Some(key) = key {
            if right - left >= w * 12 / 100 && right - left <= w * 35 / 100 {
                runs.push((key, left, right));
            }
        }
        begin = end;
    }
    // No arbitrary triple selection from four candidates or conflicting colours.
    if runs.len() != 3 || runs.iter().any(|r| r.0 != runs[0].0) {
        return Err("interior-card-count");
    }
    if runs.iter().any(|r| r.2 - r.1 < 80) {
        return Err("interior-card-size");
    }
    let widths: Vec<_> = runs.iter().map(|r| r.2 - r.1).collect();
    if widths.iter().max().unwrap() * 100 > widths.iter().min().unwrap() * 135 {
        return Err("interior-card-widths");
    }
    let a = runs[1].1 - runs[0].1;
    let b = runs[2].1 - runs[1].1;
    if a.max(b) * 100 > a.min(b) * 125 {
        return Err("interior-card-spacing");
    }
    let key = runs[0].0;
    let rows: Vec<_> = (0..ROWS)
        .map(|row| {
            let y = row as u32 * h / ROWS as u32;
            runs.iter().all(|(_, left, right)| {
                let mut count = 0;
                let mut total = 0;
                for x in (*left..*right).step_by(((right - left) / 48).max(1) as usize) {
                    total += 1;
                    if !masked(masks, x, x, y) && colour_key(image.get_pixel(x, y).0) == Some(key) {
                        count += 1;
                    }
                }
                count * 100 >= total * 52
            })
        })
        .collect();
    let bodies: Vec<_> = bands(&rows, 2)
        .into_iter()
        .filter(|(a, b)| b - a >= ROWS / 7)
        .collect();
    if bodies.len() != 1 {
        return Err("interior-body-runs");
    }
    let y = bodies[0].0 as u32 * h / ROWS as u32;
    let bottom = bodies[0].1 as u32 * h / ROWS as u32;
    if bottom - y < h / 3 {
        return Err("interior-card-size");
    }
    let cards = runs
        .into_iter()
        .map(|(_, left, right)| Rect {
            x: left,
            y,
            width: right - left,
            height: bottom - y,
        })
        .collect();
    Ok(title_region(image, cards, "interior-fallback"))
}

fn title_region(image: &RgbImage, cards: Vec<Rect>, origin: &'static str) -> ChoiceRegion {
    let (w, h) = image.dimensions();
    let step = (w / 256).max(1);
    let y = cards[0].y;
    let bottom = y + cards[0].height;
    let mut body = Rect {
        x: cards[0].x,
        y,
        width: cards[2].x + cards[2].width - cards[0].x,
        height: bottom - y,
    };
    // Aligned bright strokes in all three interiors; descriptions have smaller
    // line height. Ambiguous icons/rows stay on the bounded card-body fallback.
    let text_rows: Vec<_> = (y..bottom)
        .map(|row| {
            cards.iter().all(|r| {
                let hop = (r.width / 192).max(1);
                let mut bright = 0;
                let mut n = 0;
                for x in (r.x + step..r.x + r.width - step).step_by(hop as usize) {
                    let p = image.get_pixel(x, row).0;
                    let hi = *p.iter().max().unwrap();
                    let lo = *p.iter().min().unwrap();
                    if lo >= 145 && hi - lo <= 75 {
                        bright += 1;
                    }
                    n += 1;
                }
                n > 0 && bright >= 3 && bright * 100 < n * 65
            })
        })
        .collect();
    let mut text: Vec<_> = bands(&text_rows, (h / 240).max(1) as usize)
        .into_iter()
        .filter(|(a, b)| {
            b - a >= (h / 80).max(5) as usize
                && b - a <= (body.height / 7).min(h / 16).max(12) as usize
        })
        .collect();
    text.sort_by_key(|(a, b)| std::cmp::Reverse(b - a));
    let titles_only = if let Some(&(a, b)) = text.first() {
        if text
            .get(1)
            .is_none_or(|(c, d)| (d - c) * 100 < (b - a) * 85)
        {
            let pad = ((b - a) as u32 / 3).max(4);
            body.y = (y + a as u32).saturating_sub(pad).max(y);
            let end = (y + b as u32 + pad).min(bottom);
            body.height = end - body.y;
            true
        } else {
            false
        }
    } else {
        false
    };
    ChoiceRegion {
        roi: body,
        cards,
        titles_only,
        origin,
    }
}
impl ChoiceRegion {
    pub fn full_cards(&self) -> Self {
        Self {
            roi: Rect {
                x: self.cards[0].x,
                y: self.cards[0].y,
                width: self.cards[2].x + self.cards[2].width - self.cards[0].x,
                height: self.cards[0].height,
            },
            cards: self.cards.clone(),
            titles_only: false,
            origin: self.origin,
        }
    }
    pub fn use_observed_row(&mut self, top: u32, bottom: u32) {
        let body = self.full_cards().roi;
        if top >= body.y && bottom <= body.y + body.height && bottom > top {
            self.roi = Rect {
                y: top,
                height: bottom - top,
                ..body
            };
            self.titles_only = true;
        }
    }
    pub fn input(&self, image: &RgbImage) -> RgbImage {
        let r = self.roi;
        let mut cropped = image::imageops::crop_imm(image, r.x, r.y, r.width, r.height).to_image();
        for (x, _, p) in cropped.enumerate_pixels_mut() {
            let absolute = x + r.x;
            if !self
                .cards
                .iter()
                .any(|card| absolute >= card.x && absolute < card.x + card.width)
            {
                *p = image::Rgb([0, 0, 0]);
            }
        }
        cropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;
    fn framed(count: u32, rows: u32) -> RgbImage {
        let mut image = RgbImage::from_pixel(1600, 900, Rgb([30, 60, 85]));
        let width = 1400 / count;
        for row in 0..rows {
            for card in 0..count {
                let left = 70 + card * width;
                let top = 100 + row * 360;
                let bottom = if rows == 1 { 790 } else { top + 270 };
                for y in top..bottom {
                    for x in left..left + width - 35 {
                        image.put_pixel(
                            x,
                            y,
                            if x < left + 8 || x >= left + width - 43 {
                                Rgb([190, 190, 160])
                            } else {
                                Rgb([6, 18, 25])
                            },
                        );
                    }
                }
                for y in top + 100..top + 130 {
                    for x in left + 100..left + width - 130 {
                        if x % 10 < 5 {
                            image.put_pixel(x, y, Rgb([235, 235, 220]));
                        }
                    }
                }
            }
        }
        image
    }
    #[test]
    fn own_mask_boundary_is_not_edge_evidence_and_fallback_stays_in_cards() {
        let mut image = framed(3, 1);
        let mask = crate::capture::MaskRect {
            x: 1470,
            y: 160,
            width: 130,
            height: 740,
        };
        for y in mask.y..mask.y + mask.height {
            for x in mask.x..mask.x + mask.width {
                image.put_pixel(x, y, Rgb([0, 0, 0]));
            }
        }
        assert!(edge_strength(&image, mask.x - 2, mask.x + 2, 200, &[]) >= 35);
        assert_eq!(
            edge_strength(&image, mask.x - 2, mask.x + 2, 200, &[mask]),
            0
        );
        let region = locate_masked(&image, &[mask]).0.unwrap();
        let input = region.input(&image);
        assert!(region.roi.x + region.roi.width <= mask.x);
        for (x, _, pixel) in input.enumerate_pixels() {
            if !region
                .cards
                .iter()
                .any(|r| x + region.roi.x >= r.x && x + region.roi.x < r.x + r.width)
            {
                assert_eq!(pixel.0, [0, 0, 0]);
            }
        }
    }

    #[test]
    fn unframed_interiors_are_an_area_hint_not_candidate_identity() {
        let mut image = framed(3, 1);
        for pixel in image.pixels_mut() {
            if *pixel == Rgb([190, 190, 160]) {
                *pixel = Rgb([6, 18, 25]);
            } else if *pixel == Rgb([30, 60, 85]) {
                // Low-contrast background forces this test through the coarse
                // interior fallback rather than ordinary high-contrast edges.
                *pixel = Rgb([2, 11, 20]);
            }
        }
        let region = locate(&image).expect("coarse three interiors remain available");
        assert_eq!(region.origin, "interior-fallback");
        assert_eq!(region.cards.len(), 3);
        assert!(region.roi.height < image.height());
        // A single joined dark scene has no safe three-card area.
        assert!(locate(&RgbImage::from_pixel(1600, 900, Rgb([6, 18, 25]))).is_none());
    }

    #[test]
    fn bounds_recognition_to_three_cards_and_excludes_background_and_gaps() {
        let image = framed(3, 1);
        let region = locate(&image).expect("three framed cards");
        assert!(region.titles_only);
        assert!(region.roi.height < 100);
        assert!(region.roi.x > 0 && region.roi.x + region.roi.width < image.width());
        let input = region.input(&image);
        let gap =
            (region.cards[0].x + region.cards[0].width + region.cards[1].x) / 2 - region.roi.x;
        assert_eq!(input.get_pixel(gap, input.height() / 2).0, [0, 0, 0]);
        let body = region.full_cards();
        assert!(!body.titles_only);
        assert!(body.roi.height > region.roi.height);
        assert_eq!(
            body.input(&image).get_pixel(gap, body.roi.height / 2).0,
            [0, 0, 0]
        );
    }
    #[test]
    fn large_neutral_icon_strokes_do_not_replace_the_title_band() {
        let mut image = framed(3, 1);
        let cards = locate(&image).unwrap().cards;
        for card in cards {
            for y in 340..410 {
                for x in card.x + 100..card.x + card.width - 100 {
                    if x % 10 < 5 {
                        image.put_pixel(x, y, Rgb([235, 235, 220]));
                    }
                }
            }
        }
        let region = locate(&image).unwrap();
        assert!(region.titles_only);
        assert!(region.roi.y < 300 && region.roi.height < 100);
    }

    #[test]
    fn title_hints_stay_inside_cards_and_outside_pixels_cannot_change_input() {
        let mut image = framed(3, 1);
        let mut region = locate(&image).unwrap();
        let body = region.full_cards().roi;
        let original = region.input(&image);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            if !region
                .cards
                .iter()
                .any(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
            {
                *pixel = Rgb([255, 255, 255]);
            }
        }
        assert_eq!(region.input(&image), original);
        let before = region.roi;
        region.use_observed_row(0, body.y);
        assert_eq!((region.roi.y, region.roi.height), (before.y, before.height));
        region.use_observed_row(body.y, body.y + body.height + 1);
        assert_eq!((region.roi.y, region.roi.height), (before.y, before.height));
        region.use_observed_row(body.y + 30, body.y + 70);
        assert_eq!((region.roi.y, region.roi.height), (body.y + 30, 40));
        assert!(region.titles_only);
    }

    #[test]
    fn rejects_blank_noise_four_cards_and_competing_rows() {
        assert!(locate(&RgbImage::new(1600, 900)).is_none());
        assert!(locate(&framed(4, 1)).is_none());
        assert!(locate(&framed(3, 2)).is_none());
        let noise = RgbImage::from_fn(1600, 900, |x, y| {
            Rgb([(x ^ y) as u8, (x * 71 + y * 37) as u8, 190])
        });
        assert!(locate(&noise).is_none());
    }
    #[test]
    fn handles_scaling_without_fixed_screen_coordinates() {
        for (w, h) in [(1280, 720), (1920, 1080), (2560, 1440)] {
            let image =
                image::imageops::resize(&framed(3, 1), w, h, image::imageops::FilterType::Nearest);
            assert!(locate(&image).is_some());
        }
    }
    #[test]
    #[ignore = "Optional offline check of an explicitly supplied reference"]
    fn supplied_reference_localizes_without_screen_capture() {
        let image = image::open(
            std::env::var("HEXGLOW_PANEL_PROBE_REFERENCE").expect("explicit reference"),
        )
        .unwrap()
        .to_rgb8();
        let (w, h) = image.dimensions();
        let mut image = image::imageops::crop_imm(
            &image,
            w * 5 / 100,
            h * 24 / 100,
            w * 90 / 100,
            h * 52 / 100,
        )
        .to_image();
        crate::capture::mask_region(
            &mut image,
            crate::capture::ScreenRect {
                x: (w * 5 / 100) as i32,
                y: (h * 24 / 100) as i32,
                width: w * 90 / 100,
                height: h * 52 / 100,
            },
            crate::capture::ScreenRect {
                x: (w * 84 / 100) as i32,
                y: (h * 39 / 100) as i32,
                width: w * 16 / 100,
                height: h * 61 / 100,
            },
        );
        let region = locate(&image).expect("provided three-card panel must localize");
        println!(
            "roi={}x{} titles_only={}",
            region.roi.width, region.roi.height, region.titles_only
        );
        let started = std::time::Instant::now();
        let lines = crate::ocr::recognize_image(region.input(&image)).unwrap();
        let candidates = crate::scoring::match_augments(&lines);
        let expected: Vec<_> = ["你摸不到", "位面转移", "无限循环往复"]
            .iter()
            .map(|name| crate::scoring::canonical_augment_exact(name).unwrap())
            .collect();
        assert_eq!(
            candidates.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            expected
        );
        println!(
            "title_roi_lines={} matched={} elapsed={}ms (cold debug, not a gameplay benchmark)",
            lines.len(),
            candidates.len(),
            started.elapsed().as_millis()
        );
    }
}
