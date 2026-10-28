/**
 * PathClaims 单测（S4 §4.3：构建内路径认领）
 *
 * 首写者认领、同单元幂等、他单元拒绝（返回 owner）、预认领、ownedBy。
 */

import { describe, expect, it } from 'vitest';
import { PathClaims } from '../src/kb/path-claims.js';

describe('PathClaims', () => {
  it('首写者认领；同单元重复幂等成功；他单元拒绝并返回 owner', () => {
    const claims = new PathClaims();
    expect(claims.claim('战斗/结算.md', 'u1')).toEqual({ ok: true });
    expect(claims.claim('战斗/结算.md', 'u1')).toEqual({ ok: true }); // 幂等
    expect(claims.claim('战斗/结算.md', 'u2')).toEqual({ ok: false, owner: 'u1' });
  });

  it('构造器预认领（planUnits 的 ownedDocs）；ownedBy 只列本单元路径', () => {
    const claims = new PathClaims([
      { path: 'a.md', unitId: 'u1' },
      { path: 'b/c.md', unitId: 'u2' },
    ]);
    expect(claims.claim('a.md', 'u2')).toEqual({ ok: false, owner: 'u1' });
    expect(claims.claim('b/c.md', 'u1')).toEqual({ ok: false, owner: 'u2' });
    expect(claims.ownedBy('u1')).toEqual(['a.md']);
    expect(claims.ownedBy('u2')).toEqual(['b/c.md']);
    expect(claims.ownedBy('u3')).toEqual([]);
    expect(claims.ownerOf('不存在.md')).toBeNull();
    expect(claims.size).toBe(2);
  });

  it('单元重试不释放：认领一经成立不可撤销', () => {
    const claims = new PathClaims();
    claims.claim('x.md', 'u1');
    // （无 release API——设计 §4.3「单元重试不释放」；唯一去账途径是构建结束）
    expect(claims.claim('x.md', 'u9')).toEqual({ ok: false, owner: 'u1' });
  });
});
