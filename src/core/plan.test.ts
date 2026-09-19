import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { MAX_PLAN_ITEMS, parsePlanItems } from './parse';
import { Rng } from './rng';
import type { BatchPair, NormalizedTopology, PlanReviewResult } from './types';

/**
 * 生成随机连通无向多重图：先生成一棵随机生成树保证连通，
 * 再追加随机边（允许平行链路、允许重复同一对）。
 */
function randomConnectedGraph(rng: Rng, n: number, extraEdges: number): NormalizedTopology {
  const sites: string[] = [];
  for (let i = 0; i < n; i++) sites[i] = `S-${(1000 + i).toString(16)}`;
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [sites[i], sites[j]] = [sites[j], sites[i]];
  }

  const raw: { id: string; u: string; v: string }[] = [];
  const usedIds = new Set<string>();
  let seq = 0;
  const newId = () => {
    let id: string;
    do {
      id = `e${(rng.int(9000) + 100).toString(36)}-${seq++}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  const order = sites.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 1; i < n; i++) {
    raw.push({ id: newId(), u: order[i], v: order[rng.int(i)] });
  }
  for (let k = 0; k < extraEdges; k++) {
    const u = sites[rng.int(n)];
    let v = sites[rng.int(n)];
    while (v === u) v = sites[rng.int(n)];
    raw.push({ id: newId(), u, v });
  }
  return { sites, links: raw };
}

interface OracleStep {
  index: number;
  firstCovered: string[];
  marginal: number;
  cumulative: number;
  remaining: number;
}

/**
 * 预言机：按顺序合并单次试接结果——每步的“首次消除”即 trial(a,b).removed
 * 中尚未被此前任何步骤覆盖的桥；trial 的 removed 已按 UTF-8 字节序，
 * 过滤保持该顺序。
 */
function oraclePlan(analyzer: Analyzer, pairs: BatchPair[]): { steps: OracleStep[]; covered: Set<string> } {
  const covered = new Set<string>();
  const baselineCount = analyzer.baseline.bridges.length;
  let cumulative = 0;
  const steps = pairs.map((p, index) => {
    const removed = analyzer.trial(p.a, p.b).removed.map((b) => b.id);
    const firstCovered = removed.filter((id) => !covered.has(id));
    for (const id of firstCovered) covered.add(id);
    cumulative += firstCovered.length;
    return { index, firstCovered, marginal: firstCovered.length, cumulative, remaining: baselineCount - cumulative };
  });
  return { steps, covered };
}

/** 逐项核对计划复核结果与预言机，并校验互斥性、并集与 UTF-8 字节序 */
function expectPlanMatches(actual: PlanReviewResult, oracle: { steps: OracleStep[]; covered: Set<string> }): void {
  expect(actual.steps).toHaveLength(oracle.steps.length);
  const union = new Set<string>();
  for (let i = 0; i < oracle.steps.length; i++) {
    const s = actual.steps[i];
    const e = oracle.steps[i];
    expect(s.index).toBe(i);
    // 清单内容与顺序（UTF-8 字节序）都与预言机一致
    expect(s.firstCovered.map((b) => b.id)).toEqual(e.firstCovered);
    expect(s.marginal).toBe(e.marginal);
    expect(s.cumulative).toBe(e.cumulative);
    expect(s.remaining).toBe(e.remaining);
    // 清单严格按链路编号 UTF-8 字节序
    const ids = s.firstCovered.map((b) => b.id);
    expect(ids).toEqual([...ids].sort());
    // 各步清单互斥：同一桥只归最早覆盖步骤
    for (const id of ids) {
      expect(union.has(id)).toBe(false);
      union.add(id);
    }
  }
  // 并集等于计划覆盖的基线桥
  expect(union).toEqual(oracle.covered);
  expect(actual.coveredCount).toBe(oracle.covered.size);
  expect(actual.coveredCount).toBe(oracle.steps.length === 0 ? 0 : oracle.steps[oracle.steps.length - 1].cumulative);
}

describe('parsePlanItems 输入契约', () => {
  it('接受单端点对与数字编号（按单次试接规则规范化）', () => {
    expect(parsePlanItems('[{"a": 1, "b": 2}]')).toEqual([{ a: '1', b: '2' }]);
    expect(parsePlanItems('[{"a": "  s1 ", "b": "s2"}]')).toEqual([{ a: 's1', b: 's2' }]);
  });

  it('拒绝非数组与空计划', () => {
    expect(() => parsePlanItems('{"a":"x","b":"y"}')).toThrow(/必须是一个 JSON 数组/);
    expect(() => parsePlanItems('[]')).toThrow(/空数组/);
    expect(() => parsePlanItems('{坏的')).toThrow(/JSON 语法错误/);
  });

  it('拒绝超过上限（整体拒绝）', () => {
    const big = JSON.stringify(Array.from({ length: MAX_PLAN_ITEMS + 1 }, () => ({ a: 'x', b: 'y' })));
    expect(() => parsePlanItems(big)).toThrow(/超过上限/);
  });

  it('拒绝非对象项、缺字段与额外字段，并按下标（0 起）报错', () => {
    expect(() => parsePlanItems('[{"a":"x","b":"y"},["a","b"]]')).toThrow(/下标 1/);
    expect(() => parsePlanItems('[{"a":"x","b":"y"},{"a":"z"}]')).toThrow(/下标 1.*缺少字段 "b"/);
    expect(() => parsePlanItems('[{"b":"y"},{"a":"x","b":"y"}]')).toThrow(/下标 0.*缺少字段 "a"/);
    expect(() => parsePlanItems('[{"a":"x","b":"y","c":1}]')).toThrow(/下标 0.*额外字段/);
    expect(() => parsePlanItems('[{"a":"x","b":"y"},{"a":"p","b":"q","note":"备用"}]')).toThrow(/下标 1.*额外字段/);
  });

  it('拒绝非法端点类型并按下标报错', () => {
    expect(() => parsePlanItems('[{"a":"","b":"y"}]')).toThrow(/下标 0.*为空/);
    expect(() => parsePlanItems('[{"a":true,"b":"y"}]')).toThrow(/下标 0/);
    expect(() => parsePlanItems('[{"a":"x","b":null}]')).toThrow(/下标 0/);
    expect(() => parsePlanItems('[{"a":"x","b":"y"},{"a":["z"],"b":"w"}]')).toThrow(/下标 1/);
  });
});

describe('Analyzer.reviewPlan 顺序归属', () => {
  const chain = (n: number): NormalizedTopology => ({
    sites: Array.from({ length: n }, (_, i) => `v${i}`),
    links: Array.from({ length: n - 1 }, (_, i) => ({ id: `c${i}`, u: `v${i}`, v: `v${i + 1}` })),
  });

  it('交叠路径按最早覆盖步骤归属，边际/累计/剩余逐步推进', () => {
    const analyzer = new Analyzer(chain(10)); // 9 座桥 c0..c8
    const result = analyzer.reviewPlan([
      { a: 'v0', b: 'v4' },
      { a: 'v2', b: 'v7' },
      { a: 'v6', b: 'v9' },
      { a: 'v0', b: 'v9' },
    ]);
    expect(result.baselineCount).toBe(9);
    expect(result.steps.map((s) => s.firstCovered.map((b) => b.id))).toEqual([
      ['c0', 'c1', 'c2', 'c3'],
      ['c4', 'c5', 'c6'],
      ['c7', 'c8'],
      [],
    ]);
    expect(result.steps.map((s) => s.marginal)).toEqual([4, 3, 2, 0]);
    expect(result.steps.map((s) => s.cumulative)).toEqual([4, 7, 9, 9]);
    expect(result.steps.map((s) => s.remaining)).toEqual([5, 2, 0, 0]);
    expect(result.coveredCount).toBe(9);
  });

  it('重复、反向、被包含路径的后续步骤均为零', () => {
    const analyzer = new Analyzer(chain(10));
    const result = analyzer.reviewPlan([
      { a: 'v0', b: 'v9' },
      { a: 'v0', b: 'v9' }, // 重复
      { a: 'v9', b: 'v0' }, // 反向
      { a: 'v2', b: 'v5' }, // 被包含
      { a: 'v3', b: 'v4' }, // 被包含的单边
    ]);
    expect(result.steps.map((s) => s.marginal)).toEqual([9, 0, 0, 0, 0]);
    expect(result.steps.map((s) => s.cumulative)).toEqual([9, 9, 9, 9, 9]);
    expect(result.steps.map((s) => s.remaining)).toEqual([0, 0, 0, 0, 0]);
    expect(result.steps[0].firstCovered).toHaveLength(9);
    for (let i = 1; i < 5; i++) expect(result.steps[i].firstCovered).toHaveLength(0);
  });

  it('反向路径先走时归属不变（顺序敏感，方向不敏感）', () => {
    const analyzer = new Analyzer(chain(6));
    const fwd = analyzer.reviewPlan([
      { a: 'v0', b: 'v3' },
      { a: 'v3', b: 'v5' },
    ]);
    const rev = analyzer.reviewPlan([
      { a: 'v3', b: 'v0' },
      { a: 'v5', b: 'v3' },
    ]);
    expect(rev.steps.map((s) => s.firstCovered.map((b) => b.id))).toEqual(
      fwd.steps.map((s) => s.firstCovered.map((b) => b.id)),
    );
  });

  it('空计划与超限整体拒绝', () => {
    const analyzer = new Analyzer(chain(5));
    expect(() => analyzer.reviewPlan([])).toThrow(/不能为空/);
    const big: BatchPair[] = Array.from({ length: MAX_PLAN_ITEMS + 1 }, () => ({ a: 'v0', b: 'v1' }));
    expect(() => analyzer.reviewPlan(big)).toThrow(/超过上限/);
  });

  it('端点不存在或相同均按下标整批拒绝，且无部分结果', () => {
    const analyzer = new Analyzer(chain(6));
    expect(() =>
      analyzer.reviewPlan([
        { a: 'v0', b: 'v5' },
        { a: 'v1', b: 'ghost' },
      ]),
    ).toThrow(/下标 1.*不在当前站点清单/);
    expect(() => analyzer.reviewPlan([{ a: 'v2', b: 'v2' }])).toThrow(/下标 0.*必须不同/);
    // 分析器未被污染：随后合法计划仍正常
    const ok = analyzer.reviewPlan([{ a: 'v0', b: 'v5' }]);
    expect(ok.steps[0].marginal).toBe(5);
  });

  it('计划复核不改写基线、单次试接与批量筛选结果', () => {
    const analyzer = new Analyzer(chain(8));
    const baselineBefore = JSON.stringify(analyzer.baseline);
    const trialBefore = analyzer.trial('v0', 'v7');
    const batchBefore = analyzer.screenBatch([
      { a: 'v0', b: 'v7' },
      { a: 'v2', b: 'v5' },
    ]);
    analyzer.reviewPlan([
      { a: 'v0', b: 'v7' },
      { a: 'v2', b: 'v5' },
    ]);
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
    const trialAfter = analyzer.trial('v0', 'v7');
    expect(trialAfter.removed.map((x) => x.id)).toEqual(trialBefore.removed.map((x) => x.id));
    const batchAfter = analyzer.screenBatch([
      { a: 'v0', b: 'v7' },
      { a: 'v2', b: 'v5' },
    ]);
    expect(batchAfter.items.map((x) => x.removedCount)).toEqual(batchBefore.items.map((x) => x.removedCount));
  });
});

describe('计划复核 vs 顺序合并单次试接预言机（随机连通多重小图）', () => {
  it('每步首次归属清单与边际/累计/剩余均与预言机一致', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = new Rng(0x1f123ff5 ^ (seed * 2246822519));
      const n = 2 + rng.int(9); // 2–10 个站点
      const g = randomConnectedGraph(rng, n, rng.int(n * 3));
      const analyzer = new Analyzer(g);

      // 随机一份有序计划（注入重复、反向与交叠候选）
      const pairs: BatchPair[] = [];
      const q = 1 + rng.int(12);
      for (let k = 0; k < q; k++) {
        const a = g.sites[rng.int(n)];
        let b = g.sites[rng.int(n)];
        while (b === a) b = g.sites[rng.int(n)];
        pairs.push({ a, b });
        const r = rng.int(4);
        if (r === 0) pairs.push({ a, b }); // 重复
        else if (r === 1) pairs.push({ a: b, b: a }); // 反向
      }

      const result = analyzer.reviewPlan(pairs);
      expect(result.baselineCount).toBe(analyzer.baseline.bridges.length);
      expectPlanMatches(result, oraclePlan(analyzer, pairs));
    }
  });

  it('末项非法时整批拒绝：无部分结果且基线不变', () => {
    const rng = new Rng(0x9e3779b9);
    const g = randomConnectedGraph(rng, 8, 6);
    const analyzer = new Analyzer(g);
    const baselineBefore = JSON.stringify(analyzer.baseline);

    const pairs: BatchPair[] = [];
    for (let k = 0; k < 5; k++) {
      pairs.push({ a: g.sites[k % g.sites.length], b: g.sites[(k + 3) % g.sites.length] });
    }
    pairs.push({ a: g.sites[0], b: '不存在的站点' }); // 末项非法

    expect(() => analyzer.reviewPlan(pairs)).toThrow(/下标 5/);
    // 无任何部分结果返回（异常即整批拒绝），基线保持不动
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
    // 合法计划随后仍可整体提交
    const ok = analyzer.reviewPlan(pairs.slice(0, 5));
    expect(ok.steps).toHaveLength(5);
    expectPlanMatches(ok, oraclePlan(analyzer, pairs.slice(0, 5)));
  });

  it('较深随机图上计划归属与预言机一致（锤炼并查集跳转）', () => {
    // 300 站点随机连通多重图 + 600 步计划，覆盖更深的 DFS 树与大量交叠
    const rng = new Rng(0xc0ffee);
    const g = randomConnectedGraph(rng, 300, 450);
    const analyzer = new Analyzer(g);
    const pairs: BatchPair[] = [];
    for (let k = 0; k < 600; k++) {
      const a = g.sites[rng.int(g.sites.length)];
      let b = g.sites[rng.int(g.sites.length)];
      while (b === a) b = g.sites[rng.int(g.sites.length)];
      pairs.push({ a, b });
    }
    expectPlanMatches(analyzer.reviewPlan(pairs), oraclePlan(analyzer, pairs));
  });
});

describe('20 万站点长链：首步全覆盖后子路径均为零', () => {
  it(
    '首步边际 = 全部桥，后续 99999 步边际均为零，清单互斥且并集为全部桥',
    { timeout: 30_000 },
    () => {
      const n = 200_000;
      const sites = new Array<string>(n);
      for (let i = 0; i < n; i++) sites[i] = `site-${i}`;
      const links = Array.from({ length: n - 1 }, (_, i) => ({
        id: `c-${i}`,
        u: sites[i],
        v: sites[i + 1],
      }));
      const analyzer = new Analyzer({ sites, links });
      expect(analyzer.baseline.bridges).toHaveLength(n - 1);

      // 计划：首步全覆盖，再跟 99999 条确定性伪随机子路径
      const pairs: BatchPair[] = [{ a: sites[0], b: sites[n - 1] }];
      let state = 0x9e3779b9;
      const rand = (): number => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state / 4294967296;
      };
      for (let i = 1; i < 100_000; i++) {
        const a = Math.floor(rand() * (n - 1));
        const b = a + 1 + Math.floor(rand() * (n - 1 - a));
        pairs.push({ a: sites[a], b: sites[b] });
      }

      const result = analyzer.reviewPlan(pairs);
      expect(result.steps).toHaveLength(100_000);
      expect(result.baselineCount).toBe(n - 1);
      expect(result.coveredCount).toBe(n - 1);

      // 首步：首次消除全部 n-1 座桥，清单按 UTF-8 字节序
      const first = result.steps[0];
      expect(first.marginal).toBe(n - 1);
      expect(first.cumulative).toBe(n - 1);
      expect(first.remaining).toBe(0);
      expect(first.firstCovered).toHaveLength(n - 1);
      const ids = first.firstCovered.map((b) => b.id);
      expect(ids).toEqual([...ids].sort());
      expect(new Set(ids).size).toBe(n - 1);

      // 后续子路径全部为零收益，累计与剩余保持不变（聚合断言，避免十万次单步断言开销）
      const rest = result.steps.slice(1);
      expect(rest.every((s, k) => s.index === k + 1)).toBe(true);
      expect(rest.every((s) => s.marginal === 0 && s.firstCovered.length === 0)).toBe(true);
      expect(rest.every((s) => s.cumulative === n - 1 && s.remaining === 0)).toBe(true);
    },
  );
});
