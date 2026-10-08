// @vitest-environment jsdom
import type {ComponentProps} from 'react';
import {useState} from 'react';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {isTauri} from '@tauri-apps/api/core';
import {SettingsPanel} from './SettingsPanel';

vi.mock('@tauri-apps/api/core',()=>({isTauri:vi.fn(()=>true)}));

const noop=()=>{};
const props:ComponentProps<typeof SettingsPanel>={
 model:{provider:'openai',baseUrl:'https://example.test/v1',name:'test-model'},setModel:noop,
 apiKey:'',setApiKey:noop,consent:true,setConsent:noop,models:[],clearModels:noop,modelStatus:'',onTestModel:noop,
 lockfile:'',setLockfile:noop,busy:false,onResumeLive:noop,storage:null,budget:128,setBudget:noop,
 days:7,setDays:noop,dailyLimit:50,setDailyLimit:noop,dailyUsed:0,onConfirm:noop,onMaintenance:async()=>{},
};
const label='自动模型推荐（可能产生费用）';

afterEach(cleanup);
beforeEach(()=>{vi.clearAllMocks();vi.mocked(isTauri).mockReturnValue(true);});

describe('explicit automatic model recommendation consent',()=>{
 it('defaults off independently of data consent and explains fees and limits',()=>{
  const onChange=vi.fn();
  const screen=render(<SettingsPanel {...props} setAutoRecommend={onChange}/>);
  const checkbox=screen.getByRole('checkbox',{name:label}) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);expect(checkbox.disabled).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('status',{name:'自动推荐状态'}).textContent).toContain('自动推荐已关闭（默认手动）');
  const text=screen.container.textContent!;
  for(const description of ['默认关闭，需单独开启','仅授权当前服务和模型','切换服务或模型后需重新开启','完整三张候选连续两次识别稳定','识别本身不调用模型、不产生模型费用','失败也不会自动重试','本次应用运行中每轮最多 3 次自动请求','与手动分析共用每日总上限','关闭立即停止新的自动调用','已发出的请求可能仍产生费用'])expect(text).toContain(description);
 });

 it.each(['no-consent','blank-model','browser','missing-handler'] as const)('cannot opt in when %s',condition=>{
  const onChange=vi.fn();
  if(condition==='browser')vi.mocked(isTauri).mockReturnValue(false);
  const screen=render(<SettingsPanel {...props} consent={condition!=='no-consent'} model={condition==='blank-model'?{...props.model,name:'   '}:props.model} setAutoRecommend={condition==='missing-handler'?undefined:onChange}/>);
  const checkbox=screen.getByRole('checkbox',{name:label}) as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  fireEvent.click(checkbox);
  expect(onChange).not.toHaveBeenCalled();
 });

 it('sends explicit true and false callbacks and displays scheduler status',()=>{
  const onChange=vi.fn();
  function Harness(){
   const [enabled,setEnabled]=useState(false);
   return <SettingsPanel {...props} autoRecommend={enabled} setAutoRecommend={next=>{onChange(next);setEnabled(next);}} autoRecommendStatus="等待第二次稳定识别"/>;
  }
  const screen=render(<Harness/>);
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
  const checkbox=screen.getByRole('checkbox',{name:label}) as HTMLInputElement;
  expect(checkbox.disabled).toBe(false);
  fireEvent.click(checkbox);
  expect(onChange).toHaveBeenCalledOnce();expect(onChange).toHaveBeenCalledWith(false);
 });
});
