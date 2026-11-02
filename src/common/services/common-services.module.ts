import { Module, Global } from '@nestjs/common';
import { UserCodeService } from './user-code.service';
import { DatabaseModule } from '../../database/database.module';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [UserCodeService],
  exports: [UserCodeService],
})
export class CommonServicesModule {}

