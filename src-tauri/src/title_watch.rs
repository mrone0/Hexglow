//! Exact title pixels only pace completed-choice monitoring. They never return
//! OCR text/candidates or authorize analysis. Changed/unknown images fail open.
use image::RgbImage;
use std::time::{Duration, Instant};

const FULL_CHECK_INTERVAL: Duration = Duration::from_secs(3);
#[derive(Clone, Copy)]
pub(crate) struct TitleRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
struct Observation {
    scope: String,
    ids: Vec<String>,
    dimensions: (u32, u32),
    regions: Vec<TitleRegion>,
    pixels: Vec<u8>,
    consecutive: usize,
    completed: Instant,
}
#[derive(Default)]
pub(crate) struct TitleWatch(Option<Observation>);

fn pixels(image: &RgbImage, regions: &[TitleRegion]) -> Option<Vec<u8>> {
    if regions.len() != 3 {
        return None;
    }
    let size = regions.iter().try_fold(0u64, |total, r| {
        (r.width > 0
            && r.height > 0
            && r.x.checked_add(r.width)? <= image.width()
            && r.y.checked_add(r.height)? <= image.height())
        .then_some(total + u64::from(r.width) * u64::from(r.height) * 3)
    })?;
    if size > 512_000 {
        return None;
    }
    let mut result = Vec::with_capacity(size as usize);
    for r in regions {
        for y in r.y..r.y + r.height {
            let begin = ((u64::from(y) * u64::from(image.width()) + u64::from(r.x)) * 3) as usize;
            result.extend_from_slice(&image.as_raw()[begin..begin + r.width as usize * 3]);
        }
    }
    Some(result)
}
fn valid_ids(ids: &[String]) -> bool {
    ids.len() == 3
        && ids.iter().all(|id| !id.trim().is_empty() && id.len() <= 64)
        && ids.iter().enumerate().all(|(i, id)| !ids[..i].contains(id))
}
impl TitleWatch {
    /// Prior geometry is only a crop hint. It never returns candidate identity
    /// or counts as another observation; current card geometry must still exist.
    pub fn observed_row(
        &self,
        scope: &str,
        dimensions: (u32, u32),
        now: Instant,
    ) -> Option<(u32, u32)> {
        let last = self.0.as_ref().filter(|last| {
            last.scope == scope
                && last.dimensions == dimensions
                && now
                    .checked_duration_since(last.completed)
                    .is_some_and(|age| age < Duration::from_secs(15))
        })?;
        Some((
            last.regions.iter().map(|r| r.y).min()?,
            last.regions.iter().map(|r| r.y + r.height).max()?,
        ))
    }
    pub fn observe(
        &mut self,
        scope: &str,
        image: &RgbImage,
        mut ids: Vec<String>,
        regions: Vec<TitleRegion>,
        fresh_inference: bool,
        now: Instant,
    ) {
        let Some(pixels) = pixels(image, &regions).filter(|_| valid_ids(&ids)) else {
            self.0 = None;
            return;
        };
        ids.sort();
        let consecutive = self
            .0
            .as_ref()
            .filter(|last| {
                last.scope == scope
                    && last.ids == ids
                    && last.dimensions == image.dimensions()
                    && now
                        .checked_duration_since(last.completed)
                        .is_some_and(|age| age <= Duration::from_secs(15))
            })
            .map_or(usize::from(fresh_inference), |last| {
                (last.consecutive + usize::from(fresh_inference)).min(2)
            });
        self.0 = Some(Observation {
            scope: scope.into(),
            ids,
            dimensions: image.dimensions(),
            regions,
            pixels,
            consecutive,
            completed: now,
        });
    }
    pub fn defer(
        &mut self,
        scope: &str,
        image: &RgbImage,
        expected: &[String],
        now: Instant,
    ) -> bool {
        if !valid_ids(expected) {
            return false;
        }
        let mut ids = expected.to_vec();
        ids.sort();
        let Some(last) = self.0.as_ref().filter(|last| {
            last.scope == scope
                && last.ids == ids
                && last.consecutive >= 2
                && last.dimensions == image.dimensions()
                && now
                    .checked_duration_since(last.completed)
                    .is_some_and(|age| age < FULL_CHECK_INTERVAL)
        }) else {
            return false;
        };
        let mut offset = 0;
        let unchanged = last.regions.iter().all(|r| {
            (r.y..r.y + r.height).all(|y| {
                let begin =
                    ((u64::from(y) * u64::from(image.width()) + u64::from(r.x)) * 3) as usize;
                let len = r.width as usize * 3;
                let same =
                    image.as_raw().get(begin..begin + len) == last.pixels.get(offset..offset + len);
                offset += len;
                same
            })
        }) && offset == last.pixels.len();
        if unchanged {
            return true;
        }
        self.0 = None; // A change must earn new observations, even if pixels change back.
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;
    fn ids() -> Vec<String> {
        vec!["a".into(), "b".into(), "c".into()]
    }
    fn regions() -> Vec<TitleRegion> {
        (0..3)
            .map(|i| TitleRegion {
                x: i * 100,
                y: 20,
                width: 90,
                height: 20,
            })
            .collect()
    }
    #[test]
    fn watches_only_two_fresh_same_group_observations_with_bounded_safety_checks() {
        let mut watch = TitleWatch::default();
        let image = RgbImage::new(300, 100);
        let at = Instant::now();
        watch.observe("one", &image, ids(), regions(), true, at);
        assert_eq!(
            watch.observed_row("one", image.dimensions(), at),
            Some((20, 40))
        );
        assert!(watch
            .observed_row("other", image.dimensions(), at)
            .is_none());
        assert!(watch
            .observed_row("one", image.dimensions(), at + Duration::from_secs(15))
            .is_none());
        assert!(!watch.defer("one", &image, &ids(), at));
        watch.observe("one", &image, ids(), regions(), false, at);
        assert!(!watch.defer("one", &image, &ids(), at));
        watch.observe("one", &image, ids(), regions(), true, at);
        assert!(watch.defer("one", &image, &ids(), at + Duration::from_millis(2999)));
        assert!(!watch.defer("one", &image, &ids(), at + Duration::from_secs(3)));
        assert!(!watch.defer("other", &image, &ids(), at));
        assert!(!watch.defer("one", &image, &["a".into(), "b".into(), "d".into()], at));
        assert!(!watch.defer("one", &RgbImage::new(300, 101), &ids(), at));
        assert!(!watch.defer("one", &image, &ids(), at - Duration::from_secs(1)));
    }
    #[test]
    fn ignores_border_animation_but_title_changes_force_real_ocr_and_reset_stability() {
        let mut watch = TitleWatch::default();
        let mut image = RgbImage::new(300, 100);
        let at = Instant::now();
        for _ in 0..2 {
            watch.observe("one", &image, ids(), regions(), true, at);
        }
        image.put_pixel(150, 80, Rgb([255, 255, 255]));
        assert!(watch.defer("one", &image, &ids(), at));
        image.put_pixel(150, 25, Rgb([255, 255, 255]));
        assert!(!watch.defer("one", &image, &ids(), at));
        image.put_pixel(150, 25, Rgb([0, 0, 0]));
        assert!(!watch.defer("one", &image, &ids(), at));
    }
    #[test]
    fn incomplete_invalid_or_missed_titles_cannot_keep_a_watch_alive() {
        let mut watch = TitleWatch::default();
        let image = RgbImage::new(300, 100);
        let at = Instant::now();
        for _ in 0..2 {
            watch.observe("one", &image, ids(), regions(), true, at);
        }
        watch.observe("one", &image, ids(), vec![], true, at);
        assert!(!watch.defer("one", &image, &ids(), at));
        let bad = vec![
            TitleRegion {
                x: u32::MAX,
                y: 0,
                width: 1,
                height: 1
            };
            3
        ];
        watch.observe("one", &image, ids(), bad, true, at);
        assert!(!watch.defer("one", &image, &ids(), at));
        watch.observe("one", &image, vec!["a".into(); 3], regions(), true, at);
        assert!(!watch.defer("one", &image, &ids(), at));
    }
}
