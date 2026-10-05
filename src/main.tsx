import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {emit,listen} from '@tauri-apps/api/event';
import {getVersion} from '@tauri-apps/api/app';
import {check} from '@tauri-apps/plugin-updater';
import {applySnapshot,blockers,fillPostGameAugments,hasContent,newSession,phaseLabel,postgameEntriesOf,resultLabel,type PostGameAugmentsEntry,type Session,type CollectorSnapshot,type Recommendation,type Review} from './domain';
import './style.css';
import './comfort.css';
import {Select} from './Select';
import {LiveOverview} from './LiveOverview';
import './live.css';
import {SaveQueue} from './saveQueue';
import './knowledge.css';
import './polish.css';
import {KnowledgePanel} from './KnowledgePanel';
import {nextTriggers,ownLevel,type TriggerState} from './level';
import {OverlayApp} from './OverlayApp';
import {RankingItemView,EngineBadge} from './Ranking';
import {DEFAULT_JEV_MODEL,DEFAULT_JEV_URL,SettingsPanel} from './SettingsPanel';
type KnowledgeResult={documents:{path:string;title:string;content:string;hash:string;sections?:string[]}[];missing:string[];warnings:string[];fingerprint:string};
type StorageStats={databaseBytes:number;sessionCount:number;sampleCount:number;budgetMb:number;retentionDays:number;budgetReached?:boolean};
type ModelConfig={provider?:'jev'|'openai';baseUrl:string;name:string;jsonMode?:boolean;maxTokens?:number;allowThirdParty?:boolean};
type Diagnostics={entries:{at:string;level:string;event:string;message:string}[];logDirectory:string;dataDirectory:string};
type OcrBucket={scans:number;hits:number;names:number};
type OcrStats={scans:number;hits:number;names:number;lastAt?:string|null;sources?:Record<string,OcrBucket>;byDay?:Record<string,OcrBucket>};
type UpdateInfo={version:string;date?:string;body?:string};
type HistoryEntry={id?:string;createdAt?:string;updatedAt?:string;ownChampion?:string;ownAugments?:string[];chosen?:string;result?:Session['result'];outcome?:string;review?:Review;similarity?:number;matched?:string[];sameChampion?:boolean};
export type OcrLine={text:string;score:number;x:number;y:number;width:number;height:number};
export type ScoredCandidate={id:string;name:string;description:string;rarity:string;category:string;score:number;reason:string;risks:string[]};
export type OcrScan={lines:OcrLine[];candidates:ScoredCandidate[];elapsedMs:number;source:string;model:string};
const augmentNote=(s:Session)=>{const count=s.players.reduce((n,p)=>n+p.augments.length,0);return count?` · ${count} 条海克斯`:'';};
export type ScoreResult={ranking:ScoredCandidate[];summary:string;profile?:{champion?:string;role?:string;ranged?:boolean|null;damage?:string}};
const USAGE_KEY='hexlens-analysis-usage';
const COOLDOWN_MS=8000;
function localDay(){const d=new Date();const p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function readUsage(){const date=localDay();try{const v=JSON.parse(localStorage.getItem(USAGE_KEY)||'null');if(v&&v.date===date&&Number.isFinite(v.count))return{date,count:Math.max(0,Math.floor(v.count))};}catch{}return{date,count:0};}
function bumpUsage(){const u=readUsage();const n=u.count+1;localStorage.setItem(USAGE_KEY,JSON.stringify({date:u.date,count:n}));return n;}
function App(){
 const [session,setSession]=useState<Session>(newSession), [history,setHistory]=useState<Session[]>([]),[archivePage,setArchivePage]=useState(0),[archiveDetail,setArchiveDetail]=useState<Session|null>(null);const archiveOffset=useRef(0);
 const current=useRef(session); const activeSession=useRef<Session|null>(null); const commit=(s:Session)=>{current.current=s;setSession(s);};
 const [model,setModel]=useState<ModelConfig>(()=>{const fallback:ModelConfig={provider:'jev',baseUrl:DEFAULT_JEV_URL,name:DEFAULT_JEV_MODEL};try{return JSON.parse(localStorage.getItem('hexlens-model')||'null')||fallback;}catch{return fallback;}});
 const [knowledge,setKnowledge]=useState<KnowledgeResult|null>(null);const [consent,setConsent]=useState(false);
 const [apiKey,setApiKey]=useState(''),[modelStatus,setModelStatus]=useState(''),[models,setModels]=useState<string[]>([]);
 const [storage,setStorage]=useState<StorageStats|null>(null),[budget,setBudget]=useState(128),[days,setDays]=useState(7);
 const [confirmation,setConfirmation]=useState<{title:string;detail:string;action:()=>Promise<void>}|null>(null);
 const debounce=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [lockfile,setLockfile]=useState(()=>localStorage.getItem('hexlens-lockfile')||'');
 const [auto,setAuto]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[view,setView]=useState('live'),[advancedOpen,setAdvancedOpen]=useState(false);
 const [snapshot,setSnapshot]=useState<CollectorSnapshot|null>(null),[diag,setDiag]=useState<Diagnostics|null>(null),[saved,setSaved]=useState('尚未保存');
 const [flash,setFlash]=useState(''),[dailyLimit,setDailyLimit]=useState(()=>{const n=Number(localStorage.getItem('hexlens-daily-budget')||'20');return Number.isFinite(n)&&n>0?Math.min(500,Math.floor(n)):20;}),[dailyUsed,setDailyUsed]=useState(()=>readUsage().count);const lastRun=useRef(0);
 const [ocr,setOcr]=useState<OcrStats|null>(null);
 const loadOcr=()=>{invoke<OcrStats>('ocr_stats').then(setOcr).catch(()=>setOcr(null));};
 const [updateInfo,setUpdateInfo]=useState<UpdateInfo|null|undefined>(undefined),[updateErr,setUpdateErr]=useState(''),[updateBusy,setUpdateBusy]=useState<'idle'|'check'|'install'>('idle'),[updateProg,setUpdateProg]=useState<number|null>(null),[appVersion,setAppVersion]=useState('');
 useEffect(()=>{if(isTauri())void getVersion().then(v=>setAppVersion(v)).catch(()=>{});},[]);
 const [similar,setSimilar]=useState<HistoryEntry[]>([]);
 const [historical,setHistorical]=useState(false);
 useEffect(()=>{localStorage.setItem('hexlens-daily-budget',String(dailyLimit));},[dailyLimit]);
 useEffect(()=>{if(!flash)return;const t=setTimeout(()=>setFlash(''),9000);return()=>clearTimeout(t);},[flash]);const reading=useRef(false),readingSince=useRef(0),pollSeq=useRef(0),epoch=useRef(0),lastSaved=useRef(0),busyRef=useRef(false);const writeQueue=useRef<Promise<unknown>>(Promise.resolve());const saver=useRef(new SaveQueue<Session>(value=>invoke('save_session',{session:value})));
 const config=useRef({lockfile,auto,historical,view});config.current={lockfile,auto,historical,view};const nextPoll=useRef(0),idleFailures=useRef(0);const trigger=useRef<TriggerState>({matchId:'',fired:[]});
  // 面板驱动识别：不依赖等级触发，对局中每次轮询都截屏，面板一出现就开侧栏并更新推荐；
  // 同一批海克斯不重复推送，换新一批（刷新）时重新打开并更新。
  const scanning=useRef(false),seenMatch=useRef(''),seenIds=useRef('');
  const detectAugments=(session:Session)=>{
   if(!isTauri()||scanning.current)return;
   if(seenMatch.current!==session.matchId){seenMatch.current=session.matchId;seenIds.current='';}
   const band=[1,7,11,15].filter(b=>b<=(ownLevel(session.liveData)??1)).pop()??1;
   scanning.current=true;
   void (async()=>{
    try{
     const scan=await invoke<OcrScan>('ocr_scan',{});
     const matched=scan.candidates??[];
     if(matched.length<2)return;
     const key=matched.map(c=>c.id).sort().join(',');
     if(key===seenIds.current)return;
     await invoke('overlay_open',{level:band});
     seenIds.current=key;
     void emit('overlay:ocr',{level:band,scan});
    }catch(error){void emit('overlay:ocr',{level:band,error:String(error)});}
    finally{scanning.current=false;}
   })();
  };
  useEffect(()=>{
  if(!isTauri())return;
  let active=true;const stops:(()=>void)[]=[];
  void listen<{level:number;scan?:OcrScan;error?:string}>('overlay:ocr',(event)=>{
   if(!active)return;
   const payload=event.payload||{};const matched=payload.scan?.candidates||[];
   if(matched.length<2)return;
   patch({candidates:matched.slice(0,3).map(c=>({id:c.id,name:c.name,description:c.description}))});
   const own=current.current.players.find(p=>p.id===current.current.ownPlayerId);
   void invoke<ScoreResult>('score_candidates',{ids:matched.map(c=>c.id),champion:own?.champion||null,level:payload.level??null,owned:own?.augments||[]})
    .then(ranking=>{void emit('overlay:scored',{level:payload.level,ranking});})
    .catch(()=>undefined);
  }).then(unlisten=>{if(active)stops.push(unlisten);else unlisten();}).catch(()=>undefined);
  return ()=>{active=false;stops.forEach(stop=>stop());};
 },[]);
useEffect(()=>{localStorage.setItem('hexlens-model',JSON.stringify(model));},[model]);
 useEffect(()=>{localStorage.setItem('hexlens-lockfile',lockfile);},[lockfile]);
 useEffect(()=>{window.scrollTo(0,0);setAdvancedOpen(false);setArchiveDetail(null);},[view]);
 useEffect(()=>{if(!advancedOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setAdvancedOpen(false);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[advancedOpen]);
 const refreshHistory=async()=>{const items=await invoke<Session[]>('list_sessions_light',{offset:archiveOffset.current*50});setHistory(items);return items;};
 const logs=async()=>setDiag(await invoke<Diagnostics>('diagnostics'));
 async function save(s=current.current){if(!hasContent(s))return;const copy=structuredClone(s);const task=saver.current.enqueue(copy);writeQueue.current=saver.current.idle();await task;setSaved(new Date().toLocaleTimeString());lastSaved.current=Date.now();if(config.current.view==='archive')await refreshHistory();}
 async function poll(){
  if(!isTauri()||busyRef.current||config.current.historical)return;
  // 卡死的 invoke 不能让采集永久停摆：超过 30 秒作废上一次任务，重新开始。
  if(reading.current){if(Date.now()-readingSince.current<30000)return;epoch.current++;}
  reading.current=true;readingSince.current=Date.now();const ticket=epoch.current;const seq=++pollSeq.current;
  try{
   const snap=await invoke<CollectorSnapshot>('collector_snapshot',{lockfilePath:config.current.lockfile.trim()||null});
   if(ticket!==epoch.current)return;setSnapshot(snap);
   idleFailures.current=snap.liveData||snap.gameId?0:idleFailures.current+1;
   nextPoll.current=Date.now()+(document.hidden?15000:idleFailures.current>5?15000:idleFailures.current>0?8000:3000);
   const previous=current.current;let base=previous;
   if(!snap.liveData&&!snap.gameId&&!previous.players.length)return; // idle: no knowledge/history DB load
   // Recover this exact identified game after restarting the assistant; never guess by hero/name.
   if(!previous.players.length&&!previous.matchId&&snap.gameId){const match=await invoke<Session|null>('get_session_by_match',{matchId:String(snap.gameId)});if(ticket!==epoch.current)return;if(match)base=match;}
    const applied=applySnapshot(base,snap);commit(applied.session);
    // 补录窗口不能被“窗口隐藏”的退避节奏错过：对局进行中最多 5 秒一次，结束后 60 秒内 3 秒一次。
    if(!applied.session.postGameFilledAt){const sinceEnd=applied.session.endedAt?Date.now()-Date.parse(applied.session.endedAt):Number.POSITIVE_INFINITY;const capture=applied.session.endedAt?sinceEnd<60000:applied.session.players.length>0;if(capture)nextPoll.current=Date.now()+(applied.session.endedAt?3000:Math.min(5000,nextPoll.current-Date.now()));}
    const levelStep=nextTriggers(trigger.current,applied.session.matchId,ownLevel(applied.session.liveData));trigger.current=levelStep.state;
    if(applied.session.phase==='InProgress')detectAugments(applied.session);
   if(applied.completed)await save(applied.completed);
   if(ticket!==epoch.current||current.current.id!==applied.session.id)return;
    if(hasContent(applied.session)&&(!!applied.completed||Date.now()-lastSaved.current>60000||previous.phase!==applied.session.phase||previous.result?.status!==applied.session.result?.status||previous.postGameFilledAt!==applied.session.postGameFilledAt))await save(current.current);
   // Logs are loaded only when the user opens the diagnostics page.
  }catch(e){setError(String(e));}finally{if(pollSeq.current===seq)reading.current=false;}
 }
 useEffect(()=>{if(!isTauri())return;const cleanup=setInterval(()=>{if(!busyRef.current&&!reading.current&&!current.current.players.length)void refreshStorage().then(s=>maintenance(s.budgetMb,s.retentionDays)).catch(e=>setError(String(e)));},30*60*1000);return()=>clearInterval(cleanup);},[]);
 useEffect(()=>{if(!isTauri())return;void poll();const timer=setInterval(()=>{if(config.current.auto&&Date.now()>=nextPoll.current)void poll();},3000);return()=>{clearInterval(timer);epoch.current++;};},[]);
 async function run(mode:'recommend'|'review',target:Session=current.current){
    if(!consent){setError('请先在模型设置中确认发送分析上下文给所配置的服务商。');return;}
   if(busyRef.current){setError('上一次分析还没结束，先等它完成再试。');return;}
   const wait=COOLDOWN_MS-(Date.now()-lastRun.current);
   if(wait>0){setError(`分析太密了，${Math.ceil(wait/1000)} 秒后再试，避免重复扣费。`);return;}
   const usedToday=readUsage().count;
   if(usedToday>=dailyLimit){setError(`今日分析已达 ${dailyLimit} 次上限（可在模型设置调整），次日自动重置。`);return;}
   lastRun.current=Date.now();epoch.current++;busyRef.current=true;setBusy(true);setError('');
   const selected=target;
  try{
   // Do not recursively embed earlier decision contexts or repeated sampled snapshots.
   const {samples,decisions,...rest}=selected;
    const evidence=await invoke<KnowledgeResult>('knowledge_retrieve',{context:selected});setKnowledge(evidence);
    const similarEntries=await invoke<HistoryEntry[]>('history_similarity',{session:{id:selected.id,ownPlayerId:selected.ownPlayerId,players:selected.players,candidates:selected.candidates,decisions:selected.decisions.map(d=>({at:d.at,chosenId:d.chosenId}))},limit:5});setSimilar(similarEntries);
    const context={...rest,knowledge:evidence,decisions:mode==='review'?decisions:[],history:similarEntries};
   const result=await invoke<Recommendation|Review>('analyze_structured',{request:{mode,context,model:{...model,provider:model.provider||'openai',apiKey}}});
    const next=mode==='recommend'?{...selected,decisions:[...selected.decisions,{at:new Date().toISOString(),context,result:result as Recommendation}]}:{...selected,review:result as Review};
    if(next.id===current.current.id)commit(next);else setArchiveDetail(d=>d&&d.id===next.id?next:d);
    await save(next);
   const used=bumpUsage();setDailyUsed(used);
   const eng=(result as Partial<Recommendation>).engine;
   setFlash(mode==='recommend'?`分析完成 · 今日第 ${used}/${dailyLimit} 次${eng?` · ${eng.latencyMs} ms · 上下文 ${Math.round((eng.inputBytes||0)/1024)} KiB`:''}`:`复盘完成 · 今日第 ${used}/${dailyLimit} 次`);
  }catch(e){setError(String(e));}finally{busyRef.current=false;setBusy(false);}
 }
 function resumeLive(){epoch.current++;if(debounce.current){clearTimeout(debounce.current);debounce.current=null;if(isTauri())void save(current.current).catch(e=>setError(String(e)));}if(config.current.historical&&activeSession.current){commit(activeSession.current);activeSession.current=null;}setHistorical(false);config.current.historical=false;void poll();}
 function patch(p:Partial<Session>){const next={...current.current,...p,updatedAt:new Date().toISOString()};commit(next);if(debounce.current)clearTimeout(debounce.current);if(isTauri())debounce.current=setTimeout(()=>{void save(current.current).catch(e=>setError(String(e)));debounce.current=null;},1500);}
 async function openArchive(id:string){busyRef.current=true;setBusy(true);try{if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}if(current.current.players.length)await save();let full=await invoke<Session>('get_session',{id});if(full.players.some(p=>!p.augments.length)){const payload=await invoke<unknown>('postgame_rescan',{session:full,lockfilePath:config.current.lockfile.trim()||null}).catch(()=>invoke<unknown>('postgame_entries',{session:full}).catch(()=>null));const entries=postgameEntriesOf(payload);const filled=entries.length?fillPostGameAugments(full,entries):full;if(filled!==full){full=filled;await save(filled);}}setArchiveDetail(full);}finally{busyRef.current=false;setBusy(false);}}
 async function checkUpdate(){if(!isTauri())return;setUpdateBusy('check');setUpdateErr('');try{const u=await check();setUpdateInfo(u?{version:u.version,date:u.date,body:u.body}:null);}catch(e){setUpdateErr(String(e));}finally{setUpdateBusy('idle');}}
 async function installUpdate(){if(!isTauri())return;setUpdateBusy('install');setUpdateErr('');setUpdateProg(0);try{const u=await check();if(!u){setUpdateInfo(null);setUpdateProg(null);return;}let got=0,total:number|null=null;await u.downloadAndInstall(event=>{if(event.event==='Started'){total=event.data.contentLength??null;}else if(event.event==='Progress'){got+=event.data.chunkLength;setUpdateProg(total?Math.min(99,Math.round(got/total*100)):null);}else setUpdateProg(100);});setFlash('更新已安装，应用会退出并启动安装器，重新打开即为新版本。');}catch(e){setUpdateErr(String(e));setUpdateProg(null);}finally{setUpdateBusy('idle');}}
 async function exportCurrent(target:Session){try{const path=await invoke<string>('export_session',{session:target});setFlash(`已导出本局到 ${path}`);}catch(e){setError(String(e));}}
 async function exportAll(){try{const r=await invoke<{path:string;count:number;bytes:number}>('export_history');setFlash(`已导出 ${r.count} 场对局到 ${r.path}（${(r.bytes/1024/1024).toFixed(1)} MB）`);}catch(e){setError(String(e));}}
 async function rescanArchive(){if(!archiveDetail)return;busyRef.current=true;setBusy(true);try{const payload=await invoke<unknown>('postgame_rescan',{session:archiveDetail,lockfilePath:config.current.lockfile.trim()||null});const entries=postgameEntriesOf(payload);if(!entries.length){setError('客户端没有返回这局的海克斯证据：可能对局太久远、客户端未运行，或该局数据已读不到。');return;}const filled=fillPostGameAugments(archiveDetail,entries);setArchiveDetail(filled);await save(filled);}catch(e){setError(String(e));}finally{busyRef.current=false;setBusy(false);}}
 async function refreshStorage(){const s=await invoke<StorageStats>('storage_stats');setStorage(s);setBudget(s.budgetMb);setDays(s.retentionDays);return s;}
 async function maintenance(b=budget,d=days){await writeQueue.current.catch(()=>{});const s=await invoke<StorageStats>('maintain_storage',{budgetMb:b,retentionDays:d});setStorage(s);await refreshHistory();if(s.budgetReached===false)setError('核心记录仍超过预算，请删除不再需要的历史；不会自动删除你的决策。');}
 async function removeRecord(id:string){epoch.current++;busyRef.current=true;setBusy(true);try{if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}await writeQueue.current.catch(()=>{});await invoke('delete_session',{id});if(current.current.id===id){commit(newSession());setHistorical(true);config.current.historical=true;}if(activeSession.current?.id===id)activeSession.current=null;if(archiveDetail?.id===id)setArchiveDetail(null);await refreshHistory();await refreshStorage();}finally{busyRef.current=false;setBusy(false);}}
 async function removeAnalysis(at:string){epoch.current++;busyRef.current=true;setBusy(true);try{if(debounce.current){clearTimeout(debounce.current);debounce.current=null;}await save();const next=await invoke<Session>('delete_analysis',{sessionId:current.current.id,at});commit(next);await refreshHistory();await refreshStorage();}finally{busyRef.current=false;setBusy(false);}}
 async function testModel(){setModelStatus('正在检测…');try{const r=await invoke<{models:string[];latencyMs:number;note:string}>('test_provider',{model:{...model,provider:model.provider||'openai',apiKey}});setModels(r.models);setModelStatus(`${r.latencyMs} ms · ${r.note}`);}catch(e){setModelStatus(String(e));}}
 useEffect(()=>{if(!isTauri())return;if(view==='archive')void refreshHistory().catch(e=>setError(String(e)));if(view==='settings')void refreshStorage().catch(e=>setError(String(e)));if(view==='logs'){void logs().catch(e=>setError(String(e)));loadOcr();}},[view]);
 const errors=blockers(session),last=session.decisions.at(-1),own=session.players.find(p=>p.id===session.ownPlayerId);
 const updatePlayer=(id:string,p:Partial<Session['players'][number]>)=>patch({players:session.players.map(x=>x.id===id?{...x,...p}:x)});
 const verified=session.players.filter(p=>p.id===session.ownPlayerId&&p.augmentsConfirmed).length;
 const pageHero={
  knowledge:{title:'把知识，整理成可靠依据。',description:'校验、编辑并维护英雄与海克斯知识，让每次建议都能追溯来源。'},
  archive:{title:'让每场对局，成为下一次依据。',description:'回看本地对局、选择与复盘，不让有价值的经验散落。'},
  logs:{title:'每一次连接，清晰可追溯。',description:'查看本地运行轨迹与诊断信息，敏感凭据不会进入日志。'},
  settings:{title:'你的模型，你的数据。',description:'连接你选择的推理服务，并掌控客户端发现与本地存储。'}
 }[view]||{title:'海萤 · Hexglow',description:'海克斯决策 · 对局记忆'};
 return <div className="shell"><nav className="rail"><img className="emblem" src="/brand.svg" alt="海萤 Logo"/><span className="rail-label">HEXGLOW</span>{[['live','◈','对局洞察'],['knowledge','▧','知识工坊'],['archive','▤','对局档案'],['logs','⌁','运行日志'],['settings','⚙','本地设置']].map(([id,icon,label])=><button className={view===id?'nav-item active':'nav-item'} key={id} onClick={()=>setView(id)}><span>{icon}</span>{label}</button>)}<div className="rail-bottom"><i/>LOCAL FIRST<br/><small>WINDOWS DESKTOP</small></div></nav>
 <div className="workspace"><header><div><strong>海萤 <span>/ HEXGLOW</span></strong><small>海克斯决策 · 对局记忆</small></div><div className="header-status"><i className={snapshot?.liveData?'pulse':''}/>{historical?'历史回看':phaseLabel(snapshot?.phase)}<span>本地运行</span></div></header>
 {view!=='live'&&<section className="hero"><div><div className="eyebrow">READ THE RIFT. REFINE THE CHOICE.</div><h1>{pageHero.title}</h1><p>{pageHero.description}</p></div><img className="hero-mark" src="/brand.svg" alt="海萤 · 微光照见每种可能"/></section>}
 {!isTauri()&&<div className="notice">浏览器仅展示界面。启动 Tauri 桌面端后自动发现客户端；Windows 是正式验证目标。</div>}
 {flash&&<div className="notice" role="status">{flash}</div>}
 {error&&<div className="error" role="alert">{error}<button onClick={()=>setError('')}>关闭</button></div>}
 {view==='logs'&&snapshot?.warnings.map((w,i)=><div className="notice compact" key={i}>{w}</div>)}
 {view==='live'&&<><LiveOverview session={session} busy={busy} ready={!!model.name.trim()&&consent&&isTauri()} setupIssue={!isTauri()?'请使用 Windows 桌面端生成建议。':!model.name.trim()?'请先在本地设置填写模型名称并测试连接。':!consent?'请先在本地设置勾选“发送前确认”。':''} blockers={errors} onRun={()=>void run('recommend')} onSettings={()=>setView('settings')} onPatch={patch} historical={historical} onResume={resumeLive}/><div className="advanced-entry"><button className="advanced-open" onClick={()=>setAdvancedOpen(true)} aria-haspopup="dialog">高级 · 手动纠正、复盘与诊断 <span>↗</span></button></div>{advancedOpen&&<div className="advanced-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setAdvancedOpen(false);}}><section className="advanced-drawer" role="dialog" aria-modal="true" aria-labelledby="advanced-title"><div className="advanced-drawer-head"><div><span className="eyebrow">ADVANCED TOOLS</span><h2 id="advanced-title">手动纠正、复盘与诊断</h2></div><button onClick={()=>setAdvancedOpen(false)} aria-label="关闭高级面板">关闭</button></div><div className="advanced-content"><p className="hint">以下仅供需要时使用，正常查看推荐无需逐项操作。未识别信息保持未知，不需要为通过校验而确认空白。</p><div className="metrics"><div><span>CLIENT LINK</span><strong>{snapshot?.connection||'自动发现中'}</strong><small>LCU / Live Client API</small></div><div><span>MATCH PHASE</span><strong>{phaseLabel(session.phase)}</strong><small>{session.matchId?`对局 ${session.matchId}`:'等待可验证的对局 ID'}</small></div><div><span>CONTEXT COVERAGE</span><strong>{verified}<em> / 1</em></strong><small>只有本人海克斯可核实</small></div><div><span>LOCAL ARCHIVE</span><strong>{resultLabel(session.result)}</strong><small>最近保存 {saved}</small></div></div>
 <div className="toolbar"><span><i/> {historical?'正在查看历史快照，不会被实时数据覆盖':auto?'自动跟踪 · 对局 3 秒 / 待机 8–15 秒':'自动跟踪已暂停'}</span><label><input type="checkbox" checked={auto&&!historical} disabled={busy||!isTauri()} onChange={e=>{epoch.current++;setAuto(e.target.checked);if(e.target.checked){resumeLive();}}}/>自动跟踪</label><button className="ghost" disabled={busy||!isTauri()} onClick={()=>{epoch.current++;resumeLive();}}>立即同步</button><button disabled={busy||!isTauri()} onClick={()=>void save().catch(e=>setError(String(e)))}>保存快照</button></div>
 <main><div><section className="panel"><div className="section-title"><h2><b>01</b> 战场上下文</h2><span>API 事实 × 人工核验</span></div><label>当前英雄<Select disabled={busy} value={session.ownPlayerId} onChange={e=>patch({ownPlayerId:e.target.value})}><option value="">等待识别 / 选择当前玩家</option>{session.players.map(p=><option key={p.id} value={p.id}>{p.champion} · {p.name}</option>)}</Select></label>
 {!session.players.length&&<div className="empty"><div className="radar">◎</div><h3>已就绪，等待本地对局信号</h3><p>工具启动后自动查找已运行的客户端。<br/>进入游戏后，阵容会自动出现在这里。</p><small>不伪造阵容 · 不推测隐藏信息</small></div>}
 <div className="teams">{['ORDER','CHAOS'].map(team=><div key={team}><h3 className="team-title">{team==='ORDER'?'蓝色方':'红色方'}<span>{own?.team===team?'我方':'阵容'}</span></h3><div className="team-cards">{session.players.filter(p=>p.team===team).map(p=><article className={`player ${p.id===session.ownPlayerId?'selected':''}`} key={p.id}><div className="player-heading"><div className="avatar">{p.champion.slice(0,2)}</div><div><strong>{p.champion}</strong><small>{/^#+$/.test(p.name.trim())?'':p.name}</small></div><span>{p.id===session.ownPlayerId?'YOU':`${p.items.length} 装备`}</span></div>{p.id===session.ownPlayerId?<><textarea aria-label={`${p.name} 已选海克斯`} disabled={busy} placeholder="海克斯及完整效果，一行一项" value={p.augments.join('\n')} onChange={e=>updatePlayer(p.id,{augments:e.target.value.split('\n'),augmentsConfirmed:false})}/><label className="check"><input type="checkbox" checked={p.augmentsConfirmed} disabled={busy} onChange={e=>updatePlayer(p.id,{augmentsConfirmed:e.target.checked,augments:p.augments.filter(x=>x.trim())})}/>已核实我的海克斯（尚无也需确认）</label></>:(p.augments.length?<div className="player-augments">{p.augments.map(a=><span key={a}>{a}</span>)}<small>{p.augmentsConfirmed?'赛后数据已核实':'手动录入'}</small></div>:<p className="player-na">运行时拿不到他人的海克斯（本地 API 不提供），这里按未知处理，不会当作「没有」。</p>)}</article>)}</div></div>)}</div>
 <label>局势补充<textarea disabled={busy} value={session.notes} onChange={e=>patch({notes:e.target.value})} placeholder="版本 / 英雄机制 / 伤害类型 / 装备计划 / 当前局势…"/></label><details><summary>查看原始 API 快照与阶段时间线</summary><pre>{JSON.stringify({liveData:session.liveData,timeline:session.timeline},null,2)}</pre></details></section>
 <section className="panel"><div className="section-title"><h2><b>02</b> 海克斯抉择</h2><span>围绕 {own?.champion||'当前英雄'} 比较</span></div><div className="candidates">{session.candidates.map((c,i)=><div className="candidate" key={c.id}><div className="candidate-top">◇<span>OPTION 0{i+1}</span></div><input aria-label={`候选 ${i+1} 名称`} disabled={busy} placeholder="海克斯名称" value={c.name} onChange={e=>patch({candidates:session.candidates.map(x=>x.id===c.id?{...x,name:e.target.value}:x)})}/><textarea aria-label={`候选 ${i+1} 效果`} disabled={busy} placeholder="完整效果、数值、触发条件与限制" value={c.description} onChange={e=>patch({candidates:session.candidates.map(x=>x.id===c.id?{...x,description:e.target.value}:x)})}/></div>)}</div>{errors.length>0&&<div className="requirements"><strong>推荐前还需要</strong>{errors.map(e=><span key={e}>○ {e}</span>)}</div>}<button className="accent wide" disabled={busy||errors.length>0||!model.name.trim()||!isTauri()} onClick={()=>void run('recommend')}>{busy?'结构化分析中…':'生成契合度分析  →'}</button><p className="hint">不自动替你操作。模型判断不代表胜率；当前快照外的变化需重新分析。</p></section>
 {last&&<section className="panel"><div className="section-title"><h2><b>03</b> 决策洞察</h2><span>{new Date(last.at).toLocaleTimeString()} 的上下文</span></div><p>{last.result.summary} <EngineBadge engine={last.result.engine}/></p>{similar.length>0&&<p className="hint">历史相似局 {similar.length} 条 · 同英雄 {similar.filter(h=>h.sameChampion).length} 条 · 重叠海克斯 {[...new Set(similar.flatMap(h=>h.matched||[]))].slice(0,6).join('、')||'无'}</p>}{last.result.ranking.map((r,i)=><RankingItemView key={r.candidateId} item={r} index={i} candidates={(last.context as Session).candidates}/>)}{last.result.missingInformation.map((s,i)=><p className="notice" key={i}>{s}</p>)}<label>记录实际选择<Select value={last.chosenId||''} disabled={busy||!!last.chosenId} onChange={e=>patch({decisions:session.decisions.map((d,i)=>i===session.decisions.length-1?{...d,chosenId:e.target.value}:d)})}><option value="">尚未记录</option>{(last.context as Session).candidates.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</Select>{last.chosenId&&<span className="hint">选择已确认并锁定。</span>}</label></section>}
 {session.decisions.length>0&&<section className="panel analysis-list"><h2>分析记录管理</h2>{session.decisions.map(d=><div className="archive-actions" key={d.at}><span>{new Date(d.at).toLocaleString()} · {d.result.summary.slice(0,60)}</span><button className="danger" disabled={busy} onClick={()=>setConfirmation({title:'删除这条分析？',detail:'删除后不能恢复；基于该分析的旧复盘也会清除，避免继续引用已删除判断。',action:()=>removeAnalysis(d.at)})}>删除分析</button></div>)}</section>}
 {knowledge&&<section className="panel"><h2>本次知识检索依据</h2><p className="hint">指纹：{knowledge.fingerprint} · {knowledge.documents.length} 份文档</p>{knowledge.documents.map(d=><details key={d.path}><summary>{d.title} · {d.path}{d.sections?.length?` · 章节：${d.sections.join('、')}`:''}</summary><pre>{d.content}</pre></details>)}{[...knowledge.missing,...knowledge.warnings].map((w,i)=><p className="notice" key={i}>{w}</p>)}</section>}
 </div><aside><section className="panel focus"><div className="eyebrow">LOCAL INFERENCE</div><h2>专注此刻的最优解</h2><p>英雄契合、阵容补强、对手克制，来自同一个完整上下文。</p><div className="engine"><i/>{model.name||'本地模型尚未配置'}</div><button className="ghost wide" onClick={()=>setView('settings')}>配置推理引擎 ↗</button><small>Jev 结构化判断 / 普通模型统一适配。</small></section>
 <section className="panel"><div className="eyebrow">POST-GAME MEMORY</div><h2>赛果与复盘</h2><div className={`result ${session.result?.status||'unknown'}`}>{resultLabel(session.result)}<small>{session.result?.source||'unknown'}{session.endedAt?' · 已检测结束':''}</small></div><label>手动结果补充（不会覆盖 API 证据）<Select disabled={busy||!!session.result&& !['manual','unknown'].includes(session.result.source)} value={session.result?.source==='manual'?session.result.status:'unknown'} onChange={e=>patch({result:{status:e.target.value as 'win'|'loss'|'unknown',source:'manual',observedAt:new Date().toISOString()}})}><option value="unknown">未知 / 待确认</option><option value="win">胜利 · 用户补充</option><option value="loss">失败 · 用户补充</option></Select></label><label>赛后观察<textarea disabled={busy} value={session.outcome} onChange={e=>patch({outcome:e.target.value})} placeholder="关键转折、实际选择表现、未实现的预期…"/></label><button className="wide" disabled={busy||!session.decisions.length||(!session.outcome.trim()&&session.result?.status!=='win'&&session.result?.status!=='loss')||!model.name.trim()||!isTauri()} onClick={()=>void run('review')}>生成本地复盘</button>{session.review&&<div className="review"><p>{session.review.summary}</p><ul>{session.review.lessons.map((x,i)=><li key={i}>{x}</li>)}</ul>{session.review.caveats.map((x,i)=><small key={i}>{x}<br/></small>)}</div>}<p className="hint">结束阶段自动保存，不因断线判负。复盘需点击触发；历史经验只作为待验证假说。</p></section><section className="panel"><div className="eyebrow">DATA INTEGRITY</div><h2>有依据，也有边界</h2><p className="hint">阵容来自本地 API。海克斯缺失时由你补齐。原始证据与模型意见独立保存，不混淆观察和推断。</p><div className="privacy">✓ 本地 SQLite<br/>✓ 日志脱敏与轮转<br/>✓ 无自动点击 / 无内存读取</div></section></aside></main></div></section></div>}</>}
 {view==='knowledge'&&<KnowledgePanel onChanged={()=>{setKnowledge(null);setError('知识已更新。此前推荐基于旧版本；下次分析将重新读取文档。');}}/>}
 {view==='archive'&&<section className="panel">{archiveDetail?<div className="archive-detail"><div className="section-title"><h2>本局档案</h2><span>{new Date(archiveDetail.createdAt).toLocaleString()} · {archiveDetail.matchId||'尚无对局 ID'}</span></div><div className="detail-meta"><span className={`pill ${archiveDetail.result?.status||'unknown'}`}>{resultLabel(archiveDetail.result)}</span><span>决策 {archiveDetail.decisions.length} 次</span><span>采样 {archiveDetail.sampleCount||0} 份</span><span>海克斯 {archiveDetail.players.reduce((n,p)=>n+p.augments.length,0)} 条</span><span>{archiveDetail.review?'已复盘':'待复盘'}</span></div><div className="teams">{['ORDER','CHAOS'].map(team=><div key={team}><h3 className="team-title">{team==='ORDER'?'蓝色方':'红色方'}<span>{archiveDetail.players.find(p=>p.id===archiveDetail.ownPlayerId)?.team===team?'我方':'阵容'}</span></h3><div className="team-cards">{archiveDetail.players.filter(p=>p.team===team).map(p=><article className={`player ${p.id===archiveDetail.ownPlayerId?'selected':''}`} key={p.id}><div className="player-heading"><div className="avatar">{p.champion.slice(0,2)}</div><div><strong>{p.champion}</strong><small>{/^#+$/.test(p.name.trim())?'':p.name}</small></div><span>{p.id===archiveDetail.ownPlayerId?'YOU':`${p.items.length} 装备`}</span></div>{p.augments.length?<div className="player-augments">{p.augments.map(a=><span key={a}>{a}</span>)}<small>{p.augmentsConfirmed?'赛后数据已核实':'手动录入'}</small></div>:<p className="player-na">本局未记录这名玩家的海克斯。</p>}</article>)}</div></div>)}</div><div className="archive-actions detail-actions"><button className="accent" disabled={busy||!model.name.trim()||!isTauri()} onClick={()=>void run('recommend',archiveDetail)}>{busy?'分析中…':'AI 分析本局  →'}</button><button disabled={busy||!isTauri()} title="客户端在线时重新拉取本局赛后证据" onClick={()=>void rescanArchive()}>{busy?'处理中…':'重新补录海克斯'}</button><button disabled={!isTauri()} title="把这一局的完整 JSON 写到应用数据目录的 exports 文件夹" onClick={()=>void exportCurrent(archiveDetail)}>导出本局 JSON</button><button onClick={()=>setArchiveDetail(null)}>← 返回列表</button><button className="danger" disabled={busy} onClick={()=>setConfirmation({title:'删除这场对局？',detail:'将永久删除此对局、分析与复盘。当前游戏仍在进行时，重新跟踪可能再次建立记录。',action:()=>removeRecord(archiveDetail.id)})}>删除</button></div><p className="hint">推荐与候选只在对局进行中展示；这里直接看双方完整海克斯。海克斯缺失时打开档案会自动找客户端补一次，也可点「重新补录海克斯」手动重试（需客户端在运行）。AI 分析读取本局完整上下文（双方阵容与海克斯、你的选择），结果保存进这条档案。{model.name.trim()&&consent?'':'（先在本地设置配置模型并勾选「发送前确认」才能分析。）'}</p>{archiveDetail.decisions.map(d=><section className="panel sub" key={d.at}><div className="section-title"><h2>AI 分析 · {new Date(d.at).toLocaleString()}</h2><span>{d.chosenId?(d.context as Session).candidates.find(c=>c.id===d.chosenId)?.name||'已记录选择':'尚未记录选择'}</span></div><p>{d.result.summary} <EngineBadge engine={d.result.engine}/></p>{d.result.ranking.map((r,i)=><RankingItemView key={r.candidateId} item={r} index={i} candidates={(d.context as Session).candidates}/>)}{d.result.missingInformation.map((s,i)=><p className="notice" key={i}>{s}</p>)}</section>)}{archiveDetail.review&&<section className="panel sub"><div className="section-title"><h2>本局复盘</h2></div><div className="review"><p>{archiveDetail.review.summary}</p><ul>{archiveDetail.review.lessons.map((x,i)=><li key={i}>{x}</li>)}</ul>{archiveDetail.review.caveats.map((x,i)=><small key={i}>{x}<br/></small>)}</div></section>}</div>:<><div className="section-title"><h2>本地对局档案</h2><span>第 {archivePage+1} 页 · 每页 50 条摘要</span></div><div className="archive-grid">{history.length?history.map(h=><article className="archive-card" key={h.id}><span className={`pill ${h.result?.status||'unknown'}`}>{resultLabel(h.result)}</span><h3>{h.players.find(p=>p.id===h.ownPlayerId)?.champion||h.players[0]?.champion||'英雄未识别'}</h3><p>{new Date(h.createdAt).toLocaleString()}</p><small>{h.decisions.length} 次决策 · {h.sampleCount||0} 份采样 · {h.review?'已复盘':'待复盘'}{augmentNote(h)}</small><code>{h.matchId||'尚无对局 ID'}</code><div className="archive-actions"><button disabled={busy} onClick={()=>void openArchive(h.id).catch(e=>setError(String(e)))}>查看记录 ↗</button><button className="danger" disabled={busy} onClick={()=>setConfirmation({title:'删除这场对局？',detail:'将永久删除此对局、分析与复盘。当前游戏仍在进行时，重新跟踪可能再次建立记录。',action:()=>removeRecord(h.id)})}>删除</button></div></article>):<div className="empty">检测到对局后自动建立档案，无需手动开始记录。</div>}</div><div className="archive-actions"><button disabled={!archivePage||busy} onClick={()=>{archiveOffset.current--;setArchivePage(archiveOffset.current);void refreshHistory().catch(e=>setError(String(e)));}}>上一页</button><button disabled={history.length<50||busy} onClick={()=>{archiveOffset.current++;setArchivePage(archiveOffset.current);void refreshHistory().catch(e=>setError(String(e)));}}>下一页</button><button disabled={!isTauri()||busy} title="把全部对局写成一个 JSON 到应用数据目录的 exports 文件夹" onClick={()=>void exportAll()}>导出全部历史</button></div></>}</section>}
 {view==='logs'&&<section className="panel"><div className="section-title"><h2>识别命中率</h2><span>长期累计 · 本地统计</span></div>{ocr?<>
  <p>截屏识别 <b>{ocr.scans}</b> 次，命中 <b>{ocr.hits}</b> 次（{ocr.scans?(ocr.hits/ocr.scans*100).toFixed(1):'0.0'}%），命中时平均 {ocr.hits?(ocr.names/ocr.hits).toFixed(1):'0.0'} 个名字，累计识别到 {ocr.names} 个名字。</p>
  <p className="hint">真实截屏 {ocr.sources?.capture?.scans||0} 次 / 命中 {ocr.sources?.capture?.hits||0} 次；开发样本 fixture {ocr.sources?.file?.scans||0} 次 / 命中 {ocr.sources?.file?.hits||0} 次。最近一次 {ocr.lastAt?new Date(ocr.lastAt).toLocaleString():'尚无'}。计数存本地 ocr-stats.json，日志轮转不会冲掉历史。</p>
  <p className="hint">近 7 天（扫描/命中）：{Object.entries(ocr.byDay||{}).slice(-7).map(([d,s])=>`${d.slice(5)} ${s.scans}/${s.hits}`).join(' · ')||'尚无'}</p>
 </>:<p className="hint">等待第一次识别；桌面端截屏识别后自动累计。</p>}</section>}
 {view==='logs'&&<section className="panel"><div className="section-title"><h2>运行轨迹</h2><button onClick={()=>{void logs().catch(e=>setError(String(e)));loadOcr();}} disabled={!isTauri()}>刷新日志</button></div><p className="hint">限额轮转日志，仅记录状态变化；相同错误去重并限频。只在打开本页或手动刷新时读取，不持续刷盘。不记录令牌、玩家姓名或模型上下文。</p><div className="log-console"><div className="console-header"><i/><i/><i/><span>HEXGLOW / SYSTEM JOURNAL</span></div>{diag?.entries.length?diag.entries.map((l,i)=><div className="log-row" key={i}><time>{new Date(l.at).toLocaleTimeString()}</time><b className={l.level.toLowerCase()}>{l.level}</b><code>{l.event}</code><span>{l.message}</span></div>):<p>等待运行事件…</p>}</div><label>日志目录<input readOnly value={diag?.logDirectory||'桌面端启动后可用'}/></label><label>本地数据目录<input readOnly value={diag?.dataDirectory||'桌面端启动后可用'}/></label></section>}
 {view==='settings'&&<><SettingsPanel model={model} setModel={setModel} apiKey={apiKey} setApiKey={setApiKey} consent={consent} setConsent={setConsent} models={models} clearModels={()=>setModels([])} modelStatus={modelStatus} onTestModel={()=>void testModel()} lockfile={lockfile} setLockfile={setLockfile} busy={busy} onResumeLive={resumeLive} storage={storage} budget={budget} setBudget={setBudget} days={days} setDays={setDays} dailyLimit={dailyLimit} setDailyLimit={setDailyLimit} dailyUsed={dailyUsed} onConfirm={setConfirmation} onMaintenance={maintenance}/><section className="panel settings-card"><div className="settings-card-head"><div><div className="eyebrow">UPDATE</div><h2><b>04</b> 应用更新</h2><p>从配置的更新源检查新版本，签名校验通过才允许安装。</p></div><span className={updateInfo?'settings-state ready':'settings-state'}>{updateInfo?`发现 ${updateInfo.version}`:appVersion?`当前 ${appVersion}`:'当前版本'}</span></div><div className="settings-inline-fields"><button disabled={!isTauri()||updateBusy!=='idle'} onClick={()=>void checkUpdate()}>{updateBusy==='check'?'检查中…':'检查更新'}</button>{updateInfo&&<button className="accent" disabled={updateBusy!=='idle'} onClick={()=>void installUpdate()}>{updateBusy==='install'?(updateProg!=null?`下载中 ${updateProg}%`:'安装中…'):`下载并安装 ${updateInfo.version}`}</button>}</div>{updateErr&&<p className="hint">检查失败：{updateErr}</p>}{!updateErr&&updateInfo===null&&<p className="hint">已是最新版本，没有发现新更新。</p>}{updateInfo&&<p className="hint">发布于 {updateInfo.date?new Date(updateInfo.date).toLocaleString():'未知时间'}{updateInfo.body?` · ${updateInfo.body.slice(0,200)}`:''}</p>}<details className="settings-details"><summary>更新源与发布约定</summary><p>更新检查请求 tauri.conf.json 中 plugins.updater.endpoints 指向的 GitHub Releases latest.json；安装包用 %USERPROFILE%\.tauri\hexglow.key 的私钥签名，构建时通过 TAURI_SIGNING_PRIVATE_KEY（或 TAURI_SIGNING_PRIVATE_KEY_PATH）注入，createUpdaterArtifacts 会额外产出 .sig。仓库当前为 private，latest.json 不带 token 会 404，公开仓库或改用公开静态托管后才可用。Windows 用 passive 模式静默安装，安装阶段应用会自动退出。</p></details></section></>}
 {confirmation&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label={confirmation.title}><h2>{confirmation.title}</h2><p>{confirmation.detail}</p><div className="archive-actions"><button onClick={()=>setConfirmation(null)}>取消</button><button className="danger" disabled={busy} onClick={()=>{const action=confirmation.action;setConfirmation(null);void action().catch(e=>setError(String(e)));}}>确认执行</button></div></section></div>}<footer><span>海萤 · HEXGLOW</span> 本地优先 / 证据驱动 / 由你决策 <span>0.0.3 · WINDOWS TARGET</span></footer></div></div>;
}
function isOverlayWindow():boolean{
 if(new URLSearchParams(window.location.search).has('overlay'))return true;
 const internals=(window as unknown as {__TAURI_INTERNALS__?:{metadata?:{currentWindow?:{label?:string}}}}).__TAURI_INTERNALS__;
 return internals?.metadata?.currentWindow?.label==='overlay';
}
createRoot(document.getElementById('root')!).render(isOverlayWindow()?<OverlayApp/>:<App/>);
