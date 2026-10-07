import { describe, it, expect } from 'vitest';
import { blockers, fillPostGameAugments, matchingEndOfGame, mergeLive, mergeMatchResult, newSession, synchronizeSelections, type MatchResult, type Player } from './domain';
const raw = { activePlayer: {summonerName:'me'}, allPlayers:[{summonerName:'me',championName:'Ahri',team:'ORDER',items:[]},{summonerName:'enemy',championName:'Garen',team:'CHAOS',items:[]}] };
describe('API context boundaries',()=>{
  it('keeps only one confirmed choice per known round and ignores another match context',()=>{
    const s=mergeLive(newSession(),raw);
    const context={id:s.id,matchId:s.matchId,ownPlayerId:s.ownPlayerId,players:s.players,candidateBand:1,candidates:[{id:'1',name:'循环往复',description:'effect'},{id:'2',name:'不同选择',description:'effect'}]};
    const result={ranking:[],summary:'',missingInformation:[]};
    s.decisions=[{at:'first',chosenId:'1',context,result},{at:'second',chosenId:'2',context,result},{at:'other',chosenId:'2',context:{...context,id:'other-session',candidateBand:7},result}];
    const next=synchronizeSelections(s);
    expect(next.players[0].augments).toEqual(['循环往复']);
    expect(next.players[0].augmentSelections).toHaveLength(1);
    expect(next.players[0].augmentSelections?.[0].band).toBe(1);
  });
  it('carries confirmed choices from their original round and preserves partial status',()=>{
    const s=mergeLive(newSession(),raw);
    s.decisions=[{at:'first',chosenId:'1',context:{ownPlayerId:'me',players:s.players,candidates:[{id:'1',name:'循环往复',description:'effect'}]},result:{ranking:[],summary:'',missingInformation:[]}}];
    s.candidates=[{id:'1',name:'different round',description:'effect'}];
    const next=synchronizeSelections(s);
    expect(next.players[0].augments).toEqual(['循环往复']);
    expect(next.players[0].augmentsConfirmed).toBe(false);
    expect(next.players[0].augmentSelections?.[0].source).toBe('manual-choice');
    expect(synchronizeSelections(next)).toBe(next);
    expect(mergeLive(next,raw).players[0].augments).toEqual(['循环往复']);
    const changed=structuredClone(raw);changed.allPlayers[0].championName='Ashe';
    expect(mergeLive(next,changed).players[0].augments).toEqual([]);
  });
  it('uses API champion and marks augment information unknown',()=>{
    const s=mergeLive(newSession(),raw);
    expect(s.ownPlayerId).toBe('me'); expect(s.players[0].champion).toBe('Ahri');
    expect(s.players.every(p=>!p.augmentsConfirmed)).toBe(true);
    expect(blockers(s).length).toBeGreaterThan(0);
  });
  it('assigns stable unique slot identities when the API masks multiple players as #',()=>{
    const masked={activePlayer:{riotId:'me#100'},allPlayers:[
      {riotId:'me#100',championName:'Ahri',team:'ORDER',items:[]},
      {riotId:'#',summonerName:'#',championName:'Garen',team:'ORDER',items:[]},
      {riotId:'#',summonerName:'#',championName:'Ashe',team:'CHAOS',items:[]},
    ]};
    const first=mergeLive(newSession(),masked),second=mergeLive(first,masked);
    expect(first.players.map(p=>p.id)).toEqual(['me#100','masked:ORDER:1','masked:CHAOS:2']);
    expect(new Set(first.players.map(p=>p.id)).size).toBe(first.players.length);
    expect(first.players[1].name).toBe('匿名玩家 2');
    expect(second.players.map(p=>p.id)).toEqual(first.players.map(p=>p.id));
    expect(first.ownPlayerId).toBe('me#100');
  });
  it('preserves manual corrections after a confirmed choice has been propagated',()=>{
    const s=mergeLive(newSession(),raw);
    s.decisions=[{at:'first',chosenId:'1',context:{ownPlayerId:'me',players:s.players,candidates:[{id:'1',name:'循环往复',description:'effect'}]},result:{ranking:[],summary:'',missingInformation:[]}}];
    const propagated=synchronizeSelections(s);
    const corrected={...propagated,players:propagated.players.map(p=>p.id==='me'?{...p,augments:['手动纠正的效果']}:p)};
    expect(synchronizeSelections(corrected)).toBe(corrected);
    expect(mergeLive(corrected,raw).players[0].augments).toEqual(['手动纠正的效果']);
    expect(mergeLive(corrected,raw).players[0].augmentSelections).toHaveLength(1);
  });
  it('preserves explicit augment observations for the same player and champion',()=>{
    const s=mergeLive(newSession(),raw); s.players[0].augments=['test effect'];s.players[0].augmentsConfirmed=true;
    expect(mergeLive(s,raw).players[0].augments).toEqual(['test effect']);
    const changed=structuredClone(raw);changed.allPlayers[0].championName='Ashe';
    expect(mergeLive(s,changed).players[0].augmentsConfirmed).toBe(false);
  });
  it('requires teams and candidate effects but does not force per-player confirmation',()=>{
    const s=mergeLive(newSession(),raw);expect(s.players.every(p=>!p.augmentsConfirmed)).toBe(true);
    s.candidates.forEach(c=>{c.name='name';c.description='effect';});expect(blockers(s)).toEqual([]);
    s.players[1].team='UNKNOWN';expect(blockers(s)).not.toEqual([]);
  });
  it('refuses to carry observations across a game-time reset',()=>{
    const s=mergeLive(newSession(),{...raw,gameData:{gameTime:900}});
    expect(()=>mergeLive(s,{...raw,gameData:{gameTime:20}})).toThrow('新对局');
  });
  it('rejects empty or malformed snapshots',()=>{
    expect(()=>mergeLive(newSession(),{})).toThrow();
    expect(()=>mergeLive(newSession(),{allPlayers:[]})).toThrow();
  });
});

describe('postgame evidence ownership',()=>{
  const player=(id:string,team:string,champion='Ahri'):Player=>({id,name:id,champion,team,items:[],augments:[],augmentsConfirmed:false});
  const session=(players:Player[])=>({...newSession(),ownPlayerId:players[0].id,players});
  it('rejects weak-name ambiguity even when the first player shares the enemy champion',()=>{
    const s=session([player('Same#A','ORDER'),player('Same#B','CHAOS')]);
    const next=fillPostGameAugments(s,[{key:'same',champion:'Ahri',team:'CHAOS',augments:['enemy-only']}]);
    expect(next).toBe(s);
    expect(s.players.every(p=>!p.augmentsConfirmed&&!p.augments.length)).toBe(true);
  });
  it('uses full Riot IDs before a short name and keeps opposing players separate',()=>{
    const s=session([player('Same#A','ORDER'),player('Same#B','CHAOS')]);
    const next=fillPostGameAugments(s,[
      {key:'same',champion:'Ahri',augments:['ambiguous']},
      {key:'SAME#B',champion:'Ahri',team:'CHAOS',augments:['enemy-only']},
      {key:'same#a',champion:'Ahri',team:'ORDER',augments:['own-only']},
    ]);
    expect(next.players.map(p=>p.augments)).toEqual([['own-only'],['enemy-only']]);
    expect(next.players.every(p=>p.augmentsConfirmed)).toBe(true);
    expect(s.players.every(p=>!p.augments.length)).toBe(true);
  });
  it('rejects contradictory teams for full and weak identities without fallback',()=>{
    const s=session([player('Me#A','ORDER'),player('masked:CHAOS:1','CHAOS')]);
    for(const key of ['me#a','me'])expect(fillPostGameAugments(s,[{key,champion:'Ahri',team:'CHAOS',augments:['wrong']}])).toBe(s);
  });
  it('accepts a unique short name and preserves existing observations',()=>{
    const s=session([player('Me#A','ORDER'),player('Other#B','CHAOS','Garen')]);
    s.players[0].augments=['manual'];
    const next=fillPostGameAugments(s,[{key:'me',champion:'Ahri',team:'ORDER',augments:['observed']}]);
    expect(next.players[0].augments).toEqual(['manual','observed']);
    expect(next.players[0].augmentsConfirmed).toBe(true);
    expect(s.players[0].augments).toEqual(['manual']);
  });
  it('keeps masked champion/team fallback but rejects duplicate evidence and contradictory full IDs',()=>{
    const s=session([player('masked:ORDER:0','ORDER'),player('Enemy#B','CHAOS')]);
    const entry={key:'path:/teams[0]/players[0]',champion:'Ahri',team:'ORDER',augments:['own-only']};
    expect(fillPostGameAugments(s,[entry]).players[0].augments).toEqual(['own-only']);
    expect(fillPostGameAugments(s,[entry,{...entry,key:'path:/duplicate'}])).toBe(s);
    expect(fillPostGameAugments(s,[{...entry,key:'SomeoneElse#C',team:'CHAOS'}])).toBe(s);
  });
});

describe('shared match evidence guards',()=>{
  it('accepts a positive exact top-level/nested match identity, including consistent mixed types',()=>{
    for(const value of [{gameId:100},{gameId:'100'},{gameData:{gameId:100}},{gameId:'100',gameData:{gameId:100}}]) {
      expect(matchingEndOfGame('100',value)).toBe(true);
    }
  });
  it('rejects raw evidence with conflicting, missing, invalid or unsafe identities',()=>{
    for(const value of [null,[],{}, {id:100},{gameId:101},{gameId:101,gameData:{gameId:100}},
      {gameId:100,gameData:{gameId:101}},{gameId:null,gameData:{gameId:100}},
      {gameId:100,gameData:{gameId:0}},{gameId:0},{gameId:-1},{gameId:100.5},
      {gameId:'100x'},{gameId:Number.MAX_SAFE_INTEGER+1}]) {
      expect(matchingEndOfGame('100',value)).toBe(false);
    }
    expect(matchingEndOfGame('',{gameId:100})).toBe(false);
    expect(matchingEndOfGame('0',{gameId:0})).toBe(false);
  });
  it('keeps every existing automatic result through late automatic, manual and unknown contradictions',()=>{
    for(const source of ['live-game-end','lcu-eog','lcu-history'] as const){
      const current:MatchResult={status:'win',source,gameId:'100',observedAt:'first'};
      for(const incoming of [
        {status:'loss',source:'lcu-history',gameId:'100',observedAt:'later'},
        {status:'loss',source:'manual',gameId:'100',observedAt:'later'},
        {status:'unknown',source:'unknown',observedAt:'later'},
        {status:'win',source:'lcu-eog',gameId:'100',observedAt:'later'},
      ] as MatchResult[])expect(mergeMatchResult(current,incoming,'100')).toBe(current);
    }
  });
  it('upgrades unknown/manual results only from explicit matching official evidence',()=>{
    for(const current of [undefined,{status:'unknown',source:'unknown',observedAt:'first'},{status:'loss',source:'manual',gameId:'100',observedAt:'first'}] as (MatchResult|undefined)[]){
      for(const source of ['lcu-eog','lcu-history','live-game-end'] as const){
        const incoming:MatchResult={status:'win',source,gameId:'100',observedAt:'later'};
        expect(mergeMatchResult(current,incoming,'100')).toBe(incoming);
        expect(mergeMatchResult(current,{...incoming,gameId:'101'},'100')).toBe(current);
        expect(mergeMatchResult(current,{...incoming,gameId:undefined},'100')).toBe(current);
        expect(mergeMatchResult(current,{...incoming,observedAt:''},'100')).toBe(current);
      }
      expect(mergeMatchResult(current,{status:'win',source:'manual',gameId:'100',observedAt:'later'},'100')).toBe(current);
    }
  });
  it('retains ID-less live-only GameEnd support without guessing an identified archive',()=>{
    const incoming:MatchResult={status:'win',source:'live-game-end',observedAt:'now'};
    expect(mergeMatchResult(undefined,incoming,'')).toBe(incoming);
    expect(mergeMatchResult(undefined,incoming,'100')).toBeUndefined();
    expect(mergeMatchResult(undefined,{...incoming,gameId:'100'},'')).toBeUndefined();
    expect(mergeMatchResult(undefined,{...incoming,source:'lcu-eog'},'')).toBeUndefined();
    expect(mergeMatchResult(undefined,{...incoming,gameId:0 as unknown as string},'100')).toBeUndefined();
  });
});
