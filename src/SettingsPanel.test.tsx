// @vitest-environment jsdom
import type {ComponentProps} from 'react';
import {useState} from 'react';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {isTauri} from '@tauri-apps/api/core';
import {DEFAULT_JEV_MODEL,DEFAULT_JEV_URL,SettingsPanel} from './SettingsPanel';
import {AUTO_MAX_PER_ROUND} from './autoRecommendation';

vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>true)}));

const noop=()=>{};
const props:ComponentProps<typeof SettingsPanel>={
 model:{provider:'openai',baseUrl:'https://example.test/v1',name:'test-model'},setModel:noop,
 apiKey:'',setApiKey:noop,consent:true,setConsent:noop,models:[],clearModels:noop,modelStatus:'',onTestModel:noop,
 lockfile:'',setLockfile:noop,busy:false,onResumeLive:noop,storage:null,budget:128,setBudget:noop,
 days:7,setDays:noop,dailyUsed:0,onConfirm:noop,onMaintenance:async()=>{},
};
const label='自动模型推荐（可能产生费用）';
type SettingsScreen=ReturnType<typeof render>;
const openTab=(screen:SettingsScreen,name:string)=>fireEvent.click(screen.getByRole('tab',{name}));

afterEach(cleanup);
beforeEach(()=>{
 vi.clearAllMocks();vi.mocked(isTauri).mockReturnValue(true);
 Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
});

describe('explicit automatic model recommendation consent',()=>{
 it.each(['jev','openai'] as const)('describes the actual %s state privacy boundary',provider=>{
  const screen=render(<SettingsPanel {...props} model={{...props.model,provider}}/>);
  openTab(screen,'自动推荐');
  const text=screen.container.textContent!;
  expect(text).toContain(provider==='jev'?'不发送玩家 ID 或跨局历史摘要':'会发送英雄、海克斯、文档片段和历史摘要');
  expect(text).toContain('手填文字可能包含个人信息');
 });
 it('shows key persistence state and can retry or clear only the current key',()=>{
  const setApiKey=vi.fn();
  const screen=render(<SettingsPanel {...props} apiKey="synthetic-only-key" keyStatus="密钥已保存" setApiKey={setApiKey}/>);
  expect(screen.getByRole('status',{name:'密钥保存状态'}).textContent).toContain('密钥已保存');
  expect(screen.container.textContent).not.toContain('synthetic-only-key');
  fireEvent.click(screen.getByRole('button',{name:'保存密钥'}));
  expect(setApiKey).toHaveBeenLastCalledWith('synthetic-only-key');
  fireEvent.change(screen.getByDisplayValue('synthetic-only-key'),{target:{value:''}});
  expect(setApiKey).toHaveBeenLastCalledWith('');
 });
 it('shows a saved off choice independently of data consent and explains defaults, fees and limits',()=>{
  const onChange=vi.fn();
  const screen=render(<SettingsPanel {...props} setAutoRecommend={onChange}/>);
  openTab(screen,'自动推荐');
  const checkbox=screen.getByRole('checkbox',{name:label}) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);expect(checkbox.disabled).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('status',{name:'自动推荐状态'}).textContent).toContain('自动推荐已关闭（已保存）');
  const text=screen.container.textContent!;
  for(const description of ['首次默认开启','手动关闭会一直保留','更换服务仍需重新授权','完整三张候选连续两次识别稳定','识别本身不调用模型、不产生模型费用','失败也不会自动重试',`本次应用运行中每轮最多 ${AUTO_MAX_PER_ROUND} 次自动请求`,'覆盖初始候选和三张卡各一次刷新','不设每日总上限','关闭立即停止新的自动调用','已发出的请求可能仍产生费用'])expect(text).toContain(description);
 });

 it.each(['browser','missing-handler'] as const)('cannot enable the preference when %s',condition=>{
  const onChange=vi.fn();
  if(condition==='browser')vi.mocked(isTauri).mockReturnValue(false);
  const screen=render(<SettingsPanel {...props} setAutoRecommend={condition==='missing-handler'?undefined:onChange}/>);
  openTab(screen,'自动推荐');
  const checkbox=screen.getByRole('checkbox',{name:label}) as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  fireEvent.click(checkbox);
  expect(onChange).not.toHaveBeenCalled();
 });
 it('shows default-on preference as waiting for authorization without claiming an active scheduler',()=>{
  const screen=render(<SettingsPanel {...props} consent={false} autoRecommend={false} autoRecommendPreferred={true} setAutoRecommend={vi.fn()}/>);
  openTab(screen,'自动推荐');
  expect((screen.getByRole('checkbox',{name:label}) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole('status',{name:'自动推荐状态'}).textContent).toContain('等待模型配置和数据授权');
 });

 it('sends explicit true and false callbacks and displays scheduler status',()=>{
  const onChange=vi.fn();
  function Harness(){
   const [enabled,setEnabled]=useState(false);
   return <SettingsPanel {...props} autoRecommend={enabled} setAutoRecommend={next=>{onChange(next);setEnabled(next);}} autoRecommendStatus="等待第二次稳定识别"/>;
  }
  const screen=render(<Harness/>);
  openTab(screen,'自动推荐');
  const checkbox=screen.getByRole('checkbox',{name:label}) as HTMLInputElement;
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(true);expect(onChange).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('status',{name:'自动推荐状态'}).textContent).toBe('自动推荐已开启 · 等待第二次稳定识别');
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(false);expect(onChange).toHaveBeenLastCalledWith(false);
 });

 it('keeps disabling available when consent, configuration or desktop readiness is lost',()=>{
  vi.mocked(isTauri).mockReturnValue(false);
  const onChange=vi.fn();
  const screen=render(<SettingsPanel {...props} consent={false} model={{...props.model,name:''}} autoRecommend={true} setAutoRecommend={onChange} busy={true}/>);
  openTab(screen,'自动推荐');
  const checkbox=screen.getByRole('checkbox',{name:label}) as HTMLInputElement;
  expect(checkbox.disabled).toBe(false);
  fireEvent.click(checkbox);
  expect(onChange).toHaveBeenCalledOnce();expect(onChange).toHaveBeenCalledWith(false);
 });
});

describe('task-based settings navigation',()=>{
 it('starts on model settings and switches only the active panel without performing actions',()=>{
  const callbacks={setModel:vi.fn(),setApiKey:vi.fn(),setConsent:vi.fn(),setAutoRecommend:vi.fn(),clearModels:vi.fn(),onTestModel:vi.fn(),setLockfile:vi.fn(),onResumeLive:vi.fn(),setBudget:vi.fn(),setDays:vi.fn(),setDailyLimit:vi.fn(),onConfirm:vi.fn(),onMaintenance:vi.fn(async()=>{})};
  const screen=render(<SettingsPanel {...props} {...callbacks}/>);
  expect(screen.getByRole('tablist')).toBeTruthy();
  expect(screen.getAllByRole('tab')).toHaveLength(4);
  expect(screen.getByRole('tab',{name:'模型连接'}).getAttribute('aria-selected')).toBe('true');
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  expect(screen.getByRole('button',{name:'保存密钥'})).toBeTruthy();
  expect(screen.queryByRole('checkbox',{name:label})).toBeNull();
  for(const name of ['自动推荐','本地数据','关于与更新','模型连接']){
   openTab(screen,name);
   const tab=screen.getByRole('tab',{name});
   const panel=screen.getByRole('tabpanel');
   expect(tab.getAttribute('aria-selected')).toBe('true');
   expect(tab.getAttribute('aria-controls')).toBe(panel.id);
   expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
   expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  }
  for(const callback of Object.values(callbacks))expect(callback).not.toHaveBeenCalled();
 });

 it('supports roving keyboard focus with arrow keys and Home/End',()=>{
  const screen=render(<SettingsPanel {...props}/>);
  const tabs=screen.getAllByRole('tab');
  const expectActive=(index:number)=>{
   expect(document.activeElement).toBe(tabs[index]);
   for(const [i,tab] of tabs.entries()){
    expect(tab.getAttribute('aria-selected')).toBe(String(i===index));
    expect(tab.tabIndex).toBe(i===index?0:-1);
   }
  };
  tabs[0].focus();
  fireEvent.keyDown(tabs[0],{key:'ArrowRight'});expectActive(1);
  fireEvent.keyDown(tabs[1],{key:'End'});expectActive(3);
  fireEvent.keyDown(tabs[3],{key:'ArrowRight'});expectActive(0);
  fireEvent.keyDown(tabs[0],{key:'ArrowLeft'});expectActive(3);
  fireEvent.keyDown(tabs[3],{key:'Home'});expectActive(0);
 });

 it('moves keyboard focus to the automatic recommendation tab from the setup shortcut',()=>{
  const screen=render(<SettingsPanel {...props}/>);
  const shortcut=screen.getByRole('button',{name:'前往自动推荐 →'});
  shortcut.focus();fireEvent.click(shortcut);
  const tab=screen.getByRole('tab',{name:'自动推荐'});
  expect(document.activeElement).toBe(tab);
  expect(tab.getAttribute('aria-selected')).toBe('true');
 });

 it('renders update content only in about settings without triggering it on navigation',()=>{
  const check=vi.fn();
  const screen=render(<SettingsPanel {...props}><section><h2>应用更新</h2><button onClick={check}>检查测试更新</button></section></SettingsPanel>);
  expect(screen.queryByRole('heading',{name:'应用更新'})).toBeNull();
  openTab(screen,'关于与更新');
  expect(screen.getByRole('heading',{name:'应用更新'})).toBeTruthy();
  expect(check).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'检查测试更新'}));
  expect(check).toHaveBeenCalledOnce();
  openTab(screen,'模型连接');
  expect(screen.queryByRole('button',{name:'检查测试更新'})).toBeNull();
 });

 it('does not equate a model name with a verified connection',()=>{
  const screen=render(<SettingsPanel {...props} modelStatus=""/>);
  expect(screen.container.textContent).toContain('尚未测试连接');
  expect(screen.queryByText('已连接',{exact:true})).toBeNull();
  expect(screen.getByDisplayValue('test-model')).toBeTruthy();
 });
});

describe('preserved model and data controls',()=>{
 it('changes protocols with the same explicit authorization reset and preset defaults',()=>{
  const setModel=vi.fn(),setConsent=vi.fn(),clearModels=vi.fn();
  const screen=render(<SettingsPanel {...props} setModel={setModel} setConsent={setConsent} clearModels={clearModels}/>);
  fireEvent.click(screen.getByRole('combobox',{name:/协议|服务商/}));
  fireEvent.click(screen.getByRole('option',{name:'TypeSafe Jev · System One'}));
  expect(setConsent).toHaveBeenLastCalledWith(false);
  expect(clearModels).toHaveBeenCalledOnce();
  expect(setModel).toHaveBeenLastCalledWith({...props.model,provider:'jev',baseUrl:DEFAULT_JEV_URL,name:DEFAULT_JEV_MODEL});
  screen.rerender(<SettingsPanel {...props} model={{...props.model,provider:'jev',baseUrl:DEFAULT_JEV_URL,name:DEFAULT_JEV_MODEL,allowThirdParty:true}} setModel={setModel} setConsent={setConsent} clearModels={clearModels}/>);
  fireEvent.click(screen.getByRole('combobox',{name:/协议|服务商/}));
  fireEvent.click(screen.getByRole('option',{name:'OpenAI 兼容 · 第三方 / 本地'}));
  expect(setConsent).toHaveBeenLastCalledWith(false);
  expect(clearModels).toHaveBeenCalledTimes(2);
  expect(setModel).toHaveBeenLastCalledWith({...props.model,provider:'openai',baseUrl:'http://127.0.0.1:11434/v1',name:'',allowThirdParty:undefined});
 });

 it('shows four requests per round and a daily statistic without a daily limit control',()=>{
  const screen=render(<SettingsPanel {...props} dailyUsed={47}/>);
  openTab(screen,'自动推荐');
  expect(screen.queryByRole('spinbutton',{name:/每日分析上限/})).toBeNull();
  expect(screen.container.textContent).toContain('每轮自动分析上限4 次 / 轮');
  expect(screen.container.textContent).toContain('今日已发起47 次');
  expect(screen.container.textContent).toContain('仅作统计，不限制每天分析次数');
 });

 it('requests confirmation before destructive maintenance and preserves its warning',async()=>{
  const onConfirm=vi.fn(),onMaintenance=vi.fn(async()=>{});
  const screen=render(<SettingsPanel {...props} onConfirm={onConfirm} onMaintenance={onMaintenance}/>);
  openTab(screen,'本地数据');
  fireEvent.click(screen.getByRole('button',{name:'应用预算并清理空间'}));
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(onMaintenance).not.toHaveBeenCalled();
  const confirmation=onConfirm.mock.calls[0][0] as Parameters<typeof props.onConfirm>[0];
  expect(confirmation.title).toContain('清理原始采样');
  expect(confirmation.detail).toContain('不自动删除核心决策与复盘');
  expect(confirmation.detail).toContain('原始快照删除后不可恢复');
  expect(confirmation.action).toBe(onMaintenance);
  await confirmation.action();
  expect(onMaintenance).toHaveBeenCalledOnce();
 });

 it.each(['busy','browser'] as const)('keeps maintenance and detection disabled when %s',condition=>{
  if(condition==='browser')vi.mocked(isTauri).mockReturnValue(false);
  const onConfirm=vi.fn(),onResumeLive=vi.fn();
  const screen=render(<SettingsPanel {...props} busy={condition==='busy'} onConfirm={onConfirm} onResumeLive={onResumeLive}/>);
  openTab(screen,'本地数据');
  for(const name of ['应用预算并清理空间','重新检测客户端']){
   const button=screen.getByRole('button',{name}) as HTMLButtonElement;
   expect(button.disabled).toBe(true);fireEvent.click(button);
  }
  expect(onConfirm).not.toHaveBeenCalled();expect(onResumeLive).not.toHaveBeenCalled();
 });
});
