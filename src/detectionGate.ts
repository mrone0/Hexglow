import type {CollectorSnapshot,Session} from './domain';
import {liveOverviewState} from './LiveOverview';
import {observedChoiceBand} from './choiceContext';
import {hasGameStart} from './gameStart';

/** Never infer an active OCR round from a retained session's last known level. */
export function liveDetectionBand(session:Session,snapshot:CollectorSnapshot|null,historical:boolean):number|null {
 const display=liveOverviewState(session,snapshot,historical);
 if(!display.live)return null;
 const band=observedChoiceBand(session,display.data,snapshot?.observedAt);
 if(band===1&&(!hasGameStart(display.data)||!session.matchId||snapshot?.gameId!==session.matchId||
  session.ocrOpening?.gameId===session.matchId&&session.ocrOpening.advanced))return null;
 return band;
}
