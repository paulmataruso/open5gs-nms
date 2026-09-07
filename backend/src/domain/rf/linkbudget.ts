import {
  LinkBudgetInput, LinkBudgetResult, CalculationResult, Assumption, Warning, EquationRecord,
  okResult, errResult,
} from './rf-types';
import { calculateEirpDbm, eirpEquation } from './eirp';
import { fsplDb, fsplEquation } from './pathloss-fspl';
import { earfcnToFrequencyMhz } from './lte-bands';
import { hataPathLossDb, cost231HataPathLossDb } from './hata-model';
import { closeInPathLossDb, closeInEquation, UMI_SC_LOS_PLE, UMI_SC_NLOS_PLE } from './close-in-model';
import { logDistancePathLossDb, logDistanceEquation, LOG_DISTANCE_ENVIRONMENT_PRESETS } from './log-distance-model';
import {
  walfischIkegamiPathLossDb, WI_DEFAULT_BUILDING_SEPARATION_M, WI_DEFAULT_STREET_ORIENTATION_DEG, wiDefaultStreetWidthM,
} from './walfisch-ikegami-model';

function resolveWithDefault(value: number | undefined, parameter: string, unit: string, assumptions: Assumption[]): number {
  if (value != null) return value;
  assumptions.push({ parameter, assumedValue: 0, unit, reason: 'Not provided by caller', overridable: true });
  return 0;
}

export function calculateLinkBudget(input: LinkBudgetInput): CalculationResult<LinkBudgetResult> {
  const assumptions: Assumption[] = [];
  const warnings: Warning[] = [];

  // Resolve frequency: either given directly, or derived from band+EARFCN.
  let frequencyMhz = input.frequencyMhz;
  if (frequencyMhz == null) {
    if (input.band != null && input.earfcn != null) {
      const r = earfcnToFrequencyMhz(input.band, input.earfcn);
      if (!r.ok) {
        return errResult({
          reason: r.error.reason,
          missingInputs: ['frequencyMhz (could not be derived from band+earfcn)'],
          availableInputs: { band: input.band, earfcn: input.earfcn },
        });
      }
      frequencyMhz = r.frequencyMhz;
    } else {
      return errResult({
        reason: 'No frequency available — provide frequencyMhz directly, or both band and earfcn',
        missingInputs: ['frequencyMhz (or band and earfcn together)'],
      });
    }
  }

  const filterLossDb     = resolveWithDefault(input.filterLossDb, 'filterLossDb', 'dB', assumptions);
  const buildingLossDb   = resolveWithDefault(input.buildingLossDb, 'buildingLossDb', 'dB', assumptions);
  const foliageLossDb    = resolveWithDefault(input.foliageLossDb, 'foliageLossDb', 'dB', assumptions);
  const miscLossDb       = resolveWithDefault(input.miscLossDb, 'miscLossDb', 'dB', assumptions);
  const ueAntennaGainDbi = resolveWithDefault(input.ueAntennaGainDbi, 'ueAntennaGainDbi', 'dBi', assumptions);

  const eirpInput = {
    txPowerDbm: input.txPowerDbm,
    cableLossDb: input.cableLossDb,
    connectorLossDb: input.connectorLossDb,
    filterLossDb,
    antennaGainDbi: input.antennaGainDbi,
  };
  const eirpDbm = calculateEirpDbm(eirpInput);

  const frequencyHz = frequencyMhz * 1_000_000;

  const propagationModel = input.propagationModel ?? 'fspl';
  if (propagationModel === 'itm') {
    // ITM's entire algorithm is terrain-profile-shaped (see itm-model.ts) —
    // this tab only has an abstract distanceM with no lat/lon, so there is
    // no real terrain profile to build. Coverage Map / Interference (which
    // do have real coordinates) are the only supported entry points for
    // this model — reject explicitly rather than silently substituting FSPL
    // or another model, which would look like a real ITM result but isn't.
    return errResult({
      reason: "propagationModel 'itm' requires a real terrain profile (latitude/longitude coordinates) and is not supported in the Link Budget tool — use the Coverage Map or Interference tools instead, which compute a real terrain profile between sites",
      missingInputs: ['siteLat/siteLon/targetLat/targetLon (not applicable to this tool)'],
    });
  }
  let pathLossDb: number;
  let pathLossEquation: EquationRecord;
  let modelName: string;

  if (propagationModel === 'fspl') {
    pathLossDb = fsplDb(input.distanceM, frequencyHz);
    pathLossEquation = fsplEquation(input.distanceM, frequencyHz, pathLossDb);
    modelName = 'Free-Space Path Loss Link Budget';
  } else if (propagationModel === 'close-in') {
    // No height/frequency restriction, unlike Hata/COST-231-Hata — the
    // right tool for low-height small-cell/CBRS-style deployments.
    let n = input.pathLossExponent;
    if (n == null) {
      const isLos = input.isLineOfSight ?? false;
      if (input.isLineOfSight == null) {
        assumptions.push({ parameter: 'isLineOfSight', assumedValue: 'false (NLOS)', reason: 'Not provided by caller — defaulted to the more conservative NLOS exponent', overridable: true });
      }
      n = isLos ? UMI_SC_LOS_PLE : UMI_SC_NLOS_PLE;
    }
    pathLossDb = closeInPathLossDb(input.distanceM, frequencyHz, n);
    pathLossEquation = closeInEquation(input.distanceM, frequencyHz, n, input.isLineOfSight, pathLossDb);
    modelName = 'Close-In Free-Space Reference-Distance Link Budget';
  } else if (propagationModel === 'log-distance') {
    const environment = input.logDistanceEnvironment ?? 'urban';
    let n = input.pathLossExponent;
    if (n == null) {
      if (input.logDistanceEnvironment == null) {
        assumptions.push({ parameter: 'logDistanceEnvironment', assumedValue: environment, reason: 'Not provided by caller', overridable: true });
      }
      const preset = LOG_DISTANCE_ENVIRONMENT_PRESETS[environment];
      n = preset.pathLossExponent;
      if (!preset.verified) {
        warnings.push({
          code: 'UNVERIFIED_PRESET_VALUE',
          message: `The "${environment}" log-distance preset (n=${preset.pathLossExponent}) is unverified — no single citable reference was found for it. Provide an explicit pathLossExponent to use a value you trust.`,
          severity: 'warning',
        });
      }
    }
    pathLossDb = logDistancePathLossDb(input.distanceM, frequencyHz, n);
    pathLossEquation = logDistanceEquation(input.distanceM, frequencyHz, n, environment, pathLossDb);
    modelName = `Log-Distance Link Budget (${environment})`;
  } else {
    if (input.txHeightM == null || input.rxHeightM == null) {
      return errResult({
        reason: `propagationModel '${propagationModel}' requires real antenna heights, not just a distance`,
        missingInputs: [input.txHeightM == null ? 'txHeightM' : null, input.rxHeightM == null ? 'rxHeightM' : null].filter((x): x is string => x != null),
      });
    }
    const distanceKm = input.distanceM / 1000;
    if (propagationModel === 'hata') {
      const environment = input.environment ?? 'urban';
      if (input.environment == null) {
        assumptions.push({ parameter: 'environment', assumedValue: environment, reason: 'Not provided by caller', overridable: true });
      }
      const hataResult = hataPathLossDb(frequencyMhz, input.txHeightM, input.rxHeightM, distanceKm, environment);
      if (!hataResult.ok) return errResult(hataResult.error);
      pathLossDb = hataResult.pathLossDb;
      pathLossEquation = hataResult.equation;
      modelName = `Hata Model Link Budget (${environment})`;
    } else if (propagationModel === 'cost231-hata') {
      const cityType = input.cityType ?? 'medium';
      if (input.cityType == null) {
        assumptions.push({ parameter: 'cityType', assumedValue: cityType, reason: 'Not provided by caller', overridable: true });
      }
      const c231Result = cost231HataPathLossDb(frequencyMhz, input.txHeightM, input.rxHeightM, distanceKm, cityType);
      if (!c231Result.ok) return errResult(c231Result.error);
      pathLossDb = c231Result.pathLossDb;
      pathLossEquation = c231Result.equation;
      modelName = `COST-231-Hata Model Link Budget (${cityType})`;
    } else {
      // walfisch-ikegami
      const mode = input.walfischIkegamiMode ?? 'nlos';
      if (input.walfischIkegamiMode == null) {
        assumptions.push({ parameter: 'walfischIkegamiMode', assumedValue: mode, reason: 'Not provided by caller — defaulted to the more conservative NLOS case', overridable: true });
      }
      if (mode === 'nlos' && input.buildingHeightM == null) {
        return errResult({
          reason: "propagationModel 'walfisch-ikegami' in NLOS mode requires buildingHeightM (representative rooftop height) — no honest default exists for site-specific building geometry",
          missingInputs: ['buildingHeightM'],
        });
      }
      const cityType = input.cityType ?? 'medium';
      if (input.cityType == null) {
        assumptions.push({ parameter: 'cityType', assumedValue: cityType, reason: 'Not provided by caller', overridable: true });
      }
      let buildingSeparationM = input.buildingSeparationM;
      if (buildingSeparationM == null) {
        buildingSeparationM = WI_DEFAULT_BUILDING_SEPARATION_M;
        assumptions.push({
          parameter: 'buildingSeparationM', assumedValue: buildingSeparationM, unit: 'm',
          reason: "Not provided by caller — COST-231 only specifies a 20-50m range, not a single value; 35m is this tool's own midpoint convention, not a standard-specified default",
          overridable: true,
        });
      }
      let streetWidthM = input.streetWidthM;
      if (streetWidthM == null) {
        streetWidthM = wiDefaultStreetWidthM(buildingSeparationM);
        assumptions.push({
          parameter: 'streetWidthM', assumedValue: streetWidthM, unit: 'm',
          reason: "Not provided by caller — defaulted to buildingSeparationM/2, the COST-231 standard's own recommended relationship",
          overridable: true,
        });
      }
      const streetOrientationDeg = input.streetOrientationDeg ?? WI_DEFAULT_STREET_ORIENTATION_DEG;
      if (input.streetOrientationDeg == null) {
        assumptions.push({
          parameter: 'streetOrientationDeg', assumedValue: streetOrientationDeg, unit: 'deg',
          reason: "Not provided by caller — 90° is the COST-231 standard's own recommended default", overridable: true,
        });
      }
      const wiResult = walfischIkegamiPathLossDb(
        frequencyMhz, input.txHeightM, input.rxHeightM, distanceKm, mode,
        input.buildingHeightM ?? 0, streetWidthM, buildingSeparationM, streetOrientationDeg, cityType,
      );
      if (!wiResult.ok) return errResult(wiResult.error);
      pathLossDb = wiResult.pathLossDb;
      pathLossEquation = wiResult.equation;
      modelName = `Walfisch-Ikegami Model Link Budget (${mode}, ${cityType})`;
    }
  }

  const totalReceivedPowerDbm = eirpDbm - pathLossDb - buildingLossDb - foliageLossDb - miscLossDb + ueAntennaGainDbi;

  const linkBudgetEquation = {
    name: 'Link Budget Summation',
    formula: 'Prx(dBm) = EIRP − pathLoss − buildingLoss − foliageLoss − miscLoss + ueAntennaGain',
    variables: {
      EIRP:          { description: 'Effective isotropic radiated power', unit: 'dBm', value: eirpDbm },
      pathLoss:      { description: 'Propagation path loss', unit: 'dB', value: pathLossDb },
      buildingLoss:  { description: 'Building penetration loss', unit: 'dB', value: buildingLossDb },
      foliageLoss:   { description: 'Foliage loss', unit: 'dB', value: foliageLossDb },
      miscLoss:      { description: 'Miscellaneous/margin loss', unit: 'dB', value: miscLossDb },
      ueAntennaGain: { description: 'UE/receiver antenna gain', unit: 'dBi', value: ueAntennaGainDbi },
      Prx:           { description: 'Total received power', unit: 'dBm', value: totalReceivedPowerDbm },
    },
    source: 'Standard link-budget cascade arithmetic (dB-domain, single signal path) — cf. 3GPP TR 25.942',
    applicableConditions: 'Single-path link budget; every term modifies the same signal path',
  };

  warnings.push({
    code: 'NOT_RSRP',
    message: 'totalReceivedPowerDbm is total wideband received power, not LTE RSRP. True RSRP (3GPP TS 36.214) requires resource-block/reference-signal power-boosting information not modeled in this calculation.',
    severity: 'info',
  });
  warnings.push({
    code: 'ASSUMPTION_USED',
    message: 'Free-space propagation model only — no terrain, shadowing margin, or interference modeled beyond the loss values you supplied.',
    severity: 'warning',
  });

  return okResult(
    { eirpDbm, pathLossDb, totalReceivedPowerDbm },
    [eirpEquation(eirpInput, eirpDbm), pathLossEquation, linkBudgetEquation],
    { assumptions, warnings, model: modelName },
  );
}
