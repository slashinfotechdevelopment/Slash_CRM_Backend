import {
  Controller,
  Post,
  Body,
  Ip,
  Headers,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LeadSourcesService } from './lead-sources.service';
import { PublicInquiryDto } from './dto';

@Controller('leads/public')
export class LeadsPublicController {
  constructor(private readonly leadSourcesService: LeadSourcesService) {}

  /**
   * Public contact / inquiry form submission endpoint.
   * No JWT required. Enters unassigned queue with source = WEBSITE.
   * Rate limited at controller level + application level.
   */
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('inquire')
  async submitInquiry(
    @Body() dto: PublicInquiryDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.leadSourcesService.handlePublicInquiry(dto, ip, userAgent);
  }
}
