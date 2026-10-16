import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OverlayApp,OverlayCandidates,reduceOverlayPublication,type OverlayPayload,type OverlayPublication} from './OverlayApp';
import type {ScoreResult} from '../recommendation/liveRecommendation';
import type {RecommendationStatus} from '../recommendation/recommendationStatus';

const initial = ():OverlayPublication => ({sequence:-1,state:{level:null,status:'idle',message:'waiting',lines:[],candidates:[]}});
const recommendation = (sequence:number,id:string):OverlayPayload => ({sequence,level:7,ranking:{summary:'ranked',ranking:[{id,name:id,description:'effect',rarity:'gold',category:'damage',score:80,reason:'reason',risks:[]}]}});
const reset = (sequence:number):OverlayPayload => ({sequence,level:null,reset:true,ranking:{summary:'waiting',ranking:[]}});

describe('overlay ordered publications',()=>{
  it('retains validated analysis status, ignores stale updates and clears it on reset',()=>{
    const payload=recommendation(1,'candidate');
    payload.analysis={phase:'failed',code:'timeout',message:'请求超时'};
    const publication=reduceOverlayPublication(initial(),payload);
    expect(publication.state.analysis).toEqual(payload.analysis);
    const invalid={...payload,sequence:2,analysis:{phase:'invented',code:'x',message:'不可显示'} as unknown as RecommendationStatus};
    const normalized=reduceOverlayPublication(publication,invalid);
    expect(normalized.state.analysis?.phase).toBe('waiting');
    expect(normalized.state.analysis?.message).not.toContain('不可显示');
    expect(reduceOverlayPublication(normalized,payload)).toBe(normalized);
    expect(reduceOverlayPublication(normalized,reset(3)).state.analysis).toBeUndefined();
  });
  it('preserves snapshot freshness metadata through live publication and clears it on reset',()=>{
    const payload=recommendation(1,'candidate');payload.ranking.source='model';payload.ranking.contextChanged=true;payload.ranking.modelScoresValid=true;
    const publication=reduceOverlayPublication(initial(),payload);expect(publication.state.contextChanged).toBe(true);
    expect(reduceOverlayPublication(publication,reset(2)).state.contextChanged).toBeUndefined();
    expect(publication.state.modelScoresValid).toBe(true);
    expect(reduceOverlayPublication(publication,reset(2)).state.modelScoresValid).toBeUndefined();
  });
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
  it('distinguishes free recognition from separately enabled automatic model requests',()=>{
    const html=renderToStaticMarkup(createElement(OverlayApp));
    expect(html).toContain('自动推荐按已保存设置与数据授权触发');
    expect(html).toContain('识别免费 · 自动分析按设置触发');
    expect(html).not.toContain('模型分析由你主动发起');
    expect(html).not.toContain('不评分或自动调用模型');
  });

  const result = ():ScoreResult => ({source:'model',rankingReliable:true,modelScoresValid:true,summary:'已核实机制比较',ranking:[83,74,72].map((score,index)=>({
    id:String(index),name:`候选 ${index}`,description:`完整效果 ${index}`,rarity:'prismatic',category:'utility',
    score,displayScore:score,confidence:0.8,assessment:'supported',evidence:[`机制依据 ${index}`],reason:`理由 ${index}`,risks:[`风险 ${index}`],
  }))});
  const render = (value:ScoreResult) => renderToStaticMarkup(createElement(OverlayCandidates,{result:value}));

  it.each([['preparing','准备分析'],['analyzing','分析中'],['blocked','分析暂停'],['failed','分析失败']] as const)('keeps %s recognition cards neutral without repeating the global state', (phase,chip)=>{
    const html=renderToStaticMarkup(createElement(OverlayCandidates,{result:{...result(),source:'recognition'},analysis:{phase,code:'test',message:'安全简短状态'}}));
    expect(html).not.toContain(chip);
    expect(html).not.toContain('待模型分析');
    expect(html).not.toContain('class="overlay-score"');
    expect(html.match(/class="overlay-score-placeholder" aria-label="尚无模型评分">—<\/span>/g)).toHaveLength(3);
    expect(html).not.toContain('<button');
  });

  it('keeps legacy and invalid model score contracts unranked without first-card emphasis',()=>{
    for(const value of [recommendation(1,'legacy').ranking,{...result(),modelScoresValid:false},{...result(),ranking:result().ranking.map((item,index)=>index===2?{...item,score:NaN}:item)}]){
      const html=render(value);
      expect(html).not.toContain('overlay-rank');
      expect(html).not.toContain('class="overlay-score"');
      expect(html).not.toContain('overlay-meter');
      expect(html).not.toContain('overlay-item top');
      expect(html).not.toContain('综合推荐');
      expect(html.match(/class="overlay-score-placeholder"/g)).toHaveLength(value.ranking.length);
    }
    const html=render({...result(),rankingReliable:false});
    for(const text of ['完整效果 2','理由 2','风险 2','机制依据 2'])expect(html).toContain(text);
    expect(render(recommendation(1,'legacy').ranking)).toContain('aria-label="尚无模型评分"');
    expect(render({...result(),modelScoresValid:false}).match(/aria-label="已分析 · 未评分"/g)).toHaveLength(3);
  });

  it('sorts validated model scores and marks the best even when evidence confidence is limited',()=>{
    const value=result();value.rankingReliable=false;
    value.ranking=value.ranking.reverse().map(item=>({...item,assessment:'limited',confidence:0.2,displayScore:null,evidence:[]}));
    const html=render(value);
    expect(html.indexOf('候选 0')).toBeLessThan(html.indexOf('候选 1'));
    expect(html.indexOf('候选 1')).toBeLessThan(html.indexOf('候选 2'));
    expect(html.match(/overlay-recommendation/g)).toHaveLength(1);
    expect(html).toContain('综合推荐');
    for(const score of [83,74,72])expect(html).toContain(`模型比较分 ${score}，非胜率`);
    expect(html).toContain('效果与分析');
    expect(html).not.toMatch(/<details[^>]*\bopen/);
  });

  it('keeps one complete effect in each collapsed disclosure summary and details behind it',()=>{
    const value=result(),html=render(value);
    expect(html.match(/<details\b/g)).toHaveLength(3);
    expect(html.match(/<summary\b/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    for(const index of [0,1,2]){
      expect(html.match(new RegExp(`完整效果 ${index}`,'g'))).toHaveLength(1);
      expect(html).toMatch(new RegExp(`<summary aria-label="查看 候选 ${index} 的完整效果与分析"><span class="overlay-effect">完整效果 ${index}</span>[\\s\\S]*?</summary><span class="overlay-attributes">棱彩 · 功能</span><small class="overlay-reason">理由 ${index}</small>`));
      for(const text of [`理由 ${index}`,`机制依据 ${index}`,`风险 ${index}`])expect(html.match(new RegExp(text,'g'))).toHaveLength(1);
    }
  });

  it('separates neutral candidate numbering from validated rank and score presentation',()=>{
    const html=render({...result(),source:'recognition'});
    expect(html.match(/overlay-option/g)).toHaveLength(3);
    for(const number of ['01','02','03'])expect(html).toContain(`候选 ${number}`);
    expect(html.match(/棱彩 · 功能/g)).toHaveLength(3);
    for(const forbidden of ['overlay-rank','class="overlay-score"','overlay-meter','overlay-item top','综合推荐'])expect(html).not.toContain(forbidden);
    expect(html.match(/class="overlay-score-placeholder"/g)).toHaveLength(3);
  });

  it('shows equal ranks for equally supported scores and identifies them as non-win-rate scores',()=>{
    const value=result();value.ranking[1].score=83;
    const html=render(value);
    expect(html.match(/并列第1/g)).toHaveLength(2);
    expect(html).toContain('第3');
    expect(html.match(/overlay-item top/g)).toHaveLength(2);
    expect(html.match(/并列综合推荐/g)).toHaveLength(2);
    expect(html).toContain('模型比较分 83，非胜率');
    expect(html.match(/class="overlay-score"/g)).toHaveLength(3);
  });

  it('never promotes recognition or an owned candidate; recommends the highest eligible choice',()=>{
    const owned=result();owned.ranking[0].alreadyOwned=true;
    const html=render({...result(),source:'recognition'});
    for(const forbidden of ['overlay-rank','class="overlay-score"','overlay-meter','overlay-item top','综合推荐'])expect(html).not.toContain(forbidden);
    expect(html).not.toContain('待模型分析');
    const ownedHtml=render(owned);
    expect(ownedHtml).toContain('已拥有');
    expect(ownedHtml).toContain('aria-label="已拥有，不参与推荐">—</span>');
    expect(ownedHtml.match(/overlay-item top/g)).toHaveLength(1);
    expect(ownedHtml).toMatch(/overlay-item top[\s\S]*?候选 1/);
    expect(ownedHtml).not.toContain('模型比较分 83');
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
    const rule=(selector:string)=>css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*\\{([^}]+)\\}`))?.[1]||'';
    expect(rule('.overlay-list')).toMatch(/min-height:\s*0/);
    expect(rule('.overlay-list')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.overlay-item')).toMatch(/flex:\s*0 0 auto/);
    for(const selector of ['.overlay-head','.overlay-context','.overlay-foot'])expect(rule(selector)).toMatch(/flex-shrink:\s*0|flex:\s*0 0 auto/);
    expect(rule('.overlay-details .overlay-effect')).toMatch(/-webkit-line-clamp:\s*2/);
    expect(rule('.overlay-details[open] .overlay-effect')).toMatch(/max-height:\s*none/);
  });
});
