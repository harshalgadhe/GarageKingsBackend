import { Injectable, OnModuleInit } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp/storage/uploads' : path.join(moduleDir, '..', '..', '..', 'storage', 'uploads');

@Injectable()
export class DynamoAssetsService implements OnModuleInit {
  onModuleInit() { fs.mkdirSync(uploadDir, { recursive: true }); }

  async upload(buffer: Buffer, filename: string, contentType: string) {
    const bucket = process.env.S3_ASSETS_BUCKET?.trim();
    if (bucket) {
      const s3 = new S3Client({ region: process.env.AWS_REGION?.trim() || 'ap-south-1' });
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `uploads/${filename}`, Body: buffer, ContentType: contentType }));
      return `https://${bucket}.s3.amazonaws.com/uploads/${filename}`;
    }
    fs.writeFileSync(path.join(uploadDir, filename), buffer);
    return `/api/v1/images/${filename}`;
  }

  async read(filename: string) {
    const safeName = path.basename(filename);
    const bucket = process.env.S3_ASSETS_BUCKET?.trim();
    if (bucket) {
      const s3 = new S3Client({ region: process.env.AWS_REGION?.trim() || 'ap-south-1' });
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `uploads/${safeName}` }));
      return result.Body as any;
    }
    const target = path.join(uploadDir, safeName);
    return fs.existsSync(target) ? fs.createReadStream(target) : null;
  }
}
