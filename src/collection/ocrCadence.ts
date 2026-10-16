/** Free OCR pacing only: unrelated to model authorization, usage quotas or request intervals. */
export type OcrCadenceResult={matched?:number;skipped?:boolean;elapsedMs?:number;probeOnly?:boolean;probeNext?:boolean;waitingForReady?:boolean};
export type OcrCadenceTicket=Readonly<{key:string;sequence:number;startedAt:number}>;

export const OCR_PANEL_IDLE_MS=350;
export const OCR_PANEL_MAX_IDLE_MS=700;
export const OCR_DISCOVERY_MAX_IDLE_MS=3000;
export const OCR_DISCOVERY_WINDOW_MS=60_000;
export const OCR_PANEL_GRACE_MS=12_000;
export const OCR_PASSIVE_IDLE_MS=10_000;
export const OCR_PROBE_IDLE_MS=500;
export const OCR_FIRST_MISS_IDLE_MS=700;
export const OCR_REPEATED_MISS_IDLE_MS=2000;
export const OCR_ABSENT_PANEL_IDLE_MS=3000;
export const OCR_SKIPPED_IDLE_MS=2000;
export const OCR_READY_RECHECK_MS=250;
export const OCR_MAX_IDLE_MS=60_000;

const validTime=(value:number)=>Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER-OCR_MAX_IDLE_MS;
const validKey=(key:string)=>typeof key==='string'&&key.trim().length>0;

/** The idle budget follows scan cost, capped safely even for overflow or invalid measurements. */
function measuredIdle(elapsedMs:unknown):number {
  if(elapsedMs===Infinity)return OCR_MAX_IDLE_MS;
  if(typeof elapsedMs!=='number'||!Number.isFinite(elapsedMs)||elapsedMs<=0)return 0;
  return Math.min(elapsedMs,OCR_MAX_IDLE_MS/3)*3;
}

/**
 * Pass a monotonic clock such as performance.now(), using the same clock for all
 * operations. isDue is a pure query: repeated poll/tick calls cannot move a
 * deadline or consume/reset a miss streak. begin reserves one observation and
 * returns its ticket; finish it once with complete, including error/skip paths.
 * The caller still owns the actual scanner lock across different choice keys.
 */
export class OcrCadence {
  private key:string|null=null;
  private misses=0;
  private discoveryAt:number|null=null;
  private lastPanelAt:number|null=null;
  private nextAt=0;
  private acceptedTime:number|null=null;
  private active:OcrCadenceTicket|null=null;
  private sequence=0;

  isDue(key:string,now:number):boolean {
    if(!validKey(key)||!validTime(now)||this.acceptedTime!==null&&now<this.acceptedTime)return false;
    // A newly observed match/round need not inherit the old panel's backoff.
    if(key!==this.key)return true;
    return this.active===null&&now>=this.nextAt;
  }

  /**
   * Remaining completion-to-next-scan budget. Infinity means the same-key scan
   * is still running or the supplied clock/key is invalid: do not pass that
   * value directly to setTimeout. Recheck after completion/reset instead.
   */
  remaining(key:string,now:number):number {
    if(!validKey(key)||!validTime(now))return Infinity;
    if(key===this.key&&this.active!==null)return Infinity;
    const clockWait=this.acceptedTime===null?0:Math.max(0,this.acceptedTime-now);
    return key!==this.key?clockWait:Math.max(clockWait,0,this.nextAt-now);
  }

  begin(key:string,now:number):OcrCadenceTicket|null {
    if(!this.isDue(key,now))return null;
    if(key!==this.key){this.key=key;this.misses=0;this.discoveryAt=null;this.lastPanelAt=null;}
    this.acceptedTime=now;
    this.sequence=this.sequence===Number.MAX_SAFE_INTEGER?1:this.sequence+1;
    const ticket=Object.freeze({key,sequence:this.sequence,startedAt:now});
    this.active=ticket;
    return ticket;
  }

  /** Stale, copied or already completed tickets never alter the current choice's pacing. */
  complete(ticket:OcrCadenceTicket,result:OcrCadenceResult,now:number):boolean {
    if(!ticket||ticket!==this.active||ticket.key!==this.key)return false;
    this.active=null;
    // Clock rollback/NaN cannot release a loop immediately. Window times use
    // the same accepted clock as the actual scan deadline.
    const anchor=validTime(now)?Math.max(now,this.acceptedTime??ticket.startedAt):this.acceptedTime??ticket.startedAt;
    const waitingForReady=result.waitingForReady===true;
    const skipped=result.skipped===true||waitingForReady;
    const probeOnly=result.probeOnly===true;
    const panel=!skipped&&!probeOnly&&typeof result.matched==='number'&&Number.isFinite(result.matched)&&result.matched>=2;
    // Foreground/loading skips cannot consume the new-level discovery window.
    if(!skipped&&this.discoveryAt===null)this.discoveryAt=anchor;
    if(panel)this.lastPanelAt=anchor;
    this.misses=panel||skipped?0:Math.min(4,this.misses+1);
    const base=skipped?OCR_SKIPPED_IDLE_MS:panel?OCR_PANEL_IDLE_MS:
      this.misses>=4?OCR_ABSENT_PANEL_IDLE_MS:this.misses>=2?OCR_REPEATED_MISS_IDLE_MS:OCR_FIRST_MISS_IDLE_MS;
    // New level -> discovery, real panel -> refresh/animation grace, sustained
    // absence -> passive probing. A miss never proves a choice was selected.
    // These windows pace free capture only; they never authorize model calls.
    const recentPanel=this.lastPanelAt!==null&&anchor-this.lastPanelAt<=OCR_PANEL_GRACE_MS;
    const discovering=this.lastPanelAt===null&&this.discoveryAt!==null&&anchor-this.discoveryAt<=OCR_DISCOVERY_WINDOW_MS;
    const measured=measuredIdle(result.elapsedMs);
    const idle=waitingForReady?Math.max(OCR_READY_RECHECK_MS,measured):skipped?Math.max(base,measured):
      probeOnly?Math.max(OCR_PROBE_IDLE_MS,measured):
      result.probeNext===true&&!panel?OCR_PROBE_IDLE_MS:
      panel?Math.max(OCR_PANEL_IDLE_MS,Math.min(measured,OCR_PANEL_MAX_IDLE_MS)):
      recentPanel?OCR_PANEL_MAX_IDLE_MS:
      discovering?Math.max(base,Math.min(measured,OCR_DISCOVERY_MAX_IDLE_MS)):
      Math.max(OCR_PASSIVE_IDLE_MS,measured);
    this.acceptedTime=anchor;
    this.nextAt=anchor+idle;
    return true;
  }

  /** Discard pacing on an explicit tracking reset; all outstanding tickets become invalid. */
  reset():void {
    this.key=null;this.misses=0;this.discoveryAt=null;this.lastPanelAt=null;this.nextAt=0;this.acceptedTime=null;this.active=null;
  }
}
