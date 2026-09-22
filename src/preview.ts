import {newSession,type Session} from './domain';
export function previewSession():Session{
 const s=newSession();s.id='preview-only';s.matchId='UI-DEMO';s.phase='InProgress';s.ownPlayerId='demo-0';s.notes='纯 UI 预览：人物与海克斯效果是演示占位，不是真实游戏采集，也不是模型结论。';
 const names=['Ahri','Garen','Ashe','Lux','Braum','Jinx','Leona','Veigar','Darius','Nami'];
 s.players=names.map((champion,i)=>({id:`demo-${i}`,name:`演示玩家 ${i+1}`,champion,team:i<5?'ORDER':'CHAOS',items:[],augments:i===0?['演示已有海克斯：仅展示布局']:[],augmentsConfirmed:true}));
 s.candidates=[{id:'demo-a',name:'潮汐回响 · 演示',description:'占位效果：用于展示持续输出类型，不代表游戏内真实海克斯。'},{id:'demo-b',name:'星芒涌动 · 演示',description:'占位效果：用于展示爆发类型，不代表游戏内真实海克斯。'},{id:'demo-c',name:'萤光护佑 · 演示',description:'占位效果：用于展示生存类型，不代表游戏内真实海克斯。'}];
 const context={...s};s.decisions=[{at:new Date().toISOString(),context,result:{summary:'这是静态演示推荐，用于检查排名、风险和选择记录的布局。不会调用模型，不进入历史数据库。',ranking:s.candidates.map((c,i)=>({candidateId:c.id,score:85-i*13,reason:'示例说明：这里展示结构化判断维度与文档依据，不是真实建议。',risks:['演示数据，不用于游戏决策']})),missingInformation:['当前为 UI 预览，真实游戏 API 和模型均未参与。']}}];return s;
}
