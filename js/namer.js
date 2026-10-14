// Word lists written for this project. Mechanics (bags, weighted tables, name layout)
// follow the same idea as the original; the words are our own.

const words = (s) => s.trim().split(/\s*,\s*/);

const PLANET_DESCRIPTORS = words(`
dusty, frozen, cratered, windswept, glassy, mossy, stormy, barren, swampy, volcanic,
salt-crusted, ringed, tidally locked, cloud-wrapped, striped, pockmarked, glittering,
sulfurous, mirrored, shadowed, sun-baked, marbled, hollow, dim, lumpy, lavender,
oily, crystalline, cavernous, sleepy, ash-grey, rust-red`);
const LIFE_DESCRIPTORS = words(`
shy, loud, tiny, towering, glowing, sluggish, curious, territorial, translucent,
migratory, nocturnal, hairy, spiny, rubbery, singing, bashful, gelatinous, ornate,
speedy, patient, striped, spotted, furtive, ceremonial, absent, pocket-sized, suspicious,
cooperative, drowsy, bioluminescent, brittle, stubborn, polite, feral, hypnotic, moth-like`);
const ANY_DESCRIPTORS = words(`
strange, quiet, enormous, forgotten, cheerful, peculiar, lonely, ancient, fresh,
spicy, grainy, velvet, jittery, hushed, vivid, faded, oddly familiar, unfinished,
over-fussy, sparkling, tender, patchy, wobbling, minty, moody, plain, ornamental,
unlabelled, handmade, dreamy, rumbling, honeyed, smoky, tasteful, chilly, floating,
second-hand, improbable, tangled, crisp, nameless, gleaming, wistful, spotless`);
const ATMO_DESCRIPTORS = words(`
thin, thick, humming, sweet, metallic, peppery, silent, electric, cold, soupy,
sparkling, hazy, acrid, perfumed, gusty, still, violet, dense, shimmering, mild,
dry, damp, sooty, fizzy, briny, smoky, glowing`);
const PLANET_TYPES = words(`
planet, planetoid, moon, moonlet, rock, giant, dwarf, wanderer, satellite, orb,
asteroid, cinder, world, boulder, ball, fragment, comet-husk, core, speck, drifter`);
const CONSTELLATIONS = words(`
Andromeda, Aquila, Ara, Auriga, Bootes, Carina, Cassiopeia, Centaurus, Cepheus, Cetus,
Columba, Corvus, Crux, Cygnus, Delphinus, Draco, Eridanus, Gemini, Grus, Hercules,
Hydra, Lacerta, Leo, Lepus, Libra, Lupus, Lynx, Lyra, Monoceros, Norma, Orion, Pavo,
Pegasus, Perseus, Phoenix, Pictor, Puppis, Pyxis, Scorpius, Sculptor, Serpens, Taurus,
Triangulum, Tucana, Ursa, Vela, Virgo, Volans, Vulpecula, Sagitta`);
const CONSTELLATIONS_RARE = words(`
Sol, Nowhere, Elsewhere, Cobalt, Parsley, Ember, Lantern, Marmalade, Tin, Hush,
Brindle, Wick, Olive, Quill, Saffron, Thimble, Juniper, Pebble, Mothlight, Dandelion, Kettle`);
const STAR_SUFFIXES = words(`
Major, Minor, Prime, Alpha, Beta, Gamma, Delta, Epsilon, Zeta, Eta, Theta, Iota, Kappa,
Lambda, Sigma, Tau, Omega, Australis, Borealis, Proxima, Ultima, Secundus, Tertius,
Nova, Reach, Gate, Deep, Verge, Drift, Hollow, Shoal, Spur, Cluster, Ridge, Belt`);
const STAR_SUFFIXES_RARE = words(`
the Younger, Junior, Redux, Reloaded, Classic, Deluxe, Remastered, Extended, Lite, Pro,
(Final), Mk II`);

const ACTIVITIES = words(`
refuelling, sightseeing, napping, picnicking, recharging, stargazing, taking notes,
mapping caves, repairing the hull, herding {fauna}, befriending {fauna}, photographing {fauna},
sampling {flora}, pressing {flora}, tasting {atmo}, bottling {atmo}, surveying the {planet},
polishing the landing legs, writing postcards, sorting rock samples, listening to {atmo},
counting craters, skipping stones, waving at {fauna}, cataloguing {flora}, having a stretch,
inventing a new colour, hiding from {fauna}, tuning the radio, watching the horizon,
losing a sock, doing nothing in particular`);
const FLORA_PLURALS = words(`flora, plants, flowers, trees, mosses, lichens, ferns, spores, fungi, vines, algae, shrubs`);
const FAUNA_PLURALS = words(`fauna, creatures, critters, beasts, herds, swarms, flocks, things, locals, crawlers`);
const ATMO_PLURALS = words(`air, atmosphere, clouds, winds, gases, breezes`);

class Bag {
  constructor(items) {
    this.items = items.slice();
    this.next = this.items.length; // shuffle on first pull
  }
  pull(rng) {
    if (this.next >= this.items.length) {
      for (let i = this.items.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
      }
      this.next = 0;
    }
    return this.items[this.next++];
  }
}

class RandomTable {
  constructor(...pairs) {
    this.pairs = pairs;
    this.total = pairs.reduce((s, p) => s + p[0], 0);
  }
  roll(rng) {
    let x = rng.range(0, this.total);
    for (const [w, v] of this.pairs) {
      x -= w;
      if (x < 0) return v;
    }
    return this.pairs[this.pairs.length - 1][1];
  }
}

const SUFFIX_PROB = 0.75, LETTER_PROB = 0.3, NUMBER_PROB = 0.3, RARE_PROB = 0.05;

export class Namer {
  constructor() {
    const planetD = new Bag(PLANET_DESCRIPTORS), lifeD = new Bag(LIFE_DESCRIPTORS);
    const anyD = new Bag(ANY_DESCRIPTORS), atmoD = new Bag(ATMO_DESCRIPTORS);
    this.planetTypes = new Bag(PLANET_TYPES);
    this.suffixesRare = new Bag(STAR_SUFFIXES_RARE);
    this.planetTable = new RandomTable([0.75, planetD], [0.25, anyD]);
    this.lifeTable = new RandomTable([0.75, lifeD], [0.25, anyD]);
    this.atmoTable = new RandomTable([0.75, atmoD], [0.25, anyD]);
    this.constellationsTable = new RandomTable(
      [RARE_PROB, new Bag(CONSTELLATIONS_RARE)], [1 - RARE_PROB, new Bag(CONSTELLATIONS)]);
    this.suffixesTable = new RandomTable(
      [RARE_PROB, this.suffixesRare], [1 - RARE_PROB, new Bag(STAR_SUFFIXES)]);
    this.delimiterTable = new RandomTable(
      [15, ' '], [3, '-'], [1, '_'], [1, '/'], [1, '.'], [1, '*'], [1, '^'], [1, '#']);
    this.activities = new Bag(ACTIVITIES);
    this.flora = new Bag(FLORA_PLURALS);
    this.fauna = new Bag(FAUNA_PLURALS);
    this.atmo = new Bag(ATMO_PLURALS);
  }
  describePlanet(rng) {
    return this.planetTable.roll(rng).pull(rng) + ' ' + this.planetTypes.pull(rng);
  }
  describeLife(rng) { return this.lifeTable.roll(rng).pull(rng); }
  describeAtmo(rng) { return this.atmoTable.roll(rng).pull(rng); }
  nameSystem(rng) {
    let s = this.constellationsTable.roll(rng).pull(rng);
    if (rng() <= SUFFIX_PROB) {
      s += this.delimiterTable.roll(rng) + this.suffixesTable.roll(rng).pull(rng);
      if (rng() <= RARE_PROB) s += ' ' + this.suffixesRare.pull(rng);
    }
    if (rng() <= LETTER_PROB) {
      s += this.delimiterTable.roll(rng) + String.fromCharCode(65 + rng.int(0, 26));
      if (rng() <= RARE_PROB) s += this.delimiterTable.roll(rng);
    }
    if (rng() <= NUMBER_PROB) s += this.delimiterTable.roll(rng) + rng.int(2, 5039);
    return s;
  }
  describeActivity(rng, planet) {
    return this.activities.pull(rng).replace(/\{(flora|fauna|planet|atmo)\}/g, (_, tag) => {
      switch (tag) {
        case 'flora': return `${planet.flora} ${this.flora.pull(rng)}`;
        case 'fauna': return `${planet.fauna} ${this.fauna.pull(rng)}`;
        case 'atmo': return `${planet.atmosphere} ${this.atmo.pull(rng)}`;
        default: return planet.description;
      }
    });
  }
}
