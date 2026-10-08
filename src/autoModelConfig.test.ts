import {describe,expect,it} from 'vitest';
import {autoModelIdentity,automaticModelIssue} from './autoModelConfig';

const model={provider:'openai',baseUrl:'https://models.example/v1',name:'example-model'};
describe('automatic model opt-in configuration',()=>{
  it('binds approval to the provider, full service path and model, not a key',()=>{
    expect(autoModelIdentity({...model,baseUrl:model.baseUrl+'/'})).toBe(autoModelIdentity(model));
    for(const change of [{provider:'jev'},{baseUrl:'https://other.example/v1'},{baseUrl:'https://models.example/v2'},{name:'other-model'}])expect(autoModelIdentity({...model,...change})).not.toBe(autoModelIdentity(model));
  });
  it.each(['bad address','https://user:pass@models.example/v1','https://models.example/v1?token=example','https://models.example/v1#fragment'])('rejects ambiguous destinations: %s',baseUrl=>{
    expect(autoModelIdentity({...model,baseUrl})).toBe('');
    expect(automaticModelIssue({...model,baseUrl},'synthetic')).not.toBe('');
  });
  it('requires a model and cloud credentials, without persisting keys',()=>{
    expect(autoModelIdentity({...model,name:' '})).toBe('');
    expect(automaticModelIssue(model,'')).toContain('API Key');
    expect(automaticModelIssue(model,'synthetic')).toBe('');
  });
  it.each(['http://127.0.0.1:11434/v1','http://[::1]:1234/v1'])('allows keyless loopback services: %s',baseUrl=>expect(automaticModelIssue({...model,baseUrl},'')).toBe(''));
  it.each(['http://models.example/v1','http://localhost:11434/v1','file:///v1'])('matches backend transport restrictions: %s',baseUrl=>expect(automaticModelIssue({...model,baseUrl},'synthetic')).not.toBe(''));
  it('requires third-party Jev permission separately',()=>{
    expect(automaticModelIssue({...model,provider:'jev'},'synthetic')).toContain('第三方');
    expect(automaticModelIssue({...model,provider:'jev',allowThirdParty:true},'synthetic')).toBe('');
  });
});
