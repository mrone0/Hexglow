import {describe, expect, it} from 'vitest';
import {AUTO_MAX_PER_ROUND, AUTO_OBSERVATION_MAX_GAP_MS, AUTO_STABLE_MS, AutoRecommendationGate, autoRecommendationKey} from './autoRecommendation';
import {newSession, type Session} from './domain';
import {confirmLocalChoice} from './localChoice';

function playing(): Session {
  return {...newSession(), id: 'session-a', matchId: '123', phase: 'InProgress', ownPlayerId: 'self', candidateBand: 7,
    liveData: {activePlayer: {level: 8}},
    players: [{id: 'self', name: '', champion: 'hero', team: 'ORDER', items: [], augments: [], augmentsConfirmed: false},
      {id: 'other', name: '', champion: 'other-hero', team: 'CHAOS', items: [], augments: [], augmentsConfirmed: false}],
    candidates: ['a', 'b', 'c'].map(id => ({id, name: `候选${id}`, description: `效果${id}`, source: 'ocr'}))};
}

function reroll(session: Session, index: number): Session {
  return {...session, candidates: session.candidates.map(candidate => ({...candidate, id: `${candidate.id}-${index}`}))};
}

function saved(context: unknown): Session['decisions'][number] {
  return {at: '2026-10-08T14:00:00Z', context, result: {ranking: [], summary: '模型结果', missingInformation: []}};
}

function ready(gate: AutoRecommendationGate, session: Session, time = 0): void {
  expect(gate.observe(session, time)).toBe(false);
  expect(gate.observe(session, time + AUTO_STABLE_MS)).toBe(true);
}

describe('automatic recommendation identity', () => {
  it('uses an order-independent complete three-card identity', () => {
    const session = playing();
    expect(autoRecommendationKey(session)).not.toBeNull();
    expect(autoRecommendationKey({...session, candidates: [...session.candidates].reverse()})).toBe(autoRecommendationKey(session));
  });

  it.each(['id', 'name', 'description'] as const)('changes when candidate %s changes', field => {
    const session = playing(), next = structuredClone(session);
    next.candidates[0][field] += '-changed';
    expect(autoRecommendationKey(next)).not.toBe(autoRecommendationKey(session));
  });

  it('ignores equipment, other players, knowledge, notes, samples and elapsed time', () => {
    const session = playing(), next = structuredClone(session);
    next.players[0].items = [{itemID: 42}];
    next.players[0].augments = ['old-choice'];
    next.players[0].name = 'changed';
    next.players[1].champion = 'changed';
    next.players.reverse();
    next.liveData = {activePlayer: {level: 10}, gameData: {gameTime: 500}};
    next.notes = 'changed';next.sampleCount = 30;next.updatedAt = 'later';
    Object.assign(next, {knowledge: {revision: 2}});
    expect(autoRecommendationKey(next)).toBe(autoRecommendationKey(session));
  });

  it.each(['id', 'matchId'] as const)('isolates each %s', field => {
    const session = playing();
    expect(autoRecommendationKey({...session, [field]: 'other'})).not.toBe(autoRecommendationKey(session));
  });

  it('isolates the owner and champion', () => {
    const session = playing(), next = structuredClone(session);
    next.players[0].champion = 'changed';
    expect(autoRecommendationKey(next)).not.toBe(autoRecommendationKey(session));
    next.ownPlayerId = 'other';
    expect(autoRecommendationKey(next)).not.toBe(autoRecommendationKey(session));
  });

  it.each([
    {phase: 'EndOfGame'}, {archived: true}, {endedAt: 'now'}, {id: ''}, {matchId: ''}, {ownPlayerId: ''},
    {candidateBand: undefined}, {candidateBand: 11}, {liveData: null}, {liveData: {activePlayer: {level: 11}}},
    {liveData: {activePlayer: {level: 0}}},
  ])('rejects a non-current or unidentified round: %j', changes => {
    expect(autoRecommendationKey({...playing(), ...changes})).toBeNull();
  });

  it('requires one complete owner hero, without requiring a player display name', () => {
    const session = playing();
    expect(autoRecommendationKey(session)).not.toBeNull();
    expect(autoRecommendationKey({...session, players: session.players.slice(1)})).toBeNull();
    expect(autoRecommendationKey({...session, players: [session.players[0], ...session.players]})).toBeNull();
    session.players[0].champion = ' ';
    expect(autoRecommendationKey(session)).toBeNull();
  });

  it('requires exactly three distinct complete OCR candidates', () => {
    for (const mutate of [
      (s: Session) => {s.candidates.pop();},
      (s: Session) => {s.candidates.push({...s.candidates[0], id: 'd'});},
      (s: Session) => {s.candidates[1].id = s.candidates[0].id;},
      (s: Session) => {s.candidates[0].source = 'manual';},
      (s: Session) => {delete s.candidates[0].source;},
      ...(['id', 'name', 'description'] as const).map(field => (s: Session) => {s.candidates[0][field] = ' ';}),
    ]) {
      const session = playing();mutate(session);
      expect(autoRecommendationKey(session)).toBeNull();
    }
  });

  it('rejects explicit and legacy confirmed choices, including choices linked to saved decisions', () => {
    const session = playing();
    expect(autoRecommendationKey(confirmLocalChoice(session, 'a'))).toBeNull();
    session.decisions = [{...saved(structuredClone(session)), chosenId: 'a'}];
    expect(autoRecommendationKey(session)).toBeNull();
    session.decisions = [];
    session.players[0].augmentSelections = [{id: 'a', name: '候选a', source: 'manual-choice', at: 'then'}];
    expect(autoRecommendationKey(session)).toBeNull();
  });

  it('does not block this round because an earlier round has a confirmed choice', () => {
    const session = playing();
    session.players[0].augmentSelections = [{id: 'old', name: '上一轮', source: 'manual-choice', at: 'then', band: 1}];
    expect(autoRecommendationKey(session)).not.toBeNull();
  });
});

describe('automatic recommendation observation gate', () => {
  it('does not turn one OCR frame into stable evidence when a read-only check runs later', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    expect(gate.isReady(session, 0)).toBe(false);
    expect(gate.observe(session, 0)).toBe(false);
    expect(gate.isReady(session, AUTO_STABLE_MS)).toBe(false);
    expect(gate.isReady(session, AUTO_STABLE_MS * 2)).toBe(false);
    expect(gate.observe(session, AUTO_STABLE_MS * 2)).toBe(true);
    expect(gate.isReady(session, AUTO_STABLE_MS * 3)).toBe(true);
  });

  it('requires two fresh OCR frames after a skipped frame, even while retrieval is in flight', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    ready(gate, session);
    gate.resetObservation();
    expect(gate.isReady(session, 2000)).toBe(false);
    expect(gate.observe(session, 3000)).toBe(false);
    expect(gate.isReady(session, 4000)).toBe(false);
    expect(gate.observe(session, 4500)).toBe(true);
    expect(gate.isReady(session, 4600)).toBe(true);
  });

  it('does not extend real OCR freshness when read-only checks repeat', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    ready(gate, session);
    expect(gate.isReady(session, AUTO_STABLE_MS + AUTO_OBSERVATION_MAX_GAP_MS)).toBe(true);
    expect(gate.isReady(session, AUTO_STABLE_MS + AUTO_OBSERVATION_MAX_GAP_MS + 1)).toBe(false);
    expect(gate.isReady(session, AUTO_STABLE_MS - 1)).toBe(false);
    expect(gate.isReady(session, NaN)).toBe(false);
  });

  it('rechecks attempts, saved decisions, current choice and identity without observing again', () => {
    const session = playing(), gate = new AutoRecommendationGate();
    ready(gate, session);
    expect(gate.isReady({...session, decisions: [saved(structuredClone(session))]}, 2000)).toBe(false);
    expect(gate.isReady(confirmLocalChoice(session, 'a'), 2000)).toBe(false);
    expect(gate.isReady(reroll(session, 1), 2000)).toBe(false);
    expect(gate.isReady(session, 2000)).toBe(true);
    gate.markAttempt(session, true);
    expect(gate.isReady(session, 2000)).toBe(false);
  });

  it('requires repeated observations spanning at least the stable interval and does not consume ready', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    expect(gate.observe(session, 0)).toBe(false);
    expect(gate.observe(session, AUTO_STABLE_MS - 1)).toBe(false);
    expect(gate.observe(session, AUTO_STABLE_MS)).toBe(true);
    expect(gate.observe(session, AUTO_STABLE_MS + 1)).toBe(true);
  });

  it('does not count a retained old observation across a long gap or backwards clock', () => {
    for (const later of [AUTO_OBSERVATION_MAX_GAP_MS + 1, -1]) {
      const gate = new AutoRecommendationGate(), session = playing();
      expect(gate.observe(session, 0)).toBe(false);
      expect(gate.observe(session, later)).toBe(false);
      expect(gate.observe(session, later + AUTO_STABLE_MS)).toBe(true);
    }
  });

  it('resets stability for every changed candidate group and for returning to a previous group', () => {
    const gate = new AutoRecommendationGate(), session = playing(), next = reroll(session, 1);
    expect(gate.observe(session, 0)).toBe(false);
    expect(gate.observe(next, 1000)).toBe(false);
    expect(gate.observe(session, 2000)).toBe(false);
    expect(gate.observe(session, 3000)).toBe(true);
  });

  it('keeps stability across card reordering and irrelevant game-state updates', () => {
    const gate = new AutoRecommendationGate(), session = playing(), next = structuredClone(session);
    next.candidates.reverse();next.players[0].items.push({itemID: 42});next.notes = 'changed';
    expect(gate.observe(session, 0)).toBe(false);
    expect(gate.observe(next, AUTO_STABLE_MS)).toBe(true);
  });

  it('requires fresh stability after explicit skipped, stopped or failed OCR observations', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    ready(gate, session);
    gate.resetObservation();
    ready(gate, session, 2000);
  });

  it('clears stability automatically for invalid, missing or selected observations', () => {
    for (const invalid of [{...playing(), candidates: []}, {...playing(), phase: 'EndOfGame'}, confirmLocalChoice(playing(), 'a')]) {
      const gate = new AutoRecommendationGate(), session = playing();
      expect(gate.observe(session, 0)).toBe(false);
      expect(gate.observe(invalid, 1000)).toBe(false);
      ready(gate, session, 2000);
    }
  });

  it('ignores non-finite clocks and clears earlier stability', () => {
    for (const time of [NaN, Infinity, -Infinity]) {
      const gate = new AutoRecommendationGate(), session = playing();
      expect(gate.observe(session, 0)).toBe(false);
      expect(gate.observe(session, time)).toBe(false);
      ready(gate, session, 2000);
    }
  });

  it('suppresses automatic retries after a sent request even when no result was saved', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    ready(gate, session);
    gate.markAttempt(session, true);
    expect(session.decisions).toHaveLength(0);
    expect(gate.observe(session, 2000)).toBe(false);
    gate.resetObservation();
    expect(gate.observe(session, 3000)).toBe(false);
    expect(gate.observe({...session, candidates: [...session.candidates].reverse()}, 4000)).toBe(false);
  });

  it('records a manual request for automatic deduplication without consuming the automatic quota', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    const manual = {...session, candidates: session.candidates.map(candidate => ({...candidate, source: 'manual' as const}))};
    gate.markAttempt(manual, false);
    gate.markAttempt(manual, false); // An explicit manual retry is still allowed by the caller.
    expect(gate.observe(session, 0)).toBe(false);
    expect(gate.observe(session, 1000)).toBe(false);
    for (let index = 1; index <= AUTO_MAX_PER_ROUND; index++) {
      const next = reroll(session, index);ready(gate, next, index * 2000);gate.markAttempt(next, true);
    }
    expect(gate.observe(reroll(session, 4), 10000)).toBe(false);
    expect(gate.observe(reroll(session, 4), 11000)).toBe(false);
  });

  it('limits all groups in a round to three automatic attempts, even after owner identity changes', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    for (let index = 0; index < AUTO_MAX_PER_ROUND; index++) {
      const next = reroll(session, index);ready(gate, next, index * 2000);gate.markAttempt(next, true);
    }
    const next = reroll(session, 10);next.ownPlayerId = 'other';
    expect(gate.observe(next, 8000)).toBe(false);
    expect(gate.observe(next, 9000)).toBe(false);
  });

  it('gives later rounds and games separate quota, and retains deduplication when returning', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    for (let index = 0; index < AUTO_MAX_PER_ROUND; index++) gate.markAttempt(reroll(session, index), true);
    for (const next of [
      {...session, candidateBand: 11, liveData: {activePlayer: {level: 11}}},
      {...session, matchId: '456'}, {...session, id: 'session-b'},
    ]) ready(gate, next, 10000);
    expect(gate.observe(reroll(session, 3), 12000)).toBe(false);
    expect(gate.observe(reroll(session, 0), 13000)).toBe(false);
  });

  it('requires a fresh stable observation when switching rounds or sessions', () => {
    const session = playing();
    for (const next of [{...session, id: 'other'}, {...session, candidateBand: 11, liveData: {activePlayer: {level: 11}}}]) {
      const gate = new AutoRecommendationGate();
      expect(gate.observe(session, 0)).toBe(false);
      ready(gate, next, 1000);
    }
  });

  it('deduplicates persisted model decisions after restart without requiring live-only snapshot fields', () => {
    const session = playing();
    session.decisions = [saved({id: session.id, matchId: session.matchId, ownPlayerId: session.ownPlayerId,
      players: session.players, candidateBand: session.candidateBand, candidates: [...session.candidates].reverse().map(({source, ...candidate}) => candidate)})];
    const gate = new AutoRecommendationGate();
    expect(gate.observe(session, 0)).toBe(false);
    expect(gate.observe(session, 1000)).toBe(false);
    ready(gate, reroll(session, 1), 2000);
  });

  it('does not mix saved decisions from another game, round, owner or changed candidate description', () => {
    const session = playing();
    const context = structuredClone(session);context.candidates[0].description = 'different';
    session.decisions = [saved(null), saved({}), saved({players: [null], candidates: [null]}), saved({...session, id: 'other'}),
      saved({...session, matchId: 'other'}), saved({...session, ownPlayerId: 'other'}), saved({...session, candidateBand: 1}), saved(context)];
    ready(new AutoRecommendationGate(), session);
  });

  it('respects newly saved successes and explicit choices even after becoming ready', () => {
    const session = playing(), gate = new AutoRecommendationGate();
    ready(gate, session);
    session.decisions = [saved(structuredClone(session))];
    expect(gate.observe(session, 2000)).toBe(false);
    const selected = confirmLocalChoice(playing(), 'a');
    expect(gate.observe(selected, 3000)).toBe(false);
  });

  it('ignores attempts without a usable choice identity', () => {
    const gate = new AutoRecommendationGate(), session = playing();
    for (let index = 0; index < 5; index++) gate.markAttempt({...session, matchId: ''}, true);
    ready(gate, session);
  });
});
