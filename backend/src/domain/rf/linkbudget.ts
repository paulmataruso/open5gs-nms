import {
  LinkBudgetInput, LinkBudgetResult, CalculationResult, Assumption, Warning, EquationRecord,
  okResult, errResult,
} from './rf-types';
import { calculateEirpDbm, eirpEquation } from './eirp';
import { fsplDb, fsplEquation } from './pathloss-fspl';
import { earfcnToFrequencyMhz } from './lte-bands';
import { hataPathLossDb, cost231HataPathLossDb } from './hata-model';
import { closeInPathLossDb, closeInEquation, UMI_SC_LOS_PLE, UMI_SC_NLOS_PLE } from './close-in-model';

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
    } else {
      const cityType = input.cityType ?? 'medium';
      if (input.cityType == null) {
        assumptions.push({ parameter: 'cityType', assumedValue: cityType, reason: 'Not provided by caller', overridable: true });
      }
      const c231Result = cost231HataPathLossDb(frequencyMhz, input.txHeightM, input.rxHeightM, distanceKm, cityType);
      if (!c231Result.ok) return errResult(c231Result.error);
      pathLossDb = c231Result.pathLossDb;
      pathLossEquation = c231Result.equation;
      modelName = `COST-231-Hata Model Link Budget (${cityType})`;
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
