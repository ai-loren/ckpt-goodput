(() => {
  'use strict';

  const FIELDS = [
    ['gpus', '卡数', 10_000_000, true],
    ['mtbfHours', '单卡平均故障间隔（小时）', 1e9, false],
    ['intervalMinutes', '保存间隔（分钟）', 1e6, false],
    ['saveSeconds', '每次保存停顿（秒）', 1e6, false],
    ['restartMinutes', '发现 + 恢复耗时（分钟）', 1e6, false],
  ];
  const DEFAULTS = { gpus: '1024', mtbfHours: '35000', intervalMinutes: '120', saveSeconds: '540', restartMinutes: '55' };
  const PARTS = [['goodput', '有效训练'], ['save', '保存'], ['rework', '重算'], ['restart', '恢复']];

  // 故障按泊松到达、保存与恢复期间也可能中断时的精确拆分（Daly 2006 Eq. 20 的倒数，再按状态拆开）。
  // 四项加起来恰好是 1；τ、δ、R 都远小于 M 时依次退化为 1 − δ/τ − (τ+δ)/2M − R/M、δ/τ、(τ+δ)/2M、R/M。
  function breakdown(tau, delta, restart, M) {
    const x = (tau + delta) / M;
    const alive = Math.exp(-restart / M);
    const productive = alive * (x / Math.expm1(x));
    return {
      goodput: productive * (tau / (tau + delta)),
      save: productive * (delta / (tau + delta)),
      rework: alive - productive,
      restart: -Math.expm1(-restart / M),
    };
  }

  // Daly 2006 Eq. (21)：(1 − τ/M)·e^((τ+δ)/M) = 1 在 (0, M) 内恰有一个根，二分到区间宽度可以忽略为止。
  function optimalInterval(delta, M) {
    const f = (tau) => (1 - tau / M) * Math.exp((tau + delta) / M) - 1;
    let lo = 0;
    let hi = M;
    for (let step = 0; step < 200 && hi - lo > M * 1e-13; step += 1) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function validate(config) {
    const { gpus, mtbfHours, intervalMinutes, saveSeconds, restartMinutes } = config;
    if (!Number.isInteger(gpus) || gpus < 1) return `卡数需要是正整数，现在是 ${gpus}。填集群里参与训练的 GPU 数。`;
    if (!(mtbfHours > 0)) return `单卡平均故障间隔需要大于 0，现在是 ${mtbfHours}。填一张卡平均多少小时出一次会中断训练的故障。`;
    if (!(intervalMinutes > 0)) return `保存间隔需要大于 0，现在是 ${intervalMinutes}。填两次 checkpoint 之间训练多少分钟。`;
    if (!(saveSeconds > 0)) return `每次保存停顿需要大于 0，现在是 ${saveSeconds}。填一次 checkpoint 让训练停下多少秒；异步保存也填它真正阻塞的那一段。`;
    if (!(restartMinutes >= 0)) return `发现 + 恢复耗时不能是负数，现在是 ${restartMinutes}。填从出故障到训练重新跑起来要多少分钟，没有就填 0。`;
    return '';
  }

  function estimate(config) {
    const error = validate(config);
    if (error) return { error };
    const M = config.mtbfHours / config.gpus;
    const tau = config.intervalMinutes / 60;
    const delta = config.saveSeconds / 3600;
    const restart = config.restartMinutes / 60;
    const optimal = optimalInterval(delta, M);
    const current = breakdown(tau, delta, restart, M);
    return {
      clusterMtbf: M,
      failuresPerDay: 24 / M,
      optimal,
      current,
      best: breakdown(optimal, delta, restart, M),
      lostGpuHoursPerDay: config.gpus * 24 * (1 - current.goodput),
    };
  }

  const roundTo = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

  function suggestions(config) {
    const base = estimate(config);
    if (base.error) return [];
    const M = base.clusterMtbf;
    const candidates = [];
    const bestMinutes = Math.max(1, Math.round(base.optimal * 60));
    if (bestMinutes !== config.intervalMinutes) candidates.push([`按最优间隔保存：每 ${duration(bestMinutes / 60)}一次`, { intervalMinutes: bestMinutes }]);
    const halfSave = roundTo(config.saveSeconds / 2, 1);
    if (halfSave > 0) {
      const minutes = Math.max(1, Math.round(optimalInterval(halfSave / 3600, M) * 60));
      candidates.push([`保存停顿减半（${config.saveSeconds} → ${halfSave} 秒），间隔改为新的最优 ${duration(minutes / 60)}`, { saveSeconds: halfSave, intervalMinutes: minutes }]);
    }
    const halfRestart = roundTo(config.restartMinutes / 2, 1);
    candidates.push([`恢复耗时减半（${config.restartMinutes} → ${halfRestart} 分钟）`, { restartMinutes: halfRestart }]);
    return candidates
      .map(([label, change]) => {
        const result = estimate({ ...config, ...change });
        return { label, change, goodput: result.current.goodput, gain: result.current.goodput - base.current.goodput };
      })
      .filter((option) => option.gain >= 0.0005)
      .sort((a, b) => b.gain - a.gain)
      .slice(0, 3);
  }

  function duration(hours) {
    const minutes = hours * 60;
    if (minutes < 1) return `${Math.round(minutes * 60)} 秒`;
    if (minutes < 10) return `${roundTo(minutes, 1)} 分钟`;
    if (minutes < 60) return `${Math.round(minutes)} 分钟`;
    if (hours < 48) {
      const whole = Math.floor(minutes / 60);
      const rest = Math.round(minutes - whole * 60);
      return rest === 60 ? `${whole + 1} 小时` : rest ? `${whole} 小时 ${rest} 分` : `${whole} 小时`;
    }
    return `${roundTo(hours / 24, 1)} 天`;
  }

  const percent = (share) => `${(share * 100).toFixed(1)}%`;
  const grouped = (value) => Math.round(value).toLocaleString('en-US');

  const TICKS = [[1 / 60, '1 分'], [5 / 60, '5 分'], [15 / 60, '15 分'], [0.5, '30 分'], [1, '1 时'], [2, '2 时'], [4, '4 时'], [8, '8 时'], [24, '1 天'], [72, '3 天'], [168, '7 天']];

  function chart(config, result) {
    const M = result.clusterMtbf;
    const delta = config.saveSeconds / 3600;
    const restart = config.restartMinutes / 60;
    const tau = config.intervalMinutes / 60;
    const lo = Math.min(tau, result.optimal) / 6;
    const hi = Math.min(Math.max(tau, result.optimal) * 6, M * 4);
    const samples = Array.from({ length: 80 }, (_, index) => lo * (hi / lo) ** (index / 79));
    const values = samples.map((sample) => breakdown(sample, delta, restart, M).goodput);
    const span = Math.max(Math.max(...values) - Math.min(...values), 0.004);
    const step = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2].find((candidate) => span / candidate <= 4) || 0.25;
    const top = Math.min(1, Math.ceil((Math.max(...values) + step * 0.2) / step) * step);
    const bottom = Math.max(0, Math.floor((Math.min(...values) - step * 0.2) / step) * step);
    const [W, H, L, R, T, B] = [320, 176, 36, 10, 18, 24];
    const x = (hours) => L + ((Math.log(hours) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - L - R);
    const y = (share) => T + ((top - share) / (top - bottom || 1)) * (H - T - B);
    const path = samples.map((sample, index) => `${index ? 'L' : 'M'}${x(sample).toFixed(1)},${y(values[index]).toFixed(1)}`).join('');
    const yTicks = Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, index) => bottom + step * index);
    const xTicks = TICKS.filter(([hours]) => hours >= lo && hours <= hi);
    const marker = (hours, share, kind, label) => {
      const cx = x(hours).toFixed(1);
      const cy = y(share).toFixed(1);
      const anchor = Number(cx) > W - 40 ? 'end' : Number(cx) < L + 20 ? 'start' : 'middle';
      return `<line class="ckpt-guide is-${kind}" x1="${cx}" x2="${cx}" y1="${cy}" y2="${H - B}"></line><circle class="ckpt-dot is-${kind}" cx="${cx}" cy="${cy}" r="4.5"></circle><text class="ckpt-dot-label is-${kind}" x="${cx}" y="${Number(cy) - 10}" text-anchor="${anchor}">${label}</text>`;
    };
    const inRange = (hours) => hours >= lo && hours <= hi;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="有效训练时间随保存间隔的变化">
      ${yTicks.map((share) => `<line class="ckpt-grid" x1="${L}" x2="${W - R}" y1="${y(share).toFixed(1)}" y2="${y(share).toFixed(1)}"></line><text class="ckpt-axis" x="${L - 6}" y="${(y(share) + 3.5).toFixed(1)}" text-anchor="end">${(share * 100).toFixed(step < 0.01 ? 1 : 0)}%</text>`).join('')}
      ${xTicks.map(([hours, label]) => `<text class="ckpt-axis" x="${x(hours).toFixed(1)}" y="${H - B + 15}" text-anchor="middle">${label}</text>`).join('')}
      <path class="ckpt-curve" d="${path}"></path>
      ${inRange(result.optimal) ? marker(result.optimal, result.best.goodput, 'best', '最优') : ''}
      ${inRange(tau) && Math.abs(tau - result.optimal) / result.optimal > 0.05 ? marker(tau, result.current.goodput, 'current', '当前') : ''}
    </svg>`;
  }

  const field = (name, label, integer) => `<label class="ckpt-field"><span>${label}</span><input type="number" inputmode="${integer ? 'numeric' : 'decimal'}" name="${name}" min="0" step="${integer ? '1' : 'any'}"></label>`;

  let remembered = { ...DEFAULTS };

  function mount(root) {
    const byName = Object.fromEntries(FIELDS.map((entry) => [entry[0], entry]));
    root.innerHTML = `
      <div class="ckpt">
        <form class="ckpt-form" novalidate>
          <fieldset><legend>集群</legend>
            ${field('gpus', byName.gpus[1], true)}
            ${field('mtbfHours', byName.mtbfHours[1], false)}
            <p class="ckpt-note" data-out="cluster"></p>
            <p class="ckpt-hint">参照：Llama 3 预训练 16,384 张卡、54 天里有 419 次意外中断，折算单卡约 5.1 万小时。</p>
          </fieldset>
          <fieldset><legend>Checkpoint</legend>
            ${field('intervalMinutes', byName.intervalMinutes[1], false)}
            ${field('saveSeconds', byName.saveSeconds[1], false)}
            <p class="ckpt-hint">异步保存只填真正让训练停下来的那一段。</p>
          </fieldset>
          <fieldset><legend>故障恢复</legend>
            ${field('restartMinutes', byName.restartMinutes[1], false)}
            <p class="ckpt-hint">从出故障到训练重新跑起来：发现故障、换节点、重新拉起、加载 checkpoint。</p>
          </fieldset>
        </form>
        <div class="ckpt-peek" aria-hidden="true"><span>有效训练时间</span><b data-out="peek"></b></div>
        <section class="ckpt-result" aria-label="估算结果">
          <p class="ckpt-kicker">有效训练时间</p>
          <p class="ckpt-total" aria-live="polite"><strong data-out="total"></strong><span data-out="best"></span></p>
          <div class="ckpt-bar" aria-hidden="true"><div class="ckpt-fill">${PARTS.map(([key]) => `<i data-part="${key}"></i>`).join('')}</div></div>
          <ul class="ckpt-legend">${PARTS.map(([key, label]) => `<li data-part="${key}"><span>${label}</span><b data-out="${key}"></b></li>`).join('')}</ul>
          <p class="ckpt-facts" data-out="facts"></p>
          <figure class="ckpt-chart" data-out="chart"></figure>
          <div class="ckpt-tips" data-out="tips"></div>
          <p class="ckpt-error" role="alert" data-out="error" hidden></p>
        </section>
      </div>`;

    const form = root.querySelector('.ckpt-form');
    const out = (name) => root.querySelector(`[data-out="${name}"]`);
    const current = () => Object.fromEntries([...form.elements].filter((element) => element.name).map((element) => [element.name, element.value]));
    const write = (values) => {
      for (const element of form.elements) if (element.name && element.name in values) element.value = String(values[element.name]);
    };

    const read = () => {
      const values = current();
      const config = {};
      for (const [name, label, max, integer] of FIELDS) {
        const raw = values[name].trim();
        if (!(integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(raw)) {
          throw new Error(`${label}需要是${integer ? '正整数' : '不小于 0 的数字'}，现在是「${raw || '空'}」。填一个${integer ? '大于 0 的整数' : '数字'}。`);
        }
        if (Number(raw) > max) throw new Error(`${label}最大支持 ${max}，现在是 ${raw}。填一个小一点的值。`);
        config[name] = Number(raw);
      }
      return { values, config };
    };

    const showError = (message) => {
      out('error').textContent = message;
      out('error').hidden = false;
      out('peek').textContent = '配置有误，见下方提示';
      root.querySelector('.ckpt').dataset.state = 'error';
    };

    const render = () => {
      let state;
      try {
        state = read();
      } catch (error) {
        showError(error.message);
        return;
      }
      const { config } = state;
      const result = estimate(config);
      if (result.error) {
        showError(result.error);
        return;
      }
      remembered = { ...state.values };
      out('error').hidden = true;
      root.querySelector('.ckpt').dataset.state = 'ok';
      const { current: now, best } = result;
      out('cluster').textContent = `集群平均每 ${duration(result.clusterMtbf)}中断一次，每天约 ${result.failuresPerDay.toFixed(2)} 次。`;
      out('total').textContent = percent(now.goodput);
      out('best').textContent = Math.abs(config.intervalMinutes / 60 - result.optimal) / result.optimal > 0.05
        ? ` 按最优间隔 ${duration(result.optimal)}保存可到 ${percent(best.goodput)}`
        : ` 已在最优间隔附近（${duration(result.optimal)}）`;
      out('peek').textContent = percent(now.goodput);
      for (const [key] of PARTS) {
        root.querySelector(`.ckpt-fill [data-part="${key}"]`).style.setProperty('width', `${(now[key] * 100).toFixed(3)}%`);
        out(key).textContent = percent(now[key]);
      }
      out('facts').textContent = `每天约损失 ${grouped(result.lostGpuHoursPerDay)} 卡时。`;
      out('chart').innerHTML = `${chart(config, result)}<figcaption>横轴是保存间隔（对数刻度），纵轴是有效训练时间。</figcaption>`;

      const tips = suggestions(config);
      out('tips').innerHTML = tips.length
        ? `<p class="ckpt-tips-title">还能这样提</p>${tips.map((tip, index) => `<button type="button" class="ckpt-tip" data-tip="${index}"><span>${tip.label}</span><b>+${(tip.gain * 100).toFixed(1)} 个点，到 ${percent(tip.goodput)}</b></button>`).join('')}`
        : '';
      out('tips').querySelectorAll('[data-tip]').forEach((button) => {
        button.addEventListener('click', () => {
          write({ ...current(), ...tips[Number(button.dataset.tip)].change });
          render();
        });
      });
    };

    form.addEventListener('submit', (event) => event.preventDefault());
    form.addEventListener('input', render);
    write(remembered);
    render();
  }

  window.SITE_TOOLS = { ...(window.SITE_TOOLS || {}), 'ckpt-goodput': { DEFAULTS, breakdown, optimalInterval, estimate, suggestions, duration, mount } };
})();
