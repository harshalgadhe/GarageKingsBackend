import { Controller, Get, Query, Request, UseGuards, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiService } from '../api/api.service.js';

@Controller('api/v1/admin/analytics')
@UseGuards(AuthGuard('jwt'))
export class AdminAnalyticsController {
  constructor(private readonly apiService: ApiService) {}

  private checkAdmin(req: any) {
    const role = req.user?.role;
    if (role !== 'Owner' && role !== 'Admin') {
      throw new ForbiddenException('Access denied.');
    }
  }

  @Get()
  async getAnalytics(@Query('timeRange') timeRange?: string, @Request() req?: any) {
    this.checkAdmin(req);
    return this.apiService.getAnalyticsMetrics(timeRange);
  }

  @Get('dashboard/kpis')
  async getDashboardKpis(@Query('timeRange') timeRange?: string, @Query('cashAccountId') cashAccountId?: string, @Request() req?: any) {
    this.checkAdmin(req);
    return this.apiService.getFinanceMetrics(timeRange, cashAccountId);
  }

  @Get('dashboard/supplier-metrics')
  async getSupplierMetrics(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSupplierMetrics();
  }
}
export default AdminAnalyticsController;
