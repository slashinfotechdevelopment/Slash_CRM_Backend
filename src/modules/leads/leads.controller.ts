import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  Ip,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { LeadsService } from './leads.service';
import { LeadPipelineService } from './lead-pipeline.service';
import {
  CreateLeadDto,
  UpdateLeadDto,
  QueryLeadsDto,
  AssignLeadDto,
  QualifyLeadDto,
  ChangeLeadStatusDto,
  ConvertLeadDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

@Controller('leads')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly pipelineService: LeadPipelineService,
  ) {}

  @Post()
  @RequirePermissions('leads.create')
  async create(
    @Body() dto: CreateLeadDto,
    @Req() req: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const lead = await this.leadsService.create(
      dto,
      req.user.sub,
      ip,
      userAgent,
    );
    return {
      success: true,
      message: 'Lead created successfully.',
      data: lead,
    };
  }

  @Get()
  @RequirePermissions('leads.view')
  async findAll(@Query() query: QueryLeadsDto, @Req() req: any) {
    const result = await this.leadsService.findAll(
      query,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'Leads retrieved successfully.',
      data: result,
    };
  }

  @Get(':id')
  @RequirePermissions('leads.view')
  async findOne(@Param('id') id: string, @Req() req: any) {
    const lead = await this.leadsService.findOne(
      id,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'Lead details retrieved successfully.',
      data: lead,
    };
  }

  @Put(':id')
  @RequirePermissions('leads.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @Req() req: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const updated = await this.leadsService.update(
      id,
      dto,
      req.user.sub,
      req.user.userType,
      ip,
      userAgent,
    );
    return {
      success: true,
      message: 'Lead updated successfully.',
      data: updated,
    };
  }

  @Delete(':id')
  @RequirePermissions('leads.delete')
  async remove(
    @Param('id') id: string,
    @Req() req: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.leadsService.remove(
      id,
      req.user.sub,
      req.user.userType,
      ip,
      userAgent,
    );
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leads.restore')
  async restore(
    @Param('id') id: string,
    @Req() req: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const restored = await this.leadsService.restore(
      id,
      req.user.sub,
      ip,
      userAgent,
    );
    return {
      success: true,
      message: 'Lead restored successfully.',
      data: restored,
    };
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leads.assign')
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignLeadDto,
    @Req() req: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    const lead = await this.pipelineService.assignLead(
      id,
      dto,
      req.user.sub,
      req.user.userType,
      ip,
      userAgent,
    );
    return {
      success: true,
      message: 'Lead assignment updated successfully.',
      data: lead,
    };
  }

  @Post(':id/qualify')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leads.update')
  async qualify(
    @Param('id') id: string,
    @Body() dto: QualifyLeadDto,
    @Req() req: any,
  ) {
    const lead = await this.pipelineService.qualifyLead(
      id,
      dto,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'Lead qualification updated successfully.',
      data: lead,
    };
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leads.update')
  async changeStatus(
    @Param('id') id: string,
    @Body() dto: ChangeLeadStatusDto,
    @Req() req: any,
  ) {
    const lead = await this.pipelineService.changeStatus(
      id,
      dto,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'Lead status updated successfully.',
      data: lead,
    };
  }

  @Post(':id/convert')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leads.update')
  async convert(
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
    @Req() req: any,
  ) {
    const lead = await this.pipelineService.convertLead(
      id,
      dto,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'Lead converted successfully. Ready for client account creation.',
      data: lead,
    };
  }
}
