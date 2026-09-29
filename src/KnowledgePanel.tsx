import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {Select} from './Select';

type Doc={path:string;title:string;kind:string;status:string;patch:string};
type Check={valid:boolean;errors:string[];warnings:string[]};

export function KnowledgePanel({onChanged}:{onChanged:()=>void}){
 const [kind,setKind]=useState('Champion'),[docs,setDocs]=useState<Doc[]>([]),[path,setPath]=useState(''),[content,setContent]=useState(''),[root,setRoot]=useState('');
 const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[check,setCheck]=useState<Check|null>(null),[message,setMessage]=useState(''),[preview,setPreview]=useState(false),[deleteConfirm,setDeleteConfirm]=useState(false);
 const importInput=useRef<HTMLInputElement>(null);
 const desktop=isTauri();
 const editorRows=Math.min(28,Math.max(9,content.split(/\r?\n/).length+2));

 async function list(k=kind){const r=await invoke<{documents:Doc[];root:string}>('knowledge_list',{kind:k});setDocs(r.documents);setRoot(r.root);}
 useEffect(()=>{if(desktop)void list().catch(e=>setMessage(String(e)));},[kind]);
 function canLeave(){return !dirty||confirm('尚有未保存的文档修改，确定放弃吗？');}
 async function load(p:string){if(!canLeave())return;setBusy(true);try{const r=await invoke<{content:string}>('knowledge_read',{path:p});setPath(p);setContent(r.content);setDirty(false);setCheck(null);setMessage('');setPreview(false);}catch(e){setMessage(String(e));}finally{setBusy(false);}}
 function create(){if(!canLeave())return;setPath('augments/custom-new.md');setContent('---\ntype: Augment\ntitle: 新海克斯\ndescription: 请填写简短说明。\ntags: [海克斯]\nstatus: draft\nhexglow:\n  schema_version: 1\n  augment_id: custom-new\n  game_id: null\n  aliases: []\n  mode: hextech-aram\n  patch: unknown\n---\n\n# 完整效果\n请填写完整效果和数值。\n\n# 触发条件\n待确认。\n\n# 限制与例外\n待确认。\n\n# 相关交互\n暂无已确认资料。\n');setDirty(true);setCheck(null);setPreview(false);}
 async function validate(){const r=await invoke<Check>('knowledge_validate',{kind,path,content});setCheck(r);return r;}
 async function save(){setBusy(true);setMessage('');try{const r=await validate();if(!r.valid)return;await invoke('knowledge_save',{kind,path,content});setDirty(false);setMessage('已覆盖生效并更新索引。历史决策证据不变。');await list();onChanged();}catch(e){setMessage(String(e));}finally{setBusy(false);}}
 async function remove(){setBusy(true);try{const r=await invoke<{warnings:string[]}>('knowledge_delete',{path});setPath('');setContent('');setDirty(false);setCheck(null);setDeleteConfirm(false);setMessage(`已删除。${r.warnings?.join('；')||''}`);await list();onChanged();}catch(e){setMessage(String(e));}finally{setBusy(false);}}
 async function importMarkdown(e:ChangeEvent<HTMLInputElement>){const f=e.target.files?.[0];e.target.value='';if(!f)return;if(f.size>256*1024){setMessage('文档不能超过 256 KiB');return;}setContent(await f.text());setDirty(true);setCheck(null);setPreview(false);}

 return <section className="panel knowledge-panel">
  <div className="section-title"><h2>知识工坊 <small>OKF 0.2 · 海萤 Schema 1</small></h2><span>一份文档，直接修改生效</span></div>
  <p className="hint">内置 Patch 16.18 的英雄与海克斯榜单索引；统计资料均为待核实草稿，不包含完整游戏机制。英雄可修改不可删除；海克斯可新增、修改、删除。仅在打开本页或对局分析时加载。</p>
  {!desktop&&<div className="notice">请在 Windows Tauri 桌面端使用真实文件编辑；浏览器预览不会写入知识库。</div>}

  <div className="knowledge-controls">
   <label>文档类型<Select disabled={busy} value={kind} onChange={e=>{if(!canLeave())return;setKind(e.target.value);setPath('');setContent('');setDirty(false);setCheck(null);setPreview(false);}}><option value="Champion">英雄</option><option value="Augment">海克斯</option></Select></label>
   <label>选择文档<Select disabled={busy||!desktop} value={docs.some(d=>d.path===path)?path:''} onChange={e=>{if(e.target.value)void load(e.target.value);}}><option value="">请选择文档</option>{docs.map(d=><option value={d.path} key={d.path}>{d.title} · {d.status} · {d.patch}</option>)}</Select></label>
   {kind==='Augment'&&<button className="knowledge-create" disabled={busy||!desktop} onClick={create}>＋ 新建海克斯</button>}
  </div>

  <label className="knowledge-path">文档路径 <span>小写字母 / 数字 / 连字符；已有身份不可改</span><input disabled={busy||docs.some(d=>d.path===path)} value={path} onChange={e=>{setPath(e.target.value);setDirty(true);}} placeholder={kind==='Champion'?'champions/ahri.md':'augments/custom-new.md'}/></label>

  {path?<>
   <div className="knowledge-workspace">
    <div className="knowledge-toolbar">
     <div className="knowledge-mode" role="tablist" aria-label="文档视图">
      <button role="tab" aria-selected={!preview} className={!preview?'active':''} onClick={()=>setPreview(false)}>编辑文档</button>
      <button role="tab" aria-selected={preview} className={preview?'active':''} onClick={()=>setPreview(true)}>安全预览</button>
     </div>
     <div className="knowledge-toolbar-actions">
      <span className={dirty?'sync-status dirty':'sync-status'}>{dirty?'● 尚未保存':'✓ 已同步'}</span>
      <button className="import-button" disabled={busy} onClick={()=>importInput.current?.click()}>↑ 导入 Markdown</button>
      <input ref={importInput} className="knowledge-file-input" type="file" accept=".md,text/markdown" disabled={busy} onChange={e=>void importMarkdown(e)}/>
     </div>
    </div>
    {preview?<article className="markdown-preview">{content.split('\n').map((line,i)=>line.startsWith('# ')?<h2 key={i}>{line.slice(2)}</h2>:line.startsWith('## ')?<h3 key={i}>{line.slice(3)}</h3>:<div key={i}>{line||'\u00a0'}</div>)}</article>:<textarea rows={editorRows} className="knowledge-editor" spellCheck={false} aria-label="OKF Markdown 编辑器" value={content} disabled={busy} onChange={e=>{setContent(e.target.value);setDirty(true);setCheck(null);}}/>}
   </div>
   <div className="knowledge-footer">
    <p className="hint">预览只显示安全文本与标题，不执行 HTML 或代码。</p>
    <div className="knowledge-footer-actions">
     <button className="knowledge-validate" disabled={busy||!desktop} onClick={()=>void validate().catch(e=>setMessage(String(e)))}>校验格式</button>
     <button className="accent knowledge-save" disabled={busy||!desktop} onClick={()=>void save()}>保存并生效</button>
     {kind==='Augment'&&<button className="danger" disabled={busy||!docs.some(d=>d.path===path)} onClick={()=>setDeleteConfirm(true)}>删除海克斯</button>}
    </div>
   </div>
  </>:<div className="knowledge-empty-state"><span>◇</span><div><h3>选择一份文档后开始编辑</h3><p>{kind==='Augment'?'从上方选择已有文档，或新建一份海克斯知识。':'从上方选择英雄文档；内容会在这里按实际长度展开。'}</p></div></div>}

  {check&&<div className={check.valid?'notice':'error'}>{check.valid?'格式校验通过':'不能保存'}{check.errors.map((s,i)=><div key={i}>错误：{s}</div>)}{check.warnings.map((s,i)=><div key={i}>提示：{s}</div>)}</div>}
  {message&&<div className="notice">{message}</div>}
  <p className="hint knowledge-location">{root||'应用数据目录 / knowledge'} · 备份仅保留最近有限版本，不参与检索。</p>

  {deleteConfirm&&<div className="modal-backdrop"><section className="modal knowledge-delete-modal" role="dialog" aria-modal="true"><h2>删除当前海克斯文档？</h2><p>该文档将不再参与新分析，关联链接可能失效。历史决策中的已保存依据不会删除。</p><div className="knowledge-delete-actions"><button onClick={()=>setDeleteConfirm(false)}>取消</button><button className="danger" disabled={busy} onClick={()=>void remove()}>确认删除</button></div></section></div>}
 </section>;
}
