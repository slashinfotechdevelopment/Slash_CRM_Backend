import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PermissionsService } from './permissions.service';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { PermissionQueryDto } from './dto/permission-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.service';

@ApiTags('Permissions')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('permissions.assign')
  @ApiOperation({
    summary: 'Create a new system permission',
    description: 'Requires permissions.assign or Super Admin authorization.',
  })
  @ApiResponse({ status: 201, description: 'Permission created successfully.' })
  @ApiResponse({ status: 409, description: 'Permission code already exists.' })
  async create(
    @Body() dto: CreatePermissionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.permissionsService.create(dto, user.sub);
    return {
      success: true,
      message: 'Permission created successfully.',
      data,
    };
  }

  @Get()
  @RequirePermissions('permissions.view')
  @ApiOperation({
    summary: 'List permissions with pagination and filters',
    description: 'Filter by module, status, or search code and name.',
  })
  @ApiResponse({ status: 200, description: 'Permissions retrieved successfully.' })
  async findAll(@Query() query: PermissionQueryDto) {
    const data = await this.permissionsService.findAll(query);
    return {
      success: true,
      message: 'Permissions retrieved successfully.',
      data,
    };
  }

  @Get('modules')
  @RequirePermissions('permissions.view')
  @ApiOperation({
    summary: 'Retrieve all active permissions grouped by module',
    description: 'Returns permissions formatted for role/permission management UI trees.',
  })
  @ApiResponse({
    status: 200,
    description: 'Grouped permissions retrieved successfully.',
  })
  async findGroupedByModule() {
    const data = await this.permissionsService.findGroupedByModule();
    return {
      success: true,
      message: 'Grouped permissions retrieved successfully.',
      data,
    };
  }

  @Get(':id')
  @RequirePermissions('permissions.view')
  @ApiOperation({ summary: 'Get permission details by ID' })
  @ApiResponse({ status: 200, description: 'Permission details retrieved.' })
  @ApiResponse({ status: 404, description: 'Permission not found.' })
  async findOne(@Param('id') id: string) {
    const data = await this.permissionsService.findOne(id);
    return {
      success: true,
      message: 'Permission details retrieved successfully.',
      data,
    };
  }

  @Patch(':id')
  @RequirePermissions('permissions.assign')
  @ApiOperation({ summary: 'Update permission name, description or status' })
  @ApiResponse({ status: 200, description: 'Permission updated successfully.' })
  @ApiResponse({ status: 404, description: 'Permission not found.' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePermissionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.permissionsService.update(id, dto, user.sub);
    return {
      success: true,
      message: 'Permission updated successfully.',
      data,
    };
  }

  @Delete(':id')
  @RequirePermissions('permissions.assign')
  @ApiOperation({
    summary: 'Delete permission',
    description: 'Fails if permission is assigned to protected system roles.',
  })
  @ApiResponse({ status: 200, description: 'Permission deleted successfully.' })
  @ApiResponse({
    status: 400,
    description: 'Cannot delete permission assigned to system roles.',
  })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const result = await this.permissionsService.remove(id, user.sub);
    return {
      success: true,
      message: result.message,
    };
  }
}

