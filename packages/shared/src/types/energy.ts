export interface EnergyMetrics {
  energyWh: number;
  carbonGrams: number;
}

export interface ModelEnergyProfile {
  inputWhPerMillion: number;
  outputWhPerMillion: number;
  source: 'measured' | 'estimated' | 'zero';
}

export interface EnergyConfig {
  enabled: boolean;
  gridCarbonIntensity: number;
  localModelCarbonIntensity: number;
  includeInRouting: boolean;
  energyWeight: number;
}

export interface EfficiencyReport {
  actualEnergyWh: number;
  actualCarbonGrams: number;
  baselineEnergyWh: number;
  baselineCarbonGrams: number;
  savedEnergyWh: number;
  savedCarbonGrams: number;
  savingsPercent: number;
  baselineModel: string;
}
