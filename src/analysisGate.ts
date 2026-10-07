import type {CollectorSnapshot,Session} from './domain';
import {liveOverviewState} from './LiveOverview';

/** Every recommendation entry point must use the same live-data rule as the UI. */
export function analysisSource(mode:'recommend'|'review',target:Session,current:Session,snapshot:CollectorSnapshot|null,historical:boolean):Session {
 const selected=target.id===current.id?current:target;
 if(mode==='review')return selected;
 const display=liveOverviewState(current,snapshot,historical);
 if(target.id!==current.id||!display.live)throw new Error('当前没有可用的实时对局，本轮推荐已暂停。历史对局请使用“复盘本局”。');
 return {...current,liveData:display.data};
}
