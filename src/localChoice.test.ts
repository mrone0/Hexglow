import {describe,expect,it} from 'vitest';
import {newSession,synchronizeSelections,type Session} from './domain';
import {confirmLocalChoice,isCurrentChoiceDecision,localChoiceState} from './localChoice';

function playing(){return {...newSession(),phase:'InProgress',candidateBand:1,ownPlayerId:'me',players:[{id:'me',name:'me',champion:'Ahri',team:'ORDER',items:[],augments:[],augmentsConfirmed:false}],candidates:[{id:'1001',name:'泰坦的坚决',description:'effect'},{id:'1018',name:'巨像的勇气',description:'effect'}],liveData:{activePlayer:{level:3}}};}
function analysis(context:Session,chosenId?:string):Session['decisions'][number]{return {at:'2026-10-06T08:00:00.000Z',context:structuredClone(context),chosenId,result:{ranking:context.candidates.map(candidate=>({candidateId:candidate.id,score:50,reason:'分析',risks:[]})),summary:'分析总结',missingInformation:[]}};}
describe('recording local selections without model analysis',()=>{
  it('records and locks each round without claiming all owned choices are known',()=>{
    const session=confirmLocalChoice(playing(),'1001');
    expect(session.decisions).toEqual([]);
    expect(session.players[0].augments).toEqual(['泰坦的坚决']);
    expect(session.players[0].augmentsConfirmed).toBe(false);
    expect(confirmLocalChoice(session,'1018')).toBe(session);
    const next={...session,candidateBand:7,liveData:{activePlayer:{level:7}}};
    expect(confirmLocalChoice(next,'1018').players[0].augments).toEqual(['泰坦的坚决','巨像的勇气']);
  });
  it('rejects stale, unknown and ended choices',()=>{
    const session=playing();
    expect(confirmLocalChoice(session,'unknown')).toBe(session);
    const next={...session,liveData:{activePlayer:{level:7}}};
    expect(confirmLocalChoice(next,'1001')).toBe(next);
    const ended={...session,phase:'EndOfGame'};
    expect(confirmLocalChoice(ended,'1001')).toBe(ended);
    const archived={...session,archived:true};
    expect(confirmLocalChoice(archived,'1001')).toBe(archived);
    const unknownLevel={...session,liveData:null};
    expect(confirmLocalChoice(unknownLevel,'1001')).toBe(unknownLevel);
    const unknownBand={...session,candidateBand:undefined};
    expect(confirmLocalChoice(unknownBand,'1001')).toBe(unknownBand);
  });

  it('records one choice shared with the current model snapshot and rejects another candidate',()=>{
    const session=playing();
    session.decisions=[analysis(session)];
    const chosen=confirmLocalChoice(session,'1001','2026-10-06T08:01:00.000Z');
    expect(chosen.decisions[0].chosenId).toBe('1001');
    expect(chosen.players[0].augmentSelections).toHaveLength(1);
    expect(synchronizeSelections(chosen).players[0].augmentSelections).toHaveLength(1);
    expect(confirmLocalChoice(chosen,'1018')).toBe(chosen);
    expect(chosen.decisions[0].chosenId).toBe('1001');
  });

  it('an existing model confirmation locks the entire band even after candidates change',()=>{
    const session=playing();
    session.decisions=[analysis(session,'1001')];
    session.candidates=[{id:'1170',name:'万用瞄准镜',description:'新的候选'}];
    const rejected=confirmLocalChoice(session,'1170');
    expect(rejected.players[0].augments).toEqual(['泰坦的坚决']);
    expect(rejected.players[0].augmentSelections).toHaveLength(1);
    expect(localChoiceState(rejected).choice?.id).toBe('1001');
    expect(rejected.decisions[0].chosenId).toBe('1001');
  });

  it('keeps historical, another-game and changed-candidate model snapshots read-only',()=>{
    const session=playing();
    for(const context of [
      {...session,candidateBand:7},
      {...session,id:'another-game'},
      {...session,candidates:session.candidates.map(candidate=>({...candidate,description:'old effect'}))},
    ]){
      const current={...session,decisions:[analysis(context)]};
      const chosen=confirmLocalChoice(current,'1001');
      expect(chosen.players[0].augmentSelections).toHaveLength(1);
      expect(chosen.decisions[0].chosenId).toBeUndefined();
    }
    expect(isCurrentChoiceDecision(session,analysis({...session,id:'another-game'}))).toBe(false);
    expect(isCurrentChoiceDecision(session,analysis({...session,candidateBand:undefined}))).toBe(false);
  });

  it('does not assign legacy decisions to an invented band or confirm overlapping candidates twice',()=>{
    const session=playing();
    const legacy={...session,candidateBand:undefined};
    session.decisions=[analysis(legacy,'1001')];
    const rejected=confirmLocalChoice(session,'1018');
    expect(rejected.players[0].augmentSelections).toEqual([expect.objectContaining({id:'1001',band:undefined})]);
    expect(localChoiceState(rejected).legacyChoice?.id).toBe('1001');
    expect(localChoiceState(rejected).choice).toBeUndefined();
    expect(localChoiceState(rejected).available).toBe(false);
    const next={...rejected,candidateBand:7,liveData:{activePlayer:{level:7}},candidates:[{id:'1170',name:'万用瞄准镜',description:'new effect'}]};
    expect(confirmLocalChoice(next,'1170').players[0].augmentSelections).toHaveLength(2);
  });
});
