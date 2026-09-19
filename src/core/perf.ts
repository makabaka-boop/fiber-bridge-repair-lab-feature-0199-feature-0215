/**
 * 上限性能基准：200000 站点 / 400000 链路。
 * 用法：npx tsx src/core/perf.ts（或 node --import tsx）。
 * 断言总耗时 < 5000ms，且整个分析为显式栈迭代、不触发递归深度问题。
 *
 * 第二段：200000 站点纯长链 + 100000 组批量方案查询，断言分析器构建
 * （含只读 LCA 索引）与整批查询合计 < 5000ms，且每项计数等于站点距离。
 *
 * 第三段：200000 站点纯长链的有序备纤计划——首步全覆盖、再跟 99999 条
 * 子路径，断言仅首步有收益（边际 = n−1）、后续均为零，且分析器构建与
 * 整批复核合计 < 5000ms。
 */
import { parseTopology } from './parse';
import { Analyzer } from './analysis';
import type { BatchPair, NormalizedTopology } from './types';

function buildUpperBoundTopology(): string {
  const n = 200_000;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;

  // 生成树（长链，制造最深的“递归”场景）n-1 条，再补平行/回边到 400k
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `tree-${i}`, u: sites[i - 1], v: sites[i] });
  }
  let extra = 0;
  while (links.length < 400_000) {
    // 随机回边，跨度足够大时会成大环；也插入部分平行边
    const i = Math.floor(Math.random() * n);
    let j = Math.floor(Math.random() * n);
    if (j === i) j = (j + 1) % n;
    links.push({ id: `x-${extra++}`, u: sites[i], v: sites[j] });
  }
  return JSON.stringify({ sites, links });
}

function normalize(t: NormalizedTopology): NormalizedTopology {
  return t;
}

const ms = (a: number, b: number) => (b - a).toFixed(1);

function main(): void {
  const t0 = performance.now();
  const text = buildUpperBoundTopology();
  const t1 = performance.now();
  const parsed = normalize(parseTopology(text));
  const t2 = performance.now();
  const analyzer = new Analyzer(parsed);
  const t3 = performance.now();
  // 再做一次最坏路径试接（两端在链上相距最远）
  const trial = analyzer.trial(parsed.sites[0], parsed.sites[parsed.sites.length - 1]);
  const t4 = performance.now();

  console.log(`构造输入: ${ms(t0, t1)} ms`);
  console.log(`解析校验: ${ms(t1, t2)} ms`);
  console.log(`基线Tarjan(含LCA索引): ${ms(t2, t3)} ms`);
  console.log(`试接: ${ms(t3, t4)} ms`);
  console.log(`解析+基线+试接合计: ${ms(t1, t4)} ms`);
  console.log(`站点=${analyzer.baseline.siteCount} 链路=${analyzer.baseline.linkCount}`);
  console.log(`基线桥=${analyzer.baseline.bridges.length} 试接后仍脆弱=${trial.stillFragile.length} 已消除=${trial.removed.length}`);

  const budget = 5000;
  if (t4 - t1 > budget) {
    console.error(`超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：在上限 ${budget}ms 预算内完成`);

  benchBatch();
  benchPlan();
}

/** 批量方案筛选基准：200000 站点纯长链 + 100000 组查询，计数应等于距离 */
function benchBatch(): void {
  const n = 200_000;
  const q = 100_000;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `c-${i}`, u: sites[i - 1], v: sites[i] });
  }

  const b0 = performance.now();
  const chainAnalyzer = new Analyzer(normalize(parseTopology(JSON.stringify({ sites, links }))));
  const b1 = performance.now();

  // 确定性伪随机端点对（线性同余），避免测试间抖动
  let state = 0x9e3779b9;
  const rand = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const pairs: BatchPair[] = new Array(q);
  for (let i = 0; i < q; i++) {
    const a = Math.floor(rand() * n);
    let b = Math.floor(rand() * n);
    if (b === a) b = (b + 1) % n;
    pairs[i] = { a: sites[a], b: sites[b] };
  }

  const b2 = performance.now();
  const result = chainAnalyzer.screenBatch(pairs);
  const b3 = performance.now();

  // 长链上每条边都是桥：可消除数量必须等于两端点的站点距离
  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOf.set(sites[i], i);
  for (let i = 0; i < q; i++) {
    const it = result.items[i];
    const dist = Math.abs(indexOf.get(it.a)! - indexOf.get(it.b)!);
    if (it.removedCount !== dist || it.index !== i) {
      console.error(`下标 ${i} 计数错误：期望距离 ${dist}，实际 ${it.removedCount}`);
      process.exit(1);
    }
  }

  console.log(`—— 批量方案筛选（200000 站点长链 / ${q} 组查询）——`);
  console.log(`解析+分析器构建(含LCA索引): ${ms(b0, b1)} ms`);
  console.log(`生成查询: ${ms(b1, b2)} ms`);
  console.log(`整批查询: ${ms(b2, b3)} ms`);
  console.log(`分析器构建+整批查询合计: ${ms(b0, b3)} ms`);

  const budget = 5000;
  if (b3 - b0 > budget) {
    console.error(`批量筛选超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：批量筛选在上限 ${budget}ms 预算内完成，${q} 项计数全部等于距离`);
}

/**
 * 有序备纤计划基准：200000 站点纯长链，首步 (site-0, site-199999) 全覆盖，
 * 再跟 99999 条子路径。断言仅首步有收益（边际 = 199999）、后续步骤边际
 * 均为零、各步清单互斥且并集为全部桥；构建 + 整批复核合计 < 5000ms。
 */
function benchPlan(): void {
  const n = 200_000;
  const q = 100_000;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `c-${i}`, u: sites[i - 1], v: sites[i] });
  }

  const p0 = performance.now();
  const chainAnalyzer = new Analyzer(normalize(parseTopology(JSON.stringify({ sites, links }))));
  const p1 = performance.now();

  // 首步全覆盖 + 99999 条确定性伪随机子路径（线性同余，避免测试间抖动）
  let state = 0x9e3779b9;
  const rand = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const pairs: BatchPair[] = new Array(q);
  pairs[0] = { a: sites[0], b: sites[n - 1] };
  for (let i = 1; i < q; i++) {
    const a = Math.floor(rand() * (n - 1));
    const b = a + 1 + Math.floor(rand() * (n - 1 - a));
    pairs[i] = { a: sites[a], b: sites[b] };
  }

  const p2 = performance.now();
  const result = chainAnalyzer.reviewPlan(pairs);
  const p3 = performance.now();

  // 仅首步有收益：边际 = n-1、累计 = n-1、剩余 = 0；后续步骤全为零
  const first = result.steps[0];
  if (result.steps.length !== q || first.marginal !== n - 1 || result.coveredCount !== n - 1) {
    console.error(`首步归属错误：边际 ${first.marginal}，覆盖总数 ${result.coveredCount}，期望 ${n - 1}`);
    process.exit(1);
  }
  let totalListed = first.firstCovered.length;
  for (let i = 1; i < q; i++) {
    const s = result.steps[i];
    if (s.marginal !== 0 || s.cumulative !== n - 1 || s.remaining !== 0) {
      console.error(`下标 ${i} 应为零收益：边际 ${s.marginal} 累计 ${s.cumulative} 剩余 ${s.remaining}`);
      process.exit(1);
    }
    totalListed += s.firstCovered.length;
  }
  // 各步清单互斥，并集恰为计划覆盖的全部基线桥
  if (totalListed !== n - 1 || first.remaining !== 0) {
    console.error(`清单并集大小 ${totalListed}，期望 ${n - 1}`);
    process.exit(1);
  }

  console.log(`—— 有序备纤计划（200000 站点长链 / 首步全覆盖 + ${q - 1} 条子路径）——`);
  console.log(`解析+分析器构建(含LCA索引): ${ms(p0, p1)} ms`);
  console.log(`生成计划: ${ms(p1, p2)} ms`);
  console.log(`整批复核: ${ms(p2, p3)} ms`);
  console.log(`分析器构建+整批复核合计: ${ms(p0, p3)} ms`);

  const budget = 5000;
  if (p3 - p0 > budget) {
    console.error(`有序备纤计划超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：有序备纤计划在上限 ${budget}ms 预算内完成，仅首步有收益、后续 ${q - 1} 步均为零`);
}

main();
