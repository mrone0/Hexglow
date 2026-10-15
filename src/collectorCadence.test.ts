import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CollectorSnapshot} from './domain';
import {collectorPollDelay} from './collectorCadence';

function snapshot(changes: Partial<CollectorSnapshot> = {}): CollectorSnapshot {
  return {platformSupported:true, connection:'lcu', phase:'Unknown', gameId:null, liveData:null,
    lcuSession:null, endOfGame:null, result:null, observedAt:'2026-10-12T12:00:00.000Z', warnings:[], ...changes};
}

afterEach(() => {vi.unstubAllGlobals();});

describe('collector polling cadence', () => {
  it.each(['ReadyCheck','ChampSelect','GameStart','Reconnect','InProgress'])(
    'polls a reliably connected %s phase every second before game data is available', phase => {
      for (const connection of ['lcu','lcu-and-live','live-only','connected']) {
        expect(collectorPollDelay(snapshot({phase,connection}),0)).toBe(1000);
        expect(collectorPollDelay(snapshot({phase,connection}),100)).toBe(1000);
      }
    });

  it.each(['Lobby','None','Matchmaking','PreEndOfGame','EndOfGame','WaitingForStats'])(
    'polls a reliably connected %s phase every three seconds', phase => {
      expect(collectorPollDelay(snapshot({phase}),0)).toBe(3000);
      expect(collectorPollDelay(snapshot({phase}),100)).toBe(3000);
    });

  it.each(['ReadyCheck','ChampSelect','GameStart','Reconnect','InProgress','Lobby','None','Matchmaking','PreEndOfGame','EndOfGame','WaitingForStats','Unknown'])(
    'does not trust a retained %s phase when explicitly disconnected', phase => {
      const state=snapshot({phase,connection:'disconnected',gameId:'123',liveData:{activePlayer:{level:3}}});
      expect(collectorPollDelay(state,1)).toBe(8000);
      expect(collectorPollDelay(state,6)).toBe(15000);
    });

  it.each([0,1,5])('keeps eight-second backoff for %i idle failures without reliable phase/data', failures => {
    expect(collectorPollDelay(snapshot(),failures)).toBe(8000);
    expect(collectorPollDelay(snapshot({connection:'disconnected'}),failures)).toBe(8000);
  });

  it.each([6,7,100])('uses fifteen-second backoff after %i idle failures', failures => {
    expect(collectorPollDelay(snapshot(),failures)).toBe(15000);
    expect(collectorPollDelay(snapshot({connection:'disconnected'}),failures)).toBe(15000);
  });

  it('continues three-second polling for unknown phases with a reliable game identity', () => {
    expect(collectorPollDelay(snapshot({gameId:'123'}),100)).toBe(3000);
    expect(collectorPollDelay(snapshot({phase:'FuturePhase',gameId:'123'}),100)).toBe(3000);
  });

  it('continues polling with usable live data even if roster or game identity is unavailable', () => {
    for (const liveData of [{activePlayer:{level:3}},{gameData:{gameTime:0}},{allPlayers:[{championName:'synthetic'}]}]) {
      expect(collectorPollDelay(snapshot({connection:'live-only',liveData}),100)).toBe(3000);
    }
  });

  it.each([null,{},[],false,0,'stale-data'])('does not use malformed/empty live data %j to bypass backoff', liveData => {
    expect(collectorPollDelay(snapshot({liveData,gameId:' '}),6)).toBe(15000);
  });

  it('does not treat absent connection state as a reliable loading phase', () => {
    for (const connection of ['', ' ']) {
      expect(collectorPollDelay(snapshot({phase:'InProgress',connection,gameId:'123'}),6)).toBe(15000);
    }
  });

  it('does not let assistant document visibility slow down loading or active-game polling', () => {
    for (const hidden of [false,true]) {
      vi.stubGlobal('document',{hidden});
      for (const phase of ['ReadyCheck','ChampSelect','GameStart','Reconnect','InProgress']) {
        expect(collectorPollDelay(snapshot({phase}),100)).toBe(1000);
      }
    }
  });

  it('works without a document and does not read browser visibility', () => {
    vi.stubGlobal('document',undefined);
    expect(collectorPollDelay(snapshot({phase:'ChampSelect'}),0)).toBe(1000);
    vi.stubGlobal('document',{get hidden(){throw new Error('visibility must not affect cadence');}});
    expect(collectorPollDelay(snapshot({phase:'InProgress'}),0)).toBe(1000);
  });
});
