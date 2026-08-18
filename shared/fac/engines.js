// shared/fac/engines.js
//
// Binds every family's engine to its metadata entry in the registry.
//
// Importing this module is what turns a metadata-only registry — labels,
// rating bases, credibility parameters — into one that can price. The server
// gets it through shared/fac/index.js; the browser deliberately does not,
// because it prices nothing except the property workbook, which it imports
// on its own.
//
// The one line per family below is the whole registration step. Adding a
// family is an entry in families/meta.js, a module, and a line here.

import { registerEngine } from './registry.js';

import { scheduleProperty } from './families/scheduleProperty.js';
import { liabilityLimit, marineLiability } from './families/liabilityLimit.js';
import { hullValue } from './families/hullValue.js';
import { transitValues } from './families/transitValues.js';
import { projectWorks } from './families/projectWorks.js';
import { plantOperational } from './families/plantOperational.js';
import { energyAsset } from './families/energyAsset.js';
import { cyberLimit } from './families/cyberLimit.js';
import { motorFleet } from './families/motorFleet.js';
import { paBenefit } from './families/paBenefit.js';

export const ENGINES = [
  scheduleProperty,
  projectWorks,
  plantOperational,
  energyAsset,
  hullValue,
  transitValues,
  marineLiability,
  liabilityLimit,
  cyberLimit,
  motorFleet,
  paBenefit,
];

for (const family of ENGINES) registerEngine(family);
