import type {Candidate,Session} from './domain';

const identity=(name:string)=>name.replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();

export function markCandidateEdits(previous:Candidate[],next:Candidate[]):Candidate[]{
 return next.map(candidate=>{
  const old=previous.find(c=>c.id===candidate.id);
  return !old||old.name!==candidate.name||old.description!==candidate.description
   ?{...candidate,source:'manual'}:candidate;
 });
}

// 同一轮的手动校正优先；明确进入下一等级轮次后可以读取新候选。
export function mergeDetectedCandidates(session:Session,detected:Candidate[],band:number):Candidate[]|null {
 const manual=session.candidateBand===undefined||session.candidateBand===band
  ?session.candidates.filter(c=>c.source==='manual'):[];
 const matched=(candidate:Candidate)=>manual.find(c=>c.id===candidate.id||identity(c.name)===identity(candidate.name));
 if(manual.some(c=>!detected.some(d=>matched(d)===c&&identity(c.name)===identity(d.name))))return null;
 return detected.map(candidate=>{
  const corrected=matched(candidate);
  return corrected?{...corrected,id:candidate.id}:{...candidate,source:'ocr'};
 });
}
