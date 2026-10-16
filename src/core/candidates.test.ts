import {describe,expect,it} from 'vitest';
import {markCandidateEdits,mergeDetectedCandidates} from './candidates';
import {newSession,type Candidate} from './domain';

const detected:Candidate[]=[{id:'1068',name:'循环往复',description:'bundled'},{id:'1388',name:'无限循环往复',description:'bundled'}];

describe('OCR and manual candidate edits',()=>{
 it('preserves a corrected effect when the same OCR candidates are refreshed',()=>{
  const s=newSession();s.candidateBand=7;s.candidates=structuredClone(detected);
  s.candidates=markCandidateEdits(s.candidates,s.candidates.map((c,i)=>i===0?{...c,description:'actual effect'}:c));
  const merged=mergeDetectedCandidates(s,detected,7)!;
  expect(merged[0].description).toBe('actual effect');
  expect(merged[0].source).toBe('manual');
 });
 it('matches manually filled slots by name without discarding their effect',()=>{
  const s=newSession();s.candidates=markCandidateEdits(s.candidates,[{id:'1',name:'循环往复',description:'actual effect'}]);
  expect(mergeDetectedCandidates(s,detected,1)?.[0]).toEqual({id:'1068',name:'循环往复',description:'actual effect',source:'manual'});
 });
 it('holds manual identities when OCR suggests different candidates in the same round',()=>{
  const s=newSession();s.candidateBand=7;s.candidates=[{...detected[0],name:'corrected identity',source:'manual'}];
  expect(mergeDetectedCandidates(s,detected,7)).toBeNull();
 });
 it('accepts the next round or an explicit request to resume OCR',()=>{
  const s=newSession();s.candidateBand=7;s.candidates=[{...detected[0],name:'manual',source:'manual'}];
  expect(mergeDetectedCandidates(s,detected,11)).toEqual(detected.map(c=>({...c,source:'ocr'})));
  s.candidates=markCandidateEdits(s.candidates,s.candidates.map(c=>({...c,source:'ocr'})));
  expect(mergeDetectedCandidates(s,detected,7)).not.toBeNull();
 });
});
