import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DataSource } from 'typeorm';

type RdsMasterSecret = {
  username: string;
  password: string;
  host?: string;
  port?: number;
  dbname?: string;
};

export async function createMigrationDataSource(): Promise<DataSource> {
  const secretArn = process.env.RDS_MASTER_SECRET_ARN?.trim();
  if (!secretArn) throw new Error('RDS_MASTER_SECRET_ARN is required for migrations.');

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || 'ap-south-1',
    endpoint: process.env.SECRETS_MANAGER_ENDPOINT?.trim() || undefined,
  });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('The RDS migration secret has no string value.');

  const secret = JSON.parse(response.SecretString) as RdsMasterSecret;
  const host = secret.host || process.env.MIGRATION_DATABASE_HOST?.trim();
  if (!host) throw new Error('MIGRATION_DATABASE_HOST is required when the RDS secret has no host.');
  const dataSource = new DataSource({
    type: 'postgres',
    host,
    port: Number(secret.port || process.env.MIGRATION_DATABASE_PORT || 5432),
    username: secret.username,
    password: secret.password,
    database: secret.dbname || process.env.MIGRATION_DATABASE_NAME || 'garagekings_prod',
    ssl: process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
    extra: { max: 1, min: 0, connectionTimeoutMillis: 10000, idleTimeoutMillis: 5000 },
  });

  await dataSource.initialize();
  return dataSource;
}
