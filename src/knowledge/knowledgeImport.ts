import {parseDocument} from 'yaml';
import type {KnowledgeKind} from './knowledgeForm';

/** A new import chooses its own safe identity; it must never overwrite another document silently. */
export function knowledgeImportPath(content:string,kind:KnowledgeKind,path:string,existingPaths:string[]):string {
 const frontmatter=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
 if(!frontmatter)throw new Error('导入文件缺少资料信息，原有编辑内容未改动。');
 const doc=parseDocument(frontmatter[1],{uniqueKeys:true});
 if(doc.errors.length)throw new Error('导入文件的资料信息格式有误，原有编辑内容未改动。');
 const id=doc.getIn(['hexglow',kind==='Champion'?'champion_id':'augment_id']);
 if(doc.get('type')!==kind)throw new Error('导入资料分类不一致，请先选择对应的英雄或海克斯分类。');
 if(typeof id!=='string'||!/^[a-z0-9-]+$/i.test(id))throw new Error('导入资料的内部编号无效，未导入或覆盖任何资料。');
 const importedPath=`${kind==='Champion'?'champions':'augments'}/${id.toLowerCase()}.md`;
 if(existingPaths.includes(path)){
  if(importedPath!==path)throw new Error('导入文件不属于当前对象，请先选择对应的资料。');
  return path;
 }
 if(kind!=='Augment')throw new Error('请先选择已有英雄，不能通过导入新增英雄。');
 if(existingPaths.includes(importedPath))throw new Error('这份海克斯资料已存在，请先在列表中选择它，再导入修改。');
 return importedPath;
}
