import {useState} from 'react';
import type {Session} from './domain';
import {confirmLocalChoice,localChoiceState} from './localChoice';

export function LocalChoiceControls({session,busy,onPatch}:{session:Session;busy:boolean;onPatch:(patch:Partial<Session>)=>void}){
  const [pending,setPending]=useState<{id:string;key:string}|null>(null);
  const state=localChoiceState(session);
  const selectionKey=JSON.stringify([session.id,session.ownPlayerId,session.candidateBand,session.candidates]);
  if(state.choice)return <p className="choice-locked-note">✓ 本轮已记录「{state.choice.name}」，选择已锁定。</p>;
  if(state.legacyChoice)return <p className="choice-locked-note">「{state.legacyChoice.name}」已有确认记录，但旧记录未标明轮次；本组候选不再重复确认。</p>;
  if(!state.available)return null;
  const candidate=pending?.key===selectionKey?session.candidates.find(value=>value.id===pending.id):undefined;
  return <div className="local-choice-controls"><p className="hint">在游戏中选好后，在这里记录实际选择；本地推荐与模型分析共用本轮记录。</p><div className="local-choice-buttons">{session.candidates.map(value=><button key={value.id} disabled={busy||!value.name.trim()||!value.description.trim()} aria-pressed={candidate?.id===value.id} onClick={()=>setPending({id:value.id,key:selectionKey})}>我选了「{value.name}」</button>)}</div>{candidate&&<div className="choice-confirm-bar"><div><strong>确认记录「{candidate.name}」？</strong><span>仅记录你在游戏中的选择，确认后本轮锁定。</span></div><div className="choice-confirm-actions"><button disabled={busy} onClick={()=>setPending(null)}>取消</button><button className="accent" disabled={busy} onClick={()=>{const next=confirmLocalChoice(session,candidate.id);onPatch({players:next.players,decisions:next.decisions});setPending(null);}}>确认选择</button></div></div>}</div>;
}
