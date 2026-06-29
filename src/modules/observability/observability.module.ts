import { Module } from '@nestjs/common';
import { ObservabilityController } from './observability.controller.js';
import { TelemetryService } from './services/telemetry.service.js';
import { AuditLogService } from './services/audit-log.service.js';
import { MetricsService } from './services/metrics.service.js';
import { HealthService } from './services/health.service.js';
import { AlertService } from './services/alert.service.js';
import { DiagnosticsService } from './services/diagnostics.service.js';

@Module({
  controllers: [ObservabilityController],
  providers: [
    TelemetryService,
    AuditLogService,
    MetricsService,
    HealthService,
    AlertService,
    DiagnosticsService
  ],
  exports: [
    TelemetryService,
    AuditLogService,
    MetricsService,
    HealthService,
    AlertService,
    DiagnosticsService
  ]
})
export class ObservabilityModule {}
export default ObservabilityModule;
