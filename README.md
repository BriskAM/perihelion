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
- Procedural planet art (banded gas giants with storms, craters, cracks, continents, swirls),
  lumpy asteroids and ringed planets, all generated from each planet's own seed.
- Moons: bigger planets get up to three moons on their own orbits. You can land on them.
- Six minimal ship models (pick one in the menu), including the classic outline from the
  Android egg. Fading, speed-coloured trails with engine glow.
- Binary star systems, binary planets (two worlds orbiting each other), black holes (at the centre
  of some systems, or wandering the outer ones) and dense asteroid belts you can collide with.
- Black holes: a black horizon with a photon ring, a lensed accretion disk and violet gravity
  rings. Get close and time slows, the screen trembles and your ship stretches; cross the horizon
  and you are lost (you respawn parked on a planet, minus a quarter of your credits).
- The background grid sags into stars, black holes and big planets (switch it off in the menu).
- AI ships with their own hulls and callsigns that fly between planets and land.
- Assisted autopilot: it takes a moment to lock on, turns at a limited rate, coasts to save fuel,
  steers around the star, and hands control back when you grab the stick (it re-locks a moment
  after you let go). Turn it off in the menu for the classic instant autopilot.

## Credits
Inspired by the space Easter egg in Android. The simulation is a fresh implementation and all
word lists, textures and the other ship models are original. The one exception is the "Classic"
ship outline (`js/classic-hull.js`), the SVG path from the Android Open Source Project, used
under the Apache License 2.0 (`LICENSE-APACHE-2.0.txt`, copyright notice kept in that file).
"Android" and its logo are trademarks of Google LLC, which is not affiliated with this project.

## License
MIT, see `LICENSE`.
