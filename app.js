/*
 * Primordia – user interface: rendering, controls, charts and interaction.
 */
(() => {
  'use strict';

  // Show any runtime error on screen instead of failing silently.
  window.addEventListener('error', (e) => {
    const b = document.getElementById('errorBanner');
    b.textContent = `Error: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`;
    b.hidden = false;
  });

  const { World, TRAITS, SPECIES } = window.Sim;
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const SPEEDS = [0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 32];
  const COLORS = { herb: '#4fd1c5', pred: '#ff6b6b', food: '#9be15d', grid: '#5b6b80', gridLine: '#161e2b' };
  const BRUSH = { food: 35, meteor: 70 };
  const TOOLS = ['inspect', 'food', 'herb', 'pred', 'meteor'];

  const world = new World();
  window.world = world; // handy for poking at from the browser console

  const ui = {
    running: true,
    speedIndex: 2,
    acc: 0,
    tool: 'inspect',
    selected: null,
    follow: false,
    colorBy: 'lineage',
    showVision: false,
    showZones: true,
    showTrails: true,
    trait: 'speed',
    series: { herb: true, pred: true, food: false },
    cam: { x: world.cfg.width / 2, y: world.cfg.height / 2, zoom: 1 },
    mouse: { x: 0, y: 0, inside: false, down: false, pan: false, moved: false, sx: 0, sy: 0, camX: 0, camY: 0 },
    effects: [],
    trails: new Map(),
    popHover: null,
    lastPanels: 0,
    lastEventId: 0,
    tps: 0, tpsTicks: 0, tpsTime: performance.now(),
  };

  // ======================================================================
  // World canvas & camera
  // ======================================================================
  const canvas = $('world');
  const ctx = canvas.getContext('2d');
  let cw = 1, ch = 1, dpr = 1;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    cw = Math.max(1, r.width);
    ch = Math.max(1, r.height);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const scale = () => Math.min(cw / world.cfg.width, ch / world.cfg.height) * 0.96 * ui.cam.zoom;
  const toWorld = (sx, sy) => { const s = scale(); return [(sx - cw / 2) / s + ui.cam.x, (sy - ch / 2) / s + ui.cam.y]; };

  function clampCam() {
    ui.cam.x = clamp(ui.cam.x, 0, world.cfg.width);
    ui.cam.y = clamp(ui.cam.y, 0, world.cfg.height);
  }

  function fitView() {
    ui.cam.x = world.cfg.width / 2;
    ui.cam.y = world.cfg.height / 2;
    ui.cam.zoom = 1;
    ui.follow = false;
  }

  // Pre-rendered glowing sprites are much faster than canvas shadows.
  function makeGlow(rgb, size = 32) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.18, `rgba(${rgb},.9)`);
    grad.addColorStop(0.4, `rgba(${rgb},.25)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }
  const foodSprite = makeGlow('155,225,93');
  const carrionSprite = makeGlow('192,138,106');

  // ---------- colours ----------
  const PLASMA = [[40, 60, 140], [120, 80, 200], [230, 90, 140], [255, 180, 70], [250, 250, 150]];
  function ramp(t) {
    t = clamp(t, 0, 1) * (PLASMA.length - 1);
    const i = Math.min(PLASMA.length - 2, Math.floor(t)), f = t - i;
    const a = PLASMA[i], b = PLASMA[i + 1];
    return `rgb(${(a[0] + (b[0] - a[0]) * f) | 0},${(a[1] + (b[1] - a[1]) * f) | 0},${(a[2] + (b[2] - a[2]) * f) | 0})`;
  }
  const traitByKey = Object.fromEntries(TRAITS.map((t) => [t.key, t]));

  function colorFor(o) {
    if (ui.colorBy === 'lineage') {
      // Herbivores span teal → violet, predators red → orange, so the species never look alike.
      const h = o.genes.hue / 360;
      return o.kind === 'herb' ? `hsl(${150 + h * 150},70%,62%)` : `hsl(${(h * 40 + 352) % 360},88%,63%)`;
    }
    if (ui.colorBy === 'energy') return ramp(o.energy / o.maxEnergy);
    const t = traitByKey[ui.colorBy];
    return ramp((o.genes[t.key] - t.min) / (t.max - t.min));
  }

  // ---------- rendering ----------
  function render() {
    const s = scale();
    const W = world.cfg.width, H = world.cfg.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (cw / 2 - ui.cam.x * s), dpr * (ch / 2 - ui.cam.y * s));
    const px = 1 / s; // one screen pixel in world units

    // Visible region (for culling)
    const [vx0, vy0] = toWorld(0, 0), [vx1, vy1] = toWorld(cw, ch);
    const visible = (x, y, m = 20) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m;

    // Ground, tinted by season
    const sf = world.seasonFactor();
    const warm = clamp((sf - 1) / 0.65, -1, 1);
    ctx.fillStyle = warm >= 0 ? `rgb(${11 + warm * 4},${16 + warm * 3},${22})` : `rgb(10,${15 - warm * 2},${24 - warm * 6})`;
    ctx.fillRect(0, 0, W, H);

    // Subtle grid
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = px;
    ctx.beginPath();
    for (let x = 100; x < W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 100; y < H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    // Fertile zones and their tall-grass cores
    if (ui.showZones) {
      for (const h of world.hotspots) {
        const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.r * 1.4);
        g.addColorStop(0, `rgba(90,200,110,${0.09 * sf})`);
        g.addColorStop(1, 'rgba(90,200,110,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r * 1.4, 0, TAU); ctx.fill();
        ctx.setLineDash([4 * px, 6 * px]);
        ctx.strokeStyle = 'rgba(120,220,130,.22)';
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r * world.cfg.coverRadius, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Border
    ctx.strokeStyle = '#243046';
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(0, 0, W, H);

    // Food and carrion (additive glow)
    ctx.globalCompositeOperation = 'lighter';
    const fs = 11;
    for (const f of world.food) {
      if (!visible(f.x, f.y)) continue;
      ctx.globalAlpha = Math.min(1, (world.tick - f.bornAt) / 60 + 0.15);
      ctx.drawImage(foodSprite, f.x - fs / 2, f.y - fs / 2, fs, fs);
    }
    const rot = SPECIES.pred.carrionLife;
    for (const c of world.carcasses) {
      if (!visible(c.x, c.y)) continue;
      ctx.globalAlpha = 0.8 * (1 - (world.tick - c.bornAt) / rot);
      ctx.drawImage(carrionSprite, c.x - 6, c.y - 6, 12, 12);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Trails
    if (ui.showTrails) {
      ctx.lineWidth = 1.2 * px;
      ctx.lineCap = 'round';
      for (const o of world.organisms) {
        const t = ui.trails.get(o.id);
        if (!t || t.length < 4 || !visible(o.x, o.y, 60)) continue;
        ctx.strokeStyle = o.kind === 'herb' ? 'rgba(79,209,197,.16)' : 'rgba(255,107,107,.22)';
        ctx.beginPath();
        ctx.moveTo(t[0], t[1]);
        for (let i = 2; i < t.length; i += 2) ctx.lineTo(t[i], t[i + 1]);
        ctx.lineTo(o.x, o.y);
        ctx.stroke();
      }
    }

    // Vision ranges
    if (ui.showVision) {
      ctx.lineWidth = px;
      for (const o of world.organisms) {
        if (!visible(o.x, o.y, o.genes.vision)) continue;
        ctx.strokeStyle = o.kind === 'herb' ? 'rgba(79,209,197,.10)' : 'rgba(255,107,107,.14)';
        ctx.beginPath(); ctx.arc(o.x, o.y, o.genes.vision, 0, TAU); ctx.stroke();
      }
    }

    // Organisms
    const minR = 2.6 * px;
    for (const o of world.organisms) {
      if (!visible(o.x, o.y)) continue;
      const r = Math.max(minR, o.radius);
      ctx.globalAlpha = 0.4 + 0.6 * clamp(o.energy / o.maxEnergy * 1.6, 0, 1);
      ctx.fillStyle = colorFor(o);
      const c = Math.cos(o.heading), sn = Math.sin(o.heading);
      if (o.kind === 'herb') {
        ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(5,10,16,.75)';
        ctx.beginPath(); ctx.arc(o.x + c * r * 0.5, o.y + sn * r * 0.5, r * 0.32, 0, TAU); ctx.fill();
      } else {
        const L = r * 1.5;
        ctx.beginPath();
        ctx.moveTo(o.x + c * L, o.y + sn * L);
        ctx.lineTo(o.x - c * L * 0.8 - sn * r, o.y - sn * L * 0.8 + c * r);
        ctx.lineTo(o.x - c * L * 0.4, o.y - sn * L * 0.4);
        ctx.lineTo(o.x - c * L * 0.8 + sn * r, o.y - sn * L * 0.8 - c * r);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Selection
    const sel = ui.selected;
    if (sel && sel.alive) {
      const pulse = 1 + 0.15 * Math.sin(performance.now() / 200);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath(); ctx.arc(sel.x, sel.y, sel.radius * 2.2 * pulse + 3 * px, 0, TAU); ctx.stroke();
      ctx.setLineDash([3 * px, 5 * px]);
      ctx.strokeStyle = sel.kind === 'herb' ? 'rgba(79,209,197,.5)' : 'rgba(255,107,107,.55)';
      ctx.beginPath(); ctx.arc(sel.x, sel.y, sel.genes.vision, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      const t = sel.target;
      if (t && (t.alive || t.eaten === false)) {
        ctx.strokeStyle = sel.state === 'flee' ? 'rgba(255,107,107,.7)' : 'rgba(255,255,255,.45)';
        ctx.beginPath(); ctx.moveTo(sel.x, sel.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      }
    }

    // Meteor and spawn effects
    const now = performance.now();
    ui.effects = ui.effects.filter((e) => now - e.t0 < e.dur);
    for (const e of ui.effects) {
      const p = (now - e.t0) / e.dur;
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = (e.kind === 'meteor' ? 4 : 2) * px * (1 - p) + px;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.3 + p * 0.9), 0, TAU); ctx.stroke();
      if (e.kind === 'meteor' && p < 0.35) {
        ctx.globalAlpha = (0.35 - p) * 1.6;
        ctx.fillStyle = '#ffb35c';
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + p), 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Brush preview
    const m = ui.mouse;
    if (m.inside && BRUSH[ui.tool]) {
      const [wx, wy] = toWorld(m.x, m.y);
      ctx.setLineDash([4 * px, 4 * px]);
      ctx.strokeStyle = ui.tool === 'meteor' ? 'rgba(255,170,90,.7)' : 'rgba(155,225,93,.6)';
      ctx.lineWidth = 1.2 * px;
      ctx.beginPath(); ctx.arc(wx, wy, BRUSH[ui.tool], 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function updateTrails() {
    if (!ui.showTrails) { ui.trails.clear(); return; }
    const seen = new Set();
    for (const o of world.organisms) {
      seen.add(o.id);
      let t = ui.trails.get(o.id);
      if (!t) { t = []; ui.trails.set(o.id, t); }
      const n = t.length;
      if (n === 0 || (t[n - 2] - o.x) ** 2 + (t[n - 1] - o.y) ** 2 > 9) {
        t.push(o.x, o.y);
        if (t.length > 24) t.splice(0, 2);
      }
    }
    for (const id of ui.trails.keys()) if (!seen.has(id)) ui.trails.delete(id);
  }

  // ======================================================================
  // Pointer interaction
  // ======================================================================
  function applyTool(wx, wy, e, first) {
    switch (ui.tool) {
      case 'food':
        world.sprinkleFood(wx, wy, first ? 10 : 3, BRUSH.food * 0.5);
        break;
      case 'herb':
      case 'pred':
        if (!first) break;
        for (let i = 0, n = e.shiftKey ? 5 : 1; i < n; i++) {
          world.spawn(ui.tool, wx + (n > 1 ? (Math.random() - 0.5) * 30 : 0), wy + (n > 1 ? (Math.random() - 0.5) * 30 : 0));
        }
        ui.effects.push({ kind: 'spawn', x: wx, y: wy, r: 22, t0: performance.now(), dur: 500, color: ui.tool === 'herb' ? COLORS.herb : COLORS.pred });
        break;
      case 'meteor':
        if (!first) break;
        world.smite(wx, wy, BRUSH.meteor);
        ui.effects.push({ kind: 'meteor', x: wx, y: wy, r: BRUSH.meteor, t0: performance.now(), dur: 900, color: '#ffa04a' });
        refreshLog();
        break;
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const m = ui.mouse;
    m.down = true; m.moved = false;
    m.sx = e.offsetX; m.sy = e.offsetY; m.camX = ui.cam.x; m.camY = ui.cam.y;
    m.pan = ui.tool === 'inspect' || e.button !== 0;
    if (!m.pan) {
      const [wx, wy] = toWorld(e.offsetX, e.offsetY);
      applyTool(wx, wy, e, true);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const m = ui.mouse;
    m.x = e.offsetX; m.y = e.offsetY; m.inside = true;
    if (!m.down) return;
    if (m.pan) {
      const dx = e.offsetX - m.sx, dy = e.offsetY - m.sy;
      if (!m.moved && dx * dx + dy * dy > 16) { m.moved = true; canvas.classList.add('dragging'); ui.follow = false; }
      if (m.moved) {
        const s = scale();
        ui.cam.x = m.camX - dx / s;
        ui.cam.y = m.camY - dy / s;
        clampCam();
      }
    } else if (ui.tool === 'food') {
      const [wx, wy] = toWorld(e.offsetX, e.offsetY);
      applyTool(wx, wy, e, false);
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    const m = ui.mouse;
    if (m.down && m.pan && !m.moved && ui.tool === 'inspect') {
      const [wx, wy] = toWorld(e.offsetX, e.offsetY);
      select(world.findAt(wx, wy, Math.max(10, 16 / scale())));
    }
    m.down = false;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('pointerleave', () => { ui.mouse.inside = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [wx, wy] = toWorld(e.offsetX, e.offsetY);
    ui.cam.zoom = clamp(ui.cam.zoom * Math.exp(-e.deltaY * 0.0015), 1, 12);
    if (!ui.follow) {
      const [nx, ny] = toWorld(e.offsetX, e.offsetY);
      ui.cam.x += wx - nx;
      ui.cam.y += wy - ny;
      clampCam();
    }
  }, { passive: false });

  function setTool(tool) {
    ui.tool = tool;
    for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
    canvas.className = `tool-${tool}`;
  }
  for (const b of document.querySelectorAll('.tool')) b.addEventListener('click', () => setTool(b.dataset.tool));
  setTool('inspect');

  function select(o) {
    ui.selected = o || null;
    if (!o) ui.follow = false;
    renderInspector(true);
  }

  // ======================================================================
  // Controls
  // ======================================================================
  function paintRange(input) {
    const p = (input.value - input.min) / (input.max - input.min) * 100;
    input.style.setProperty('--fill', `${p}%`);
  }

  function bindRange(id, outId, apply, fmt) {
    const input = $(id), out = $(outId);
    const update = () => { const v = Number(input.value); apply(v); out.textContent = fmt(v); paintRange(input); };
    input.addEventListener('input', update);
    update();
  }

  bindRange('speed', 'speedOut', (v) => { ui.speedIndex = v; }, (v) => `${SPEEDS[v]}×`);
  bindRange('food', 'foodOut', (v) => { world.cfg.foodRate = v / 100; }, (v) => `${v}%`);
  bindRange('mutRate', 'mutRateOut', (v) => { world.cfg.mutationRate = v / 100; }, (v) => `${v}%`);
  bindRange('mutStr', 'mutStrOut', (v) => { world.cfg.mutationStrength = v / 100; }, (v) => `${v}%`);

  $('seasons').addEventListener('change', (e) => { world.cfg.seasons = e.target.checked; });
  $('showVision').addEventListener('change', (e) => { ui.showVision = e.target.checked; });
  $('showZones').addEventListener('change', (e) => { ui.showZones = e.target.checked; });
  $('showTrails').addEventListener('change', (e) => { ui.showTrails = e.target.checked; });
  $('colorBy').addEventListener('change', (e) => {
    ui.colorBy = e.target.value;
    $('gradientKey').hidden = ui.colorBy === 'lineage';
  });

  function togglePause() {
    ui.running = !ui.running;
    const b = $('pauseBtn');
    b.textContent = ui.running ? 'Pause' : 'Resume';
    b.classList.toggle('paused', !ui.running);
    $('stepBtn').disabled = ui.running;
  }

  function stepOnce() {
    if (ui.running) return;
    world.step();
    updateTrails();
    updatePanels();
  }

  function resetWorld() {
    world.reset();
    ui.selected = null;
    ui.follow = false;
    ui.trails.clear();
    ui.lastEventId = 0;
    $('log').innerHTML = '';
    $('extinctOverlay').hidden = true;
    fitView();
    updatePanels();
    renderInspector(true);
  }

  function releasePredators() {
    world.introducePredators(10);
    refreshLog();
  }

  $('pauseBtn').addEventListener('click', togglePause);
  $('stepBtn').addEventListener('click', stepOnce);
  $('resetBtn').addEventListener('click', resetWorld);
  $('extinctResetBtn').addEventListener('click', resetWorld);
  $('addPredBtn').addEventListener('click', releasePredators);
  $('removePredBtn').addEventListener('click', () => { world.removePredators(); refreshLog(); });
  $('fitBtn').addEventListener('click', fitView);
  $('reseedBtn').addEventListener('click', () => {
    for (let i = 0; i < 40; i++) world.spawn('herb', Math.random() * world.cfg.width, Math.random() * world.cfg.height);
    world.log('40 new herbivores were seeded.', 'info');
    $('extinctOverlay').hidden = true;
    refreshLog();
  });

  // Help
  $('traitHelp').innerHTML = TRAITS.map((t) => `<li><b>${t.label}:</b> ${t.help}</li>`).join('');
  const toggleHelp = (show) => { $('helpOverlay').hidden = show === undefined ? !$('helpOverlay').hidden : !show; };
  $('helpBtn').addEventListener('click', () => toggleHelp());
  $('helpClose').addEventListener('click', () => toggleHelp(false));
  $('helpOverlay').addEventListener('click', (e) => { if (e.target.id === 'helpOverlay') toggleHelp(false); });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el.matches && el.matches('input, select, textarea') && el.type !== 'range' && el.type !== 'checkbox') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); togglePause(); }
    else if (k === 's') stepOnce();
    else if (k === 'r') resetWorld();
    else if (k === 'p') releasePredators();
    else if (k === 'h' || k === '?') toggleHelp();
    else if (k === 'f' && ui.selected) { ui.follow = !ui.follow; renderInspector(true); }
    else if (k === 'escape') { select(null); toggleHelp(false); }
    else if (k === '0') fitView();
    else if (k === '+' || k === '=') ui.cam.zoom = clamp(ui.cam.zoom * 1.25, 1, 12);
    else if (k === '-') ui.cam.zoom = clamp(ui.cam.zoom / 1.25, 1, 12);
    else if (k >= '1' && k <= '5') setTool(TOOLS[Number(k) - 1]);
  });

  // ======================================================================
  // Charts
  // ======================================================================
  function prep(c) {
    const r = c.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    return [g, r.width, r.height];
  }

  function niceMax(v) {
    if (v <= 10) return 10;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function fmtTick(t) { return t >= 10000 ? `${(t / 1000).toFixed(0)}k` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : `${t}`; }

  function axes(g, w, h, pad, yMin, yMax, labels) {
    g.font = '10px -apple-system, system-ui, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = yMin + (yMax - yMin) * i / 4;
      const y = pad.t + (1 - i / 4) * (h - pad.t - pad.b);
      g.strokeStyle = COLORS.gridLine;
      g.beginPath(); g.moveTo(pad.l, Math.round(y) + 0.5); g.lineTo(w - pad.r, Math.round(y) + 0.5); g.stroke();
      g.fillStyle = COLORS.grid;
      g.fillText(labels(v), pad.l - 5, y);
    }
  }

  const popCanvas = $('popChart');
  popCanvas.addEventListener('mousemove', (e) => { ui.popHover = e.offsetX; drawPopChart(); });
  popCanvas.addEventListener('mouseleave', () => { ui.popHover = null; drawPopChart(); });

  for (const b of document.querySelectorAll('#popLegend .key')) {
    b.addEventListener('click', () => {
      const s = b.dataset.series;
      ui.series[s] = !ui.series[s];
      b.classList.toggle('on', ui.series[s]);
      drawPopChart();
    });
  }

  function drawPopChart() {
    const [g, w, h] = prep(popCanvas);
    const H = world.history;
    if (H.length < 2) return;
    const pad = { l: 34, r: 8, t: 8, b: 20 };
    const t0 = H[0].t, t1 = H[H.length - 1].t;
    let maxY = 0;
    for (const s of H) {
      if (ui.series.herb) maxY = Math.max(maxY, s.herb);
      if (ui.series.pred) maxY = Math.max(maxY, s.pred);
      if (ui.series.food) maxY = Math.max(maxY, s.food);
    }
    maxY = niceMax(maxY * 1.05);
    const X = (t) => pad.l + (t - t0) / (t1 - t0 || 1) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - v / maxY) * (h - pad.t - pad.b);
    axes(g, w, h, pad, 0, maxY, (v) => Math.round(v));

    // Season strip along the bottom
    const sy = h - pad.b + 3;
    for (let i = 1; i < H.length; i++) {
      const sf = H[i].season;
      g.fillStyle = sf >= 1 ? `rgba(155,225,93,${(sf - 1) * 0.8})` : `rgba(140,180,255,${(1 - sf) * 0.8})`;
      g.fillRect(X(H[i - 1].t), sy, X(H[i].t) - X(H[i - 1].t) + 0.5, 3);
    }
    g.fillStyle = COLORS.grid;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(fmtTick(t0), pad.l, h - 2);
    g.textAlign = 'right';
    g.fillText(fmtTick(t1), w - pad.r, h - 2);

    const line = (key, color, opts = {}) => {
      g.beginPath();
      H.forEach((s, i) => (i ? g.lineTo(X(s.t), Y(s[key])) : g.moveTo(X(s.t), Y(s[key]))));
      if (opts.fill) {
        const path = new Path2D();
        H.forEach((s, i) => (i ? path.lineTo(X(s.t), Y(s[key])) : path.moveTo(X(s.t), Y(s[key]))));
        path.lineTo(X(t1), Y(0)); path.lineTo(X(t0), Y(0)); path.closePath();
        const grad = g.createLinearGradient(0, pad.t, 0, h - pad.b);
        grad.addColorStop(0, opts.fill); grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fill(path);
      }
      g.setLineDash(opts.dash || []);
      g.strokeStyle = color;
      g.lineWidth = opts.width || 1.6;
      g.stroke();
      g.setLineDash([]);
    };
    if (ui.series.food) line('food', 'rgba(155,225,93,.75)', { dash: [3, 3], width: 1.2 });
    if (ui.series.herb) line('herb', COLORS.herb, { fill: 'rgba(79,209,197,.22)' });
    if (ui.series.pred) line('pred', COLORS.pred, { fill: 'rgba(255,107,107,.18)' });

    // Hover readout
    if (ui.popHover != null && ui.popHover >= pad.l) {
      const tt = t0 + (ui.popHover - pad.l) / (w - pad.l - pad.r) * (t1 - t0);
      let best = H[0];
      for (const s of H) if (Math.abs(s.t - tt) < Math.abs(best.t - tt)) best = s;
      const x = X(best.t);
      g.strokeStyle = 'rgba(255,255,255,.25)';
      g.beginPath(); g.moveTo(x + 0.5, pad.t); g.lineTo(x + 0.5, h - pad.b); g.stroke();
      const rows = [[`tick ${best.t}`, '#dbe4f0']];
      if (ui.series.herb) rows.push([`herbivores ${best.herb}`, COLORS.herb]);
      if (ui.series.pred) rows.push([`predators ${best.pred}`, COLORS.pred]);
      if (ui.series.food) rows.push([`food ${best.food}`, COLORS.food]);
      const bw = 104, bh = rows.length * 14 + 8;
      const bx = x + 8 + bw > w ? x - bw - 8 : x + 8;
      g.fillStyle = 'rgba(10,14,22,.92)';
      g.strokeStyle = '#273245';
      g.beginPath(); g.roundRect(bx, pad.t, bw, bh, 6); g.fill(); g.stroke();
      g.textAlign = 'left'; g.textBaseline = 'top';
      rows.forEach(([text, color], i) => { g.fillStyle = color; g.fillText(text, bx + 8, pad.t + 5 + i * 14); });
    }
  }

  // Evolution chart
  const traitCanvas = $('traitChart');
  $('traitTabs').innerHTML = TRAITS.map((t) => `<button data-trait="${t.key}" class="${t.key === ui.trait ? 'on' : ''}">${t.label}</button>`).join('');
  for (const b of document.querySelectorAll('#traitTabs button')) {
    b.addEventListener('click', () => {
      ui.trait = b.dataset.trait;
      for (const x of document.querySelectorAll('#traitTabs button')) x.classList.toggle('on', x === b);
      drawTraitChart();
    });
  }

  function drawTraitChart() {
    const [g, w, h] = prep(traitCanvas);
    const H = world.history;
    if (H.length < 2) return;
    const tr = traitByKey[ui.trait];
    const pad = { l: 34, r: 8, t: 8, b: 16 };
    const t0 = H[0].t, t1 = H[H.length - 1].t;

    let lo = Infinity, hi = -Infinity;
    for (const s of H) for (const kind of ['herb', 'pred']) {
      const v = s.traits[kind][tr.key];
      if (v) { lo = Math.min(lo, v.m - v.s); hi = Math.max(hi, v.m + v.s); }
    }
    if (!isFinite(lo)) return;
    const minSpan = (tr.max - tr.min) * 0.15;
    if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
    const padV = (hi - lo) * 0.1;
    lo = Math.max(tr.min, lo - padV); hi = Math.min(tr.max, hi + padV);

    const X = (t) => pad.l + (t - t0) / (t1 - t0 || 1) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
    axes(g, w, h, pad, lo, hi, (v) => v.toFixed(tr.digits ? Math.max(1, tr.digits - 1) : 0));
    g.fillStyle = COLORS.grid;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillText(fmtTick(t0), pad.l, h - 2);
    g.textAlign = 'right';
    g.fillText(fmtTick(t1), w - pad.r, h - 2);

    for (const [kind, color, band, dash] of [['herb', COLORS.herb, 'rgba(79,209,197,.15)', []], ['pred', COLORS.pred, 'rgba(255,107,107,.13)', [4, 3]]]) {
      // Split into runs where the species exists, so extinctions leave gaps.
      const runs = [];
      let cur = null;
      for (const s of H) {
        const v = s.traits[kind][tr.key];
        if (v) { if (!cur) runs.push(cur = []); cur.push([s.t, v]); } else cur = null;
      }
      for (const run of runs) {
        g.beginPath();
        run.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v.m + v.s)) : g.moveTo(X(t), Y(v.m + v.s))));
        for (let i = run.length - 1; i >= 0; i--) g.lineTo(X(run[i][0]), Y(run[i][1].m - run[i][1].s));
        g.closePath();
        g.fillStyle = band;
        g.fill();
        g.beginPath();
        run.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v.m)) : g.moveTo(X(t), Y(v.m))));
        g.setLineDash(dash);
        g.strokeStyle = color;
        g.lineWidth = 1.6;
        g.stroke();
        g.setLineDash([]);
      }
    }
  }

  // Histograms
  $('hists').innerHTML = TRAITS.map((t) =>
    `<div class="hist"><div class="label"><span>${t.label}</span><b id="hm-${t.key}">–</b></div><canvas id="h-${t.key}"></canvas></div>`).join('');

  function drawHistograms() {
    const BINS = 24;
    for (const t of TRAITS) {
      const [g, w, h] = prep($(`h-${t.key}`));
      const herb = new Array(BINS).fill(0), pred = new Array(BINS).fill(0);
      let sum = 0, n = 0;
      for (const o of world.organisms) {
        const v = o.genes[t.key];
        const b = clamp(Math.floor((v - t.min) / (t.max - t.min) * BINS), 0, BINS - 1);
        (o.kind === 'herb' ? herb : pred)[b]++;
        if (o.kind === 'herb') { sum += v; n++; }
      }
      $(`hm-${t.key}`).textContent = n ? (sum / n).toFixed(t.digits) : '–';
      const max = Math.max(1, ...herb, ...pred);
      const bw = w / BINS;
      g.fillStyle = '#151c28';
      g.fillRect(0, h - 1, w, 1);
      for (let i = 0; i < BINS; i++) {
        if (herb[i]) {
          const bh = Math.max(1.5, herb[i] / max * (h - 2));
          g.fillStyle = 'rgba(79,209,197,.75)';
          g.fillRect(i * bw + 0.5, h - 1 - bh, bw - 1, bh);
        }
        if (pred[i]) {
          const bh = Math.max(1.5, pred[i] / max * (h - 2));
          g.fillStyle = 'rgba(255,107,107,.8)';
          g.fillRect(i * bw + bw * 0.25, h - 1 - bh, bw * 0.5, bh);
        }
      }
      // Marker for the selected organism
      const sel = ui.selected;
      if (sel) {
        const x = (sel.genes[t.key] - t.min) / (t.max - t.min) * w;
        g.fillStyle = '#ffffff';
        g.fillRect(Math.round(x) - 0.5, 0, 1.5, h);
      }
    }
  }

  // ======================================================================
  // Side panels
  // ======================================================================
  const STATE_LABEL = { wander: 'wandering', forage: 'foraging', flee: 'fleeing!', hunt: 'hunting', rest: 'digesting', scavenge: 'scavenging' };

  function updateStats() {
    const herbs = world.organisms.filter((o) => o.kind === 'herb');
    const preds = world.organisms.filter((o) => o.kind === 'pred');
    const oldest = world.organisms.reduce((a, o) => (!a || o.age > a.age ? o : a), null);
    const dh = world.stats.deaths.herb, dp = world.stats.deaths.pred;
    const avgGen = (arr) => arr.length ? (arr.reduce((a, o) => a + o.gen, 0) / arr.length).toFixed(1) : '–';
    const rows = [
      ['Herbivores', herbs.length, 'c-herb'],
      ['Predators', preds.length, 'c-pred'],
      ['Food', world.food.length, 'c-food'],
      ['Carcasses', world.carcasses.length],
      'sep',
      ['Season', `${world.seasonName()} · ${Math.round(world.seasonFactor() * 100)}% growth`],
      ['Highest generation', `${world.stats.maxGen.herb} / ${world.stats.maxGen.pred}`],
      ['Average generation', `${avgGen(herbs)} / ${avgGen(preds)}`],
      ['Oldest living', oldest ? `#${oldest.id} · ${oldest.age} ticks` : '–'],
      'sep',
      ['Births', world.stats.births],
      ['Herbivores starved', dh.starved],
      ['Herbivores eaten', dh.eaten],
      ['Died of old age', dh['old age'] + dp['old age']],
      ['Predators starved', dp.starved],
      ['Meteor victims', dh.meteor + dp.meteor],
      'sep',
      ['World seed', world.seed],
    ];
    $('stats').innerHTML = rows.map((r) => r === 'sep' ? '<div class="sep"></div>'
      : `<dt>${r[0]}</dt><dd class="${r[2] || ''}">${typeof r[1] === 'number' ? r[1].toLocaleString() : r[1]}</dd>`).join('');
  }

  function speciesMeans(kind) {
    const m = {}; let n = 0;
    for (const t of TRAITS) m[t.key] = 0;
    for (const o of world.organisms) if (o.kind === kind) { n++; for (const t of TRAITS) m[t.key] += o.genes[t.key]; }
    for (const t of TRAITS) m[t.key] = n ? m[t.key] / n : null;
    return m;
  }

  function renderInspector(force) {
    const el = $('inspector');
    const o = ui.selected;
    if (!o) {
      if (force || !el.querySelector('.empty')) {
        el.innerHTML = '<p class="empty">Pick the <b>Inspect</b> tool and click an organism to see its genome, energy and family history. Press <kbd>F</kbd> to follow it.</p>';
      }
      return;
    }
    const means = speciesMeans(o.kind);
    const color = colorFor(o);
    const state = o.alive ? (STATE_LABEL[o.state] || o.state) : `died: ${o.cause}`;
    const isPredator = o.kind === 'pred';
    const traitRows = TRAITS.map((t) => {
      const p = (o.genes[t.key] - t.min) / (t.max - t.min) * 100;
      const mp = means[t.key] != null ? (means[t.key] - t.min) / (t.max - t.min) * 100 : null;
      return `<div class="trait-row" title="${t.help}"><span class="name">${t.label}</span>
        <div class="trait-track"><i class="fill" style="width:${p}%;background:${isPredator ? COLORS.pred : COLORS.herb}"></i>
        ${mp != null ? `<i class="mean" style="left:${mp}%"></i>` : ''}</div>
        <span class="val">${o.genes[t.key].toFixed(t.digits)}</span></div>`;
    }).join('');
    const breeding = o.reproThreshold > o.maxEnergy ? 'infertile (too costly)' : o.age < o.maturity ? `matures at ${o.maturity}` : 'adult';
    el.innerHTML = `
      <div class="insp-head">
        <span class="insp-dot ${o.kind}" style="background:${color};color:${color}"></span>
        <div><div class="insp-title">${isPredator ? 'Predator' : 'Herbivore'} #${o.id}</div>
        <div class="insp-sub">Generation ${o.gen}${o.parentId ? ` · child of #${o.parentId}` : ' · founder'}</div></div>
        <span class="insp-state ${o.alive ? '' : 'dead'}">${state}</span>
      </div>
      <div class="row" style="display:flex;justify-content:space-between;color:var(--muted);font-size:11.5px">
        <span>Energy</span><span>${Math.max(0, o.energy).toFixed(0)} / ${o.maxEnergy.toFixed(0)}</span></div>
      <div class="bar"><i style="width:${clamp(o.energy / o.maxEnergy * 100, 0, 100)}%"></i></div>
      <div class="insp-grid">
        <div><b>${o.age}</b><span>age</span></div>
        <div><b>${o.children}</b><span>children</span></div>
        <div><b>${o.meals}</b><span>${isPredator ? 'meals' : 'food eaten'}</span></div>
      </div>
      ${traitRows}
      <p class="insp-note">Burns ${world.metabolism(o, o.lastSpeed).toFixed(3)} energy/tick · ${breeding}. White tick = species average.</p>
      <div class="insp-actions">
        <button class="btn ${ui.follow ? 'on' : ''}" id="followBtn" ${o.alive ? '' : 'disabled'}>${ui.follow ? 'Following' : 'Follow'}</button>
        <button class="btn" id="deselectBtn">Deselect</button>
      </div>`;
    $('followBtn').onclick = () => { ui.follow = !ui.follow; renderInspector(true); };
    $('deselectBtn').onclick = () => select(null);
  }

  function refreshLog() {
    const evs = world.events;
    const latest = evs.length ? evs[evs.length - 1].id : 0;
    if (latest === ui.lastEventId) return;
    const prev = ui.lastEventId;
    ui.lastEventId = latest;
    $('log').innerHTML = evs.slice(-40).reverse().map((e) =>
      `<li class="${e.type} ${e.id > prev && prev ? 'fresh' : ''}"><time>${fmtTick(e.tick)}</time><span>${e.text}</span></li>`).join('');
  }

  function updateHeader() {
    $('tickLabel').textContent = world.tick.toLocaleString();
    const pill = $('seasonPill');
    const name = world.seasonName();
    pill.textContent = name;
    pill.className = `pill ${world.cfg.seasons ? name.toLowerCase() : 'none'}`;
    $('tpsLabel').textContent = `${Math.round(ui.tps)} ticks/s`;
    $('zoomLabel').textContent = `${Math.round(ui.cam.zoom * 100)}%`;
  }

  function updatePanels() {
    updateHeader();
    updateStats();
    drawPopChart();
    drawTraitChart();
    drawHistograms();
    refreshLog();
    if (ui.selected) renderInspector(false);
    if (world.counts.herb === 0 && $('extinctOverlay').hidden) {
      $('extinctText').textContent = `Every herbivore has died after ${world.tick.toLocaleString()} ticks and ${world.stats.maxGen.herb} generations.`;
      $('extinctOverlay').hidden = false;
    } else if (world.counts.herb > 0) {
      $('extinctOverlay').hidden = true;
    }
  }

  // ======================================================================
  // Main loop
  // ======================================================================
  function frame(now) {
    if (ui.running) {
      ui.acc += SPEEDS[ui.speedIndex];
      let steps = Math.floor(ui.acc);
      ui.acc -= steps;
      const start = performance.now();
      while (steps-- > 0) {
        world.step();
        ui.tpsTicks++;
        if (performance.now() - start > 22) { ui.acc = 0; break; } // keep the UI responsive
      }
      updateTrails();
    }

    if (now - ui.tpsTime > 1000) {
      ui.tps = ui.tpsTicks * 1000 / (now - ui.tpsTime);
      ui.tpsTicks = 0;
      ui.tpsTime = now;
    }

    const sel = ui.selected;
    if (ui.follow && sel && sel.alive) {
      ui.cam.x += (sel.x - ui.cam.x) * 0.12;
      ui.cam.y += (sel.y - ui.cam.y) * 0.12;
      if (ui.cam.zoom < 2.5) ui.cam.zoom += (2.5 - ui.cam.zoom) * 0.05;
    } else if (ui.follow && sel && !sel.alive) {
      ui.follow = false;
    }

    render();
    if (now - ui.lastPanels > 200) { updatePanels(); ui.lastPanels = now; }
    requestAnimationFrame(frame);
  }

  // Optional URL parameters, e.g. index.html?warmup=20000&predators=5000&select=1
  // fast-forward the world before showing it.
  const params = new URLSearchParams(location.search);
  const warmup = Math.min(200000, Number(params.get('warmup')) || 0);
  const predAt = params.has('predators') ? Number(params.get('predators')) || 0 : -1;
  for (let i = 0; i < warmup; i++) {
    if (i === predAt) world.introducePredators(10);
    world.step();
  }
  if (predAt >= 0 && predAt >= warmup) world.introducePredators(10);
  if (params.has('select')) select(world.organisms.find((o) => o.kind === 'pred') || world.organisms[0]);

  updatePanels();
  renderInspector(true);
  requestAnimationFrame(frame);
})();
