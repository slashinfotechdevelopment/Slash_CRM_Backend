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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { PermissionAssignmentItemDto } from './dto/permission-assignment-item.dto';
import { RoleQueryDto } from './dto/role-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.service';

@ApiTags('Roles')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('roles.create')
  @ApiOperation({
    summary: 'Create a new custom role',
    description: 'Creates a custom role with optional initial permissions and data scopes.',
  })
  @ApiResponse({ status: 201, description: 'Role created successfully.' })
  @ApiResponse({ status: 403, description: 'Cannot delegate permissions you do not possess.' })
  @ApiResponse({ status: 409, description: 'Role code already exists.' })
  async create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.rolesService.create(dto, user.sub, user.userType);
    return {
      success: true,
      message: 'Role created successfully.',
      data,
    };
  }

  @Get()
  @RequirePermissions('roles.view')
  @ApiOperation({
    summary: 'List roles with pagination and search',
    description: 'Excludes soft-deleted roles by default. Shows user and permission counts.',
  })
  @ApiResponse({ status: 200, description: 'Roles retrieved successfully.' })
  async findAll(@Query() query: RoleQueryDto) {
    const data = await this.rolesService.findAll(query);
    return {
      success: true,
      message: 'Roles retrieved successfully.',
      data,
    };
  }

  @Get(':id')
  @RequirePermissions('roles.view')
  @ApiOperation({ summary: 'Get role details and assigned permissions' })
  @ApiResponse({ status: 200, description: 'Role details retrieved.' })
  @ApiResponse({ status: 404, description: 'Role not found or deleted.' })
  async findOne(@Param('id') id: string) {
    const data = await this.rolesService.findOne(id);
    return {
      success: true,
      message: 'Role details retrieved successfully.',
      data,
    };
  }

  @Patch(':id')
  @RequirePermissions('roles.update')
  @ApiOperation({ summary: 'Update role name, description, or status' })
  @ApiResponse({ status: 200, description: 'Role updated successfully.' })
  @ApiResponse({ status: 403, description: 'Only Super Admin can modify system roles.' })
  @ApiResponse({ status: 404, description: 'Role not found.' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.rolesService.update(id, dto, user.sub, user.userType);
    return {
      success: true,
      message: 'Role updated successfully.',
      data,
    };
  }

  @Delete(':id')
  @RequirePermissions('roles.delete')
  @ApiOperation({
    summary: 'Soft delete role',
    description: 'Cannot delete protected system roles or roles currently assigned to active users.',
  })
  @ApiResponse({ status: 200, description: 'Role soft deleted successfully.' })
  @ApiResponse({ status: 400, description: 'Role is system protected or assigned to active users.' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const result = await this.rolesService.remove(id, user.sub, user.userType);
    return {
      success: true,
      message: result.message,
    };
  }

  @Patch(':id/restore')
  @RequirePermissions('roles.delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted custom role',
    description: 'Restricted to Super Admin. Restores only eligible custom roles.',
  })
  @ApiResponse({ status: 200, description: 'Role restored successfully.' })
  @ApiResponse({ status: 400, description: 'Role is not deleted or is a protected system role.' })
  @ApiResponse({ status: 403, description: 'Only Super Admin can restore roles.' })
  @ApiResponse({ status: 404, description: 'Role not found.' })
  async restore(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.rolesService.restore(id, user.sub, user.userType);
    return {
      success: true,
      message: 'Role restored successfully.',
      data,
    };
  }

  @Get(':id/permissions')
  @RequirePermissions('roles.view')
  @ApiOperation({ summary: 'Get all permissions assigned to a role' })
  @ApiResponse({ status: 200, description: 'Role permissions retrieved.' })
  async getPermissions(@Param('id') id: string) {
    const data = await this.rolesService.getRolePermissions(id);
    return {
      success: true,
      message: 'Role permissions retrieved successfully.',
      data,
    };
  }

  @Put(':id/permissions')
  @RequirePermissions('roles.assign')
  @ApiOperation({
    summary: 'Replace all permissions assigned to a role',
    description: 'Atomically replaces role permission mappings. Enforces delegation authority for non-Super Admin callers.',
  })
  @ApiResponse({ status: 200, description: 'Role permissions replaced successfully.' })
  @ApiResponse({ status: 403, description: 'Cannot delegate permissions you do not possess.' })
  async replacePermissions(
    @Param('id') id: string,
    @Body() dto: AssignPermissionsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.rolesService.replacePermissions(
      id,
      dto,
      user.sub,
      user.userType,
    );
    return {
      success: true,
      message: 'Role permissions replaced successfully.',
      data,
    };
  }

  @Post(':id/permissions')
  @RequirePermissions('roles.assign')
  @ApiOperation({ summary: 'Add or update a single permission assignment for a role' })
  @ApiResponse({ status: 200, description: 'Permission assigned to role.' })
  @ApiResponse({ status: 403, description: 'Cannot delegate permissions you do not possess.' })
  async addPermission(
    @Param('id') id: string,
    @Body() dto: PermissionAssignmentItemDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.rolesService.addPermission(
      id,
      dto,
      user.sub,
      user.userType,
    );
    return {
      success: true,
      message: 'Permission assigned to role successfully.',
      data,
    };
  }

  @Delete(':id/permissions/:permissionId')
  @RequirePermissions('roles.assign')
  @ApiOperation({ summary: 'Remove a single permission assignment from a role' })
  @ApiResponse({ status: 200, description: 'Permission removed from role.' })
  @ApiResponse({ status: 403, description: 'Cannot remove permissions from Super Admin role.' })
  async removePermission(
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const result = await this.rolesService.removePermission(
      id,
      permissionId,
      user.sub,
      user.userType,
    );
    return {
      success: true,
      message: result.message,
    };
  }
}
