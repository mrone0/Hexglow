import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {KnowledgePanel} from './KnowledgePanel';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>false}));

describe('knowledge page version guidance',()=>{
  it('refers to the actual document version instead of hardcoding one patch for the whole library',()=>{
    const html=renderToStaticMarkup(<KnowledgePanel onChanged={()=>{}}/>);
    expect(html).toContain('适用版本以各文档标注为准');
    expect(html).toContain('可在下方列表中查看');
    expect(html).not.toMatch(/Patch\s+\d+\.\d+/);
    expect(html).toContain('内置资料为待核实草稿');
  });
});
