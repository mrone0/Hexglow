import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {describe,expect,it,vi} from 'vitest';
import {modelDestination} from '../src/modelConsent.ts';
import {AUTO_RECOMMEND_PREFERENCE_KEY,readAutoRecommendPreference,autoModelIdentity} from '../src/autoModelConfig.ts';

// Execute the actual settings handlers without mounting Tauri or sending any request.
const source=fs.readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const handlers=new Map();let modelEffect;
function visit(node){
 if(ts.isVariableDeclaration(node)&&['setAutoRecommend','setConsent','setModel'].includes(node.name.getText(ast)))handlers.set(node.name.getText(ast),node.initializer.getText(ast));
 if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&ts.isArrayLiteralExpression(node.arguments[1])&&node.arguments[1].elements.some(e=>e.getText(ast)==='model'))modelEffect=node.arguments[0].getText(ast);
 ts.forEachChild(node,visit);
}
visit(ast);if(handlers.size!==3||!modelEffect)throw Error('Settings handlers missing');
const compile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const initialModel={provider:'openai',baseUrl:'https://synthetic.invalid/v1',name:'synthetic-model'};
function harness(storage=new Map(),authorized=false){
 const model=JSON.parse(storage.get('hexlens-model')||JSON.stringify(initialModel));
 const enabled=readAutoRecommendPreference(storage.get(AUTO_RECOMMEND_PREFERENCE_KEY)??null,storage.get('hexglow-auto-recommend-consent')??null);
 storage.set(AUTO_RECOMMEND_PREFERENCE_KEY,String(enabled));
 if(authorized)storage.set('hexglow-model-consent',modelDestination(model));
 const consent=storage.get('hexglow-model-consent')===modelDestination(model);
 const settings={current:{model,apiKey:'synthetic-key',consent,autoRecommend:enabled&&consent,revision:0}};
 const context=vm.createContext({model,automaticEnabled:enabled,analysisSettings:settings,modelRevision:{current:0},modelDestination,autoModelIdentity,AUTO_RECOMMEND_PREFERENCE_KEY,
  autoRecommendationGate:{current:{resetObservation:vi.fn()}},lastAutoScan:{current:null},modelKeys:{current:{select:vi.fn()}},
  isTauri:()=>true,localStorage:{setItem:(k,v)=>storage.set(k,v)},setAutoRecommendStatus:vi.fn(),setModels:vi.fn(),setModelStatus:vi.fn(),
  setAutomaticEnabled:value=>{context.automaticEnabled=value;},setApprovedDestination:vi.fn(),applyApiKey:vi.fn(),
  setModelState:value=>{context.model=value;vm.runInContext(compile(`(${modelEffect})()`),context);},
 });
 for(const [name,body] of handlers)vm.runInContext(compile(`globalThis.${name}=${body}`),context);
 return {context,storage,settings};
}
describe('saved automatic model settings',()=>{
 it('defaults on but does not activate without data authorization',()=>{
  const h=harness();expect(h.context.automaticEnabled).toBe(true);expect(h.settings.current.autoRecommend).toBe(false);
  h.context.setConsent(true);expect(h.settings.current.autoRecommend).toBe(true);
 });
 it.each([true,false])('restores an explicit %s preference with the saved model after restart',enabled=>{
  const h=harness(new Map(),true);h.context.setAutoRecommend(enabled);
  h.context.setModel({...initialModel,name:'selected-model'});
  const restarted=harness(h.storage);
  expect(restarted.context.model.name).toBe('selected-model');expect(restarted.context.automaticEnabled).toBe(enabled);
  expect(restarted.settings.current.autoRecommend).toBe(enabled);
 });
 it('does not erase the preference when changing models or services, but still requires new service consent',()=>{
  const h=harness(new Map(),true);h.context.setModel({...initialModel,name:'other-model'});
  expect(h.settings.current.autoRecommend).toBe(true);expect(h.context.automaticEnabled).toBe(true);
  h.context.setModel({...initialModel,baseUrl:'https://other.invalid/v1'});
  expect(h.settings.current.consent).toBe(false);expect(h.settings.current.autoRecommend).toBe(false);
  expect(h.context.automaticEnabled).toBe(true);expect(h.context.applyApiKey).toHaveBeenCalledWith('');
  h.context.setConsent(true);expect(h.settings.current.autoRecommend).toBe(true);
  expect(h.storage.get('hexglow-model-consent')).toBe(modelDestination(h.context.model));
 });
 it('revoking data consent pauses calls without losing the preference',()=>{
  const h=harness(new Map(),true);h.context.setConsent(false);
  expect(h.settings.current.autoRecommend).toBe(false);expect(h.context.automaticEnabled).toBe(true);
  h.context.setConsent(true);expect(h.settings.current.autoRecommend).toBe(true);
 });
 it('never treats default-on preference as permission for a different service after restart',()=>{
  const h=harness(new Map(),true);h.context.setModel({...initialModel,baseUrl:'https://other.invalid/v1'});
  const restarted=harness(h.storage);expect(restarted.context.automaticEnabled).toBe(true);
  expect(restarted.settings.current.consent).toBe(false);expect(restarted.settings.current.autoRecommend).toBe(false);
 });
});
