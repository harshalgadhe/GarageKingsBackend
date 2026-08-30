import 'dotenv/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const driver = String(process.argv[2] || '').trim().toLowerCase();
if (!['postgres', 'dynamodb'].includes(driver)) {
  throw new Error('Usage: npm run storage:select -- postgres|dynamodb');
}
const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
const client = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-south-1', endpoint,
  credentials: endpoint ? { accessKeyId: 'local', secretAccessKey: 'local' } : undefined
}));
await client.send(new UpdateCommand({
  TableName: process.env.DYNAMODB_TABLE_NAME || 'garagekings-local',
  Key: { pk: 'SETTINGS', sk: 'APP' },
  UpdateExpression: 'SET #entity = if_not_exists(#entity, :entity), storageDriver = :driver, storageDriverUpdatedAt = :now',
  ExpressionAttributeNames: { '#entity': 'entity' },
  ExpressionAttributeValues: { ':entity': 'SETTINGS', ':driver': driver, ':now': new Date().toISOString() }
}));
console.log(`Selected ${driver}. Restart the backend to apply it.`);
