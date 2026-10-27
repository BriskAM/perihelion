// Achievements: each one checks the running counters in the save. Unlocked ones are toasted once.
export const ACHIEVEMENTS = [
  ['first-sling', 'Slingshot', 'Take a gravity assist', (c) => c.slingshots >= 1],
  ['sling-10', 'Pinball wizard', 'Take 10 gravity assists', (c) => c.slingshots >= 10],
  ['big-turn', 'Hairpin', 'Turn 60 degrees or more in one slingshot', (c) => c.bestTurn >= 60],
  ['scan-1', 'Cloud skimmer', 'Chart a gas giant with a scan pass', (c) => c.scans >= 1],
  ['scan-storm', 'Storm chaser', 'Scan a giant while a storm rages', (c) => c.stormScans >= 1],
  ['comet', 'Snowball', 'Sample a comet', (c) => c.comets >= 1],
  ['rescue', 'Good samaritan', 'Rescue a ship in distress', (c) => c.rescues >= 1],
  ['rescue-5', 'Search and rescue', 'Rescue 5 ships', (c) => c.rescues >= 5],
  ['ore-50', 'Prospector', 'Sell 50 ore', (c) => c.oreSold >= 50],
  ['ore-500', 'Mining magnate', 'Sell 500 ore', (c) => c.oreSold >= 500],
  ['station', 'Docking permitted', 'Dock at a station', (c) => c.stationDocks >= 1],
  ['systems-5', 'Drifter', 'Visit 5 systems', (c) => c.systems >= 5],
  ['systems-25', 'Wanderer of stars', 'Visit 25 systems', (c) => c.systems >= 25],
  ['blackhole', 'Event horizon', 'Visit a system with a black hole', (c) => c.blackHoleSystems >= 1],
  ['binary', 'Two suns', 'Visit a binary star system', (c) => c.binarySystems >= 1],
  ['tour', 'Sightseer', 'Finish an orbit tour', (c) => c.tours >= 1],
  ['orbit', 'Steady hands', 'Hold a stable orbit for 30 s', (c) => c.orbitsHeld >= 1],
  ['eruption', 'Ringside seat', 'Watch a volcano erupt up close', (c) => c.eruptionsSeen >= 1],
  ['impact', 'Witness', 'See a comet strike a world', (c) => c.cometStrikes >= 1],
  ['postcards-20', 'Scrapbook', 'Collect 20 postcards', (c) => c.postcards >= 20],
  ['signal', 'Something out there', 'Decode a signal beacon', (c) => c.beacons >= 1],
  ['derelict', 'First contact', 'Find the derelict at the end of the signal', (c) => c.derelicts >= 1],
  ['pulsar', 'Lighthouse keeper', 'Visit a pulsar system', (c) => c.pulsarSystems >= 1],
  ['dwarf', 'Long winter', 'Visit a brown dwarf system', (c) => c.dwarfSystems >= 1],
  ['young', 'Nursery', 'Visit a young system still in its debris disk', (c) => c.youngSystems >= 1],
  ['outpost', 'Landlord', 'Deploy a relay', (c) => c.outposts >= 1],
  ['outpost-10', 'Network', 'Deploy 10 relays', (c) => c.outposts >= 10],
  ['wing', 'Wingman', 'Hire a wingman', (c) => c.wing >= 1],
  ['daily', 'Daily driver', 'Finish a daily challenge', (c) => c.dailies >= 1],
  ['node', 'By the numbers', 'Fly a planned burn', (c) => c.nodes >= 1],
  ['dyson', 'Kardashev', 'Fly through a Dyson swarm', (c) => c.dysons >= 1],
  ['dodge', 'Not today', 'Dodge three superlaser shots', (c) => c.dodges >= 3],
  ['weakspot', 'Weak spot', 'Get inside a fortress’s guard and scan it', (c) => c.fortressScans >= 1],
  ['wormhole', 'Shortcut', 'Travel through a wormhole', (c) => c.wormholes >= 1],
  ['whales', 'Whale song', 'Record a pod of star whales', (c) => c.whales >= 1],
];

export function blankCounts() {
  return {
    slingshots: 0, bestTurn: 0, scans: 0, stormScans: 0, comets: 0, rescues: 0, oreSold: 0, stationDocks: 0,
    systems: 1, blackHoleSystems: 0, binarySystems: 0, tours: 0, orbitsHeld: 0, eruptionsSeen: 0, cometStrikes: 0, postcards: 0,
    dysons: 0, dodges: 0, fortressScans: 0, wormholes: 0, whales: 0,
    beacons: 0, derelicts: 0, pulsarSystems: 0, dwarfSystems: 0, youngSystems: 0, outposts: 0, wing: 0, dailies: 0, nodes: 0,
  };
}

/** Returns the achievements that just unlocked (and records them in state.achievements). */
export function checkAchievements(state) {
  const got = [];
  for (const [id, name, desc, test] of ACHIEVEMENTS) {
    if (state.achievements.includes(id) || !test(state.counts)) continue;
    state.achievements.push(id);
    got.push({ id, name, desc });
  }
  return got;
}
