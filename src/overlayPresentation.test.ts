import {describe,expect,it} from 'vitest';
import {overlayPresentation} from './overlayPresentation';
import type {ScoreResult} from './liveRecommendation';
import type {RecommendationStatus} from './recommendationStatus';

const model = ():ScoreResult => ({source:'model',modelScoresValid:true,rankingReliable:false,contextChanged:true,
  summary:'冗长的机制、置信度、知识、历史说明。'.repeat(30),profile:{champion:'元素女皇'},
  ranking:[60,85,72].map((score,index)=>({id:String(index),name:`候选${index}`,description:'效果',rarity:'',category:'',score,
    reason:'详细理由',risks:[],evidence:[],assessment:'limited',displayScore:null,confidence:0.3})),
});

describe('compact overlay analysis status', () => {
  it.each(['waiting','analyzing'] as const)('keeps previous cards but withholds scores/recommendation while region is unconfirmed (%s)',phase=>{
    const result=model();result.contextChanged=false;
    const before=JSON.stringify(result);
    const status={phase,code:'choice-region-unavailable',message:'正在复核海克斯区域；此前结果尚未确认适用于当前画面。'};
    const uncertain=overlayPresentation(result,status);
    expect(uncertain.label).toBe('此前候选 · 复核中');
    expect(uncertain.candidates).toHaveLength(3);
    expect(uncertain.candidates.every(candidate=>candidate.displayScore===null&&candidate.rank===null&&!candidate.recommended)).toBe(true);
    expect(uncertain.status).toContain(status.message);
    expect(uncertain.footnote).toBe('区域复核中 · 未发布新推荐');
    expect(JSON.stringify(result)).toBe(before);
    const fresh=overlayPresentation(result,{phase:'complete',code:'saved-result',message:'本组已确认'});
    expect(fresh.candidates[0].displayScore).toBe(85);
    expect(fresh.candidates[0].recommended).toBe(true);
  });
  const recognition = (): ScoreResult => ({...model(), source: 'recognition', modelScoresValid: false});
  it.each([
    ['preparing', '正在准备知识', '已识别 · 准备分析', '准备分析'],
    ['analyzing', '模型正在分析', '模型分析中', '分析中'],
    ['blocked', '今日自动分析次数已用完', '自动分析暂停', '分析暂停'],
    ['failed', '请求超时，可在主窗口重试', '模型分析失败', '分析失败'],
    ['complete', '分析已完成，等待结果同步', '已分析 · 待同步', '等待结果同步'],
  ] as const)('shows the real %s state without fabricating scores', (phase, message, label, chip) => {
    const view = overlayPresentation(recognition(), {phase, code: 'test', message});
    expect(view.label).toBe(label);
    expect(view.status).toBe(`元素女皇 · ${message}`);
    expect(view.analysisChip).toBe(chip);
    expect(view.candidates.every(candidate => candidate.displayScore === null && !candidate.recommended)).toBe(true);
  });
  it('keeps a valid prior model result ranked even if a later analysis is waiting or failed', () => {
    for (const phase of ['waiting', 'preparing', 'analyzing', 'blocked', 'failed'] as const) {
      const view = overlayPresentation(model(), {phase, code: 'test', message: '不应覆盖已分析结果'});
      expect(view.label).toBe('已分析 · 此前结果');
      expect(view.status).toBe('元素女皇 · 按模型评分排序');
      expect(view.candidates[0].displayScore).toBe(85);
      expect(view.candidates[0].recommended).toBe(true);
    }
  });
  it('falls back conservatively for malformed status publications', () => {
    const view = overlayPresentation(recognition(), {phase: 'invalid', message: '不可显示'} as unknown as RecommendationStatus);
    expect(view.label).toBe('已识别 · 待分析');
    expect(view.status).toBe('元素女皇 · 等待稳定候选');
    expect(view.analysisChip).toBe('待模型分析');
  });
  it.each(['confirming-ocr','incomplete-ocr','ineligible-choice'])('labels %s as OCR work, not model inference', code => {
    const view = overlayPresentation(recognition(), {phase:'waiting',code,message:'正在复核；尚未调用模型。'});
    expect(view.label).toBe('候选复核中');
    expect(view.analysisChip).toBe('复核候选');
    expect(view.candidates.every(candidate => candidate.displayScore === null)).toBe(true);
  });
  it('distinguishes received scores from waiting for the model while persistence is pending', () => {
    const view = overlayPresentation(recognition(), {phase:'analyzing',code:'result-received',message:'已收到评分，正在保存并同步侧栏…'});
    expect(view.label).toBe('评分已返回 · 同步中');
    expect(view.analysisChip).toBe('同步评分');
    expect(view.candidates.every(candidate => candidate.displayScore === null)).toBe(true);
  });
  it('labels the short current-round check separately from model waiting',()=>{
    const view=overlayPresentation(recognition(),{phase:'waiting',code:'refreshing-context',message:'正在同步最新轮次；尚未调用模型。'});
    expect(view.label).toBe('正在确认轮次');expect(view.analysisChip).toBe('同步轮次');
    expect(view.candidates.every(candidate=>candidate.displayScore===null)).toBe(true);
  });
});

describe('compact overlay model ranking',()=>{
  it('shows the model result, sorts raw validated scores, and marks only the maximum without changing data',()=>{
    const result=model(),before=structuredClone(result),view=overlayPresentation(result);
    expect(view.candidates.map(item=>[item.id,item.displayScore,item.recommended])).toEqual([['1',85,true],['2',72,false],['0',60,false]]);
    expect(view.label).toBe('已分析 · 此前结果');
    expect(view.status).toBe('元素女皇 · 按模型评分排序');
    expect(view.footnote).toBe('模型评分，非胜率 · 此前结果');
    expect(view.status.length).toBeLessThan(40);
    expect(result).toEqual(before);
  });
  it.each([NaN,Infinity,-1,101,undefined])('does not fabricate a recommendation for invalid or missing score %s',score=>{
    const result=model();result.ranking[0].score=score;
    const view=overlayPresentation(result);
    expect(view.candidates.every(item=>item.displayScore===null&&!item.recommended)).toBe(true);
    expect(view.status).toContain('暂无可用评分');
  });
  it('requires the validated model contract and never ranks OCR or legacy heuristic scores',()=>{
    for(const result of [{...model(),modelScoresValid:false},{...model(),modelScoresValid:undefined},{...model(),source:'recognition' as const},{...model(),source:undefined}]){
      expect(overlayPresentation(result).candidates.every(item=>!item.recommended&&item.displayScore===null)).toBe(true);
    }
  });
  it('labels tied maximums honestly and excludes all owned candidates',()=>{
    const result=model();result.ranking[2].score=85;
    expect(overlayPresentation(result).candidates.filter(item=>item.recommended).map(item=>item.recommendationLabel)).toEqual(['并列综合推荐','并列综合推荐']);
    result.ranking.forEach(item=>{item.alreadyOwned=true;});
    expect(overlayPresentation(result).candidates.every(item=>!item.recommended&&item.rank===null)).toBe(true);
  });
});
