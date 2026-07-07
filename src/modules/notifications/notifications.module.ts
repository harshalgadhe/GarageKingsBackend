import { Module, forwardRef } from '@nestjs/common';
import { AdminNotificationsController } from './admin-notifications.controller.js';
import { ApiModule } from '../api/api.module.js';

@Module({
  imports: [forwardRef(() => ApiModule)],
  controllers: [AdminNotificationsController],
  providers: [],
  exports: []
})
export class NotificationsModule {}
export default NotificationsModule;
