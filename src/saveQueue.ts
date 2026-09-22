// One in-flight write; only the latest not-yet-started snapshot per session is kept.
export class SaveQueue<T extends {id:string}>{
 private pending=new Map<string,{value:T;waiters:{resolve:()=>void;reject:(e:unknown)=>void}[]}>();
 private running=false;private idleWaiters:(()=>void)[]=[];
 constructor(private write:(value:T)=>Promise<unknown>){}
 enqueue(value:T):Promise<void>{return new Promise((resolve,reject)=>{const old=this.pending.get(value.id);this.pending.set(value.id,{value,waiters:[...(old?.waiters||[]),{resolve,reject}]});void this.drain();});}
 idle():Promise<void>{return this.running||this.pending.size?new Promise(resolve=>this.idleWaiters.push(resolve)):Promise.resolve();}
 private async drain(){if(this.running)return;this.running=true;try{while(this.pending.size){const [key,item]=this.pending.entries().next().value!;this.pending.delete(key);try{await this.write(item.value);item.waiters.forEach(w=>w.resolve());}catch(e){item.waiters.forEach(w=>w.reject(e));}}}finally{this.running=false;this.idleWaiters.splice(0).forEach(resolve=>resolve());}}
}
