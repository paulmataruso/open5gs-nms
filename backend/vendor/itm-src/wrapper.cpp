// Embind wrapper exposing NTIA's ITM_P2P_TLS (point-to-point, time/location/
// situation variability mode) as a clean JS-callable function. This file is
// NOT part of the vendored NTIA source — it's this project's own thin
// adapter, kept separate from the vendored code so re-vendoring a newer ITM
// release never touches it.
//
// ITM_P2P_TLS's real signature (include/itm.h) takes a raw C array for the
// terrain profile and raw output pointers — neither marshals cleanly to JS
// through Embind on its own, so this wrapper accepts a std::vector<double>
// (Embind marshals this from a plain JS array automatically) and returns a
// value_object (marshals to a plain JS object) instead.

#include <emscripten/bind.h>
#include <vector>
#include "include/itm.h"

struct ItmP2pResult {
  int returnCode;
  double pathLossDb;
  long warnings;
};

// profile: pfl[] format exactly as ITM defines it — profile[0] = np (number
// of intervals = point count - 1), profile[1] = xi (constant step distance
// in meters), profile[2..] = elevation in meters. Built on the TypeScript
// side from terrain-profile.ts's own even-interval output (see itm-model.ts).
ItmP2pResult itmP2pTls(
  double txHeightM, double rxHeightM, const std::vector<double>& profile,
  int climate, double n0, double freqMhz, int polarization,
  double epsilon, double sigma, int mdvar,
  double timePercent, double locationPercent, double situationPercent
) {
  double pathLossDb = 0.0;
  long warnings = 0;
  int rc = ITM_P2P_TLS(
    txHeightM, rxHeightM, profile.data(), climate, n0, freqMhz,
    polarization, epsilon, sigma, mdvar, timePercent, locationPercent, situationPercent,
    &pathLossDb, &warnings
  );
  return ItmP2pResult{ rc, pathLossDb, warnings };
}

EMSCRIPTEN_BINDINGS(itm_module) {
  emscripten::register_vector<double>("VectorDouble");
  emscripten::value_object<ItmP2pResult>("ItmP2pResult")
    .field("returnCode", &ItmP2pResult::returnCode)
    .field("pathLossDb", &ItmP2pResult::pathLossDb)
    .field("warnings", &ItmP2pResult::warnings);
  emscripten::function("itmP2pTls", &itmP2pTls);
}
