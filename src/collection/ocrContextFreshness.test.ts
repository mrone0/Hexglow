import {describe, expect, it} from 'vitest';
import {newSession, type CollectorSnapshot, type Session} from '../core/domain';
import {canAnalyzeObservedChoice, hasFreshOcrSnapshot, OCR_CONTEXT_MAX_AGE_MS} from './ocrContextFreshness';

const BASE = Date.parse('2026-10-13T00:00:00.000Z');
const iso = (offset: number) => new Date(BASE + offset).toISOString();

function fixture() {
  const session: Session = {...newSession(), id:'session-a', matchId:'123', phase:'InProgress', candidateBand:7,
    ownPlayerId:'', players:[], liveData:{activePlayer:{level:6}}, updatedAt:iso(0)};
  const snapshot: CollectorSnapshot = {platformSupported:true, connection:'lcu-and-live', phase:'InProgress',
    gameId:'123', liveData:{activePlayer:{level:7}}, lcuSession:null, endOfGame:null, result:null,
    observedAt:iso(1200), warnings:[]};
  return {session, snapshot, firstObservedAt:BASE+1000, pollStartedAt:BASE+1100, now:BASE+1300};
}

describe('fresh collector evidence after an independently observed OCR group', () => {
  it('bounds all free scan entry points by snapshot completion age', () => {
    const f=fixture();
    expect(hasFreshOcrSnapshot(null,f.now)).toBe(false);
    expect(hasFreshOcrSnapshot(f.snapshot,BASE+1200)).toBe(true);
    expect(hasFreshOcrSnapshot(f.snapshot,BASE+6200)).toBe(true);
    expect(hasFreshOcrSnapshot(f.snapshot,BASE+6201)).toBe(false);
    expect(hasFreshOcrSnapshot(f.snapshot,BASE+1199)).toBe(false);
    for (const now of [NaN,Infinity,-Infinity,-1]) expect(hasFreshOcrSnapshot(f.snapshot,now)).toBe(false);
    for (const observedAt of ['', ' ', 'invalid']) expect(hasFreshOcrSnapshot({...f.snapshot,observedAt},f.now)).toBe(false);
  });

  it('accepts current same-match round evidence from a request started after the group appeared', () => {
    const f=fixture();
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(true);
    expect(f.session.liveData).toEqual({activePlayer:{level:6}});
  });

  it('does not mistake a late completion of an old collector request for a new round observation', () => {
    const f=fixture();
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,BASE+900)).toBe(false);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.firstObservedAt)).toBe(false);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.firstObservedAt+1)).toBe(true);
  });

  it('rejects stale-round evidence even if its collector request started after OCR', () => {
    const f=fixture();f.snapshot.liveData={activePlayer:{level:6}};
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    f.session.liveData={activePlayer:{level:7}};
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
  });

  it('never sends new seventh-level candidates using the previous first-round snapshot', () => {
    const f=fixture();f.session.candidateBand=1;f.snapshot.liveData={activePlayer:{level:6}};
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,BASE+900)).toBe(false);
    f.snapshot.liveData={activePlayer:{level:7}};
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    f.session.candidateBand=7;
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(true);
  });

  it.each([null,undefined,NaN,Infinity,-Infinity,-1])('rejects invalid/missing first-observation time %s', time => {
    const f=fixture();
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,time,f.now,f.pollStartedAt)).toBe(false);
  });

  it.each([null,undefined,NaN,Infinity,-Infinity,-1])('rejects invalid/missing collector-start time %s', time => {
    const f=fixture();
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,time)).toBe(false);
  });

  it.each([NaN,Infinity,-Infinity,-1])('rejects an invalid current clock %s', now => {
    const f=fixture();
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,now,f.pollStartedAt)).toBe(false);
  });

  it('rejects all future-clock evidence, including a backwards current clock', () => {
    const f=fixture();
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.now+1,f.now,f.pollStartedAt)).toBe(false);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.now+1)).toBe(false);
    f.snapshot.observedAt=iso(1301);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,BASE+999,f.pollStartedAt)).toBe(false);
  });

  it.each(['',' ','not-a-time'])('rejects an invalid or missing collector completion timestamp %j', observedAt => {
    const f=fixture();f.snapshot.observedAt=observedAt;
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
  });

  it('rejects a completion timestamp before that collector request started', () => {
    const f=fixture();f.snapshot.observedAt=iso(1099);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    f.snapshot.observedAt=iso(1100);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(true);
  });

  it('allows the five-second freshness boundary but rejects an older request even when it just completed', () => {
    const f=fixture();
    expect(OCR_CONTEXT_MAX_AGE_MS).toBe(5000);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.pollStartedAt+5000,f.pollStartedAt)).toBe(true);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.pollStartedAt+5001,f.pollStartedAt)).toBe(false);
    f.snapshot.observedAt=iso(6101);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,BASE+6101,f.pollStartedAt)).toBe(false);
  });

  it.each([null,'','456','0123'])('requires an exact current game ID, not merely live-only data (%s)', gameId => {
    const f=fixture();f.snapshot.gameId=gameId;f.snapshot.connection='live-only';
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
  });

  it('rejects missing session identity and ended or archived sessions', () => {
    const f=fixture();
    for (const changes of [{id:''},{matchId:''},{endedAt:iso(1250)},{archived:true}]) {
      expect(canAnalyzeObservedChoice({...f.session,...changes},f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    }
  });

  it.each(['disconnected','',' '])('rejects an unreliable connection %j despite matching IDs', connection => {
    const f=fixture();f.snapshot.connection=connection;
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
  });

  it.each(['Unknown','ChampSelect','GameStart','Reconnect','PreEndOfGame','EndOfGame','Lobby'])(
    'requires both session and snapshot to remain InProgress, not %s', phase => {
      const f=fixture();
      expect(canAnalyzeObservedChoice({...f.session,phase},f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
      expect(canAnalyzeObservedChoice(f.session,{...f.snapshot,phase},f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    });

  it('requires a real snapshot and known current round', () => {
    const f=fixture();
    expect(canAnalyzeObservedChoice(f.session,null,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    f.snapshot.liveData=null;
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    f.snapshot.liveData={activePlayer:{level:7}};f.session.candidateBand=undefined;
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
  });

  it('rejects LCU-only first-round evidence without a real game start event', () => {
    const f=fixture();f.session.candidateBand=1;f.session.liveData=null;
    f.session.timeline=[{at:iso(0),phase:'GameStart',connection:'lcu'},
      {at:iso(500),phase:'InProgress',connection:'lcu'}];
    f.snapshot.connection='lcu';f.snapshot.liveData=null;
    const before=structuredClone(f.session);
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    expect(f.session).toEqual(before);
  });

  it('requires a real start event for an unknown-roster opening, not early game time', () => {
    const f=fixture();f.session.candidateBand=1;f.snapshot.liveData={gameData:{gameTime:12}};
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
    f.session.ocrOpening={gameId:f.session.matchId,loadingObserved:true,advanced:false};
    f.snapshot.liveData={events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}};
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(true);
    f.snapshot.liveData={gameData:{gameTime:500}};
    expect(canAnalyzeObservedChoice(f.session,f.snapshot,f.firstObservedAt,f.now,f.pollStartedAt)).toBe(false);
  });
});
