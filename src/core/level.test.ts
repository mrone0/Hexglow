import {describe, expect, it} from 'vitest';
import {augmentBand, augmentRoundLabel, nextTriggers, ownLevel, type TriggerState} from './level';

const empty: TriggerState = {matchId: '', fired: []};

describe('augmentBand', () => {
  it('maps levels to the official augment levels', () => {
    expect([1, 6, 7, 10, 11, 14, 15, 18].map(augmentBand)).toEqual([1, 1, 7, 7, 11, 11, 15, 15]);
  });
});

describe('augmentRoundLabel',()=>{
  it('labels selection rounds instead of displaying an internal band as the player level',()=>{
    expect([1,7,11,15].map(augmentRoundLabel)).toEqual(['第1轮','第2轮','第3轮','第4轮']);
    expect(augmentRoundLabel(augmentBand(3))).toBe('第1轮');
    expect(augmentRoundLabel(3)).toBe('未知轮次');
  });
});

describe('ownLevel', () => {
  it('reads the active player level', () => {
    expect(ownLevel({activePlayer: {level: 9}})).toBe(9);
    expect(ownLevel({activePlayer: {level: 9.7}})).toBe(9);
    expect(ownLevel({activePlayer: {}})).toBeNull();
    expect(ownLevel(null)).toBeNull();
    expect(ownLevel({activePlayer: {level: -3}})).toBeNull();
  });
});

describe('nextTriggers', () => {
  it('fires once per band and never repeats', () => {
    let state = empty;
    let step = nextTriggers(state, 'g1', 1);
    expect(step.fired).toEqual([1]);
    state = step.state;
    step = nextTriggers(state, 'g1', 6);
    expect(step.fired).toEqual([]);
    state = step.state;
    step = nextTriggers(state, 'g1', 7);
    expect(step.fired).toEqual([7]);
    state = step.state;
    step = nextTriggers(state, 'g1', 7);
    expect(step.fired).toEqual([]);
  });
  it('only fires the band of the first sample', () => {
    const step = nextTriggers(empty, 'g1', 9);
    expect(step.fired).toEqual([7]);
    expect(nextTriggers(step.state, 'g1', 10).fired).toEqual([]);
    expect(nextTriggers(step.state, 'g1', 11).fired).toEqual([11]);
    expect(nextTriggers(step.state, 'g1', 15).fired).toEqual([15]);
  });
  it('resets when the match changes', () => {
    let state = nextTriggers(empty, 'g1', 7).state;
    state = nextTriggers(state, 'g2', 7).state;
    expect(state).toEqual({matchId: 'g2', fired: [7]});
    expect(nextTriggers(state, 'g2', 1).fired).toEqual([]);
    expect(nextTriggers(empty, 'g2', 7).state.fired).toEqual([7]);
  });
  it('ignores missing level or match', () => {
    expect(nextTriggers(empty, 'g1', null).fired).toEqual([]);
    expect(nextTriggers(empty, '', 7).fired).toEqual([]);
    expect(nextTriggers(empty, '', null).state).toEqual(empty);
  });
});
