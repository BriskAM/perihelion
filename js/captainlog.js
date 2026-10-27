// The captain's log: a line in the ship's own voice for each thing that happens, flavoured by the
// autopilot's personality. Templates use {name}, {turn}, {pe}, {gain}, {star}, {ship}, {cr}.

const LINES = {
  charted: {
    any: ['Charted {name}. Another dot on the map becomes a place.', '{name}: surveyed, logged, named. Moving on.', 'Boots-down on {name}. Nobody has stood here before.'],
    racer: ['{name} done. Next.', 'Tagged {name} at speed. No time for postcards.'],
    efficient: ['{name} charted for almost nothing. The fuel gauge barely noticed.'],
    cinematic: ['{name} at golden hour. Worth the long way round.', 'Watched the horizon of {name} roll under us for a while before setting down.'],
    explorer: ['{name}. Nobody else has been here. That is the whole point.'],
    daredevil: ['{name}. Came in hotter than the manual says. The manual is boring.'],
  },
  slingshot: {
    any: ['Swung round {name}, {turn} degrees in a breath. Free speed is the best speed.', 'Borrowed a little of {name}’s orbit. It won’t miss it.'],
    efficient: ['{name} turned us {turn} degrees for zero fuel. Lovely.'],
    cinematic: ['{name} filled the whole window for a moment, then flung us {turn} degrees onward.'],
    daredevil: ['{pe} above the clouds of {name}. Could have gone lower.', 'Skimmed {name} close enough to taste it.'],
    racer: ['{name} slingshot: {gain} speed. Faster is better.'],
  },
  scan: {
    any: ['Dragged the scanner through {name}’s cloud tops at {pe}. Good data.'],
    daredevil: ['{pe} over {name}’s storms. The hull is still complaining.'],
    cinematic: ['Lightning under the keel as we skimmed {name}.'],
  },
  rescue: { any: ['Towed {ship} back to life. They owe us a drink. And {cr} credits.', '{ship} rescued. Out here everybody helps everybody.'] },
  eruption: { any: ['{name} erupted right in front of us. Rocks still falling.', 'Fire on {name}. We kept our distance. Mostly.'] },
  storm: { any: ['A storm is spinning up on {name}. Scanners are twitching.'] },
  strike: { any: ['A comet just hit {name}. We saw the flash from here.'] },
  arrival: {
    any: ['New system: {star}. Everything here is unnamed.', 'Dropped out of the jump at {star}. Quiet. For now.'],
    explorer: ['{star}. Fresh sky. Let’s get to work.'],
    racer: ['{star}. Clock is running.'],
  },
  station: { any: ['Docked at {name}. Hot coffee, cold fuel, warm hull.'] },
  tour: { any: ['Spent a few orbits just looking at {name}.', 'Circled {name} for a while. Some places you just watch.'] },
  beam: { any: ['Crossed the pulsar beam. Every alarm on the ship went off at once.'] },
  signal: { any: ['That signal again. Faint, regular, not natural.', 'Decoded the beacon: coordinates. Someone wants to be found.'] },
  derelict: { any: ['Found it. A ship the size of a moon, dark for a thousand years.'] },
  hull: { any: ['Hull gave out. Waking up in the medbay. Again.'] },
  outpost: { any: ['Dropped a relay over {name}. Ours now.'] },
  wing: { any: ['Wingman charted {name}. Good kid.'] },
  dyson: { any: ['A Dyson swarm. Somebody built a shell round a whole star. Nobody answers the hail.', 'Flew through the collectors of a Dyson swarm. The star behind them is a dim orange coal.'] },
  lock: { any: ['Targeting lock from that station. That is a very big dish.', 'The fortress is turning to face us. Not good.'], daredevil: ['It is locking on. Excellent.'] },
  dodge: { any: ['Superlaser missed. Felt the heat through the hull.', 'It fired where we were going to be. We were not there.'] },
  hit: { any: ['Took a glancing hit from the superlaser. Half the panels are screaming.'] },
  weakspot: { any: ['Got inside its guard and scanned a weak spot. It has gone very quiet.'] },
  wormhole: { any: ['Through the wormhole. The stars smeared, then snapped back somewhere else.', 'In one side, out the other. Physics can take the rest of the day off.'] },
  whales: { any: ['Star whales. A whole pod of them, singing in radio. Recorded every note.', 'They swam right past the window. Bigger than the ship. Glowing.'] },
};

const fill = (t, d) => t.replace(/\{(\w+)\}/g, (_, k) => (d[k] ?? '').toString());

/** A log line for an event, or null if we have nothing to say about it. */
export function captainsLine(kind, data, persona = 'balanced', rnd = Math.random) {
  const set = LINES[kind];
  if (!set) return null;
  const pool = [...set.any, ...(set[persona] ?? []), ...(set[persona] ?? [])]; // the style's own lines come up more
  return fill(pool[Math.floor(rnd() * pool.length)], data);
}
