import { Module, forwardRef } from '@nestjs/common';
import { AdminAnalyticsController } from './admin-analytics.controller.js';
import { ApiModule } from '../api/api.module.js';

@Module({
  imports: [forwardRef(() => ApiModule)],
  controllers: [AdminAnalyticsController],
  providers: [],
  exports: []
})
export class AnalyticsModule {}
export default AnalyticsModule;
