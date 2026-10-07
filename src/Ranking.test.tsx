import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {EngineBadge,RankingItemView} from './Ranking';
import type {RankingItem} from './domain';

const item:RankingItem={candidateId:'a',score:74,modelScore:80,localScore:null,modelWeight:0.8,confidence:0.8,reason:'模型理由',risks:[]};
const render=(value:RankingItem,scoringMode?:string)=>renderToStaticMarkup(<RankingItemView item={value} index={0} candidates={[{id:'a',name:'当前候选'}]} scoringMode={scoringMode}/>);

describe('model scoring provenance',()=>{
  it('does not present model-only results as local-rule blending',()=>{
    const html=render(item,'dynamic-model-v1');
    expect(html).toContain('模型 80.0');
    expect(html).not.toContain('本地规则');
    expect(html).not.toContain('模型占比');
    expect(render({...item,localScore:99},'dynamic-model-v1')).not.toContain('本地规则');
  });
  it('labels retained legacy blending as historical instead of new dynamic comparison',()=>{
    const html=render({...item,localScore:60});
    expect(html).toContain('历史本地规则 60');
    expect(html).toContain('历史模型占比 80%');
  });
  it('does not display an owned candidate as the first recommendation or a normal score',()=>{
    const html=render({...item,score:0,alreadyOwned:true},'dynamic-model-v1');
    expect(html).toContain('已拥有');expect(html).toContain('不作为新选择');
    expect(html).not.toContain('class="rank">01');expect(html).not.toContain('<b>0</b>');
  });
  it('identifies dynamic model mode without presenting confidence as calibrated probability',()=>{
    const html=renderToStaticMarkup(<EngineBadge engine={{provider:'test',model:'mock',latencyMs:1,confidenceKind:'self_reported',scoringMode:'dynamic-model-v1'}}/>);
    expect(html).toContain('动态模型比较');expect(html).toContain('模型自报置信度，未校准');
  });
});
