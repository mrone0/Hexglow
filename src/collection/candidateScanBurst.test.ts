import {describe,expect,it} from 'vitest';
import {CandidateScanBurst,CANDIDATE_BURST_MAX_SCANS,CANDIDATE_BURST_WINDOW_MS,CANDIDATE_RECHECK_MS} from './candidateScanBurst';

describe('bounded candidate OCR scan burst',()=>{
 it('does not start a burst from take or an empty candidate key',()=>{
  const burst=new CandidateScanBurst();
  expect(burst.take(1000)).toBeNull();
  burst.arm('',1000);
  expect(burst.take(1000)).toBeNull();
  burst.arm('   ',1000);
  expect(burst.take(1000)).toBeNull();
 });

 it('plans a real recheck 550 ms after a valid armed observation',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('round-one-candidates',1000);
  expect(CANDIDATE_RECHECK_MS).toBe(550);
  expect(burst.take(1000)).toBe(1550);
  expect(burst.take(1600,300)).toBe(1900);
 });

 it('allows at most four planned scans and repeated same-key arms do not replenish them',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('same-candidates',1000);
  expect(CANDIDATE_BURST_MAX_SCANS).toBe(4);
  for(let i=0;i<4;i++){
   const now=1000+i*600;
   burst.arm('same-candidates',now);
   expect(burst.take(now)).toBe(now+550);
  }
  burst.arm('same-candidates',3500);
  expect(burst.take(3500)).toBeNull();
 });

 it('does not extend the initial six-second window when the same key is recognized again',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('same-candidates',1000);
  expect(CANDIDATE_BURST_WINDOW_MS).toBe(6000);
  burst.arm('same-candidates',6400);
  expect(burst.take(6450)).toBe(7000);
  expect(burst.take(6451)).toBeNull();
  burst.arm('same-candidates',10000);
  expect(burst.take(10000)).toBeNull();
 });

 it('rejects scans at the deadline even with zero delay',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('candidates',1000);
  expect(burst.take(7000,0)).toBeNull();
 });

 it('checks activity without arming a burst or consuming its four-scan budget',()=>{
  const burst=new CandidateScanBurst();
  expect(burst.isActive(1000)).toBe(false);
  burst.arm('candidates',1000);
  for(let i=0;i<4;i++){
   expect(burst.isActive(1000)).toBe(true);
   expect(burst.take(1000)).toBe(1550);
  }
  expect(burst.take(1000)).toBeNull();
  expect(burst.isActive(1550)).toBe(true);
 });

 it('allows an already scheduled last scan exactly at the deadline but rejects a throttled late timer',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('candidates',1000);
  for(let i=0;i<3;i++)burst.take(1000);
  expect(burst.take(6450)).toBe(7000);
  expect(burst.isActive(7000)).toBe(true);
  expect(burst.isActive(7001)).toBe(false);
 });

 it.each([NaN,Infinity,-Infinity,-1,999])('invalidates a scheduled burst when its timer clock is invalid or backwards: %s',now=>{
  const burst=new CandidateScanBurst();
  burst.arm('candidates',1000);
  burst.take(1000);
  expect(burst.isActive(now)).toBe(false);
  expect(burst.isActive(1550)).toBe(false);
 });

 it('reports an explicitly reset burst as inactive',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('candidates',1000);
  burst.take(1000);
  burst.reset();
  expect(burst.isActive(1550)).toBe(false);
 });

 it('starts a fresh budget and window for a new nonempty candidate key',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('old-candidates',1000);
  for(let i=0;i<4;i++)expect(burst.take(1000)).toBe(1550);
  expect(burst.take(1000)).toBeNull();
  burst.arm('new-candidates',12000);
  expect(burst.take(12000)).toBe(12550);
 });

 it.each([NaN,Infinity,-Infinity,-1])('rejects invalid clock %s without implicitly arming',now=>{
  const burst=new CandidateScanBurst();
  burst.arm('candidates',now);
  expect(burst.take(1000)).toBeNull();
 });

 it.each([NaN,Infinity,-Infinity,-1])('invalidates an existing burst on invalid take clock %s',now=>{
  const burst=new CandidateScanBurst();
  burst.arm('candidates',1000);
  expect(burst.take(now)).toBeNull();
  burst.arm('candidates',1100);
  expect(burst.take(1100)).toBeNull();
 });

 it('invalidates a burst when time moves backwards between scans',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('candidates',1000);
  expect(burst.take(1500)).toBe(2050);
  expect(burst.take(1499)).toBeNull();
  expect(burst.take(1600)).toBeNull();
 });

 it('does not reset the clock guard when an arm call moves backwards',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('old-candidates',1000);
  burst.arm('new-candidates',999);
  expect(burst.take(1000)).toBeNull();
  burst.arm('new-candidates',1100);
  expect(burst.take(1100)).toBe(1650);
 });

 it('rejects invalid delays without consuming a successful scan allowance',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('candidates',1000);
  for(const delay of [NaN,Infinity,-Infinity,-1,6001])expect(burst.take(1000,delay)).toBeNull();
  for(let i=0;i<4;i++)expect(burst.take(1000)).toBe(1550);
  expect(burst.take(1000)).toBeNull();
 });

 it('clears the key, budget and clock guard on reset',()=>{
  const burst=new CandidateScanBurst();
  burst.arm('same-candidates',10000);
  for(let i=0;i<4;i++)burst.take(10000);
  burst.reset();
  expect(burst.take(1000)).toBeNull();
  burst.arm('same-candidates',1000);
  expect(burst.take(1000)).toBe(1550);
 });
});
