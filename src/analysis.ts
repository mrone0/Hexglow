import type {Recommendation,Review,Session} from './domain';

export type AnalysisResult = {mode:'recommend';result:Recommendation}|{mode:'review';result:Review};

// 请求使用固定快照；采集继续更新同一局的落盘目标，包括跨局时的最终归档。
export class AnalysisTarget {
 readonly snapshot:Session;
 readonly at:string;
 private latest:Session;

 constructor(session:Session,at=new Date().toISOString()){
  this.snapshot=structuredClone(session);
  this.latest=session;
  this.at=at;
 }

 observe(session:Session){
  if(session.id===this.snapshot.id)this.latest=session;
 }

 complete(context:unknown,analysis:AnalysisResult):Session {
  const session=this.latest;
  return analysis.mode==='recommend'
   ?{...session,decisions:[...session.decisions,{at:this.at,context,result:analysis.result}]}
   :{...session,review:analysis.result};
 }
}
