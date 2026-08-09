import fs from 'fs';
import * as archiverModule from 'archiver';

const OUTPUT = 'lambda-deploy.zip';
if (fs.existsSync(OUTPUT)) fs.unlinkSync(OUTPUT);

const output = fs.createWriteStream(OUTPUT);
const archiveOptions = { zlib: { level: 1 } };
const archive = typeof archiverModule.default === 'function'
  ? archiverModule.default('zip', archiveOptions)
  : new archiverModule.ZipArchive(archiveOptions);

await new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
  archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });

  archive.pipe(output);
  archive.directory('dist/', 'dist');
  archive.directory('certs/', 'certs');
  archive.directory('node_modules/', 'node_modules');
  archive.file('package.json', { name: 'package.json' });
  archive.finalize();
});

const mb = (archive.pointer() / 1024 / 1024).toFixed(1);
console.log(`Done. lambda-deploy.zip: ${mb} MB`);
