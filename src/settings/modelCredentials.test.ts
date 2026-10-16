import {describe,expect,it,vi} from 'vitest';
import {ModelCredentials} from './modelCredentials';

const A='openai:https://a.invalid/v1',B='jev:https://b.invalid/v1';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function tick(){for(let n=0;n<12;n++)await Promise.resolve();}
function harness(){
 const persisted=new Map<string,string>();
 const io={load:vi.fn(async(destination:string)=>persisted.get(destination)||null),save:vi.fn(async(destination:string,value:string)=>{if(value.trim())persisted.set(destination,value);else persisted.delete(destination);})};
 const values:string[]=[],statuses:string[]=[];
 const controller=new ModelCredentials(io,value=>values.push(value),status=>statuses.push(status));
 return {controller,io,persisted,values,statuses};
}

describe('model credential persistence and service switching',()=>{
 it('restores a saved key in a fresh controller without writing during restoration',async()=>{
  const h=harness();h.controller.select(A);await h.controller.flush();
  h.controller.change('synthetic-only-key');await h.controller.flush();
  const restored:string[]=[];const second=new ModelCredentials(h.io,value=>restored.push(value),()=>{});
  second.select(A);expect(second.isLoading()).toBe(true);await second.flush();
  expect(restored).toEqual(['','synthetic-only-key']);expect(second.isLoading()).toBe(false);
  expect(h.io.save).toHaveBeenCalledTimes(1);
 });

 it('cannot overwrite newly typed input with a delayed restore',async()=>{
  const h=harness(),load=deferred<string|null>();h.io.load.mockImplementationOnce(()=>load.promise);
  h.controller.select(A);await tick();h.controller.change('synthetic-new-key');
  load.resolve('synthetic-old-key');await h.controller.flush();
  expect(h.values).not.toContain('synthetic-old-key');expect(h.persisted.get(A)).toBe('synthetic-new-key');
 });

 it('writes input in order and flush waits for the latest write',async()=>{
  const h=harness(),write=deferred<void>();h.controller.select(A);await h.controller.flush();
  h.io.save.mockImplementationOnce(async(destination,value)=>{await write.promise;h.persisted.set(destination,value);});
  h.controller.change('synthetic-first');await tick();h.controller.change('synthetic-last');
  let done=false;const finish=h.controller.flush().then(()=>{done=true;});await tick();
  expect(done).toBe(false);expect(h.io.save).toHaveBeenCalledTimes(1);
  write.resolve();await finish;expect(h.persisted.get(A)).toBe('synthetic-last');
 });

 it('switches services without deleting the old key or applying an old load',async()=>{
  const h=harness(),load=deferred<string|null>();h.persisted.set(B,'synthetic-B');
  h.io.load.mockImplementationOnce(()=>load.promise);
  h.controller.select(A);await tick();h.controller.change('synthetic-A');h.controller.select(B);
  load.resolve('synthetic-stale-A');await h.controller.flush();
  expect(h.values).not.toContain('synthetic-stale-A');expect(h.values.at(-1)).toBe('synthetic-B');
  expect(h.persisted.get(A)).toBe('synthetic-A');expect(h.io.save).toHaveBeenCalledWith(A,'synthetic-A');
  h.controller.select(A);await h.controller.flush();expect(h.values.at(-1)).toBe('synthetic-A');
 });

 it('clearing deletes only the selected service',async()=>{
  const h=harness();h.persisted.set(A,'synthetic-A');h.persisted.set(B,'synthetic-B');
  h.controller.select(A);await h.controller.flush();h.controller.change('');await h.controller.flush();
  expect(h.persisted.has(A)).toBe(false);expect(h.persisted.get(B)).toBe('synthetic-B');
 });

 it('does not silently exit or update after a failed save, and supports retry',async()=>{
  const h=harness();h.controller.select(A);await h.controller.flush();
  h.io.save.mockRejectedValueOnce(new Error('native failure synthetic-private-key'));
  h.controller.change('synthetic-private-key');await expect(h.controller.flush()).rejects.toThrow('密钥尚未保存成功');
  expect(h.statuses.join(' ')).not.toContain('synthetic-private-key');
  h.controller.change('synthetic-private-key');await h.controller.flush();
  expect(h.persisted.get(A)).toBe('synthetic-private-key');
 });

 it('reports a load failure without blocking exit when no key was edited',async()=>{
  const h=harness();h.io.load.mockRejectedValueOnce(new Error('secret native error'));
  h.controller.select(A);await h.controller.flush();expect(h.statuses.at(-1)).toContain('读取失败');
  expect(h.statuses.join(' ')).not.toContain('secret');expect(h.controller.isLoading()).toBe(false);
 });

 it('never persists to an invalid destination',async()=>{
  const h=harness();h.controller.select('');h.controller.change('synthetic-key');
  await expect(h.controller.flush()).rejects.toThrow();expect(h.io.load).not.toHaveBeenCalled();expect(h.io.save).not.toHaveBeenCalled();
 });
});
