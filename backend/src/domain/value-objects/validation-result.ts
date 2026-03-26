export interface ValidationError {
  field: string;
  message: string;
  service?: string;
  severity: 'error' | 'warning';
}

export class ValidationResult {
  public readonly errors: ValidationError[];
  public readonly warnings: ValidationError[];

  constructor(errors: ValidationError[] = []) {
    this.errors = errors.filter((e) => e.severity === 'error');
    this.warnings = errors.filter((e) => e.severity === 'warning');
  }

  get isValid(): boolean {
    return this.errors.length === 0;
  }

  get allIssues(): ValidationError[] {
    return [...this.errors, ...this.warnings];
  }

  merge(other: ValidationResult): ValidationResult {
    return new ValidationResult([...this.allIssues, ...other.allIssues]);
  }

  static ok(): ValidationResult {
    return new ValidationResult([]);
  }

  static error(field: string, message: string, service?: string): ValidationResult {
    return new ValidationResult([{ field, message, service, severity: 'error' }]);
  }

  static warning(field: string, message: string, service?: string): ValidationResult {
    return new ValidationResult([{ field, message, service, severity: 'warning' }]);
  }
}
