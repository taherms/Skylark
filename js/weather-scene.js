/* ==========================================================================
   Skylark Weather — ambient scene engine
   Draws a living sky behind the UI: sun/moon, drifting clouds, rain, snow,
   fog and the occasional flash of lightning. Also owns the mascot's mood
   (accessories, eyes, mouth) since both are driven by the same weather state.
   No external dependencies — everything here is hand-rolled canvas + SVG.
   ========================================================================== */

const WeatherScene = (() => {
  let canvas, ctx, dpr = 1;
  let w = 0, h = 0;
  let raf = null;
  let last = 0;

  let sky = { category: 'clear', isDay: true, windKph: 8, precipMm: 0, cloudLevel: 0 };
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // gradient recipes per "mood" — used by the CSS crossfade layers, not canvas
  const SKY_GRADIENTS = {
    'clear-day':    'linear-gradient(180deg,#5eaef9 0%,#8ad7ff 36%,#d9f4ff 68%,#fff2d8 100%)',
    'clear-night':  'linear-gradient(180deg,#121a39 0%,#1f2e6c 38%,#495eaa 70%,#b9c6f4 100%)',
    'clouds-day':   'linear-gradient(180deg,#77a9d8 0%,#a9d0f8 28%,#dff4ff 62%,#eff9ff 100%)',
    'clouds-night': 'linear-gradient(180deg,#1a2342 0%,#2d3d67 34%,#536b99 66%,#b8c8eb 100%)',
    'fog-day':      'linear-gradient(180deg,#a6b4bd 0%,#d1dfe6 40%,#edf7ff 100%)',
    'fog-night':    'linear-gradient(180deg,#1b2433 0%,#35455f 35%,#5a6d89 100%)',
    'rain-day':     'linear-gradient(180deg,#4e6f95 0%,#6d8db2 32%,#8fb2c9 62%,#cfe8f4 100%)',
    'rain-night':   'linear-gradient(180deg,#0d1320 0%,#1c2a3e 35%,#3c4f73 68%,#b5c7d8 100%)',
    'storm-day':    'linear-gradient(180deg,#2a3d66 0%,#4d5f86 30%,#7288aa 62%,#dce9ff 100%)',
    'storm-night':  'linear-gradient(180deg,#0c1220 0%,#1a2540 36%,#354a6a 64%,#a7b8db 100%)',
    'snow-day':     'linear-gradient(180deg,#8db4d6 0%,#cfe6f7 38%,#edf8ff 68%,#f8fbff 100%)',
    'snow-night':   'linear-gradient(180deg,#19253f 0%,#2f4875 36%,#647ca8 64%,#dfe9ff 100%)',
  };

  let skyA, skyB, activeIsA = true;

  function moodKey() {
    const cat = sky.category === 'drizzle' ? 'rain' : sky.category;
    return `${cat}-${sky.isDay ? 'day' : 'night'}`;
  }

  function applySkyGradient() {
    const key = moodKey();
    const css = SKY_GRADIENTS[key] || SKY_GRADIENTS['clear-day'];
    const incoming = activeIsA ? skyB : skyA;
    const outgoing = activeIsA ? skyA : skyB;
    incoming.style.background = css;
    incoming.classList.add('is-active');
    outgoing.classList.remove('is-active');
    activeIsA = !activeIsA;

    const meta = document.getElementById('theme-color-meta');
    if (meta) {
      const themeColors = {
        'clear-day': '#4A90E2', 'clear-night': '#141a3a',
        'clouds-day': '#8b9dae', 'clouds-night': '#1d2437',
        'fog-day': '#a7b1b5', 'fog-night': '#232830',
        'rain-day': '#556579', 'rain-night': '#141b2b',
        'storm-day': '#394153', 'storm-night': '#0d0f18',
        'snow-day': '#8ea2ba', 'snow-night': '#1c2338',
      };
      meta.setAttribute('content', themeColors[key] || '#4A90E2');
    }
  }

  /* ---------------------------- particle stores ---------------------------- */
  let rain = [], snow = [], stars = [], clouds = [], mist = [];
  let lightningAlpha = 0;
  let nextLightningAt = 0;
  let sunRayAngle = 0;

  function seedStars() {
    stars = [];
    const n = 70;
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random(), y: Math.random() * 0.6,
        r: Math.random() * 1.4 + 0.4,
        phase: Math.random() * Math.PI * 2,
        speed: 0.6 + Math.random() * 0.8,
      });
    }
  }

  function seedClouds(level) {
    clouds = [];
    const count = level <= 0 ? 0 : level === 1 ? 3 : level === 2 ? 5 : 7;
    for (let i = 0; i < count; i++) {
      const depth = Math.random(); // 0 = far/small/slow, 1 = near/big/fast
      clouds.push({
        x: Math.random(),
        y: 0.06 + Math.random() * 0.32,
        scale: 0.5 + depth * 1.1,
        depth,
        speed: (4 + depth * 10),
      });
    }
  }

  function seedMist(active) {
    mist = [];
    if (!active) return;
    for (let i = 0; i < 5; i++) {
      mist.push({
        x: Math.random(),
        y: 0.35 + i * 0.13,
        speed: 3 + Math.random() * 4,
        alpha: 0.16 + Math.random() * 0.14,
        scaleX: 1.4 + Math.random() * 0.8,
      });
    }
  }

  function seedRain(intensity) {
    rain = [];
    if (intensity <= 0) return;
    const count = Math.round(40 + intensity * 220);
    for (let i = 0; i < count; i++) {
      rain.push({
        x: Math.random(), y: Math.random(),
        len: 10 + Math.random() * 14,
        speed: (420 + Math.random() * 260) * (0.6 + intensity),
      });
    }
  }

  function seedSnow(intensity) {
    snow = [];
    if (intensity <= 0) return;
    const count = Math.round(30 + intensity * 160);
    for (let i = 0; i < count; i++) {
      snow.push({
        x: Math.random(), y: Math.random(),
        r: 1.6 + Math.random() * 2.8,
        speed: 26 + Math.random() * 46,
        drift: Math.random() * Math.PI * 2,
        driftSpeed: 0.6 + Math.random() * 0.8,
      });
    }
  }

  /* ------------------------------- rendering ------------------------------- */

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawSunOrMoon(dt) {
    const cx = w * 0.78, cy = h * 0.16 + (window.scrollY || 0) * 0.02;
    const cloudFade = 1 - Math.min(sky.cloudLevel, 3) * 0.24;
    if (sky.category === 'fog') return;

    if (sky.isDay) {
      const r = Math.min(w, h) * 0.09;
      sunRayAngle += dt * 0.05;
      ctx.save();
      ctx.globalAlpha = Math.max(0.18, cloudFade);
      const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.6);
      glow.addColorStop(0, 'rgba(255,236,170,0.85)');
      glow.addColorStop(1, 'rgba(255,236,170,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 2.6, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = 'rgba(255,244,214,0.55)';
      ctx.lineWidth = 3;
      for (let i = 0; i < 10; i++) {
        const a = sunRayAngle + (i / 10) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r * 1.25, cy + Math.sin(a) * r * 1.25);
        ctx.lineTo(cx + Math.cos(a) * r * 1.65, cy + Math.sin(a) * r * 1.65);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffe9a8';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else {
      const r = Math.min(w, h) * 0.075;
      ctx.save();
      ctx.globalAlpha = Math.max(0.25, cloudFade);
      const glow = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * 2.2);
      glow.addColorStop(0, 'rgba(220,228,255,0.35)');
      glow.addColorStop(1, 'rgba(220,228,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 2.2, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#eef1fb';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(180,190,220,0.45)';
      ctx.beginPath(); ctx.arc(cx - r * 0.32, cy - r * 0.18, r * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + r * 0.28, cy + r * 0.3, r * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function drawStars(dt, t) {
    if (sky.isDay) return;
    ctx.save();
    for (const s of stars) {
      const alpha = 0.35 + 0.5 * Math.abs(Math.sin(t * 0.001 * s.speed + s.phase));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCloud(cx, cy, scale, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = sky.isDay ? 'rgba(255,255,255,0.92)' : 'rgba(120,130,155,0.55)';
    const puffs = [[0, 0, 34], [26, -8, 26], [-28, -6, 24], [50, 4, 20], [-48, 6, 18], [8, 10, 30]];
    for (const [ox, oy, r] of puffs) {
      ctx.beginPath();
      ctx.ellipse(cx + ox * scale, cy + oy * scale, r * scale, r * scale * 0.82, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function windAnimationStrength() {
    return Math.min(1, sky.windKph / 42);
  }

  function drawClouds(dt) {
    const windBoost = 0.1 + windAnimationStrength() * 1.2;
    for (const c of clouds) {
      c.x += (c.speed * dt) / (w || 1) * windBoost;
      if (c.x > 1.25) c.x = -0.25;
      const alpha = 0.62 + c.depth * 0.38;
      drawCloud(c.x * w, c.y * h, c.scale, alpha);
    }
  }

  function drawMist(dt) {
    for (const m of mist) {
      m.x += (m.speed * dt) / (w || 1) * 0.03;
      if (m.x > 1.4) m.x = -0.4;
      ctx.save();
      ctx.globalAlpha = m.alpha;
      const grad = ctx.createLinearGradient(0, m.y * h - 40, 0, m.y * h + 40);
      const tint = sky.isDay ? '255,255,255' : '200,206,220';
      grad.addColorStop(0, `rgba(${tint},0)`);
      grad.addColorStop(0.5, `rgba(${tint},1)`);
      grad.addColorStop(1, `rgba(${tint},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(m.x * w, m.y * h, w * 0.5 * m.scaleX, 46, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawRain(dt) {
    if (!rain.length) return;
    const maxWindLean = Math.max(-1.0, Math.min(1.0, sky.windKph / 35)) * windAnimationStrength();
    ctx.save();
    ctx.strokeStyle = sky.isDay ? 'rgba(210,228,245,0.8)' : 'rgba(150,175,210,0.7)';
    ctx.lineWidth = 1.5;
    for (const d of rain) {
      d.y += (d.speed * dt) / (h || 1);
      d.x += (maxWindLean * d.speed * dt) / (w || 1) * 0.7;
      if (d.y > 1.05) { d.y = -0.05; d.x = Math.random(); }
      if (d.x > 1.05) d.x = -0.05;
      if (d.x < -0.05) d.x = 1.05;
      const x = d.x * w, y = d.y * h;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + maxWindLean * d.len, y + d.len);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSnow(dt, t) {
    if (!snow.length) return;
    const windDrift = windAnimationStrength();
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    for (const s of snow) {
      s.y += (s.speed * dt) / (h || 1);
      const driftX = Math.sin(t * 0.001 * s.driftSpeed + s.drift) * 0.012;
      s.x += driftX * dt * 0.09 + (sky.windKph / 2200) * windDrift * dt;
      if (s.y > 1.05) { s.y = -0.05; s.x = Math.random(); }
      if (s.x > 1.05) s.x = -0.05;
      if (s.x < -0.05) s.x = 1.05;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawLightning(dt, now) {
    if (sky.category !== 'storm') { lightningAlpha = 0; return; }
    if (now > nextLightningAt) {
      lightningAlpha = 0.55 + Math.random() * 0.35;
      nextLightningAt = now + 3200 + Math.random() * 6500;
    }
    if (lightningAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = lightningAlpha;
      ctx.fillStyle = '#eef3ff';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      lightningAlpha *= 0.86;
    }
  }

  function frame(now) {
    if (!last) last = now;
    const dt = Math.min(50, now - last);
    last = now;
    ctx.clearRect(0, 0, w, h);

    drawStars(dt, now);
    drawSunOrMoon(dt);
    if (sky.category === 'fog') drawMist(dt);
    else drawClouds(dt);
    drawRain(dt);
    drawSnow(dt, now);
    drawLightning(dt, now);

    raf = reduceMotion ? null : requestAnimationFrame(frame);
  }

  function cloudLevelFor(category, code) {
    if (category === 'clear') return code === 1 ? 1 : 0;
    if (category === 'clouds') return code === 2 ? 2 : 3;
    if (category === 'fog') return 1;
    return 3; // drizzle/rain/snow/storm are all overcast
  }

  /* --------------------------------- mascot --------------------------------- */

  function updateMascot() {
    const m = document.getElementById('mascot');
    if (!m) return;
    m.classList.remove('show-sunglasses', 'show-scarf', 'show-earmuffs', 'show-umbrella', 'show-sweat', 'eyes-closed');

    const cold = sky.feelsLike !== undefined && sky.feelsLike < 4;
    const hot = sky.feelsLike !== undefined && sky.feelsLike >= 24;

    if (sky.category === 'snow') { m.classList.add('show-earmuffs', 'show-scarf'); }
    else if (cold) { m.classList.add('show-scarf'); }

    if (['rain', 'drizzle', 'storm'].includes(sky.category)) m.classList.add('show-umbrella');
    if (sky.category === 'storm') m.classList.add('show-sweat');
    if (sky.category === 'clear' && sky.isDay && hot) m.classList.add('show-sunglasses');

    if (!sky.isDay && (sky.category === 'clear' || sky.category === 'clouds')) m.classList.add('eyes-closed');

    const mouth = document.getElementById('mascot-mouth');
    if (mouth) {
      if (sky.category === 'storm') mouth.setAttribute('d', 'M100 150q15 -4 30 0');
      else if (sky.category === 'fog') mouth.setAttribute('d', 'M100 148q15 4 30 0');
      else mouth.setAttribute('d', 'M100 144q15 14 30 0');
    }

    // occasional blink for liveliness
    if (!reduceMotion && !m.dataset.blinkWired) {
      m.dataset.blinkWired = '1';
      const blink = () => {
        if (!m.classList.contains('eyes-closed')) {
          m.classList.add('blink');
          setTimeout(() => m.classList.remove('blink'), 140);
        }
        setTimeout(blink, 2600 + Math.random() * 3200);
      };
      setTimeout(blink, 1800);
    }
  }

  /* --------------------------------- public --------------------------------- */

  function init(canvasEl, skyAEl, skyBEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    skyA = skyAEl; skyB = skyBEl;
    seedStars();
    window.addEventListener('resize', resize);
    resize();
    if (!reduceMotion) raf = requestAnimationFrame(frame);
    else frame(performance.now());
  }

  function setScene({ category, code, isDay, windKph = 8, precipMm = 0, feelsLike }) {
    const changed = category !== sky.category || isDay !== sky.isDay;
    sky = { category, isDay, windKph, precipMm, feelsLike, cloudLevel: cloudLevelFor(category, code) };

    if (changed) applySkyGradient();

    seedClouds(sky.cloudLevel);
    seedMist(category === 'fog');
    const precipIntensity = Math.max(0, Math.min(1.4, precipMm / 4));
    seedRain(['rain', 'drizzle', 'storm'].includes(category) ? Math.max(0.28, precipIntensity) : 0);
    seedSnow(category === 'snow' ? Math.max(0.3, precipIntensity) : 0);

    updateMascot();
  }

  return { init, setScene };
})();
