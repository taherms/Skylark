/* ==========================================================================
   Skylark Weather — tiny chart renderer
   Hand-rolled canvas line/bar charts. No dependency, so the whole app stays
   installable and works offline once the shell is cached.
   ========================================================================== */

const Charts = (() => {
  let raf = null;

  function niceScale(min, max, padFrac = 0.18) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const pad = span * padFrac;
    return { min: min - pad, max: max + pad };
  }

  function drawGrid(ctx, W, H, padL, padR, padT, padB, yMin, yMax, yFormat, gridColor, textColor) {
    const rows = 3;
    ctx.save();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = '11px Inter, sans-serif';
    ctx.fillStyle = textColor;
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      const y = padT + t * (H - padT - padB);
      ctx.globalAlpha = i === rows ? 0.3 : 0.16;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      const val = yMax - t * (yMax - yMin);
      ctx.globalAlpha = 0.7;
      ctx.fillText(yFormat(val), 2, y);
    }
    ctx.restore();
  }

  function drawXLabels(ctx, labels, H, padL, padR, padB, step, textColor) {
    ctx.save();
    ctx.fillStyle = textColor;
    ctx.globalAlpha = 0.7;
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    const innerW = ctx.canvas.clientWidth - padL - padR;
    const n = labels.length;
    for (let i = 0; i < n; i += step) {
      const x = padL + (innerW * i) / (n - 1);
      ctx.fillText(labels[i], x, H - padB + 14);
    }
    ctx.restore();
  }

  function xAt(i, n, padL, innerW) { return padL + (innerW * i) / Math.max(1, n - 1); }
  function yAt(v, yMin, yMax, padT, innerH) { return padT + (1 - (v - yMin) / (yMax - yMin)) * innerH; }

  function renderLine(ctx, opts) {
    const { W, H, labels, series, nowIndex, progress } = opts;
    const padL = 30, padR = 8, padT = 14, padB = 22;
    const innerW = W - padL - padR, innerH = H - padT - padB;

    let yMin = Infinity, yMax = -Infinity;
    series.forEach((s) => s.data.forEach((v) => { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }));
    const scale = niceScale(yMin, yMax);

    drawGrid(ctx, W, H, padL, padR, padT, padB, scale.min, scale.max, opts.yFormat, opts.gridColor, opts.textColor);

    const n = labels.length;
    const visibleN = Math.max(2, Math.round(n * progress));

    series.forEach((s) => {
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.6;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < visibleN; i++) {
        const x = xAt(i, n, padL, innerW);
        const y = yAt(s.data[i], scale.min, scale.max, padT, innerH);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // soft fill under the primary (first) series
      if (s === series[0]) {
        const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
        grad.addColorStop(0, s.color + '55');
        grad.addColorStop(1, s.color + '02');
        ctx.lineTo(xAt(visibleN - 1, n, padL, innerW), H - padB);
        ctx.lineTo(xAt(0, n, padL, innerW), H - padB);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.restore();
    });

    // "now" marker
    if (nowIndex != null && nowIndex < visibleN) {
      const x = xAt(nowIndex, n, padL, innerW);
      ctx.save();
      ctx.strokeStyle = opts.textColor;
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      ctx.restore();
      series.forEach((s) => {
        const y = yAt(s.data[nowIndex], scale.min, scale.max, padT, innerH);
        ctx.save();
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      });
    }

    drawXLabels(ctx, labels, H, padL, padR, padB, Math.max(1, Math.round(n / 6)), opts.textColor);
  }

  function renderBar(ctx, opts) {
    const { W, H, labels, series, nowIndex, progress } = opts;
    const padL = 30, padR = 8, padT = 14, padB = 22;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const s = series[0];

    let yMax = Math.max(...s.data, 1);
    let yMin = Math.min(0, ...s.data);
    const scale = niceScale(yMin, yMax, 0.15);
    scale.min = Math.min(scale.min, 0);

    drawGrid(ctx, W, H, padL, padR, padT, padB, scale.min, scale.max, opts.yFormat, opts.gridColor, opts.textColor);

    const n = labels.length;
    const barW = (innerW / n) * 0.55;
    const zeroY = yAt(0, scale.min, scale.max, padT, innerH);
    const visibleN = Math.max(1, Math.round(n * progress));

    for (let i = 0; i < visibleN; i++) {
      const x = xAt(i, n, padL, innerW);
      const y = yAt(s.data[i], scale.min, scale.max, padT, innerH);
      ctx.save();
      ctx.fillStyle = (s.barColors && s.barColors[i]) || s.color;
      const top = Math.min(y, zeroY), h = Math.max(2, Math.abs(zeroY - y));
      const r = Math.min(4, barW / 2);
      roundRect(ctx, x - barW / 2, top, barW, h, r);
      ctx.fill();
      if (nowIndex === i) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        roundRect(ctx, x - barW / 2, top, barW, h, r);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawXLabels(ctx, labels, H, padL, padR, padB, Math.max(1, Math.round(n / 6)), opts.textColor);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render(canvas, config) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (raf) cancelAnimationFrame(raf);

    const duration = reduceMotion ? 0 : 520;
    const start = performance.now();

    const step = (now) => {
      const t = duration === 0 ? 1 : Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      ctx.clearRect(0, 0, W, H);
      const opts = { W, H, progress: eased, ...config };
      if (config.type === 'bar') renderBar(ctx, opts); else renderLine(ctx, opts);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  return { render };
})();
