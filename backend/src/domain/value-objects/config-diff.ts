export interface ConfigDiffEntry {
  service: string;
  field: string;
  oldValue: string;
  newValue: string;
  type: 'added' | 'removed' | 'changed';
}

export interface ConfigDiff {
  entries: ConfigDiffEntry[];
  hasDifferences: boolean;
  summary: string;
}
