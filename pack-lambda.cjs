#!/usr/bin/env node
// Fast Lambda zip packager using archiver (CommonJS)
const fs = require('fs');
const path = require('path');

const OUTPUT = 'lambda-deploy-new.zip';

async function pack() {
  const { ZipArchive } = await import('archiver');
  if (fs.existsSync(OUTPUT)) fs.unlinkSync(OUTPUT);
  
  const output = fs.createWriteStream(OUTPUT);
  const archive = new ZipArchive({ zlib: { level: 1 } }); // level 1 = fast

  output.on('close', () => {
    const mb = (archive.pointer() / 1024 / 1024).toFixed(1);
    console.log(`Done. lambda-deploy.zip: ${mb} MB`);
  });

  archive.on('warning', err => { if (err.code !== 'ENOENT') throw err; });
  archive.on('error', err => { throw err; });
  archive.pipe(output);

  archive.directory('dist/', 'dist');
  archive.directory('node_modules/', 'node_modules');
  archive.file('package.json', { name: 'package.json' });

  await archive.finalize();
}

pack().catch(err => { console.error(err); process.exit(1); });
