import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const zipPath = path.join(__dirname, 'dummy_payload.zip');

// Enforce a valid 22-byte ZIP header for empty zip archives
const emptyZipBuffer = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00
]);

fs.writeFileSync(zipPath, emptyZipBuffer);
console.log(`✔ Generated valid empty ZIP file at: ${zipPath}`);
