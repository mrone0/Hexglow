type CredentialIO = {
 load:(destination:string)=>Promise<string|null>;
 save:(destination:string,apiKey:string)=>Promise<void>;
};

/** Serialize native operations; stale loads and saves cannot update another service's UI. */
export class ModelCredentials {
 private destination:string|null=null;
 private generation=0;
 private edit=0;
 private tail:Promise<void>=Promise.resolve();
 private failure=false;
 private loading=false;
 constructor(private io:CredentialIO,private onValue:(value:string)=>void,private onStatus:(message:string)=>void){}

 select(destination:string):void {
  if(this.destination===destination)return;
  this.destination=destination;const generation=++this.generation;this.edit=0;this.failure=false;this.loading=!!destination;
  this.onValue('');
  if(!destination){this.onStatus('填写有效的服务地址后可保存密钥。');return;}
  this.onStatus('正在恢复此服务保存的密钥…');
  this.tail=this.tail.then(async()=>{
   try {
    const key=await this.io.load(destination);
    if(generation!==this.generation||this.edit!==0)return;
    this.failure=false;this.onValue(key||'');
    this.onStatus(key?'已恢复此服务的密钥。':'尚未保存密钥，填写后会自动保存。');
   } catch {
    if(generation!==this.generation||this.edit!==0)return;
    this.onStatus('密钥读取失败，请重新填写并保存。');
   } finally {
    if(generation===this.generation)this.loading=false;
   }
  });
 }

 isLoading():boolean {return this.loading;}

 change(value:string):void {
  const destination=this.destination,generation=this.generation,edit=++this.edit;
  if(!destination){this.failure=true;this.onStatus('服务地址无效，密钥尚未保存。');return;}
  this.failure=false;this.onStatus(value.trim()?'正在保存密钥…':'正在删除此服务保存的密钥…');
  this.tail=this.tail.then(async()=>{
   try {
    await this.io.save(destination,value);
    if(generation!==this.generation||edit!==this.edit)return;
    this.failure=false;this.onStatus(value.trim()?'密钥已保存，重启和正常升级后会自动恢复。':'此服务保存的密钥已删除。');
   } catch {
    if(generation!==this.generation||edit!==this.edit)return;
    this.failure=true;this.onStatus('密钥保存失败，请点击“保存密钥”重试。');
   }
  });
 }

 /** Exit and installation must wait for the latest input to reach native storage. */
 async flush():Promise<void> {
  let observed:Promise<void>;
  do {observed=this.tail;await observed;} while(observed!==this.tail);
  if(this.failure)throw new Error('密钥尚未保存成功，请在模型设置中重新保存后再退出或更新。');
 }
}
