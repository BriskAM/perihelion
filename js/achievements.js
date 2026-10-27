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
];

export function blankCounts() {
  return {
    slingshots: 0, bestTurn: 0, scans: 0, stormScans: 0, comets: 0, rescues: 0, oreSold: 0, stationDocks: 0,
    systems: 1, blackHoleSystems: 0, binarySystems: 0, tours: 0, orbitsHeld: 0, eruptionsSeen: 0, cometStrikes: 0, postcards: 0,
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
