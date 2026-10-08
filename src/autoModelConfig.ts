import {modelDestination} from './modelConsent';

type AutomaticModel = {provider?:string;baseUrl:string;name:string;allowThirdParty?:boolean};

/** Automatic billing needs its own opt-in, bound to both service and model. */
export function autoModelIdentity(model:AutomaticModel):string {
  const destination=modelDestination(model);
  return destination&&model.name.trim()?JSON.stringify([destination,model.name.trim()]):'';
}

export function automaticModelIssue(model:AutomaticModel,apiKey:string):string {
  if(!autoModelIdentity(model))return '请先填写有效的模型地址与名称。';
  const url=new URL(model.baseUrl.trim());
  const local=/^127\.0\.0\.\d+$/.test(url.hostname)||url.hostname==='[::1]';
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))return '自动推荐仅支持 HTTPS 或本机 HTTP 回环地址。';
  if(model.provider==='jev'&&!(url.protocol==='https:'&&url.hostname==='api.typesafe.ai')&&!model.allowThirdParty)return '请先明确允许此第三方 Jev 地址。';
  if(!local&&!apiKey.trim())return '请先填写当前服务的 API Key；Key 不会跨启动保存。';
  return '';
}
