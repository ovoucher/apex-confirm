import { runJourney, type JourneyResult } from "../src/sim/journey.js";
import { seedDir } from "../src/util/paths.js";

let cached: JourneyResult | null = null;
/** The seeded two-period journey, run once per test file. */
export function journey(): JourneyResult {
  if (!cached) cached = runJourney({ seedDir: seedDir() });
  return cached;
}
