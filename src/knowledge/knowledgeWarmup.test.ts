import {describe, expect, it, vi} from 'vitest';
import {KnowledgeWarmup, type KnowledgeWarmupResult} from './knowledgeWarmup';

async function flush() {for (let n=0;n<8;n++) await Promise.resolve();}
const ready = async (): Promise<KnowledgeWarmupResult> => ({status:'ready'});

describe('loading-time local knowledge warmup', () => {
  it('warms before a game ID or OCR candidates exist and binds the later ID without repeating', async () => {
    const prepare=vi.fn(ready), gate=new KnowledgeWarmup(prepare);
    gate.observe('ChampSelect');await flush();
    expect(prepare).toHaveBeenCalledExactlyOnceWith();
    gate.observe('GameStart','123');gate.observe('InProgress','123');await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it.each(['GameStart','Reconnect','InProgress'])('handles launching midway in %s', async phase => {
    const prepare=vi.fn(ready), gate=new KnowledgeWarmup(prepare);
    gate.observe(phase,'123');await flush();
    expect(prepare).toHaveBeenCalledExactlyOnceWith();
  });

  it('refreshes on the next exact match without depending on an intervening lobby event', async () => {
    const prepare=vi.fn(ready), gate=new KnowledgeWarmup(prepare);
    gate.observe('InProgress','123');await flush();
    gate.observe('InProgress','456');await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it.each(['EndOfGame','Lobby','Matchmaking','ReadyCheck'])('arms another loading cycle after %s', async phase => {
    const prepare=vi.fn(ready), gate=new KnowledgeWarmup(prepare);
    gate.observe('ChampSelect');await flush();gate.observe(phase);gate.observe('ChampSelect');await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('does not preheat for idle/unknown phases or retry because of temporary disconnection', async () => {
    const prepare=vi.fn(ready), gate=new KnowledgeWarmup(prepare);
    for(const phase of ['Lobby','Matchmaking','ReadyCheck','Unknown','Disconnected'])gate.observe(phase);
    await flush();expect(prepare).not.toHaveBeenCalled();
    gate.observe('ChampSelect');await flush();gate.observe('Disconnected');gate.observe('Unknown');gate.observe('InProgress','123');await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('does not wait or overlap requests, even if a new match arrives during preparation', async () => {
    let finish!: (value: KnowledgeWarmupResult) => void;
    const prepare=vi.fn(() => new Promise<KnowledgeWarmupResult>(resolve => {finish=resolve;}));
    const gate=new KnowledgeWarmup(prepare);
    expect(gate.observe('ChampSelect','123')).toBeUndefined();await flush();
    for(let i=0;i<10;i++)gate.observe('InProgress','123');
    gate.observe('InProgress','456');await flush();expect(prepare).toHaveBeenCalledTimes(1);
    finish({status:'ready'});await flush();gate.observe('InProgress','456');await flush();
    expect(prepare).toHaveBeenCalledTimes(2);finish({status:'ready'});await flush();
  });

  it.each(['failed','reject','throw'])('bounds failures for %s and still allows the next loading cycle', async outcome => {
    const prepare=vi.fn((): Promise<KnowledgeWarmupResult> => {
      if(outcome==='throw')throw Error('synthetic IPC failure');
      return outcome==='failed'?Promise.resolve({status:'failed'}):Promise.reject(Error('synthetic failure'));
    });
    const gate=new KnowledgeWarmup(prepare);
    for(let i=0;i<8;i++){gate.observe('ChampSelect');await flush();}
    expect(prepare).toHaveBeenCalledTimes(2);
    gate.observe('EndOfGame');gate.observe('ChampSelect');await flush();
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('does not exhaust retry readiness while another worker is legitimately busy',async()=>{
    const prepare=vi.fn<()=>Promise<KnowledgeWarmupResult>>().mockResolvedValue({status:'busy'}),gate=new KnowledgeWarmup(prepare);
    for(let i=0;i<4;i++){gate.observe('GameStart','123');await flush();}
    expect(prepare).toHaveBeenCalledTimes(4);
    prepare.mockResolvedValue({status:'ready'});gate.observe('InProgress','123');await flush();
    gate.observe('InProgress','123');await flush();expect(prepare).toHaveBeenCalledTimes(5);
  });

  it('retries once if startup preparation was busy, then remembers readiness', async () => {
    const prepare=vi.fn<() => Promise<KnowledgeWarmupResult>>().mockResolvedValueOnce({status:'busy'}).mockResolvedValue({status:'ready'});
    const gate=new KnowledgeWarmup(prepare);
    gate.observe('ChampSelect');await flush();gate.observe('GameStart','123');await flush();
    gate.observe('InProgress','123');await flush();expect(prepare).toHaveBeenCalledTimes(2);
  });
});
