export type AugmentSelection = {id:string; name:string; source:'manual-choice'; at:string; band?:number};
export type Player = { id: string; name: string; champion: string; team: string; items: unknown[]; augments: string[]; augmentsConfirmed: boolean; augmentSelections?:AugmentSelection[] };
export type Candidate = { id: string; name: string; description: string; source?:'manual'|'ocr' };
export type FactorScore = { key: string; label: string; score: number; confidence?: number | null; reason?:string; references?:string[] };
export type RankingItem = {
  candidateId: string;
  score: number;
  reason: string;
  risks: string[];
  factors?: FactorScore[];
  evidence?: string[];
  confidence?: number | null;
  modelScore?: number | null;
  localScore?: number | null;
  modelWeight?: number;
  alreadyOwned?: boolean;
};
export type Recommendation = { ranking: RankingItem[]; summary: string; missingInformation: string[]; engine?: { provider: string; model: string; latencyMs: number; inputBytes?: number; confidenceKind: string; scoringMode?: string } };
export type Review = { summary: string; lessons: string[]; caveats: string[] };
export type MatchResult = { status: 'win'|'loss'|'unknown'; source: 'live-game-end'|'lcu-eog'|'lcu-history'|'manual'|'unknown'; observedAt: string; gameId?: string; evidence?: unknown };
const evidenceGameId=(value:unknown):string|null=>{
 if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):null;
 if(typeof value!=='string'||!/^\d+$/.test(value))return null;
 const normalized=value.replace(/^0+/,'');
 return normalized||null;
};
/** Raw evidence must name this match itself; conflicting nested/top-level IDs are never trusted. */
export function matchingEndOfGame(sessionMatchId:string,raw:unknown):boolean {
 const expected=evidenceGameId(sessionMatchId);
 if(!expected||!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const payload=raw as Record<string,unknown>;
 const nested=payload.gameData&&typeof payload.gameData==='object'&&!Array.isArray(payload.gameData)?payload.gameData as Record<string,unknown>:null;
 const ids:unknown[]=[];
 if(Object.prototype.hasOwnProperty.call(payload,'gameId'))ids.push(payload.gameId);
 if(nested&&Object.prototype.hasOwnProperty.call(nested,'gameId'))ids.push(nested.gameId);
 return ids.length>0&&ids.every(value=>evidenceGameId(value)===expected);
}
/** Shared by polling and late recovery: an automatic outcome cannot be rewritten by a later contradiction. */
export function mergeMatchResult(current:MatchResult|undefined,incoming:Partial<MatchResult>|null|undefined,matchId:string):MatchResult|undefined {
 const official=(source:unknown)=>source==='live-game-end'||source==='lcu-eog'||source==='lcu-history';
 if(current&&(current.status==='win'||current.status==='loss')&&official(current.source))return current;
 if(!incoming||(incoming.status!=='win'&&incoming.status!=='loss')||!official(incoming.source)||typeof incoming.observedAt!=='string'||!incoming.observedAt)return current;
 const expected=evidenceGameId(matchId),received=typeof incoming.gameId==='string'?evidenceGameId(incoming.gameId):null;
 if(incoming.source==='live-game-end'&&incoming.gameId===undefined){
  // ID-less Live GameEnd remains usable for an unidentified live-only session,
  // but must not be attached to an already identified archive by assumption.
  if(matchId!=='')return current;
 }else if(!expected||received!==expected)return current;
 return incoming as MatchResult;
}
export type TimelineEntry = { at: string; phase: string; connection: string };
export type Session = { patch?:string; candidateBand?:number; sampleCount?:number; schemaVersion?: number; id: string; createdAt: string; updatedAt?: string; endedAt?: string; matchId: string; ownPlayerId: string; players: Player[]; candidates: Candidate[]; notes: string; liveData: unknown; decisions: { at: string; result: Recommendation; context: unknown; chosenId?: string }[]; outcome: string; review?: Review; result?: MatchResult; phase?: string; timeline?: TimelineEntry[]; samples?: { at: string; data: unknown }[]; lcuSession?: unknown; endOfGame?: unknown; postGameFilledAt?: string; archived?: boolean };
export type PostGameAugmentsEntry = { key: string; augments: string[]; champion?: string; team?: string };
export type PostGameAugments = { players: PostGameAugmentsEntry[]; fields: string[] };
export type CollectorSnapshot = { platformSupported: boolean; connection: string; phase: string; gameId: string|null; liveData: any|null; lcuSession: unknown|null; endOfGame: unknown|null; postGameAugments?: PostGameAugments|null; result: MatchResult|null; observedAt: string; warnings: string[] };
export const newSession = (): Session => ({ schemaVersion:2,id: crypto.randomUUID(), createdAt: new Date().toISOString(), matchId: '', ownPlayerId: '', players: [], candidates: [1,2,3].map(n => ({id: String(n), name:'', description:''})), notes:'', liveData:null, decisions:[], outcome:'', timeline:[], samples:[], result:{status:'unknown',source:'unknown',observedAt:new Date().toISOString()} });
export const endPhases = new Set(['PreEndOfGame','EndOfGame','WaitingForStats']);
const visibleIdentity=(...values:unknown[])=>values.map(value=>typeof value==='string'?value.trim():'').find(value=>value&&value!=='#')||'';
const maskedPlayerId=(team:unknown,index:number)=>`masked:${typeof team==='string'&&team.trim()?team:'UNKNOWN'}:${index}`;
// 已确认选择是已知的局部事实，不代表本人全部海克斯均已核实。
export function synchronizeSelections(session:Session):Session {
 const own=session.players.find(p=>p.id===session.ownPlayerId);
 if(!own)return session;
 const selections=[...(own.augmentSelections||[])],augments=[...own.augments];
 for(const decision of session.decisions){
  if(!decision.chosenId)continue;
  const context=decision.context as Partial<Session>|null;
  if(context?.id&&context.id!==session.id)continue;
  if(context?.matchId&&session.matchId&&context.matchId!==session.matchId)continue;
  const player=context?.players?.find(p=>p.id===context.ownPlayerId);
  if(!player||player.id!==own.id||player.champion!==own.champion)continue;
  const candidate=context?.candidates?.find(c=>c.id===decision.chosenId);
  if(!candidate?.name.trim())continue;
  // 已传播过的选择保留来源，但不能覆盖用户后续对已选列表的纠正。
  if(selections.some(s=>s.at===decision.at))continue;
  if(context?.candidateBand!==undefined&&selections.some(s=>s.band===context.candidateBand))continue;
  selections.push({id:candidate.id,name:candidate.name,source:'manual-choice',at:decision.at,band:context?.candidateBand});
  if(!augments.includes(candidate.name))augments.push(candidate.name);
 }
 if(selections.length===(own.augmentSelections?.length||0)&&augments.length===own.augments.length)return session;
 return {...session,players:session.players.map(p=>p===own?{...p,augments,augmentSelections:selections}:p)};
}
export function mergeLive(session: Session, raw: any): Session {
  if (!raw || !Array.isArray(raw.allPlayers) || raw.allPlayers.length === 0) throw new Error('本地 API 未提供有效玩家列表');
  const previousTime = (session.liveData as any)?.gameData?.gameTime;
  const currentTime = raw.gameData?.gameTime;
  if (typeof previousTime === 'number' && typeof currentTime === 'number' && currentTime + 15 < previousTime) throw new Error('游戏时间回退，必须开始新对局');
  const players = raw.allPlayers.map((p: any, index: number): Player => {
    const identity=visibleIdentity(p.riotId,p.summonerName);
    const id = identity || maskedPlayerId(p.team,index);
    const old = session.players.find(x => x.id === id && x.champion === p.championName);
    return { id, name: identity || `匿名玩家 ${index+1}`, champion: p.championName || '', team: p.team || 'UNKNOWN', items: Array.isArray(p.items) ? p.items : [], augments: old?.augments || [], augmentsConfirmed: old?.augmentsConfirmed || false, augmentSelections:old?.augmentSelections };
  });
  const active = visibleIdentity(raw.activePlayer?.riotId,raw.activePlayer?.summonerName);
  return synchronizeSelections({ ...session, liveData: raw, patch: typeof raw.gameData?.gameVersion==='string'?raw.gameData.gameVersion.split('.').slice(0,2).join('.'):session.patch, players, ownPlayerId: players.some((p: Player) => p.id === session.ownPlayerId) ? session.ownPlayerId : players.find((p: Player) => p.id === active)?.id || '' });
}
const keyOf=(value?:string)=>String(value||'').trim().toLowerCase();
const fullRiotId=(value:string)=>/^[^#]+#[^#]+$/.test(value);
const playerIdentities=(player:Player)=>player.id.startsWith('masked:')||player.id.trim()==='#'?[]:[player.id,player.name].map(keyOf).filter(name=>name&&name!=='#');
const weakPlayerNames=(player:Player)=>new Set(playerIdentities(player).map(name=>name.split('#')[0]));
// 赛后证据按身份挂回玩家：只做并集与已核实标记，不覆盖已录入的内容。
// 身份对不上时（被遮蔽的玩家在实时接口里只有 "#"），退回「英雄 + 阵营」兜底匹配：
// 在场玩家与赛后条目两边都必须唯一才认，拿不准就不认，绝不张冠李戴。
export function fillPostGameAugments(session:Session, entries:PostGameAugmentsEntry[]):Session {
  if(!entries?.length||!session.players.length) return session;
  const used=new Set<number>();
  const compatible=(player:Player,item:PostGameAugmentsEntry)=>!!item.augments?.length&&(!item.champion||!player.champion||keyOf(item.champion)===keyOf(player.champion))&&(!item.team||keyOf(item.team)===keyOf(player.team));
  const unique=(indices:number[])=>indices.length===1&&!used.has(indices[0])?indices[0]:-1;
  const pick=(player:Player)=>{
    const identities=playerIdentities(player),names=weakPlayerNames(player);
    // 完整 Riot ID 是强身份，优先于短姓名；即使 ID 相同，冲突阵营或英雄也不能采信。
    const strong=entries.reduce<number[]>((found,item,index)=>fullRiotId(keyOf(item.key))&&identities.includes(keyOf(item.key))?[...found,index]:found,[]);
    if(strong.length) return unique(strong.filter(index=>compatible(player,entries[index])));
    const weak=entries.reduce<number[]>((found,item,index)=>!fullRiotId(keyOf(item.key))&&names.has(keyOf(item.key))?[...found,index]:found,[]);
    if(weak.length){
      // 不按数组先后抢占弱姓名。即使一个条目带阵营，也可能已被旧版采集器
      // 把同名玩家的证据合并；全场重名时只能等待完整身份或独立路径证据。
      const unambiguous=weak.filter(index=>session.players.filter(p=>weakPlayerNames(p).has(keyOf(entries[index].key))).length===1);
      return unique(unambiguous.filter(index=>compatible(player,entries[index])));
    }
    const champion=keyOf(player.champion),team=keyOf(player.team);
    if(!champion) return -1;
    const twins=session.players.filter(p=>keyOf(p.champion)===champion&&keyOf(p.team)===team).length;
    if(twins!==1) return -1;
    const fallback=entries.reduce<number[]>((found,item,index)=>{
      if(!compatible(player,item)||keyOf(item.champion)!==champion) return found;
      const key=keyOf(item.key);
      // 已明确指向另一位可见玩家的条目，不得因英雄相同而再次兜底分配。
      if(fullRiotId(key)){
        if(identities.some(fullRiotId)||session.players.some(p=>playerIdentities(p).includes(key)))return found;
      }else if(session.players.some(p=>weakPlayerNames(p).has(key)))return found;
      if(item.team) return keyOf(item.team)===team?[...found,index]:found;
      // 条目没带阵营时，只有全场该英雄唯一才敢认。
      return session.players.filter(p=>keyOf(p.champion)===champion).length===1?[...found,index]:found;
    },[]);
    return unique(fallback);
  };
  const players=session.players.map(player=>{
    const index=pick(player);
    if(index<0) return player;
    used.add(index);
    const entry=entries[index];
    const augments=[...player.augments];
    for(const augment of entry.augments) if(augment.trim()&&!augments.includes(augment)) augments.push(augment);
    return augments.length===player.augments.length&&player.augmentsConfirmed?player:{...player,augments,augmentsConfirmed:true};
  });
  if(players.every((player,index)=>player===session.players[index])) return session;
  return {...session,players,postGameFilledAt:new Date().toISOString()};
}
// postgame_entries 返回 {players, fields}；顺带容忍按数组返回的形状，避免读 .length 静默拿到 undefined。
export const postgameEntriesOf = (payload: unknown): PostGameAugmentsEntry[] => {
  if (Array.isArray(payload)) return payload as PostGameAugmentsEntry[];
  const players = (payload as { players?: unknown } | null)?.players;
  return Array.isArray(players) ? (players as PostGameAugmentsEntry[]) : [];
};
// 只有内容值得进档案：既无玩家、分析、复盘，也没有任何手动补充的空壳不能归档，
// 也不能落库——对局结束重新排队时出现的空 ChampSelect 会直接复用它。
export const hasContent=(s:Session)=>s.players.length>0||s.decisions.length>0||!!s.review||!!s.notes.trim()||!!s.outcome.trim()||(!!s.result&&s.result.status!=='unknown')||s.candidates.some(c=>c.name.trim());
export function applySnapshot(current: Session, snap: CollectorSnapshot): {session:Session; completed?:Session} {
  const hasLive = Array.isArray(snap.liveData?.allPlayers) && snap.liveData.allPlayers.length>0;
  const oldTime = (current.liveData as any)?.gameData?.gameTime;
  const nextTime = snap.liveData?.gameData?.gameTime;
  const timeReset = hasLive && typeof oldTime==='number' && typeof nextTime==='number' && nextTime + 15 < oldTime;
  const idChanged = !!current.matchId && !!snap.gameId && current.matchId !== String(snap.gameId);
  const nextStart = !!current.endedAt && (snap.phase==='ChampSelect' || snap.phase==='GameStart') && current.phase!==snap.phase && !hasLive;
  const currentEndEvent = snap.liveData?.events?.Events?.some((e:any)=>e.EventName==='GameEnd');
  const newUnknownGame = !!current.endedAt && hasLive && !snap.gameId && !currentEndEvent && (!snap.result || snap.result.status==='unknown');
  let completed:Session|undefined;
  let session=current;
  if ((idChanged || timeReset || nextStart || newUnknownGame) && hasContent(current)) {
    completed={...current,archived:true,updatedAt:snap.observedAt};
    session=newSession();
  }
  session={...session,updatedAt:snap.observedAt,phase:snap.phase};
  if(snap.gameId) session.matchId=String(snap.gameId);
  if(hasLive) session=mergeLive(session,snap.liveData);
  if(snap.lcuSession) session.lcuSession=snap.lcuSession;
  // The envelope is not sufficient: validate the raw payload's own ID and keep
  // the first evidence, even if later same-match responses are empty/partial.
  if(!session.endOfGame && snap.gameId && session.matchId===String(snap.gameId) && matchingEndOfGame(session.matchId,snap.endOfGame)) session.endOfGame=snap.endOfGame;
  // 对局结束后自动补上一局：把 EOG / 比赛历史读到的海克斯挂回本局玩家。
  if(snap.postGameAugments?.players?.length && snap.gameId && session.matchId===String(snap.gameId)) session=fillPostGameAugments(session,snap.postGameAugments.players);
  const mergedResult=mergeMatchResult(session.result,snap.result,session.matchId);
  if(mergedResult!==session.result) {
    session.result=mergedResult;
    session.endedAt ??= snap.observedAt;
  }
  if(endPhases.has(snap.phase) && (session.matchId || session.players.length)) session.endedAt ??=snap.observedAt;
  const timeline=[...(session.timeline||[])];
  const previous=timeline.at(-1);
  if(previous?.phase!==snap.phase || previous?.connection!==snap.connection) timeline.push({at:snap.observedAt,phase:snap.phase,connection:snap.connection});
  session.timeline=timeline.slice(-200);
  const samples=[...(session.samples||[])];
  if(hasLive && (!samples.length || Date.parse(snap.observedAt)-Date.parse(samples.at(-1)!.at)>=15000)) samples.push({at:snap.observedAt,data:snap.liveData});
  session.samples=samples.slice(-30);
  return {session,completed};
}
export function blockers(s: Session): string[] {
  const errors: string[] = [];
  if (!s.players.some(p => p.id === s.ownPlayerId && p.champion)) errors.push('确认当前使用的英雄');
  if (s.players.some(p=>!['ORDER','CHAOS'].includes(p.team)) || new Set(s.players.map(p=>p.team)).size !== 2) errors.push('等待 API 提供双方阵容');
  if (s.candidates.length < 2 || s.candidates.some(c=>!c.name.trim() || !c.description.trim())) errors.push('填写候选名称与完整效果');
  return errors;
}
export const resultLabel=(r?:MatchResult)=>r?.status==='win'?'胜利':r?.status==='loss'?'失败':'结果待确认';
export const phaseLabel=(p?:string)=>({None:'客户端待机',Lobby:'游戏大厅',Matchmaking:'匹配中',ReadyCheck:'确认对局',ChampSelect:'英雄选择',GameStart:'正在载入',InProgress:'对局进行中',Reconnect:'等待重连',WaitingForStats:'等待结算',PreEndOfGame:'对局结束',EndOfGame:'赛后结算',Disconnected:'等待客户端',Unknown:'识别中'}[p||'']||p||'等待客户端');
