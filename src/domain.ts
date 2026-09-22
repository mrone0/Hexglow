export type Player = { id: string; name: string; champion: string; team: string; items: unknown[]; augments: string[]; augmentsConfirmed: boolean };
export type Candidate = { id: string; name: string; description: string };
export type Recommendation = { ranking: { candidateId: string; score: number; reason: string; risks: string[] }[]; summary: string; missingInformation: string[] };
export type Review = { summary: string; lessons: string[]; caveats: string[] };
export type MatchResult = { status: 'win'|'loss'|'unknown'; source: 'live-game-end'|'lcu-eog'|'manual'|'unknown'; observedAt: string; gameId?: string; evidence?: unknown };
export type TimelineEntry = { at: string; phase: string; connection: string };
export type Session = { sampleCount?:number; schemaVersion?: number; id: string; createdAt: string; updatedAt?: string; endedAt?: string; matchId: string; ownPlayerId: string; players: Player[]; candidates: Candidate[]; notes: string; liveData: unknown; decisions: { at: string; result: Recommendation; context: unknown; chosenId?: string }[]; outcome: string; review?: Review; result?: MatchResult; phase?: string; timeline?: TimelineEntry[]; samples?: { at: string; data: unknown }[]; lcuSession?: unknown; endOfGame?: unknown; archived?: boolean };
export type CollectorSnapshot = { platformSupported: boolean; connection: string; phase: string; gameId: string|null; liveData: any|null; lcuSession: unknown|null; endOfGame: unknown|null; result: MatchResult|null; observedAt: string; warnings: string[] };
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
  if ((idChanged || timeReset || nextStart || newUnknownGame) && (current.players.length>0 || current.decisions.length>0 || current.matchId)) {
    completed={...current,archived:true,updatedAt:snap.observedAt};
    session=newSession();
  }
  session={...session,updatedAt:snap.observedAt,phase:snap.phase};
  if(snap.gameId) session.matchId=String(snap.gameId);
  if(hasLive) session=mergeLive(session,snap.liveData);
  if(snap.lcuSession) session.lcuSession=snap.lcuSession;
  // End-game payload is retained only when collector provides a matching game ID.
  if(snap.endOfGame && snap.gameId && session.matchId===String(snap.gameId)) session.endOfGame=snap.endOfGame;
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
