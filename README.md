# Perihelion

A tiny procedural solar-system explorer for the browser. Fly a little ship through a seeded
star system, land on planets, and fill your codex. Works on phones (touch) and laptops (mouse).

**Play:** https://briskam.github.io/perihelion/

## Controls
- Drag anywhere to fly (a floating stick: direction steers, distance sets thrust).
- `A` or the AUTO button toggles the autopilot. `M` opens the menu.
- `?seed=12345` loads a specific system, `?auto` starts on autopilot. No seed means today's system.

## Features
- Seeded universe: one star, 1-10 planets on Kepler orbits, generated names and descriptions.
- Saved progress (browser localStorage): codex of discoveries, credits, upgrades.
- Missions (survey, visit, voyage) that come from the seed, so a shared link means shared jobs.
- Optional survival layer: fuel, refuelling on landing, and a star-corona heat hazard.
- Ship upgrades bought with credits; ranks as you discover more planets.

## Credits
Inspired by the space Easter egg in Android. This project contains no Google code, art or text:
the simulation is a fresh implementation and all word lists, shapes and textures are original.
"Android" and its logo are trademarks of Google LLC, which is not affiliated with this project.

## License
MIT, see `LICENSE`.
