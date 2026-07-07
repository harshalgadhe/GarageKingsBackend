import { Controller, Get, Post, Delete, Param, Query, Request, UseGuards, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiService } from '../api/api.service.js';

@Controller('api/v1/admin/notifications')
@UseGuards(AuthGuard('jwt'))
export class AdminNotificationsController {
  constructor(private readonly apiService: ApiService) {}

  private checkAdmin(req: any) {
    const role = req.user?.role;
    if (role !== 'Owner' && role !== 'Admin') {
      throw new UnauthorizedException('Administrative privileges required.');
    }
  }

  @Get()
  async getNotifications(@Request() req: any, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    this.checkAdmin(req);
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const offsetNum = offset ? parseInt(offset, 10) : 0;
    return this.apiService.getSystemNotifications(limitNum, offsetNum);
  }

  @Post('read')
  async markNotificationsRead(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.markNotificationsRead();
  }

  @Delete(':id')
  async deleteNotification(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.deleteSystemNotification(id);
  }
}
export default AdminNotificationsController;
