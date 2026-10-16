import {endPhases,phaseLabel,type Session,type CollectorSnapshot} from './domain';
import {hasGameStart} from './gameStart';

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
