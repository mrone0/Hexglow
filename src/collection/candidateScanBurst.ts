export const CANDIDATE_RECHECK_MS=550;
export const CANDIDATE_BURST_WINDOW_MS=6000;
export const CANDIDATE_BURST_MAX_SCANS=4;

/** A bounded budget for real OCR rechecks, never a substitute for fresh scans. */
export class CandidateScanBurst {
 private key:string|null=null;
 private startedAt=0;
 private lastNow:number|null=null;
 private scans=0;
 private invalid=false;

 arm(key:string,now:number):void {
  if(!this.observeClock(now))return;
  if(!key.trim()||key===this.key)return;
  this.key=key;
  this.startedAt=now;
  this.scans=0;
  this.invalid=false;
 }

 take(now:number,delay=CANDIDATE_RECHECK_MS):number|null {
  if(!this.observeClock(now)||this.key===null||this.invalid)return null;
  if(!Number.isFinite(delay)||delay<0||this.scans>=CANDIDATE_BURST_MAX_SCANS)return null;
  const due=now+delay;
  const deadline=this.startedAt+CANDIDATE_BURST_WINDOW_MS;
  if(now>=deadline||!Number.isFinite(due)||due>deadline)return null;
  this.scans+=1;
  return due;
 }

 /** Check again when a timer fires: background throttling must not extend the burst. */
 isActive(now:number):boolean {
  return this.observeClock(now)&&this.key!==null&&!this.invalid&&now<=this.startedAt+CANDIDATE_BURST_WINDOW_MS;
 }

 reset():void {
  this.key=null;
  this.startedAt=0;
  this.lastNow=null;
  this.scans=0;
  this.invalid=false;
 }

 private observeClock(now:number):boolean {
  if(!Number.isFinite(now)||now<0||(this.lastNow!==null&&now<this.lastNow)){
   this.invalid=true;
   return false;
  }
  this.lastNow=now;
  return true;
 }
}
