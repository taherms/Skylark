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
  // (brighter + more saturated than a literal photo-sky so the app reads as lively)
  const SKY_GRADIENTS = {
    'clear-day':    'linear-gradient(180deg,#3f9dff 0%,#7fd4ff 36%,#c9f3ff 68%,#ffe9b8 100%)',
    'clear-night':  'linear-gradient(180deg,#161f4d 0%,#2a3f8f 38%,#5568c9 70%,#c7d0ff 100%)',
    'clouds-day':   'linear-gradient(180deg,#5f9bdc 0%,#95c8ff 28%,#d8f1ff 62%,#f2fbff 100%)',
    'clouds-night': 'linear-gradient(180deg,#1c275a 0%,#324b8a 34%,#5e78c0 66%,#cbd8ff 100%)',
    'fog-day':      'linear-gradient(180deg,#9db4c4 0%,#c9dfec 40%,#eef9ff 100%)',
    'fog-night':    'linear-gradient(180deg,#1e2b45 0%,#3a5375 35%,#6889a8 100%)',
    'rain-day':     'linear-gradient(180deg,#3b6899 0%,#5d92c2 32%,#86bcda 62%,#c7ecfb 100%)',
    'rain-night':   'linear-gradient(180deg,#0d1730 0%,#1f3358 35%,#3e5d92 68%,#a9cbe8 100%)',
    'storm-day':    'linear-gradient(180deg,#233a72 0%,#47619e 30%,#7291c4 62%,#d6ebff 100%)',
    'storm-night':  'linear-gradient(180deg,#0a1330 0%,#1c2c5c 36%,#37538c 64%,#9fb6e6 100%)',
    'snow-day':     'linear-gradient(180deg,#78aee0 0%,#c1e6fb 38%,#e9f8ff 68%,#fbfdff 100%)',
    'snow-night':   'linear-gradient(180deg,#182a52 0%,#345590 36%,#6d90c8 64%,#e5edff 100%)',
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
        'clear-day': '#3f9dff', 'clear-night': '#1a2660',
        'clouds-day': '#6fa3d0', 'clouds-night': '#28356e',
        'fog-day': '#9fb0bd', 'fog-night': '#2b374a',
        'rain-day': '#4a76a3', 'rain-night': '#1a2c4c',
        'storm-day': '#3a5487', 'storm-night': '#16244a',
        'snow-day': '#8fb8dd', 'snow-night': '#25407a',
      };
      meta.setAttribute('content', themeColors[key] || '#4A90E2');
    }
  }

  /* ---------------------------- particle stores ---------------------------- */
  let rain = [], snow = [], stars = [], clouds = [], mist = [], leaves = [];
  let lightningAlpha = 0;
  let nextLightningAt = 0;
  let sunRayAngle = 0;

  // Eased 0..1 driving how much real wind speeds up the animation. Smoothing
  // avoids a jump the instant the scene changes, and clamping means a gale
  // never pushes the sky past a calm, legible top speed.
  let windStrength = 0;
  function targetWindStrength() { return Math.min(1, sky.windKph / 55); }

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

  function seedLeaves() {
    // A handful of leaves drifting through the lower sky — the one thing on
    // screen that visibly answers "is it windy?" on a plain clear or cloudy
    // day, when there's no rain/snow to carry that signal.
    leaves = [];
    for (let i = 0; i < 6; i++) {
      leaves.push({
        x: Math.random(), y: 0.42 + Math.random() * 0.44,
        size: 4.5 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2,
        spinDir: Math.random() < 0.5 ? -1 : 1,
        bobPhase: Math.random() * Math.PI * 2,
        bobSpeed: 0.5 + Math.random() * 0.5,
        tint: Math.random(),
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

  // Where the sun/moon sits along its arc right now, based on real progress
  // between its rise and set time — not just a fixed decorative spot.
  function arcPosition(progress) {
    const c = Math.max(0, Math.min(1, progress));
    return { x: 0.14 + c * 0.72, y: 0.68 - Math.sin(c * Math.PI) * 0.56 };
  }

  // The weather API reports times as the location's local wall clock with no
  // UTC offset, so `new Date(...)` on those strings is only meaningful relative
  // to other timestamps from the same payload — comparing it against a raw
  // Date.now() (a real UTC instant) silently breaks whenever the browser's own
  // timezone differs from the forecast location's. Anchor "now" to the
  // observation time the weather payload itself reported, then advance it by
  // real elapsed wall-clock time so the arc still ticks forward live between
  // refreshes.
  function currentClockMs() {
    if (sky.nowMs == null) return Date.now();
    return sky.nowMs + (Date.now() - sky.nowSetAtReal);
  }

  function riseSetProgress(riseMs, setMs) {
    if (!riseMs || !setMs || setMs <= riseMs) return null;
    const now = currentClockMs();
    if (now < riseMs || now > setMs) return null;
    return (now - riseMs) / (setMs - riseMs);
  }

  function drawMoonDisc(cx, cy, r, phase) {
    // Warm, cartoonish palette (cream + soft plum) instead of clinical grey —
    // matches the mascot's flat, friendly illustration style.
    const litColor = '#fff6da';
    const darkColor = 'rgba(58,50,86,0.92)';
    const angle = ((phase % 1) + 1) % 1 * Math.PI * 2; // 0 new, PI full, 2PI new
    const litRight = angle < Math.PI;
    const a = litRight ? angle : (2 * Math.PI - angle); // fold into 0..PI
    const rx = r * Math.cos(a); // + thin crescent near new, - near-full bulge near full
    const illum = (1 - Math.cos(angle)) / 2; // 0 new .. 1 full

    ctx.save();
    ctx.fillStyle = darkColor;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.beginPath();
    if (litRight) {
      ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);
      if (rx >= 0) ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, true);
      else ctx.ellipse(cx, cy, -rx, r, 0, Math.PI / 2, Math.PI * 1.5, false);
    } else {
      ctx.arc(cx, cy, r, Math.PI / 2, Math.PI * 1.5, false);
      if (rx >= 0) ctx.ellipse(cx, cy, rx, r, 0, Math.PI * 1.5, Math.PI / 2, true);
      else ctx.ellipse(cx, cy, -rx, r, 0, -Math.PI / 2, Math.PI / 2, false);
    }
    ctx.closePath();
    ctx.fillStyle = litColor;
    ctx.fill();
    ctx.clip(); // keep craters/face confined to exactly the lit shape, even for a thin crescent

    ctx.fillStyle = 'rgba(226,203,150,0.55)';
    ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.34, r * 0.13, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.24, cy + r * 0.02, r * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx - r * 0.04, cy + r * 0.36, r * 0.08, 0, Math.PI * 2); ctx.fill();

    // a sleepy little face only peeks out once the moon is more than half full —
    // a sliver of crescent is too thin to hold a face without looking broken.
    if (illum > 0.55) {
      ctx.globalAlpha = Math.min(1, (illum - 0.55) / 0.2);
      const faceX = cx + (litRight ? r * 0.16 : -r * 0.16);
      ctx.strokeStyle = 'rgba(90,72,48,0.75)';
      ctx.lineWidth = Math.max(1.3, r * 0.05);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(faceX - r * 0.24, cy - r * 0.05, r * 0.12, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
      ctx.beginPath(); ctx.arc(faceX + r * 0.22, cy - r * 0.05, r * 0.12, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
      ctx.beginPath(); ctx.arc(faceX, cy + r * 0.2, r * 0.15, Math.PI * 0.12, Math.PI * 0.88); ctx.stroke();
      ctx.fillStyle = 'rgba(255,182,160,0.5)';
      ctx.beginPath(); ctx.ellipse(faceX - r * 0.38, cy + r * 0.12, r * 0.09, r * 0.06, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(faceX + r * 0.38, cy + r * 0.12, r * 0.09, r * 0.06, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }

  function drawSunOrMoon(dt) {
    if (sky.category === 'fog') return;
    // Only draw the body once we can confirm it has actually risen and hasn't
    // set yet — no rise/set data (or a moon that hasn't come up) means it
    // simply isn't shown, rather than pinning it to a decorative fixed spot.
    const progress = riseSetProgress(sky.isDay ? sky.sunriseMs : sky.moonriseMs, sky.isDay ? sky.sunsetMs : sky.moonsetMs);
    if (progress == null) return;
    const pos = arcPosition(progress);
    const cx = w * pos.x, cy = h * pos.y + (window.scrollY || 0) * 0.02;
    const cloudFade = 1 - Math.min(sky.cloudLevel, 3) * 0.24;

    if (sky.isDay) {
      const r = Math.min(w, h) * 0.09;
      sunRayAngle += dt * 0.1;
      ctx.save();
      ctx.globalAlpha = Math.max(0.18, cloudFade);
      const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.6);
      glow.addColorStop(0, 'rgba(255,241,190,0.92)');
      glow.addColorStop(1, 'rgba(255,225,150,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 2.6, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = 'rgba(255,248,224,0.65)';
      ctx.lineWidth = 3;
      for (let i = 0; i < 10; i++) {
        const a = sunRayAngle + (i / 10) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r * 1.25, cy + Math.sin(a) * r * 1.25);
        ctx.lineTo(cx + Math.cos(a) * r * 1.65, cy + Math.sin(a) * r * 1.65);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffdd7a';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else {
      const r = Math.min(w, h) * 0.085;
      ctx.save();
      ctx.globalAlpha = Math.max(0.25, cloudFade);
      const glow = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * 2.2);
      glow.addColorStop(0, 'rgba(255,240,205,0.4)');
      glow.addColorStop(1, 'rgba(255,240,205,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 2.2, 0, Math.PI * 2); ctx.fill();

      drawMoonDisc(cx, cy, r, sky.moonPhase != null ? sky.moonPhase : 0.5);
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
    ctx.fillStyle = sky.isDay ? 'rgba(255,255,255,0.95)' : 'rgba(152,162,196,0.62)';
    const puffs = [[0, 0, 34], [26, -8, 26], [-28, -6, 24], [50, 4, 20], [-48, 6, 18], [8, 10, 30]];
    for (const [ox, oy, r] of puffs) {
      ctx.beginPath();
      ctx.ellipse(cx + ox * scale, cy + oy * scale, r * scale, r * scale * 0.82, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawClouds(dt) {
    // dt is seconds; c.speed is a "screen-widths-per-second"-scale constant, so
    // this drifts clouds fully across the sky in tens of seconds, not frames.
    const windBoost = 0.5 + windStrength * 1.5;
    for (const c of clouds) {
      c.x += (c.speed * windBoost * dt) / (w || 1);
      if (c.x > 1.25) c.x = -0.25;
      const alpha = 0.68 + c.depth * 0.32;
      drawCloud(c.x * w, c.y * h, c.scale, alpha);
    }
  }

  function drawLeaves(dt, now) {
    if (sky.category === 'snow') return; // leaves blowing through falling snow reads as a bug, not wind
    // Speed and visibility both track windStrength directly, so a calm day
    // barely stirs them while a breeze makes the drift unmistakable — capped
    // at the same smooth ceiling as the clouds.
    const speed = 0.012 + windStrength * 0.15;
    const visibility = Math.min(1, 0.12 + windStrength * 1.5);
    if (visibility <= 0.03) return;
    const dayColors = ['#e8a25b', '#d98b46', '#c9c15b'];
    const nightColors = ['#8f97b8', '#7c84a8', '#9aa0c2'];
    const palette = sky.isDay ? dayColors : nightColors;
    ctx.save();
    for (const lf of leaves) {
      lf.x += speed * dt;
      if (lf.x > 1.08) { lf.x = -0.08; lf.y = 0.42 + Math.random() * 0.44; }
      lf.rot += lf.spinDir * (0.3 + windStrength * 1.4) * dt;
      const bob = Math.sin(now * 0.001 * lf.bobSpeed + lf.bobPhase) * 0.018;
      const x = lf.x * w, y = (lf.y + bob) * h;
      const size = lf.size * (w / 800 || 1);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(lf.rot);
      ctx.globalAlpha = visibility;
      ctx.fillStyle = palette[Math.floor(lf.tint * palette.length)];
      ctx.beginPath();
      ctx.ellipse(0, 0, size, size * 0.58, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-size * 0.9, 0); ctx.lineTo(size * 0.9, 0); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawMist(dt) {
    for (const m of mist) {
      m.x += (m.speed * dt) / (w || 1);
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
    const maxWindLean = Math.max(-1.0, Math.min(1.0, sky.windKph / 45)) * windStrength;
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
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    for (const s of snow) {
      s.y += (s.speed * dt) / (h || 1);
      const driftX = Math.sin(t * 0.001 * s.driftSpeed + s.drift) * 0.05;
      s.x += driftX * dt + (sky.windKph / 700) * windStrength * dt;
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
    const dtMs = Math.min(50, now - last); // clamp guards against big jumps after tab-away
    last = now;
    const dt = dtMs / 1000; // seconds — every particle speed below is tuned per second
    windStrength += (targetWindStrength() - windStrength) * Math.min(1, dt * 1.5);
    ctx.clearRect(0, 0, w, h);

    drawStars(dt, now);
    drawSunOrMoon(dt);
    if (sky.category === 'fog') drawMist(dt);
    else drawClouds(dt);
    drawLeaves(dt, now);
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
    seedLeaves();
    window.addEventListener('resize', resize);
    resize();
    if (!reduceMotion) raf = requestAnimationFrame(frame);
    else frame(performance.now());
  }

  function setScene({ category, code, isDay, windKph = 8, precipMm = 0, feelsLike, sunrise, sunset, moonrise, moonset, moonPhase, now }) {
    const changed = category !== sky.category || isDay !== sky.isDay;
    sky = {
      category, isDay, windKph, precipMm, feelsLike, cloudLevel: cloudLevelFor(category, code),
      sunriseMs: sunrise ? sunrise.getTime() : null, sunsetMs: sunset ? sunset.getTime() : null,
      moonriseMs: moonrise ? moonrise.getTime() : null, moonsetMs: moonset ? moonset.getTime() : null,
      moonPhase: moonPhase != null ? moonPhase : null,
      nowMs: now ? now.getTime() : null, nowSetAtReal: Date.now(),
    };

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
