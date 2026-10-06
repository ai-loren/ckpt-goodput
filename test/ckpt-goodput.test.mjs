import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const context = { window: {} };
runInNewContext(await readFile(new URL('../ckpt-goodput.js', import.meta.url), 'utf8'), context, { filename: 'ckpt-goodput.js' });
const tool = context.window.SITE_TOOLS['ckpt-goodput'];
const baseline = { gpus: 1024, mtbfHours: 35000, intervalMinutes: 120, saveSeconds: 540, restartMinutes: 55 };
const config = (patch) => ({ ...baseline, ...patch });
const GAIN_30_TO_186 = 0.1433791548606398;
const close = (actual, expected, tolerance, message) => assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ± ${tolerance}, got ${actual}`);

test('the four shares follow the exact Poisson model and add up to one', () => {
  const M = 35000 / 1024;
  const parts = tool.breakdown(2, 0.15, 55 / 60, M);
  close(parts.goodput, 0.8774318436370828, 1e-12, 'goodput');
  close(parts.save, 0.06580738827278122, 1e-12, 'save');
  close(parts.rework, 0.030298157585370133, 1e-12, 'rework');
  close(parts.restart, 0.026462610504765893, 1e-12, 'restart');
  close(parts.goodput + parts.save + parts.rework + parts.restart, 1, 1e-12, 'sum');
});

test('with failures far apart the shares reduce to the first-order model', () => {
  const parts = tool.breakdown(1, 0.01, 0.1, 1e9);
  close(parts.save / (0.01 / 1), 1, 0.015, 'save ≈ δ/τ');
  close(parts.rework / (1.01 / 2e9), 1, 1e-3, 'rework ≈ (τ+δ)/2M');
  close(parts.restart / (0.1 / 1e9), 1, 1e-6, 'restart ≈ R/M');
});

test('the optimal interval solves Daly Eq. 21, matches his Eq. 37 and beats every other interval', () => {
  const M = 35000 / 1024;
  const best = tool.optimalInterval(0.15, M);
  close(best, 3.102962642490767, 1e-9, 'exact root');
  close((1 - best / M) * Math.exp((best + 0.15) / M), 1, 1e-12, 'Eq. 21 residual');
  close(best, 3.102952834420734, 1e-4, 'Daly Eq. 37 approximation');
  assert(best < Math.sqrt(2 * 0.15 * M), 'the exact optimum sits below Young’s first-order estimate');
  const goodputAt = (tau) => tool.breakdown(tau, 0.15, 55 / 60, M).goodput;
  for (const factor of [0.2, 0.5, 0.9, 0.99, 1.01, 1.1, 2, 5]) {
    assert(goodputAt(best) > goodputAt(best * factor), `the optimum beats ${factor} × optimum`);
  }
  assert.equal(tool.optimalInterval(0.15, M), tool.estimate(baseline).optimal);
});

test('restart time lowers goodput but does not move the optimum', () => {
  const a = tool.estimate(config({ restartMinutes: 0 }));
  const b = tool.estimate(config({ restartMinutes: 120 }));
  assert.equal(a.optimal, b.optimal);
  assert(b.current.goodput < a.current.goodput);
});

test('the default configuration reads like the card on the works page', () => {
  const result = tool.estimate(baseline);
  assert.equal((result.current.goodput * 100).toFixed(1), '87.7');
  assert.equal((result.best.goodput * 100).toFixed(1), '88.5');
  close(result.clusterMtbf, 34.1796875, 1e-12, 'cluster MTBF in hours');
  close(result.failuresPerDay, 24 / 34.1796875, 1e-12, 'failures per day');
  close(result.lostGpuHoursPerDay, 3012.2350107750526, 1e-6, 'GPU-hours lost per day');
  assert.equal(tool.duration(result.optimal), '3 小时 6 分');
  const defaults = tool.DEFAULTS;
  assert.deepEqual([defaults.gpus, defaults.mtbfHours, defaults.intervalMinutes, defaults.saveSeconds, defaults.restartMinutes], ['1024', '35000', '120', '540', '55']);
});

test('more GPUs mean proportionally more frequent interruptions', () => {
  const small = tool.estimate(config({ gpus: 1024 }));
  const large = tool.estimate(config({ gpus: 4096 }));
  close(large.clusterMtbf * 4, small.clusterMtbf, 1e-12, 'cluster MTBF scales with 1/N');
  assert(large.current.goodput < small.current.goodput);
  assert(large.optimal < small.optimal, 'more frequent failures call for more frequent checkpoints');
});

test('durations read naturally in Chinese', () => {
  assert.equal(tool.duration(30 / 3600), '30 秒');
  assert.equal(tool.duration(7.5 / 60), '7.5 分钟');
  assert.equal(tool.duration(45 / 60), '45 分钟');
  assert.equal(tool.duration(2), '2 小时');
  assert.equal(tool.duration(34.1796875), '34 小时 11 分');
  assert.equal(tool.duration(59.995 / 60 + 1), '2 小时');
  assert.equal(tool.duration(72), '3 天');
});

test('impossible inputs say what was expected and what to fill in', () => {
  const error = (patch) => tool.estimate(config(patch)).error;
  assert.match(error({ gpus: 0 }), /卡数需要是正整数.*0.*参与训练的 GPU 数/);
  assert.match(error({ gpus: 1.5 }), /卡数需要是正整数/);
  assert.match(error({ mtbfHours: 0 }), /单卡平均故障间隔需要大于 0/);
  assert.match(error({ intervalMinutes: 0 }), /保存间隔需要大于 0/);
  assert.match(error({ saveSeconds: 0 }), /每次保存停顿需要大于 0.*异步保存/);
  assert.match(error({ restartMinutes: -1 }), /发现 \+ 恢复耗时不能是负数.*没有就填 0/);
  assert.equal(error({ restartMinutes: 0 }), undefined);
});

test('suggestions are real improvements, sorted by gain, and skip levers that cannot help', () => {
  const tips = tool.suggestions(baseline);
  assert(tips.length === 3, `expected interval, save and restart tips for the baseline, got ${tips.map((tip) => tip.label).join(' / ')}`);
  for (let index = 1; index < tips.length; index += 1) assert(tips[index - 1].gain >= tips[index].gain, 'sorted by gain');
  for (const tip of tips) {
    const after = tool.estimate(config(tip.change));
    assert.equal(tip.goodput, after.current.goodput, `${tip.label} reports the goodput it leads to`);
    assert(tip.gain > 0, `${tip.label} improves goodput`);
  }
  const atOptimum = tool.suggestions(config({ intervalMinutes: 186, restartMinutes: 0 }));
  assert(!atOptimum.some((tip) => 'restartMinutes' in tip.change), 'no restart tip when restart already takes no time');
  assert(!atOptimum.some((tip) => Object.keys(tip.change).join() === 'intervalMinutes'), 'no interval tip when switching to the optimum gains less than 0.05 points');
  const tinyPause = tool.suggestions(config({ saveSeconds: 0.04 }));
  assert(!tinyPause.some((tip) => 'saveSeconds' in tip.change), 'a pause that would round to 0 seconds is not offered as a tip');
  const nearOptimum = tool.suggestions(config({ intervalMinutes: 170 }));
  assert(!nearOptimum.some((tip) => Object.keys(tip.change).join() === 'intervalMinutes'), 'a flat optimum is not worth a tip');
  const farOff = tool.suggestions(config({ intervalMinutes: 30 })).find((tip) => Object.keys(tip.change).join() === 'intervalMinutes');
  assert(farOff, 'saving every 30 minutes with a 9-minute pause gets an interval tip');
  assert.equal(farOff.change.intervalMinutes, 186);
  close(farOff.gain, GAIN_30_TO_186, 1e-12, 'gain of moving from 30 to 186 minutes');
});
