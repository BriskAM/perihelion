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

## A living system
- **Elliptical orbits**: every world rides an exact Kepler ellipse, fast near the star and slow far out.
  Random systems roll gentle eccentricities, capped so worlds keep to their lanes; our solar system uses
  the real values (Mercury 0.21, Mars 0.09 and so on). The orbit lines are drawn as the true ellipses.
- **Hull and repairs**: rock hits, hard landings and overheating wear the hull (armour upgrades soften
  it). Time on the ground patches it, satellites help, and stations fix it completely. Hull 0 is a loss.
- **Mining**: touch a belt rock (or a loose one) gently and it goes into the hold. Sell ore at satellites
  (4 CR) or stations (8 CR). Cargo hold upgrades carry more.
- **Stations** sit at the L4/L5 Lagrange points of giant worlds, among their trojan swarms: full refuel,
  full repair, best ore price.
- **Storms** brew on gas giants (a churning spiral with lightning); a scan pass during one pays double.
  Deeper scan passes pay more in any weather.
- **Volcanoes**: molten worlds (and Io) erupt; the rock they throw is a real free body that falls back and
  scars the surface, or escapes into orbit around the star.
- **Mayday**: now and then an AI ship runs dry and drifts. Match its speed to tow it (+150 CR). Cruise
  goes on rescues itself, and also visits stations when damaged, low on fuel or carrying ore.
- **Burn preview**: hold the stick inside its dead zone and a dashed orange path shows where a burn that
  way would take you; push further to fire.
- **Postcards**: slingshots, first landings, eruptions, comet strikes, rescues and arrivals are framed and
  captioned automatically (MENU > POSTCARDS). Cruise collects them while you are away.
- **Galaxy map and achievements** (MENU > GALAXY): every system you have visited, joined in the order
  you flew them (tap one to jump back), and 20 achievements.
- Everything is drawn to scale: from far out ships, satellites, stations and comet nuclei are single points
  (the ship cam shows your heading).
- **Colour themes**: every system picks a palette from its star and seed (violet, emerald, amber, crimson,
  ice, nebula, graphite); the space, grid, starfield and HUD all follow it. Lock one in OPTIONS.
- **The engine always wins**: thrust scales to beat the strongest pull of any planet or star nearby (by a
  third), so nothing but a black hole can hold the ship down, gas giants included. After a loss you wake
  up on solid ground, never in a gas giant.
- **Slingshots only when they help**: the autopilot only swings past a world that is roughly between it and
  where it is going (a short detour, inside a 40 degree cone) and only when the bend it needs there is one
  that world's pull can actually give.

## Stories, building, challenges
- **The Signal**: after a few jumps the ship picks up a faint signal. Each beacon you reach decodes the
  coordinates of the next system (cruise follows it on its own); the last one leads to the Derelict, a
  broken ring ship the size of a moon. Progress is in MENU > MISSIONS.
- **Rare systems**: pulsars (two radio beams sweep round like a lighthouse and scorch anything they cross),
  brown dwarfs (too dim to warm anything: every world is frozen) and young systems still wrapped in a dense
  debris disk and full of comets.
- **Captain's log**: a line in the ship's own voice for every event, flavoured by the autopilot style
  (MENU > LOG, and in italics in the floating window).
- **Relays** (O, or MENU > SHIP): drop a relay into orbit round the nearest world for 300 CR. Every relay
  you own, in any system, pays a few credits a minute, and you can dock at it.
- **Wingman** (MENU > SHIP): hire a second ship that flies with you and charts worlds for you in its own
  style; the cinematic camera checks in on it.
- **Daily challenge** (MENU > MISSIONS): today's system with a goal (least fuel, fastest, most slingshots),
  your best result, and a result line to copy and share.
- **Planned burns**: hold a burn preview for a moment and let go (or press B) and the ship flies exactly
  that change of velocity for you. N moves it to the next periapsis or apoapsis, X cancels.
- **Instant replays**: in cruise, slingshots, eruptions and impacts are replayed in letterboxed slow
  motion a moment later (tap to skip). R replays the last few seconds any time.
- **Seasons and tides**: on an eccentric orbit, ice caps shrink near the star and grow far out; ocean worlds
  bulge toward a close moon.
- **Music**: the score swells through slingshots, plays a chord on arrival, an eerie motif for the Signal,
  and the pad sags and wavers when the ship is in danger.

## Autopilot styles (K, or MENU > OPTIONS)
The autopilot has personalities: the same pilot with different dials (speed, slingshot appetite and how
tight it swings, scan depth, orbit tours, landing style, dwell, cruise warp, comet detours, how long it
stays in a system, and which shots the cinematic camera favours). The HUD keeps score for the current one.
- **Balanced**: a bit of everything.
- **Racer**: as fast as possible. Hard burns, direct landings, max warp, no sightseeing.
- **Efficient**: as little fuel as possible. Gentle speeds, aerobraking, a slingshot whenever it helps.
- **Cinematic**: as spectacular as possible. Tight slingshots, deep scan passes, orbit tours, comet chases.
- **Explorer**: charts far worlds as readily as near ones and jumps on as soon as a system is done.
- **Daredevil**: skims everything just above the clouds and runs rock belts fast.

`test/persona-harness.js` flies each style through the same systems. Over 12 simulated minutes in six
systems: Efficient used about 40% less fuel per world than Balanced with no crashes, Racer and Explorer
charted the most, and Daredevil took twice Balanced's slingshots and the most orbit tours.

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

## Tests
`npm test` runs the simulation harnesses under Node (no browser): every gas giant across 40 seeds must be
charted and left again, and each autopilot style must chart worlds (with Efficient or Cinematic the
thriftiest). GitHub Actions runs it on every push (`.github/workflows/test.yml`).

## Credits
Inspired by the space Easter egg in Android. The simulation is a fresh implementation and all
word lists, textures and the other ship models are original. The one exception is the "Classic"
ship outline (`js/classic-hull.js`), the SVG path from the Android Open Source Project, used
under the Apache License 2.0 (`LICENSE-APACHE-2.0.txt`, copyright notice kept in that file).
"Android" and its logo are trademarks of Google LLC, which is not affiliated with this project.

## License
MIT, see `LICENSE`.
