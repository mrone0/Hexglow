import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OverlayCandidates,reduceOverlayPublication,type OverlayPayload,type OverlayPublication} from './OverlayApp';
import type {ScoreResult} from './liveRecommendation';

const initial = ():OverlayPublication => ({sequence:-1,state:{level:null,status:'idle',message:'waiting',lines:[],candidates:[]}});
const recommendation = (sequence:number,id:string):OverlayPayload => ({sequence,level:7,ranking:{summary:'ranked',ranking:[{id,name:id,description:'effect',rarity:'gold',category:'damage',score:80,reason:'reason',risks:[]}]}});
const reset = (sequence:number):OverlayPayload => ({sequence,level:null,reset:true,ranking:{summary:'waiting',ranking:[]}});

describe('overlay ordered publications',()=>{
  it('replays the first recommendation and ignores an older ready response',()=>{
    const first = reduceOverlayPublication(initial(),recommendation(1,'first'));
    expect(first.state.candidates[0].id).toBe('first');
    const newest = reduceOverlayPublication(first,recommendation(3,'newest'));
    expect(reduceOverlayPublication(newest,recommendation(1,'first'))).toBe(newest);
    expect(reduceOverlayPublication(newest,reset(2))).toBe(newest);
  });

  it('clears the persistent window on close and accepts the next backend sequence',()=>{
    const first = reduceOverlayPublication(initial(),recommendation(1,'old'));
    const closed = reduceOverlayPublication(first,reset(2));
    expect(closed.state.candidates).toEqual([]);
    expect(closed.state.level).toBeNull();
    expect(closed.state.status).toBe('idle');
    expect(reduceOverlayPublication(closed,recommendation(1,'old'))).toBe(closed);
    const reopened = reduceOverlayPublication(closed,recommendation(3,'new'));
    expect(reopened.state.candidates[0].id).toBe('new');
    expect(reduceOverlayPublication(reopened,reset(2))).toBe(reopened);
    expect(reduceOverlayPublication(reopened,recommendation(3,'duplicate'))).toBe(reopened);
  });

  it('ready after close restores the reset when the frontend mounts again',()=>{
    const replay = reduceOverlayPublication(initial(),reset(2));
    expect(replay.sequence).toBe(2);
    expect(replay.state.candidates).toEqual([]);
    expect(replay.state.status).toBe('idle');
  });

  it('preserves the scoring hero for evidence-limited presentations and clears it on reset',()=>{
    const payload=recommendation(1,'candidate');payload.ranking.profile={champion:'岩雀'};payload.ranking.source='recognition';
    const publication=reduceOverlayPublication(initial(),payload);
    expect(publication.state.profile?.champion).toBe('岩雀');
    expect(publication.state.source).toBe('recognition');
    expect(reduceOverlayPublication(publication,reset(2)).state.profile).toBeUndefined();
    expect(reduceOverlayPublication(publication,reset(2)).state.source).toBeUndefined();
  });
});

describe('overlay evidence-aware candidates',()=>{
  const result = ():ScoreResult => ({source:'model',rankingReliable:true,summary:'已核实机制比较',ranking:[83,74,72].map((score,index)=>({
    id:String(index),name:`候选 ${index}`,description:`完整效果 ${index}`,rarity:'prismatic',category:'utility',
    score,displayScore:score,confidence:0.8,assessment:'supported',evidence:[`机制依据 ${index}`],reason:`理由 ${index}`,risks:[`风险 ${index}`],
  }))});
  const render = (value:ScoreResult) => renderToStaticMarkup(createElement(OverlayCandidates,{result:value}));

  it('keeps legacy scores and mixed evidence unranked without first-card emphasis',()=>{
    for(const value of [recommendation(1,'legacy').ranking,{...result(),rankingReliable:false},{...result(),ranking:result().ranking.map((item,index)=>index===2?{...item,assessment:'unresolved' as const,displayScore:null}:item)}]){
      const html=render(value);
      expect(html).not.toContain('overlay-rank');
      expect(html).not.toContain('overlay-score');
      expect(html).not.toContain('overlay-meter');
      expect(html).not.toContain('overlay-item top');
    }
    const html=render({...result(),rankingReliable:false});
    for(const text of ['完整效果 2','理由 2','风险 2','机制依据 2'])expect(html).toContain(text);
    expect(render(recommendation(1,'legacy').ranking)).toContain('依据有限');
  });

  it('shows equal ranks for equally supported scores and identifies them as non-win-rate scores',()=>{
    const value=result();value.ranking[1].displayScore=83;
    const html=render(value);
    expect(html.match(/并列第1/g)).toHaveLength(2);
    expect(html).toContain('第3');
    expect(html.match(/overlay-item top/g)).toHaveLength(2);
    expect(html).toContain('模型比较分 83，非胜率');
    expect(html).toContain('overlay-meter');
  });

  it('recognition and owned candidates cannot acquire preferred styling or score meters',()=>{
    const owned=result();owned.ranking[0].alreadyOwned=true;
    for(const value of [{...result(),source:'recognition' as const},owned]){
      const html=render(value);
      for(const forbidden of ['overlay-rank','overlay-score','overlay-meter','overlay-item top'])expect(html).not.toContain(forbidden);
    }
    expect(render({...result(),source:'recognition'})).toContain('待模型分析');
    expect(render(owned)).toContain('已拥有 · 不作为新选择');
  });

  it('retains complete long content and reserves scrolling for the list instead of shrinking cards',async()=>{
    const value=result();
    for(const item of value.ranking){item.description='完整长效果。'.repeat(100)+'效果末尾';item.reason='完整长依据。'.repeat(50)+'理由末尾';item.risks=['完整长风险。'.repeat(50)+'风险末尾'];}
    const html=render(value);
    for(const text of ['效果末尾','理由末尾','风险末尾'])expect(html.match(new RegExp(text,'g'))).toHaveLength(3);
    // Runtime-only test dependency: the client app's TypeScript configuration has no Node ambient types.
    const filesystemModule='node:fs';
    const {readFileSync}=await import(filesystemModule) as {readFileSync:(path:URL,encoding:'utf8')=>string};
    const css=readFileSync(new URL('./overlay.css',import.meta.url),'utf8');
    const rule=(selector:string)=>css.match(new RegExp(`${selector.replaceAll('.', '\\.')}\\s*\\{([^}]+)\\}`))?.[1]||'';
    expect(rule('.overlay-list')).toMatch(/min-height:\s*0/);
    expect(rule('.overlay-list')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.overlay-item')).toMatch(/flex:\s*0 0 auto/);
    for(const selector of ['.overlay-head','.overlay-status','.overlay-foot'])expect(rule(selector)).toMatch(/flex-shrink:\s*0/);
  });
});
