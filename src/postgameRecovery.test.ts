import {describe, expect, it} from 'vitest';
import {applySnapshot, newSession, type Session} from './domain';
import {readSession} from './sessionReader';
import {canRecoverPostgame, hasMissingPostgameEvidence, mergePostgameEvidence, PostgameRetryQueue} from './postgameRecovery';

const start = Date.parse('2026-10-07T07:26:10Z');
function ended(): Session {
  return {...newSession(), matchId: '100', endedAt: new Date(start).toISOString(), archived: true, phase: 'EndOfGame', ownPlayerId: 'me#1',
    players: [{id: 'me#1', name: 'me#1', champion: 'Ahri', team: 'ORDER', items: [], augments: [], augmentsConfirmed: false}],
    notes: 'preserve', samples: [{at: 'sample', data: {test: true}}]};
}
const reply = () => ({gameId: '100', observedAt: new Date(start + 10000).toISOString(),
  players: [{key: 'me#1', champion: 'Ahri', team: 'ORDER', augments: ['test augment']}],
  endOfGame: {gameId: 100, participants: []},
  result: {gameId: '100', source: 'lcu-history', status: 'win', observedAt: new Date(start + 10000).toISOString()}});

describe('late postgame evidence', () => {
  it('recovers outcome, raw evidence and augments without changing archive/lifecycle or other edits', () => {
    const original = ended();
    const next = mergePostgameEvidence(original, reply());
    expect(next).toMatchObject({id: original.id, matchId: '100', archived: true, phase: 'EndOfGame', notes: 'preserve', endedAt: original.endedAt,
      result: {status: 'win', source: 'lcu-history', gameId: '100'}, endOfGame: {gameId: 100}, samples: original.samples});
    expect(next.players[0]).toMatchObject({augments: ['test augment'], augmentsConfirmed: true});
    expect(hasMissingPostgameEvidence(next)).toBe(false);
    expect(canRecoverPostgame(next)).toBe(true); // Attributed entries do not prove all choices arrived.
    expect(readSession(next).result?.source).toBe('lcu-history');
    expect(original.players[0].augments).toEqual([]);
    expect(mergePostgameEvidence(next, reply())).toBe(next);
  });

  it('rejects wrong or missing match identity even when the player/hero is identical', () => {
    const session = ended();
    for (const payload of [{...reply(), gameId: '101'}, {...reply(), gameId: undefined}, null, reply().players]) {
      expect(mergePostgameEvidence(session, payload)).toBe(session);
    }
    expect(mergePostgameEvidence({...session, endedAt: undefined, archived: false}, reply()).result?.status).toBe('unknown');
  });

  it('does not accept a mismatched result or mismatched stored raw payload', () => {
    const session = ended();
    const next = mergePostgameEvidence(session, {...reply(), players: [], endOfGame: {gameId: 101}, result: {...reply().result, gameId: '101'}});
    expect(next).toBe(session);
  });

  it('accepts explicit nested gameData identity but not an unrelated generic object id', () => {
    const session = ended();
    const raw = {gameData: {gameId: 100}, teams: []};
    const next = mergePostgameEvidence(session, {gameId: '100', endOfGame: raw});
    expect(next.endOfGame).toBe(raw);
    expect(mergePostgameEvidence(session, {gameId: '100', endOfGame: {id: 100}})).toBe(session);
    expect(mergePostgameEvidence(session, {gameId: '100', endOfGame: {gameId: 101, gameData: {gameId: 100}}})).toBe(session);
    expect(mergePostgameEvidence(session, {gameId: '100', endOfGame: {gameId: 100, gameData: {gameId: 101}}})).toBe(session);
  });

  it('preserves automatic outcome and manual selections through incomplete/conflicting retries', () => {
    const session = ended();
    session.result = {gameId: '100', source: 'lcu-eog', status: 'loss', observedAt: 'automatic'};
    session.players[0].augments = ['manual choice'];
    const next = mergePostgameEvidence(session, reply());
    expect(next.result).toBe(session.result);
    expect(next.players[0].augments).toEqual(['manual choice', 'test augment']);
    expect(mergePostgameEvidence(next, {gameId: '100', result: {status: 'unknown'}})).toBe(next);
  });

  it('never replaces stored raw evidence with a later partial response', () => {
    const raw = {gameId: 100, teams: [{test: 'retained evidence'}]};
    const session = {...ended(), endOfGame: raw};
    const next = mergePostgameEvidence(session, reply());
    expect(next.endOfGame).toBe(raw);
    expect(next.result?.status).toBe('win');
    expect(next.players[0].augments).toEqual(['test augment']);
  });

  it('upgrades a manual guess to identity-matched official evidence, preserving free-text notes', () => {
    const session = ended();
    session.result = {gameId: '100', source: 'manual', status: 'loss', observedAt: 'manual'};
    session.outcome = 'manual observation';
    const next = mergePostgameEvidence(session, reply());
    expect(next.result).toMatchObject({status: 'win', source: 'lcu-history'});
    expect(next.outcome).toBe('manual observation');
  });

  it('recovers a result without claiming unavailable augment evidence is complete', () => {
    const next = mergePostgameEvidence(ended(), {...reply(), players: []});
    expect(next.result?.status).toBe('win');
    expect(next.players[0].augmentsConfirmed).toBe(false);
    expect(hasMissingPostgameEvidence(next)).toBe(true);
  });

  it('ignores malformed entries instead of marking them confirmed', () => {
    const session = ended();
    expect(mergePostgameEvidence(session, {gameId: '100', players: [null, {}, {key: 'me#1', augments: [123]}]})).toBe(session);
  });

  it('keeps separate path evidence attributable to masked players without mixing their choices', () => {
    const session = {...ended(), players: [
      {...ended().players[0], id: 'masked:ORDER:0', name: '#'},
      {...ended().players[0], id: 'masked:CHAOS:1', name: '#', champion: 'Jinx', team: 'CHAOS'},
    ]};
    // The scanner emits separate record paths when two source players share a short name.
    const players = [
      {key: 'path:/teams[0]/players[0]', champion: 'Ahri', team: 'ORDER', augments: ['own-only']},
      {key: 'path:/teams[1]/players[0]', champion: 'Jinx', team: 'CHAOS', augments: ['enemy-only']},
    ];
    for (const entries of [players, [...players].reverse()]) {
      const next = mergePostgameEvidence(session, {gameId: '100', players: entries});
      expect(next.players.map(player => player.augments)).toEqual([['own-only'], ['enemy-only']]);
      expect(next.players.every(player => player.augmentsConfirmed)).toBe(true);
    }
    const twins = {...session, players: session.players.map(player => ({...player, team: 'ORDER', champion: 'Ahri'}))};
    expect(mergePostgameEvidence(twins, {gameId: '100', players: players.map(player => ({...player, team: 'ORDER', champion: 'Ahri'}))})).toBe(twins);
    expect(session.players.every(player => !player.augments.length)).toBe(true);
  });
});

describe('bounded postgame retry scheduling', () => {
  it('keeps the ended target after a new match starts and carries newer edits', () => {
    const queue = new PostgameRetryQueue();
    const session = ended();
    queue.observe(session, start);
    expect(queue.take(start + 2999)).toBeNull();
    queue.observe({...session, notes: 'later note'}, start + 3000);
    queue.observe({...newSession(), matchId: '101'}, start + 3000);
    expect(queue.take(start + 3000)).toMatchObject({id: session.id, matchId: '100', notes: 'later note'});
    expect(queue.take(start + 3001)).toBeNull();
    expect(queue.take(start + 9000)?.id).toBe(session.id);
  });

  it('recovers an archived game even if the end phase was missed', () => {
    const old = {...ended(), endedAt: undefined, archived: false, phase: 'InProgress'};
    const transition = applySnapshot(old, {platformSupported: true, phase: 'InProgress', connection: 'lcu', gameId: '101',
      observedAt: new Date(start).toISOString(), liveData: null, lcuSession: null, endOfGame: null, result: null, warnings: []});
    const archive = transition.completed!;
    expect(archive.endedAt).toBeUndefined();
    const queue = new PostgameRetryQueue();
    queue.observe(archive, start);
    const target = queue.take(start + 3000)!;
    expect(target.matchId).toBe('100');
    expect(mergePostgameEvidence(target, reply()).result?.status).toBe('win');
    expect(transition.session.matchId).toBe('101');
  });

  it('does not let repeated polls reset the retry budget', () => {
    const queue = new PostgameRetryQueue();
    const session = ended();
    queue.observe(session, start);
    let count = 0;
    for (let elapsed = 3000; elapsed < 600000; elapsed += 3000) {
      queue.observe(session, start + elapsed);
      if (queue.take(start + elapsed)) count++;
    }
    expect(count).toBe(8);
  });

  it('expires old sessions and excludes live/unidentified games', () => {
    const queue = new PostgameRetryQueue();
    queue.observe({...ended(), matchId: ''}, start);
    queue.observe({...ended(), endedAt: undefined, archived: false}, start);
    queue.observe(ended(), start + 600000);
    expect(queue.take(start + 600001)).toBeNull();
  });

  it('continues after confirmed partial evidence and cannot resurrect an explicitly deleted target', () => {
    const queue = new PostgameRetryQueue();
    const session = ended();
    queue.observe(session, start);
    const partial = mergePostgameEvidence(session, reply());
    queue.observe(partial, start + 1000);
    expect(queue.take(start + 3000)).toBe(partial);
    queue.observe(session, start + 4000);
    queue.forget(session.id);
    queue.observe(session, start + 5000);
    expect(queue.take(start + 9000)).toBeNull();
  });

  it('keeps collecting complementary fragments without inventing a fixed slot count or resetting the budget', () => {
    const queue = new PostgameRetryQueue();
    let session = mergePostgameEvidence(ended(), reply());
    queue.observe(session, start);
    let attempts = 0;
    for (let elapsed = 3000; elapsed < 600000; elapsed += 3000) {
      queue.observe(session, start + elapsed);
      if (!queue.take(start + elapsed)) continue;
      attempts++;
      session = mergePostgameEvidence(session, {...reply(), players: [{...reply().players[0], augments: [`fragment ${attempts}`]}]});
    }
    expect(attempts).toBe(8);
    expect(session.players[0].augments).toHaveLength(9);
    expect(session.players[0].augmentsConfirmed).toBe(true);
    expect(hasMissingPostgameEvidence(session)).toBe(false);
    queue.observe(session, start + 599000);
    expect(queue.take(start + 599999)).toBeNull();
  });

  it('does not extend the original deadline when an archived-only record is enriched', () => {
    const queue = new PostgameRetryQueue();
    const session = {...ended(), endedAt: undefined, updatedAt: new Date(start).toISOString()};
    queue.observe(session, start);
    queue.observe({...mergePostgameEvidence(session, reply()), updatedAt: new Date(start + 590000).toISOString()}, start + 590000);
    expect(queue.take(start + 600000)).toBeNull();
    queue.observe({...session, updatedAt: new Date(start + 600000).toISOString()}, start + 600000);
    expect(queue.take(start + 603000)).toBeNull();
  });
});
