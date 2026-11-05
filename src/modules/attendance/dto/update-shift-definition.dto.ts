import { PartialType } from '@nestjs/swagger';
import { CreateShiftDefinitionDto } from './create-shift-definition.dto';

export class UpdateShiftDefinitionDto extends PartialType(
  CreateShiftDefinitionDto,
) {}

