// @vitest-environment jsdom
import {useState} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {cleanup,fireEvent,render as mount} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {KnowledgeFormEditor} from './KnowledgeFormEditor';
import type {KnowledgeFields,KnowledgeKind} from './knowledgeForm';

const fields:KnowledgeFields={title:'测试资料',description:'简要说明',status:'draft',patch:'unknown',tags:['机制','条件'],aliases:['别称一','别称二'],sections:{'基础机制':'机制正文','常见打法':'打法正文','海克斯搭配':'搭配正文','注意事项':'注意正文','完整效果':'效果正文','触发条件':'触发正文','限制与例外':'限制正文','相关交互':'交互正文'}};
const render=(kind:KnowledgeKind='Champion',disabled=false,value=fields)=>renderToStaticMarkup(<KnowledgeFormEditor kind={kind} fields={value} disabled={disabled} onChange={()=>{}}/>);

afterEach(cleanup);

describe('guided knowledge editor',()=>{
 it('does not describe a deprecated document as disabled from retrieval',()=>{
  const html=render('Champion',false,{...fields,status:'deprecated'});
  expect(html).toContain('已过时');
  expect(html).toContain('不会自动排除检索');
  expect(html).not.toContain('已停用');
 });
 it('provides Chinese champion fields without exposing technical metadata',()=>{
  const html=render();
  for(const label of ['英雄名称','一句话说明','基础机制','常见打法','海克斯搭配','注意事项'])expect(html).toContain(label);
  expect(html).toContain('机制正文');expect(html).toContain('直接输入中文');
  expect(html).not.toContain('YAML');expect(html).not.toContain('schema_version');expect(html).not.toContain('champion_id');expect(html).not.toContain('文档路径');
  expect((html.match(/<textarea /g)||[]).length).toBe(7);
 });
 it('provides augment-specific prompts without changing stored text',()=>{
  const html=render('Augment');
  for(const label of ['海克斯名称','完整效果','触发条件','限制与例外','相关交互'])expect(html).toContain(label);
  expect(html).toContain('效果正文');expect(html).not.toContain('机制正文');
  expect(html).toContain('没有可靠资料时请填写待核实');
 });
 it('keeps optional metadata collapsed and explains status without claiming verification',()=>{
  const html=render();
  expect(html).toContain('<details class="knowledge-form-details">');
  expect(html).not.toMatch(/<details[^>]*\sopen/);
  for(const label of ['适用版本','资料状态','别名','标签','待核实'])expect(html).toContain(label);
  expect(html).toContain('不代表内容已自动核验');
  expect(html).toContain('别称一\n别称二');expect(html).toContain('每行填写一个');
 });
 it('associates visible field labels and guidance with accessible controls',()=>{
  const html=render();
  const labels=[...html.matchAll(/<label for="([^"]+)"/g)].map(match=>match[1]);
  expect(labels).toHaveLength(10);
  for(const id of labels)expect(html).toContain(`id="${id}"`);
  expect(html).toContain('aria-label="资料状态"');expect(html).toContain('aria-describedby=');
 });
 it('disables every edit control while an operation is in progress',()=>{
  const html=render('Champion',true);
  expect(html).toMatch(/<fieldset[^>]+disabled=""/);
  for(const control of html.matchAll(/<(?:input|textarea|button)\b[^>]*>/g))expect(control[0]).toContain('disabled=""');
 });
 it('renders imported content as escaped text rather than executable markup',()=>{
  const html=render('Champion',false,{...fields,title:'<img src=x onerror=alert(1)>',description:'<script>alert(1)</script>',sections:{...fields.sections,'基础机制':'</textarea><script>alert(2)</script>'}});
  expect(html).not.toContain('<script>');expect(html).not.toContain('<img ');
  expect(html).toContain('&lt;script&gt;');expect(html).toContain('&lt;/textarea&gt;');
 });
 it('preserves unknown status instead of silently choosing a trusted status',()=>{
  const html=render('Champion',false,{...fields,status:'custom-status'});
  expect(html).toContain('其他状态（保留原值）');
  expect(html).not.toContain('<span>已整理</span>');
 });

 it.each([['别名','aliases'],['标签','tags']] as const)('notifies the parent immediately and preserves whitespace while typing %s', (label,key)=>{
  const onChange=vi.fn();
  function Harness(){
   const [value,setValue]=useState(fields);
   return <KnowledgeFormEditor kind="Champion" fields={value} disabled={false} onChange={next=>{onChange(next);setValue(next);}}/>;
  }
  const screen=mount(<Harness/>);
  const input=screen.getByLabelText(label) as HTMLTextAreaElement;
  for(const text of [' 新称呼',' 新称呼\n',' 新称呼\n\n',' 新称呼\n\n 另一个 ']){
   fireEvent.change(input,{target:{value:text}});
   expect(input.value).toBe(text);
   expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({[key]:text.split('\n')}));
  }
  expect(onChange).toHaveBeenCalledTimes(4);
  fireEvent.blur(input);
  expect(input.value).toBe('新称呼\n另一个');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({[key]:['新称呼','另一个']}));
 });

 it('normalizes duplicates only on blur without overwriting other edited fields',()=>{
  const onChange=vi.fn();
  function Harness(){
   const [value,setValue]=useState(fields);
   return <KnowledgeFormEditor kind="Champion" fields={value} disabled={false} onChange={next=>{onChange(next);setValue(next);}}/>;
  }
  const screen=mount(<Harness/>);
  const aliases=screen.getByLabelText('别名') as HTMLTextAreaElement;
  fireEvent.change(aliases,{target:{value:' 别称 \n别称\n\n'}});
  expect(aliases.value).toBe(' 别称 \n别称\n\n');
  fireEvent.change(screen.getByLabelText('英雄名称'),{target:{value:'修改后的名称'}});
  fireEvent.blur(aliases);
  expect(aliases.value).toBe('别称');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({title:'修改后的名称',aliases:['别称']}));
 });
});
