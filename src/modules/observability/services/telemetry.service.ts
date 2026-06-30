import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { AlertService } from './alert.service.js';

@Injectable()
export class TelemetryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly alertService: AlertService
  ) {}

  async logError(errorData: {
    errorType: 'Frontend' | 'Backend';
    message: string;
    stackTrace?: string;
    exceptionType?: string;
    severity?: string;
    module?: string;
    route?: string;
    endpoint?: string;
    userId?: string;
    userEmail?: string;
    sessionId?: string;
    url?: string;
    browser?: string;
    device?: string;
    correlationId?: string;
    payload?: any;
    duration?: number;
    buildVersion?: string;
  }) {
    try {
      const message = errorData.message || 'Unknown error';
      const stack = errorData.stackTrace || '';
      const category = this.classifyError(message, stack, errorData.route || errorData.endpoint || '');
      const redactedPayload = errorData.payload ? this.redactPayload(errorData.payload) : null;

      // Fingerprinting: hash the cleaned message and stack
      const cleanSource = this.getCleanFingerprintSource(message, stack);
      const fingerprint = crypto.createHash('sha256').update(cleanSource).digest('hex');

      // Insert or Update error using upsert syntax
      await this.dataSource.query(`
        INSERT INTO telemetry_errors (
          fingerprint, error_type, category, message, stack_trace, exception_type, severity, 
          module, route, endpoint, occurrence_count, latest_user_id, latest_user_email, 
          latest_session_id, latest_url, latest_browser, latest_device, latest_correlation_id, 
          latest_payload, latest_duration, build_version, last_occurrence
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, CURRENT_TIMESTAMP)
        ON CONFLICT (fingerprint) DO UPDATE SET
          occurrence_count = telemetry_errors.occurrence_count + 1,
          last_occurrence = CURRENT_TIMESTAMP,
          latest_user_id = EXCLUDED.latest_user_id,
          latest_user_email = EXCLUDED.latest_user_email,
          latest_session_id = EXCLUDED.latest_session_id,
          latest_url = EXCLUDED.latest_url,
          latest_browser = EXCLUDED.latest_browser,
          latest_device = EXCLUDED.latest_device,
          latest_correlation_id = EXCLUDED.latest_correlation_id,
          latest_payload = EXCLUDED.latest_payload,
          latest_duration = EXCLUDED.latest_duration,
          acknowledged = FALSE;
      `, [
        fingerprint,
        errorData.errorType,
        category,
        message,
        stack,
        errorData.exceptionType || 'Error',
        errorData.severity || 'Error',
        errorData.module || 'Root',
        errorData.route,
        errorData.endpoint,
        errorData.userId,
        errorData.userEmail,
        errorData.sessionId,
        errorData.url,
        errorData.browser,
        errorData.device,
        errorData.correlationId,
        redactedPayload ? JSON.stringify(redactedPayload) : null,
        errorData.duration || null,
        errorData.buildVersion || '1.0.0'
      ]);

      // Check alert conditions after logging error
      this.alertService.checkAlerts().catch((err: any) => {
        console.error('Failed to run alert checks after error logging:', err.message);
      });
    } catch (e: any) {
      // Direct console log as fallback to avoid recursion
      console.error('Failed to log telemetry error:', e.message);
    }
  }

  private classifyError(message: string, stack: string, location: string): string {
    const text = `${message} ${stack} ${location}`.toLowerCase();

    if (text.includes('connection refused') || text.includes('failed to connect') || text.includes('db_connection') || text.includes('database connection')) {
      return 'DB_CONNECTION_ERROR';
    }
    if (text.includes('select ') || text.includes('insert ') || text.includes('update ') || text.includes('relation "') || text.includes('postgresql') || text.includes('typeorm')) {
      return 'DB_QUERY_ERROR';
    }
    if (text.includes('jwt expired') || text.includes('token expired') || text.includes('jwt malformed')) {
      return 'AUTH_EXPIRED_TOKEN';
    }
    if (text.includes('invalid credentials') || text.includes('password') && text.includes('incorrect') || text.includes('username/password')) {
      return 'AUTH_INVALID_CREDENTIALS';
    }
    if (text.includes('unauthorized') || text.includes('401') || text.includes('forbidden') || text.includes('403')) {
      return 'AUTH_UNAUTHORIZED';
    }
    if (text.includes('cognito') || text.includes('aws-sdk') && text.includes('identity-provider')) {
      return 'INTEGRATION_COGNITO_ERROR';
    }
    if (text.includes('stripe') || text.includes('payment_intent') || text.includes('checkout session')) {
      return 'INTEGRATION_STRIPE_ERROR';
    }
    if (text.includes('s3') || text.includes('aws-sdk/client-s3') || text.includes('s3 upload')) {
      return 'INTEGRATION_S3_ERROR';
    }
    if (text.includes('validation') || text.includes('bad request') || text.includes('is not valid') || text.includes('400')) {
      return 'VALIDATION_ERROR';
    }
    if (text.includes('limit reached') || text.includes('already reserved') || text.includes('max qty') || text.includes('insufficient stock')) {
      return 'BUSINESS_RULE_VIOLATION';
    }
    if (text.includes('not found') || text.includes('404')) {
      return 'NOT_FOUND';
    }
    if (text.includes('fetch') || text.includes('network') || text.includes('connection_refused') || text.includes('net::')) {
      return 'NETWORK_ERROR';
    }
    if (text.includes('exception') || text.includes('runtime') || text.includes('nullpointer') || text.includes('undefined')) {
      return 'RUNTIME_EXCEPTION';
    }
    return 'UNKNOWN';
  }

  private getCleanFingerprintSource(message: string, stack: string): string {
    let text = `${message}\n${stack}`;
    // Strip dynamic values (UUIDs, numbers, emails, hex tokens)
    text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, 'UUID');
    text = text.replace(/\b\d+\b/g, 'NUM');
    text = text.replace(/[\w.-]+@[\w.-]+\.\w+/g, 'EMAIL');
    text = text.replace(/\b0x[0-9a-f]+\b/ig, 'HEX');
    return text;
  }

  private redactPayload(payload: any): any {
    if (!payload) return payload;
    if (typeof payload !== 'object') return payload;

    const redacted = Array.isArray(payload) ? [] : {};
    const sensitiveKeys = ['password', 'token', 'access_token', 'refresh_token', 'secret', 'authorization', 'cookie', 'cvv', 'card', 'pin'];

    for (const key of Object.keys(payload)) {
      const val = payload[key];
      if (sensitiveKeys.includes(key.toLowerCase())) {
        redacted[key] = '[REDACTED]';
      } else if (typeof val === 'object' && val !== null) {
        redacted[key] = this.redactPayload(val);
      } else {
        redacted[key] = val;
      }
    }
    return redacted;
  }
}
export default TelemetryService;
