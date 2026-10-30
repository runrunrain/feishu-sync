import type { KbManifestDoc } from '../../types/agent-knowledge.js';
import type { KbSection, KbTable } from './outline.js';
export interface KbIndexDoc {
  docId: string; path: string; title: string; summary: string; tags: string[];
  sources: KbManifestDoc['sources']; lines: string[]; normAll: string; lineOffsets: Int32Array;
  meta: { title: string; tags: string; path: string; summary: string };
  sections: KbSection[]; tables: KbTable[];
}
export interface KbIndex {
  releaseId: string; builtAt: number; rankerVersion: 'lex-v1'; docs: KbIndexDoc[];
  byPath: Map<string, number>; byDocId: Map<string, number>; vocab: string[];
  avgSummaryLen: number; avgSectionLen: number;
  integrity: { verified: number; mismatched: string[]; missing: string[] }; bytes: number;
}
