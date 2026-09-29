//! 屏幕截取：只在正式目标平台 Windows 上实现。
//! 读取显卡当前输出的像素，不读取游戏进程内存。
#[cfg(any(target_os = "windows", test))]
use image::RgbImage;

/// 中心区域比例：海克斯选择卡片固定出现在屏幕中部。
#[cfg(any(target_os = "windows", test))]
const CENTER_WIDTH_RATIO: f64 = 0.62;
#[cfg(any(target_os = "windows", test))]
const CENTER_HEIGHT_RATIO: f64 = 0.52;

#[cfg(target_os = "windows")]
pub fn grab_center_png() -> Result<Vec<u8>, String> {
    let screen = imp::grab_screen()?;
    Ok(encode(&crop_center(&screen)))
}

#[cfg(not(target_os = "windows"))]
pub fn grab_center_png() -> Result<Vec<u8>, String> {
    Err("自动截屏仅支持 Windows；本平台可用图片路径调用 OCR".into())
}

#[cfg(target_os = "windows")]
mod imp {
    use image::RgbImage;
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    pub fn grab_screen() -> Result<RgbImage, String> {
        let (width, height) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        if width <= 0 || height <= 0 {
            return Err("无法获取屏幕尺寸".into());
        }
        let (width, height) = (width as u32, height as u32);
        let bytes = width.saturating_mul(height).saturating_mul(4) as usize;
        unsafe {
            let screen: HDC = GetDC(None);
            if screen.is_invalid() {
                return Err("无法访问屏幕设备上下文".into());
            }
            let memory: HDC = CreateCompatibleDC(Some(screen));
            if memory.is_invalid() {
                ReleaseDC(None, screen);
                return Err("无法创建截取设备上下文".into());
            }
            let mut info = BITMAPINFO::default();
            // Negative height gives top-down rows so pixels map straight onto the image.
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let created = CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0);
            let bitmap = match created {
                Ok(bitmap) => bitmap,
                Err(error) => {
                    let _ = DeleteDC(memory);
                    ReleaseDC(None, screen);
                    return Err(format!("无法分配截取缓冲区：{error}"));
                }
            };
            if bits.is_null() {
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(memory);
                ReleaseDC(None, screen);
                return Err("截取缓冲区为空".into());
            }
            let previous = SelectObject(memory, bitmap.into());
            let copied = BitBlt(memory, 0, 0, width as i32, height as i32, Some(screen), 0, 0, SRCCOPY);
            let decoded = copied.map(|()| {
                let pixels = std::slice::from_raw_parts(bits as *const u8, bytes);
                bgra_to_rgb(pixels, width, height)
            });
            SelectObject(memory, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            decoded.map_err(|error| format!("屏幕像素读取失败：{error}"))
        }
    }

    fn bgra_to_rgb(bytes: &[u8], width: u32, height: u32) -> RgbImage {
        let mut pixels = Vec::with_capacity((width * height * 3) as usize);
        for pixel in bytes.chunks_exact(4) {
            pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        RgbImage::from_raw(width, height, pixels).expect("pixel buffer matches dimensions")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn bgra_to_rgb_swaps_channels() {
            let image = bgra_to_rgb(&[1, 2, 3, 255, 4, 5, 6, 255], 2, 1);
            assert_eq!(image.get_pixel(0, 0).0, [3, 2, 1]);
            assert_eq!(image.get_pixel(1, 0).0, [6, 5, 4]);
        }
    }
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn center_rect(width: u32, height: u32) -> (u32, u32, u32, u32) {
    let crop_width = ((width as f64) * CENTER_WIDTH_RATIO) as u32;
    let crop_height = ((height as f64) * CENTER_HEIGHT_RATIO) as u32;
    let x = width.saturating_sub(crop_width) / 2;
    let y = height.saturating_sub(crop_height) / 2;
    (x, y, crop_width.max(1), crop_height.max(1))
}

#[cfg(any(target_os = "windows", test))]
fn crop_center(screen: &RgbImage) -> RgbImage {
    let (x, y, width, height) = center_rect(screen.width(), screen.height());
    image::imageops::crop_imm(screen, x, y, width, height).to_image()
}

#[cfg(any(target_os = "windows", test))]
fn encode(image: &RgbImage) -> Vec<u8> {
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("encoding an in-memory PNG cannot fail");
    png
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    fn image(width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, y| Rgb([x as u8, y as u8, 0]))
    }

    #[test]
    fn center_crop_is_centered_and_bounded() {
        let (x, y, width, height) = center_rect(1920, 1080);
        assert_eq!((width, height), (1190, 561));
        assert!((i64::from(x) * 2 + i64::from(width) - 1920).abs() <= 1);
        assert!((i64::from(y) * 2 + i64::from(height) - 1080).abs() <= 1);
    }

    #[test]
    fn crop_returns_expected_size() {
        let cropped = crop_center(&image(1920, 1080));
        assert_eq!((cropped.width(), cropped.height()), (1190, 561));
    }

    #[test]
    fn png_round_trip() {
        let png = encode(&image(64, 32));
        let decoded = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!((decoded.width(), decoded.height()), (64, 32));
    }

    #[test]
    fn non_windows_capture_reports_platform() {
        #[cfg(not(target_os = "windows"))]
        assert!(grab_center_png().unwrap_err().contains("Windows"));
    }
}
