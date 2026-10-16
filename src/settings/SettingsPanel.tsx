import {useId,useState,type ReactNode} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {Select} from '../ui/Select';
import {modelServiceLabel} from './modelConsent';
import {AUTO_MAX_PER_ROUND} from '../recommendation/autoRecommendation';
import './settings.css';

type ModelConfig={provider?:'jev'|'openai';baseUrl:string;name:string;jsonMode?:boolean;maxTokens?:number;allowThirdParty?:boolean};
export const DEFAULT_JEV_URL='https://api.typesafe.ai/v1';
export const DEFAULT_JEV_MODEL='jev-1.13.0';
const DEFAULT_LOCAL_URL='http://127.0.0.1:11434/v1';
const isOfficialJev=(url:string)=>{try{const u=new URL(url.trim());return u.hostname==='api.typesafe.ai'&&u.protocol==='https:';}catch{return false;}};
type StorageStats={databaseBytes:number;sessionCount:number;sampleCount:number;budgetMb:number;retentionDays:number;budgetReached?:boolean;unreadableSessions?:number};
type Confirmation={title:string;detail:string;action:()=>Promise<void>};

type Props={
 children?:ReactNode;
 model:ModelConfig;
 setModel:(model:ModelConfig)=>void;
 apiKey:string;
 setApiKey:(value:string)=>void;
 keyStatus?:string;
 consent:boolean;
 setConsent:(value:boolean)=>void;
 autoRecommend?:boolean;
 autoRecommendPreferred?:boolean;
 setAutoRecommend?:(enabled:boolean)=>void;
 autoRecommendStatus?:string;
 models:string[];
 clearModels:()=>void;
 modelStatus:string;
 onTestModel:()=>void;
 lockfile:string;
 setLockfile:(value:string)=>void;
 busy:boolean;
 onResumeLive:()=>void;
 storage:StorageStats|null;
 budget:number;
 setBudget:(value:number)=>void;
 days:number;
 setDays:(value:number)=>void;
 dailyUsed:number;
 onConfirm:(confirmation:Confirmation)=>void;
 onMaintenance:()=>Promise<void>;
};

const presets=[
 ['Ollama','http://127.0.0.1:11434/v1'],
 ['LM Studio','http://127.0.0.1:1234/v1'],
 ['自定义本地','http://127.0.0.1:8080/v1']
] as const;

const settingsTabs=['模型连接','自动推荐','本地数据','关于与更新'] as const;

export function SettingsPanel({children,model,setModel,apiKey,setApiKey,keyStatus,consent,setConsent,autoRecommend=false,autoRecommendPreferred=autoRecommend,setAutoRecommend,autoRecommendStatus,models,clearModels,modelStatus,onTestModel,lockfile,setLockfile,busy,onResumeLive,storage,budget,setBudget,days,setDays,dailyUsed,onConfirm,onMaintenance}:Props){
 const desktop=isTauri(),canEnableAutoRecommend=desktop&&!!setAutoRecommend;
 const [tab,setTab]=useState(0),uid=useId();
 return <div className="settings-page">
  <div className="settings-tabs" role="tablist" aria-label="设置分类">{settingsTabs.map((name,index)=><button key={name} type="button" role="tab" id={uid+'-tab-'+index} aria-controls={uid+'-panel-'+index} aria-selected={tab===index} tabIndex={tab===index?0:-1} onClick={()=>setTab(index)} onKeyDown={event=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?settingsTabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+settingsTabs.length)%settingsTabs.length;setTab(next);document.getElementById(uid+'-tab-'+next)?.focus();}}>{name}</button>)}</div>
  <div className="settings-tab-content" role="tabpanel" id={uid+'-panel-'+tab} aria-labelledby={uid+'-tab-'+tab} tabIndex={0}>
   {tab===0&&<section className="panel settings-card">
    <div className="settings-card-head"><div><h2>模型连接</h2><p>选择你使用的服务。配置会自动保存，无需重复填写。</p></div><span className="settings-state">{model.name.trim()?'已填写模型':'等待配置'}</span></div>
    <div className="settings-form">
     <div className="settings-field-grid">
      <label>协议 / 服务商<Select aria-label="协议 / 服务商" value={model.provider||'openai'} onChange={e=>{setConsent(false);clearModels();setModel(e.target.value==='jev'?{...model,provider:'jev',baseUrl:DEFAULT_JEV_URL,name:DEFAULT_JEV_MODEL}:{...model,provider:'openai',baseUrl:DEFAULT_LOCAL_URL,name:'',allowThirdParty:undefined});}}><option value="jev">TypeSafe Jev · System One</option><option value="openai">OpenAI 兼容 · 第三方 / 本地</option></Select></label>
      <label>模型名称<input placeholder="填写准确模型名" value={model.name} onChange={e=>setModel({...model,name:e.target.value})}/></label>
     </div>
     <div><label>服务地址<input value={model.baseUrl} onChange={e=>setModel({...model,baseUrl:e.target.value})}/></label><div className="settings-presets"><span>本地服务</span>{presets.map(([name,url])=><button key={name} type="button" aria-pressed={model.provider!=='jev'&&model.baseUrl===url} onClick={()=>setModel({...model,provider:'openai',baseUrl:url,allowThirdParty:undefined})}>{name}</button>)}</div></div>
     {model.provider==='jev'&&<div><label className="settings-check"><input type="checkbox" checked={!!model.allowThirdParty} onChange={e=>setModel({...model,allowThirdParty:e.target.checked})}/><span><strong>允许使用第三方地址</strong><small>官方 api.typesafe.ai 无需勾选；第三方地址仅支持 HTTPS 或本机 HTTP 回环，不能带账号、查询或片段。</small></span></label>{model.baseUrl.trim()&&!isOfficialJev(model.baseUrl)&&!model.allowThirdParty&&<p className="settings-warning">第三方地址需先勾选「允许使用第三方地址」，否则连接会被拒绝。</p>}</div>}
     <div className="settings-key-field"><label htmlFor={uid+'-key'}>API Key <span className="field-note">本地服务通常留空</span></label><div className="settings-input-action"><input id={uid+'-key'} type="password" autoComplete="off" disabled={busy} value={apiKey} onChange={e=>setApiKey(e.target.value)}/><button disabled={!desktop||busy} onClick={()=>setApiKey(apiKey)}>保存密钥</button></div><p className="hint" role="status" aria-label="密钥保存状态">{keyStatus||'密钥保存在当前 Windows 用户的凭据管理器中。'}<span className="settings-secondary-line">按服务自动保存，重启与升级后恢复；清空输入框会删除此服务保存的密钥。</span></p></div>
     {models.length>0&&<label>服务可用模型<Select aria-label="服务可用模型" value={model.name} onChange={e=>setModel({...model,name:e.target.value})}><option value="">请选择</option>{models.map(m=><option key={m}>{m}</option>)}</Select></label>}
     <div className="settings-test-row"><button className="accent" disabled={!desktop} onClick={onTestModel}>测试连接并获取模型</button><div className="connection-status" role="status" aria-label="模型连接状态"><i/>{modelStatus||'尚未测试连接'}</div></div>
     <details className="settings-details settings-advanced"><summary>高级请求选项 <span>Token · JSON 兼容</span></summary><div className="settings-advanced-body"><label>输出 Token 上限<input type="number" min={256} max={4096} value={model.maxTokens||2200} onChange={e=>setModel({...model,maxTokens:Number(e.target.value)})}/></label><label className="settings-check"><input type="checkbox" checked={model.jsonMode!==false} onChange={e=>setModel({...model,jsonMode:e.target.checked})}/><span><strong>发送 JSON 模式参数</strong><small>服务不兼容时可关闭，响应仍会进行 JSON 校验。</small></span></label></div></details>
    </div>
    <div className="settings-card-footer"><span>配置完成后，还需确认数据授权和自动推荐偏好。</span><button className="settings-text-action" onClick={()=>{setTab(1);document.getElementById(`${uid}-tab-1`)?.focus();}}>前往自动推荐 →</button></div>
   </section>}

   {tab===1&&<section className="panel settings-card">
    <div className="settings-card-head"><div><h2>自动推荐</h2><p>每轮最多 4 次自动分析，进入新轮次后重新计数。</p></div><span className={autoRecommend?'settings-state ready':'settings-state'}>{autoRecommend?'已开启':autoRecommendPreferred?'等待就绪':'已关闭'}</span></div>
    <div className="settings-automation-row"><div><h3>自动模型推荐</h3><p>候选稳定识别后自动分析，结果显示在侧栏。</p></div><label className="settings-switch"><input type="checkbox" aria-label="自动模型推荐（可能产生费用）" checked={autoRecommendPreferred} disabled={!setAutoRecommend||(!autoRecommendPreferred&&!canEnableAutoRecommend)} onChange={e=>{if(!e.target.checked||canEnableAutoRecommend)setAutoRecommend?.(e.target.checked);}}/><span aria-hidden="true"/></label></div>
    <p className="settings-warning">可能产生模型费用。关闭立即停止新的自动调用；已发出的请求可能仍产生费用。识别本身不调用模型、不产生模型费用。</p>
    <div className="settings-status-line" role="status" aria-label="自动推荐状态"><i/>{autoRecommend?'自动推荐已开启':autoRecommendPreferred?'自动推荐偏好已开启，等待模型配置和数据授权':'自动推荐已关闭（已保存）'}{autoRecommendStatus?' · '+autoRecommendStatus:''}</div>
    <div className="settings-section-divider"/>
    <label className="settings-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span><strong>允许 {modelServiceLabel(model)} 分析本局数据</strong><small>{model.provider==='jev'?'会发送当前英雄、装备、双方阵容、海克斯和知识片段，不发送玩家 ID 或跨局历史摘要。':'会发送英雄、海克斯、文档片段和历史摘要；不发送原始账号标识。'}手填文字可能包含个人信息。</small></span></label>
    <p className="settings-footnote">自动推荐首次默认开启，授权并配置好模型后可能自动产生模型费用；不希望自动调用时请先关闭上方开关。数据授权会记住，更换服务仍需重新授权。</p>
    <div className="settings-budget-row"><div className="settings-usage"><span>每轮自动分析上限</span><strong>{AUTO_MAX_PER_ROUND}<small> 次 / 轮</small></strong><p>初始候选 + 三次刷新 · 新轮、新局独立计数</p></div><div className="settings-usage"><span>今日已发起</span><strong>{dailyUsed}<small> 次</small></strong><p>仅作统计，不限制每天分析次数</p></div></div>
    <details className="settings-details"><summary>触发规则与费用说明</summary><p>首次默认开启，开关、模型名称和服务地址会保存，重启与正常升级后恢复；手动关闭会一直保留。新一组完整三张候选连续两次识别稳定后自动分析。同一组候选在本次运行中不会自动重复请求，失败也不会自动重试；本次应用运行中每轮最多 {AUTO_MAX_PER_ROUND} 次自动请求，覆盖初始候选和三张卡各一次刷新；不设每日总上限。</p><p>局势、装备或知识变化不会额外触发自动请求。同时只发一个请求，发送间隔至少 1 秒；同组手动重复分析或同局重复复盘仍须间隔 8 秒，换组不继承旧组的等待。本地准备失败或发送前取消不计次数与间隔；已发出的失败请求或保存超时仍计入本轮自动次数，进入新轮或新局重新计数。应用只统计次数、耗时与上下文大小，不估算金额。</p></details>
   </section>}

   {tab===2&&<section className="panel settings-card">
    <div className="settings-card-head"><div><h2>本地数据</h2><p>管理客户端发现、对局档案和原始采样。</p></div><span className="settings-state">仅此设备</span></div>
    <div className="settings-local-section"><div className="settings-section-intro"><h3>客户端连接</h3><p>自动发现失败时，再填写 lockfile 的绝对路径。</p></div><div className="settings-section-fields"><label htmlFor={uid+'-lockfile'}>lockfile 路径 <span className="field-note">可选</span></label><div className="settings-input-action"><input id={uid+'-lockfile'} placeholder="C:\Riot Games\League of Legends\lockfile" value={lockfile} onChange={e=>setLockfile(e.target.value)}/><button disabled={!desktop||busy} onClick={onResumeLive}>重新检测客户端</button></div><p className="hint">启动后自动发现 LeagueClientUx，无需管理员权限。</p></div></div>
    <div className="settings-local-section"><div className="settings-section-intro"><h3>对局存储</h3><p>保留核心决策与复盘，按预算整理原始采样。</p></div><div className="settings-section-fields">
     <div className="storage-meter"><div><strong>{((storage?.databaseBytes||0)/1024/1024).toFixed(1)} MB</strong><small>{budget} MB 预算</small></div><progress aria-label="数据库空间使用" max={budget} value={(storage?.databaseBytes||0)/1024/1024}/><p>{storage?.sessionCount||0} 场对局 · {storage?.sampleCount||0} 份采样</p></div>
     {!!storage?.unreadableSessions&&<p className="notice">有 {storage.unreadableSessions} 条记录格式异常，已隔离显示；原文保留，可通过“导出全部历史”备份检查。</p>}
     <div className="settings-field-grid"><label>SQLite 预算（MB）<input type="number" min={32} max={2048} value={budget} onChange={e=>setBudget(Number(e.target.value))}/></label><label>采样保留（天）<input type="number" min={1} max={365} value={days} onChange={e=>setDays(Number(e.target.value))}/></label></div>
     <div className="settings-cleanup-row"><button disabled={busy||!desktop} onClick={()=>onConfirm({title:'应用预算并清理原始采样？',detail:'清理过期或超预算的原始快照并回收数据库空间；不自动删除核心决策与复盘。原始快照删除后不可恢复。',action:onMaintenance})}>应用预算并清理空间</button><small>操作前会再次确认</small></div>
     <details className="settings-details"><summary>保留与检索策略</summary><p>空闲时每 30 分钟维护，也可手动清理。内存只保留近期 30 份采样与 50 条历史摘要；Jev 不检索跨局历史，普通语言模型通道仍可检索最多 5 条相关历史摘要。超预算且无法清理时会拒绝新增保存，不会默默删除核心记录。</p></details>
    </div></div>
   </section>}

   {tab===3&&<>{children}<section className="panel settings-card settings-about-card"><div className="settings-card-head"><div><h2>隐私与后台运行</h2><p>了解数据去向与应用边界。</p></div></div><div className="settings-policy-list"><div><h3>安全保存</h3><p>API Key 按协议及服务地址保存在当前 Windows 用户的凭据管理器中，不写入普通设置、对局档案、导出文件或日志。换服务会读取该服务独立保存的密钥；清空输入框可删除。</p></div><div><h3>后台与退出</h3><p>隐藏到系统托盘期间仍会自动跟踪；点击“完全退出”或从托盘选择“退出 Hexglow”后才停止采集。不安装开机自启或系统服务。</p></div></div><details className="settings-details"><summary>协议与项目声明</summary><p>Jev 使用官方 System One 协议，默认地址为官方 api.typesafe.ai，改填第三方地址需先勾选「允许使用第三方地址」；普通模型使用统一判断问题的 JSON 适配。支持第三方 HTTPS 和本机 HTTP，不会自动切换服务商，模型费用由用户账号承担。</p><p>客户端凭据只在 Rust 内存中用于本地请求，不回传界面、不写入日志。LCU 不保证稳定；运行在本地不等于自动符合平台政策。发布前仍需核对官方规则与产品注册要求。</p><p>Hexglow 是独立项目，未经 Riot Games 背书，不代表 Riot Games 或其工作人员的观点。Riot Games 及相关游戏、商标与资产归各自权利人所有。</p></details></section></>}
  </div>
 </div>;
}
