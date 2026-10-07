import type {CollectorSnapshot,Session} from './domain';
import {liveOverviewState} from './LiveOverview';
import {augmentBand,ownLevel} from './level';

/** Never infer an active OCR round from a retained session's last known level. */
export function liveDetectionBand(session:Session,snapshot:CollectorSnapshot|null,historical:boolean):number|null {
 const display=liveOverviewState(session,snapshot,historical);
 const level=ownLevel(display.data);
 return display.live&&level!==null?augmentBand(level):null;
}
