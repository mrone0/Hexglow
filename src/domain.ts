export type Player = { id: string; name: string; champion: string; team: string; items: unknown[]; augments: string[]; augmentsConfirmed: boolean };
export type Candidate = { id: string; name: string; description: string };
export type Recommendation = { ranking: { candidateId: string; score: number; reason: string; risks: string[] }[]; summary: string; missingInformation: string[] };
export type Review = { summary: string; lessons: string[]; caveats: string[] };
export type MatchResult = { status: 'win'|'loss'|'unknown'; source: 'live-game-end'|'lcu-eog'|'manual'|'unknown'; observedAt: string; gameId?: string; evidence?: unknown };
export type TimelineEntry = { at: string; phase: string; connection: string };
export type Session = { sampleCount?:number; schemaVersion?: number; id: string; createdAt: string; updatedAt?: string; endedAt?: string; matchId: string; ownPlayerId: string; players: Player[]; candidates: Candidate[]; notes: string; liveData: unknown; decisions: { at: string; result: Recommendation; context: unknown; chosenId?: string }[]; outcome: string; review?: Review; result?: MatchResult; phase?: string; timeline?: TimelineEntry[]; samples?: { at: string; data: unknown }[]; lcuSession?: unknown; endOfGame?: unknown; postGameFilledAt?: string; archived?: boolean };
export type PostGameAugmentsEntry = { key: string; augments: string[]; champion?: string; team?: string };
export type PostGameAugments = { players: PostGameAugmentsEntry[]; fields: string[] };
export type CollectorSnapshot = { platformSupported: boolean; connection: string; phase: string; gameId: string|null; liveData: any|null; lcuSession: unknown|null; endOfGame: unknown|null; postGameAugments?: PostGameAugments|null; result: MatchResult|null; observedAt: string; warnings: string[] };
export const newSession = (): Session => ({ schemaVersion:2,id: crypto.randomUUID(), createdAt: new Date().toISOString(), matchId: '', ownPlayerId: '', players: [], candidates: [1,2,3].map(n => ({id: String(n), name:'', description:''})), notes:'', liveData:null, decisions:[], outcome:'', timeline:[], samples:[], result:{status:'unknown',source:'unknown',observedAt:new Date().toISOString()} });
export const endPhases = new Set(['PreEndOfGame','EndOfGame','WaitingForStats']);
export function mergeLive(session: Session, raw: any): Session {
  if (!raw || !Array.isArray(raw.allPlayers) || raw.allPlayers.length === 0) throw new Error('本地 API 未提供有效玩家列表');
  const previousTime = (session.liveData as any)?.gameData?.gameTime;
  const currentTime = raw.gameData?.gameTime;
  if (typeof previousTime === 'number' && typeof currentTime === 'number' && currentTime + 15 < previousTime) throw new Error('游戏时间回退，必须开始新对局');
  const players = raw.allPlayers.map((p: any, index: number): Player => {
    const id = p.riotId || p.summonerName || `${p.team}:${index}`;
    const old = session.players.find(x => x.id === id && x.champion === p.championName);
    return { id, name: p.riotId || p.summonerName || id, champion: p.championName || '', team: p.team || 'UNKNOWN', items: Array.isArray(p.items) ? p.items : [], augments: old?.augments || [], augmentsConfirmed: old?.augmentsConfirmed || false };
  });
  const active = raw.activePlayer?.riotId || raw.activePlayer?.summonerName;
  return { ...session, liveData: raw, players, ownPlayerId: players.some((p: Player) => p.id === session.ownPlayerId) ? session.ownPlayerId : players.find((p: Player) => p.id === active)?.id || '' };
}
const keyOf=(value?:string)=>String(value||'').trim().toLowerCase();
// 赛后证据按身份挂回玩家：只做并集与已核实标记，不覆盖已录入的内容。
// 身份对不上时（被遮蔽的玩家在实时接口里只有 "#"），退回「英雄 + 阵营」兜底匹配：
// 在场玩家与赛后条目两边都必须唯一才认，拿不准就不认，绝不张冠李戴。
export function fillPostGameAugments(session:Session, entries:PostGameAugmentsEntry[]):Session {
  if(!entries?.length||!session.players.length) return session;
  const used=new Set<number>();
  const pick=(player:Player)=>{
    const names=new Set([player.id,player.name,player.id.split('#')[0],player.name.split('#')[0]].map(keyOf).filter(Boolean));
    // 身份对上但英雄对不上时也不认：同名不同人的局面宁可不填。
    const byIdentity=entries.findIndex((item,index)=>!used.has(index)&&names.has(keyOf(item.key))&&item.augments?.length&&(!item.champion||!player.champion||keyOf(item.champion)===keyOf(player.champion)));
    if(byIdentity>=0) return byIdentity;
    const champion=keyOf(player.champion),team=keyOf(player.team);
    if(!champion) return -1;
    const twins=session.players.filter(p=>keyOf(p.champion)===champion&&keyOf(p.team)===team).length;
    if(twins!==1) return -1;
    const fallback=entries.reduce<number[]>((found,item,index)=>{
      if(used.has(index)||!item.augments?.length||keyOf(item.champion)!==champion) return found;
      if(item.team) return keyOf(item.team)===team?[...found,index]:found;
      // 条目没带阵营时，只有全场该英雄唯一才敢认。
      return session.players.filter(p=>keyOf(p.champion)===champion).length===1?[...found,index]:found;
    },[]);
    return fallback.length===1?fallback[0]:-1;
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
  // End-game payload is retained only when collector provides a matching game ID.
  if(snap.endOfGame && snap.gameId && session.matchId===String(snap.gameId)) session.endOfGame=snap.endOfGame;
  // 对局结束后自动补上一局：把 EOG / 比赛历史读到的海克斯挂回本局玩家。
  if(snap.postGameAugments?.players?.length && snap.gameId && session.matchId===String(snap.gameId)) session=fillPostGameAugments(session,snap.postGameAugments.players);
  if(snap.result && snap.result.status!=='unknown' && (!snap.result.gameId || snap.result.gameId===session.matchId)) {
    // Never overwrite automatic evidence with an unconfirmed/manual observation.
    session.result=snap.result;
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
