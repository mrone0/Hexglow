import {isTauri} from '@tauri-apps/api/core';
import {Select} from './Select';
import {modelServiceLabel} from './modelConsent';

type ModelConfig={provider?:'jev'|'openai';baseUrl:string;name:string;jsonMode?:boolean;maxTokens?:number;allowThirdParty?:boolean};
export const DEFAULT_JEV_URL='https://api.typesafe.ai/v1';
export const DEFAULT_JEV_MODEL='jev-1.13.0';
const DEFAULT_LOCAL_URL='http://127.0.0.1:11434/v1';
const isOfficialJev=(url:string)=>{try{const u=new URL(url.trim());return u.hostname==='api.typesafe.ai'&&u.protocol==='https:';}catch{return false;}};
type StorageStats={databaseBytes:number;sessionCount:number;sampleCount:number;budgetMb:number;retentionDays:number;budgetReached?:boolean;unreadableSessions?:number};
type Confirmation={title:string;detail:string;action:()=>Promise<void>};

type Props={
 model:ModelConfig;
 setModel:(model:ModelConfig)=>void;
 apiKey:string;
 setApiKey:(value:string)=>void;
 consent:boolean;
 setConsent:(value:boolean)=>void;
 autoRecommend?:boolean;
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
 dailyLimit:number;
 setDailyLimit:(value:number)=>void;
 dailyUsed:number;
 onConfirm:(confirmation:Confirmation)=>void;
 onMaintenance:()=>Promise<void>;
};

const presets=[
 ['Ollama','http://127.0.0.1:11434/v1'],
 ['LM Studio','http://127.0.0.1:1234/v1'],
 ['自定义本地','http://127.0.0.1:8080/v1']
] as const;

export function SettingsPanel({model,setModel,apiKey,setApiKey,consent,setConsent,autoRecommend=false,setAutoRecommend,autoRecommendStatus,models,clearModels,modelStatus,onTestModel,lockfile,setLockfile,busy,onResumeLive,storage,budget,setBudget,days,setDays,dailyLimit,setDailyLimit,dailyUsed,onConfirm,onMaintenance}:Props){
 const desktop=isTauri();
 const canEnableAutoRecommend=desktop&&consent&&!!model.name.trim()&&!!setAutoRecommend;
 return <div className="settings-page">
  <section className="panel settings-card settings-model-card">
   <div className="settings-card-head"><div><div className="eyebrow">MODEL ADAPTER</div><h2><b>01</b> 模型连接</h2><p>先选协议和服务地址，再验证模型是否可用。</p></div><span className={model.name.trim()?'settings-state ready':'settings-state'}>{model.name.trim()?'已填写模型':'等待配置'}</span></div>
   <div className="settings-model-grid">
    <div className="settings-group">
     <h3>服务与模型</h3>
     <label>协议 / 服务商<Select value={model.provider||'openai'} onChange={e=>{setConsent(false);clearModels();setModel(e.target.value==='jev'?{...model,provider:'jev',baseUrl:DEFAULT_JEV_URL,name:DEFAULT_JEV_MODEL}:{...model,provider:'openai',baseUrl:DEFAULT_LOCAL_URL,name:'',allowThirdParty:undefined});}}><option value="jev">TypeSafe Jev · System One</option><option value="openai">OpenAI 兼容 · 第三方 / 本地</option></Select></label>
     <div className="preset-field"><span>快速选择本地服务</span><div className="model-presets">{presets.map(([name,url])=><button key={name} aria-pressed={model.provider!=='jev'&&model.baseUrl===url} onClick={()=>setModel({...model,provider:'openai',baseUrl:url,allowThirdParty:undefined})}>{name}</button>)}</div></div>
     <label>服务地址<input value={model.baseUrl} onChange={e=>setModel({...model,baseUrl:e.target.value})}/></label>
     {model.provider==='jev'&&<label className="settings-check"><input type="checkbox" checked={!!model.allowThirdParty} onChange={e=>setModel({...model,allowThirdParty:e.target.checked})}/><span><strong>允许使用第三方地址</strong><small>官方 api.typesafe.ai 默认可用，无需勾选；改填第三方时仍须 HTTPS 或本机 HTTP 回环，地址不能带账号、查询或片段。</small></span></label>}
     {model.provider==='jev'&&model.baseUrl.trim()&&!isOfficialJev(model.baseUrl)&&!model.allowThirdParty&&<p className="hint">第三方地址需先勾选「允许使用第三方地址」，否则连接会被拒绝。</p>}
     <label>模型名称<input placeholder="填写准确模型名，或先获取模型列表" value={model.name} onChange={e=>setModel({...model,name:e.target.value})}/></label>
     {models.length>0&&<label>服务可用模型<Select value={model.name} onChange={e=>setModel({...model,name:e.target.value})}><option value="">请选择</option>{models.map(m=><option key={m}>{m}</option>)}</Select></label>}
    </div>
    <div className="settings-group">
     <h3>请求选项</h3>
     <label>API Key <span className="field-note">本地服务通常留空 · 云服务按要求填写 · 仅保存在本次内存</span><input type="password" autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)}/></label>
      <label>输出 Token 上限<input type="number" min={256} max={4096} value={model.maxTokens||2200} onChange={e=>setModel({...model,maxTokens:Number(e.target.value)})}/></label>
      <label>每日分析上限 <span className="field-note">防重复扣费</span><input type="number" min={1} max={500} value={dailyLimit} onChange={e=>setDailyLimit(Math.max(1,Math.min(500,Number(e.target.value)||1)))}/></label>
      <p className="hint">今日已发起 {dailyUsed} 次分析请求；失败或保存超时也计入。连点与 8 秒内的重复分析会被拦截，达到上限后次日自动重置。应用只统计次数、耗时与上下文大小，不估算金额。</p>
     <label className="settings-check"><input type="checkbox" checked={model.jsonMode!==false} onChange={e=>setModel({...model,jsonMode:e.target.checked})}/><span><strong>发送 JSON 模式参数</strong><small>服务不兼容时可关闭，响应仍会进行 JSON 校验。</small></span></label>
     <button className="accent settings-primary-action" disabled={!desktop} onClick={onTestModel}>测试连接并获取模型</button>
     <div className={modelStatus?'connection-status':'connection-status idle'}><i/>{modelStatus||'尚未测试连接'}</div>
    </div>
   </div>
   <label className="settings-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span><strong>允许 {modelServiceLabel(model)} 分析本局数据</strong><small>手动分析或已开启的自动推荐会发送英雄、海克斯、文档片段和历史摘要。数据授权会记住；更换服务地址后需要重新勾选。原始账号标识不发送，但手填文字可能包含个人信息。</small></span></label>
   <label className="settings-consent"><input type="checkbox" aria-label="自动模型推荐（可能产生费用）" checked={autoRecommend} disabled={!setAutoRecommend||(!autoRecommend&&!canEnableAutoRecommend)} onChange={e=>{if(!e.target.checked||canEnableAutoRecommend)setAutoRecommend?.(e.target.checked);}}/><span><strong>自动模型推荐（可能产生费用）</strong><small>默认关闭，需单独开启。仅授权当前服务和模型；切换服务或模型后需重新开启。新一组完整三张候选连续两次识别稳定后自动分析，并将当前有效结果显示在侧栏。识别本身不调用模型、不产生模型费用。</small></span></label>
   <p className="hint" role="status" aria-label="自动推荐状态">{autoRecommend?'自动推荐已开启':'自动推荐已关闭（默认手动）'}{autoRecommendStatus?` · ${autoRecommendStatus}`:!autoRecommend&&!canEnableAutoRecommend?' · 请先在桌面端填写模型并勾选数据授权。':''}</p>
   <p className="settings-footnote">同一组候选在本次运行中不会自动重复请求，失败也不会自动重试；本次应用运行中每轮最多 3 次自动请求，与手动分析共用每日总上限。局势、装备或知识变化不会额外触发自动请求。关闭立即停止新的自动调用；已发出的请求可能仍产生费用。</p>
   <details className="settings-details"><summary>协议、费用与隐私说明</summary><p>Jev 使用官方 System One 协议，默认地址为官方 api.typesafe.ai，改填第三方地址需先勾选「允许使用第三方地址」；普通模型使用统一判断问题的 JSON 适配。支持第三方 HTTPS 和本机 HTTP，不会自动切换服务商。模型费用由用户账号承担；API Key 在彻底退出应用后清空。</p></details>
  </section>

  <section className="panel settings-card settings-runtime-card">
   <div className="settings-card-head"><div><div className="eyebrow">LOCAL RUNTIME</div><h2><b>02</b> 运行与本地数据</h2><p>客户端发现与数据保留都只在这台设备上管理。</p></div></div>
   <div className="settings-runtime-grid">
    <section className="settings-subsection">
     <div className="settings-subsection-head"><span>连接</span><h3>Windows 客户端发现</h3></div>
     <p className="hint">启动后自动发现 LeagueClientUx。自动发现失败时，再填写客户端 lockfile 的绝对路径。</p>
     <label>lockfile 路径 <span className="field-note">可选</span><input placeholder="C:\Riot Games\League of Legends\lockfile" value={lockfile} onChange={e=>setLockfile(e.target.value)}/></label>
     <button disabled={!desktop||busy} onClick={onResumeLive}>重新检测客户端</button>
     <p className="settings-footnote">凭据只在 Rust 内存中用于本地请求，不回传界面、不写入日志，也不会请求管理员权限。</p>
    </section>
    <section className="settings-subsection">
     <div className="settings-subsection-head"><span>存储</span><h3>对局记忆与空间</h3></div>
     <div className="storage-meter"><div><strong>{((storage?.databaseBytes||0)/1024/1024).toFixed(1)} MB</strong><small>{budget} MB 预算</small></div><progress max={budget} value={(storage?.databaseBytes||0)/1024/1024}/><p>{storage?.sessionCount||0} 场对局 · {storage?.sampleCount||0} 份采样</p></div>
     {!!storage?.unreadableSessions&&<p className="notice">有 {storage.unreadableSessions} 条记录格式异常，已隔离显示；原文保留，可通过“导出全部历史”备份检查。</p>}
     <div className="settings-inline-fields"><label>SQLite 预算（MB）<input type="number" min={32} max={2048} value={budget} onChange={e=>setBudget(Number(e.target.value))}/></label><label>采样保留（天）<input type="number" min={1} max={365} value={days} onChange={e=>setDays(Number(e.target.value))}/></label></div>
     <button disabled={busy||!desktop} onClick={()=>onConfirm({title:'应用预算并清理原始采样？',detail:'清理过期或超预算的原始快照并回收数据库空间；不自动删除核心决策与复盘。原始快照删除后不可恢复。',action:onMaintenance})}>应用预算并清理空间</button>
     <details className="settings-details compact"><summary>查看保留与检索策略</summary><p>空闲时每 30 分钟维护，也可手动清理。内存只保留近期 30 份采样与 50 条历史摘要；推荐优先检索同英雄的最多 5 份复盘。超预算且无法清理时会拒绝新增保存，不会默默删除核心记录。</p></details>
    </section>
   </div>
  </section>

  <section className="panel settings-trust-card">
   <div><div className="eyebrow">TRUST & POLICY</div><h2><b>03</b> 边界与后台运行</h2></div>
   <div className="settings-trust-grid"><p><strong>本地优先</strong>LCU 不保证稳定；运行在本地不等于自动符合平台政策。发布前仍需核对官方规则与产品注册要求。</p><p><strong>退出语义</strong>隐藏到系统托盘期间仍会自动跟踪；从托盘选择“退出 Hexglow”后才停止采集。不安装开机自启或系统服务。</p></div>
   <p className="hint">Hexglow 是独立项目，未经 Riot Games 背书，不代表 Riot Games 或其工作人员的观点。Riot Games 及相关游戏、商标与资产归各自权利人所有。</p>
  </section>
 </div>;
}
