/*
 * Primordia – simulation engine.
 *
 * Pure logic, no DOM. The world holds food pellets and two species of
 * organisms (herbivores and predators). Every organism carries a genome of
 * heritable traits. Nothing decides who survives except the energy budget:
 * eat more than you burn and you live long enough to reproduce, otherwise
 * you starve. Offspring inherit their parent's genes with random mutations.
 */
(function (root) {
  'use strict';

  // ---------- Seeded random numbers so a run can be reproduced ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const TAU = Math.PI * 2;

  // Heritable traits. `herb` / `pred` are the starting values for each species.
  const TRAITS = [
    { key: 'speed',      label: 'Speed',      min: 0.3, max: 4.0, herb: 1.3, pred: 1.5, digits: 2,
      help: 'How fast it moves. Fast movers catch food and escape, but burn energy with the square of speed.' },
    { key: 'vision',     label: 'Vision',     min: 10,  max: 220, herb: 50,  pred: 80,  digits: 0,
      help: 'How far it can see food, prey or danger. Better senses cost energy every tick.' },
    { key: 'efficiency', label: 'Efficiency', min: 0.4, max: 2.5, herb: 1.0, pred: 1.0, digits: 2,
      help: 'Divides all running costs, but efficient bodies mature later and cost more to give birth to.' },
    { key: 'size',       label: 'Size',       min: 0.5, max: 2.5, herb: 1.0, pred: 1.3, digits: 2,
      help: 'Bigger bodies store more energy and win fights, but cost more to run and turn more slowly.' },
  ];

  const SPECIES = {
    herb: { basal: 0.012, move: 0.011, sense: 0.00030, maxEnergy: 80,  maturity: 150, lifespan: 3000, birthCost: 0.08, radius: 4, sprint: 1.15, breedAt: 0.6 },
    pred: { basal: 0.010, move: 0.010, sense: 0.00022, maxEnergy: 220, maturity: 400, lifespan: 4200, birthCost: 0.08, radius: 5.5, sprint: 1.45,
            breedAt: 0.45, killEnergy: 18, digest: 100, carrionEnergy: 16, carrionLife: 900, spotInCover: 25 },
  };

  const DEFAULTS = {
    width: 1600,
    height: 1000,
    foodRate: 1.0,          // multiplier set by the UI
    baseFoodPerTick: 0.9,
    maxFood: 900,
    foodEnergy: 14,
    mutationRate: 0.12,     // chance each gene mutates at birth
    mutationStrength: 0.12, // typical size of a mutation (fraction of the value)
    seasons: true,
    seasonLength: 3000,
    coverRadius: 0.5,     // fraction of a fertile zone that is tall grass
    initialHerbivores: 60,
    initialFood: 350,
    maxPopulation: 1600,
  };

  // ---------- Uniform spatial grid for fast "what's near me" queries ----------
  class Grid {
    constructor(w, h, cell) {
      this.cell = cell;
      this.cols = Math.ceil(w / cell);
      this.rows = Math.ceil(h / cell);
      this.cells = Array.from({ length: this.cols * this.rows }, () => []);
    }
    clear() { for (const c of this.cells) c.length = 0; }
    insert(o) {
      const cx = clamp((o.x / this.cell) | 0, 0, this.cols - 1);
      const cy = clamp((o.y / this.cell) | 0, 0, this.rows - 1);
      this.cells[cy * this.cols + cx].push(o);
    }
    nearest(x, y, r, accept) {
      const c = this.cell;
      const x0 = clamp(((x - r) / c) | 0, 0, this.cols - 1), x1 = clamp(((x + r) / c) | 0, 0, this.cols - 1);
      const y0 = clamp(((y - r) / c) | 0, 0, this.rows - 1), y1 = clamp(((y + r) / c) | 0, 0, this.rows - 1);
      let best = null, bestD = r * r;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          for (const o of this.cells[cy * this.cols + cx]) {
            const dx = o.x - x, dy = o.y - y, d = dx * dx + dy * dy;
            if (d < bestD && accept(o)) { bestD = d; best = o; }
          }
        }
      }
      return best;
    }
  }

  const isPred = (o) => o.alive && o.kind === 'pred';
  const isHerb = (o) => o.alive && o.kind === 'herb';
  const isFood = (f) => !f.eaten;

  class World {
    constructor(opts = {}) {
      this.cfg = Object.assign({}, DEFAULTS, opts);
      this.reset(opts.seed);
    }

    reset(seed) {
      const cfg = this.cfg;
      this.seed = seed != null ? seed >>> 0 : (Math.random() * 4294967296) >>> 0;
      this.rng = mulberry32(this.seed);
      this.tick = 0;
      this.nextId = 1;
      this.organisms = [];
      this.food = [];
      this.carcasses = [];
      this.foodAcc = 0;
      this.counts = { herb: 0, pred: 0 };
      this.stats = {
        births: 0,
        deaths: {
          herb: { starved: 0, eaten: 0, 'old age': 0, meteor: 0 },
          pred: { starved: 0, eaten: 0, 'old age': 0, meteor: 0 },
        },
        maxGen: { herb: 0, pred: 0 },
      };
      this.history = [];
      this.historyEvery = 10;
      this.events = [];
      this.eventId = 0;
      this.foodGrid = new Grid(cfg.width, cfg.height, 40);
      this.orgGrid = new Grid(cfg.width, cfg.height, 40);
      this.carcGrid = new Grid(cfg.width, cfg.height, 40);

      // Fertile zones drift slowly around the map; most food grows near them.
      this.hotspots = [];
      for (let i = 0; i < 3; i++) {
        const a = this.rng() * TAU;
        this.hotspots.push({
          x: cfg.width * (0.2 + 0.6 * this.rng()),
          y: cfg.height * (0.2 + 0.6 * this.rng()),
          vx: Math.cos(a) * 0.06, vy: Math.sin(a) * 0.06,
          r: 110 + this.rng() * 90,
        });
      }

      for (let i = 0; i < cfg.initialFood; i++) this.addFood();
      for (let i = 0; i < cfg.initialHerbivores; i++) {
        this.organisms.push(this.makeOrganism('herb', this.rng() * cfg.width, this.rng() * cfg.height, this.randomGenes('herb')));
      }
      this.countPopulations();
      this.log(`A new world begins (seed ${this.seed}).`, 'info');
      this.record();
    }

    // ---------- helpers ----------
    gauss() {
      let u = 0, v = 0;
      while (u === 0) u = this.rng();
      while (v === 0) v = this.rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
    }

    log(text, type = 'info') {
      this.events.push({ id: ++this.eventId, tick: this.tick, text, type });
      if (this.events.length > 80) this.events.shift();
    }

    seasonFactor() {
      if (!this.cfg.seasons) return 1;
      return 1 + 0.65 * Math.sin(TAU * this.tick / this.cfg.seasonLength);
    }

    seasonName() {
      if (!this.cfg.seasons) return 'Eternal spring';
      const p = (this.tick % this.cfg.seasonLength) / this.cfg.seasonLength;
      if (p < 0.125 || p >= 0.875) return 'Spring';
      if (p < 0.375) return 'Summer';
      if (p < 0.625) return 'Autumn';
      return 'Winter';
    }

    randomGenes(kind) {
      const g = { hue: this.rng() * 360 };
      for (const t of TRAITS) g[t.key] = clamp(t[kind] * (1 + this.gauss() * 0.08), t.min, t.max);
      return g;
    }

    mutate(genes) {
      const { mutationRate, mutationStrength } = this.cfg;
      const g = Object.assign({}, genes);
      for (const t of TRAITS) {
        if (this.rng() < mutationRate) g[t.key] = clamp(g[t.key] * (1 + this.gauss() * mutationStrength), t.min, t.max);
      }
      // Hue carries no fitness; it just lets you watch lineages spread.
      if (this.rng() < mutationRate) g.hue = (g.hue + this.gauss() * 18 + 360) % 360;
      return g;
    }

    makeOrganism(kind, x, y, genes, parent = null) {
      const sp = SPECIES[kind];
      const maxEnergy = sp.maxEnergy * genes.size;
      const birthCost = sp.maxEnergy * genes.size * sp.birthCost * genes.efficiency * genes.efficiency;
      return {
        id: this.nextId++,
        kind,
        x: clamp(x, 0, this.cfg.width),
        y: clamp(y, 0, this.cfg.height),
        heading: this.rng() * TAU,
        wander: 0,
        genes,
        radius: sp.radius * Math.sqrt(genes.size),
        maxEnergy,
        energy: maxEnergy * 0.5,
        birthCost,
        reproThreshold: maxEnergy * sp.breedAt + birthCost, // above maxEnergy = can never breed
        maturity: Math.round(sp.maturity * Math.pow(genes.efficiency, 1.2)),
        lifespan: Math.round(sp.lifespan * (0.85 + 0.3 * this.rng())),
        age: 0,
        gen: parent ? parent.gen + 1 : 0,
        parentId: parent ? parent.id : null,
        children: 0,
        meals: 0,
        cooldown: 0,
        lastSpeed: 0,
        state: 'wander',
        target: null,
        alive: true,
        cause: null,
        bornAt: this.tick,
      };
    }

    addFood(x, y) {
      const cfg = this.cfg;
      if (x == null) {
        if (this.rng() < 0.6) {
          const h = this.hotspots[(this.rng() * this.hotspots.length) | 0];
          x = h.x + this.gauss() * h.r * 0.6;
          y = h.y + this.gauss() * h.r * 0.6;
        } else {
          x = this.rng() * cfg.width;
          y = this.rng() * cfg.height;
        }
      }
      this.food.push({ x: clamp(x, 2, cfg.width - 2), y: clamp(y, 2, cfg.height - 2), energy: cfg.foodEnergy, eaten: false, bornAt: this.tick });
    }

    // The dense centre of each fertile zone is tall grass.
    inCover(x, y) {
      const k = this.cfg.coverRadius;
      for (const h of this.hotspots) {
        const r = h.r * k;
        if ((x - h.x) ** 2 + (y - h.y) ** 2 < r * r) return true;
      }
      return false;
    }

    metabolism(o, speed) {
      const sp = SPECIES[o.kind], g = o.genes;
      const basal = sp.basal * Math.pow(g.size, 1.4);
      const move = sp.move * speed * speed * g.size;
      const sense = sp.sense * g.vision;
      return (basal + move + sense) / g.efficiency;
    }

    countPopulations() {
      let herb = 0, pred = 0;
      for (const o of this.organisms) if (o.alive) (o.kind === 'herb' ? herb++ : pred++);
      this.counts = { herb, pred };
    }

    // ---------- the main tick ----------
    step() {
      this.tick++;
      this.spawnFood();
      this.moveHotspots();

      this.foodGrid.clear();
      for (const f of this.food) this.foodGrid.insert(f);
      this.orgGrid.clear();
      for (const o of this.organisms) this.orgGrid.insert(o);

      // Carcasses rot away after a while.
      const rot = SPECIES.pred.carrionLife;
      for (const c of this.carcasses) if (this.tick - c.bornAt > rot) c.eaten = true;
      this.carcasses = this.carcasses.filter(isFood);
      this.carcGrid.clear();
      for (const c of this.carcasses) this.carcGrid.insert(c);

      const born = [];
      for (const o of this.organisms) {
        if (!o.alive) continue; // may have been eaten earlier this tick
        if (o.kind === 'herb') this.updateHerb(o); else this.updatePred(o);
        this.live(o, born);
      }

      if (born.length) for (const b of born) this.organisms.push(b);
      this.organisms = this.organisms.filter((o) => o.alive);
      this.food = this.food.filter(isFood);

      const prev = this.counts;
      this.countPopulations();
      if (prev.herb > 0 && this.counts.herb === 0) this.log('Herbivores have gone extinct.', 'death');
      if (prev.pred > 0 && this.counts.pred === 0) this.log('Predators have gone extinct.', 'death');

      if (this.tick % this.historyEvery === 0) this.record();
    }

    spawnFood() {
      const cfg = this.cfg;
      this.foodAcc += cfg.baseFoodPerTick * cfg.foodRate * this.seasonFactor();
      const cap = cfg.maxFood * Math.max(0.3, cfg.foodRate);
      while (this.foodAcc >= 1) {
        this.foodAcc -= 1;
        if (this.food.length < cap) this.addFood();
      }
    }

    moveHotspots() {
      const { width, height } = this.cfg;
      for (const h of this.hotspots) {
        h.x += h.vx; h.y += h.vy;
        if (h.x < h.r * 0.5 || h.x > width - h.r * 0.5) h.vx *= -1;
        if (h.y < h.r * 0.5 || h.y > height - h.r * 0.5) h.vy *= -1;
      }
    }

    // Turn toward a desired direction (limited turn rate) and move.
    move(o, dx, dy, speed) {
      const { width, height } = this.cfg;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const m = 40; // push away from walls
      if (o.x < m) dx += (m - o.x) / m * 1.5;
      if (o.x > width - m) dx -= (o.x - (width - m)) / m * 1.5;
      if (o.y < m) dy += (m - o.y) / m * 1.5;
      if (o.y > height - m) dy -= (o.y - (height - m)) / m * 1.5;

      let diff = Math.atan2(dy, dx) - o.heading;
      diff = ((diff + Math.PI) % TAU + TAU) % TAU - Math.PI;
      const turn = 0.22 / Math.sqrt(o.genes.size);
      o.heading += clamp(diff, -turn, turn);
      o.x = clamp(o.x + Math.cos(o.heading) * speed, 0, width);
      o.y = clamp(o.y + Math.sin(o.heading) * speed, 0, height);
      o.lastSpeed = speed;
    }

    wanderDir(o) {
      o.wander = clamp(o.wander * 0.9 + (this.rng() - 0.5) * 0.5, -1.2, 1.2);
      const a = o.heading + o.wander;
      return [Math.cos(a), Math.sin(a)];
    }

    updateHerb(o) {
      const g = o.genes;
      let dx, dy, speed = g.speed * 0.6;
      o.state = 'wander';
      o.target = null;

      if (this.counts.pred > 0) {
        const p = this.orgGrid.nearest(o.x, o.y, g.vision, isPred);
        if (p) {
          dx = o.x - p.x; dy = o.y - p.y;
          speed = g.speed * SPECIES.herb.sprint;
          o.state = 'flee'; o.target = p;
        }
      }
      if (o.state === 'wander') {
        const f = this.foodGrid.nearest(o.x, o.y, g.vision, isFood);
        if (f) {
          dx = f.x - o.x; dy = f.y - o.y;
          const d = Math.hypot(dx, dy);
          speed = g.speed;
          o.state = 'forage'; o.target = f;
          if (d <= o.radius + 2 + speed) {
            f.eaten = true;
            o.energy = Math.min(o.maxEnergy, o.energy + f.energy);
            o.meals++;
            speed = Math.min(speed, d);
          }
        }
      }
      if (o.state === 'wander') [dx, dy] = this.wanderDir(o);
      this.move(o, dx, dy, speed);
    }

    updatePred(o) {
      const g = o.genes;
      let dx, dy, speed;
      o.target = null;

      if (o.cooldown > 0) {
        o.cooldown--;
        o.state = 'rest';
        speed = g.speed * 0.35;
        [dx, dy] = this.wanderDir(o);
      } else {
        // Herbivores hiding in tall grass are only spotted from close range.
        const spot2 = SPECIES.pred.spotInCover ** 2;
        const prey = this.orgGrid.nearest(o.x, o.y, g.vision, (q) =>
          isHerb(q) && (!this.inCover(q.x, q.y) || (q.x - o.x) ** 2 + (q.y - o.y) ** 2 < spot2));
        const carc = this.carcGrid.nearest(o.x, o.y, g.vision, isFood);
        const dPrey = prey ? Math.hypot(prey.x - o.x, prey.y - o.y) : Infinity;
        const dCarc = carc ? Math.hypot(carc.x - o.x, carc.y - o.y) : Infinity;
        if (carc && dCarc < dPrey * 1.5) {
          // Scavenging: carrion can't run away.
          dx = carc.x - o.x; dy = carc.y - o.y;
          speed = g.speed;
          o.state = 'scavenge'; o.target = carc;
          if (dCarc <= o.radius + 3 + speed) {
            carc.eaten = true;
            o.energy = Math.min(o.maxEnergy, o.energy + carc.energy);
            o.meals++;
            o.cooldown = 30;
            speed = Math.min(speed, dCarc);
          }
        } else if (prey) {
          dx = prey.x - o.x; dy = prey.y - o.y;
          speed = g.speed * SPECIES.pred.sprint;
          o.state = 'hunt'; o.target = prey;
          if (dPrey <= o.radius + prey.radius + speed) this.attack(o, prey);
        } else {
          o.state = 'wander';
          speed = g.speed * 0.6;
          [dx, dy] = this.wanderDir(o);
        }
      }
      this.move(o, dx, dy, speed);
    }

    attack(pred, prey) {
      // Bigger predators win more often; big prey can fight free.
      const chance = clamp(0.25 + 0.45 * (pred.genes.size / prey.genes.size), 0.1, 0.95);
      if (this.rng() < chance) {
        const sp = SPECIES.pred;
        pred.energy = Math.min(pred.maxEnergy, pred.energy + sp.killEnergy * prey.genes.size + 0.4 * prey.energy);
        pred.meals++;
        pred.cooldown = sp.digest; // digesting
        this.kill(prey, 'eaten');
      } else {
        pred.cooldown = 15; // prey escaped, predator recovers
      }
    }

    live(o, born) {
      o.energy -= this.metabolism(o, o.lastSpeed);
      o.age++;
      if (o.energy <= 0) return this.kill(o, 'starved');
      if (o.age > o.lifespan) return this.kill(o, 'old age');
      if (o.age >= o.maturity && o.energy >= o.reproThreshold &&
          this.organisms.length + born.length < this.cfg.maxPopulation) {
        born.push(this.reproduce(o));
      }
    }

    reproduce(o) {
      const e = o.energy - o.birthCost;
      o.energy = e * 0.5;
      const a = this.rng() * TAU;
      const child = this.makeOrganism(o.kind, o.x + Math.cos(a) * o.radius * 2, o.y + Math.sin(a) * o.radius * 2, this.mutate(o.genes), o);
      child.energy = Math.min(child.maxEnergy, e * 0.5);
      o.children++;
      this.stats.births++;
      if (child.gen > this.stats.maxGen[o.kind]) {
        this.stats.maxGen[o.kind] = child.gen;
        if (child.gen % 25 === 0) this.log(`${o.kind === 'herb' ? 'Herbivores' : 'Predators'} reached generation ${child.gen}.`, 'gen');
      }
      return child;
    }

    kill(o, cause) {
      if (!o.alive) return;
      o.alive = false;
      o.cause = cause;
      o.diedAt = this.tick;
      const d = this.stats.deaths[o.kind];
      d[cause] = (d[cause] || 0) + 1;
      // Herbivores that die naturally leave a carcass predators can scavenge.
      if (o.kind === 'herb' && (cause === 'starved' || cause === 'old age')) {
        this.carcasses.push({ x: o.x, y: o.y, energy: SPECIES.pred.carrionEnergy * o.genes.size, eaten: false, bornAt: this.tick });
      }
    }

    // ---------- statistics ----------
    record() {
      const sums = {};
      for (const kind of ['herb', 'pred']) {
        sums[kind] = { n: 0 };
        for (const t of TRAITS) { sums[kind][t.key] = 0; sums[kind][t.key + '2'] = 0; }
      }
      for (const o of this.organisms) {
        const s = sums[o.kind];
        s.n++;
        for (const t of TRAITS) { const v = o.genes[t.key]; s[t.key] += v; s[t.key + '2'] += v * v; }
      }
      const traits = {};
      for (const kind of ['herb', 'pred']) {
        const s = sums[kind];
        traits[kind] = {};
        for (const t of TRAITS) {
          if (!s.n) { traits[kind][t.key] = null; continue; }
          const m = s[t.key] / s.n;
          traits[kind][t.key] = { m, s: Math.sqrt(Math.max(0, s[t.key + '2'] / s.n - m * m)) };
        }
      }
      this.history.push({ t: this.tick, herb: this.counts.herb, pred: this.counts.pred, food: this.food.length, season: this.seasonFactor(), traits });
      if (this.history.length > 1200) {
        this.history = this.history.filter((_, i) => i % 2 === 0);
        this.historyEvery *= 2;
      }
    }

    // ---------- interactive actions used by the UI ----------
    spawn(kind, x, y) {
      const o = this.makeOrganism(kind, x, y, this.randomGenes(kind));
      this.organisms.push(o);
      this.countPopulations();
      return o;
    }

    introducePredators(n = 10) {
      for (let i = 0; i < n; i++) this.spawn('pred', this.rng() * this.cfg.width, this.rng() * this.cfg.height);
      this.log(`${n} predators were released into the world.`, 'pred');
    }

    removePredators() {
      let n = 0;
      for (const o of this.organisms) if (o.kind === 'pred' && o.alive) { o.alive = false; o.cause = 'removed'; n++; }
      this.organisms = this.organisms.filter((o) => o.alive);
      this.countPopulations();
      if (n) this.log(`All ${n} predators were removed.`, 'info');
    }

    sprinkleFood(x, y, n, spread) {
      for (let i = 0; i < n; i++) this.addFood(x + this.gauss() * spread, y + this.gauss() * spread);
    }

    smite(x, y, r) {
      let n = 0;
      for (const o of this.organisms) {
        if (o.alive && Math.hypot(o.x - x, o.y - y) <= r) { this.kill(o, 'meteor'); n++; }
      }
      for (const f of this.food) if (Math.hypot(f.x - x, f.y - y) <= r) f.eaten = true;
      this.organisms = this.organisms.filter((o) => o.alive);
      this.food = this.food.filter(isFood);
      this.countPopulations();
      this.log(`A meteor struck, killing ${n} organism${n === 1 ? '' : 's'}.`, 'death');
      return n;
    }

    findAt(x, y, r) {
      let best = null, bestD = r * r;
      for (const o of this.organisms) {
        const d = (o.x - x) ** 2 + (o.y - y) ** 2;
        if (d < bestD) { bestD = d; best = o; }
      }
      return best;
    }
  }

  const api = { World, TRAITS, SPECIES, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
