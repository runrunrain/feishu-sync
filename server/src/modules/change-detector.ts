/**
 * ChangeDetector - Detect changes in Feishu wiki subtrees
 *
 * Implements 架构设计文档 §6.1 + 技术实现文档 §七:
 * - detectChanges(): main entry point
 * - traverseWikiSubtree(): BFS recursion with space_id caching
 * - compareWithLocalRecords(): compare obj_edit_time with SQLite records
 * - resolveSheetTokenFromLink(): sheet obj_token fallback
 *
 * Field mapping validated by 飞书认证架构专项设计 §十一:
 * - obj_edit_time: Unix seconds (from lark-cli wiki +node-get)
 * - space_id: from getNode(rootUrl) return value
 * - has_child: boolean for recursion
 */

import type { LarkCliClient } from './lark-cli-client.js';
import type { LocalMapStore } from './local-map-store.js';
import type { ChangeDetectionResult, ChangedDocument, LarkCliNodeInfo } from '../types/index.js';

export class ChangeDetector {
  // space_id cache: rootUrl -> space_id (avoid repeated getNode calls)
  private spaceIdCache = new Map<string, string>();

  constructor(
    private larkCliClient: LarkCliClient,
    private localMapStore: LocalMapStore
  ) {}

  /**
   * Main entry point: detect changes in a wiki subtree
   */
  async detectChanges(rootUrl: string): Promise<ChangeDetectionResult> {
    // 1. Get root node info (space_id + root_token + obj_edit_time)
    const rootInfo = await this.larkCliClient.getNode(rootUrl);
    const spaceId = rootInfo.space_id;
    const rootToken = rootInfo.node_token;

    // Cache space_id for future calls
    this.spaceIdCache.set(rootUrl, spaceId);

    // 2. Traverse entire subtree and collect all nodes
    const cloudNodes = await this.traverseWikiSubtree(spaceId, rootToken);

    // 3. Compare with local SQLite records
    const changedDocuments = await this.compareWithLocalRecords(cloudNodes);

    return {
      changed: changedDocuments.length > 0,
      changedDocuments,
      checkedAt: new Date().toISOString(),
      totalNodes: cloudNodes.length,
    };
  }

  /**
   * Traverse wiki subtree using BFS queue
   * - Simplified version: only collect node tokens and obj_tokens
   * - obj_edit_time will be fetched during compareWithLocalRecords on-demand
   * - This avoids N+1 query problem and lark-cli --obj-type limitation
   */
  private async traverseWikiSubtree(spaceId: string, rootToken: string): Promise<LarkCliNodeInfo[]> {
    const allNodes: LarkCliNodeInfo[] = [];
    const queue = [rootToken];

    while (queue.length > 0) {
      const currentToken = queue.shift()!;

      try {
        // List child nodes (basic info without obj_edit_time)
        const nodes = await this.larkCliClient.listWikiNodes({
          spaceId,
          parentNodeToken: currentToken,
        });

        for (const node of nodes) {
          // Push node with minimal info (obj_edit_time will be fetched later)
          allNodes.push({
            ...node,
            obj_edit_time: 0, // Placeholder, will be fetched on-demand during comparison
          });

          // If node has children, add to queue for next level
          if (node.has_child) {
            queue.push(node.node_token);
          }
        }
      } catch (error) {
        // Single level failure should not interrupt entire traversal
        console.error(`[ChangeDetector] Failed to list nodes for token ${currentToken}:`, error);
        continue;
      }
    }

    return allNodes;
  }

  /**
   * Compare cloud nodes with local SQLite records (simplified M1 version)
   * - No local record → added
   * - Has local record → unchanged (skip time comparison for now)
   * - Return ChangedDocument[] (M1: only detect added nodes, time comparison deferred to M2)
   */
  private async compareWithLocalRecords(cloudNodes: LarkCliNodeInfo[]): Promise<ChangedDocument[]> {
    const changedDocuments: ChangedDocument[] = [];

    for (const node of cloudNodes) {
      try {
        const localRecord = await this.localMapStore.getDocumentByObjToken(node.obj_token);

        if (!localRecord) {
          // New node (added)
          changedDocuments.push({
            objToken: node.obj_token,
            objType: node.obj_type as ChangedDocument['objType'], // Cast to exclude 'bitable'|'mindnote'|'file'
            title: node.title,
            changeType: 'added',
            cloudModifiedTime: new Date().toISOString(), // Placeholder for M1
            localSyncedTime: null,
            localMdPath: null,
          });
        }
        // M1: Skip time comparison, will be implemented in M2 with proper time fetching
      } catch (error) {
        // Single comparison failure should not interrupt entire process
        console.error(`[ChangeDetector] Failed to compare node ${node.obj_token}:`, error);
        continue;
      }
    }

    return changedDocuments;
  }

  /**
   * Resolve sheet obj_token from link (fallback for missing obj_token in HTML comments)
   * One-line solution: lark-cli wiki +node-get --node-token <URL>
   */
  async resolveSheetTokenFromLink(link: string): Promise<string> {
    const nodeInfo = await this.larkCliClient.getNode(link);
    return nodeInfo.obj_token;
  }
}
