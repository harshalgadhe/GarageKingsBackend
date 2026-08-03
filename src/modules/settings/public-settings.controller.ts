import { Controller, Get } from '@nestjs/common';
import { ApiService } from '../api/api.service.js';

@Controller('api/v1/public/settings')
export class PublicSettingsController {
  constructor(private readonly apiService: ApiService) {}

  @Get()
  async getSettings() {
    const raw = await this.apiService.getGlobalSettings();
    return {
      showPrices: raw.showPrices,
      instagramUrl: raw.instagramUrl,
      companyUpiId: raw.companyUpiId,
      upiQrImage: raw.upiQrImage,
      partnerNames: raw.partnerNames
    };
  }
}
export default PublicSettingsController;
