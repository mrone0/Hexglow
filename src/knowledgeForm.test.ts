/// <reference types="vite/client" />
import {describe, expect, it} from 'vitest';
import {parseDocument} from 'yaml';
import {createAugmentDocument, readKnowledgeForm, sectionNames, updateKnowledgeForm, type KnowledgeFields, type KnowledgeKind} from './knowledgeForm';

const fixture = `---
# Keep metadata comments.
title: "原名称" # title comment
description: '原说明'
tags: ["原标签"] # tag comment
status: draft
type: Augment
unknown: { nested: [a, b], exact: 'keep this' }
hexglow:
  schema_version: 1
  mode: hextech-aram
  patch: "16.19.1" # patch comment
  augment_id: custom-test
  game_id: 123
  aliases: ["old"]
  verified: false
  future_extension: keep-me
---
# 原名称

> Intro and [original link](../champions/ahri.md).

## 完整效果

第一行
第二行

### 内部小节
保留内部段落。

## 自定义章节
保持原样，包括空白。

## 触发条件

原条件。

## 限制与例外

原限制。

## 相关交互

与[示例](../augments/custom-example.md)相关。
`;

function fields(content = fixture, kind: KnowledgeKind = 'Augment'): KnowledgeFields {
  const result = readKnowledgeForm(content, kind);
  expect(result.error).toBeUndefined();
  expect(result.fields).not.toBeNull();
  return structuredClone(result.fields!);
}

function metadata(content: string): Record<string, any> {
  return parseDocument(content.split(/^---\r?$/m)[1]).toJS();
}

describe('lossless knowledge form', () => {
  it('reads every bundled champion and augment without rewriting any bytes', () => {
    const documents = import.meta.glob<string>('../knowledge-seed/{champions,augments}/*.md', {query: '?raw', import: 'default', eager: true});
    expect(Object.keys(documents).length).toBeGreaterThan(300);
    for (const [path, content] of Object.entries(documents)) {
      const kind: KnowledgeKind = path.includes('/champions/') ? 'Champion' : 'Augment';
      const result = readKnowledgeForm(content, kind);
      expect(result.error, path).toBeUndefined();
      expect(updateKnowledgeForm(content, kind, result.fields!)).toBe(content);
    }
  });

  it.each(['\n', '\r\n'])('preserves the exact unchanged document with %j endings', newline => {
    const content = fixture.replace(/\n/g, newline);
    const result = readKnowledgeForm(content, 'Augment');
    expect(result.extraSections).toEqual(['自定义章节']);
    expect(result.fields!.sections['完整效果']).toContain('### 内部小节\n保留内部段落。');
    expect(updateKnowledgeForm(content, 'Augment', result.fields!)).toBe(content);
  });

  it('only replaces a changed scalar and preserves comments, extensions and the entire body', () => {
    const changed = fields();
    changed.description = '新说明：包含 "引号"、#、:、[特殊]字符';
    const updated = updateKnowledgeForm(fixture, 'Augment', changed);
    expect(updated).toBe(fixture.replace("'原说明'", JSON.stringify(changed.description)));
    expect(metadata(updated).description).toBe(changed.description);
    expect(metadata(updated).hexglow.verified).toBe(false);
  });

  it('edits all exposed metadata without changing protected identities or verified status', () => {
    const changed = fields();
    changed.title = '新名称';
    changed.status = 'stable';
    changed.patch = '16.20';
    changed.tags = ['中文标签', 'x: y'];
    changed.aliases = ['别名', 'quote " slash \\'];
    const updated = updateKnowledgeForm(fixture, 'Augment', changed);
    const data = metadata(updated);
    expect(updated).toContain('# 新名称\n\n> Intro');
    expect(updated).toContain('"新名称" # title comment');
    expect(updated).toContain('["中文标签","x: y"] # tag comment');
    expect(updated).toContain('"16.20" # patch comment');
    expect(data.type).toBe('Augment');
    expect(data.hexglow.augment_id).toBe('custom-test');
    expect(data.hexglow.game_id).toBe(123);
    expect(data.hexglow.verified).toBe(false);
    expect(data.unknown).toEqual(metadata(fixture).unknown);
    expect(updated).toContain('future_extension: keep-me');
  });

  it('does not change a separate document heading or introduction when the title changes', () => {
    const content = fixture.replace('# 原名称\n', '# 其他文档标题\n');
    const changed = fields(content);
    changed.title = '新名称';
    const updated = updateKnowledgeForm(content, 'Augment', changed);
    expect(updated).toContain('# 其他文档标题\n\n> Intro');
    expect(updated).not.toContain('# 新名称');
  });

  it('edits exactly one body section and preserves its surrounding blank lines and CRLF', () => {
    const content = fixture.replace(/\n/g, '\r\n');
    const changed = fields(content);
    changed.sections['触发条件'] = '新条件。\n第二行。';
    const updated = updateKnowledgeForm(content, 'Augment', changed);
    expect(updated).toBe(content.replace('原条件。', '新条件。\r\n第二行。'));
    expect(updated.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('allows empty text during editing and can restore an empty title and section', () => {
    const changed = fields();
    changed.title = '';
    changed.description = '';
    changed.patch = '';
    changed.sections['触发条件'] = '';
    const empty = updateKnowledgeForm(fixture, 'Augment', changed);
    const resumed = fields(empty);
    expect(resumed.title).toBe('');
    expect(resumed.description).toBe('');
    expect(resumed.patch).toBe('');
    expect(resumed.sections['触发条件']).toBe('');
    resumed.title = '恢复名称';
    resumed.sections['触发条件'] = '恢复条件';
    const restored = updateKnowledgeForm(empty, 'Augment', resumed);
    expect(restored).toContain('# 恢复名称\n');
    expect(fields(restored).sections['触发条件']).toBe('恢复条件');
    expect(restored).toContain('## 限制与例外\n');
  });

  it('preserves Enter, blank lines and trailing spaces through repeated form keystrokes', () => {
    for (const initial of [fixture, createAugmentDocument('custom-compact'), fixture.trimEnd()]) {
      let content = initial;
      for (const name of sectionNames.Augment) {
        for (const value of ['新内容', '新内容\n', '新内容\n\n', '\n新内容\n\n', '新内容  ', '', '\n', '\n\n']) {
          const changed = fields(content);
          changed.sections[name] = value;
          content = updateKnowledgeForm(content, 'Augment', changed);
          expect(fields(content).sections[name], `${name}: ${JSON.stringify(value)}`).toBe(value);
        }
      }
    }
  });

  it('allows blank list entries while typing, leaving save-time validation to the backend', () => {
    const changed = fields();
    changed.aliases = ['第一个别名', '', ''];
    changed.tags = ['', '标签', ''];
    const updated = updateKnowledgeForm(fixture, 'Augment', changed);
    expect(fields(updated).aliases).toEqual(changed.aliases);
    expect(fields(updated).tags).toEqual(changed.tags);
  });

  it('can fill an empty final section whose heading has no terminating newline', () => {
    const content = fixture.slice(0, fixture.indexOf('## 相关交互')) + '## 相关交互';
    const changed = fields(content);
    expect(changed.sections['相关交互']).toBe('');
    changed.sections['相关交互'] = '新增内容';
    const updated = updateKnowledgeForm(content, 'Augment', changed);
    expect(fields(updated).sections['相关交互']).toBe('新增内容');
  });

  it('serializes metadata strings safely instead of allowing YAML injection', () => {
    const changed = fields();
    changed.description = '换行\nstatus: stable\nhexglow:\n  verified: true\n---\n## 相关交互';
    changed.aliases = ['x\n- y', 'false', '"], status: stable #'];
    const updated = updateKnowledgeForm(fixture, 'Augment', changed);
    const data = metadata(updated);
    expect(data.description).toBe(changed.description);
    expect(data.hexglow.aliases).toEqual(changed.aliases);
    expect(data.status).toBe('draft');
    expect(data.hexglow.verified).toBe(false);
    expect(fields(updated).sections).toEqual(fields().sections);
  });

  it('supports uncommented block scalars and block lists, preserving the following key', () => {
    const content = fixture.replace("description: '原说明'", 'description: |\n  原说明\n  第二行')
      .replace('tags: ["原标签"] # tag comment', 'tags:\n  - 原标签\n  - 第二标签');
    const changed = fields(content);
    expect(changed.description).toBe('原说明\n第二行\n');
    changed.description = '改后文字';
    changed.tags = ['新标签'];
    const updated = updateKnowledgeForm(content, 'Augment', changed);
    expect(metadata(updated).description).toBe('改后文字');
    expect(metadata(updated).tags).toEqual(['新标签']);
    expect(metadata(updated).status).toBe('draft');
    expect(updated).toContain("unknown: { nested: [a, b], exact: 'keep this' }");
  });

  it('supports flow mappings without reordering fields', () => {
    const content = fixture.replace(/hexglow:\n[\s\S]*?\n---/, 'hexglow: {schema_version: 1, mode: hextech-aram, patch: "16.19.1", augment_id: custom-test, aliases: ["old"], verified: false}\n---');
    const changed = fields(content);
    changed.patch = '新版';
    expect(updateKnowledgeForm(content, 'Augment', changed)).toBe(content.replace('patch: "16.19.1"', 'patch: "新版"'));
  });

  it('recognizes first-level required headings and leaves third-level headings inside the section', () => {
    const content = fixture.replace(/^## (完整效果|触发条件|限制与例外|相关交互)$/gm, '# $1');
    const changed = fields(content);
    expect(changed.sections['完整效果']).toContain('### 内部小节');
    changed.sections['相关交互'] += '\n另一条。';
    expect(updateKnowledgeForm(content, 'Augment', changed)).toContain('# 相关交互\n');
  });

  it.each(['```', '~~~'])('ignores fake required headings inside %s fences', fence => {
    const content = fixture.replace('原条件。', `${fence}md\n## 完整效果\n# 相关交互\n${fence}\n原条件。`);
    const changed = fields(content);
    expect(changed.sections['触发条件']).toContain('## 完整效果');
    expect(updateKnowledgeForm(content, 'Augment', changed)).toBe(content);
  });

  it('only closes a fence with the same marker and a sufficiently long delimiter', () => {
    const content = fixture.replace('原条件。', '````md\n```\n~~~\n## 完整效果\n````\n原条件。');
    expect(fields(content).sections['触发条件']).toContain('## 完整效果');
  });

  it.each([
    ['missing frontmatter', fixture.slice(4)],
    ['unclosed frontmatter', fixture.replace('\n---\n', '\n...\n')],
    ['missing required heading', fixture.replace('## 触发条件', '## 别的章节')],
    ['duplicate required heading', fixture + '\n# 触发条件\n重复'],
    ['unclosed backtick fence', fixture + '\n```md\n文字'],
    ['unclosed tilde fence', fixture + '\n~~~\n文字'],
    ['duplicate YAML field', fixture.replace('status: draft', 'status: draft\nstatus: stable')],
    ['wrong document kind', fixture.replace('type: Augment', 'type: Champion')],
    ['missing known metadata', fixture.replace('  aliases: ["old"]\n', '')],
    ['non-string tag', fixture.replace('tags: ["原标签"]', 'tags: [123]')],
    ['anchored editable scalar', fixture.replace('title: "原名称"', 'title: &name "原名称"')],
    ['alias metadata', fixture.replace("description: '原说明'", 'description: *missing')],
    ['list item comments', fixture.replace('tags: ["原标签"] # tag comment', 'tags:\n  - 原标签 # 保留的注释')],
    ['empty flow list comments', fixture.replace('tags: ["原标签"] # tag comment', 'tags: [ # 保留的注释\n]')],
    ['block scalar comments', fixture.replace("description: '原说明'", 'description: | # 保留的注释\n  原说明')],
    ['merge mappings', fixture.replace('unknown:', '<<: {x: y}\nunknown:')],
  ])('fails safely for %s without exposing a lossy form', (_name, content) => {
    const result = readKnowledgeForm(content, 'Augment');
    expect(result.fields).toBeNull();
    expect(result.error).toContain('高级编辑');
    expect(() => updateKnowledgeForm(content, 'Augment', fields())).toThrow();
  });

  it('rejects body edits that could escape their section', () => {
    for (const unsafe of ['新条件\n## 相关交互\n注入', '```\n未闭代码', '~~~\n未闭代码']) {
      const changed = fields();
      changed.sections['触发条件'] = unsafe;
      expect(() => updateKnowledgeForm(fixture, 'Augment', changed)).toThrow('高级编辑');
    }
  });

  it('rejects title injection without corrupting document structure', () => {
    for (const title of ['名称\n## 相关交互', '完整效果']) {
      const changed = fields();
      changed.title = title;
      expect(() => updateKnowledgeForm(fixture, 'Augment', changed)).toThrow();
    }
  });

  it('creates an editable draft with required metadata and sections, not a fabricated game ID', () => {
    const content = createAugmentDocument('custom-0f61bbcc-a111-4aa0-b333-4fdea7acfc77');
    const result = fields(content);
    const data = metadata(content);
    expect(result.status).toBe('draft');
    expect(result.patch).toBe('unknown');
    expect(Object.keys(result.sections)).toEqual(sectionNames.Augment);
    expect(data.type).toBe('Augment');
    expect(data.hexglow.schema_version).toBe(1);
    expect(data.hexglow.mode).toBe('hextech-aram');
    expect(data.hexglow.verified).toBe(false);
    expect(data.hexglow.game_id).toBeUndefined();
    expect(updateKnowledgeForm(content, 'Augment', result)).toBe(content);
  });

  it.each(['../wrong', 'custom-x\nverified: true', 'custom-', 'custom-中文', `custom-${'a'.repeat(100)}`])('rejects unsafe creation ID %s', id => {
    expect(() => createAugmentDocument(id)).toThrow('标识');
  });
});
