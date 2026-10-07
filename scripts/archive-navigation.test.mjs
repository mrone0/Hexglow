import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

// Inspect/render only the actual archive navigation JSX. Loading main.tsx would
// mount the application and is deliberately avoided; no IPC or personal data.
const path = new URL('../src/main.tsx', import.meta.url);
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const elements = [];
function visit(node) {if (ts.isJsxElement(node)) elements.push(node); ts.forEachChild(node, visit);}
visit(ast);
const className = node => node.openingElement.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(ast) === 'className')?.initializer?.text;
const workspace = elements.find(node => className(node) === 'workspace');
const navigation = workspace?.children.find(node => ts.isJsxExpression(node) && node.getText(ast).includes('className="archive-page-back"'));
if (!workspace || !navigation?.expression) throw new Error('Page-level archive navigation JSX not found');
const compiled = ts.transpileModule(`(${navigation.expression.getText(ast)})`, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
}).outputText;

function render(view, archiveDetail) {
  const updates = [];
  const element = vm.runInNewContext(compiled, {exports: {}, require: createRequire(import.meta.url), view, archiveDetail, setArchiveDetail: next => updates.push(next)});
  return {element, html: renderToStaticMarkup(element), updates};
}

describe('archive detail return navigation', () => {
  it('opens archive details at the page top so the return button is immediately visible', () => {
    let callback;
    function find(node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[1]?.getText(ast) === '[view,archiveDetail?.id]') callback = node.arguments[0];
      ts.forEachChild(node, find);
    }
    find(ast);
    expect(callback).toBeDefined();
    const calls = [];
    const execute = (view, archiveDetail) => vm.runInNewContext(`(${callback.getText(ast)})()`, {view, archiveDetail, window:{scrollTo:(...args)=>calls.push(args)}});
    execute('archive', {id:'synthetic'});
    expect(calls).toEqual([[0,0]]);
    execute('archive', null);execute('live', {id:'synthetic'});
    expect(calls).toHaveLength(1);
  });
  it('places the only return button directly in the workspace before hero and archive content', () => {
    const index = workspace.children.indexOf(navigation);
    const hero = workspace.children.findIndex(node => ts.isJsxExpression(node) && node.getText(ast).includes('className="hero"'));
    const archive = workspace.children.findIndex(node => ts.isJsxExpression(node) && node.getText(ast).includes('className="archive-detail"'));
    expect(index).toBeGreaterThan(-1);
    expect(index).toBeLessThan(hero);
    expect(index).toBeLessThan(archive);
    const buttons = elements.filter(node => node.openingElement.tagName.getText(ast) === 'button' && node.children.some(child => ts.isJsxText(child) && child.text.includes('返回列表')));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].parent.openingElement.tagName.getText(ast)).toBe('div');
    expect(className(buttons[0].parent)).toBe('archive-page-back');
    expect(className(buttons[0])).toBeUndefined();
    expect(elements.find(node => className(node) === 'archive-actions detail-actions').getText(ast)).not.toContain('返回列表');
  });

  it('shows it only while viewing an archive detail and preserves the original back action', () => {
    const detail = render('archive', {id: 'synthetic-archive'});
    expect(detail.html).toContain('← 返回列表');
    detail.element.props.children.props.onClick();
    expect(detail.updates).toEqual([null]);
    expect(render('archive', null).html).toBe('');
    expect(render('live', {id: 'synthetic-archive'}).html).toBe('');
  });

  it('adds only spacing for its page-level row without changing button styling', () => {
    const css = fs.readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
    expect(css.match(/\.archive-page-back\s*\{([^}]+)\}/)?.[1].trim()).toBe('margin-top: 16px;');
    expect(css).not.toMatch(/\.archive-page-back\s+button/);
  });
});
