// Our own solar system, scaled to fit the game: Earth has radius 300 and the orbits are squeezed
// (but keep their order and spacing character) so everything fits inside the 200,000-unit range.
// Descriptions are the game's usual tongue-in-cheek codex entries.

export const SOL = {
  star: { cls: 'G', radius: 7000 },
  planets: [
    {
      name: 'Mercury', R: 115, orbit: 17_000, color: '#b8a89a', spin: 0.012, spec: { kind: 'craters', rings: null },
      description: 'scorched iron world', atmosphere: 'a faint exosphere', fauna: 'none', flora: 'none',
    },
    {
      name: 'Venus', R: 285, orbit: 25_000, color: '#e8c070', spin: -0.006, spec: { kind: 'swirl', rings: null },
      atmo: [1, 45], description: 'cloud-wrapped furnace', atmosphere: 'crushing carbon dioxide', fauna: 'none', flora: 'none',
    },
    {
      name: 'Earth', R: 300, orbit: 36_000, color: '#4c9be8', spec: { kind: 'ocean', rings: null }, atmo: [0.5, 40],
      description: 'ocean world', atmosphere: 'nitrogen and oxygen', fauna: 'everywhere, mostly harmless', flora: 'everywhere',
      geo: 2.6, // radius, in planet radii, where geostationary satellites sit (sets the spin)
      moons: [{ name: 'Moon', R: 82, orbit: 2900, color: '#c9c9d4', spec: { kind: 'craters' },
        description: 'cratered grey moon', atmosphere: 'none', fauna: 'a few flags', flora: 'none' }],
    },
    {
      name: 'Mars', R: 160, orbit: 47_000, color: '#d9663d', spin: 0.058, spec: { kind: 'craters', rings: null }, atmo: [0.12, 30],
      description: 'rust-red desert', atmosphere: 'thin carbon dioxide', fauna: 'a few robots', flora: 'none',
      moons: [
        { name: 'Phobos', R: 14, orbit: 520, color: '#9a8f86', spec: { kind: 'craters' }, description: 'lumpy captured rock', atmosphere: 'none', fauna: 'none', flora: 'none' },
        { name: 'Deimos', R: 10, orbit: 900, color: '#a39a90', spec: { kind: 'craters' }, description: 'smaller lumpy rock', atmosphere: 'none', fauna: 'none', flora: 'none' },
      ],
    },
    {
      name: 'Jupiter', R: 1900, orbit: 82_000, color: '#d9a066', gas: true, spin: 0.09, spec: { kind: 'gas', rings: null },
      description: 'gas giant', atmosphere: 'hydrogen and one very old storm', fauna: 'none', flora: 'none',
      moons: [
        { name: 'Io', R: 85, orbit: 3600, color: '#e8d34a', spec: { kind: 'cracks' }, description: 'volcanic moon', atmosphere: 'sulphur breath', fauna: 'none', flora: 'none' },
        { name: 'Europa', R: 75, orbit: 5200, color: '#d8e4ee', spec: { kind: 'cracks' }, description: 'icy moon over an ocean', atmosphere: 'a whisper of oxygen', fauna: 'unconfirmed', flora: 'none' },
        { name: 'Ganymede', R: 125, orbit: 7400, color: '#b9b1a6', spec: { kind: 'continents' }, description: 'largest moon of all', atmosphere: 'thin oxygen', fauna: 'none', flora: 'none' },
        { name: 'Callisto', R: 110, orbit: 10_000, color: '#8c847a', spec: { kind: 'craters' }, description: 'ancient cratered moon', atmosphere: 'traces of carbon dioxide', fauna: 'none', flora: 'none' },
      ],
    },
    {
      name: 'Saturn', R: 1650, orbit: 106_000, color: '#e3d08a', gas: true, spin: 0.08,
      spec: { kind: 'gas', rings: { inner: 1.3, width: 1.0, ry: 0.3, tilt: 0.45 } },
      description: 'ringed gas giant', atmosphere: 'hydrogen, helium and gentle winds', fauna: 'none', flora: 'none',
      moons: [
        { name: 'Enceladus', R: 40, orbit: 3300, color: '#f2f6fa', spec: { kind: 'cracks' }, description: 'geyser moon', atmosphere: 'plumes of vapour', fauna: 'unconfirmed', flora: 'none' },
        { name: 'Rhea', R: 60, orbit: 4800, color: '#cfcac2', spec: { kind: 'craters' }, description: 'icy cratered moon', atmosphere: 'none', fauna: 'none', flora: 'none' },
        { name: 'Titan', R: 125, orbit: 7500, color: '#d9a441', spec: { kind: 'swirl' }, atmo: [0.9, 60], haze: '#d9a441',
          description: 'moon with lakes and orange skies', atmosphere: 'dense nitrogen haze', fauna: 'none', flora: 'none' },
        { name: 'Iapetus', R: 55, orbit: 12_000, color: '#8d8a84', spec: { kind: 'craters' }, description: 'two-tone moon', atmosphere: 'none', fauna: 'none', flora: 'none' },
      ],
    },
    {
      name: 'Uranus', R: 790, orbit: 127_000, color: '#8fd8e0', gas: true, spin: -0.05,
      spec: { kind: 'gas', rings: { inner: 1.6, width: 0.25, ry: 0.15, tilt: 1.35 } },
      description: 'ice giant that rolls on its side', atmosphere: 'cold hydrogen and methane', fauna: 'none', flora: 'none',
      moons: [
        { name: 'Titania', R: 60, orbit: 3000, color: '#b6b2ac', spec: { kind: 'cracks' }, description: 'icy canyon moon', atmosphere: 'none', fauna: 'none', flora: 'none' },
        { name: 'Oberon', R: 55, orbit: 4200, color: '#a39d96', spec: { kind: 'craters' }, description: 'dark cratered moon', atmosphere: 'none', fauna: 'none', flora: 'none' },
      ],
    },
    {
      name: 'Neptune', R: 760, orbit: 146_000, color: '#4a6fe0', gas: true, spin: 0.055, spec: { kind: 'swirl', rings: null },
      description: 'distant blue ice giant', atmosphere: 'hydrogen, methane and supersonic winds', fauna: 'none', flora: 'none',
      moons: [
        { name: 'Triton', R: 80, orbit: 3000, color: '#d8c8c0', spec: { kind: 'cracks' }, description: 'frozen captured moon', atmosphere: 'thin nitrogen', fauna: 'none', flora: 'none' },
      ],
    },
    {
      name: 'Pluto', R: 55, orbit: 170_000, color: '#cbb7a0', spin: 0.01, spec: { kind: 'cracks', rings: null },
      description: 'small cold world with a heart-shaped plain', atmosphere: 'nitrogen frost', fauna: 'none', flora: 'none',
      pair: { name: 'Charon', R: 28, color: '#9d948c', sep: 700, spec: { kind: 'craters' },
        description: 'its binary partner', atmosphere: 'none', fauna: 'none', flora: 'none' },
    },
  ],
  belts: [
    { radius: 62_000, width: 8000, fixed: { spacing: 270, sizeScale: 1, clumpy: 0.3, peaked: true } },
    { radius: 158_000, width: 7000, fixed: { spacing: 420, sizeScale: 1.2, clumpy: 0, peaked: false } },
  ],
  // satellites: `at` is a planet name; orbit is an altitude above the surface (or, for
  // geostationary, uses the planet's geo radius)
  satellites: [
    { at: 'Earth', kind: 'orbiter', name: 'ISS', alt: 110, phase: 0 },
    { at: 'Earth', kind: 'orbiter', name: 'Hubble', alt: 170, phase: 2.1 },
    { at: 'Earth', kind: 'orbiter', name: 'GPS-1', alt: 400, phase: 0.3 },
    { at: 'Earth', kind: 'orbiter', name: 'GPS-2', alt: 400, phase: 2.4 },
    { at: 'Earth', kind: 'orbiter', name: 'GPS-3', alt: 400, phase: 4.5 },
    { at: 'Earth', kind: 'geostationary', name: 'Comsat-A', phase: 0 },
    { at: 'Earth', kind: 'geostationary', name: 'Comsat-B', phase: 3.14 },
    { at: 'Moon', kind: 'orbiter', name: 'Lunar Gateway', alt: 120, phase: 1 },
    { at: 'Mars', kind: 'orbiter', name: 'MRO', alt: 120, phase: 0.5 },
    { at: 'Mars', kind: 'orbiter', name: 'MAVEN', alt: 220, phase: 3.2 },
    { at: 'Jupiter', kind: 'orbiter', name: 'Juno', alt: 1000, phase: 0.2 },
    { at: 'Saturn', kind: 'orbiter', name: 'Cassini', alt: 950, phase: 1.7 },
    { kind: 'probe', name: 'Voyager 1', outbound: true, angle: 0.9, speed: 650 },
    { kind: 'probe', name: 'Voyager 2', outbound: true, angle: 4.0, speed: 560 },
    { kind: 'probe', name: 'Pioneer 10', outbound: true, angle: 2.4, speed: 480 },
    { kind: 'probe', name: 'New Horizons', dest: 'Pluto', speed: 800, from: 'Earth' },
  ],
};
