import {describe,expect,it} from 'vitest';
import {createAugmentDocument} from './knowledgeForm';
import {knowledgeImportPath} from './knowledgeImport';
import {knowledgeMessage,knowledgeStatusLabel} from './knowledgeMessages';

describe('knowledge import identity',()=>{
 const content=createAugmentDocument('custom-example');
 it('uses the imported identity for an unsaved new augment',()=>{
  expect(knowledgeImportPath(content,'Augment','augments/custom-random.md',[])).toBe('augments/custom-example.md');
 });
 it('does not silently overwrite an existing augment from a new draft',()=>{
  expect(()=>knowledgeImportPath(content,'Augment','augments/custom-random.md',['augments/custom-example.md'])).toThrow('已存在');
 });
 it('allows matching existing imports and refuses mismatched identities',()=>{
  expect(knowledgeImportPath(content,'Augment','augments/custom-example.md',['augments/custom-example.md'])).toBe('augments/custom-example.md');
  expect(()=>knowledgeImportPath(content,'Augment','augments/custom-other.md',['augments/custom-other.md'])).toThrow('不属于当前对象');
 });
 it('rejects malformed frontmatter, traversal and wrong kind',()=>{
  expect(()=>knowledgeImportPath('not markdown','Augment','augments/custom-new.md',[])).toThrow();
  expect(()=>knowledgeImportPath(content.replaceAll('custom-example','../escape'),'Augment','augments/custom-new.md',[])).toThrow('编号无效');
  expect(()=>knowledgeImportPath(content,'Champion','champions/ahri.md',['champions/ahri.md'])).toThrow('分类不一致');
 });
});

describe('knowledge UI diagnostics',()=>{
 it('explains common validation issues in Chinese without implying automatic verification',()=>{
  expect(knowledgeMessage('Required string: title')).toBe('请填写名称。');
  expect(knowledgeMessage('Duplicate title, ID or alias: augments/1001.md')).toContain('重复');
  expect(knowledgeMessage('Missing link: augments/gone.md')).toContain('augments/gone.md');
  expect(knowledgeMessage('Error: unknown-diagnostic')).toBe('unknown-diagnostic');
  expect(knowledgeStatusLabel('deprecated')).toBe('已过时');
 });
});
