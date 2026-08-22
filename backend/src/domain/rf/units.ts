// dBm<->Watts conversions and the two genuinely distinct forms of "adding"
// RF power quantities. See sumPowersDbm's comment for the pitfall this
// module exists to prevent.

export function dbmToWatts(dbm: number): number {
  return Math.pow(10, (dbm - 30) / 10);
}

export function wattsToDbm(watts: number): number {
  return 10 * Math.log10(watts) + 30;
}

export function dbmToMilliwatts(dbm: number): number {
  return Math.pow(10, dbm / 10);
}

export function milliwattsToDbm(mw: number): number {
  return 10 * Math.log10(mw);
}

// Cascading gains/losses on ONE signal path (a link budget) is plain dB
// arithmetic: Pout(dBm) = Pin(dBm) + Gain(dB) - Loss(dB) -- that is NOT
// this function, just do that with plain +/- on dBm values directly.
//
// This function is for the OTHER case: combining two INDEPENDENT absolute
// power quantities (signal + noise, two interferers), which cannot be done
// by adding their dBm values. Must convert to linear (mW), sum, convert
// back. Example: sumPowersDbm(-50, -50) ~= -46.99 dBm -- NOT -100 (naive
// dBm sum) and NOT -50 (no-op) -- this is exactly the confusion a naive
// implementation gets wrong.
export function sumPowersDbm(...dbmValues: number[]): number {
  const totalMw = dbmValues.reduce((sum, dbm) => sum + dbmToMilliwatts(dbm), 0);
  return milliwattsToDbm(totalMw);
}
