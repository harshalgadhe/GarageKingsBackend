#!/usr/bin/env node
// Fast Lambda zip packager using archiver
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const OUTPUT = 'lambda-deploy.zip';

// Install archiver temporarily if not present
try {
  require.resolve('archiver');
} catch {
  console.log('Installing archiver...');
  execSync('npm install archiver --no-save --prefix /tmp/archiver-tmp', { stdio: 'pipe' });
}

async function pack() {
  if (fs.existsSync(OUTPUT)) fs.unlinkSync(OUTPUT);
  
  const output = fs.createWriteStream(OUTPUT);
  const archive = archiver('zip', { zlib: { level: 1 } }); // level 1 = fast, not max compression

  output.on('close', () => {
    const mb = (archive.pointer() / 1024 / 1024).toFixed(1);
    console.log(`✅ lambda-deploy.zip created: ${mb} MB`);
  });

  archive.on('error', err => { throw err; });
  archive.pipe(output);

  archive.directory('dist/', 'dist');
  archive.directory('node_modules/', 'node_modules');
  archive.file('package.json', { name: 'package.json' });

  await archive.finalize();
}

pack().catch(err => { console.error(err); process.exit(1); });
