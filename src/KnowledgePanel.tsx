import {useEffect,useMemo,useRef,useState,type ChangeEvent} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {Select} from './Select';
import {KnowledgeFormEditor} from './KnowledgeFormEditor';
import {createAugmentDocument,readKnowledgeForm,updateKnowledgeForm,type KnowledgeFields,type KnowledgeKind} from './knowledgeForm';
import {knowledgeMessage,knowledgeStatusLabel} from './knowledgeMessages';
import {knowledgeImportPath} from './knowledgeImport';

type Doc={path:string;title:string;kind:string;status:string;patch:string};
type Check={valid:boolean;errors:string[];warnings:string[]};
type Listing={documents:Doc[];root:string;warnings?:string[]};
type EditorMode='form'|'source'|'preview';

export function KnowledgePanel({onChanged,onLeaveGuard}:{onChanged:()=>void;onLeaveGuard?:(guard:(()=>boolean)|null)=>void}){
 const [kind,setKind]=useState<KnowledgeKind>('Champion'),[docs,setDocs]=useState<Doc[]>([]),[path,setPath]=useState(''),[content,setContent]=useState(''),[root,setRoot]=useState('');
 const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[check,setCheck]=useState<Check|null>(null),[message,setMessage]=useState(''),[mode,setMode]=useState<EditorMode>('form'),[deleteConfirm,setDeleteConfirm]=useState(false);
 const [listWarnings,setListWarnings]=useState<string[]>([]);
 const importInput=useRef<HTMLInputElement>(null);
 const desktop=isTauri();
 const form=useMemo(()=>content?readKnowledgeForm(content,kind):null,[content,kind]);
 const editorRows=Math.min(28,Math.max(9,content.split(/\r?\n/).length+2));
 const previewBody=content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');

 function showList(result:Listing){setDocs(result.documents);setRoot(result.root);setListWarnings(result.warnings||[]);}
 async function list(){showList(await invoke<Listing>('knowledge_list',{kind}));}
 useEffect(()=>{
  if(!desktop)return;
  let active=true;
  setBusy(true);
  void invoke<Listing>('knowledge_list',{kind}).then(result=>{if(active)showList(result);}).catch(e=>{if(active)setMessage(knowledgeMessage(String(e)));}).finally(()=>{if(active)setBusy(false);});
  return ()=>{active=false;};
 },[kind,desktop]);
 useEffect(()=>{
  if(!dirty)return;
  const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',warn);
  return ()=>window.removeEventListener('beforeunload',warn);
 },[dirty]);
 useEffect(()=>{
  onLeaveGuard?.(()=>{if(busy){setMessage('资料正在处理中，请稍候再离开。');return false;}return !dirty||confirm('尚有未保存的资料修改，确定放弃吗？');});
  return ()=>onLeaveGuard?.(null);
 },[dirty,busy,onLeaveGuard]);
 function canLeave(){return !dirty||confirm('尚有未保存的资料修改，确定放弃吗？');}
 function edit(next:string){setContent(next);setDirty(true);setCheck(null);setMessage('');}
 function changeFields(fields:KnowledgeFields){try{edit(updateKnowledgeForm(content,kind,fields));}catch(e){setMessage(knowledgeMessage(String(e)));}}
 async function load(p:string){
  if(!canLeave())return;
  setBusy(true);
  try{const r=await invoke<{content:string}>('knowledge_read',{path:p});setPath(p);setContent(r.content);setDirty(false);setCheck(null);setMessage('');setMode('form');setDeleteConfirm(false);}
  catch(e){setMessage(knowledgeMessage(String(e)));}finally{setBusy(false);}
 }
 function create(){
  if(!canLeave())return;
  const id=`custom-${crypto.randomUUID()}`;
  setPath(`augments/${id}.md`);setContent(createAugmentDocument(id));setDirty(true);setCheck(null);setMessage('');setMode('form');setDeleteConfirm(false);
 }
 async function validate(){const r=await invoke<Check>('knowledge_validate',{kind,path,content});setCheck(r);return r;}
 async function checkFormat(){setBusy(true);setMessage('');try{await validate();}catch(e){setMessage(knowledgeMessage(String(e)));}finally{setBusy(false);}}
 async function save(){
  setBusy(true);setMessage('');
  try{
   const r=await validate();if(!r.valid)return;
   const saved=await invoke<{warnings?:string[]}>('knowledge_save',{kind,path,content});
   setDirty(false);setCheck({...r,warnings:[...new Set([...r.warnings,...(saved.warnings||[])])]});
   setMessage('资料已保存。下次主动模型分析会读取更新；历史分析不变，也不会自动调用模型。');
   // Invalidate current recommendations after the write, even if list refresh fails.
   onChanged();
   try{await list();}catch(e){setMessage(`资料已保存，但列表刷新失败：${knowledgeMessage(String(e))}`);}
  }catch(e){setMessage(knowledgeMessage(String(e)));}finally{setBusy(false);}
 }
 async function remove(){
  setBusy(true);
  try{
   const r=await invoke<{warnings:string[]}>('knowledge_delete',{path});
   setPath('');setContent('');setDirty(false);setCheck(null);setDeleteConfirm(false);
   setDocs(previous=>previous.filter(doc=>doc.path!==path));
   setMessage(r.warnings?.length?'已删除。其他资料仍有关联此项的链接，请检查。':'已删除当前海克斯资料。');
   onChanged();try{await list();}catch(e){setMessage(`资料已删除，但列表刷新失败：${knowledgeMessage(String(e))}`);}
  }catch(e){setMessage(knowledgeMessage(String(e)));}finally{setBusy(false);}
 }
 async function importMarkdown(e:ChangeEvent<HTMLInputElement>){
  const file=e.target.files?.[0];e.target.value='';if(!file||!canLeave())return;
  if(file.size>256*1024){setMessage('资料内容不能超过 256 KiB，请精简后再导入。');return;}
  setBusy(true);
  try{const imported=await file.text();const importedPath=knowledgeImportPath(imported,kind,path,docs.map(doc=>doc.path));setPath(importedPath);edit(imported);setMode('source');setMessage('已导入到编辑区，尚未保存。可以切换到表单继续填写。');}
  catch(e){setMessage(knowledgeMessage(String(e)));}finally{setBusy(false);}
 }

 return <section className="panel knowledge-panel">
  <div className="section-title"><h2>知识工坊</h2><span>选择资料 · 填写内容 · 保存使用</span></div>
  <p className="hint">直接填写中文内容即可，不需要了解文档格式。适用版本以各文档标注为准，可在下方列表中查看。内置资料为待核实草稿；英雄可修改，海克斯可新增、修改、删除。</p>
  {!desktop&&<div className="notice">请在 Windows 桌面端编辑真实资料；浏览器预览不会写入知识库。</div>}
  {listWarnings.map((warning,i)=><div className="notice" key={i}>{knowledgeMessage(warning)}</div>)}

  <div className="knowledge-controls">
   <label>资料分类<Select aria-label="资料分类" disabled={busy} value={kind} onChange={e=>{if(!canLeave())return;setKind(e.target.value as KnowledgeKind);setDocs([]);setPath('');setContent('');setDirty(false);setCheck(null);setMessage('');setMode('form');setDeleteConfirm(false);}}><option value="Champion">英雄</option><option value="Augment">海克斯</option></Select></label>
   <label>选择{kind==='Champion'?'英雄':'海克斯'}<Select aria-label={kind==='Champion'?'选择英雄':'选择海克斯'} disabled={busy||!desktop} value={docs.some(d=>d.path===path)?path:''} onChange={e=>{if(e.target.value)void load(e.target.value);}}><option value="">{busy?'正在加载…':'输入名称搜索或选择'}</option>{docs.map(d=><option value={d.path} key={d.path}>{d.title} · {knowledgeStatusLabel(d.status)} · {d.patch==='unknown'?'版本待确认':d.patch}</option>)}</Select></label>
   {kind==='Augment'&&<button className="knowledge-create" disabled={busy||!desktop} onClick={create}>＋ 新建海克斯资料</button>}
  </div>

  {path?<>
   <div className="knowledge-workspace">
    <div className="knowledge-toolbar">
     <div className="knowledge-mode" role="tablist" aria-label="编辑方式">
      <button role="tab" aria-selected={mode==='form'} disabled={busy} className={mode==='form'?'active':''} onClick={()=>setMode('form')}>表单编辑</button>
      <button role="tab" aria-selected={mode==='preview'} disabled={busy} className={mode==='preview'?'active':''} onClick={()=>setMode('preview')}>内容预览</button>
      <button role="tab" aria-selected={mode==='source'} disabled={busy} className={mode==='source'?'active':''} onClick={()=>setMode('source')}>高级编辑</button>
     </div>
     <span className={dirty?'sync-status dirty':'sync-status'} role="status">{dirty?'● 尚未保存':'✓ 已保存'}</span>
    </div>
    {mode==='form'?(form?.fields?<>
     <KnowledgeFormEditor key={path} kind={kind} fields={form.fields} disabled={busy} onChange={changeFields}/>
     {!!form.extraSections.length&&<p className="hint knowledge-preserved">另有 {form.extraSections.length} 段自定义内容，保存表单时会原样保留；可在高级编辑中修改。</p>}
    </>:<div className="knowledge-form-unavailable" role="alert"><h3>这份资料需要使用高级编辑</h3><p>{form?.error||'无法安全读取表单内容。'}</p><p>原文没有被修改。为保护自定义格式，不会自动重建资料。</p><button disabled={busy} onClick={()=>setMode('source')}>查看原文</button></div>):
     mode==='preview'?<article className="markdown-preview" aria-label="知识内容预览">{previewBody.split(/\r?\n/).map((line,i)=>line.startsWith('# ')?<h2 key={i}>{line.slice(2)}</h2>:line.startsWith('## ')?<h3 key={i}>{line.slice(3)}</h3>:<div key={i}>{line||'\u00a0'}</div>)}</article>:<>
      <div className="knowledge-source-tools">
       <p className="hint">高级编辑适合熟悉 Markdown 的用户。切换编辑方式不会丢失未保存内容；类型和已有身份不能修改。</p>
       <label className="knowledge-path">文件位置（自动管理）<input readOnly value={path}/></label>
       <button className="import-button" disabled={busy||!desktop} onClick={()=>importInput.current?.click()}>导入 Markdown 文件</button>
       <input ref={importInput} className="knowledge-file-input" type="file" accept=".md,text/markdown" disabled={busy} onChange={e=>void importMarkdown(e)}/>
      </div>
      <textarea rows={editorRows} className="knowledge-editor" spellCheck={false} aria-label="Markdown 高级编辑器" value={content} disabled={busy} onChange={e=>edit(e.target.value)}/>
     </>}
   </div>
   <div className="knowledge-footer">
    <p className="hint">保存时自动检查格式。新内容供下次主动分析使用，不会自动调用模型。</p>
    <div className="knowledge-footer-actions">
     {mode==='source'&&<button className="knowledge-validate" disabled={busy||!desktop} onClick={()=>void checkFormat()}>检查格式</button>}
     <button className="accent knowledge-save" disabled={busy||!desktop||!dirty||(mode==='form'&&!form?.fields)} onClick={()=>void save()}>{busy?'处理中…':'保存资料'}</button>
     {kind==='Augment'&&<button className="danger" disabled={busy||!docs.some(d=>d.path===path)} onClick={()=>setDeleteConfirm(true)}>删除资料</button>}
    </div>
   </div>
  </>:<div className="knowledge-empty-state"><span>◇</span><div><h3>选择{kind==='Champion'?'英雄':'海克斯'}，直接修改资料</h3><p>{kind==='Augment'?'选择已有海克斯，或新建一份资料；文件和编号由程序自动管理。':'选好英雄后，按基础机制、常见打法、海克斯搭配和注意事项分别填写。'}</p></div></div>}

  {check&&<div className={check.valid?'notice':'error'} role="status">{check.valid?'格式检查通过（不代表内容已核实）':'暂时无法保存'}{check.errors.map((s,i)=><div key={i}>{knowledgeMessage(s)}</div>)}{check.warnings.map((s,i)=><div key={i}>{knowledgeMessage(s)}</div>)}</div>}
  {message&&<div className="notice" role="status">{message}</div>}
  <details className="knowledge-location"><summary>存储与备份</summary><p className="hint">{root||'应用数据目录 / knowledge'}<br/>文件格式和编号由程序管理。已有资料保存前会保留有限备份，备份不参与检索。</p></details>

  {deleteConfirm&&<div className="modal-backdrop"><section className="modal knowledge-delete-modal" role="dialog" aria-modal="true" aria-label="删除当前海克斯资料"><h2>删除当前海克斯资料？</h2><p>该资料将不再参与新分析，关联链接可能失效。历史决策中的已保存依据不会删除。</p><div className="knowledge-delete-actions"><button disabled={busy} onClick={()=>setDeleteConfirm(false)}>取消</button><button className="danger" disabled={busy} onClick={()=>void remove()}>确认删除</button></div></section></div>}
 </section>;
}
