# Perihelion

A tiny procedural solar-system explorer for the browser. Fly a little ship through a seeded
star system, land on planets, and fill your codex. Works on phones (touch) and laptops (mouse).

**Play:** https://briskam.github.io/perihelion/

## Controls
- Drag anywhere to fly (a floating stick: direction steers, distance sets thrust). The hull swings
  round quickly but visibly, and thrust only builds once it points the way you asked.
- Keyboard: `W`/`↑` thrust (hold `Shift` for fine), `Q`/`D` or `←`/`→` turn, `S`/`↓` swing to retrograde.
- Scroll, pinch or `+`/`-` to set how close the camera sits (`0` resets). `,` and `.` change time warp.
- `A` or AUTO toggles the autopilot, `C` or CRUISE starts AFK cruise, `P` or PIP opens the floating
  window, `V` cuts to the next cinematic shot, `M` opens the menu.
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
- Strict landing: you must slow down to touch down. The speed limit depends on the planet (heavy
  planets pull harder than the engine, so they forgive more). Too fast and you bounce and take
  damage; far too fast and the ship is destroyed. The HUD shows `REL: speed/limit` near a surface.
  Switch it off in the menu to land at any speed.
- Not every system has everything: each system rolls a character (barren, ordinary, crowded,
  deserted) that changes how many moons, rings, belts, binary planets and AI ships it gets.
- Asteroid belts differ too: some are dense, some sparse, some clumpy, with bigger or smaller rocks.
- The autopilot always charts a course to somewhere new: it picks among uncharted worlds, weighted
  toward nearer ones, steers around stars, black holes, planets and rocks, and watches its fuel.
  (Moons of very heavy planets are left to you.)
- **Our solar system** (`?system=sol`, or Menu > Options > Our solar system): Sun, eight planets, their
  moons, Pluto and Charon as a binary pair, two asteroid belts, scaled to fit the game.
- Atmospheres and gas giants: air slows you (drag grows with the square of speed) and heats you
  (with the cube), so dive too fast and you burn up. Gas giants have no surface; skim their upper air
  to survey them, but go deeper and the air crushes you. Thick air also cushions a landing.
- Planets spin. Artificial satellites orbit planets, hang over a fixed spot (geostationary), or
  coast between worlds as probes. Approach one slowly to dock for credits and fuel.
- Real orbits: planets, moons and belts move at the speed gravity would give a free-flying ship, so
  you can sit in a stable orbit around a planet.
- The autopilot aerobrakes (lets thick air do part of the braking within the heating limit), hovers
  over gas giants to survey them, routes around stars and black holes, and avoids moon swarms.
- Ship cam: when the main view is zoomed out, a small round window shows a fixed close-up of your ship
  with its velocity (green) and thrust (orange) arrows. Toggle it in the menu.
- Orbit-first landings (Options > Orbit-first landings): for planets with room for a stable orbit and no
  big moons in the way, the autopilot aims to pass low, circularises with one burn (CAPTURE), holds
  ORBITING briefly, then spirals down (DESCENT), coasting through any atmosphere so the air does the
  braking (AEROBRAKE). In my 15-system test it used about 18% less fuel per discovery and made about a
  third as many hard landings as the straight braking burn.
- Autopilot pace (Options): Calm, Normal, Fast or Turbo. It scales turning, lock-on, sightseeing and the
  orbit phases (capture, orbit hold, descent). Faster is rougher: hard landings roughly triple at Turbo.
- While the autopilot is on, the ship cam stays open. Zoomed out it shows the ship close-up; zoomed in it
  switches to a wide overview of the trip (ship, target and the route between them).
- Floating window (PIP button or P): a small always-on-top window with a low-detail view of the autopilot, so you can keep watching while using other tabs. Uses Document Picture-in-Picture (Chrome/Edge), falling back to a video PiP. Idle mode auto-rescues the ship if it runs dry. (Written but not verified in a real browser window.)
- Procedural sound: engine, air and reentry, a drone per star class, a tune for every world, plus effects. Options > Sound.
- AI ships with their own hulls and callsigns that fly between planets and land.
- Assisted autopilot: it takes a moment to lock on, turns at a limited rate, coasts to save fuel,
  steers around the star, and hands control back when you grab the stick (it re-locks a moment
  after you let go). Turn it off in the menu for the classic instant autopilot.

## Simulation and feel (the overhaul)
- **Smart camera**: zoom rides a spring in log space, so it pulls out with speed and eases back in near
  worlds without lurching. It looks ahead along your velocity, frames the autopilot's target, leans toward
  the ground when you are low, and shakes on hard landings, rock hits and nearby impacts.
- **Trajectory prediction**: inside a world's sphere of influence you see the exact conic (ellipse or
  hyperbola) with periapsis and apoapsis; out in the open the path is integrated through every moving body
  until it meets a world, which is drawn as a ghost where it will be, with your flyby orbit around it.
  The HUD shows `ORB` (Pe, Ap, period), `ENC` (encounter) or `IMPACT`, plus prograde and retrograde markers.
- **Time warp** (1x to 16x) runs extra short substeps, so orbits and collisions stay exact. It is capped
  automatically by how soon you could hit something.
- **Planets shape the belts**: big worlds carve resonance gaps (the Kirkwood gaps), raise a travelling
  bulge in the belt as they pass, and giants herd librating trojan swarms 60 degrees ahead of and behind them.
- **Comets and loose rocks** are free bodies pulled by every star, planet and moon: giants fling them,
  capture them or pull them in, and an impact leaves a glowing scar that cools into a crater. Hit a belt
  rock hard and it tumbles off on its own orbit. Comets grow ion and dust tails near the star; match speed
  with one to sample it.
- **Planet art**: lit day sides and shadowed night sides, a bright limb facing the star, atmosphere glow,
  drifting clouds, banded gas giants with storms, filled ring bands with a division, glowing lava worlds,
  city lights on the night side of living worlds, and colours set by climate (distance and star class).
- Parallax starfield with motion streaks. Ships are drawn to scale, so they look small from far out.
- **Livelier autopilot**: it remembers where it has been and does not keep revisiting the same few
  worlds. If an uncharted world is beyond even a full tank, it hops via relay worlds instead of
  refuelling in a loop. Giants too heavy to dip into are charted with a **scan pass**: a close swing just
  above the clouds (binary giants from further out, on the far side from their partner). Orbits around
  giants sit well clear of the air, and leaving an orbit is a prograde burn that spirals out. Once nothing new is in
  reach it goes on orbit tours (capture, circle a while, leave). On longer trips it often takes a
  **gravity assist**: it lines up beside a big world, coasts through the swing (trimming the pass if it
  would clip the world or go wide), and reports how far it was turned and the speed it gained or lost.
- New missions: hold a stable orbit for 30 s, and rendezvous with a comet.

## Cruise (AFK) and the floating window
- **Cruise** (`C`): the autopilot keeps exploring on its own. It warps through long coasts, is towed free
  if it runs dry, buys the cheapest upgrade it can afford and, once a system is charted (or nothing new has
  turned up for a while), jumps to a fresh system with a hyperspace transition and title card. It keeps
  running in a background tab and stays on across reloads. When you come back it shows what happened
  while you were away. Grab the stick any time and it steps aside.
- In cruise the main camera turns **cinematic**: it cuts between chase, fly-by, wide, planet, low and
  whole-system shots.
- **PIP** opens an always-on-top window (Document Picture-in-Picture in Chrome and Edge) with a
  full-quality cinematic view of its own, the system name and charted progress, credits, fuel, what the
  autopilot is doing, a feed of recent events, and buttons for the next shot, warp and close. Other
  browsers fall back to a video PiP with a simple overlay.

## Credits
Inspired by the space Easter egg in Android. The simulation is a fresh implementation and all
word lists, textures and the other ship models are original. The one exception is the "Classic"
ship outline (`js/classic-hull.js`), the SVG path from the Android Open Source Project, used
under the Apache License 2.0 (`LICENSE-APACHE-2.0.txt`, copyright notice kept in that file).
"Android" and its logo are trademarks of Google LLC, which is not affiliated with this project.

## License
MIT, see `LICENSE`.
