const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const assets = [
  [
    path.join(root, 'node_modules', '@zxing', 'browser', 'umd', 'zxing-browser.min.js'),
    path.join(publicDir, 'vendor', 'zxing', 'zxing-browser.min.js')
  ],
  [
    path.join(root, 'node_modules', 'tesseract.js', 'dist', 'tesseract.min.js'),
    path.join(publicDir, 'vendor', 'tesseract', 'tesseract.min.js')
  ],
  [
    path.join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
    path.join(publicDir, 'vendor', 'tesseract', 'worker.min.js')
  ],
  [
    path.join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'),
    path.join(publicDir, 'vendor', 'tessdata', 'eng.traineddata.gz')
  ]
];

const coreSource = path.join(root, 'node_modules', 'tesseract.js-core');
const coreDestination = path.join(publicDir, 'vendor', 'tesseract-core');
const coreFiles = fs.readdirSync(coreSource)
  .filter(name => name.startsWith('tesseract-core') && name.endsWith('.wasm.js'))
  .map(name => [path.join(coreSource, name), path.join(coreDestination, name)]);

for (const [source, destination] of [...assets, ...coreFiles]) {
  if (!fs.statSync(source).isFile()) {
    throw new Error(`Required Vercel asset is not a file: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

console.log(`Prepared ${assets.length + coreFiles.length} static OCR and barcode assets.`);
