import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { CrossServiceValidator } from '../../domain/services/cross-service-validator';
import {
  nrfConfigSchema,
  amfConfigSchema,
  smfConfigSchema,
  upfConfigSchema,
  ausfConfigSchema,
} from '../../domain/services/validation-schemas';
import { ValidationResult, ValidationError } from '../../domain/value-objects/validation-result';
import { ValidationResultDto } from '../dto';
import { AllConfigsDto } from '../dto';
import pino from 'pino';

export class ValidateConfigUseCase {
  private readonly crossValidator = new CrossServiceValidator();

  constructor(
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  async validateCurrent(): Promise<ValidationResultDto> {
    this.logger.info('Validating current configurations');
    const configs = await this.configRepo.loadAll();
    const result = this.crossValidator.validate(configs);
    return this.toDto(result);
  }

  validateDto(dto: AllConfigsDto): ValidationResultDto {
    const errors: ValidationError[] = [];

    const schemas: Array<{ name: string; schema: unknown; data: unknown }> = [
      { name: 'nrf', schema: nrfConfigSchema, data: dto.nrf },
      { name: 'amf', schema: amfConfigSchema, data: dto.amf },
      { name: 'smf', schema: smfConfigSchema, data: dto.smf },
      { name: 'upf', schema: upfConfigSchema, data: dto.upf },
      { name: 'ausf', schema: ausfConfigSchema, data: dto.ausf },
    ];

    for (const { name, schema, data } of schemas) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (schema as any).safeParse(data);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            field: `${name}.${issue.path.join('.')}`,
            message: issue.message,
            service: name,
            severity: 'error',
          });
        }
      }
    }

    const validationResult = new ValidationResult(errors);
    return this.toDto(validationResult);
  }

  private toDto(result: ValidationResult): ValidationResultDto {
    return {
      valid: result.isValid,
      errors: result.allIssues.map((e) => ({
        field: e.field,
        message: e.message,
        service: e.service,
        severity: e.severity,
      })),
    };
  }
}
