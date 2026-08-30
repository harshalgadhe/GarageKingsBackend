import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export type StorageDriver = 'postgres' | 'dynamodb';

function documentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT || (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:8000');
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
    endpoint,
    credentials: endpoint ? { accessKeyId: 'local', secretAccessKey: 'local' } : undefined
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

const tableName = () => process.env.DYNAMODB_TABLE_NAME || 'garagekings-local';

export async function readStorageDriverPreference(): Promise<StorageDriver> {
  const override = String(process.env.STORAGE_DRIVER_OVERRIDE || '').trim().toLowerCase();
  if (override === 'postgres' || override === 'dynamodb') return override;
  if (process.env.NODE_ENV === 'production') {
    // A runtime preference is unsafe on Lambda: warm instances could keep a
    // different driver from newly started instances. Production changes must
    // therefore be made through the deployment environment and a redeploy.
    return 'postgres';
  }
  try {
    const result = await documentClient().send(new GetCommand({ TableName: tableName(), Key: { pk: 'SETTINGS', sk: 'APP' } }));
    return result.Item?.storageDriver === 'dynamodb' ? 'dynamodb' : 'postgres';
  } catch (error) {
    // PostgreSQL remains the safe compatibility fallback until the DynamoDB
    // migration is explicitly enabled and its control table is reachable.
    console.warn(`[storage] Could not read DynamoDB storage preference; using PostgreSQL: ${error?.message || error}`);
    return 'postgres';
  }
}

export async function writeStorageDriverPreference(driver: unknown): Promise<StorageDriver> {
  const normalized = String(driver || '').trim().toLowerCase();
  if (normalized !== 'postgres' && normalized !== 'dynamodb') throw new Error('Storage driver must be postgres or dynamodb.');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Storage driver selection is locked in production. Set STORAGE_DRIVER_OVERRIDE and redeploy.');
  }
  await documentClient().send(new UpdateCommand({
    TableName: tableName(), Key: { pk: 'SETTINGS', sk: 'APP' },
    UpdateExpression: 'SET #entity = if_not_exists(#entity, :entity), storageDriver = :driver, storageDriverUpdatedAt = :updatedAt',
    ExpressionAttributeNames: { '#entity': 'entity' },
    ExpressionAttributeValues: { ':entity': 'SETTINGS', ':driver': normalized, ':updatedAt': new Date().toISOString() }
  }));
  return normalized;
}
