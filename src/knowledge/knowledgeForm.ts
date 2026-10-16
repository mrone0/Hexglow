import {isMap, isNode, isScalar, isSeq, parseDocument, type Node, type Scalar, type YAMLMap, type YAMLSeq} from 'yaml';

export type KnowledgeKind = 'Champion' | 'Augment';
export type KnowledgeFields = {
  title: string;
  description: string;
  status: string;
  patch: string;
  tags: string[];
  aliases: string[];
  sections: Record<string, string>;
};
export type KnowledgeFormResult = {fields: KnowledgeFields | null; error?: string; extraSections: string[]};

export const sectionNames: Record<KnowledgeKind, readonly string[]> = {
  Champion: ['基础机制', '常见打法', '海克斯搭配', '注意事项'],
  Augment: ['完整效果', '触发条件', '限制与例外', '相关交互'],
};

type Span = {start: number; end: number};
type Line = Span & {text: string; after: number};
type Heading = Line & {name: string; level: number};
type Section = Span & {value: string; needsHeadingNewline: boolean};
type MetadataField = Exclude<keyof KnowledgeFields, 'sections'>;
type MappedDocument = {
  fields: KnowledgeFields;
  extraSections: string[];
  nodes: Record<MetadataField, Scalar | YAMLSeq>;
  yamlOffset: number;
  yaml: string;
  newline: string;
  sections: Record<string, Section>;
  mainTitle?: Heading;
};

function fail(message: string): never {
  throw new Error(`${message}，请使用高级编辑。`);
}

function lines(text: string, offset = 0): Line[] {
  const result: Line[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && match[0].length) {
    result.push({text: match[1], start: offset + match.index, end: offset + match.index + match[1].length,
      after: offset + match.index + match[0].length});
  }
  return result;
}

// Only headings outside fenced code delimit form fields. Third-level headings stay in their section.
function headings(body: string, offset = 0): Heading[] {
  const result: Heading[] = [];
  let fence: {character: string; length: number} | undefined;
  for (const line of lines(body, offset)) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line.text);
      if (close && close[1][0] === fence.character && close[1].length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      fence = {character: open[1][0], length: open[1].length};
      continue;
    }
    const heading = /^( {0,3})(#{1,2})(?:[ \t]+(.*?))?[ \t]*$/.exec(line.text);
    if (heading) {
      const name = (heading[3] ?? '').trimEnd();
      result.push({...line, name, level: heading[2].length});
    }
  }
  if (fence) fail('文档包含未闭合的代码围栏');
  return result;
}

function direct(map: YAMLMap, key: string): Node {
  // Merge keys and non-string keys need a fuller YAML editor, not an inferred flattened view.
  if (map.items.some(pair => !isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<')) {
    fail('文档包含无法安全映射的元数据键');
  }
  const pair = map.items.find(item => isScalar(item.key) && item.key.value === key);
  if (!pair || !isNode(pair.value)) fail(`缺少元数据 ${key}`);
  return pair.value;
}

function safeValue(node: Node, label: string): asserts node is Scalar | YAMLSeq {
  if ((!isScalar(node) && !isSeq(node)) || !node.range || node.tag || node.anchor) {
    fail(`元数据 ${label} 使用了不支持的复杂格式`);
  }
  if (isSeq(node)) {
    const hasInternalComment = (token: unknown): boolean => {
      if (!token || typeof token !== 'object') return false;
      if (Array.isArray(token)) return token.some(hasInternalComment);
      const record = token as Record<string, unknown>;
      if (record.type === 'comment' && typeof record.offset === 'number') {
        return record.offset >= node.range![0] && record.offset < node.range![1];
      }
      return Object.values(record).some(hasInternalComment);
    };
    if (hasInternalComment(node.srcToken)) fail(`元数据 ${label} 包含列表内注释`);
    for (const item of node.items) {
      if (!isScalar(item) || typeof item.value !== 'string' || item.tag || item.anchor || item.comment || item.commentBefore) {
        fail(`元数据 ${label} 包含复杂列表或列表内注释`);
      }
    }
    // A comment after a flow sequence lies outside value-end and is preserved automatically.
    if (!node.flow && node.comment) fail(`元数据 ${label} 包含列表内注释`);
  } else if ((node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') && node.comment) {
    fail(`元数据 ${label} 包含块文本内注释`);
  }
}

function mapDocument(content: string, kind: KnowledgeKind): MappedDocument {
  const allLines = lines(content);
  if (allLines[0]?.text !== '---') fail('缺少文档开头的 YAML 元数据');
  const delimiter = allLines.find((line, index) => index > 0 && line.text === '---');
  if (!delimiter) fail('YAML 元数据未闭合');
  const yamlOffset = allLines[0].after;
  const yaml = content.slice(yamlOffset, delimiter.start);
  const parsed = parseDocument(yaml, {uniqueKeys: true, keepSourceTokens: true});
  if (parsed.errors.length || !isMap(parsed.contents)) fail('YAML 元数据格式不正确或存在重复字段');
  const root = parsed.contents;
  const type = direct(root, 'type');
  if (!isScalar(type) || type.value !== kind) fail('文档类型与所选资料不一致');
  const hexglow = direct(root, 'hexglow');
  if (!isMap(hexglow) || hexglow.tag || hexglow.anchor) fail('hexglow 元数据不是可安全编辑的对象');
  const identity = direct(hexglow, kind === 'Champion' ? 'champion_id' : 'augment_id');
  if (!isScalar(identity) || typeof identity.value !== 'string' || !identity.value.trim()) fail('文档标识不正确');
  const names: MetadataField[] = ['title', 'description', 'status', 'patch', 'tags', 'aliases'];
  const nodes = {} as MappedDocument['nodes'];
  const values: Partial<KnowledgeFields> = {};
  for (const name of names) {
    const node = direct(name === 'patch' || name === 'aliases' ? hexglow : root, name);
    safeValue(node, name);
    nodes[name] = node;
    if (name === 'tags' || name === 'aliases') {
      if (!isSeq(node)) fail(`元数据 ${name} 应为文字列表`);
      values[name] = node.items.map(item => (item as Scalar<string>).value);
    } else {
      if (!isScalar(node) || typeof node.value !== 'string') fail(`元数据 ${name} 应为文字`);
      values[name] = node.value;
    }
  }
  if (!['draft', 'stable', 'deprecated'].includes(values.status!)) fail('文档状态不受支持');

  const bodyHeadings = headings(content.slice(delimiter.after), delimiter.after);
  const required = sectionNames[kind];
  const sections: Record<string, Section> = {};
  const sectionValues: Record<string, string> = {};
  for (const name of required) {
    const matches = bodyHeadings.filter(heading => heading.name === name);
    if (matches.length !== 1) fail(matches.length ? `必需章节“${name}”重复` : `缺少必需章节“${name}”`);
    const heading = matches[0];
    const next = bodyHeadings[bodyHeadings.indexOf(heading) + 1];
    const end = next?.start ?? content.length;
    const raw = content.slice(heading.after, end);
    // Strip only the fixed layout boundary, never all blank lines: the latter eats Enter
    // in a controlled textarea that reparses its source on every keystroke.
    const prefix = /^(?:\r\n|\n|\r)/.exec(raw)?.[0] ?? '';
    const remaining = raw.slice(prefix.length);
    let valueEnd = remaining.length;
    for (let index = 0; index < 2; index++) {
      const boundary = /(?:\r\n|\n|\r)$/.exec(remaining.slice(0, valueEnd));
      if (boundary) valueEnd -= boundary[0].length;
    }
    const value = remaining.slice(0, valueEnd).replace(/\r\n|\r/g, '\n');
    sections[name] = {start: heading.after, end, value, needsHeadingNewline: heading.after === heading.end};
    sectionValues[name] = value;
  }
  const firstSectionStart = Math.min(...required.map(name => bodyHeadings.find(heading => heading.name === name)!.start));
  const possibleTitles = bodyHeadings.filter(heading => heading.start < firstSectionStart && heading.level === 1 && heading.name === values.title);
  const mainTitle = possibleTitles.length === 1 ? possibleTitles[0] : undefined;
  return {fields: {...values, sections: sectionValues} as KnowledgeFields, nodes, yamlOffset, yaml,
    newline: content.includes('\r\n') ? '\r\n' : '\n', sections, mainTitle,
    extraSections: bodyHeadings.filter(heading => !required.includes(heading.name) && heading !== mainTitle).map(heading => heading.name)};
}

export function readKnowledgeForm(content: string, kind: KnowledgeKind): KnowledgeFormResult {
  try {
    const mapped = mapDocument(content, kind);
    return {fields: mapped.fields, extraSections: mapped.extraSections};
  } catch (error) {
    return {fields: null, extraSections: [], error: error instanceof Error ? error.message : '无法安全读取文档，请使用高级编辑。'};
  }
}

/** Apply disjoint source edits only. Unknown metadata, prose and unedited Markdown retain their original bytes. */
export function updateKnowledgeForm(content: string, kind: KnowledgeKind, fields: KnowledgeFields): string {
  const mapped = mapDocument(content, kind);
  const edits: (Span & {replacement: string})[] = [];
  for (const name of Object.keys(mapped.nodes) as MetadataField[]) {
    const value = fields[name];
    const isList = name === 'tags' || name === 'aliases';
    if (isList ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : typeof value !== 'string') {
      fail(`元数据 ${name} 的内容类型不正确`);
    }
    if (JSON.stringify(value) === JSON.stringify(mapped.fields[name])) continue;
    if (name === 'status' && !['draft', 'stable', 'deprecated'].includes(value as string)) fail('文档状态不受支持');
    if (name === 'title' && /[\r\n]/.test(value as string)) fail('名称不能包含换行');
    const node = mapped.nodes[name];
    const [start, end] = node.range!;
    const oldValue = mapped.yaml.slice(start, end);
    // Block values include their terminating newline in value-end; keep that boundary after conversion.
    const finalNewline = /(?:\r\n|\n|\r)$/.exec(oldValue)?.[0] ?? '';
    edits.push({start: mapped.yamlOffset + start, end: mapped.yamlOffset + end,
      replacement: JSON.stringify(value) + finalNewline});
  }
  for (const name of sectionNames[kind]) {
    const value = fields.sections?.[name];
    if (typeof value !== 'string') fail(`缺少章节“${name}”的文字内容`);
    const normalized = value.replace(/\r\n|\r/g, '\n');
    const original = mapped.sections[name];
    if (normalized === original.value) continue;
    if (headings(normalized).length) fail('简易编辑不能添加一级或二级章节');
    // Use a fixed one-line leading / two-line trailing layout only for an edited section.
    // This lets intentional leading/trailing newlines survive the next read, including
    // compact original documents or a final heading without a terminating newline.
    edits.push({...original, replacement: (original.needsHeadingNewline ? mapped.newline : '')
      + mapped.newline + normalized.replace(/\n/g, mapped.newline) + mapped.newline.repeat(2)});
  }
  if (mapped.mainTitle && fields.title !== mapped.fields.title) {
    if (sectionNames[kind].includes(fields.title.trim())) fail('名称不能与必需章节标题相同');
    const heading = mapped.mainTitle;
    const prefix = /^( {0,3}#)[ \t]*/.exec(content.slice(heading.start, heading.end))![0];
    edits.push({start: heading.start, end: heading.end, replacement: `${prefix.trimEnd()} ${fields.title}`});
  }
  let updated = content;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
  }
  // A form edit must not silently corrupt a neighbouring section or metadata field.
  mapDocument(updated, kind);
  return updated;
}

export function createAugmentDocument(id: string): string {
  if (!/^custom-[a-z0-9-]+$/.test(id) || id.length > 100) throw new Error('新海克斯标识格式不正确。');
  return `---\ntitle: "新海克斯"\ndescription: "请填写简短说明。"\ntags: ["海克斯"]\nstatus: draft\ntype: Augment\nhexglow:\n  schema_version: 1\n  mode: hextech-aram\n  patch: "unknown"\n  augment_id: "${id}"\n  aliases: []\n  verified: false\n---\n# 新海克斯\n\n## 完整效果\n请填写完整效果和数值；未核实的信息请注明。\n\n## 触发条件\n待核实。\n\n## 限制与例外\n待核实。\n\n## 相关交互\n暂无已确认资料。\n`;
}
