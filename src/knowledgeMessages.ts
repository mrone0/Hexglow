export function knowledgeStatusLabel(status:string):string {
 return ({draft:'待核实',stable:'已整理',deprecated:'已过时'} as Record<string,string>)[status]||'状态待确认';
}

/** Translate common validation failures without hiding unfamiliar diagnostic evidence. */
export function knowledgeMessage(message:string):string {
 const text=message.replace(/^Error:\s*/, '');
 const labels:Record<string,string>={title:'名称',description:'一句话说明',status:'资料状态'};
 const required=text.match(/^Required string: (.+)$/);
 if(required)return `请填写${labels[required[1]]||required[1]}。`;
 const known:Record<string,string>={
  'Unsupported status':'请选择有效的资料状态。',
  'tags must be a string list':'标签请每行填写一项，不要填写空白项。',
  'hexglow.aliases must be a string list':'别名请每行填写一项，不要填写空白项。',
  'hexglow.patch must be a nonempty string':'请填写适用版本；不确定时可填 unknown。',
  'File exceeds 256 KiB':'资料内容不能超过 256 KiB，请精简后保存。',
  'Patch applicability is not independently verified':'适用版本由资料维护者填写，程序不会自动核实。',
  'Draft: content is not verified':'当前资料标记为待核实，模型会保留这一不确定性。',
  'Local links are checked against the knowledge tree on save/retrieval':'关联资料会在保存或分析时检查是否存在。',
  'type must match kind (Champion/Augment)':'导入资料的分类与当前对象不一致，请选择对应的英雄或海克斯。',
  'Identity must exactly match the filename stem':'资料编号与当前对象不一致，请勿更改编号；导入时请选择对应资料。',
  'Existing type is immutable':'不能把已有英雄资料改成海克斯资料，或反向修改。',
  'Knowledge exceeds 2000-document limit':'知识库已达到 2000 份资料上限，暂时不能新增。',
  'Unregistered knowledge document':'这份资料已不存在或无法读取，请重新选择。',
 };
 if(known[text])return known[text];
 if(text.startsWith('Duplicate title, ID or alias:'))return '名称或别名与已有资料重复，请使用不同名称或删除重复别名。';
 if(text.startsWith('Existing identity is immutable:'))return '已有资料的内部编号不能修改。请保留原编号后再保存。';
 if(text.startsWith('Missing required heading:'))return `缺少“${text.slice('Missing required heading:'.length).trim()}”内容栏目，请在高级编辑中恢复标题。`;
 if(text.startsWith('Missing link:'))return `关联资料不存在：${text.slice('Missing link:'.length).trim()}。已保留链接，请检查关联对象。`;
 return text;
}
