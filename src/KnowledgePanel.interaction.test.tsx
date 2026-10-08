// @vitest-environment jsdom
import type {SelectHTMLAttributes} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {KnowledgePanel} from './KnowledgePanel';
import {createAugmentDocument} from './knowledgeForm';

const {invokeMock}=vi.hoisted(()=>({invokeMock:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:invokeMock}));
vi.mock('./Select',()=>({Select:(props:SelectHTMLAttributes<HTMLSelectElement>)=><select {...props}/> }));

const championPath='champions/ahri.md';
const champion=`---
# Keep the author's metadata comment.
title: 阿狸
description: 原始说明
tags: [机制]
status: draft
type: Champion
author_extension: {retain: "exactly this"}
hexglow:
  schema_version: 1
  mode: hextech-aram
  patch: "unknown"
  champion_id: ahri
  aliases: [Ahri]
  verified: false
---
# 阿狸

> 原有引言必须保留。

## 基础机制
原始机制。

## 常见打法
原始打法。

## 海克斯搭配
[原有关联](../augments/example.md)

## 注意事项
原始注意事项。

## 我的补充
自定义正文及 <script>inert()</script> 必须保留。
`;
type InvokeArgs={kind?:string;path?:string;content?:string};
type Guard=()=>boolean;
let stored:Record<string,string>;
let operations:string[];

function listing(kind='Champion'){
 return {root:'X:/mock-only/knowledge',warnings:[],documents:kind==='Champion'?[{path:championPath,title:'阿狸',kind,status:'draft',patch:'unknown'}]:[]};
}
async function backend(command:string,args:InvokeArgs={}){
 operations.push(command);
 if(command==='knowledge_list')return listing(args.kind);
 if(command==='knowledge_read')return {path:args.path,content:stored[args.path!]};
 if(command==='knowledge_validate')return {valid:true,errors:[],warnings:[]};
 if(command==='knowledge_save'){stored[args.path!]=args.content!;return {path:args.path,valid:true,warnings:[]};}
 throw new Error(`Unexpected mocked command: ${command}`);
}
function changed(){operations.push('onChanged');}
async function openChampion(props:Partial<Parameters<typeof KnowledgePanel>[0]>={}){
 const mounted=render(<KnowledgePanel onChanged={changed} {...props}/>);
 await waitFor(()=>expect((screen.getByLabelText('选择英雄') as HTMLSelectElement).disabled).toBe(false));
 fireEvent.change(screen.getByLabelText('选择英雄'),{target:{value:championPath}});
 await waitFor(()=>expect((screen.getByRole('tab',{name:'表单编辑'}) as HTMLButtonElement).disabled).toBe(false));
 return mounted;
}
const mechanism=()=>screen.getByRole('textbox',{name:/基础机制/}) as HTMLTextAreaElement;
const saveButton=()=>screen.getByRole('button',{name:'保存资料'}) as HTMLButtonElement;
const source=()=>screen.getByLabelText('Markdown 高级编辑器') as HTMLTextAreaElement;

beforeEach(()=>{
 stored={[championPath]:champion};operations=[];
 invokeMock.mockReset();invokeMock.mockImplementation(backend);
 vi.spyOn(window,'confirm').mockReturnValue(false);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe('knowledge panel user interactions (mocked desktop I/O only)',()=>{
 it('loads into the Chinese form with technical fields hidden and no model request',async()=>{
  const {container}=await openChampion();
  expect((screen.getByLabelText('英雄名称') as HTMLInputElement).value).toBe('阿狸');
  expect(mechanism().value).toBe('原始机制。');
  expect(screen.getByRole('tab',{name:'表单编辑'}).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByLabelText('Markdown 高级编辑器')).toBeNull();
  expect(screen.queryByLabelText('文件位置（自动管理）')).toBeNull();
  expect(container.textContent).not.toContain('schema_version');
  expect(container.textContent).not.toContain('champion_id');
  expect(container.querySelector('.knowledge-form-details')?.hasAttribute('open')).toBe(false);
  expect(saveButton().disabled).toBe(true);
  expect(operations).toEqual(['knowledge_list','knowledge_read']);
 });

 it('saves edited body through validate → save → invalidation → list, preserving all unrelated text',async()=>{
  const onChanged=vi.fn(changed);
  await openChampion({onChanged});operations=[];
  fireEvent.change(mechanism(),{target:{value:'新的机制与成立条件。'}});
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(()=>expect(onChanged).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(saveButton().disabled).toBe(true));
  expect(operations).toEqual(['knowledge_validate','knowledge_save','onChanged','knowledge_list']);
  expect(stored[championPath]).toBe(champion.replace('## 基础机制\n原始机制。','## 基础机制\n\n新的机制与成立条件。'));
  expect(screen.getByText(/资料已保存。下次模型分析/)).toBeTruthy();
 });

 it('retains unsaved content when validation rejects and never attempts a write',async()=>{
  invokeMock.mockImplementation((command:string,args:InvokeArgs)=>command==='knowledge_validate'
   ?Promise.resolve({valid:false,errors:['Required string: description'],warnings:[]})
   :backend(command,args));
  const onChanged=vi.fn();await openChampion({onChanged});
  fireEvent.change(mechanism(),{target:{value:'仍未保存的文字。'}});
  fireEvent.click(saveButton());
  await screen.findByText('请填写一句话说明。');
  expect(mechanism().value).toBe('仍未保存的文字。');
  expect(screen.getByText('● 尚未保存')).toBeTruthy();
  expect(saveButton().disabled).toBe(false);
  expect(invokeMock.mock.calls.some(([command])=>command==='knowledge_save')).toBe(false);
  expect(onChanged).not.toHaveBeenCalled();
 });

 it('retains dirty content on save failure and translates duplicate aliases to Chinese',async()=>{
  invokeMock.mockImplementation((command:string,args:InvokeArgs)=>command==='knowledge_save'
   ?Promise.reject('Duplicate title, ID or alias: champions/other.md')
   :backend(command,args));
  const onChanged=vi.fn();await openChampion({onChanged});
  fireEvent.change(screen.getByLabelText('别名'),{target:{value:'已存在的别名'}});
  fireEvent.click(saveButton());
  await screen.findByText('名称或别名与已有资料重复，请使用不同名称或删除重复别名。');
  expect((screen.getByLabelText('别名') as HTMLTextAreaElement).value).toBe('已存在的别名');
  expect(screen.getByText('● 尚未保存')).toBeTruthy();
  expect(saveButton().disabled).toBe(false);
  expect(stored[championPath]).toBe(champion);
  expect(onChanged).not.toHaveBeenCalled();
 });

 it('shares one draft between source and form while preserving unknown YAML, links and custom sections',async()=>{
  await openChampion();
  fireEvent.click(screen.getByRole('tab',{name:'高级编辑'}));
  const edited=source().value.replace('原始机制。','在高级编辑修改的机制。');
  fireEvent.change(source(),{target:{value:edited}});
  fireEvent.click(screen.getByRole('tab',{name:'表单编辑'}));
  expect(mechanism().value).toBe('在高级编辑修改的机制。');
  fireEvent.change(screen.getByRole('textbox',{name:/常见打法/}),{target:{value:'在表单修改的打法。'}});
  fireEvent.click(screen.getByRole('tab',{name:'高级编辑'}));
  expect(source().value).toBe(edited.replace('## 常见打法\n原始打法。','## 常见打法\n\n在表单修改的打法。'));
  expect(window.confirm).not.toHaveBeenCalled();
  fireEvent.click(saveButton());
  await screen.findByText(/资料已保存。下次模型分析/);
  expect(stored[championPath]).toContain('# Keep the author\'s metadata comment.');
  expect(stored[championPath]).toContain('author_extension: {retain: "exactly this"}');
  expect(stored[championPath]).toContain('[原有关联](../augments/example.md)');
  expect(stored[championPath]).toContain('## 我的补充\n自定义正文及 <script>inert()</script> 必须保留。');
 });

 it('creates a new augment with an automatically matching path and ID, without asking for technical fields',async()=>{
  render(<KnowledgePanel onChanged={changed}/>);
  await waitFor(()=>expect((screen.getByLabelText('资料分类') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('资料分类'),{target:{value:'Augment'}});
  await waitFor(()=>expect((screen.getByRole('button',{name:'＋ 新建海克斯资料'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'＋ 新建海克斯资料'}));
  fireEvent.change(screen.getByLabelText('海克斯名称'),{target:{value:'新的测试海克斯'}});
  expect(screen.queryByLabelText('文件位置（自动管理）')).toBeNull();
  fireEvent.click(saveButton());
  await screen.findByText(/资料已保存。下次模型分析/);
  const call=invokeMock.mock.calls.find(([command])=>command==='knowledge_save')!;
  const args=call[1] as InvokeArgs;
  expect(args.kind).toBe('Augment');
  expect(args.path).toMatch(/^augments\/custom-[a-f0-9-]+\.md$/);
  const id=args.path!.replace(/^augments\//,'').replace(/\.md$/,'');
  expect(args.content).toContain(`augment_id: "${id}"`);
  expect(args.content).toContain('title: "新的测试海克斯"');
  expect(args.content).toContain('  verified: false');
 });

 it('falls back safely for malformed source without rewriting it or allowing a form save',async()=>{
  stored[championPath]=champion.replace('## 基础机制','## 不支持的栏目');
  await openChampion();
  expect(screen.getByRole('alert').textContent).toContain('这份资料需要使用高级编辑');
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'查看原文'}));
  expect(source().value).toBe(stored[championPath]);
  expect(screen.getByText('✓ 已保存')).toBeTruthy();
  expect(invokeMock.mock.calls.some(([command])=>command==='knowledge_save')).toBe(false);
 });

 it('marks alias-only typing dirty immediately, preserves blank lines and blocks rejected navigation before blur',async()=>{
  let guard:Guard|null=null;
  await openChampion({onLeaveGuard:next=>{guard=next;}});
  const aliases=screen.getByLabelText('别名') as HTMLTextAreaElement;
  fireEvent.change(aliases,{target:{value:' 新别名\n\n'}});
  expect(aliases.value).toBe(' 新别名\n\n');
  expect(screen.getByText('● 尚未保存')).toBeTruthy();
  expect(saveButton().disabled).toBe(false);
  expect(guard).toBeTypeOf('function');
  expect(guard!()).toBe(false);
  expect(window.confirm).toHaveBeenCalledTimes(1);
  const unload=new Event('beforeunload',{cancelable:true});
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  expect(aliases.value).toBe(' 新别名\n\n');
  fireEvent.blur(aliases);
  expect(aliases.value).toBe('新别名');
 });

 it('blocks leaving while reading and unregisters its leave guard when unmounted',async()=>{
  let releaseRead!:()=>void;
  const readDone=new Promise<void>(resolve=>{releaseRead=resolve;});
  invokeMock.mockImplementation(async(command:string,args:InvokeArgs)=>{
   if(command==='knowledge_read')await readDone;
   return backend(command,args);
  });
  let guard:Guard|null=null;
  const onLeaveGuard=vi.fn((next:Guard|null)=>{guard=next;});
  const mounted=render(<KnowledgePanel onChanged={changed} onLeaveGuard={onLeaveGuard}/>);
  await waitFor(()=>expect((screen.getByLabelText('选择英雄') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('选择英雄'),{target:{value:championPath}});
  expect(guard).toBeTypeOf('function');
  expect(guard!()).toBe(false);
  expect(window.confirm).not.toHaveBeenCalled();
  await act(async()=>{releaseRead();await readDone;});
  await waitFor(()=>expect(mechanism().disabled).toBe(false));
  expect(guard!()).toBe(true);
  mounted.unmount();
  expect(onLeaveGuard).toHaveBeenLastCalledWith(null);
 });

 it('still invalidates recommendations after successful save when refreshing the list fails',async()=>{
  let listCount=0;
  invokeMock.mockImplementation((command:string,args:InvokeArgs)=>{
   if(command==='knowledge_list'&&++listCount>1)return Promise.reject('refresh unavailable');
   return backend(command,args);
  });
  const onChanged=vi.fn();await openChampion({onChanged});
  fireEvent.change(mechanism(),{target:{value:'成功写入但刷新失败。'}});
  fireEvent.click(saveButton());
  await screen.findByText(/资料已保存，但列表刷新失败/);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(stored[championPath]).toContain('成功写入但刷新失败。');
  expect(screen.getByText('✓ 已保存')).toBeTruthy();
  expect(saveButton().disabled).toBe(true);
 });

 it('locks source editing and navigation while an explicit format check is pending',async()=>{
  let releaseCheck!:()=>void;
  const checkDone=new Promise<void>(resolve=>{releaseCheck=resolve;});
  invokeMock.mockImplementation(async(command:string,args:InvokeArgs)=>{
   if(command==='knowledge_validate')await checkDone;
   return backend(command,args);
  });
  let guard:Guard|null=null;
  await openChampion({onLeaveGuard:next=>{guard=next;}});
  fireEvent.click(screen.getByRole('tab',{name:'高级编辑'}));
  fireEvent.click(screen.getByRole('button',{name:'检查格式'}));
  expect(source().disabled).toBe(true);
  expect((screen.getByRole('tab',{name:'表单编辑'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('选择英雄') as HTMLSelectElement).disabled).toBe(true);
  expect(guard!()).toBe(false);
  await act(async()=>{releaseCheck();await checkDone;});
  await waitFor(()=>expect(source().disabled).toBe(false));
  expect(guard!()).toBe(true);
  expect(invokeMock.mock.calls.some(([command])=>command==='knowledge_save')).toBe(false);
 });

 it('imports a new augment under its document ID without requiring manual filename edits',async()=>{
  vi.mocked(window.confirm).mockReturnValue(true);
  const {container}=render(<KnowledgePanel onChanged={changed}/>);
  await waitFor(()=>expect((screen.getByLabelText('资料分类') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('资料分类'),{target:{value:'Augment'}});
  await waitFor(()=>expect((screen.getByRole('button',{name:'＋ 新建海克斯资料'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'＋ 新建海克斯资料'}));
  fireEvent.click(screen.getByRole('tab',{name:'高级编辑'}));
  const imported=createAugmentDocument('custom-imported');
  const file=new File([imported],'my-knowledge.md',{type:'text/markdown'});
  Object.defineProperty(file,'text',{value:vi.fn().mockResolvedValue(imported)});
  fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[file]}});
  await screen.findByText('已导入到编辑区，尚未保存。可以切换到表单继续填写。');
  expect(source().value).toBe(imported);
  expect((screen.getByLabelText('文件位置（自动管理）') as HTMLInputElement).value).toBe('augments/custom-imported.md');
  fireEvent.click(screen.getByRole('tab',{name:'表单编辑'}));
  expect((screen.getByLabelText('海克斯名称') as HTMLInputElement).value).toBe('新海克斯');
  fireEvent.click(saveButton());
  await screen.findByText(/资料已保存。下次模型分析/);
  expect(stored['augments/custom-imported.md']).toBe(imported);
 });

 it('reports a successful deletion separately from refresh failure and removes the stale option',async()=>{
  const augmentPath='augments/custom-existing.md';
  stored[augmentPath]=createAugmentDocument('custom-existing');
  let augmentLists=0;
  invokeMock.mockImplementation(async(command:string,args:InvokeArgs)=>{
   if(command==='knowledge_list'&&args.kind==='Augment'){
    if(++augmentLists>1)throw new Error('refresh unavailable');
    return {root:'X:/mock-only/knowledge',warnings:[],documents:[{path:augmentPath,title:'现有海克斯',kind:'Augment',status:'draft',patch:'unknown'}]};
   }
   if(command==='knowledge_delete'){delete stored[args.path!];return {deleted:true,warnings:[]};}
   return backend(command,args);
  });
  const onChanged=vi.fn();render(<KnowledgePanel onChanged={onChanged}/>);
  await waitFor(()=>expect((screen.getByLabelText('资料分类') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('资料分类'),{target:{value:'Augment'}});
  await waitFor(()=>expect((screen.getByLabelText('选择海克斯') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('选择海克斯'),{target:{value:augmentPath}});
  await screen.findByLabelText('海克斯名称');
  fireEvent.click(screen.getByRole('button',{name:'删除资料'}));
  expect(stored[augmentPath]).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'确认删除'}));
  await screen.findByText(/资料已删除，但列表刷新失败/);
  expect(stored[augmentPath]).toBeUndefined();
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('option',{name:/现有海克斯/})).toBeNull();
  expect(screen.queryByLabelText('海克斯名称')).toBeNull();
 });
});
