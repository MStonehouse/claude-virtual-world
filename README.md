# Primordia: an artificial life sandbox

A browser-based artificial life simulation. Simple organisms search for food, burn energy, reproduce, and pass their genes on with random mutations. Nothing is scripted to survive: natural selection emerges from each organism's energy budget.

**Live demo:** https://mstonehouse.github.io/claude-virtual-world/

## Running it locally

There's no build step and nothing to install. Double-click `index.html`, or run a tiny local web server:

```sh
cd path/to/this/folder
python3 -m http.server 8000
# then open http://localhost:8000
```

## What's in the world

- **Herbivores** (circles) eat the green food pellets.
- **Predators** (arrowheads) hunt herbivores and scavenge carrion. Release them with the *Release 10* button or the Predator tool.
- **Genes:** each organism inherits *speed*, *vision*, *efficiency* and *size* from its parent. Each one helps in some way and costs in another. For example, energy spent on movement grows with the square of speed, and efficient bodies mature later and cost more to give birth to.
- **Fertile zones** drift around the map and grow most of the food. Their dense centres are **tall grass**, where predators can only spot prey up close.
- **Seasons** change how quickly food grows. Herbivores that starve leave carrion behind.

## Controls

| Control | What it does |
| --- | --- |
| Speed | Ticks simulated per frame (0.25× to 32×) |
| Food abundance | How quickly food grows |
| Mutation rate / strength | How often genes change at birth, and by how much |
| Seasons | Turn the seasonal food cycle on or off |
| Tools (bottom bar) | Inspect, Feed, place a Herbivore or Predator, Meteor |
| Colour by | Colour organisms by lineage, by any trait, or by energy |

**Keyboard:** `Space` pause · `S` step · `R` reset · `P` release predators · `1`–`5` tools · `F` follow the selected organism · `Esc` deselect · scroll to zoom · drag to pan.

**URL options:** `index.html?warmup=20000&predators=5000` fast-forwards 20,000 ticks before the page appears and releases predators at tick 5,000.

## Files

- `index.html`: page layout
- `style.css`: dark theme
- `sim.js`: the simulation engine (no browser APIs, so it can run headless)
- `app.js`: rendering, controls, charts, inspector
