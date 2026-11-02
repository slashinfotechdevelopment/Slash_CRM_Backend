import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
    @Get()
    checkHealth() {
        return {
            success: true,
            message: 'Slash Infotech CRM API is running',
            timestamp: new Date().toISOString(),
        };
    }
}