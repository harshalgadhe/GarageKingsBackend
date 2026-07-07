import { Module, forwardRef } from '@nestjs/common';
import { PublicSettingsController } from './public-settings.controller.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { ApiModule } from '../api/api.module.js';

@Module({
  imports: [forwardRef(() => ApiModule)],
  controllers: [PublicSettingsController, AdminSettingsController],
  providers: [],
  exports: []
})
export class SettingsModule {}
export default SettingsModule;
