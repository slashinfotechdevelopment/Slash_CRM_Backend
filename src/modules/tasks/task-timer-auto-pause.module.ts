import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { TaskTimerAutoPauseService } from './task-timer-auto-pause.service';

@Module({
  imports: [DatabaseModule],
  providers: [TaskTimerAutoPauseService],
  exports: [TaskTimerAutoPauseService],
})
export class TaskTimerAutoPauseModule {}

