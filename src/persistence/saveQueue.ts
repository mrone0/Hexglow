// One in-flight write; only the latest not-yet-started snapshot per session is kept.
export class SaveQueue<T extends {id:string}>{
 private pending=new Map<string,{value:T;waiters:{resolve:()=>void;reject:(e:unknown)=>void}[]}>();
 private running=false;private idleWaiters:(()=>void)[]=[];
 constructor(private write:(value:T)=>Promise<unknown>,private timeoutMs=15000){}
 enqueue(value:T):Promise<void>{return new Promise((resolve,reject)=>{const old=this.pending.get(value.id);this.pending.set(value.id,{value,waiters:[...(old?.waiters||[]),{resolve,reject}]});void this.drain();});}
 idle():Promise<void>{return this.running||this.pending.size?new Promise(resolve=>this.idleWaiters.push(resolve)):Promise.resolve();}
 // IPC 超时不会取消后台写入。通知调用方后仍等待它结束，防止旧快照晚到覆盖新快照。
 private async drain(){
  if(this.running)return;
  this.running=true;
  try{
   while(this.pending.size){
    const [key,item]=this.pending.entries().next().value!;
    this.pending.delete(key);
    const timer=setTimeout(()=>item.waiters.forEach(w=>w.reject(new Error('保存超时，正在等待后台写入结束'))),this.timeoutMs);
    try{await this.write(item.value);item.waiters.forEach(w=>w.resolve());}
    catch(e){item.waiters.forEach(w=>w.reject(e));}
    finally{clearTimeout(timer);}
   }
  }finally{this.running=false;this.idleWaiters.splice(0).forEach(resolve=>resolve());}
 }
}
