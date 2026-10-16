import {describe, expect, it, vi} from 'vitest';
import {newSession, type Session} from '../core/domain';
import {NEW_REQUEST_INTERVAL_MS, REPEAT_REQUEST_INTERVAL_MS, RequestInterval} from './requestInterval';

function playing(): Session {
  return {...newSession(), id:'session-a', matchId:'123', ownPlayerId:'self', candidateBand:1,
    players:[{id:'self', name:'', champion:'hero', team:'ORDER', items:[], augments:[], augmentsConfirmed:false}],
    candidates:['a','b','c'].map(id => ({id, name:`name-${id}`, description:`effect-${id}`, source:'ocr'}))};
}

function changed(session: Session, suffix = 'next'): Session {
  return {...session, candidates:session.candidates.map(candidate => ({...candidate, id:`${candidate.id}-${suffix}`}))};
}

function harness(at = 0) {
  let time = at;
  return {interval:new RequestInterval(() => time), set:(next:number) => {time=next;}};
}

describe('request dispatch intervals', () => {
  it('keeps a short global interval and a longer same-choice repeat interval', () => {
    expect(NEW_REQUEST_INTERVAL_MS).toBe(1000);
    expect(REPEAT_REQUEST_INTERVAL_MS).toBe(8000);
  });

  it('does not consume an interval during local preparation or repeated reads', () => {
    const {interval,set}=harness(), session=playing();
    for (const at of [0,999,1000,7999,8000,15000]) {
      set(at);
      expect(interval.remaining('recommend',session)).toBe(0);
      expect(interval.remaining('review',session)).toBe(0);
    }
    interval.markDispatched('recommend',session);
    expect(interval.remaining('recommend',session)).toBe(8000);
  });

  it.each([[0,8000],[999,7001],[1000,7000],[7999,1],[8000,0],[9000,0]])(
    'returns the same-group boundary at %i ms without extending it', (at,wait) => {
      const {interval,set}=harness(), session=playing();
      interval.markDispatched('recommend',session);set(at);
      expect(interval.remaining('recommend',session)).toBe(wait);
      expect(interval.remaining('recommend',session)).toBe(wait);
    });

  it.each([[0,1000],[999,1],[1000,0],[7999,0],[8000,0]])(
    'returns the different-group boundary at %i ms', (at,wait) => {
      const {interval,set}=harness(), session=playing();
      interval.markDispatched('recommend',session);set(at);
      expect(interval.remaining('recommend',changed(session))).toBe(wait);
    });

  it('retains the first group repeat limit across A → B → A', () => {
    const {interval,set}=harness(), session=playing(), next=changed(session);
    interval.markDispatched('recommend',session);set(1000);
    interval.markDispatched('recommend',next);set(2000);
    expect(interval.remaining('recommend',session)).toBe(6000);
    expect(interval.remaining('recommend',next)).toBe(7000);
    set(8000);
    expect(interval.remaining('recommend',session)).toBe(0);
    expect(interval.remaining('recommend',next)).toBe(1000);
  });

  it.each(['id','matchId','candidateBand','candidateId','name','description'])(
    'does not carry the repeat interval into a new %s identity', field => {
      const {interval,set}=harness(), session=playing(), next=structuredClone(session);
      if (field==='id'||field==='matchId'||field==='ownPlayerId') next[field]+='-next';
      else if (field==='champion') next.players[0].champion+='-next';
      else if (field==='candidateBand') next.candidateBand=7;
      else next.candidates[0][field==='candidateId'?'id':field as 'name'|'description']+='-next';
      interval.markDispatched('recommend',session);set(1000);
      expect(interval.remaining('recommend',next)).toBe(0);
      expect(interval.remaining('recommend',session)).toBe(7000);
    });

  it('does not bypass a repeat limit through ordering, source, equipment or unrelated context', () => {
    const {interval,set}=harness(), session=playing(), next=structuredClone(session);
    next.candidates.reverse();next.candidates.forEach(candidate => {candidate.source='manual';});
    next.players[0].items=[{itemID:42}];next.players[0].augments=['previous-choice'];
    next.players[0].name='changed';next.notes='changed';next.liveData={gameData:{gameTime:500}};
    Object.assign(next,{knowledge:{revision:2}});
    interval.markDispatched('recommend',session);set(1000);
    expect(interval.remaining('recommend',next)).toBe(7000);
  });

  it('keeps the same-group repeat interval when unknown roster and owner arrive',()=>{
    const {interval,set}=harness(),complete=playing(),unknown={...complete,ownPlayerId:'',players:[]};
    interval.markDispatched('recommend',unknown);set(1000);
    expect(interval.remaining('recommend',complete)).toBe(7000);
    complete.ownPlayerId='corrected';complete.players[0].champion='corrected';
    expect(interval.remaining('recommend',complete)).toBe(7000);
  });

  it('uses the entire candidate tuple for deterministic ordering even if manual IDs repeat', () => {
    const {interval,set}=harness(), session=playing();
    session.candidates.forEach(candidate => {candidate.id='same';});
    interval.markDispatched('recommend',session);set(1000);
    expect(interval.remaining('recommend',{...session,candidates:[...session.candidates].reverse()})).toBe(7000);
  });

  it('groups reviews by session and match, without inheriting recommendation repeat limits', () => {
    const {interval,set}=harness(), session=playing(), next=changed(structuredClone(session));
    interval.markDispatched('recommend',session);set(1000);
    expect(interval.remaining('review',session)).toBe(0);
    interval.markDispatched('review',session);set(2000);
    next.candidateBand=7;next.ownPlayerId='other';next.players[0].champion='other';
    expect(interval.remaining('review',next)).toBe(7000);
    expect(interval.remaining('review',{...next,id:'session-b'})).toBe(0);
    expect(interval.remaining('review',{...next,matchId:'456'})).toBe(0);
    expect(interval.remaining('recommend',session)).toBe(6000);
    expect(interval.remaining('recommend',next)).toBe(0);
  });

  it('retains the interval for a failed dispatch and restarts it only on another dispatch', () => {
    const {interval,set}=harness(), session=playing();
    interval.markDispatched('recommend',session); // No success acknowledgement is required.
    set(7999);expect(interval.remaining('recommend',session)).toBe(1);
    set(8000);expect(interval.remaining('recommend',session)).toBe(0);
    interval.markDispatched('recommend',session);set(8999);
    expect(interval.remaining('recommend',session)).toBe(7001);
    expect(interval.remaining('recommend',changed(session))).toBe(1);
  });

  it('does not mutate the session while generating identities', () => {
    const {interval}=harness(), session=playing(), before=structuredClone(session);
    session.candidates.reverse();before.candidates.reverse();
    interval.markDispatched('recommend',session);interval.remaining('recommend',session);
    expect(session).toEqual(before);
  });

  it('uses a monotonic default clock instead of wall time', () => {
    const clock=vi.spyOn(performance,'now').mockReturnValue(10000);
    try {
      const interval=new RequestInterval(), session=playing();
      interval.markDispatched('recommend',session);clock.mockReturnValue(11000);
      expect(interval.remaining('recommend',changed(session))).toBe(0);
      expect(interval.remaining('recommend',session)).toBe(7000);
    } finally {clock.mockRestore();}
  });

  it('handles a clock rollback conservatively without waiting for the old wall time to catch up', () => {
    const {interval,set}=harness(3_600_000), session=playing();
    interval.markDispatched('recommend',session);set(3_601_000);
    expect(interval.remaining('recommend',session)).toBe(7000);
    set(0);
    expect(interval.remaining('recommend',session)).toBe(7000);
    expect(interval.remaining('recommend',session)).toBe(7000);
    set(6999);expect(interval.remaining('recommend',session)).toBe(1);
    set(7000);expect(interval.remaining('recommend',session)).toBe(0);
  });

  it('does not prematurely release or poison timers after a non-finite clock read', () => {
    const {interval,set}=harness(), session=playing();
    interval.markDispatched('recommend',session);set(1000);
    expect(interval.remaining('recommend',session)).toBe(7000);
    for (const at of [NaN,Infinity,-Infinity]) {
      set(at);expect(interval.remaining('recommend',session)).toBe(7000);
    }
    set(8000);expect(interval.remaining('recommend',session)).toBe(0);
  });

  it('cleans expired dispatches while retaining unexpired groups', () => {
    const {interval,set}=harness(), session=playing();
    interval.markDispatched('recommend',session);set(1000);
    interval.markDispatched('recommend',changed(session,'b'));set(8000);
    interval.markDispatched('recommend',changed(session,'c'));
    const records=(interval as unknown as {sent:Map<string,number>}).sent;
    expect(records.size).toBe(2);
    set(9000);
    expect(interval.remaining('recommend',session)).toBe(0);
    expect(interval.remaining('recommend',changed(session,'b'))).toBe(0);
    expect(interval.remaining('recommend',changed(session,'c'))).toBe(7000);
  });

  it('bounds records even if a caller misuses markDispatched, without forgetting an unexpired limit', () => {
    const {interval,set}=harness(), session=playing();
    for (let index=0;index<100;index++) interval.markDispatched('recommend',changed(session,String(index)));
    expect((interval as unknown as {sent:Map<string,number>}).sent.size).toBeLessThanOrEqual(32);
    expect(interval.remaining('recommend',changed(session,'0'))).toBe(8000);
    set(7999);expect(interval.remaining('recommend',changed(session,'0'))).toBe(1);
    set(8000);expect(interval.remaining('recommend',changed(session,'0'))).toBe(0);
    interval.markDispatched('recommend',session);
    expect((interval as unknown as {sent:Map<string,number>}).sent.size).toBe(1);
    set(9000);expect(interval.remaining('recommend',changed(session,'new'))).toBe(0);
  });
});
