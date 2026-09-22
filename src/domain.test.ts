import { describe, it, expect } from 'vitest';
import { blockers, mergeLive, newSession } from './domain';
const raw = { activePlayer: {summonerName:'me'}, allPlayers:[{summonerName:'me',championName:'Ahri',team:'ORDER',items:[]},{summonerName:'enemy',championName:'Garen',team:'CHAOS',items:[]}] };
describe('API context boundaries',()=>{
  it('uses API champion and marks augment information unknown',()=>{
    const s=mergeLive(newSession(),raw);
    expect(s.ownPlayerId).toBe('me'); expect(s.players[0].champion).toBe('Ahri');
    expect(s.players.every(p=>!p.augmentsConfirmed)).toBe(true);
    expect(blockers(s).length).toBeGreaterThan(0);
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
