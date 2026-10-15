import fs from 'node:fs';
import {describe, expect, it} from 'vitest';

// Source/configuration regression checks ONLY, not native integration tests.
// These checks never launch Hexglow, capture the screen, load ONNX models,
// contact a service, inspect user settings, or write installation resources.
// Rust tests and the separately invoked offline corpus exercise actual inference.
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const native = read('../src-tauri/src/ocr.rs');
const main = read('../src-tauri/src/main.rs');
const manifest = JSON.parse(read('../src-tauri/resources/ocr/manifest.json'));
const bundle = JSON.parse(read('../src-tauri/tauri.conf.json')).bundle;

// Top-level Rust functions in this module terminate at an unindented brace.
// Deliberately do not assert loop shape, fast-engine ownership, or error types:
// an optional/degraded fast engine must remain a valid implementation.
function rustFunction(name) {
  const pattern = new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\b[^]*?^\\}`, 'm');
  const found = native.match(pattern)?.[0];
  if (!found) throw new Error(`Native OCR function not found: ${name}`);
  const result=found.replace(/^\s*\/\/[^\n]*/gm, '');
  // Screen acquisition and injectable post-capture processing are one path.
  return name==='perform_scan_watched'?result+'\n'+rustFunction('process_scan_image'):result;
}

describe('OCR runtime source contracts (not native integration)', () => {
  it('shares the injectable post-capture path and bounds localized recognition (not an acceptance proof)',()=>{
    const scan=rustFunction('perform_scan_watched');
    expect(scan).toMatch(/process_scan_image\s*\(\s*image\s*,\s*source\s*,\s*round_key\s*,\s*watch_candidate_ids\s*,\s*started\s*,\s*&masked\s*,?\s*\)/);
    expect(scan).toContain('choice_region::locate_masked(&image, masked)');
    expect(scan).toContain('"ocrRegion"');
    expect(rustFunction('recognize_capture_scoped')).toContain('recognize_choice_region(');
    const policy=rustFunction('recognize_choice_region');
    expect(policy).toContain('region.full_cards()');expect(policy).toContain('predict_region(');
    expect(policy).not.toContain('recognize_with_policy(');
    expect(rustFunction('predict_region')).toContain('region.input(image)');
  });
  it('requests CPU explicitly and monitors only exact known IDs without OCR or retained candidates',()=>{
    expect(rustFunction('ocr_session_config')).toContain('.with_execution_providers(vec![OrtExecutionProvider::CPU])');
    const scan=rustFunction('perform_scan_watched');
    expect(scan.indexOf('watch.defer(')).toBeLessThan(scan.indexOf('recognize_capture_scoped('));
    expect(scan).toContain('"unchangedPanel":true');
    expect(scan).toContain('"watchCandidateIds":expected');
    expect(scan).toContain('"candidates":[]');
    const overlay=read('../src-tauri/src/overlay.rs');
    const opening=overlay.slice(overlay.indexOf('fn open_overlay('),overlay.indexOf('pub fn overlay_publish'));
    expect(opening.indexOf('!needs_open_layout(')).toBeLessThan(opening.indexOf('start_watcher(app)'));
    expect(opening.indexOf('!needs_open_layout(')).toBeLessThan(opening.indexOf('resize(&window, WIDTH)'));
    const resize=overlay.slice(overlay.indexOf('fn resize('),overlay.indexOf('fn notify('));
    expect(resize.indexOf('inner_size()')).toBeLessThan(resize.indexOf('.set_size('));
    const anchor=overlay.slice(overlay.indexOf('fn anchor('),overlay.indexOf('fn game_monitor('));
    expect(anchor.indexOf('outer_position()')).toBeLessThan(anchor.indexOf('.set_position('));
  });
  it('checks readiness before an automatic capture can wait on inference or read the screen',()=>{
    const scan=rustFunction('perform_scan_watched');
    expect(scan.indexOf('INFERENCE_READY.load(Ordering::Acquire)')).toBeLessThan(scan.indexOf('capture::try_grab_center_image()'));
    expect(scan).toContain('image_path.is_none() && band.is_some()');
    expect(scan).toContain('"ocr-warming-up"');expect(scan).toContain('"ocr-initialization-failed"');
    expect(scan).toContain('"waitingForReady":!failed');
  });
  it('pixel-only results return before inference and keep their counters separate',()=>{
    const scan=rustFunction('perform_scan_watched');
    expect(scan).toContain('panel_probe::inspect(&image)');
    expect(scan.indexOf('if !full')).toBeLessThan(scan.indexOf('recognize_capture_scoped('));
    expect(scan).toContain('"probeOnly":true');
    expect(scan).toContain('"recognitionMs":0');
    const log=rustFunction('scan_and_log');
    expect(log.indexOf('if result["probeOnly"] == true')).toBeLessThan(log.indexOf('record_ocr_scan('));
    expect(log).toContain('"panel-probe"');
    expect(log).toContain('record_panel_probe(');
  });
  it('only automatic scopes defer empty Small fallback, and real title hints keep immediate fallback',()=>{
    const scan=rustFunction('perform_scan_watched');
    expect(scan).toContain('let empty_fallback_due = match (scope, hint)');
    expect(scan).toContain('_ => true');
    expect(scan).toContain('budget.completed(key, Instant::now())');
    const policy=rustFunction('recognize_with_fallback_policy');
    expect(policy).toContain('!empty_fallback_due && !crate::scoring::has_augment_title_hint(&lines)');
    expect(policy).toContain('lines: Vec::new()');
    expect(policy).toContain('"empty-fallback-deferred"');
    expect(policy).toContain('fast_panel_is_reliable(&lines)');
    expect(rustFunction('cached_frame_result')).toContain('frame.result.fallback_reason == "empty-fallback-deferred"');
    expect(rustFunction('recognize_with_pipeline')).toContain('recognize_with_policy(pipeline, image, true)');
  });
  it('automatic capture checks only the foreground game, never enumerates unrelated windows', () => {
    const capture=read('../src-tauri/src/capture.rs');
    const automatic=capture.match(/pub fn try_grab_center\([^]*?\n    \}/)?.[0];
    expect(automatic).toContain('GetForegroundWindow()');
    expect(automatic).toContain('belongs_to_game(foreground)');
    expect(automatic).not.toMatch(/find_game_window\(|EnumWindows\(/);
    expect(automatic).toContain('current_skip(Some(window))');
  });
  it('wide capture masks only the registered own sidebar without moving windows or saving frames',()=>{
    const capture=read('../src-tauri/src/capture.rs');
    expect(capture).toContain('const CENTER_WIDTH_RATIO: f64 = 0.90');
    expect(capture).toContain('pid != std::process::id()');
    expect(capture).toContain('GetWindowRect(window, &mut rect)');
    const automatic=capture.match(/pub fn try_grab_center\([^]*?\n    \}/)?.[0];
    expect(automatic).toContain('before_overlay.into_iter().chain(own_overlay_rect())');
    expect(automatic).toContain('super::mask_region(&mut image, region, overlay)');
    expect(automatic).not.toMatch(/\.save\(|ShowWindow|SetWindowPos|EnumWindows/);
    expect(read('../src-tauri/src/overlay.rs')).toContain('capture::register_overlay_handle(');
  });
  it('retries local inference readiness during loading without queueing behind an active scanner', () => {
    const warmup=rustFunction('ocr_warmup');
    expect(warmup).toContain('PIPELINE.try_lock()');
    expect(warmup).toContain('TryLockError::WouldBlock');
    expect(warmup).toContain('"status":"busy"');
    expect(warmup).toContain('INFERENCE_READY.load(Ordering::Acquire)');
    expect(warmup).toContain('prime_pipeline(');
    expect(warmup).toContain('warmup_catalog()');
    expect(warmup).not.toMatch(/capture::|recognize_capture\(|overlay_open|analyze_structured/);
  });

  it('prepares a hidden non-focused sidebar without showing it or polling the cursor', () => {
    const overlay=read('../src-tauri/src/overlay.rs');
    const prepare=overlay.match(/pub fn overlay_prepare\([^]*?^\}/m)?.[0];
    const create=overlay.match(/fn ensure_overlay_window\([^]*?^\}/m)?.[0];
    expect(prepare).toContain('OPENING.try_lock()');
    expect(prepare).not.toMatch(/\.show\(|\.hide\(|set_focus\(|start_watcher\(|CONTENT/);
    expect(create).toContain('.visible(false)');
    expect(create).toContain('.focused(false)');
    expect(main).toContain('overlay::overlay_prepare,');
  });
  it('bounds each native inference session and disables both idle spinning pools', () => {
    expect(rustFunction('build_pipeline')).toMatch(/\.ort_session\(ocr_session_config\(available_ocr_threads\(\)\)\)/);
    const config = rustFunction('ocr_session_config');
    expect(config).toMatch(/\.with_intra_threads\(threads\.clamp\(1, MAX_OCR_THREADS\)\)/);
    expect(config).toContain('.with_inter_threads(1)');
    expect(config).toContain('.with_parallel_execution(false)');
    expect(config).toContain('.add_config_entry("session.intra_op.allow_spinning", "0")');
    expect(config).toContain('.add_config_entry("session.inter_op.allow_spinning", "0")');
    expect(native).toMatch(/const MAX_OCR_THREADS: usize = 1;/);
  });

  it('keeps OCR preprocessing in one private bounded Rayon pool, including warmup', () => {
    const pool = rustFunction('ocr_cpu_pool');
    expect(pool).toMatch(/OCR_CPU_POOL\s*\.get_or_init/);
    expect(pool).toContain('.num_threads(available_ocr_threads())');
    expect(pool).toContain('game_worker::prepare_private_thread()');
    expect(pool).not.toMatch(/build_global|set_var|RAYON_NUM_THREADS/);
    expect(rustFunction('predict_lines')).toMatch(/ocr_cpu_pool\(\)\?[^]*\.install\(\|\| ocr\.predict\(vec!\[image\]\)\)/);
    expect(rustFunction('prime_pipeline')).toContain('predict_lines(');
  });

  it('registers the async scan command and moves the synchronous scan onto a blocking worker', () => {
    const command = rustFunction('ocr_scan');
    expect(command).toMatch(/^pub\s+async\s+fn\s+ocr_scan\b/);
    expect(command).toMatch(/tauri::async_runtime::spawn_blocking\s*\(/);
    expect(command).toContain('scan_and_log');
    expect(command).toMatch(/\.await\b/);
    expect(main).toMatch(/generate_handler!\[[^]*ocr::ocr_scan\s*,/);
  });

  it('starts inference preparation during setup rather than waiting for the first scan', () => {
    const startup = rustFunction('start_warmup');
    expect(main).toMatch(/\.setup\([^]*ocr::start_warmup\(app\.handle\(\)\)/);
    expect(startup).toMatch(/tauri::async_runtime::spawn_blocking\s*\(/);
    expect(startup).toMatch(/spawn_blocking\([^]*with_pipeline\([^]*\bprime_pipeline\b/);
    expect(startup).not.toMatch(/with_pipeline\(\s*\|_\|\s*Ok\(\(\)\)\s*\)/);
  });

  it('warms the recognizers with bundled text and real prediction, not only model loading or a blank image', () => {
    const prime = rustFunction('prime_pipeline');
    expect(prime).toMatch(/include_bytes!\([^]*augment-card\.png/);
    expect(prime).toContain('load_from_memory');
    expect(prime).toContain('predict_lines(');
    expect(prime).toMatch(/\.fast\b/);
    expect(prime).toMatch(/\.fallback\b/);
    expect(rustFunction('predict_lines')).toMatch(/\.predict\s*\(/);
    const fixture = fs.readFileSync(new URL('../src-tauri/tests/fixtures/augment-card.png', import.meta.url));
    expect([...fixture.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(fixture.length).toBeGreaterThan(1024);
  });

  it('keeps the warmup inference path independent of capture, cached frames, scoring, publication and paid requests', () => {
    const warmup = ['prime_pipeline', 'predict_lines', 'rect_of', 'normalize']
      .map(rustFunction).join('\n');
    for (const forbidden of [
      /\bcapture::/, /\bFRAME\b/, /\brecognize_capture\s*\(/,
      /\bperform_scan\s*\(/, /\bscan_and_log\s*\(/,
      /\bscoring::/, /\bmatch_augments\s*\(/, /\brecord_ocr_scan\s*\(/,
      /\boverlay_(?:open|publish|ready)\b/, /\bemit\s*\(/,
      /\brecommend\s*\(/, /\bjev\b/, /\breqwest::/, /https?:\/\//,
    ]) expect(warmup).not.toMatch(forbidden);
  });

  it('bundles the whole OCR resource directory and retains both recognizer families plus license notices', () => {
    expect(bundle.resources['resources/ocr/']).toBe('resources/ocr/');
    expect(manifest.license).toBe('Apache-2.0');
    expect(manifest.files.map(file => file.name)).toEqual(expect.arrayContaining([
      'pp-ocrv6_small_det.onnx', 'pp-ocrv6_small_rec.onnx', 'ppocrv6_dict.txt',
      'pp-ocrv6_tiny_rec.onnx', 'ppocrv6_tiny_dict.txt',
    ]));
    const notice = read('../src-tauri/resources/ocr/NOTICE.txt');
    expect(notice).toContain('Tiny recognition');
    expect(notice).toContain('LICENSE-APACHE-2.0.txt');
    expect(read('../src-tauri/resources/ocr/LICENSE-APACHE-2.0.txt')).toContain('Apache License');
  });

  it('pins valid, safe manifest names and hashes with sizes matching the native resource table', () => {
    const names = new Map([...native.matchAll(/const\s+(\w+):\s*&str\s*=\s*"([^"]+)"/g)]
      .map(([, key, value]) => [key, value]));
    const modelTable = native.match(/const\s+MODEL_FILES\b[^]*?=\s*\[([^]*?)\];/)?.[1];
    expect(modelTable).toBeDefined();
    const nativeSizes = new Map([...modelTable.matchAll(/\(\s*(\w+)\s*,\s*([\d_]+)\s*\)/g)]
      .map(([, key, size]) => [names.get(key), Number(size.replaceAll('_', ''))]));
    expect(new Set(manifest.files.map(file => file.name)).size).toBe(manifest.files.length);
    for (const file of manifest.files) {
      expect(file.name).toMatch(/^[a-z0-9_.-]+$/);
      expect(['.', '..']).not.toContain(file.name);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.size).toBeGreaterThan(0);
      expect(Number.isSafeInteger(file.size)).toBe(true);
      expect(nativeSizes.get(file.name)).toBe(file.size);
      expect(file.urls.length).toBeGreaterThan(0);
      for (const url of file.urls) expect(new URL(url).protocol).toBe('https:');
    }
  });

  it('makes preparation and installed-resource verification iterate the manifest rather than three old filenames', () => {
    for (const script of ['../scripts/prepare-ocr-models.ps1', '../scripts/verify-installed.ps1']) {
      const source = read(script);
      expect(source).toContain('manifest.json');
      expect(source).toMatch(/foreach\s*\(\$entry\s+in\s+\$manifest\.files\)/);
      expect(source).toMatch(/\$entry\.size/i);
      expect(source).toMatch(/\$entry\.sha256/i);
      expect(source).toContain('SHA256');
      expect(source).toContain('ComputeHash');
    }
    expect(read('../scripts/verify-release.ps1'))
      .toMatch(/prepare-ocr-models\.ps1'\)\s+-VerifyOnly/);
  });
});
