import {describe,expect,it} from 'vitest';
import {OcrCadence,OCR_MAX_IDLE_MS,OCR_PANEL_MAX_IDLE_MS,OCR_DISCOVERY_MAX_IDLE_MS,OCR_DISCOVERY_WINDOW_MS,OCR_PANEL_GRACE_MS,OCR_PASSIVE_IDLE_MS,type OcrCadenceResult} from './ocrCadence';

const key=(session='session',match='123',band=1)=>JSON.stringify([session,match,band]);
function finish(cadence:OcrCadence,at:number,result:OcrCadenceResult,currentKey=key(),finishedAt=at){
  const ticket=cadence.begin(currentKey,at);
  expect(ticket).not.toBeNull();
  expect(cadence.complete(ticket!,result,finishedAt)).toBe(true);
  return ticket!;
}

describe('free OCR observation cadence',()=>{
  it('rechecks readiness after 250ms without consuming discovery or accepting retained candidates',()=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:3,waitingForReady:true,skipped:true});
    expect(cadence.isDue(key(),249)).toBe(false);expect(cadence.isDue(key(),250)).toBe(true);
    finish(cadence,250,{matched:0,elapsedMs:5000},key(),5250);
    expect(cadence.remaining(key(),5250)).toBe(OCR_DISCOVERY_MAX_IDLE_MS);
  });
  it('exposes a pure exact remaining budget, with an explicit in-flight/invalid sentinel',()=>{
    const cadence=new OcrCadence();
    expect(cadence.remaining(key(),0)).toBe(0);
    const ticket=cadence.begin(key(),0)!;
    expect(cadence.remaining(key(),100)).toBe(Infinity);
    expect(cadence.remaining(key('new'),100)).toBe(0);
    expect(cadence.complete(ticket,{matched:3,elapsedMs:300},300)).toBe(true);
    for(const [at,wait] of [[300,700],[600,400],[999,1],[1000,0],[5000,0]]){
      expect(cadence.remaining(key(),at)).toBe(wait);expect(cadence.remaining(key(),at)).toBe(wait);
      expect(cadence.isDue(key(),at)).toBe(wait===0);
    }
    expect(cadence.remaining(key('new'),301)).toBe(0);
    expect(cadence.remaining(key(),NaN)).toBe(Infinity);expect(cadence.remaining('',300)).toBe(Infinity);
  });

  it('never reports zero remaining after an accepted clock rolls backwards',()=>{
    const cadence=new OcrCadence();finish(cadence,1000,{matched:3},key(),1100);
    expect(cadence.remaining(key(),500)).toBe(950);
    expect(cadence.remaining(key('new'),500)).toBe(600);
    cadence.reset();expect(cadence.remaining(key(),500)).toBe(0);
  });
  it('allows the first scan immediately and makes repeated due checks pure',()=>{
    const cadence=new OcrCadence();
    expect(cadence.isDue(key(),0)).toBe(true);expect(cadence.isDue(key(),0)).toBe(true);
    const ticket=cadence.begin(key(),0)!;
    expect(cadence.isDue(key(),1000)).toBe(false);expect(cadence.begin(key(),1000)).toBeNull();
    expect(cadence.complete(ticket,{matched:3,elapsedMs:100},100)).toBe(true);
    for(const at of [100,200,449.9,449.9])expect(cadence.isDue(key(),at)).toBe(false);
    expect(cadence.isDue(key(),450)).toBe(true);expect(cadence.isDue(key(),450)).toBe(true);
    expect(cadence.begin(key(),450)).not.toBeNull();
  });

  it.each([2,3])('uses the complete visible-panel baseline for %i candidates',matched=>{
    const cadence=new OcrCadence();finish(cadence,100,{matched,elapsedMs:0});
    expect(cadence.isDue(key(),449)).toBe(false);expect(cadence.isDue(key(),450)).toBe(true);
  });

  it('backs off consecutive empty or incomplete frames and resets after a panel returns',()=>{
    const cadence=new OcrCadence();
    let now=0;
    for(const [matched,idle] of [[0,700],[1,2000],[0,2000],[0,3000],[0,3000],[3,350],[0,700]]){
      finish(cadence,now,{matched,elapsedMs:10});
      expect(cadence.isDue(key(),now+idle-1)).toBe(false);
      now+=idle;expect(cadence.isDue(key(),now)).toBe(true);
    }
  });

  it('treats skipped/error scans as a two-second pause, not as proof of another empty panel',()=>{
    const cadence=new OcrCadence();
    finish(cadence,0,{matched:0});finish(cadence,700,{matched:0});
    finish(cadence,2700,{matched:3,skipped:true,elapsedMs:10});
    expect(cadence.isDue(key(),4699)).toBe(false);expect(cadence.isDue(key(),4700)).toBe(true);
    finish(cadence,4700,{matched:0});
    expect(cadence.isDue(key(),5399)).toBe(false);expect(cadence.isDue(key(),5400)).toBe(true);
    finish(cadence,5400,{skipped:true}); // Caller maps thrown capture errors to skipped.
    expect(cadence.isDue(key(),7399)).toBe(false);expect(cadence.isDue(key(),7400)).toBe(true);
  });

  it.each([[{matched:3},700],[{matched:0},3000],[{skipped:true},5400]] as const)('bounds discovery/confirmation without reducing skip backoff: %j', (result,idle)=>{
    const cadence=new OcrCadence();finish(cadence,100,{...result,elapsedMs:1800},key(),1900);
    expect(cadence.isDue(key(),1900+idle-1)).toBe(false);expect(cadence.isDue(key(),1900+idle)).toBe(true);
  });

  it('does not turn a 2.2s first-panel inference into a further 6.6s wait',()=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:3,elapsedMs:2213},key(),2213);
    expect(cadence.remaining(key(),2213)).toBe(OCR_PANEL_MAX_IDLE_MS);
    expect(cadence.isDue(key(),2913)).toBe(true);
  });

  it('keeps pixel probes lightweight and prompt without counting their hints as a detected panel',()=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:3,probeOnly:true,elapsedMs:10});
    expect(cadence.remaining(key(),0)).toBe(500);
    finish(cadence,OCR_DISCOVERY_WINDOW_MS+1,{matched:0,elapsedMs:1});
    expect(cadence.remaining(key(),OCR_DISCOVERY_WINDOW_MS+1)).toBe(OCR_PASSIVE_IDLE_MS);
    const at=OCR_DISCOVERY_WINDOW_MS+1+OCR_PASSIVE_IDLE_MS;
    finish(cadence,at,{probeOnly:true,elapsedMs:10});
    expect(cadence.remaining(key(),at)).toBe(500);
  });

  it('does not reuse a slow failed inference budget as a delay before cheap probing',()=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:0,elapsedMs:5000,probeNext:true},key(),5000);
    expect(cadence.remaining(key(),5000)).toBe(500);
    finish(cadence,5500,{probeOnly:true,elapsedMs:10},key(),5510);
    expect(cadence.remaining(key(),5510)).toBe(500);
  });

  it('does not turn the logged 3.277s missed confirmation into another 9.831s wait',()=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:3,elapsedMs:100});
    finish(cadence,700,{matched:0,elapsedMs:3277},key(),3977);
    expect(cadence.remaining(key(),3977)).toBe(OCR_PANEL_MAX_IDLE_MS);
    finish(cadence,4677,{matched:0,elapsedMs:100},key(),4777);
    expect(cadence.remaining(key(),4777)).toBe(OCR_PANEL_MAX_IDLE_MS);
    finish(cadence,5477,{matched:3,elapsedMs:250},key(),5727);
    expect(cadence.remaining(key(),5727)).toBe(OCR_PANEL_MAX_IDLE_MS);
    cadence.reset();finish(cadence,0,{matched:0,elapsedMs:5000},key(),5000);
    expect(cadence.remaining(key(),5000)).toBe(OCR_DISCOVERY_MAX_IDLE_MS);
  });

  it('reduces sustained panel absence to passive probes without declaring a selection',()=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:3});
    finish(cadence,OCR_PANEL_GRACE_MS,{matched:0});
    expect(cadence.remaining(key(),OCR_PANEL_GRACE_MS)).toBe(OCR_PANEL_MAX_IDLE_MS);
    finish(cadence,OCR_PANEL_GRACE_MS+OCR_PANEL_MAX_IDLE_MS,{matched:0,elapsedMs:5000});
    expect(cadence.remaining(key(),OCR_PANEL_GRACE_MS+OCR_PANEL_MAX_IDLE_MS)).toBe(15000);
    finish(cadence,OCR_PANEL_GRACE_MS+OCR_PANEL_MAX_IDLE_MS+15000,{matched:0,elapsedMs:200});
    expect(cadence.remaining(key(),OCR_PANEL_GRACE_MS+OCR_PANEL_MAX_IDLE_MS+15000)).toBe(OCR_PASSIVE_IDLE_MS);
  });

  it('bounds new-level discovery, but foreground skips do not consume it',()=>{
    const cadence=new OcrCadence();finish(cadence,0,{skipped:true});
    finish(cadence,OCR_DISCOVERY_WINDOW_MS*2,{skipped:true});
    finish(cadence,OCR_DISCOVERY_WINDOW_MS*3,{matched:0,elapsedMs:2000});
    expect(cadence.remaining(key(),OCR_DISCOVERY_WINDOW_MS*3)).toBe(OCR_DISCOVERY_MAX_IDLE_MS);
    finish(cadence,OCR_DISCOVERY_WINDOW_MS*4+1,{matched:0,elapsedMs:200});
    expect(cadence.remaining(key(),OCR_DISCOVERY_WINDOW_MS*4+1)).toBe(OCR_PASSIVE_IDLE_MS);
  });

  it.each([7,11,15])('wakes level band %s immediately despite passive backoff in the previous band',band=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:3});
    finish(cadence,OCR_PANEL_GRACE_MS+1,{matched:0,elapsedMs:5000});
    const now=OCR_PANEL_GRACE_MS+2,next=key('session','123',band);
    expect(cadence.remaining(key(),now)).toBe(14999);
    expect(cadence.remaining(next,now)).toBe(0);
    finish(cadence,now,{matched:0,elapsedMs:5000},next);
    expect(cadence.remaining(next,now)).toBe(OCR_DISCOVERY_MAX_IDLE_MS);
  });

  it.each([NaN,-1,-Infinity,undefined])('falls back to the baseline for an invalid elapsed measurement %j',elapsedMs=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:3,elapsedMs});
    expect(cadence.isDue(key(),349)).toBe(false);expect(cadence.isDue(key(),350)).toBe(true);
  });

  it.each([20_000,Number.MAX_VALUE,Infinity])('caps oversized elapsed measurements safely at sixty seconds: %j',elapsedMs=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:3,elapsedMs:1});
    const afterGrace=OCR_PANEL_GRACE_MS+1;
    finish(cadence,afterGrace,{matched:0,elapsedMs});
    expect(cadence.isDue(key(),afterGrace+OCR_MAX_IDLE_MS-1)).toBe(false);expect(cadence.isDue(key(),afterGrace+OCR_MAX_IDLE_MS)).toBe(true);
  });

  it.each([key('next-session'),key('session','next-match'),key('session','123',7)])('lets a changed session/match/round start without old backoff: %s',nextKey=>{
    const cadence=new OcrCadence();finish(cadence,0,{matched:0,elapsedMs:2000});
    expect(cadence.isDue(key(),1)).toBe(false);
    expect(cadence.isDue(nextKey,1)).toBe(true);finish(cadence,1,{matched:0},nextKey);
    expect(cadence.isDue(nextKey,700)).toBe(false);expect(cadence.isDue(nextKey,701)).toBe(true);
  });

  it('does not let old, copied or repeated completions alter the new active choice',()=>{
    const cadence=new OcrCadence(),old=cadence.begin(key(),0)!;
    const nextKey=key('session','123',7),next=cadence.begin(nextKey,1)!;
    expect(cadence.complete(old,{skipped:true,elapsedMs:20_000},2)).toBe(false);
    expect(cadence.complete({...next},{matched:0},2)).toBe(false);
    expect(cadence.isDue(nextKey,50_000)).toBe(false);
    expect(cadence.complete(next,{matched:3},100)).toBe(true);
    expect(cadence.complete(next,{skipped:true,elapsedMs:20_000},101)).toBe(false);
    expect(cadence.isDue(nextKey,449)).toBe(false);expect(cadence.isDue(nextKey,450)).toBe(true);
  });

  it.each([NaN,Infinity,-Infinity,-1,Number.MAX_VALUE])('fails closed for an invalid begin/query clock %j',now=>{
    const cadence=new OcrCadence();
    expect(cadence.isDue(key(),now)).toBe(false);expect(cadence.begin(key(),now)).toBeNull();
    expect(cadence.begin(key(),0)).not.toBeNull();
  });

  it('does not use a backwards clock to bypass either the active ticket or its completion delay',()=>{
    const cadence=new OcrCadence(),ticket=cadence.begin(key(),1000)!;
    expect(cadence.isDue(key('other'),999)).toBe(false);
    expect(cadence.complete(ticket,{matched:3},500)).toBe(true);
    for(const at of [500,999,1000,1349])expect(cadence.isDue(key(),at)).toBe(false);
    expect(cadence.isDue(key(),1350)).toBe(true);
  });

  it.each([NaN,Infinity,-1])('anchors an invalid completion clock %j to the last accepted observation',now=>{
    const cadence=new OcrCadence(),ticket=cadence.begin(key(),1000)!;
    expect(cadence.complete(ticket,{matched:3},now)).toBe(true);
    expect(cadence.isDue(key(),1000)).toBe(false);expect(cadence.isDue(key(),1349)).toBe(false);
    expect(cadence.isDue(key(),1350)).toBe(true);
  });

  it('rejects empty keys and resets all pacing without resurrecting an old completion',()=>{
    const cadence=new OcrCadence();
    for(const invalid of ['', ' '])expect(cadence.begin(invalid,0)).toBeNull();
    const old=cadence.begin(key(),1000)!;cadence.reset();
    expect(cadence.complete(old,{matched:3},1001)).toBe(false);
    expect(cadence.isDue(key(),0)).toBe(true);
    finish(cadence,0,{matched:0});expect(cadence.isDue(key(),700)).toBe(true);
  });
});
