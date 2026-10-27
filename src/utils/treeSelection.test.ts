import { expect, it } from 'vitest';
import { applySelectionGesture, descendantSelection } from './treeSelection';
const nodes = [
  { obj_token: 'p', wiki_node_token: 'wiki-p', parent_node_token: null },
  { obj_token: 'c', wiki_node_token: 'wiki-c', parent_node_token: 'wiki-p' },
  { obj_token: 'g', wiki_node_token: 'wiki-g', parent_node_token: 'wiki-c' },
  { obj_token: 'other', wiki_node_token: 'wiki-other', parent_node_token: null },
];
it('父级选择包括收起/搜索外的孙文档，多个重叠子树去重且其他根不变', () => {
  expect(descendantSelection(nodes, ['p','c'])).toEqual(['p','c','g']);
  expect(descendantSelection(nodes, ['g','other'])).toEqual(['g','other']);
});
it('循环、缺失标识和本地归档不会导致无限展开或误选其他记录', () => {
  const cyclic = [{ ...nodes[0], parent_node_token: 'wiki-c' }, nodes[1], nodes[3], { obj_token: 'archive', wiki_node_token: null, parent_node_token: null }];
  expect(descendantSelection(cyclic, ['p','missing'])).toEqual(['p','c']);
  expect(descendantSelection(cyclic, ['archive'])).toEqual(['archive']);
});

const plain = { shiftKey: false, metaKey: false, ctrlKey: false };
const displayed = ['p', 'other', 'archive', 'last'];
const identity = (tokens: Iterable<string>) => [...tokens];
it('普通点选替换选择，Command 与 Ctrl 点选保留其他项并可取消', () => {
  expect([...applySelectionGesture(new Set(['other']), 'p', null, displayed, identity, plain).chosen]).toEqual(['p']);
  for (const key of ['metaKey', 'ctrlKey'] as const) {
    const added = applySelectionGesture(new Set(['other']), 'p', null, displayed, identity, { ...plain, [key]: true });
    expect([...added.chosen]).toEqual(['other', 'p']);
    expect([...applySelectionGesture(added.chosen, 'p', added.anchor, displayed, identity, { ...plain, [key]: true }).chosen]).toEqual(['other']);
  }
});
it('Shift 按可见顺序双向连选并保留起点，缩短区间会替换旧区间', () => {
  const ranged = applySelectionGesture(new Set(['last']), 'archive', 'p', displayed, identity, { ...plain, shiftKey: true });
  expect([...ranged.chosen]).toEqual(['p', 'other', 'archive']);
  expect(ranged.anchor).toBe('p');
  expect([...applySelectionGesture(ranged.chosen, 'other', ranged.anchor, displayed, identity, { ...plain, shiftKey: true }).chosen]).toEqual(['p', 'other']);
  expect([...applySelectionGesture(new Set(), 'other', 'last', displayed, identity, { ...plain, shiftKey: true }).chosen]).toEqual(['other', 'archive', 'last']);
});
it('Command/Ctrl + Shift 追加区间，跨来源归档也沿显示顺序', () => {
  for (const key of ['metaKey', 'ctrlKey'] as const) {
    expect([...applySelectionGesture(new Set(['p']), 'last', 'archive', displayed, identity, { ...plain, shiftKey: true, [key]: true }).chosen]).toEqual(['p', 'archive', 'last']);
  }
});
it('收起的子文档只随父节点联选进入范围，关闭联选则不加入', () => {
  const expand = (tokens: Iterable<string>) => descendantSelection(nodes, tokens);
  expect([...applySelectionGesture(new Set(), 'other', 'p', ['p', 'other'], expand, { ...plain, shiftKey: true }).chosen]).toEqual(['p', 'other', 'c', 'g']);
  expect([...applySelectionGesture(new Set(), 'other', 'p', ['p', 'other'], identity, { ...plain, shiftKey: true }).chosen]).toEqual(['p', 'other']);
});
it('搜索或折叠隐藏起点后只选择目标，不带入不可见的旧区间', () => {
  const selected = applySelectionGesture(new Set(['p']), 'archive', 'p', ['other', 'archive'], identity, { ...plain, shiftKey: true });
  expect([...selected.chosen]).toEqual(['archive']); expect(selected.anchor).toBe('archive');
});
it('复选框保留逐项增减习惯，部分选择的父节点补全子树', () => {
  const expand = (tokens: Iterable<string>) => descendantSelection(nodes, tokens);
  const added = applySelectionGesture(new Set(['other', 'c']), 'p', null, displayed, expand, plain, true);
  expect([...added.chosen]).toEqual(['other', 'c', 'p', 'g']);
  expect([...applySelectionGesture(added.chosen, 'p', 'p', displayed, expand, plain, true).chosen]).toEqual(['other']);
});
