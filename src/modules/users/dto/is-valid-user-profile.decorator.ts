import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { EmployeeProfileDto } from './employee-profile.dto';
import { ClientProfileDto } from './client-profile.dto';

@ValidatorConstraint({ name: 'IsValidUserProfile', async: false })
export class IsValidUserProfileConstraint implements ValidatorConstraintInterface {
  private failureReason = 'Invalid profile configuration';

  validate(profile: any, args: ValidationArguments): boolean {
    const object = args.object as Record<string, any>;
    const userType = object.userType;

    if (userType === 'ADMIN') {
      if (profile !== undefined && profile !== null) {
        this.failureReason = 'Profile data is not permitted for ADMIN user type.';
        return false;
      }
      return true;
    }

    if (userType === 'EMPLOYEE') {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        this.failureReason = 'Profile object is required for EMPLOYEE user type.';
        return false;
      }

      const instance = plainToInstance(EmployeeProfileDto, profile);
      const errors = validateSync(instance, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      if (errors.length > 0) {
        const firstError =
          errors[0].constraints && Object.values(errors[0].constraints)[0]
            ? Object.values(errors[0].constraints)[0]
            : `Invalid field: ${errors[0].property}`;
        this.failureReason = `Employee profile validation failed: ${firstError}`;
        return false;
      }
      return true;
    }

    if (userType === 'CLIENT') {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        this.failureReason = 'Profile object is required for CLIENT user type.';
        return false;
      }

      const instance = plainToInstance(ClientProfileDto, profile);
      const errors = validateSync(instance, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      if (errors.length > 0) {
        const firstError =
          errors[0].constraints && Object.values(errors[0].constraints)[0]
            ? Object.values(errors[0].constraints)[0]
            : `Invalid field: ${errors[0].property}`;
        this.failureReason = `Client profile validation failed: ${firstError}`;
        return false;
      }
      return true;
    }

    // Default to true if userType is invalid (userType validation will flag it)
    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    return this.failureReason;
  }
}

export function IsValidUserProfile(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidUserProfileConstraint,
    });
  };
}

