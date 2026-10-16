// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {OverlayApp,type OverlayPayload} from './OverlayApp';

const {invokeMock,listenMock}=vi.hoisted(()=>({invokeMock:vi.fn(),listenMock:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:invokeMock}));
vi.mock('@tauri-apps/api/event',()=>({listen:listenMock}));

function publication():OverlayPayload {
  return {sequence:1,level:7,ranking:{source:'model',modelScoresValid:true,rankingReliable:false,contextChanged:true,
    summary:'不要在侧栏显示这段冗长的模型解释。'.repeat(30),profile:{champion:'元素女皇'},
    ranking:[60,85,72].map((score,index)=>({id:String(index),name:`候选${index}`,description:`完整效果${index}`,
      score,rarity:'',category:'',reason:`详细分析${index}`,risks:[`风险${index}`],evidence:[`引用${index}`],
      assessment:'limited',confidence:0.3,displayScore:null})),
  }};
}

beforeEach(()=>{vi.clearAllMocks();listenMock.mockResolvedValue(()=>undefined);});
afterEach(cleanup);

describe('live compact sidebar',()=>{
  it('auto-collapse retains unconfirmed candidates behind the handle without clearing or reopening the window',async()=>{
    const payload=publication();
    payload.analysis={phase:'waiting',code:'choice-region-unavailable',message:'区域复核中'};
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(container.querySelectorAll('.overlay-item')).toHaveLength(3));
    const collapse=listenMock.mock.calls.find(([name])=>name==='overlay:collapsed')?.[1];
    expect(collapse).toBeTypeOf('function');
    collapse({payload:{collapsed:true,reason:'unconfirmed'}});
    await waitFor(()=>expect(screen.getByLabelText('展开侧栏')).toBeTruthy());
    expect(container.querySelectorAll('.overlay-item')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('展开侧栏'));
    expect(container.querySelectorAll('.overlay-item')).toHaveLength(3);
    expect(screen.getByText('此前候选 · 复核中')).toBeTruthy();
    expect(container.querySelectorAll('.overlay-score')).toHaveLength(0);
    expect(invokeMock.mock.calls.map(([command])=>command)).toEqual(['overlay_ready','overlay_set_collapsed']);
    expect(invokeMock).toHaveBeenCalledWith('overlay_set_collapsed',{collapsed:false});
  });
  it('marks unconfirmed previous cards without scores, then restores a freshly confirmed ranking',async()=>{
    const payload=publication();payload.ranking.contextChanged=false;
    payload.analysis={phase:'waiting',code:'choice-region-unavailable',message:'正在复核海克斯区域；此前结果尚未确认适用于当前画面。'};
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getByText('此前候选 · 复核中')).toBeTruthy());
    expect(container.querySelectorAll('.overlay-item')).toHaveLength(3);
    expect(container.querySelectorAll('.overlay-score')).toHaveLength(0);
    expect(container.textContent).not.toContain('综合推荐');
    expect(container.querySelector('.overlay-card')?.getAttribute('data-tone')).toBe('previous');
    const listener=listenMock.mock.calls.find(([name])=>name==='overlay:state')?.[1];
    listener({payload:{...payload,sequence:2,analysis:{phase:'complete',code:'saved-result',message:'已确认本组候选'}}});
    await waitFor(()=>expect(screen.getByText('综合推荐')).toBeTruthy());
    expect(container.querySelectorAll('.overlay-score')).toHaveLength(3);
    expect(invokeMock.mock.calls.some(([command])=>command==='overlay_close'||command==='overlay_open')).toBe(false);
  });
  it('shows failure and blocker reasons received with recognized candidates',async()=>{
    const payload=publication();payload.ranking.source='recognition';payload.ranking.modelScoresValid=false;
    payload.analysis={phase:'failed',code:'model-timeout',message:'请求超时，请到主窗口查看'};
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getByText('模型分析失败')).toBeTruthy());
    expect(screen.getByText('请求超时，请到主窗口查看')).toBeTruthy();
    expect(screen.queryByText('分析失败')).toBeNull();
    expect(container.textContent).not.toContain('待模型分析');
    expect(container.querySelectorAll('.overlay-score')).toHaveLength(0);
    expect(screen.getAllByLabelText('尚无模型评分')).toHaveLength(3);
    expect(container.querySelector('.overlay-card')?.getAttribute('data-tone')).toBe('failed');
    expect(screen.getByRole('status').textContent).toBe('元素女皇模型分析失败请求超时，请到主窗口查看');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(container.querySelectorAll('.overlay-status')).toHaveLength(1);
    expect(container.querySelectorAll('.overlay-item .overlay-analysis-note')).toHaveLength(0);
    const listener=listenMock.mock.calls.find(([name])=>name==='overlay:state')?.[1];
    expect(listener).toBeTypeOf('function');
    listener({payload:{...payload,sequence:2,analysis:{phase:'blocked',code:'daily-limit',message:'今日自动分析次数已用完'}}});
    await waitFor(()=>expect(screen.getByText('自动分析暂停')).toBeTruthy());
    expect(screen.getByText('今日自动分析次数已用完')).toBeTruthy();
    expect(screen.queryByText('分析暂停')).toBeNull();
    expect(container.querySelector('.overlay-card')?.getAttribute('data-tone')).toBe('blocked');
    expect(container.querySelectorAll('.overlay-score,.overlay-meter,.overlay-recommendation,.overlay-item.top')).toHaveLength(0);
    expect(invokeMock.mock.calls.every(([command])=>command==='overlay_ready')).toBe(true);
  });
  it('renders the published model result as compact ranked cards, keeping details collapsed',async()=>{
    invokeMock.mockResolvedValue(publication());
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getByText('综合推荐')).toBeTruthy());
    expect([...container.querySelectorAll('h3')].map(node=>node.textContent)).toEqual(['候选1','候选2','候选0']);
    expect(container.querySelectorAll('.overlay-score')).toHaveLength(3);
    expect(container.querySelectorAll('.overlay-item.top')).toHaveLength(1);
    expect(screen.getByText('已分析 · 此前结果')).toBeTruthy();
    expect(container.querySelector('.overlay-card')?.getAttribute('data-tone')).toBe('previous');
    expect(container.querySelector('.overlay-champion')?.textContent).toBe('元素女皇');
    expect(container.querySelector('.overlay-status')?.textContent).toBe('局势已变化，以下为此前评分。');
    expect(screen.getByRole('status').textContent).toContain('已分析 · 此前结果');
    expect(container.textContent).not.toContain('不要在侧栏显示');
    expect([...container.querySelectorAll('details')].every(node=>!node.open)).toBe(true);
    for(const index of [0,1,2]){
      expect(screen.getAllByText(`完整效果${index}`)).toHaveLength(1);
      const effect=screen.getByText(`完整效果${index}`),summary=effect.closest('summary'),details=effect.closest('details');
      expect(summary?.parentElement).toBe(details);
      expect(summary?.textContent).toContain('效果与分析');
      expect(details?.open).toBe(false);
      expect(screen.getByText(`详细分析${index}`).closest('details')).toBe(details);
      expect(screen.getByText(`详细分析${index}`).closest('summary')).toBeNull();
      expect(summary?.getAttribute('aria-label')).toBe(`查看 候选${index} 的完整效果与分析`);
    }
    fireEvent.click(screen.getByLabelText('折叠侧栏'));
    expect(screen.getByLabelText('展开侧栏')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('展开侧栏'));
    expect(screen.getByText('综合推荐')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('关闭侧栏'));
    expect(invokeMock.mock.calls.map(([command])=>command)).toEqual(['overlay_ready','overlay_set_collapsed','overlay_set_collapsed','overlay_close']);
    expect(invokeMock).toHaveBeenCalledWith('overlay_set_collapsed',{collapsed:true});
    expect(invokeMock).toHaveBeenCalledWith('overlay_set_collapsed',{collapsed:false});
  });
  it.each(['waiting','preparing','analyzing','blocked','failed'] as const)('keeps prior model scores and the previous tone when subsequent analysis is %s',async phase=>{
    const payload=publication();payload.analysis={phase,code:phase==='waiting'?'request-cooldown':'test',message:'不得替换已有结果'};
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getByText('已分析 · 此前结果')).toBeTruthy());
    expect(container.querySelector('.overlay-card')?.getAttribute('data-tone')).toBe('previous');
    expect([...container.querySelectorAll('.overlay-score')].map(node=>node.textContent)).toEqual(['85','72','60']);
    expect(screen.getByRole('status').textContent).toBe('元素女皇已分析 · 此前结果局势已变化，以下为此前评分。');
    expect(container.textContent).not.toContain('不得替换已有结果');
    expect(container.querySelectorAll('.overlay-item.top')).toHaveLength(1);
    expect(invokeMock.mock.calls.map(([command])=>command)).toEqual(['overlay_ready']);
  });
  it.each(['waiting','preparing','analyzing','complete'] as const)('uses the %s recognition tone without turning candidate numbers into model rankings',async phase=>{
    const payload=publication();payload.ranking.source='recognition';payload.ranking.modelScoresValid=false;
    payload.analysis={phase,code:'test',message:'候选状态说明'};
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getByText('候选 01')).toBeTruthy());
    expect(container.querySelector('.overlay-card')?.getAttribute('data-tone')).toBe(phase);
    expect([...container.querySelectorAll('.overlay-option')].map(node=>node.textContent)).toEqual(['候选 01','候选 02','候选 03']);
    expect(container.querySelectorAll('.overlay-rank,.overlay-score,.overlay-meter,.overlay-recommendation,.overlay-item.top')).toHaveLength(0);
    expect([...container.querySelectorAll('.overlay-score-placeholder')].map(node=>node.textContent)).toEqual(['—','—','—']);
    expect(container.querySelectorAll('.overlay-item .overlay-analysis-note')).toHaveLength(0);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(container.querySelector('.overlay-status')).toBeNull();
    expect(invokeMock.mock.calls.map(([command])=>command)).toEqual(['overlay_ready']);
  });
  it('keeps one score slot and one accessible disclosure per candidate throughout real status updates',async()=>{
    const payload=publication();payload.ranking.source='recognition';payload.ranking.modelScoresValid=false;payload.ranking.contextChanged=false;
    payload.analysis={phase:'waiting',code:'confirming-ocr',message:'等待再次识别确认'};
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getByText('候选复核中')).toBeTruthy());
    const articles=[...container.querySelectorAll('.overlay-item')];
    const listener=listenMock.mock.calls.find(([name])=>name==='overlay:state')?.[1];
    let sequence=1;
    for(const [phase,code,label] of [
      ['preparing','knowledge','已识别 · 准备分析'],
      ['analyzing','model-request','模型分析中'],
      ['analyzing','result-received','评分已返回 · 同步中'],
    ] as const){
      listener({payload:{...payload,sequence:++sequence,analysis:{phase,code,message:'冗长内部准备说明不重复在候选卡中'}}});
      await waitFor(()=>expect(screen.getByText(label)).toBeTruthy());
      expect([...container.querySelectorAll('.overlay-item')]).toEqual(articles);
      expect(container.querySelectorAll('.overlay-score-block')).toHaveLength(3);
      expect(screen.getAllByLabelText('尚无模型评分')).toHaveLength(3);
      expect(container.querySelectorAll('.overlay-item .overlay-analysis-note')).toHaveLength(0);
      expect(container.querySelectorAll('.overlay-item .overlay-score')).toHaveLength(0);
      expect(screen.getByRole('status').textContent).toBe(`元素女皇${label}`);
      expect(screen.queryByText('冗长内部准备说明不重复在候选卡中')).toBeNull();
      for(const index of [0,1,2])expect(screen.getByLabelText(`查看 候选${index} 的完整效果与分析`)).toBeTruthy();
    }
    const completed=publication();completed.ranking.contextChanged=false;
    listener({payload:{...completed,sequence:++sequence,analysis:{phase:'complete',code:'done',message:'分析完成'}}});
    await waitFor(()=>expect(screen.getByText('综合推荐')).toBeTruthy());
    expect([...container.querySelectorAll('.overlay-item')]).toEqual([articles[1],articles[2],articles[0]]);
    expect(container.querySelectorAll('.overlay-score-block')).toHaveLength(3);
    expect(container.querySelectorAll('.overlay-score-placeholder')).toHaveLength(0);
    expect([...container.querySelectorAll('.overlay-score')].map(node=>node.textContent)).toEqual(['85','72','60']);
    expect(screen.getByRole('status').textContent).toBe('元素女皇已分析');
    expect(container.querySelectorAll('.overlay-status')).toHaveLength(0);
    expect(invokeMock.mock.calls.map(([command])=>command)).toEqual(['overlay_ready']);
  });
  it('marks completed but unscored analysis without promoting an arbitrary candidate',async()=>{
    const payload=publication();payload.ranking.modelScoresValid=false;
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getAllByLabelText('已分析 · 未评分')).toHaveLength(3));
    expect(container.querySelectorAll('.overlay-score')).toHaveLength(0);
    expect(container.querySelectorAll('.overlay-recommendation')).toHaveLength(0);
    expect(container.querySelectorAll('.overlay-item.top')).toHaveLength(0);
    expect(screen.getByTitle('元素女皇 · 已分析 · 暂无可用评分')).toBeTruthy();
    expect(container.querySelector('.overlay-mode')?.textContent).toBe('已分析 · 未评分');
    expect(screen.getByRole('status').textContent).toBe('元素女皇已分析 · 未评分局势已变化，以下为此前评分。');
    expect(container.querySelector('.overlay-foot')?.textContent).toContain('已分析 · 未评分 · 此前结果');
  });
  it.each([false,true])('explains an all-owned model group without scores or a winner (previous=%s)',async contextChanged=>{
    const payload=publication();payload.ranking.contextChanged=contextChanged;
    payload.ranking.ranking=payload.ranking.ranking.map(candidate=>({...candidate,alreadyOwned:true}));
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getByText('本组均已拥有')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toBe(`元素女皇本组均已拥有${contextChanged?'局势已变化，以下为此前评分。':''}`);
    expect(screen.getAllByText('已拥有')).toHaveLength(3);
    expect(screen.getAllByLabelText('已拥有，不参与推荐')).toHaveLength(3);
    expect(container.querySelectorAll('.overlay-score,.overlay-rank,.overlay-item.top,.overlay-recommendation')).toHaveLength(0);
    expect(container.querySelectorAll('.overlay-option')).toHaveLength(3);
    expect(container.querySelector('.overlay-card')?.getAttribute('data-tone')).toBe(contextChanged?'previous':'complete');
    if(contextChanged)expect(container.querySelector('.overlay-foot')?.textContent).toContain('此前结果');
    expect(invokeMock.mock.calls.map(([command])=>command)).toEqual(['overlay_ready']);
  });
  it('shows a request cooldown as a single explicit global status instead of vague waiting or active inference',async()=>{
    const payload=publication();payload.ranking.source='recognition';payload.ranking.modelScoresValid=false;
    payload.analysis={phase:'waiting',code:'request-cooldown',message:'请求间隔未到，候选已记录'};
    invokeMock.mockResolvedValue(payload);
    const {container}=render(<OverlayApp/>);
    await waitFor(()=>expect(screen.getByText('等待请求间隔')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toBe('元素女皇等待请求间隔');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByText('已识别 · 待分析')).toBeNull();
    expect(screen.queryByText('模型分析中')).toBeNull();
    expect(container.querySelectorAll('.overlay-item .overlay-analysis-note')).toHaveLength(0);
    expect(screen.getAllByLabelText('尚无模型评分')).toHaveLength(3);
    expect(container.querySelectorAll('.overlay-score,.overlay-item.top,.overlay-recommendation')).toHaveLength(0);
    expect(invokeMock.mock.calls.map(([command])=>command)).toEqual(['overlay_ready']);
  });
});
