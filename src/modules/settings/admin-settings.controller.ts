import { Controller, Post, Body, Request, UseGuards, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiService } from '../api/api.service.js';

@Controller('api/v1/admin/settings')
@UseGuards(AuthGuard('jwt'))
export class AdminSettingsController {
  constructor(private readonly apiService: ApiService) {}

  private checkAdmin(req: any) {
    const role = req.user?.role;
    if (role !== 'Owner' && role !== 'Admin') {
      throw new UnauthorizedException('Administrative privileges required.');
    }
  }

  @Post()
  async updateSettings(@Body() settings: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.updateGlobalSettings(settings, req.user.email, req.ip);
  }
}
export default AdminSettingsController;
