import {expect,it} from 'vitest';
import {SaveQueue} from './saveQueue';
it('coalesces queued same-session snapshots without losing other sessions',async()=>{let release!:()=>void;const seen:number[]=[];const queue=new SaveQueue<{id:string;n:number}>(async value=>{seen.push(value.n);if(value.n===1)await new Promise<void>(r=>release=r);});const a=queue.enqueue({id:'a',n:1});const b=queue.enqueue({id:'a',n:2});const c=queue.enqueue({id:'a',n:3});const d=queue.enqueue({id:'b',n:4});release();await Promise.all([a,b,c,d,queue.idle()]);expect(seen).toEqual([1,3,4]);});
it('failed writes reject their callers without stalling subsequent snapshots',async()=>{const q=new SaveQueue<{id:string}>(async v=>{if(v.id==='bad')throw new Error('disk full');});await expect(q.enqueue({id:'bad'})).rejects.toThrow('disk full');await expect(q.enqueue({id:'good'})).resolves.toBeUndefined();await q.idle();});
it('reports a timeout but waits for the real write before advancing or becoming idle',async()=>{
 let release!:()=>void;let persisted=0;const seen:number[]=[];
 const q=new SaveQueue<{id:string;n:number}>(async v=>{if(v.n===1)await new Promise<void>(r=>release=r);persisted=v.n;seen.push(v.n);},10);
 await expect(q.enqueue({id:'same',n:1})).rejects.toThrow('保存超时');
 const next=q.enqueue({id:'same',n:2});let idle=false;const waiting=q.idle().then(()=>{idle=true;});
 expect(seen).toEqual([]);expect(idle).toBe(false);
 release();await Promise.all([next,waiting]);expect(seen).toEqual([1,2]);expect(persisted).toBe(2);
});
