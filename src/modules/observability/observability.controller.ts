import { Controller, Get, Post, Patch, Body, Query, Request, UseGuards, Param, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TelemetryService } from './services/telemetry.service.js';
import { AuditLogService } from './services/audit-log.service.js';
import { MetricsService } from './services/metrics.service.js';
import { HealthService } from './services/health.service.js';
import { AlertService } from './services/alert.service.js';
import { DiagnosticsService } from './services/diagnostics.service.js';

@Controller('api/v1')
export class ObservabilityController {
  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly auditLogService: AuditLogService,
    private readonly metricsService: MetricsService,
    private readonly healthService: HealthService,
    private readonly alertService: AlertService,
    private readonly diagnosticsService: DiagnosticsService
  ) {}

  @Get('health')
  async getHealth() {
    return this.healthService.getHealth();
  }

  @Post('telemetry/log')
  async logFrontendError(@Body() body: any, @Request() req: any) {
    await this.telemetryService.logError({
      errorType: 'Frontend',
      message: body.message,
      stackTrace: body.stack,
      url: body.url,
      browser: body.userAgent,
      userEmail: body.userEmail,
      correlationId: body.correlationId || req.headers['x-correlation-id']
    });
    return { success: true };
  }

  private checkAdmin(req: any) {
    const role = req.user?.role?.toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Owner privilege required.');
    }
  }

  @Get('admin/telemetry/errors')
  @UseGuards(AuthGuard('jwt'))
  async getTelemetryErrors(
    @Query('page') page: number,
    @Query('limit') limit: number,
    @Query('search') search: string,
    @Query('acknowledged') acknowledged: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    const ackValue = acknowledged === 'true' ? true : acknowledged === 'false' ? false : undefined;
    return this.diagnosticsService.getRecentErrors({ page, limit, search, acknowledged: ackValue });
  }

  @Patch('admin/telemetry/errors/:fingerprint/acknowledge')
  @UseGuards(AuthGuard('jwt'))
  async acknowledgeError(
    @Param('fingerprint') fingerprint: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.diagnosticsService.acknowledgeError(fingerprint);
  }

  @Post('admin/telemetry/clear-errors')
  @UseGuards(AuthGuard('jwt'))
  async clearAllErrors(@Request() req: any) {
    this.checkAdmin(req);
    return this.diagnosticsService.clearAllErrors();
  }

  @Get('admin/audit-logs')
  @UseGuards(AuthGuard('jwt'))
  async getAuditLogs(
    @Query('page') page: number,
    @Query('limit') limit: number,
    @Query('search') search: string,
    @Query('category') category: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.auditLogService.getLogs({ page, limit, search, category });
  }

  @Get('admin/performance-metrics')
  @UseGuards(AuthGuard('jwt'))
  async getPerformanceStats(
    @Query('feature') feature: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    return this.metricsService.getPerformanceMetrics(feature);
  }

  @Get('admin/observability/settings')
  @UseGuards(AuthGuard('jwt'))
  async getSettings(@Request() req: any) {
    this.checkAdmin(req);
    return this.alertService.getObservabilitySettings();
  }

  @Post('admin/observability/settings')
  @UseGuards(AuthGuard('jwt'))
  async saveSettings(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    const result = await this.alertService.saveObservabilitySettings(body);
    
    // Trigger cleanup and alerts check immediately in the background
    this.alertService.runRetentionCleanup().catch((e: any) => console.error('Failed to run retention cleanup:', e.message));
    this.alertService.checkAlerts().catch((e: any) => console.error('Failed to check alerts:', e.message));
    
    return result;
  }
}
export default ObservabilityController;
