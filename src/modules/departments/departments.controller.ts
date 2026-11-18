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
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { QueryDepartmentsDto } from './dto/query-departments.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.service';

@ApiTags('Departments')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  @RequirePermissions('departments.view')
  @ApiOperation({
    summary: 'List departments with search, hierarchy, and optional pagination',
    description: 'Retrieves all active departments for dropdown selectors and organizational hierarchies.',
  })
  @ApiResponse({ status: 200, description: 'Departments retrieved successfully.' })
  async getDepartments(@Query() query: QueryDepartmentsDto) {
    const data = await this.departmentsService.getDepartments(query);
    return {
      success: true,
      data: data.items,
      pagination: data.total !== undefined
        ? {
            total: data.total,
            page: data.page ?? 1,
            limit: data.limit ?? data.total,
            totalPages: data.totalPages ?? 1,
          }
        : undefined,
    };
  }

  @Get(':id')
  @RequirePermissions('departments.view')
  @ApiOperation({
    summary: 'Get department details by ID',
    description: 'Retrieves full details of a department including sub-departments and assigned employees.',
  })
  @ApiResponse({ status: 200, description: 'Department details retrieved.' })
  @ApiResponse({ status: 404, description: 'Department not found.' })
  async getDepartmentById(@Param('id') id: string) {
    const data = await this.departmentsService.getDepartmentById(id);
    return {
      success: true,
      data,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('departments.create')
  @ApiOperation({
    summary: 'Create a new department',
    description: 'Creates a new department dynamically. Accessible to Admins and Super Admins.',
  })
  @ApiResponse({ status: 201, description: 'Department created successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid input or validation error.' })
  @ApiResponse({ status: 409, description: 'Department code already exists.' })
  async createDepartment(
    @Body() dto: CreateDepartmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.departmentsService.createDepartment(dto, user.sub);
    return {
      success: true,
      message: `Department "${data.name}" created successfully.`,
      data,
    };
  }

  @Patch(':id')
  @RequirePermissions('departments.update')
  @ApiOperation({
    summary: 'Update an existing department',
    description: 'Modifies department name, description, status, or parent department hierarchy.',
  })
  @ApiResponse({ status: 200, description: 'Department updated successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid update parameters or circular hierarchy.' })
  @ApiResponse({ status: 404, description: 'Department not found.' })
  async updateDepartment(
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.departmentsService.updateDepartment(id, dto, user.sub);
    return {
      success: true,
      message: `Department "${data.name}" updated successfully.`,
      data,
    };
  }

  @Delete(':id')
  @RequirePermissions('departments.delete')
  @ApiOperation({
    summary: 'Delete or deactivate a department',
    description: 'Safely deactivates a department provided no active employees are assigned.',
  })
  @ApiResponse({ status: 200, description: 'Department deleted successfully.' })
  @ApiResponse({ status: 400, description: 'Cannot delete department with active employees.' })
  @ApiResponse({ status: 404, description: 'Department not found.' })
  async deleteDepartment(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const result = await this.departmentsService.deleteDepartment(id, user.sub);
    return {
      success: true,
      message: result.message,
    };
  }
}
