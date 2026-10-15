import fs from 'node:fs';
import {describe,expect,it} from 'vitest';

// Source wiring regression only, not a real-client latency benchmark. The fixed
// transport deadlines and correlation behavior also have native unit coverage.
const source=fs.readFileSync(new URL('../src-tauri/src/collector.rs',import.meta.url),'utf8');
const start=source.indexOf('pub async fn collector_snapshot(');
const snapshot=source.slice(start,source.indexOf('\n#[',start+1));

describe('startup collection wiring',()=>{
  it('supplements an unavailable full snapshot with a bounded real event read, never an invented level',()=>{
    expect(snapshot).toContain('needs_start_event(phase, lcu_connected, &session, &live)');
    expect(snapshot).toContain('"/liveclientdata/eventdata"');
    expect(snapshot).toContain('LIVE_START_BUDGET');
    expect(snapshot).toContain('merge_start_event(&mut live, &events)');
    expect(snapshot.indexOf('"game-start-signal"')).toBeGreaterThan(snapshot.indexOf('correlate_payloads('));
    expect(snapshot).not.toMatch(/"level"\s*:\s*3/);
  });
  it('starts both fixed LCU reads before waiting for Live API and joins both results',()=>{
    const spawn=snapshot.indexOf('let lifecycle_reads');
    const live=snapshot.indexOf('match get_json(&client, None, "/liveclientdata/allgamedata", live_deadline).await');
    const launch=snapshot.slice(spawn,snapshot.indexOf('let live_deadline'));
    expect(spawn).toBeGreaterThan(0);expect(live).toBeGreaterThan(spawn);
    expect(launch.match(/tauri::async_runtime::spawn\(async move/g)).toHaveLength(2);
    expect(launch).toContain('"/lol-gameflow/v1/gameflow-phase"');
    expect(launch).toContain('"/lol-gameflow/v1/session"');
    expect(launch.match(/deadline/g)).toHaveLength(2);
    expect(snapshot).toContain('phase_read.await.unwrap_or(Err(ApiError::Unavailable))');
    expect(snapshot).toContain('session_read.await.unwrap_or(Err(ApiError::Unavailable))');
  });

  it('still correlates same-game evidence after reads and keeps discovery failure invalidation',()=>{
    expect(snapshot.indexOf('correlate_payloads(')).toBeGreaterThan(snapshot.indexOf('session_read.await'));
    expect(snapshot.indexOf('degrade_unknown_phase(')).toBeGreaterThan(snapshot.indexOf('session_read.await'));
    expect(snapshot).toContain('*cached = None;');
    expect(snapshot).not.toMatch(/println!|dbg!|eprintln!/);
  });

  it('reuses the local transport and bounds optional Live wait before publishing lifecycle',()=>{
    expect(source).toContain('const LIVE_SNAPSHOT_BUDGET: Duration = Duration::from_millis(500);');
    expect(snapshot).toContain('deadline.min(Instant::now() + LIVE_SNAPSHOT_BUDGET)');
    const transport=source.slice(source.indexOf('fn riot_client()'),source.indexOf('// Only a fixed error class'));
    expect(transport).toContain('OnceLock<Result<Client, String>>');
    expect(transport).toContain('get_or_init');
    expect(transport).toContain('.no_proxy()');
    expect(transport).toContain('.redirect(Policy::none())');
  });
});
