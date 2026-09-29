import {useEffect,useState} from 'react';
import {phaseLabel,type Session} from './domain';

type Props={
 session:Session;
 busy:boolean;
 ready:boolean;
 setupIssue:string;
 blockers:string[];
 onRun:()=>void;
 onSettings:()=>void;
 onPatch:(p:Partial<Session>)=>void;
 onResume:()=>void;
 historical:boolean;
};

export function LiveOverview({session,busy,ready,setupIssue,blockers,onRun,onSettings,onPatch,onResume,historical}:Props){
 const [editing,setEditing]=useState(false);
 const [pendingChoice,setPendingChoice]=useState<string|null>(null);
 const own=session.players.find(p=>p.id===session.ownPlayerId),last=session.decisions.at(-1);
 const hasGame=!!session.players.length,unknown=session.players.some(p=>!p.augmentsConfirmed);
 const candidatesComplete=session.candidates.length>=2&&session.candidates.every(candidate=>candidate.name.trim()&&candidate.description.trim());

 useEffect(()=>{setPendingChoice(null);},[last?.at,last?.chosenId]);
 useEffect(()=>{if(hasGame&&!last&&!candidatesComplete)setEditing(true);},[hasGame,last?.at,candidatesComplete]);

 function confirmChoice(){
  if(!last||last.chosenId||!pendingChoice)return;
  onPatch({decisions:session.decisions.map(d=>d===last?{...d,chosenId:pendingChoice}:d)});
 }

 return <div className="live-simple">
  <section className="match-strip">
   <div className="hero-avatar">{own?.champion.slice(0,2)||'◇'}</div>
   <div><span className="quiet-label">{historical?'历史对局':'当前对局'}</span><h1>{own?.champion||'等待进入对局'}</h1><p>{hasGame?phaseLabel(session.phase):'打开游戏即可，海萤会自动识别当前对局。'}</p></div>
   {historical&&<button onClick={onResume}>返回实时对局</button>}
   {hasGame&&<details className="lineup"><summary>双方阵容</summary>{['ORDER','CHAOS'].map(t=><p key={t}><b>{t===own?.team?'我方':'敌方'}</b> {session.players.filter(p=>p.team===t).map(p=>p.champion).join(' · ')}</p>)}</details>}
  </section>

  <section className="recommend-panel">
   <div className="recommend-heading"><h2>海克斯推荐</h2>{last&&<small>分析于 {new Date(last.at).toLocaleTimeString()}</small>}</div>
   {!hasGame?<div className="calm-empty"><span>✧</span><h3>先去享受游戏</h3><p>检测到对局后，这里会显示你的英雄与海克斯建议。</p><small>无需手动建立对局或保存快照</small></div>:<>
    {last?<>
     <div className="simple-ranking">{last.result.ranking.map((r,i)=>{
      const c=(last.context as Session).candidates.find(c=>c.id===r.candidateId);
      const confirmed=last.chosenId===r.candidateId,pending=pendingChoice===r.candidateId,locked=!!last.chosenId;
      return <div className={`choice-slot${i===0?' recommended':''}`} key={r.candidateId}>
       <div className="choice-label"><span>{i===0?'✦ 海萤优先推荐':`备选 ${i}`}</span>{i===0&&<small>综合当前阵容与信息</small>}</div>
       <article className={`hex-choice${confirmed?' selected':''}${pending?' pending':''}`}>
        <div className="choice-meta"><span className="quiet-label">{i===0?'推荐方案':`比较方案 ${i+1}`}</span>{confirmed?<span className="chosen-pill">已确认</span>:pending&&<span className="chosen-pill pending-pill">待确认</span>}</div>
        <h3>{c?.name||r.candidateId}</h3>
        <p>{r.reason}</p>
        <div className="choice-details"><h4>效果与注意事项</h4><p className="choice-effect">{c?.description||'暂无完整效果说明。'}</p>{r.risks.length>0?<ul>{r.risks.map((s,j)=><li key={j}>{s}</li>)}</ul>:<p className="choice-safe">暂无额外注意事项</p>}</div>
        <button disabled={busy||locked} onClick={()=>setPendingChoice(r.candidateId)}>{locked?(confirmed?'✓ 已确认选择':'选择已锁定'):pending?'等待确认':'我选了这个'}</button>
       </article>
      </div>;
     })}</div>
     {pendingChoice&&!last.chosenId&&<div className="choice-confirm-bar"><div><strong>确认选择「{(last.context as Session).candidates.find(c=>c.id===pendingChoice)?.name||pendingChoice}」？</strong><span>确认后将锁定本次选择，不能再次更换。</span></div><div className="choice-confirm-actions"><button disabled={busy} onClick={()=>setPendingChoice(null)}>取消</button><button className="accent" disabled={busy} onClick={confirmChoice}>确认选择</button></div></div>}
     {last.chosenId&&<div className="choice-locked-note">✓ 本次选择已确认并锁定，不可重复更换。</div>}
     <details className="recommend-notes"><summary>查看分析说明与信息缺失</summary><p>{last.result.summary}</p>{last.result.missingInformation.map((s,i)=><p key={i}>{s}</p>)}<p>分数与排序不是胜率；这是上次分析时的建议，修改候选或局势后需要重新分析。</p></details>
    </>:<div className="calm-empty"><span>◇</span><h3>{busy?'正在比较你的候选…':'等待本轮海克斯候选'}</h3><p>{candidatesComplete?'候选已就绪，可以开始生成建议。':'游戏本地接口尚未返回候选；快速补充区已在下方展开。已识别到的字段会自动填入。'}</p></div>}
    <div className="next-action">{!ready?<><span>{setupIssue}</span><button className="accent" onClick={onSettings}>前往设置</button></>:<><span>{busy?'正在分析，请稍候':blockers.length?blockers[0]:unknown?'将基于已知信息分析，未识别的海克斯不会当作没有。':'候选与模型均已就绪'}</span><button onClick={()=>setEditing(v=>!v)}>{editing?'收起候选':'补充 / 修改候选'}</button><button className="accent" disabled={busy||blockers.length>0} onClick={onRun}>{last?'重新分析':'获取建议'}</button></>}</div>
    {editing&&<div className="candidate-entry"><p className="hint">仅需补充本轮候选，不要求逐一填写双方所有玩家。请填写真实效果，缺失信息不会自动编造。</p><div className="candidates">{session.candidates.map((c,i)=><div className="candidate" key={c.id}><label>候选 {i+1}<input disabled={busy} value={c.name} placeholder="海克斯名称" onChange={e=>onPatch({candidates:session.candidates.map(x=>x.id===c.id?{...x,name:e.target.value}:x)})}/></label><textarea disabled={busy} value={c.description} aria-label={`候选${i+1}完整效果`} placeholder="效果与数值" onChange={e=>onPatch({candidates:session.candidates.map(x=>x.id===c.id?{...x,description:e.target.value}:x)})}/></div>)}</div></div>}
   </>}
  </section>
 </div>;
}
