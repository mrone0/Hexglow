import {useId} from 'react';
import {Select} from './Select';
import type {KnowledgeFields,KnowledgeKind} from './knowledgeForm';

const sections:Record<KnowledgeKind,{name:string;hint:string;placeholder:string}[]>={
 Champion:[
  {name:'基础机制',hint:'写清技能与被动怎样生效，哪些条件会改变效果。',placeholder:'描述已知的技能、被动、触发条件与重要数值；不确定的内容请注明待核实。'},
  {name:'常见打法',hint:'说明常见玩法、装备方向，以及适用的对局情况。',placeholder:'可以按不同玩法分段填写，说明各自依赖的条件与取舍。'},
  {name:'海克斯搭配',hint:'写出相关海克斯名称、适配原因、成立条件和不适用情况。',placeholder:'例如：搭配某海克斯时，在什么条件下有效；与哪些装备或已选海克斯有关。'},
  {name:'注意事项',hint:'补充容易误解的机制、限制、例外和资料来源。',placeholder:'写明不确定或尚未验证的结论，避免把推测当作确定机制。'},
 ],
 Augment:[
  {name:'完整效果',hint:'说明海克斯做什么，保留关键数值、持续时间与冷却信息。',placeholder:'用完整句子填写效果与数值；缺失的信息可以注明待核实。'},
  {name:'触发条件',hint:'说明什么时候生效，需要哪些行为或前置条件。',placeholder:'例如：由什么技能或行为触发，是否要求特定状态、装备或目标。'},
  {name:'限制与例外',hint:'补充不能触发的情况、叠加限制、上限和特殊例外。',placeholder:'没有可靠资料时请填写待核实，不要把未知写成没有限制。'},
  {name:'相关交互',hint:'写出相关英雄、装备或其他海克斯名称，并说明搭配条件。',placeholder:'说明为什么适配或不适配，以及组合成立所需要的条件；不必填写文件链接。'},
 ],
};

function LineListField({id,label,value,disabled,onChange}:{id:string;label:string;value:string[];disabled:boolean;onChange:(value:string[])=>void}){
 function commit(text:string){
  const normalized=[...new Set(text.split(/\r?\n/).map(item=>item.trim()).filter(Boolean))];
  if(JSON.stringify(normalized)!==JSON.stringify(value))onChange(normalized);
 }
 return <div className="knowledge-form-field">
  <label htmlFor={id}>{label}</label>
  <p id={`${id}-hint`} className="knowledge-form-help">每行填写一个，可留空。</p>
  <textarea id={id} aria-describedby={`${id}-hint`} rows={3} value={value.join('\n')} disabled={disabled} onChange={e=>onChange(e.target.value.split(/\r?\n/))} onBlur={e=>commit(e.currentTarget.value)}/>
 </div>;
}

export function KnowledgeFormEditor({kind,fields,disabled,onChange}:{kind:KnowledgeKind;fields:KnowledgeFields;disabled:boolean;onChange:(fields:KnowledgeFields)=>void}){
 const uid=useId();
 const titleLabel=kind==='Champion'?'英雄名称':'海克斯名称';
 const patch=(changes:Partial<KnowledgeFields>)=>onChange({...fields,...changes});
 const knownStatus=['draft','stable','deprecated'].includes(fields.status);
 return <fieldset className="knowledge-form" disabled={disabled}>
  <legend className="knowledge-form-legend">编辑{kind==='Champion'?'英雄':'海克斯'}资料</legend>
  <p className="knowledge-form-intro">像填写资料卡一样编辑即可。直接输入中文，格式与章节由程序维护。</p>
  <div className="knowledge-form-field">
   <label htmlFor={`${uid}-title`}>{titleLabel}</label>
   <input id={`${uid}-title`} value={fields.title} disabled={disabled} onChange={e=>patch({title:e.target.value})}/>
  </div>
  <div className="knowledge-form-field">
   <label htmlFor={`${uid}-description`}>一句话说明</label>
   <textarea id={`${uid}-description`} rows={2} value={fields.description} disabled={disabled} placeholder="用一两句话概括这份资料。" onChange={e=>patch({description:e.target.value})}/>
  </div>
  <div className="knowledge-form-sections">
   {sections[kind].map(({name,hint,placeholder},index)=><div className="knowledge-form-section" key={name}>
    <label htmlFor={`${uid}-section-${index}`}><span aria-hidden="true">{String(index+1).padStart(2,'0')}</span>{name}</label>
    <p className="knowledge-form-help" id={`${uid}-section-${index}-hint`}>{hint}</p>
    <textarea id={`${uid}-section-${index}`} aria-describedby={`${uid}-section-${index}-hint`} rows={Math.min(12,Math.max(4,(fields.sections[name]||'').split('\n').length+1))} value={fields.sections[name]||''} disabled={disabled} placeholder={placeholder} onChange={e=>patch({sections:{...fields.sections,[name]:e.target.value}})}/>
   </div>)}
  </div>
  <details className="knowledge-form-details">
   <summary>辅助信息 <span>适用版本、资料状态、别名与标签</span></summary>
   <div className="knowledge-form-metadata">
    <div className="knowledge-form-field">
     <label htmlFor={`${uid}-patch`}>适用版本</label>
     <p className="knowledge-form-help" id={`${uid}-patch-hint`}>按资料实际适用版本填写，不确定时保持未知。</p>
     <input id={`${uid}-patch`} aria-describedby={`${uid}-patch-hint`} value={fields.patch==='unknown'?'':fields.patch} disabled={disabled} placeholder="未知" onChange={e=>patch({patch:e.target.value||'unknown'})}/>
    </div>
    <div className="knowledge-form-field">
     <label htmlFor={`${uid}-status`}>资料状态</label>
     <p className="knowledge-form-help">“已整理”不代表内容已自动核验。状态仅作资料标记，不会自动排除检索。</p>
     <Select id={`${uid}-status`} aria-label="资料状态" value={fields.status} disabled={disabled} onChange={e=>patch({status:e.target.value})}>
      <option value="draft">待核实</option><option value="stable">已整理</option><option value="deprecated">已过时</option>
      {!knownStatus&&<option value={fields.status}>其他状态（保留原值）</option>}
     </Select>
    </div>
    <LineListField id={`${uid}-aliases`} label="别名" value={fields.aliases} disabled={disabled} onChange={aliases=>patch({aliases})}/>
    <LineListField id={`${uid}-tags`} label="标签" value={fields.tags} disabled={disabled} onChange={tags=>patch({tags})}/>
   </div>
  </details>
 </fieldset>;
}
