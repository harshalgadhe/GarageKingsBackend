import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class MetricsService {
  constructor(private readonly dataSource: DataSource) {}

  async recordMetric(metric: {
    metricType: string;
    feature: string;
    endpoint?: string;
    durationMs?: number;
    payloadSizeBytes?: number;
    correlationId?: string;
    userId?: string;
    metadata?: any;
  }) {
    try {
      await this.dataSource.query(`
        INSERT INTO performance_metrics (
          metric_type, feature, endpoint, duration_ms, payload_size_bytes, correlation_id, user_id, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        metric.metricType,
        metric.feature,
        metric.endpoint || null,
        metric.durationMs || null,
        metric.payloadSizeBytes || null,
        metric.correlationId || null,
        metric.userId || null,
        metric.metadata ? JSON.stringify(metric.metadata) : null
      ]);
    } catch (e: any) {
      console.error('Failed to log performance metric:', e.message);
    }
  }

  async getPerformanceMetrics(feature?: string) {
    let queryStr = `
      SELECT 
        feature,
        COUNT(*)::int as "totalRequests",
        ROUND(AVG(duration_ms))::int as "avgLatency",
        MAX(duration_ms)::int as "maxLatency",
        COUNT(CASE WHEN duration_ms > 2000 THEN 1 END)::int as "slowRequests"
      FROM performance_metrics
      WHERE timestamp > NOW() - INTERVAL '24 HOURS'
    `;
    const params = [];
    if (feature) {
      queryStr += ' AND feature = $1';
      params.push(feature);
    }
    queryStr += ' GROUP BY feature';
    return this.dataSource.query(queryStr, params);
  }
}
export default MetricsService;
