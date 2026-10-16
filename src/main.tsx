import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {getVersion} from '@tauri-apps/api/app';
import {listen} from '@tauri-apps/api/event';
import {check} from '@tauri-apps/plugin-updater';
import {applySnapshot,blockers,hasContent,newSession,phaseLabel,resultLabel,type Session,type CollectorSnapshot,type Recommendation,type Review} from './core/domain';
import './styles/style.css';
import './styles/comfort.css';
import {Select} from './ui/Select';
import {LiveOverview} from './live/LiveOverview';
import {liveOverviewState} from './core/liveState';
import {analysisSource} from './recommendation/analysisGate';
import {RequestInterval} from './recommendation/requestInterval';
import {collectorPollDelay} from './collection/collectorCadence';
import {currentChoiceBand} from './core/choiceContext';
import {liveDetectionBand} from './collection/detectionGate';
import {createLocalRecommendation,localRecommendationKey,recognizedCandidates,modelRecommendation,selectLocalRecommendation,restoreModelRecommendation,type LocalRecommendation,type ScoredCandidate} from './recommendation/liveRecommendation';
import {canPublishModelRecommendation,canRetainModelRecommendation,modelContextKey} from './recommendation/modelPublication';
import {canRecoverPostgame,mergePostgameEvidence,hasMissingPostgameEvidence,PostgameRetryQueue} from './persistence/postgameRecovery';
import './live/live.css';
import {SaveQueue} from './persistence/saveQueue';
import {AnalysisTarget} from './recommendation/analysis';
import {markCandidateEdits,mergeDetectedCandidates} from './core/candidates';
import {readSession,readSessionPage} from './persistence/sessionReader';
import './knowledge/knowledge.css';
import './styles/polish.css';
import {KnowledgePanel} from './knowledge/KnowledgePanel';
import {OverlayApp} from './overlay/OverlayApp';
import {synchronizeSelections} from './core/domain';
import {RankingItemView,EngineBadge} from './ui/Ranking';
import {DEFAULT_JEV_MODEL,DEFAULT_JEV_URL,SettingsPanel} from './settings/SettingsPanel';
import {modelDestination,modelServiceLabel} from './settings/modelConsent';
import {AUTO_MAX_PER_ROUND,AutoRecommendationGate,autoRecommendationKey} from './recommendation/autoRecommendation';
import {OcrCadence} from './collection/ocrCadence';
import {canAnalyzeObservedChoice,hasFreshOcrSnapshot} from './collection/ocrContextFreshness';
import {CandidateScanBurst,CANDIDATE_RECHECK_MS} from './collection/candidateScanBurst';
import {RecommendationProgress,recommendationProgressKey} from './recommendation/recommendationProgress';
import type {RecommendationStatus} from './recommendation/recommendationStatus';
import {analysisDataIssue,analysisFailure} from './core/analysisPreflight';
import {AUTO_RECOMMEND_PREFERENCE_KEY,readAutoRecommendPreference,autoModelIdentity,automaticModelIssue} from './settings/autoModelConfig';
import {ModelCredentials} from './settings/modelCredentials';
import {KnowledgeWarmup, type KnowledgeWarmupResult} from './knowledge/knowledgeWarmup';
type KnowledgeResult={documents:{path:string;title:string;content:string;hash:string;sections?:string[]}[];missing:string[];warnings:string[];fingerprint:string};
type StorageStats={databaseBytes:number;sessionCount:number;sampleCount:number;budgetMb:number;retentionDays:number;budgetReached?:boolean;unreadableSessions?:number};
type ModelConfig={provider?:'jev'|'openai';baseUrl:string;name:string;jsonMode?:boolean;maxTokens?:number;allowThirdParty?:boolean};
type Diagnostics={entries:{at:string;level:string;event:string;message:string}[];logDirectory:string;dataDirectory:string};
type OcrBucket={scans:number;hits:number;names:number};
type OcrStats={scans:number;hits:number;names:number;lastAt?:string|null;sources?:Record<string,OcrBucket>;byDay?:Record<string,OcrBucket>;panelProbes?:{checks:number;likely:number;uncertain:number;unlikely:number;ocr:number;complete:number;cache:number;sinceAt?:string|null}};
type UpdateInfo={version:string;date?:string;body?:string};
type HistoryEntry={id?:string;createdAt?:string;updatedAt?:string;ownChampion?:string;ownAugments?:string[];chosen?:string;result?:Session['result'];outcome?:string;review?:Review;similarity?:number;matched?:string[];sameChampion?:boolean};
export type OcrLine={text:string;score:number;x:number;y:number;width:number;height:number};
export type OcrScan={lines:OcrLine[];candidates:ScoredCandidate[];elapsedMs:number;source:string;model:string;skipped?:boolean;probeOnly?:boolean;probeNext?:boolean;waitingForReady?:boolean;unchangedPanel?:boolean;watchCandidateIds?:string[];panelState?:string;reason?:string;message?:string};
const augmentNote=(s:Session)=>{const count=s.players.reduce((n,p)=>n+p.augments.length,0);return count?` · ${count} 条海克斯`:'';};
const USAGE_KEY='hexlens-analysis-usage';
function localDay(){const d=new Date();const p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function readUsage(){const date=localDay();try{const v=JSON.parse(localStorage.getItem(USAGE_KEY)||'null');if(v&&v.date===date&&Number.isFinite(v.count))return{date,count:Math.max(0,Math.floor(v.count))};}catch{}return{date,count:0};}
function bumpUsage(){const u=readUsage();const n=u.count+1;localStorage.setItem(USAGE_KEY,JSON.stringify({date:u.date,count:n}));return n;}
function App(){
 const [session,setSession]=useState<Session>(newSession), [history,setHistory]=useState<Session[]>([]),[archivePage,setArchivePage]=useState(0),[archiveDetail,setArchiveDetail]=useState<Session|null>(null);const archiveOffset=useRef(0);
 const archiveDetailRef=useRef(archiveDetail);archiveDetailRef.current=archiveDetail;
 const [archiveHasNext,setArchiveHasNext]=useState(false);const historyRequest=useRef(0);
 const postgameRetries=useRef(new PostgameRetryQueue()),recoveringPostgame=useRef(false);
 const current=useRef(session); const activeSession=useRef<Session|null>(null),analysisTarget=useRef<AnalysisTarget|null>(null); const commit=(s:Session)=>{s=synchronizeSelections(s);analysisTarget.current?.observe(s);postgameRetries.current.observe(s);current.current=s;setSession(s);};
 const [model,setModelState]=useState<ModelConfig>(()=>{const fallback:ModelConfig={provider:'jev',baseUrl:DEFAULT_JEV_URL,name:DEFAULT_JEV_MODEL};try{const stored=JSON.parse(localStorage.getItem('hexlens-model')||'null');return stored&&typeof stored.baseUrl==='string'&&typeof stored.name==='string'?stored:fallback;}catch{return fallback;}});
 const [knowledge,setKnowledge]=useState<KnowledgeResult|null>(null);
 const knowledgeRevision=useRef(0);
 const knowledgeWarmup=useRef(new KnowledgeWarmup(async()=>{
  const prepared=await Promise.allSettled(['knowledge_warmup','ocr_warmup','overlay_prepare'].map(command=>invoke<KnowledgeWarmupResult>(command)));
  return {status:prepared.some(result=>result.status==='rejected')?'failed':prepared.every(result=>result.status==='fulfilled'&&result.value.status==='ready')?'ready':'busy'};
 }));
 const knowledgeLeaveGuard=useRef<(()=>boolean)|null>(null);
 const [approvedDestination,setApprovedDestination]=useState(()=>localStorage.getItem('hexglow-model-consent')||'');
 const [automaticEnabled,setAutomaticEnabled]=useState(()=>readAutoRecommendPreference(localStorage.getItem(AUTO_RECOMMEND_PREFERENCE_KEY),localStorage.getItem('hexglow-auto-recommend-consent')));
 useEffect(()=>{localStorage.setItem(AUTO_RECOMMEND_PREFERENCE_KEY,String(automaticEnabled));},[automaticEnabled]);
 const [autoRecommendStatus,setAutoRecommendStatus]=useState('等待本轮完整候选稳定识别。');
 const modelRevision=useRef(0),autoRecommendationGate=useRef(new AutoRecommendationGate());
 const lastAutoScan=useRef<{key:string;at:number}|null>(null);
 const recommendationProgress=useRef(new RecommendationProgress());
 const confirmationScan=useRef<{key:string;at:number;cooldown:boolean;timer:ReturnType<typeof setTimeout>}|null>(null);
 const candidateScanBurst=useRef(new CandidateScanBurst());
 const ocrCadence=useRef(new OcrCadence());
 const openingOcrArmed=useRef('');
 const detectAugmentsRef=useRef<(session:Session)=>void>(()=>{});
 const confirmScanRef=useRef(()=>{});
 const exitPending=useRef<number|null>(null),lastExitRequest=useRef(0);
 const consent=!!modelDestination(model)&&approvedDestination===modelDestination(model);
 const autoRecommend=consent&&automaticEnabled&&!!autoModelIdentity(model);
 const setAutoRecommend=(enabled:boolean)=>{modelRevision.current++;analysisSettings.current={...analysisSettings.current,autoRecommend:enabled&&analysisSettings.current.consent&&!!autoModelIdentity(analysisSettings.current.model),revision:modelRevision.current};autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;setAutomaticEnabled(enabled);localStorage.setItem(AUTO_RECOMMEND_PREFERENCE_KEY,String(enabled));setAutoRecommendStatus(enabled?'自动推荐偏好已保存，配置与授权有效后等待完整候选稳定识别。':'已关闭并保存，不再发起自动请求；在途请求可能已计费。');};
 const setConsent=(approved:boolean)=>{const destination=approved?modelDestination(analysisSettings.current.model):'';modelRevision.current++;analysisSettings.current={...analysisSettings.current,consent:!!destination,autoRecommend:!!destination&&automaticEnabled&&!!autoModelIdentity(analysisSettings.current.model),revision:modelRevision.current};autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;setApprovedDestination(destination);localStorage.setItem('hexglow-model-consent',destination);};
 const setModel=(next:ModelConfig)=>{modelRevision.current++;analysisSettings.current={...analysisSettings.current,model:next,autoRecommend:automaticEnabled&&analysisSettings.current.consent&&!!autoModelIdentity(next),revision:modelRevision.current};autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;if(modelDestination(next)!==modelDestination(model)){setConsent(false);applyApiKey('');if(isTauri())modelKeys.current?.select(modelDestination(next));setModels([]);setModelStatus('');}setModelState(next);};
 const [apiKey,setApiKeyState]=useState(''),[modelStatus,setModelStatus]=useState(''),[models,setModels]=useState<string[]>([]),[keyStatus,setKeyStatus]=useState('');
 const applyApiKey=(value:string)=>{modelRevision.current++;analysisSettings.current={...analysisSettings.current,apiKey:value,revision:modelRevision.current};autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;setApiKeyState(value);};
 const applyApiKeyRef=useRef(applyApiKey);applyApiKeyRef.current=applyApiKey;
 const modelKeys=useRef<ModelCredentials|null>(null);
 if(!modelKeys.current)modelKeys.current=new ModelCredentials({load:destination=>invoke<string|null>('model_key_load',{destination}),save:(destination,value)=>invoke<void>('model_key_save',{destination,apiKey:value})},value=>applyApiKeyRef.current(value),setKeyStatus);
 const setApiKey=(value:string)=>{applyApiKey(value);if(isTauri())modelKeys.current?.change(value);};
 const credentialDestination=modelDestination(model);
 useEffect(()=>{if(isTauri())modelKeys.current?.select(credentialDestination);},[credentialDestination]);
 const [storage,setStorage]=useState<StorageStats|null>(null),[budget,setBudget]=useState(128),[days,setDays]=useState(7);
 const [confirmation,setConfirmation]=useState<{title:string;detail:string;action:()=>Promise<void>}|null>(null);
 const debounce=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [lockfile,setLockfile]=useState(()=>localStorage.getItem('hexlens-lockfile')||'');
 const [auto,setAutoState]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[view,setView]=useState('live'),[advancedOpen,setAdvancedOpen]=useState(false);
 const setAuto=(enabled:boolean)=>{config.current.auto=enabled;autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;setAutoState(enabled);};
 const [snapshot,setSnapshot]=useState<CollectorSnapshot|null>(null),[diag,setDiag]=useState<Diagnostics|null>(null),[saved,setSaved]=useState('尚未保存');
 const snapshotRef=useRef(snapshot);snapshotRef.current=snapshot;
 const snapshotPollStartedAt=useRef(0);
 const [localRecommendation,setLocalRecommendation]=useState<LocalRecommendation|null>(null),[detection,setDetection]=useState<{sessionId:string;message:string}|null>(null);
 const localRecommendationRef=useRef(localRecommendation);localRecommendationRef.current=localRecommendation;
 const [flash,setFlash]=useState(''),[dailyUsed,setDailyUsed]=useState(()=>readUsage().count);const requestInterval=useRef(new RequestInterval());
 const [ocr,setOcr]=useState<OcrStats|null>(null);
 const loadOcr=()=>{invoke<OcrStats>('ocr_stats').then(setOcr).catch(()=>setOcr(null));};
 const [updateInfo,setUpdateInfo]=useState<UpdateInfo|null|undefined>(undefined),[updateErr,setUpdateErr]=useState(''),[updateBusy,setUpdateBusy]=useState<'idle'|'check'|'install'>('idle'),[updateProg,setUpdateProg]=useState<number|null>(null),[appVersion,setAppVersion]=useState('');
 const analysisSettings=useRef({model,apiKey,consent,autoRecommend,revision:modelRevision.current,updating:updateBusy==='install'});
 analysisSettings.current={model,apiKey,consent,autoRecommend,revision:modelRevision.current,updating:updateBusy==='install'};
 const runRef=useRef(run);runRef.current=run;
 const maybeAutoRecommendRef=useRef(maybeAutoRecommend);maybeAutoRecommendRef.current=maybeAutoRecommend;
 useEffect(()=>{if(isTauri())void getVersion().then(v=>setAppVersion(v)).catch(()=>{});},[]);
 const [similar,setSimilar]=useState<HistoryEntry[]>([]);
 const [historical,setHistorical]=useState(false);
 useEffect(()=>{if(!flash)return;const t=setTimeout(()=>setFlash(''),9000);return()=>clearTimeout(t);},[flash]);const reading=useRef(false),readingSince=useRef(0),pollSeq=useRef(0),epoch=useRef(0),lastSaved=useRef(0),busyRef=useRef(false),collectionPaused=useRef(false);const writeQueue=useRef<Promise<unknown>>(Promise.resolve());const saver=useRef(new SaveQueue<Session>(writeSnapshot));
 const config=useRef({lockfile,auto,historical,view});config.current={lockfile,auto,historical,view};const nextPoll=useRef(0),idleFailures=useRef(0);
  // OCR 本身不调用模型。独立授权后仅稳定的新候选可进入有界自动分析。
  const scanning=useRef(false),seenMatch=useRef(''),seenIds=useRef(''),candidateRevision=useRef(0),panelMisses=useRef(0);
  const unconfirmedOverlay=useRef<{key:string;previous?:RecommendationStatus}|null>(null);
  const detectAugments=(session:Session)=>{
   if(!isTauri()||scanning.current||(busyRef.current&&!analysisTarget.current)||config.current.historical||collectionPaused.current||!hasFreshOcrSnapshot(snapshotRef.current,Date.now()))return;
   const band=liveDetectionBand(session,snapshotRef.current,config.current.historical);
   if(band===null)return;
   const scanStartedAt=Date.now();
   const scanTicket=ocrCadence.current.begin(JSON.stringify([session.id,session.matchId,band]),scanStartedAt);
   if(!scanTicket)return;
   let scanTiming={matched:0,skipped:true,elapsedMs:0,probeOnly:false,probeNext:false,waitingForReady:false};
   const ticket=epoch.current;
   const revision=candidateRevision.current;
   const valid=()=>ticket===epoch.current&&revision===candidateRevision.current&&current.current.id===session.id&&!collectionPaused.current&&(!busyRef.current||!!analysisTarget.current)&&hasFreshOcrSnapshot(snapshotRef.current,Date.now())&&liveDetectionBand(current.current,snapshotRef.current,config.current.historical)===band;
   scanning.current=true;
   void (async()=>{
    try{
     if(seenMatch.current!==session.id){seenMatch.current=session.id;seenIds.current='';await invoke('overlay_close');}
     const blocked=autoRecommendationGate.current.blockReason(session);
     const watchCandidateIds=!busyRef.current&&['saved','attempted','round-limit'].includes(blocked||'')&&autoRecommendationKey(session)?session.candidates.map(candidate=>candidate.id):null;
     const scan=await invoke<OcrScan>('ocr_scan',{roundKey:JSON.stringify([session.id,session.matchId,band]),watchCandidateIds});
     scanTiming={matched:scan.probeOnly||scan.waitingForReady?0:scan.candidates?.length||0,skipped:scan.skipped===true,probeOnly:scan.probeOnly===true,probeNext:scan.probeNext===true,waitingForReady:scan.waitingForReady===true,elapsedMs:Math.max(Number.isFinite(scan.elapsedMs)?scan.elapsedMs:0,Date.now()-scanStartedAt)};
     if(!valid())return;
     if(scan.unchangedPanel===true&&scan.probeOnly===true&&scan.source==='capture'&&!scan.skipped&&!scan.waitingForReady&&
       watchCandidateIds&&scan.watchCandidateIds?.length===3&&new Set(scan.watchCandidateIds).size===3&&scan.watchCandidateIds.every(id=>watchCandidateIds.includes(id))){
      // A pacing hint is not absence and not an OCR observation. Keep visible
      // saved results, but discard authorization for any newly requested work.
      cancelConfirmationScan();candidateScanBurst.current.reset();autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;
      return;
     }
     const detectionMessage=scan.waitingForReady?'OCR 正在预热，就绪后继续本轮识别。':scan.skipped?scan.message||'等待游戏回到前台识别':scan.reason==='choice-region-unavailable'?'等待定位海克斯卡片区域；不识别周围游戏文字。':scan.probeOnly?'正在轻量探测选择面板，尚未运行完整 OCR':scan.candidates.length>=2?'已识别本轮候选':'未识别到完整候选，等待游戏中的选择面板';
     setDetection(previous=>previous?.sessionId===session.id&&previous.message===detectionMessage?previous:{sessionId:session.id,message:detectionMessage});
     const matched=(scan.probeOnly||scan.waitingForReady?[]:scan.candidates??[]).slice(0,3);
     if(scan.source==='capture'&&scan.probeOnly===true&&!scan.skipped&&!scan.waitingForReady&&scan.reason==='choice-region-unavailable'){
      // Unknown geometry is NOT evidence the panel disappeared. Revoke fresh
      // analysis evidence, but do not close/reopen or republish the old ranking.
      cancelConfirmationScan();candidateScanBurst.current.reset();autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;
      const choiceKey=recommendationProgressKey(current.current);
      if(unconfirmedOverlay.current?.key!==choiceKey)unconfirmedOverlay.current={key:choiceKey,previous:recommendationProgress.current.get(current.current)};
      const sent=busyRef.current&&analysisTarget.current&&recommendationProgress.current.get(analysisTarget.current.snapshot)?.phase==='analyzing';
      const status:RecommendationStatus={phase:sent?'analyzing':'waiting',code:'choice-region-unavailable',message:sent?'模型请求已发出；区域复核中，尚未确认当前候选。':'正在复核海克斯区域；此前结果尚未确认适用于当前画面。'};
      if(recommendationProgress.current.failure(current.current)){
       // Keep the actual model failure in the main-window progress history.
       // The sidebar can independently withhold unconfirmed previous scores.
       void invoke('overlay_analysis_status',{payload:{sessionId:current.current.id,level:band,candidates:current.current.candidates,analysis:status}}).catch(()=>{});
      }else reportRecommendation(current.current,status);
      return;
     }
     if(scan.skipped||matched.length<2){
      cancelConfirmationScan();autoRecommendationGate.current.resetObservation();
      if(scan.skipped||scan.waitingForReady)candidateScanBurst.current.reset();else panelMisses.current++;
      // A single blank frame may be an animation. It never authorizes a new
      // request, but need not discard an already requested, sub-two-second result.
      const last=lastAutoScan.current;
      const receiving=!scan.skipped&&!scan.probeOnly&&!scan.waitingForReady&&panelMisses.current===1&&busyRef.current&&recommendationProgress.current.get(current.current)?.phase==='analyzing'&&last?.key===autoRecommendationKey(current.current)&&Date.now()-last.at>=0&&Date.now()-last.at<=2000;
      if(!receiving)lastAutoScan.current=null;
      if(!busyRef.current&&!autoRecommendationGate.current.blockReason(current.current))reportRecommendation(current.current,{phase:scan.reason==='ocr-initialization-failed'?'blocked':'waiting',code:scan.waitingForReady?'ocr-warming-up':scan.reason==='ocr-initialization-failed'?'ocr-initialization-failed':scan.skipped?'capture-unavailable':scan.probeOnly?'waiting-panel':'incomplete-ocr',message:scan.waitingForReady?'OCR 正在预热，就绪后继续本轮识别；尚未调用模型。':scan.reason==='ocr-initialization-failed'?scan.message||'OCR 初始化失败，请查看诊断。':scan.skipped?'游戏回到前台后继续识别。':scan.probeOnly?'正在轻量探测选择面板；尚未运行完整 OCR 或调用模型。':'候选暂未读全，正在复核；尚未调用模型。'});
      if(!scan.skipped&&!scan.waitingForReady){
       scheduleConfirmationScan(current.current);
       if(panelMisses.current>=2&&seenIds.current){await invoke('overlay_close');seenIds.current='';}
      }
      return;
     }
     panelMisses.current=0;
     if(scan.source==='capture'&&unconfirmedOverlay.current){
      const uncertain=unconfirmedOverlay.current;unconfirmedOverlay.current=null;
      const sameCards=band===current.current.candidateBand&&matched.length===current.current.candidates.length&&matched.every(card=>current.current.candidates.some(candidate=>candidate.id===card.id&&candidate.name===card.name&&candidate.description===card.description));
      if(sameCards&&uncertain.key===recommendationProgressKey(current.current)){
       const latest=recommendationProgress.current.get(current.current);
       const restored=recommendationProgress.current.failure(current.current)||(latest?.code!=='choice-region-unavailable'?latest:undefined)||uncertain.previous||{phase:'waiting' as const,code:'confirming-ocr',message:'候选已识别，正在复核；尚未调用模型。'};
       // Fresh matching OCR clears the presentation timer, not model observations,
       // quotas or failures. Do not reopen a folded/closed window for the old group.
       if(recommendationProgress.current.failure(current.current))void invoke('overlay_analysis_status',{payload:{sessionId:current.current.id,level:band,candidates:current.current.candidates,analysis:restored}}).catch(()=>{});
       else reportRecommendation(current.current,restored);
      }
     }
     const own=current.current.players.find(p=>p.id===current.current.ownPlayerId);
     const key=JSON.stringify([band,own?.champion,own?.augments,own?.items,matched.map(c=>[c.id,c.name,c.description]).sort((a,b)=>a[0].localeCompare(b[0]))]);
     if(key===seenIds.current){
      // A slow response may have been saved while OCR was stale. A fresh same-group
      // observation restores that saved score without sending another request.
      if(localRecommendationRef.current?.result.source!=='model'){
       const restored=restoreDurableRecommendation(current.current);
       if(restored){setLocalRecommendation(restored);await invoke('overlay_publish',{payload:{level:band,sessionId:session.id,ranking:restored.result,analysis:recommendationProgress.current.get(current.current)}});}
      }
      if(valid())maybeAutoRecommendRef.current(current.current,scan);return;
     }
     const candidates=mergeDetectedCandidates(current.current,matched.map(c=>({id:c.id,name:c.name,description:c.description})),band);
     if(!candidates){autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;seenIds.current=key;return;}
     const scoringContext={...current.current,candidates,candidateBand:band};
     const cached=selectLocalRecommendation(scoringContext,localRecommendationRef.current)||restoreDurableRecommendation(scoringContext);
     const ranking=cached?.result.source==='model'?cached.result:recognizedCandidates(scoringContext);
     const shouldOpen=!seenIds.current||recommendationProgressKey(current.current)!==recommendationProgressKey(scoringContext);
     if(!valid()||localRecommendationKey({...current.current,candidates,candidateBand:band})!==localRecommendationKey(scoringContext))return;
     patch({candidates,candidateBand:band},'ocr');
     // 未发起模型分析时只展示候选，不生成本地契合分。
     setLocalRecommendation(cached?.result.source==='model'?cached:createLocalRecommendation(scoringContext,ranking));
     // 先缓存完整状态，前端监听就绪后可主动取回，首轮不依赖事件恰好到达。
      await invoke('overlay_publish',{payload:{level:band,sessionId:session.id,scan,ranking,analysis:recommendationProgress.current.get(scoringContext)}});
     if(!valid())return;
     if(shouldOpen)await invoke('overlay_open',{level:band});
     if(!valid())return;
     seenIds.current=key;
     maybeAutoRecommendRef.current(current.current,scan);
    }catch(error){if(valid()){cancelConfirmationScan();candidateScanBurst.current.reset();autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;const sent=analysisTarget.current&&recommendationProgress.current.get(analysisTarget.current.snapshot)?.phase==='analyzing';reportRecommendation(current.current,{phase:'blocked',code:'capture-error',message:sent?'识别暂不可用，已发出的分析不会重复请求。':'识别暂不可用，等待下次扫描；尚未调用模型。'});setError(String(error));}}
    finally{ocrCadence.current.complete(scanTicket,scanTiming,Date.now());scanning.current=false;}
   })();
  };
 detectAugmentsRef.current=detectAugments;
 confirmScanRef.current=confirmCandidateScan;
 useEffect(()=>()=>cancelConfirmationScan(),[]);
 const localScoreKey=JSON.stringify([session.id,session.phase,liveDetectionBand(session,snapshot,historical),modelContextKey(session)]);
 useEffect(()=>{
  // 恢复或上下文变更后只更新候选展示，不自动请求模型，也不沿用旧分数。
  if(!isTauri())return;
  if(historical||liveDetectionBand(session,snapshotRef.current,historical)!==session.candidateBand||session.candidates.length<2||session.candidates.some(c=>!c.name.trim()||!c.description.trim())){
   setLocalRecommendation(null);
   void invoke('overlay_close').catch(e=>setError(String(e)));
   return;
  }
  const retained=selectLocalRecommendation(session,localRecommendationRef.current)||restoreDurableRecommendation(session);
  if(retained){
   if(retained!==localRecommendationRef.current){setLocalRecommendation(retained);void invoke('overlay_publish',{payload:{level:retained.band,sessionId:session.id,ranking:retained.result}}).catch(e=>setError(String(e)));}
   return;
  }
  let active=true;
  const result=recognizedCandidates(session);
  setLocalRecommendation(createLocalRecommendation(session,result));
  // 只更新缓存，不重新打开用户关闭的侧栏。
  void invoke('overlay_publish',{payload:{level:session.candidateBand,sessionId:session.id,ranking:result,analysis:recommendationProgress.current.get(session)}}).catch(e=>{if(active)setError(String(e));});
  return()=>{active=false;};
 },[localScoreKey,historical]);
useEffect(()=>{localStorage.setItem('hexlens-model',JSON.stringify(model));},[model]);
 useEffect(()=>{localStorage.setItem('hexlens-lockfile',lockfile);},[lockfile]);
 useEffect(()=>{window.scrollTo(0,0);setAdvancedOpen(false);setArchiveDetail(null);},[view]);
 useEffect(()=>{if(view==='archive'&&archiveDetail)window.scrollTo(0,0);},[view,archiveDetail?.id]);
 useEffect(()=>{if(!advancedOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setAdvancedOpen(false);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[advancedOpen]);
 const refreshHistory=async()=>{const request=++historyRequest.current;const raw=await invoke<unknown>('list_sessions_light',{offset:archiveOffset.current*50});if(!Array.isArray(raw))throw new Error('档案列表格式异常，原数据未改写。');const page=readSessionPage(raw);if(request===historyRequest.current){setHistory(page.sessions);setArchiveHasNext(page.hasNext);if(page.invalid)setError(`本页有 ${page.invalid} 条档案结构异常，已隔离显示；原记录仍保留，可导出检查。`);}return page.sessions;};
 const logs=async()=>setDiag(await invoke<Diagnostics>('diagnostics'));
 async function writeSnapshot(value:Session){await invoke('save_session',{session:value});recommendationProgress.current.markSaved(value);}
 async function save(s=current.current){if(!hasContent(s))return;const copy=structuredClone(s);const task=saver.current.enqueue(copy);writeQueue.current=saver.current.idle();await task;setSaved(new Date().toLocaleTimeString());lastSaved.current=Date.now();if(config.current.view==='archive')await refreshHistory();}
 useEffect(()=>{
  if(!isTauri())return;
  let active=true;const stops:(()=>void)[]=[];
  void (async()=>{
   const before=await listen<{requestId:number}>('app:before-exit',event=>{
    const requestId=event.payload.requestId;
    if(!Number.isSafeInteger(requestId)||requestId<=lastExitRequest.current)return;
    lastExitRequest.current=requestId;
    const ownsExit=()=>exitPending.current===requestId;
    void (async()=>{
     if(knowledgeLeaveGuard.current&&!knowledgeLeaveGuard.current()){const message='请先保存知识资料或确认放弃修改，再退出。';setError(message);await invoke('desktop_exit_ready',{requestId,error:message});return;}
     if(busyRef.current){const message='分析或数据操作正在进行，请完成后再退出。';setError(message);await invoke('desktop_exit_ready',{requestId,error:message});return;}
     exitPending.current=requestId;busyRef.current=true;setBusy(true);collectionPaused.current=true;epoch.current++;
     try{
      if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}
      await save();if(!ownsExit())return;
      await saver.current.idle();if(!ownsExit())return;
      await modelKeys.current?.flush();if(!ownsExit())return;
      await invoke('desktop_exit_ready',{requestId,error:null});
     }catch(e){
      // A timed-out request may finish after the user retries or starts another operation.
      if(!ownsExit())return;
      exitPending.current=null;busyRef.current=false;setBusy(false);collectionPaused.current=false;
      setError(`退出前保存失败：${String(e)}`);
      await invoke('desktop_exit_ready',{requestId,error:String(e)});
     }
    })().catch(e=>{if(lastExitRequest.current===requestId&&!busyRef.current)setError(String(e));});
   });
   if(!active){before();return;}stops.push(before);
   const failed=await listen<{requestId:number;message:string}>('app:exit-error',event=>{
    if(exitPending.current!==event.payload.requestId)return;
    exitPending.current=null;busyRef.current=false;setBusy(false);collectionPaused.current=false;
    setError(event.payload.message);
   });
   if(!active){failed();return;}stops.push(failed);await invoke('desktop_ready');
  })().catch(e=>setError(String(e)));
  return()=>{active=false;stops.forEach(stop=>stop());};
 },[]);
 async function poll(){
  if(!isTauri()||collectionPaused.current||config.current.historical)return;
  // 卡死的 invoke 不能让采集永久停摆：超过 30 秒作废上一次任务，重新开始。
  if(reading.current){if(Date.now()-readingSince.current<30000)return;epoch.current++;}
  const pollStartedAt=Date.now();reading.current=true;readingSince.current=pollStartedAt;const ticket=epoch.current;const seq=++pollSeq.current;
  try{
   const snap=await invoke<CollectorSnapshot>('collector_snapshot',{lockfilePath:config.current.lockfile.trim()||null});
   if(ticket!==epoch.current)return;snapshotRef.current=snap;snapshotPollStartedAt.current=pollStartedAt;setSnapshot(snap);
   // Prepare local documents during selection/loading, even before gameId/liveData
   // exist. Never await preheating or make OCR wait for this optional work.
   knowledgeWarmup.current.observe(snap.phase,snap.gameId);
   idleFailures.current=snap.liveData||snap.gameId?0:idleFailures.current+1;
   // Loading/game state is authoritative even while the main window is hidden.
   nextPoll.current=Date.now()+collectorPollDelay(snap,idleFailures.current);
   const previous=current.current;let base=previous;
   if(!snap.liveData&&!snap.gameId&&!previous.players.length&&!['ChampSelect','GameStart','InProgress','Reconnect'].includes(snap.phase)){void recoverPostgame(ticket);return;} // keep loading transitions even before roster/game ID exists
   // Recover this exact identified game after restarting the assistant; never guess by hero/name.
   if(!previous.players.length&&!previous.matchId&&snap.gameId){
    const match=await invoke<unknown>('get_session_by_match',{matchId:String(snap.gameId)});
    if(ticket!==epoch.current)return;
    if(match!==null){try{
     const restored=readSession(match);
     // Persisted loading history is not evidence that this process saw a new
     // opening. Keep later-round boundaries, but do not reopen a mid-game attach.
     base={...restored,ocrOpening:{gameId:restored.matchId,loadingObserved:false,advanced:restored.ocrOpening?.advanced===true}};
    }catch(e){setError(`${String(e)}；继续从实际对局信号跟踪，旧原文仍保留。`);}}
   }
    const applied=applySnapshot(base,snap);
    if(applied.completed){analysisTarget.current?.observe(applied.completed);postgameRetries.current.observe(applied.completed);}
    // 必须先排入旧局最终保存；否则等待窗口关闭期间返回的模型结果可能被旧快照覆盖。
    const completedSave=applied.completed?save(applied.completed):null;
    void completedSave?.catch(()=>{});
    commit(applied.session);
    const detectionBand=liveDetectionBand(applied.session,snap,config.current.historical);
    // An actual API GameStart signal arms the opening once. No elapsed-time
    // fallback, roster requirement or extra level-three check; not engine readiness.
    const readyKey=JSON.stringify([applied.session.id,applied.session.matchId]);
    if(detectionBand===1&&openingOcrArmed.current!==readyKey){
     openingOcrArmed.current=readyKey;ocrCadence.current.reset();
    }
    if(detectionBand===null||previous.id!==applied.session.id||(previous.phase==='InProgress'&&applied.session.phase!=='InProgress')||currentChoiceBand(previous)!==detectionBand){
     seenIds.current='';panelMisses.current=0;
     autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;
     await invoke('overlay_close');
     if(ticket!==epoch.current)return;
    }
    // 补录窗口不能被“窗口隐藏”的退避节奏错过：对局进行中最多 5 秒一次，结束后 60 秒内 3 秒一次。
    if(!applied.session.postGameFilledAt){const sinceEnd=applied.session.endedAt?Date.now()-Date.parse(applied.session.endedAt):Number.POSITIVE_INFINITY;const capture=applied.session.endedAt?sinceEnd<60000:applied.session.players.length>0;if(capture)nextPoll.current=Date.now()+(applied.session.endedAt?3000:Math.min(5000,nextPoll.current-Date.now()));}
    if(detectionBand===null&&snap.phase==='InProgress')setDetection({sessionId:applied.session.id,message:'等待当前局的实际开局或等级接口信号，不按加载时长推测。'});
    if(detectionBand!==null)detectAugments(applied.session);
   if(completedSave)await completedSave;
   if(ticket!==epoch.current||current.current.id!==applied.session.id)return;
    if(hasContent(applied.session)&&(!!applied.completed||Date.now()-lastSaved.current>60000||previous.phase!==applied.session.phase||previous.result?.status!==applied.session.result?.status||previous.postGameFilledAt!==applied.session.postGameFilledAt))await save(current.current);
    void recoverPostgame(ticket);
   // Logs are loaded only when the user opens the diagnostics page.
  }catch(e){if(ticket===epoch.current&&pollSeq.current===seq){idleFailures.current++;nextPoll.current=Date.now()+(idleFailures.current>5?15000:8000);setError(String(e));}}finally{if(pollSeq.current===seq)reading.current=false;}
 }
 async function recoverPostgame(ticket:number){
  // Recovery is read-only at the client API and low priority; never delay active-game OCR.
  if(recoveringPostgame.current||ticket!==epoch.current||collectionPaused.current||busyRef.current||['InProgress','ChampSelect','GameStart','Reconnect'].includes(snapshotRef.current?.phase||''))return;
  const target=postgameRetries.current.take();if(!target)return;
  recoveringPostgame.current=true;
  const latest=async()=>{
   await saver.current.idle();
   if(current.current.id===target.id)return current.current;
   // A detail/held view can predate the final collector save. Old matches must
   // rebase on the persisted record, not a presentation cache.
   return readSession(await invoke<unknown>('get_session',{id:target.id}));
  };
  const valid=()=>ticket===epoch.current&&!collectionPaused.current&&!busyRef.current;
  try{
   const base=await latest();if(!valid()||base.matchId!==target.matchId)return;
   if(!canRecoverPostgame(base)){postgameRetries.current.observe(base);return;}
   // Nonempty confirmed entries are not a completeness signal. The queue owns
   // the finite retry budget; later replies can still add complementary evidence.
   let payload:unknown=null,readFailed=false,readError:unknown;
   try{payload=await invoke<unknown>('postgame_rescan',{session:base,lockfilePath:config.current.lockfile.trim()||null});}
   catch(e){readFailed=true;readError=e;}
   if(!valid())return;
   // Rebase after both the request and any save wait. Never publish completion
   // before durability, and never replace edits/polls made during that wait.
   for(let pass=0;pass<3;pass++){
    const currentBase=await latest();if(!valid()||currentBase.matchId!==target.matchId)return;
    const filled=mergePostgameEvidence(currentBase,payload);
    // Even an unchanged in-memory result may have failed its previous save.
    // Persist before publishing this attempt; never equate memory with durability.
    await save(filled);if(!valid())return;
    await saver.current.idle();if(!valid())return;
    let persisted=filled;
    if(current.current.id===target.id){if(current.current!==currentBase)continue;}
    else{
     persisted=readSession(await invoke<unknown>('get_session',{id:target.id}));
     if(!valid()||persisted.matchId!==target.matchId)return;
     if(current.current.id===target.id)continue;
     if(mergePostgameEvidence(persisted,payload)!==persisted)continue;
    }
    postgameRetries.current.observe(persisted);
    analysisTarget.current?.observe(persisted);
    if(current.current.id===persisted.id)commit(persisted);
    if(activeSession.current?.id===persisted.id)activeSession.current=persisted;
    setArchiveDetail(detail=>detail?.id===persisted.id?persisted:detail);
    // A client read failure must not block saving already acquired evidence.
    // Report it after durability; a save failure instead reaches the outer catch.
    if(readFailed)setError(`赛后补录暂未完成，将在有限窗口内重试：${String(readError)}`);
    return;
   }
  }catch(e){if(valid())setError(`赛后补录暂未完成，将在有限窗口内重试：${String(e)}`);}finally{recoveringPostgame.current=false;}
 }
 useEffect(()=>{if(!isTauri())return;const cleanup=setInterval(()=>{if(!busyRef.current&&!reading.current&&!current.current.players.length)void refreshStorage().then(s=>maintenance(s.budgetMb,s.retentionDays)).catch(e=>setError(String(e)));},30*60*1000);return()=>clearInterval(cleanup);},[]);
 function backgroundTick(){
  if(!config.current.auto||config.current.historical||collectionPaused.current||analysisSettings.current.updating)return;
  confirmScanRef.current();
  const now=Date.now();
  if(now>=nextPoll.current)void poll();
  // Recheck a visible choice independently of API latency. No fresh snapshot,
  // no scanner: a disconnected/stalled collector must not keep an old round live.
  if(!hasFreshOcrSnapshot(snapshotRef.current,now))return;
  const band=liveDetectionBand(current.current,snapshotRef.current,false);
  if(band!==null&&ocrCadence.current.isDue(JSON.stringify([current.current.id,current.current.matchId,band]),now))detectAugmentsRef.current(current.current);
 }
 useEffect(()=>{if(!isTauri())return;let active=true;let stop:(()=>void)|undefined;void listen('app:background-tick',()=>{if(active)backgroundTick();}).then(unlisten=>{if(!active){unlisten();return;}stop=unlisten;void poll();}).catch(e=>setError(String(e)));return()=>{active=false;stop?.();epoch.current++;};},[]);
 function reportRecommendation(target:Session,status:RecommendationStatus,automatic=true,httpStatus?:number){
   const changed=recommendationProgress.current.set(target,status);
   if(recommendationProgressKey(target)===recommendationProgressKey(current.current)){
    setAutoRecommendStatus(status.message);
    // A status-only IPC is identity checked by the native cache and cannot replace
    // newer candidates/scores or reopen a user-closed window.
    if(changed)void invoke('overlay_analysis_status',{payload:{sessionId:target.id,level:target.candidateBand,candidates:target.candidates,analysis:status}}).catch(()=>{});
   }
   if(changed)void invoke('recommendation_diagnostic',{entry:{stage:status.phase,code:status.code,matchId:/^\d{1,24}$/.test(target.matchId)?target.matchId:undefined,band:target.candidateBand,automatic,httpStatus}}).catch(()=>{});
 }
 function restoreDurableRecommendation(target:Session):LocalRecommendation|null {
   // Filter before restoration: an in-memory result is not evidence of a successful save.
   return restoreModelRecommendation({...target,decisions:target.decisions.filter(decision=>recommendationProgress.current.canRestore(target,decision.at,knowledgeRevision.current,analysisSettings.current.revision))});
 }
 function cancelConfirmationScan(){const pending=confirmationScan.current;if(pending)clearTimeout(pending.timer);confirmationScan.current=null;}
 function scheduleConfirmationScan(target:Session,delay=CANDIDATE_RECHECK_MS,cooldown=false){
   const key=recommendationProgressKey(target);
   if(target.candidates.length<2||target.candidates.some(candidate=>candidate.source!=='ocr')||automaticIssue()||(busyRef.current&&!analysisTarget.current))return;
   if(confirmationScan.current?.key===key)return;
   cancelConfirmationScan();
   // Only OCR retries use the small burst budget. A request-cooldown timer is
   // one separate wake-up and still performs a real capture before any request.
   const at=cooldown?Date.now()+Math.max(CANDIDATE_RECHECK_MS,delay):candidateScanBurst.current.take(Date.now(),delay);
   if(at===null)return;
   confirmationScan.current={key,at,cooldown,timer:setTimeout(()=>confirmScanRef.current(),at-Date.now())};
 }
 function confirmCandidateScan(){
   const pending=confirmationScan.current;
   if(!pending||Date.now()<pending.at)return;
   if(!pending.cooldown&&!candidateScanBurst.current.isActive(Date.now())){cancelConfirmationScan();return;}
   if(automaticIssue()||(busyRef.current&&!analysisTarget.current)||!hasFreshOcrSnapshot(snapshotRef.current,Date.now())||Date.now()-pending.at>15000||recommendationProgressKey(current.current)!==pending.key||liveDetectionBand(current.current,snapshotRef.current,config.current.historical)!==current.current.candidateBand){cancelConfirmationScan();candidateScanBurst.current.reset();return;}
   if(scanning.current)return; // native ticks also drain this when browser timers are throttled
   const remaining=ocrCadence.current.remaining(JSON.stringify([current.current.id,current.current.matchId,current.current.candidateBand]),Date.now());
   if(!Number.isFinite(remaining)){cancelConfirmationScan();return;}
   if(remaining>0){clearTimeout(pending.timer);pending.at=Date.now()+remaining;pending.timer=setTimeout(()=>confirmScanRef.current(),remaining);return;}
   cancelConfirmationScan();
   detectAugmentsRef.current(current.current); // a real capture, never a replay of retained candidates
 }
 function automaticIssue():string {
   const settings=analysisSettings.current;
   if(!settings.consent)return '请先授权当前模型服务分析数据。';
   if(!settings.autoRecommend)return '自动推荐未开启，请在设置中开启。';
   if(modelKeys.current?.isLoading())return '正在恢复此服务保存的密钥，请稍候。';
   if(!config.current.auto||config.current.historical||collectionPaused.current||settings.updating)return '自动推荐已暂停，等待恢复实时跟踪。';
   const issue=automaticModelIssue(settings.model,settings.apiKey);
   if(issue)return issue;
   return '';
 }
 function automaticIssueCode(issue:string):string {
   if(issue.includes('授权'))return 'service-consent';
   if(issue.includes('未开启'))return 'auto-disabled';
   if(issue.includes('恢复此服务'))return 'key-loading';
   if(issue.includes('API Key'))return 'missing-key';
   if(issue.includes('实时跟踪'))return 'collection-paused';
   return 'model-settings';
 }
 function maybeAutoRecommend(session:Session,scan:OcrScan){
   const key=autoRecommendationKey(session);
   const observedKey=autoRecommendationKey({...session,candidates:scan.candidates.map(candidate=>({...candidate,source:'ocr'}))});
   if(scan.skipped||scan.probeOnly||scan.waitingForReady||scan.source!=='capture'||!key||observedKey!==key){
    cancelConfirmationScan();autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;
    const sent=analysisTarget.current&&recommendationProgress.current.get(analysisTarget.current.snapshot)?.phase==='analyzing';
    reportRecommendation(session,sent?{phase:'analyzing',code:'candidate-recheck',message:'分析请求已发出，正在重新核对当前候选。'}:{phase:'waiting',code:'ineligible-choice',message:'等待本轮三张完整 OCR 候选；手动候选请点击分析。'});
    if(!scan.skipped&&scan.source==='capture')scheduleConfirmationScan(session);else candidateScanBurst.current.reset();
    return;
   }
   lastAutoScan.current={key,at:Date.now()};
   const issue=automaticIssue();
   if(issue){cancelConfirmationScan();autoRecommendationGate.current.resetObservation();reportRecommendation(session,{phase:'blocked',code:automaticIssueCode(issue),message:issue});return;}
   candidateScanBurst.current.arm(key,Date.now());
   const firstObserved=autoRecommendationGate.current.firstObservedAt(session);
   if(busyRef.current){
    const ready=autoRecommendationGate.current.observe(session,Date.now());
    if(firstObserved===null&&autoRecommendationGate.current.firstObservedAt(session)!==null)nextPoll.current=0;
    if(!ready&&!autoRecommendationGate.current.blockReason(session))scheduleConfirmationScan(session);
    return;
   }
   if(liveDetectionBand(session,snapshotRef.current,config.current.historical)!==session.candidateBand){cancelConfirmationScan();autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;reportRecommendation(session,{phase:'waiting',code:'round-changed',message:'轮次已变化，等待当前轮候选。'});return;}
   const blocked=autoRecommendationGate.current.blockReason(session);
   if(blocked){
    cancelConfirmationScan();
    const failure=recommendationProgress.current.failure(session),restorable=blocked==='saved'?restoreDurableRecommendation(session):null;
    reportRecommendation(session,blocked==='saved'&&restorable?{phase:'complete',code:'saved-result',message:'本组分析已保存，不重复请求。'}:failure?failure:blocked==='saved'?{phase:'blocked',code:'saved-context-changed',message:'已有分析不适用于当前配置或知识，可在主窗口手动分析。'}:blocked==='round-limit'?{phase:'blocked',code:'round-limit',message:`本轮自动分析已达 ${AUTO_MAX_PER_ROUND} 次上限，可手动分析。`}:{phase:'blocked',code:'already-attempted',message:'本组已尝试分析，未自动重试；可在主窗口手动分析。'});
    return;
   }
   const ready=autoRecommendationGate.current.observe(session,Date.now());
   if(firstObserved===null&&autoRecommendationGate.current.firstObservedAt(session)!==null)nextPoll.current=0;
   if(!ready){reportRecommendation(session,{phase:'waiting',code:'confirming-ocr',message:'候选已识别，正在复核；尚未调用模型。'});scheduleConfirmationScan(session);return;}
   if(!canAnalyzeObservedChoice(session,snapshotRef.current,autoRecommendationGate.current.firstObservedAt(session),Date.now(),snapshotPollStartedAt.current)){
    reportRecommendation(session,{phase:'waiting',code:'refreshing-context',message:'候选已识别，正在同步最新轮次；尚未调用模型。'});return;
   }
   const wait=requestInterval.current.remaining('recommend',session);
   if(wait>0){reportRecommendation(session,{phase:'waiting',code:'request-cooldown',message:`请求间隔保护，约 ${Math.ceil(wait/1000)} 秒后重新核对候选。`});scheduleConfirmationScan(session,wait,true);return;}
   const dataIssue=analysisDataIssue(session);
   if(dataIssue){reportRecommendation(session,{phase:'blocked',code:'incomplete-context',message:`${dataIssue}；尚未调用模型。`});return;}
   cancelConfirmationScan();
   void runRef.current('recommend',session,true);
 }
 async function run(mode:'recommend'|'review',target:Session=current.current,automatic=false){
   const settings=analysisSettings.current;
   const {model,apiKey,consent}=settings;
   if(modelKeys.current?.isLoading()){setError('正在恢复此服务保存的密钥，请稍候再分析。');return;}
   if(automatic){const issue=automaticIssue();if(issue){reportRecommendation(target,{phase:'blocked',code:automaticIssueCode(issue),message:issue});return;}}
   let source:Session;
   try{source=analysisSource(mode,target,current.current,snapshotRef.current,config.current.historical);}catch(e){setError(String(e));return;}
    if(!consent){setView('settings');setError(`请在“本地设置 → 自动推荐”中勾选“允许 ${modelServiceLabel(model)} 分析本局数据”，再返回对局分析。`);return;}
   if(busyRef.current){setError('上一次分析还没结束，先等它完成再试。');return;}
   const wait=requestInterval.current.remaining(mode,source);
   if(wait>0){setError(`请求间隔保护，${Math.ceil(wait/1000)} 秒后可再分析；同组重复分析至少间隔 8 秒。`);return;}
   if(mode==='recommend'){const issue=analysisDataIssue(source);if(issue){reportRecommendation(source,{phase:'blocked',code:'incomplete-context',message:`${issue}；尚未调用模型。`},automatic);setError(issue);return;}}
   epoch.current++;busyRef.current=true;setBusy(true);setError('');
   const tracking=new AnalysisTarget(synchronizeSelections(source));
   analysisTarget.current=tracking;
   const selected=tracking.snapshot;
   const selectedKnowledgeRevision=knowledgeRevision.current;
   const selectedModelRevision=settings.revision;
   let dispatched=false,resultReceived=false;
   if(mode==='recommend')reportRecommendation(selected,{phase:'preparing',code:'retrieving-context',message:'正在读取本地知识，准备分析…'},automatic);
  try{
   // Do not recursively embed earlier decision contexts or repeated sampled snapshots.
   const {samples,decisions,...rest}=selected;
   const isJev=model.provider==='jev';
    const [evidence,similarEntries]=await Promise.all([
     invoke<KnowledgeResult>('knowledge_retrieve',{context:selected}),
     isJev?Promise.resolve([]):invoke<HistoryEntry[]>('history_similarity',{session:{id:selected.id,ownPlayerId:selected.ownPlayerId,players:selected.players,candidates:selected.candidates,decisions:selected.decisions.map(d=>({at:d.at,chosenId:d.chosenId}))},limit:5})
    ]);setKnowledge(evidence);setSimilar(similarEntries);
    const context:Record<string,unknown>={...rest,knowledge:evidence,decisions:mode==='review'?decisions:[]};
    // Legacy local snapshots may contain extra fields. Never carry their history
    // into a Jev request; local player IDs are removed by the native state boundary.
    delete context.history;
    if(!isJev)context.history=similarEntries;
   // Retrieval can outlive a disconnect or game transition; recheck before sending paid work.
   analysisSource(mode,selected,current.current,snapshotRef.current,config.current.historical);
   if(!analysisSettings.current.consent||selectedModelRevision!==analysisSettings.current.revision)throw new Error('模型配置或授权已变化；本次尚未调用模型。');
   if(mode==='recommend'&&(modelContextKey(selected)!==modelContextKey(current.current)||selectedKnowledgeRevision!==knowledgeRevision.current))throw new Error('候选、阵容或知识已变化，请重新发起分析；本次尚未调用模型。');
   if(automatic){
    const latest=lastAutoScan.current,key=autoRecommendationKey(current.current);
    if(automaticIssue()||!key||latest?.key!==key||Date.now()-latest.at>15000||!autoRecommendationGate.current.isReady(current.current,Date.now()))throw new Error('自动推荐条件已变化，等待下一次稳定识别；本次尚未调用模型。');
    if(!canAnalyzeObservedChoice(current.current,snapshotRef.current,autoRecommendationGate.current.firstObservedAt(current.current),Date.now(),snapshotPollStartedAt.current))throw new Error('当前轮次证据待刷新；本次尚未调用模型。');
   }
   // 发出请求即计数；每日仅作统计，自动请求仍受每轮上限约束。
   const used=bumpUsage();setDailyUsed(used);
   if(mode==='recommend')autoRecommendationGate.current.markAttempt(selected,automatic);
   // Local retrieval and cancelled preflight do not consume a request interval.
   requestInterval.current.markDispatched(mode,selected);
   dispatched=true;
   if(mode==='recommend')reportRecommendation(selected,{phase:'analyzing',code:'request-dispatched',message:'正在请求模型评分…'},automatic);
   const result=await invoke<Recommendation|Review>('analyze_structured',{request:{mode,context,model:{...model,provider:model.provider||'openai',apiKey}}});
   resultReceived=true;
   if(mode==='recommend')reportRecommendation(selected,{phase:'analyzing',code:'result-received',message:'已收到评分，正在保存并同步侧栏…'},automatic);
    const next=tracking.complete(context,mode==='recommend'?{mode,result:result as Recommendation}:{mode,result:result as Review});
    if(mode==='recommend')recommendationProgress.current.recordResult(next,tracking.at,selectedKnowledgeRevision,selectedModelRevision,false);
    if(next.id===current.current.id)commit(next);else setArchiveDetail(d=>d&&d.id===next.id?next:d);
    await save(next);
    if(mode==='recommend'&&!recommendationProgress.current.isSaved(next,tracking.at))throw new Error('分析结果未包含在最终保存快照中。');
    // 已持久化结果只可发布回同局、同轮、同英雄与同组候选。
    // 装备/局势变化仅保留明确标注的此前快照，不重复调用；换组选项的响应只进档案。
    const publishable=()=>!config.current.historical&&analysisSettings.current.consent&&recommendationProgress.current.canRestore(next,tracking.at,knowledgeRevision.current,analysisSettings.current.revision)&&selectedModelRevision===analysisSettings.current.revision&&selectedKnowledgeRevision===knowledgeRevision.current&&canRetainModelRecommendation(selected,current.current)&&liveDetectionBand(current.current,snapshotRef.current,false)===selected.candidateBand&&(!automatic||(analysisSettings.current.autoRecommend&&config.current.auto&&!collectionPaused.current&&lastAutoScan.current?.key===autoRecommendationKey(current.current)&&Date.now()-lastAutoScan.current.at>=0&&Date.now()-lastAutoScan.current.at<=(panelMisses.current===0?15000:panelMisses.current===1?2000:0)));
    if(mode==='recommend'&&publishable()){
     const ranking={...modelRecommendation(selected,result as Recommendation),contextChanged:!canPublishModelRecommendation(selected,current.current)};
     setLocalRecommendation(createLocalRecommendation(selected,ranking,tracking.at));
     await invoke('overlay_publish',{payload:{level:selected.candidateBand,sessionId:selected.id,ranking}});
     if(publishable()&&(!automatic||panelMisses.current===0))await invoke('overlay_open',{level:selected.candidateBand});
    }
   if(mode==='recommend')reportRecommendation(selected,{phase:'complete',code:'analysis-complete',message:'模型分析已完成并保存。'},automatic);
   const eng=(result as Partial<Recommendation>).engine;
   setFlash(mode==='recommend'?`分析完成 · 今日累计 ${used} 次${eng?` · ${eng.latencyMs} ms · 上下文 ${Math.round((eng.inputBytes||0)/1024)} KiB`:''}`:`复盘完成 · 今日累计 ${used} 次`);
  }catch(e){
   const failure=analysisFailure(e);
   const message=resultReceived?'已收到分析，保存或显示失败；请勿急于重复请求。':dispatched?`${failure.message}；未自动重试，可在主窗口手动分析。`:'发送前条件变化或本地读取失败，尚未调用模型；下次识别会重新检查。';
   if(mode==='recommend')reportRecommendation(selected,{phase:dispatched?'failed':'waiting',code:resultReceived?'save-or-publish-failed':dispatched?failure.code:'pre-send-cancelled',message},automatic,failure.httpStatus);
   setError(message);
  }finally{analysisTarget.current=null;busyRef.current=false;setBusy(false);}
 }
 function beginMutation(){if(busyRef.current)return false;epoch.current++;collectionPaused.current=true;busyRef.current=true;setBusy(true);return true;}
 function endMutation(){collectionPaused.current=false;busyRef.current=false;setBusy(false);nextPoll.current=0;}
 function resumeLive(){if(collectionPaused.current)return;epoch.current++;autoRecommendationGate.current.resetObservation();lastAutoScan.current=null;if(debounce.current){clearTimeout(debounce.current);debounce.current=null;if(isTauri())void save(current.current).catch(e=>setError(String(e)));}if(config.current.historical&&activeSession.current){commit(activeSession.current);activeSession.current=null;}setHistorical(false);config.current.historical=false;void poll();}
 function patch(p:Partial<Session>,source:'manual'|'ocr'='manual'){if(source==='manual'&&(p.candidates||p.players&&p.decisions)&&!liveOverviewState(current.current,snapshotRef.current,config.current.historical).live){setError('当前显示的是已保留记录，本轮候选与选择只能在实时对局中修改。');return;}if(p.candidates&&source==='manual'){candidateRevision.current++;seenIds.current='';const edited=p.candidates.some(c=>{const old=current.current.candidates.find(x=>x.id===c.id);return !old||old.name!==c.name||old.description!==c.description;});p={...p,candidates:markCandidateEdits(current.current.candidates,p.candidates),...(edited?{candidateBand:liveDetectionBand(current.current,snapshotRef.current,config.current.historical)??undefined}:{})};}const next={...current.current,...p,updatedAt:new Date().toISOString()};commit(next);if(debounce.current)clearTimeout(debounce.current);if(isTauri())debounce.current=setTimeout(()=>{void save(current.current).catch(e=>setError(String(e)));debounce.current=null;},1500);}
 async function openArchive(id:string){if(!beginMutation())return;try{if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}if(hasContent(current.current))await save();let full=readSession(await invoke<unknown>('get_session',{id}));if(hasMissingPostgameEvidence(full)){const payload=await invoke<unknown>('postgame_rescan',{session:full,lockfilePath:config.current.lockfile.trim()||null});const filled=mergePostgameEvidence(full,payload);if(filled!==full){await save(filled);full=filled;postgameRetries.current.observe(full);if(full.id===current.current.id)commit(full);if(activeSession.current?.id===full.id)activeSession.current=full;}}setArchiveDetail(full);}finally{endMutation();}}
 async function checkUpdate(){if(!isTauri())return;setUpdateBusy('check');setUpdateErr('');let update:Awaited<ReturnType<typeof check>>=null;try{update=await check();setUpdateInfo(update?{version:update.version,date:update.date,body:update.body}:null);}catch(e){setUpdateErr(String(e));}finally{await update?.close().catch(()=>{});setUpdateBusy('idle');}}
 async function installUpdate(){
  if(!isTauri()||busyRef.current)return;setUpdateBusy('install');setUpdateErr('');setUpdateProg(0);
  let frozen=false;let update:Awaited<ReturnType<typeof check>>=null;
  try{
   update=await check();if(!update){setUpdateInfo(null);setUpdateProg(null);return;}
   let got=0,total:number|null=null;
   await update.download(event=>{if(event.event==='Started')total=event.data.contentLength??null;else if(event.event==='Progress'){got+=event.data.chunkLength;setUpdateProg(total?Math.min(99,Math.round(got/total*100)):null);}else setUpdateProg(100);});
   if(!beginMutation())throw new Error('分析或数据操作尚未结束，请稍后再安装更新。');
   frozen=true;if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}
   await save();if(activeSession.current&&activeSession.current.id!==current.current.id)await save(activeSession.current);await saver.current.idle();await modelKeys.current?.flush();
   await update.install();
  }catch(e){setUpdateErr(String(e));setUpdateProg(null);}
  finally{await update?.close().catch(()=>{});if(frozen)endMutation();setUpdateBusy('idle');}
 }
 async function exportCurrent(target:Session){try{const path=await invoke<string>('export_session',{session:target});setFlash(`已导出本局到 ${path}`);}catch(e){setError(String(e));}}
 async function exportAll(){try{const r=await invoke<{path:string;count:number;bytes:number;unreadable?:number}>('export_history');setFlash(`已导出 ${r.count} 场对局到 ${r.path}（${(r.bytes/1024/1024).toFixed(1)} MB）${r.unreadable?`；另保留 ${r.unreadable} 条异常记录原文以便检查`:''}`);}catch(e){setError(String(e));}}
 async function rescanArchive(){
  if(!archiveDetail||!beginMutation())return;
  const target=archiveDetail;
  try{
   if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}
   if(hasContent(current.current))await save();
   await saver.current.idle();
   const base=target.id===current.current.id?current.current:readSession(await invoke<unknown>('get_session',{id:target.id}));
   if(base.matchId!==target.matchId)throw new Error('档案对局标识已变化，本次补录已取消。');
   const payload=await invoke<unknown>('postgame_rescan',{session:base,lockfilePath:config.current.lockfile.trim()||null});
   const filled=mergePostgameEvidence(base,payload);
   if(filled===base){setError('客户端尚未返回这局可验证的新结算证据；已有记录保持不变，可稍后重试并在诊断页查看 HTTP 状态。');return;}
   await save(filled);
   postgameRetries.current.observe(filled);
   if(filled.id===current.current.id)commit(filled);
   if(activeSession.current?.id===filled.id)activeSession.current=filled;
   setArchiveDetail(filled);
  }catch(e){setError(String(e));}finally{endMutation();}
 }
 async function refreshStorage(){const s=await invoke<StorageStats>('storage_stats');setStorage(s);setBudget(s.budgetMb);setDays(s.retentionDays);return s;}
 async function maintenance(b=budget,d=days){if(!beginMutation())return;try{if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}if(hasContent(current.current))await save();await saver.current.idle();const s=await invoke<StorageStats>('maintain_storage',{budgetMb:b,retentionDays:d});setStorage(s);const reload=async(session:Session|null)=>session&&hasContent(session)?readSession(await invoke<unknown>('get_session',{id:session.id})):session;const [active,detail,held]=await Promise.allSettled([reload(current.current),reload(archiveDetailRef.current),reload(activeSession.current)]);if(active.status==='fulfilled'&&active.value)commit(active.value);setArchiveDetail(detail.status==='fulfilled'?detail.value:null);activeSession.current=held.status==='fulfilled'?held.value:null;await refreshHistory();const failed=[active,detail,held].find(result=>result.status==='rejected');if(failed?.status==='rejected')setError(String(failed.reason));else if(s.budgetReached===false)setError('核心记录仍超过预算，请删除不再需要的历史；不会自动删除你的决策。');}finally{endMutation();}}
 async function removeRecord(id:string){if(!beginMutation())return;try{if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}await writeQueue.current.catch(()=>{});await invoke('delete_session',{id});postgameRetries.current.forget(id);if(current.current.id===id){commit(newSession());setHistorical(true);config.current.historical=true;}if(activeSession.current?.id===id)activeSession.current=null;if(archiveDetail?.id===id)setArchiveDetail(null);await refreshHistory();await refreshStorage();}finally{endMutation();}}
 async function removeAnalysis(at:string){if(!beginMutation())return;try{if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}await save();const next=readSession(await invoke<unknown>('delete_analysis',{sessionId:current.current.id,at}));commit(next);await refreshHistory();await refreshStorage();}finally{endMutation();}}
 async function testModel(){setModelStatus('正在检测…');const destination=modelDestination(analysisSettings.current.model);try{await modelKeys.current?.flush();if(destination!==modelDestination(analysisSettings.current.model))throw new Error('模型服务已变化，请重新测试。');const {model,apiKey}=analysisSettings.current;const revision=analysisSettings.current.revision;const r=await invoke<{models:string[];latencyMs:number;note:string}>('test_provider',{model:{...model,provider:model.provider||'openai',apiKey}});if(revision!==analysisSettings.current.revision)return;setModels(r.models);setModelStatus(`${r.latencyMs} ms · ${r.note}`);}catch(e){setModelStatus(String(e));}}
 useEffect(()=>{if(!isTauri())return;if(view==='archive')void refreshHistory().catch(e=>setError(String(e)));if(view==='settings')void refreshStorage().catch(e=>setError(String(e)));if(view==='logs'){void logs().catch(e=>setError(String(e)));loadOcr();}},[view]);
 const liveCurrent=liveOverviewState(session,snapshot,historical).live;
 const previousCandidateBand=liveCurrent&&session.candidateBand!==undefined&&session.candidateBand!==liveDetectionBand(session,snapshot,historical);
 const errors=[...(!liveCurrent?['当前没有可用的实时对局，本轮推荐暂不可用']:[]),...blockers(session),...(previousCandidateBand?['等待本轮候选，当前记录来自上一等级档位']:[])],last=session.decisions.at(-1),own=session.players.find(p=>p.id===session.ownPlayerId);
 const updatePlayer=(id:string,p:Partial<Session['players'][number]>)=>patch({players:session.players.map(x=>x.id===id?{...x,...p}:x)});
 const verified=session.players.filter(p=>p.id===session.ownPlayerId&&p.augmentsConfirmed).length;
 const pageHero={
  knowledge:{title:'把知识，整理成可靠依据。',description:'校验、编辑并维护英雄与海克斯知识，让每次建议都能追溯来源。'},
  archive:{title:'让每场对局，成为下一次依据。',description:'回看本地对局、选择与复盘，不让有价值的经验散落。'},
  logs:{title:'每一次连接，清晰可追溯。',description:'查看本地运行轨迹与诊断信息，敏感凭据不会进入日志。'},
  settings:{title:'本地设置',description:'管理模型、自动推荐和本机数据。'}
 }[view]||{title:'海萤 · Hexglow',description:'海克斯决策 · 对局记忆'};
 return <div className="shell"><nav className="rail"><img className="emblem" src="/brand.svg" alt="海萤 Logo"/><span className="rail-label">HEXGLOW</span>{[['live','◈','对局洞察'],['knowledge','▧','知识工坊'],['archive','▤','对局档案'],['logs','⌁','运行日志'],['settings','⚙','本地设置']].map(([id,icon,label])=><button className={view===id?'nav-item active':'nav-item'} key={id} onClick={()=>{if(id!==view&&knowledgeLeaveGuard.current&&!knowledgeLeaveGuard.current())return;setView(id);}}><span>{icon}</span>{label}</button>)}<div className="rail-bottom"><i/>LOCAL FIRST<br/><small>WINDOWS DESKTOP</small>{isTauri()&&<button type="button" className="rail-exit" disabled={busy} title="保存对局后退出 Hexglow，不再后台运行" onClick={()=>void invoke('desktop_request_exit').catch(e=>setError(String(e)))}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 3v9M7 5.7a8 8 0 1 0 10 0"/></svg>完全退出</button>}</div></nav>
 <div className="workspace"><header><div><strong>海萤 <span>/ HEXGLOW</span></strong><small>海克斯决策 · 对局记忆</small></div><div className="header-status"><i className={snapshot?.liveData?'pulse':''}/>{historical?'历史回看':phaseLabel(snapshot?.phase)}<span>本地运行</span></div></header>
  {view==='archive'&&archiveDetail&&<div className="archive-page-back"><button onClick={()=>setArchiveDetail(null)}>← 返回列表</button></div>}
  {view!=='live'&&<section className="hero" data-settings={view==='settings'}><div><div className="eyebrow">READ THE RIFT. REFINE THE CHOICE.</div><h1>{pageHero.title}</h1><p>{pageHero.description}</p></div><img className="hero-mark" src="/brand.svg" alt="海萤 · 微光照见每种可能"/></section>}
 {!isTauri()&&<div className="notice">浏览器仅展示界面。启动 Tauri 桌面端后自动发现客户端；Windows 是正式验证目标。</div>}
 {flash&&<div className="notice" role="status">{flash}</div>}
 {error&&<div className="error" role="alert">{error}<button onClick={()=>setError('')}>关闭</button></div>}
 {view==='logs'&&snapshot?.warnings.map((w,i)=><div className="notice compact" key={i}>{w}</div>)}
 {view==='live'&&<><LiveOverview session={session} snapshot={snapshot} auto={auto} autoRecommend={autoRecommend} autoRecommendStatus={automaticIssue()||recommendationProgress.current.get(session)?.message||'等待本轮完整候选。'} analysisStatus={recommendationProgress.current.get(session)} localRecommendation={localRecommendation} detectionMessage={detection?.sessionId===session.id?detection.message:'等待游戏中的候选面板'} onSync={()=>{epoch.current++;resumeLive();}} busy={busy} ready={!!model.name.trim()&&consent&&isTauri()} setupIssue={!isTauri()?'请使用 Windows 桌面端生成模型分析。':!model.name.trim()?'模型分析需先填写模型名称并测试连接。':!consent?'模型分析需先在本地设置授权当前模型服务。':''} blockers={errors} onRun={()=>void run('recommend')} onSettings={()=>setView('settings')} onPatch={patch} historical={historical} onResume={resumeLive}/><div className="advanced-entry"><button className="advanced-open" onClick={()=>setAdvancedOpen(true)} aria-haspopup="dialog">高级 · 手动纠正、复盘与诊断 <span>↗</span></button></div>{advancedOpen&&<div className="advanced-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setAdvancedOpen(false);}}><section className="advanced-drawer" role="dialog" aria-modal="true" aria-labelledby="advanced-title"><div className="advanced-drawer-head"><div><span className="eyebrow">ADVANCED TOOLS</span><h2 id="advanced-title">手动纠正、复盘与诊断</h2></div><button onClick={()=>setAdvancedOpen(false)} aria-label="关闭高级面板">关闭</button></div><div className="advanced-content"><p className="hint">以下仅供需要时使用，正常查看推荐无需逐项操作。未识别信息保持未知，不需要为通过校验而确认空白。</p><div className="metrics"><div><span>CLIENT LINK</span><strong>{snapshot?.connection||'自动发现中'}</strong><small>LCU / Live Client API</small></div><div><span>MATCH PHASE</span><strong>{phaseLabel(session.phase)}</strong><small>{session.matchId?`对局 ${session.matchId}`:'等待可验证的对局 ID'}</small></div><div><span>CONTEXT COVERAGE</span><strong>{verified}<em> / 1</em></strong><small>只有本人海克斯可核实</small></div><div><span>LOCAL ARCHIVE</span><strong>{resultLabel(session.result)}</strong><small>最近保存 {saved}</small></div></div>
 <div className="toolbar"><span><i/> {historical?'正在查看历史快照，不会被实时数据覆盖':auto?'自动跟踪 · 对局 1 秒 / 大厅 3 秒 / 断连 8–15 秒':'自动跟踪已暂停'}</span><label><input type="checkbox" checked={auto&&!historical} disabled={busy||!isTauri()} onChange={e=>{epoch.current++;setAuto(e.target.checked);if(e.target.checked){resumeLive();}}}/>自动跟踪</label><button className="ghost" disabled={busy||!isTauri()} onClick={()=>{epoch.current++;resumeLive();}}>立即同步</button><button disabled={busy||!isTauri()} onClick={()=>void save().catch(e=>setError(String(e)))}>保存快照</button></div>
 <main><div><section className="panel"><div className="section-title"><h2><b>01</b> 战场上下文</h2><span>API 事实 × 人工核验</span></div><label>当前英雄<Select disabled={busy} value={session.ownPlayerId} onChange={e=>patch({ownPlayerId:e.target.value})}><option value="">等待识别 / 选择当前玩家</option>{session.players.map(p=><option key={p.id} value={p.id}>{p.champion} · {p.name}</option>)}</Select></label>
 {!session.players.length&&<div className="empty"><div className="radar">◎</div><h3>已就绪，等待本地对局信号</h3><p>工具启动后自动查找已运行的客户端。<br/>进入游戏后，阵容会自动出现在这里。</p><small>不伪造阵容 · 不推测隐藏信息</small></div>}
 <div className="teams">{['ORDER','CHAOS'].map(team=><div key={team}><h3 className="team-title">{team==='ORDER'?'蓝色方':'红色方'}<span>{own?.team===team?'我方':'阵容'}</span></h3><div className="team-cards">{session.players.filter(p=>p.team===team).map(p=><article className={`player ${p.id===session.ownPlayerId?'selected':''}`} key={p.id}><div className="player-heading"><div className="avatar">{p.champion.slice(0,2)}</div><div><strong>{p.champion}</strong><small>{/^#+$/.test(p.name.trim())?'':p.name}</small></div><span>{p.id===session.ownPlayerId?'YOU':`${p.items.length} 装备`}</span></div>{p.id===session.ownPlayerId?<><textarea aria-label={`${p.name} 已选海克斯`} disabled={busy} placeholder="海克斯及完整效果，一行一项" value={p.augments.join('\n')} onChange={e=>updatePlayer(p.id,{augments:e.target.value.split('\n'),augmentsConfirmed:false})}/><label className="check"><input type="checkbox" checked={p.augmentsConfirmed} disabled={busy} onChange={e=>updatePlayer(p.id,{augmentsConfirmed:e.target.checked,augments:p.augments.filter(x=>x.trim())})}/>已核实我的海克斯（尚无也需确认）</label></>:(p.augments.length?<div className="player-augments">{p.augments.map(a=><span key={a}>{a}</span>)}<small>{p.augmentsConfirmed?'赛后数据已核实':'手动录入'}</small></div>:<p className="player-na">运行时拿不到他人的海克斯（本地 API 不提供），这里按未知处理，不会当作「没有」。</p>)}</article>)}</div></div>)}</div>
 <label>局势补充<textarea disabled={busy} value={session.notes} onChange={e=>patch({notes:e.target.value})} placeholder="版本 / 英雄机制 / 伤害类型 / 装备计划 / 当前局势…"/></label><details><summary>查看原始 API 快照与阶段时间线</summary><pre>{JSON.stringify({liveData:session.liveData,timeline:session.timeline},null,2)}</pre></details></section>
 <section className="panel"><div className="section-title"><h2><b>02</b> {liveCurrent?'海克斯抉择':'历史候选记录'}</h2><span>{liveCurrent?`围绕 ${own?.champion||'当前英雄'} 比较`:'只读记录 · 非当前选择'}</span></div><div className="candidates">{session.candidates.map((c,i)=><div className="candidate" key={c.id}><div className="candidate-top">◇<span>OPTION 0{i+1}</span></div><input aria-label={`候选 ${i+1} 名称`} disabled={busy||!liveCurrent} placeholder="海克斯名称" value={c.name} onChange={e=>patch({candidates:session.candidates.map(x=>x.id===c.id?{...x,name:e.target.value}:x)})}/><textarea aria-label={`候选 ${i+1} 效果`} disabled={busy||!liveCurrent} placeholder="完整效果、数值、触发条件与限制" value={c.description} onChange={e=>patch({candidates:session.candidates.map(x=>x.id===c.id?{...x,description:e.target.value}:x)})}/></div>)}</div>{errors.length>0&&<div className="requirements"><strong>{liveCurrent?'推荐前还需要':'记录状态'}</strong>{(liveCurrent?errors:[errors[0]]).map(e=><span key={e}>○ {e}</span>)}</div>}<button className="accent wide" disabled={!liveCurrent||busy||errors.length>0||!model.name.trim()||!isTauri()} onClick={()=>void run('recommend')}>{busy?'结构化分析中…':'生成契合度分析  →'}</button><p className="hint">{liveCurrent?'不自动替你操作。模型判断不代表胜率；当前快照外的变化需重新分析。':'候选仅供回看，不再作为本轮选择。已有决策与赛果可用于复盘。'}</p></section>
 {last&&<section className="panel"><div className="section-title"><h2><b>03</b> 决策洞察</h2><span>{new Date(last.at).toLocaleTimeString()} 的上下文</span></div><p>{last.result.summary} <EngineBadge engine={last.result.engine}/></p>{similar.length>0&&<p className="hint">历史相似局 {similar.length} 条 · 同英雄 {similar.filter(h=>h.sameChampion).length} 条 · 重叠海克斯 {[...new Set(similar.flatMap(h=>h.matched||[]))].slice(0,6).join('、')||'无'}</p>}{last.result.ranking.map((r,i)=><RankingItemView key={r.candidateId} item={r} index={i} candidates={(last.context as Session).candidates} scoringMode={last.result.engine?.scoringMode}/>)}{last.result.missingInformation.map((s,i)=><p className="notice" key={i}>{s}</p>)}<p className="hint">{last.chosenId?'已确认的选择已锁定。':liveCurrent?'请在对局洞察的本轮候选下选择并确认，历史分析不会更改本轮选择。':'这是只读历史分析，未记录的选择不会补猜，也不能在这里确认。'}</p></section>}
 {session.decisions.length>0&&<section className="panel analysis-list"><h2>分析记录管理</h2>{session.decisions.map(d=><div className="archive-actions" key={d.at}><span>{new Date(d.at).toLocaleString()} · {d.result.summary.slice(0,60)}</span><button className="danger" disabled={busy} onClick={()=>setConfirmation({title:'删除这条分析？',detail:'删除后不能恢复；基于该分析的旧复盘也会清除，避免继续引用已删除判断。',action:()=>removeAnalysis(d.at)})}>删除分析</button></div>)}</section>}
 {knowledge&&<section className="panel"><h2>本次知识检索依据</h2><p className="hint">指纹：{knowledge.fingerprint} · {knowledge.documents.length} 份文档</p>{knowledge.documents.map(d=><details key={d.path}><summary>{d.title} · {d.path}{d.sections?.length?` · 章节：${d.sections.join('、')}`:''}</summary><pre>{d.content}</pre></details>)}{[...knowledge.missing,...knowledge.warnings].map((w,i)=><p className="notice" key={i}>{w}</p>)}</section>}
 </div><aside><section className="panel focus"><div className="eyebrow">LOCAL INFERENCE</div><h2>专注此刻的最优解</h2><p>英雄契合、阵容补强、对手克制，来自同一个完整上下文。</p><div className="engine"><i/>{model.name||'本地模型尚未配置'}</div><button className="ghost wide" onClick={()=>setView('settings')}>配置推理引擎 ↗</button><small>Jev 结构化判断 / 普通模型统一适配。</small></section>
 <section className="panel"><div className="eyebrow">POST-GAME MEMORY</div><h2>赛果与复盘</h2><div className={`result ${session.result?.status||'unknown'}`}>{resultLabel(session.result)}<small>{session.result?.source||'unknown'}{session.endedAt?' · 已检测结束':''}</small></div><label>手动结果补充（不会覆盖 API 证据）<Select disabled={busy||!!session.result&& !['manual','unknown'].includes(session.result.source)} value={session.result?.source==='manual'?session.result.status:'unknown'} onChange={e=>patch({result:{status:e.target.value as 'win'|'loss'|'unknown',source:'manual',observedAt:new Date().toISOString()}})}><option value="unknown">未知 / 待确认</option><option value="win">胜利 · 用户补充</option><option value="loss">失败 · 用户补充</option></Select></label><label>赛后观察<textarea disabled={busy} value={session.outcome} onChange={e=>patch({outcome:e.target.value})} placeholder="关键转折、实际选择表现、未实现的预期…"/></label><button className="wide" disabled={busy||!session.decisions.length||(!session.outcome.trim()&&session.result?.status!=='win'&&session.result?.status!=='loss')||!model.name.trim()||!isTauri()} onClick={()=>void run('review')}>生成本地复盘</button>{session.review&&<div className="review"><p>{session.review.summary}</p><ul>{session.review.lessons.map((x,i)=><li key={i}>{x}</li>)}</ul>{session.review.caveats.map((x,i)=><small key={i}>{x}<br/></small>)}</div>}<p className="hint">结束阶段自动保存，不因断线判负。复盘需点击触发；历史经验只作为待验证假说。</p></section><section className="panel"><div className="eyebrow">DATA INTEGRITY</div><h2>有依据，也有边界</h2><p className="hint">阵容来自本地 API。海克斯缺失时由你补齐。原始证据与模型意见独立保存，不混淆观察和推断。</p><div className="privacy">✓ 本地 SQLite<br/>✓ 日志脱敏与轮转<br/>✓ 无自动点击 / 无内存读取</div></section></aside></main></div></section></div>}</>}
 {view==='knowledge'&&<KnowledgePanel onLeaveGuard={guard=>{knowledgeLeaveGuard.current=guard;}} onChanged={()=>{knowledgeRevision.current++;epoch.current++;candidateRevision.current++;seenIds.current='';localRecommendationRef.current=null;setKnowledge(null);setLocalRecommendation(null);setError('知识已更新。下次模型分析将重新读取文档；此前分析保留为历史，不自动重复调用模型。');if(isTauri())void invoke('overlay_close').catch(e=>setError(String(e)));}}/>}
 {view==='archive'&&<section className="panel">{archiveDetail?<div className="archive-detail"><div className="section-title"><h2>本局档案</h2><span>{new Date(archiveDetail.createdAt).toLocaleString()} · {archiveDetail.matchId||'尚无对局 ID'}</span></div><div className="detail-meta"><span className={`pill ${archiveDetail.result?.status||'unknown'}`}>{resultLabel(archiveDetail.result)}</span><span>决策 {archiveDetail.decisions.length} 次</span><span>采样 {archiveDetail.sampleCount||0} 份</span><span>海克斯 {archiveDetail.players.reduce((n,p)=>n+p.augments.length,0)} 条</span><span>{archiveDetail.review?'已复盘':'待复盘'}</span></div><div className="teams">{['ORDER','CHAOS'].map(team=><div key={team}><h3 className="team-title">{team==='ORDER'?'蓝色方':'红色方'}<span>{archiveDetail.players.find(p=>p.id===archiveDetail.ownPlayerId)?.team===team?'我方':'阵容'}</span></h3><div className="team-cards">{archiveDetail.players.filter(p=>p.team===team).map(p=><article className={`player ${p.id===archiveDetail.ownPlayerId?'selected':''}`} key={p.id}><div className="player-heading"><div className="avatar">{p.champion.slice(0,2)}</div><div><strong>{p.champion}</strong><small>{/^#+$/.test(p.name.trim())?'':p.name}</small></div><span>{p.id===archiveDetail.ownPlayerId?'YOU':`${p.items.length} 装备`}</span></div>{p.augments.length?<div className="player-augments">{p.augments.map(a=><span key={a}>{a}</span>)}<small>{p.augmentsConfirmed?'赛后数据已核实':'手动录入'}</small></div>:<p className="player-na">本局未记录这名玩家的海克斯。</p>}</article>)}</div></div>)}</div><div className="archive-actions detail-actions"><button className="accent" disabled={busy||!archiveDetail.decisions.length||(!archiveDetail.outcome.trim()&&archiveDetail.result?.status!=='win'&&archiveDetail.result?.status!=='loss')||!model.name.trim()||!isTauri()} onClick={()=>void run('review',archiveDetail)}>{busy?'复盘中…':'复盘本局  →'}</button><button disabled={busy||!isTauri()} title="客户端在线时重新拉取本局赛后证据" onClick={()=>void rescanArchive()}>{busy?'处理中…':'重新补录结算'}</button><button disabled={!isTauri()} title="把这一局的完整 JSON 写到应用数据目录的 exports 文件夹" onClick={()=>void exportCurrent(archiveDetail)}>导出本局 JSON</button><button className="danger" disabled={busy} onClick={()=>setConfirmation({title:'删除这场对局？',detail:'将永久删除此对局、分析与复盘。当前游戏仍在进行时，重新跟踪可能再次建立记录。',action:()=>removeRecord(archiveDetail.id)})}>删除</button></div><p className="hint">推荐与候选只在对局进行中展示；这里查看已记录的赛果与双方海克斯，缺失内容保持未知。赛果或海克斯缺失时打开档案会自动找客户端补一次，也可点「重新补录结算」手动重试（需客户端在运行）。历史复盘基于本局已记录决策与赛果，不再生成本轮候选推荐；需有分析记录及胜负结果或赛后观察，复盘保存进这条档案。{model.name.trim()&&consent?'':'（先在本地设置配置模型并允许该服务分析本局数据。）'}</p>{archiveDetail.decisions.map(d=><section className="panel sub" key={d.at}><div className="section-title"><h2>AI 分析 · {new Date(d.at).toLocaleString()}</h2><span>{d.chosenId?(d.context as Session).candidates.find(c=>c.id===d.chosenId)?.name||'已记录选择':'尚未记录选择'}</span></div><p>{d.result.summary} <EngineBadge engine={d.result.engine}/></p>{d.result.ranking.map((r,i)=><RankingItemView key={r.candidateId} item={r} index={i} candidates={(d.context as Session).candidates} scoringMode={d.result.engine?.scoringMode}/>)}{d.result.missingInformation.map((s,i)=><p className="notice" key={i}>{s}</p>)}</section>)}{archiveDetail.review&&<section className="panel sub"><div className="section-title"><h2>本局复盘</h2></div><div className="review"><p>{archiveDetail.review.summary}</p><ul>{archiveDetail.review.lessons.map((x,i)=><li key={i}>{x}</li>)}</ul>{archiveDetail.review.caveats.map((x,i)=><small key={i}>{x}<br/></small>)}</div></section>}</div>:<><div className="section-title"><h2>本地对局档案</h2><span>第 {archivePage+1} 页 · 每页 50 条摘要</span></div><div className="archive-grid">{history.length?history.map(h=><article className="archive-card" key={h.id}><span className={`pill ${h.result?.status||'unknown'}`}>{resultLabel(h.result)}</span><h3>{h.players.find(p=>p.id===h.ownPlayerId)?.champion||h.players[0]?.champion||'英雄未识别'}</h3><p>{new Date(h.createdAt).toLocaleString()}</p><small>{h.decisions.length} 次决策 · {h.sampleCount||0} 份采样 · {h.review?'已复盘':'待复盘'}{augmentNote(h)}</small><code>{h.matchId||'尚无对局 ID'}</code><div className="archive-actions"><button disabled={busy} onClick={()=>void openArchive(h.id).catch(e=>setError(String(e)))}>查看记录 ↗</button><button className="danger" disabled={busy} onClick={()=>setConfirmation({title:'删除这场对局？',detail:'将永久删除此对局、分析与复盘。当前游戏仍在进行时，重新跟踪可能再次建立记录。',action:()=>removeRecord(h.id)})}>删除</button></div></article>):<div className="empty">检测到对局后自动建立档案，无需手动开始记录。</div>}</div><div className="archive-actions"><button disabled={!archivePage||busy} onClick={()=>{archiveOffset.current--;setArchivePage(archiveOffset.current);void refreshHistory().catch(e=>setError(String(e)));}}>上一页</button><button disabled={!archiveHasNext||busy} onClick={()=>{archiveOffset.current++;setArchivePage(archiveOffset.current);void refreshHistory().catch(e=>setError(String(e)));}}>下一页</button><button disabled={!isTauri()||busy} title="把全部对局写成一个 JSON 到应用数据目录的 exports 文件夹" onClick={()=>void exportAll()}>导出全部历史</button></div></>}</section>}
 {view==='logs'&&<section className="panel"><div className="section-title"><h2>识别命中率</h2><span>长期累计 · 本地统计</span></div>{ocr?<>
  <p>历史累计 OCR <b>{ocr.scans}</b> 次，产出候选 <b>{ocr.hits}</b> 次。包含旧版本与无面板画面，不能用于判断识别准确率。</p>
  {ocr.panelProbes&&<p>新增轻量探测 {ocr.panelProbes.checks} 次 · 疑似面板 {ocr.panelProbes.likely} 次 · 完整 OCR {ocr.panelProbes.ocr} 次 · 三张候选产出 {ocr.panelProbes.complete} 次 · 帧缓存复用 {ocr.panelProbes.cache} 次。探测判定不等于人工核验。</p>}
  <p className="hint">真实画面 OCR {ocr.sources?.capture?.scans||0} 次 / 有候选 {ocr.sources?.capture?.hits||0} 次；开发样本 fixture {ocr.sources?.file?.scans||0} 次 / 有候选 {ocr.sources?.file?.hits||0} 次。最近一次 {ocr.lastAt?new Date(ocr.lastAt).toLocaleString():'尚无'}。轻量探测单独计数，旧历史保留。</p>
  <p className="hint">近 7 天（扫描/命中）：{Object.entries(ocr.byDay||{}).slice(-7).map(([d,s])=>`${d.slice(5)} ${s.scans}/${s.hits}`).join(' · ')||'尚无'}</p>
 </>:<p className="hint">等待第一次识别；桌面端截屏识别后自动累计。</p>}</section>}
 {view==='logs'&&<section className="panel"><div className="section-title"><h2>运行轨迹</h2><button onClick={()=>{void logs().catch(e=>setError(String(e)));loadOcr();}} disabled={!isTauri()}>刷新日志</button></div><p className="hint">限额轮转日志，仅记录状态变化；相同错误去重并限频。只在打开本页或手动刷新时读取，不持续刷盘。不记录令牌、玩家姓名或模型上下文。</p><div className="log-console"><div className="console-header"><i/><i/><i/><span>HEXGLOW / SYSTEM JOURNAL</span></div>{diag?.entries.length?diag.entries.map((l,i)=><div className="log-row" key={i}><time>{new Date(l.at).toLocaleTimeString()}</time><b className={l.level.toLowerCase()}>{l.level}</b><code>{l.event}</code><span>{l.message}</span></div>):<p>等待运行事件…</p>}</div><label>日志目录<input readOnly value={diag?.logDirectory||'桌面端启动后可用'}/></label><label>本地数据目录<input readOnly value={diag?.dataDirectory||'桌面端启动后可用'}/></label></section>}
{view==='settings'&&<SettingsPanel autoRecommendPreferred={automaticEnabled} keyStatus={keyStatus} autoRecommend={autoRecommend} setAutoRecommend={setAutoRecommend} autoRecommendStatus={autoRecommend?(automaticIssue()||autoRecommendStatus):autoRecommendStatus} model={model} setModel={setModel} apiKey={apiKey} setApiKey={setApiKey} consent={consent} setConsent={setConsent} models={models} clearModels={()=>setModels([])} modelStatus={modelStatus} onTestModel={()=>void testModel()} lockfile={lockfile} setLockfile={setLockfile} busy={busy||updateBusy==='install'} onResumeLive={resumeLive} storage={storage} budget={budget} setBudget={setBudget} days={days} setDays={setDays} dailyUsed={dailyUsed} onConfirm={setConfirmation} onMaintenance={maintenance}><section className="panel settings-card"><div className="settings-card-head"><div><div className="eyebrow">UPDATE</div><h2><b>04</b> 应用更新</h2><p>从配置的更新源检查新版本，签名校验通过才允许安装。</p></div><span className={updateInfo?'settings-state ready':'settings-state'}>{updateInfo?`发现 ${updateInfo.version}`:appVersion?`当前 ${appVersion}`:'当前版本'}</span></div><div className="settings-inline-fields"><button disabled={!isTauri()||updateBusy!=='idle'} onClick={()=>void checkUpdate()}>{updateBusy==='check'?'检查中…':'检查更新'}</button>{updateInfo&&<button className="accent" disabled={busy||updateBusy!=='idle'} onClick={()=>void installUpdate()}>{updateBusy==='install'?(updateProg!=null?`下载中 ${updateProg}%`:'安装中…'):`下载并安装 ${updateInfo.version}`}</button>}</div>{updateErr&&<p className="hint">检查失败：{updateErr}</p>}{!updateErr&&updateInfo===null&&<p className="hint">已是最新版本，没有发现新更新。</p>}{updateInfo&&<p className="hint">发布于 {updateInfo.date?new Date(updateInfo.date).toLocaleString():'未知时间'}{updateInfo.body?` · ${updateInfo.body.slice(0,200)}`:''}</p>}<details className="settings-details"><summary>更新与数据安全</summary><p>更新来自 Hexglow 官方 GitHub Releases，下载后会校验更新签名。安装前先保存本地对局，随后自动退出并启动安装程序。更新不删除你的知识库、历史对局和模型设置；如遇网络问题，可手动下载安装包。更新签名不等于 Windows 发布者证书，系统仍可能显示安全确认。</p></details></section></SettingsPanel>}
 {confirmation&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label={confirmation.title}><h2>{confirmation.title}</h2><p>{confirmation.detail}</p><div className="archive-actions"><button onClick={()=>setConfirmation(null)}>取消</button><button className="danger" disabled={busy} onClick={()=>{const action=confirmation.action;setConfirmation(null);void action().catch(e=>setError(String(e)));}}>确认执行</button></div></section></div>}<footer><span>海萤 · HEXGLOW</span> 本地优先 / 证据驱动 / 由你决策 <span>{appVersion?`${appVersion} · `:''}WINDOWS TARGET</span></footer></div></div>;
}
function isOverlayWindow():boolean{
 if(new URLSearchParams(window.location.search).has('overlay'))return true;
 const internals=(window as unknown as {__TAURI_INTERNALS__?:{metadata?:{currentWindow?:{label?:string}}}}).__TAURI_INTERNALS__;
 return internals?.metadata?.currentWindow?.label==='overlay';
}
const overlayWindow=isOverlayWindow();
document.documentElement.classList.toggle('hexglow-overlay',overlayWindow);
createRoot(document.getElementById('root')!).render(overlayWindow?<OverlayApp/>:<App/>);
