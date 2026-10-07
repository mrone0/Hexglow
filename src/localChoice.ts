import {synchronizeSelections,type AugmentSelection,type Session} from './domain';
import {augmentBand,ownLevel} from './level';

type Decision=Session['decisions'][number];
type ChoiceState={session:Session;band:number|null;choice?:AugmentSelection;legacyChoice?:AugmentSelection;available:boolean};

export function localChoiceState(session:Session):ChoiceState {
  const current=synchronizeSelections(session);
  const own=current.players.find(player=>player.id===current.ownPlayerId);
  const level=ownLevel(current.liveData),band=level===null?null:augmentBand(level);
  const choice=band===null?undefined:own?.augmentSelections?.find(selection=>selection.band===band);
  // 旧记录没有轮次时不猜成当前轮，但同名/同 ID 已确认候选不能再次确认。
  const legacyChoice=own?.augmentSelections?.find(selection=>selection.band===undefined&&current.candidates.some(candidate=>candidate.id===selection.id||candidate.name.trim()===selection.name.trim()));
  return {session:current,band,choice,legacyChoice,available:current.phase==='InProgress'&&!current.archived&&!current.endedAt&&band!==null&&current.candidateBand===band&&!!own&&!choice&&!legacyChoice};
}

/** A model snapshot may inform this round only when its game, player and band are explicit. */
export function isCurrentChoiceDecision(session:Session,decision:Decision):boolean {
  const context=decision.context as Partial<Session>|null;
  const level=ownLevel(session.liveData);
  if(!context||session.phase!=='InProgress'||session.archived||session.endedAt||level===null||context.id!==session.id||context.candidateBand!==augmentBand(level)||session.candidateBand!==context.candidateBand)return false;
  if(session.matchId&&context.matchId&&session.matchId!==context.matchId)return false;
  const own=session.players.find(player=>player.id===session.ownPlayerId);
  const analyzed=Array.isArray(context.players)?context.players.find(player=>player.id===context.ownPlayerId):undefined;
  return !!own&&own.id===analyzed?.id&&own.champion===analyzed.champion;
}

function sameCandidates(left:Session['candidates'],right:Session['candidates']):boolean {
  return left.length===right.length&&left.every(candidate=>right.some(other=>other.id===candidate.id&&other.name===candidate.name&&other.description===candidate.description));
}

export function confirmLocalChoice(session:Session,id:string,at=new Date().toISOString()):Session {
  const {session:current,band,available}=localChoiceState(session);
  const own=current.players.find(player=>player.id===current.ownPlayerId);
  const candidate=current.candidates.find(value=>value.id===id);
  if(!available||band===null||!own||!candidate?.name.trim()||!candidate.description.trim())return current;
  // 本轮实际选择只记录一次；如最新模型分析针对同一组候选，同步标注它，
  // 不能把上一轮、其它对局或已被纠正的模型快照当成本次确认。
  const last=current.decisions.at(-1);
  const context=last?.context as Partial<Session>|undefined;
  const linkDecision=!!last&&!last.chosenId&&isCurrentChoiceDecision(current,last)&&Array.isArray(context?.candidates)&&sameCandidates(current.candidates,context.candidates);
  return {...current,decisions:linkDecision?current.decisions.map(decision=>decision===last?{...decision,chosenId:id}:decision):current.decisions,players:current.players.map(player=>player!==own?player:{...player,
    augments:player.augments.includes(candidate.name)?player.augments:[...player.augments,candidate.name],
    augmentSelections:[...(player.augmentSelections||[]),{id:candidate.id,name:candidate.name,source:'manual-choice',at,band}],
  })};
}
