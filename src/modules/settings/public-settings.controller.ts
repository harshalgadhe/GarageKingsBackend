import { Controller, Get } from '@nestjs/common';
import { ApiService } from '../api/api.service.js';

@Controller('api/v1/public/settings')
export class PublicSettingsController {
  constructor(private readonly apiService: ApiService) {}

  @Get()
  async getSettings() {
    return this.apiService.getGlobalSettings();
  }
}
export default PublicSettingsController;
