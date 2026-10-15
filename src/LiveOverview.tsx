import {useEffect,useState} from 'react';
import {endPhases,phaseLabel,type Session,type CollectorSnapshot} from './domain';
import {augmentRoundLabel,ownLevel} from './level';
import {assessmentLabel,localRankingPresentation,localRecommendationKey,modelRecommendation,selectLocalRecommendation,type LocalRecommendation} from './liveRecommendation';
import {LocalChoiceControls} from './LocalChoiceControls';
import {isCurrentChoiceDecision,localChoiceState} from './localChoice';
import {canPublishModelRecommendation} from './modelPublication';
import {overlayPresentation} from './overlayPresentation';
import type {RecommendationStatus} from './recommendationStatus';
import {observedChoiceBand} from './choiceContext';
import {hasGameStart} from './gameStart';

type Props={
 session:Session;
 snapshot:CollectorSnapshot|null;
 auto:boolean;
 autoRecommend?:boolean;
 autoRecommendStatus?:string;
 analysisStatus?:RecommendationStatus;
 localRecommendation:LocalRecommendation|null;
 detectionMessage:string;
 onSync:()=>void;
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

/** A retained session is evidence, but only a matching live snapshot is current. */
export function liveOverviewState(session:Session,snapshot:CollectorSnapshot|null,historical:boolean){
 const phase=historical?session.phase:snapshot?.phase||session.phase;
 const raw=snapshot?.liveData;
 const hasLive=!!raw&&typeof raw==='object'&&!Array.isArray(raw)&&!!(raw.activePlayer||raw.gameData||Array.isArray(raw.allPlayers)&&raw.allPlayers.length||hasGameStart(raw));
 const sameGame=!snapshot?.gameId||!session.matchId||String(snapshot.gameId)===session.matchId;
 const identified=!!snapshot?.gameId&&!!session.matchId&&String(snapshot.gameId)===session.matchId;
 const live=!historical&&!session.endedAt&&!session.archived&&session.phase==='InProgress'&&phase==='InProgress'&&!!snapshot&&snapshot.connection!=='disconnected'&&((hasLive&&sameGame)||identified);
 const previous=!!session.endedAt||!!session.archived||endPhases.has(phase||'')||['None','Lobby','Matchmaking','ReadyCheck','ChampSelect','GameStart'].includes(phase||'');
 const mode=historical?'historical':live?'live':session.players.length?previous?'previous':'unavailable':'idle';
 const label=mode==='historical'?'历史对局':mode==='live'?'当前对局':mode==='previous'?'上一局记录':mode==='unavailable'?'最近对局记录':'当前状态';
 const note=mode==='historical'?'历史快照，仅供回看。':mode==='previous'?`当前状态：${phaseLabel(phase)}。以下保留上一局资料，不代表当前对局。`:mode==='unavailable'?'实时数据暂不可用。以下保留最近一次记录，连接恢复后继续跟踪。':mode==='idle'?`${phaseLabel(phase)}，等待可读取的对局。`:'';
 return {mode,live,label,note,phase,data:mode==='idle'?null:live?hasLive?raw:null:session.liveData};
}

const completeModelContext=(value:Partial<Session>|undefined):value is Session=>!!value&&
 typeof value.id==='string'&&typeof value.matchId==='string'&&typeof value.ownPlayerId==='string'&&typeof value.notes==='string'&&
 Array.isArray(value.candidates)&&value.candidates.every(c=>c&&typeof c.id==='string'&&typeof c.name==='string'&&typeof c.description==='string')&&
 Array.isArray(value.players)&&value.players.every(p=>p&&typeof p.id==='string'&&typeof p.team==='string'&&typeof p.champion==='string'&&Array.isArray(p.augments)&&Array.isArray(p.items));

export function LiveOverview({session,snapshot,auto,autoRecommend=false,autoRecommendStatus,analysisStatus,localRecommendation,detectionMessage,onSync,busy,ready,setupIssue,blockers,onRun,onSettings,onPatch,onResume,historical}:Props){
 const [editing,setEditing]=useState(false);
 const display=liveOverviewState(session,snapshot,historical);
 const liveSession=display.live?{...session,liveData:display.data,updatedAt:snapshot?.observedAt||session.updatedAt}:session;
 const own=session.players.find(p=>p.id===session.ownPlayerId),last=session.decisions.at(-1);
 const hasGame=display.live||!!session.players.length,unknown=!session.players.length||!own||session.players.some(p=>!p.augmentsConfirmed);
 const candidatesComplete=session.candidates.length>=2&&session.candidates.every(candidate=>candidate.name.trim()&&candidate.description.trim());
 const local=display.live?selectLocalRecommendation(liveSession,localRecommendation):null;
 const localPresentation=local?localRankingPresentation(local.result):null;
 const pendingPresentation=local?.result.source==='recognition'?overlayPresentation(local.result,analysisStatus):null;
 const visibleCandidates=session.candidates.filter(candidate=>candidate.name.trim());
 const level=ownLevel(display.data),gameTime=(display.data as {gameData?:{gameTime?:unknown}}|null)?.gameData?.gameTime;
 const observedBand=observedChoiceBand(session,display.data,snapshot?.observedAt);
 const previousCandidateBand=display.live&&session.candidateBand!==undefined&&session.candidateBand!==observedBand;
 const duration=typeof gameTime==='number'&&Number.isFinite(gameTime)&&gameTime>=0?`${Math.floor(gameTime/60)}:${String(Math.floor(gameTime%60)).padStart(2,'0')}`:'—';
 const observedAt=historical?session.updatedAt:snapshot?.observedAt;
 const syncTime=observedAt&&Number.isFinite(Date.parse(observedAt))?new Date(observedAt).toLocaleTimeString():'等待同步';
 const rarity:Record<string,string>={silver:'白银',gold:'黄金',prismatic:'棱彩'};
 const confirmedChoice=localChoiceState(liveSession).choice;
 const modelContext=last?.context as Partial<Session>|undefined;
 const modelIsCurrent=display.live&&!!last&&local?.result.source==='model'&&local.at===last.at&&last.result.engine?.scoringMode==='dynamic-model-v1'&&completeModelContext(modelContext)&&canPublishModelRecommendation(modelContext,liveSession);
 const modelPresentation=last&&completeModelContext(modelContext)?localRankingPresentation(modelRecommendation(modelContext,last.result)):null;
 const modelCandidates=Array.isArray(modelContext?.candidates)?modelContext.candidates:[];
 const choiceIsCurrent=display.live&&!!last&&isCurrentChoiceDecision(liveSession,last)&&modelCandidates.length===session.candidates.length&&session.candidates.every(candidate=>modelCandidates.some(other=>other.id===candidate.id&&other.name===candidate.name&&other.description===candidate.description));
 const linkedChoiceId=choiceIsCurrent&&confirmedChoice&&modelCandidates.some(candidate=>candidate.id===confirmedChoice.id&&candidate.name===confirmedChoice.name)?confirmedChoice.id:undefined;
 const displayedChoiceId=last?.chosenId||linkedChoiceId;

 useEffect(()=>{if(!display.live)setEditing(false);else if(hasGame&&!last&&!candidatesComplete)setEditing(true);},[display.live,hasGame,last?.at,candidatesComplete]);

 return <div className="live-simple">
  <section className="match-strip">
   <div className="hero-avatar">{own?.champion.slice(0,2)||'◇'}</div>
   <div><span className="quiet-label">{display.label}</span><h1>{own?.champion||(display.live?'英雄信息待同步':'等待进入对局')}</h1><p>{display.live?phaseLabel(display.phase):display.note}</p></div>
   {historical&&<button onClick={onResume}>返回实时对局</button>}
   {session.players.length>0&&<details className="lineup" open={historical}><summary>双方阵容</summary>{['ORDER','CHAOS'].map(t=>{const roster=session.players.filter(p=>p.team===t),known=roster.filter(p=>p.augments.length);return <p key={t}><b>{own&&['ORDER','CHAOS'].includes(own.team)?t===own.team?'我方':'敌方':t==='ORDER'?'蓝方':'红方'}</b> {roster.map(p=>p.champion||'英雄待同步').join(' · ')||'待同步'}{known.length>0&&<small className="lineup-aug">{known.map(p=>`${p.champion||'英雄待同步'}：${p.augments.join('、')}`).join('；')}</small>}</p>;})}</details>}
  </section>

  <section className="live-status-panel" aria-label={display.live?'实时对局状态':historical?'历史对局状态':'对局记录状态'}>
   <div className="live-status-heading"><h2>{historical?'档案状态':display.live?'实时状态':hasGame?'记录状态':'连接状态'}</h2><span>{historical?'历史快照':!auto?'自动跟踪已暂停':display.live?'自动跟踪中':display.mode==='unavailable'?'等待实时数据':'自动等待对局'}</span>{!historical&&<button disabled={busy} onClick={onSync}>立即同步</button>}</div>
   <div className="live-status-grid">
    <div><span>{display.live?'当前等级':'记录等级'}</span><strong>{level===null?'—':`Lv.${level}`}</strong></div>
    <div><span>{display.live?'对局时间':'记录时长'}</span><strong>{duration}</strong></div>
    <div><span>客户端连接</span><strong>{historical?'历史记录':snapshot?.connection||'自动发现中'}</strong></div>
    <div><span>{historical?'档案更新':display.live?'最近同步':'最近检查'}</span><strong>{syncTime}</strong></div>
   </div>
   <div className="live-observations"><p>{display.live?'本人已选海克斯：':'已记录的本人海克斯：'}{own?.augments.filter(name=>name.trim()).join('、')||(own?.augmentsConfirmed?'已核实，暂无':'尚未识别')}</p>{display.live&&<p>{busy?'正在分析，实时对局采集与候选识别继续，不会并发发起自动模型请求。':detectionMessage}{local&&(local.result.source==='model'?'；保留本轮模型分析快照。':autoRecommend?'；保留本轮已识别候选，自动推荐按当前状态处理。':'；保留本轮已识别候选，可手动分析或在设置中开启自动推荐。')}</p>}</div>
  </section>

  <section className="recommend-panel">
   <div className="recommend-heading"><h2>{display.live||!hasGame?'海克斯推荐':'海克斯记录'}</h2>{localPresentation&&<span className="local-rule-badge">{pendingPresentation?.label||localPresentation.label}</span>}</div>
   {display.live&&<p className="hint" role="status" aria-label="自动推荐状态">{autoRecommend?'自动模型推荐已开启（可能产生费用）':'自动模型推荐未运行，可在设置中检查开关、模型配置和授权'}{autoRecommendStatus?` · ${autoRecommendStatus}`:''}</p>}
   {!hasGame?<div className="calm-empty"><span>✧</span><h3>先去享受游戏</h3><p>检测到对局后，这里会显示你的英雄与海克斯建议。</p><small>无需手动建立对局或保存快照</small></div>:<>
    {local&&localPresentation?<div className="live-local-recommendation" aria-label={local.result.source==='model'?'模型推荐':'已识别候选'}><div className="local-recommend-heading"><strong>{local.result.source==='model'?'本轮模型推荐':'本轮已识别候选'}</strong><small>{augmentRoundLabel(local.band)} · {new Date(local.at).toLocaleTimeString()} 快照</small></div><p className="local-recommend-summary">{localPresentation.summary}</p><div className="local-candidate-grid">{localPresentation.candidates.map(candidate=>{
     const current=session.candidates.find(c=>c.id===candidate.id);
     return <article className={`local-candidate${candidate.rank===1?' top':''}`} key={candidate.id}>
      <div className="local-candidate-meta"><span>{candidate.alreadyOwned?'已拥有 · 不作为新选择':candidate.rank!==null?`${candidate.tied?'并列':''}第${candidate.rank}名`:pendingPresentation?.analysisChip||assessmentLabel(candidate.assessment)}</span>{candidate.displayScore!==null&&<b aria-label={`模型比较分 ${candidate.displayScore}，非胜率`}>{candidate.displayScore}<small> 分</small></b>}</div>
      <h3>{current?.name||candidate.name}</h3><div className="local-candidate-tags">{candidate.rank===1&&<span className="recommend-pill">{candidate.tied?'并列综合推荐':'综合推荐'}</span>}{candidate.rarity&&<span className="local-rarity">{rarity[candidate.rarity]||candidate.rarity}</span>}</div><p className="candidate-reason">{candidate.reason}</p>
      <p className="candidate-effect">{current?.description||candidate.description}</p>
      <details><summary>依据与注意事项</summary>{candidate.evidence.length>0&&<ul aria-label="已知依据">{candidate.evidence.map((item,i)=><li key={i}>{item}</li>)}</ul>}{candidate.risks.length>0?<ul>{candidate.risks.map((risk,i)=><li key={i}>{risk}</li>)}</ul>:<p>{local.result.source==='recognition'?'尚未获得模型结果，风险未评估。':'暂无额外注意事项'}</p>}</details>
     </article>;
    })}</div><p className="local-recommend-footnote">模型比较不代表胜率；识别本身不评分、不调用模型。自动推荐按已保存设置与数据授权触发，手动关闭后会记住。</p></div>:visibleCandidates.length>0&&<div className="live-candidate-preview" aria-label="已记录候选"><div className="local-recommend-heading"><strong>{!display.live?'历史候选记录':previousCandidateBand?'上一轮已记录候选':candidatesComplete?'候选已就绪':'已记录候选'}</strong><small>{display.live?'待模型分析':'只读记录 · 非当前选择'}</small></div><div className="local-candidate-grid">{visibleCandidates.map((candidate,index)=><article className="local-candidate" key={candidate.id}><span className="quiet-label">候选 {index+1}{candidate.source==='manual'?' · 手动补充':''}</span><h3>{candidate.name}</h3><p>{candidate.description||'尚未补充效果。'}</p></article>)}</div><p className="local-recommend-footnote">{!display.live?'显示最近记录的候选，不代表当前仍在选择。':previousCandidateBand?observedBand===null?'轮次信息待同步，保留候选但暂不发起分析。':`等待${augmentRoundLabel(observedBand)}的新候选；上一轮记录不用于本轮分析。`:session.candidates.some(c=>c.source==='manual')?'手动候选已保留；点击模型分析后按当前效果比较。':'显示已记录的候选；游戏位于前台时会继续自动识别。'}</p></div>}
    {display.live&&!previousCandidateBand&&candidatesComplete&&<LocalChoiceControls key={localRecommendationKey(liveSession)} session={liveSession} busy={busy} onPatch={onPatch}/>}
    {last?<details className="model-analysis-section" open={!modelIsCurrent}>
     <summary className="model-recommend-heading"><h3>{modelIsCurrent?'本轮分析明细':'上次模型分析'}</h3><small>{new Date(last.at).toLocaleTimeString()} · {modelIsCurrent?'本轮分析快照':'历史分析快照，仅供查看'}</small></summary>
     <div className="simple-ranking">{last.result.ranking.map((r,i)=>{
      const c=modelCandidates.find(c=>c.id===r.candidateId);
      const confirmed=displayedChoiceId===r.candidateId;
      const comparison=modelIsCurrent?modelPresentation?.candidates.find(candidate=>candidate.id===r.candidateId):undefined;
      const recommended=comparison?.rank===1&&!r.alreadyOwned;
      return <div className={`choice-slot${recommended?' recommended':''}`} key={r.candidateId}>
       <article className={`hex-choice${confirmed?' selected':''}`}>
        <div className="choice-meta"><span className="quiet-label">{r.alreadyOwned?'已拥有 · 不作为新选择':comparison?.rank?`模型比较 · ${comparison.tied?'并列':''}第${comparison.rank}名`:`比较方案 ${i+1}`}</span>{confirmed&&<span className="chosen-pill">{choiceIsCurrent?'本轮已确认':'历史已确认'}</span>}{recommended&&<span className="recommend-pill">{comparison?.tied?'并列综合推荐':'综合推荐'}</span>}</div>
        <h3>{c?.name||r.candidateId}</h3>
        <p className="choice-reason">{r.reason}</p>
        <div className="choice-details"><h4>海克斯效果</h4><p className="choice-effect">{c?.description||'暂无完整效果说明。'}</p></div>
        <details className="choice-cautions"><summary>注意事项{r.risks.length>0?` · ${r.risks.length}`:''}</summary>{r.risks.length>0?<ul>{r.risks.map((s,j)=><li key={j}>{s}</li>)}</ul>:<p>暂无额外注意事项</p>}</details>
       </article>
      </div>;
     })}</div>
     {displayedChoiceId?<div className="choice-locked-note">✓ {choiceIsCurrent?'本轮选择已确认并锁定。':'此分析的历史选择已记录，不能在这里更换。'}</div>:modelIsCurrent&&<p className="hint">在上方本轮候选区确认实际选择，这里的模型分析会同步显示记录。</p>}
     <details className="recommend-notes"><summary>查看分析说明与信息缺失</summary><p>{last.result.summary}</p>{last.result.missingInformation.map((s,i)=><p key={i}>{s}</p>)}<p>分数与排序不是胜率；这是上次分析时的建议，修改候选或局势后需要重新分析。</p></details>
    </details>:!local&&visibleCandidates.length===0&&<div className="calm-empty"><span>◇</span><h3>{display.live?busy?'正在比较你的候选…':'等待本轮海克斯候选':'本局未记录候选'}</h3><p>{display.live?'游戏位于前台且出现候选面板时自动识别，也可在下方补充候选。':'已有阵容与海克斯资料保留在本局记录中。'}</p></div>}
    {display.live&&<div className="next-action"><span>{!ready?setupIssue:busy?'正在分析，请稍候':blockers.length?blockers[0]:unknown?'模型将基于已知信息分析，未识别的海克斯不会当作没有。':'候选与模型均已就绪'}</span><button onClick={()=>setEditing(v=>!v)}>{editing?'收起候选':'补充 / 修改候选'}</button>{!ready?<button className="accent" onClick={onSettings}>配置模型分析</button>:<button className="accent" disabled={busy||blockers.length>0||previousCandidateBand} onClick={onRun}>{last?'重新分析':'获取模型分析'}</button>}</div>}
    {display.live&&editing&&<div className="candidate-entry"><p className="hint">仅需补充本轮候选，不要求逐一填写双方所有玩家。请填写真实效果，缺失信息不会自动编造。</p><div className="candidates">{session.candidates.map((c,i)=><div className="candidate" key={c.id}><label>候选 {i+1}<input disabled={busy} value={c.name} placeholder="海克斯名称" onChange={e=>onPatch({candidates:session.candidates.map(x=>x.id===c.id?{...x,name:e.target.value}:x)})}/></label><textarea disabled={busy} value={c.description} aria-label={`候选${i+1}完整效果`} placeholder="效果与数值" onChange={e=>onPatch({candidates:session.candidates.map(x=>x.id===c.id?{...x,description:e.target.value}:x)})}/></div>)}</div></div>}
   </>}
   {display.live&&editing&&session.candidates.some(c=>c.source==='manual')&&<div className="next-action"><span>本轮手动纠正会保留；重新识别将读取当前画面。</span><button disabled={busy} onClick={()=>onPatch({candidates:session.candidates.map(c=>({...c,source:undefined}))})}>重新识别候选</button></div>}
  </section>
 </div>;
}
