// One in-flight write; only the latest not-yet-started snapshot per session is kept.
export class SaveQueue<T extends {id:string}>{
 private pending=new Map<string,{value:T;waiters:{resolve:()=>void;reject:(e:unknown)=>void}[]}>();
 private running=false;private idleWaiters:(()=>void)[]=[];
 constructor(private write:(value:T)=>Promise<unknown>,private timeoutMs=15000){}
 enqueue(value:T):Promise<void>{return new Promise((resolve,reject)=>{const old=this.pending.get(value.id);this.pending.set(value.id,{value,waiters:[...(old?.waiters||[]),{resolve,reject}]});void this.drain();});}
 idle():Promise<void>{return this.running||this.pending.size?new Promise(resolve=>this.idleWaiters.push(resolve)):Promise.resolve();}
 // 卡住的写不能让队列永久停住：超时后把失败交给调用方，继续下一条。
 private async writeWithTimeout(value:T):Promise<unknown>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   return await Promise.race([
    this.write(value),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('保存超时，已跳过这条快照')),this.timeoutMs);}),
   ]);
  }finally{if(timer!==undefined)clearTimeout(timer);}
 }
 private async drain(){if(this.running)return;this.running=true;try{while(this.pending.size){const [key,item]=this.pending.entries().next().value!;this.pending.delete(key);try{await this.writeWithTimeout(item.value);item.waiters.forEach(w=>w.resolve());}catch(e){item.waiters.forEach(w=>w.reject(e));}}}finally{this.running=false;this.idleWaiters.splice(0).forEach(resolve=>resolve());}}
}
