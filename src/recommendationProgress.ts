import type {Session} from './domain';
import type {RecommendationStatus} from './recommendationStatus';

/** In-memory choice identity only. Never send this key or candidate text to logs. */
export function recommendationProgressKey(session: Session): string {
  return JSON.stringify([session.id, session.matchId, session.candidateBand,
    session.candidates.map(candidate => [candidate.id,candidate.name,candidate.description,candidate.source]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}

/** A scan must not erase the actual failure of an already attempted choice. */
export class RecommendationProgress {
  private readonly states = new Map<string, RecommendationStatus>();
  private readonly failures = new Map<string, RecommendationStatus>();
  private readonly receipts = new Map<string, {knowledge:number;model:number;durable:boolean}>();
  get(session: Session): RecommendationStatus | undefined { return this.states.get(recommendationProgressKey(session)); }
  failure(session: Session): RecommendationStatus | undefined { return this.failures.get(recommendationProgressKey(session)); }
  recordResult(session:Session,at:string,knowledge:number,model:number,durable:boolean):void {
    this.receipts.set(`${session.id}:${at}`,{knowledge,model,durable});
  }
  isSaved(session:Session,at:string):boolean { return this.receipts.get(`${session.id}:${at}`)?.durable===true; }
  markSaved(session:Session):void {
    for(const decision of session.decisions){
      const key=`${session.id}:${decision.at}`,receipt=this.receipts.get(key);
      // Only acknowledge known results actually included in this successful write.
      // Never replace their original model/knowledge revisions or invent a receipt.
      if(receipt&&!receipt.durable)this.receipts.set(key,{...receipt,durable:true});
    }
  }
  canRestore(session:Session,at:string,knowledge:number,model:number):boolean {
    const receipt=this.receipts.get(`${session.id}:${at}`);
    return receipt?receipt.durable&&receipt.knowledge===knowledge&&receipt.model===model:knowledge===0;
  }
  set(session: Session, status: RecommendationStatus): boolean {
    const key = recommendationProgressKey(session), previous = this.states.get(key);
    if (previous?.phase === status.phase && previous.code === status.code && previous.message === status.message) return false;
    this.states.delete(key);
    this.states.set(key,status);
    if(status.phase==='failed')this.failures.set(key,status);
    if(status.phase==='preparing'||status.phase==='complete')this.failures.delete(key);
    if (this.states.size > 64) {const oldest=this.states.keys().next().value!;this.states.delete(oldest);this.failures.delete(oldest);}
    return true;
  }
}
