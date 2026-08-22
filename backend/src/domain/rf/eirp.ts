import { EquationRecord } from './rf-types';

export interface EirpInput {
  txPowerDbm: number;
  cableLossDb: number;
  connectorLossDb: number;
  filterLossDb: number;
  antennaGainDbi: number;
}

export function calculateEirpDbm(input: EirpInput): number {
  return input.txPowerDbm - input.cableLossDb - input.connectorLossDb - input.filterLossDb + input.antennaGainDbi;
}

export function eirpEquation(input: EirpInput, eirpDbm: number): EquationRecord {
  return {
    name: 'EIRP',
    formula: 'EIRP(dBm) = Ptx − cableLoss − connectorLoss − filterLoss + antennaGain',
    variables: {
      Ptx:           { description: 'Conducted transmit power', unit: 'dBm', value: input.txPowerDbm },
      cableLoss:     { description: 'Feeder cable loss', unit: 'dB', value: input.cableLossDb },
      connectorLoss: { description: 'Connector loss', unit: 'dB', value: input.connectorLossDb },
      filterLoss:    { description: 'Filter/duplexer loss', unit: 'dB', value: input.filterLossDb },
      antennaGain:   { description: 'Antenna gain', unit: 'dBi', value: input.antennaGainDbi },
      EIRP:          { description: 'Effective Isotropic Radiated Power', unit: 'dBm', value: eirpDbm },
    },
    source: 'ITU-R Recommendation V.573 (EIRP definition); FCC 47 CFR §2.1',
    applicableConditions: 'All terms referenced at the same connector/reference plane',
  };
}
