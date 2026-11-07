/**
 * CLI 拼写建议（命令/旗标「你是不是想输入」）
 *
 * 未知命令与未知旗标按编辑距离 + 前缀匹配给出最多 3 条候选，按命令全名
 * （空格分层形式）比较；无足够相近的候选时不建议——宁缺毋滥，避免把
 * 真正的用法错误淹没在噪音提示里。本模块是纯函数，不依赖命令表（候选
 * 清单由调用方传入，避免与 args.ts 循环依赖）。
 */

/** 建议上限（任务约定：最多 3 条）。 */
const MAX_SUGGESTIONS = 3;
/** 编辑距离门槛：≤2 视为相近；更长的笔误靠前缀规则兜底。 */
const MAX_EDIT_DISTANCE = 2;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = current;
  }
  return prev[b.length];
}

/** 相近判定：前缀命中（输入 ≥2 字符）或编辑距离 ≤2。 */
function isClose(input: string, candidate: string): boolean {
  if (input.length >= 2 && candidate.startsWith(input)) return true;
  return levenshtein(input, candidate) <= MAX_EDIT_DISTANCE;
}

/**
 * 从候选清单中挑出与 input 相近的项（≤3 条）：
 * 前缀命中优先，其次按编辑距离升序，同距按字典序稳定排序。
 * 输入与候选均做小写比较（命令面本身全小写，容错用户大写习惯）。
 */
export function suggestClosest(input: string, candidates: readonly string[]): string[] {
  const normalized = input.toLowerCase();
  if (normalized.length === 0) return [];
  const scored: Array<{ candidate: string; dist: number }> = [];
  for (const candidate of candidates) {
    const comparable = candidate.toLowerCase();
    if (!isClose(normalized, comparable)) continue;
    // 前缀命中视为距离 0，排最前；其余用真实距离。
    const dist = comparable.startsWith(normalized) && normalized.length >= 2
      ? 0
      : levenshtein(normalized, comparable);
    scored.push({ candidate, dist });
  }
  scored.sort((x, y) => x.dist - y.dist || (x.candidate < y.candidate ? -1 : 1));
  return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.candidate);
}
