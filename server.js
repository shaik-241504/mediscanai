const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_PORT = parseInt(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEDICINE_DATASET_PATH = path.join(PUBLIC_DIR, 'data', 'indian_medicine_data.csv');
const TESSERACT_PACKAGE_DIR = path.join(__dirname, 'node_modules', 'tesseract.js', 'dist');
const TESSERACT_CORE_DIR = path.join(__dirname, 'node_modules', 'tesseract.js-core');
const TESSERACT_LANGUAGE_PATH = path.join(__dirname, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz');
const DATASET_HEADERS = ['id', 'name', 'price', 'is_discontinued', 'manufacturer_name', 'type', 'pack_size', 'composition'];

class MedicineLookupError extends Error {}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.csv': 'text/csv; charset=UTF-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function getVendorFile(pathname) {
  if (pathname === '/vendor/zxing/zxing-browser.min.js') {
    return path.join(__dirname, 'node_modules', '@zxing', 'browser', 'umd', 'zxing-browser.min.js');
  }
  if (pathname === '/vendor/tesseract/tesseract.min.js') {
    return path.join(TESSERACT_PACKAGE_DIR, 'tesseract.min.js');
  }
  if (pathname === '/vendor/tesseract/worker.min.js') {
    return path.join(TESSERACT_PACKAGE_DIR, 'worker.min.js');
  }
  if (pathname === '/vendor/tessdata/eng.traineddata.gz') {
    return TESSERACT_LANGUAGE_PATH;
  }
  const coreMatch = pathname.match(/^\/vendor\/tesseract-core\/(tesseract-core-[a-z0-9-]+(?:\.wasm)?\.(?:js|wasm))$/);
  if (coreMatch) {
    return path.join(TESSERACT_CORE_DIR, coreMatch[1]);
  }
  return null;
}

function parseCsvRow(line) {
  const fields = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (character === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(value);
      value = '';
    } else {
      value += character;
    }
  }

  if (quoted) {
    throw new Error('The medicine dataset contains an invalid quoted field.');
  }
  fields.push(value);
  return fields;
}

function medicineTokens(text) {
  return [...new Set(
    text.toLowerCase().match(/[a-z0-9]+/g)?.filter(token =>
      token.length >= 3 && !['tablet', 'tablets', 'capsule', 'capsules', 'strip', 'oral', 'ip', 'mg', 'ml'].includes(token)
    ) || []
  )].slice(0, 40);
}

function scoreMedicineRecord(queryTokens, labelTokens, normalizedLabel, fields) {
  const nameTokens = new Set(medicineTokens(fields[1]));
  const compositionTokens = new Set(medicineTokens(fields[7]));
  const legalManufacturerWords = new Set(['pharma', 'pharmaceutical', 'pharmaceuticals', 'pvt', 'private', 'ltd', 'limited', 'company', 'industries', 'industry', 'laboratories', 'laboratory', 'labs', 'lab', 'healthcare', 'health', 'india', 'co', 'the', 'of', 'and', 'for', 'by', 'in']);
  const manufacturerTokens = new Set(medicineTokens(fields[4]).filter(token => !legalManufacturerWords.has(token)));
  const nameHits = queryTokens.filter(token => nameTokens.has(token)).length;
  const compositionHits = queryTokens.filter(token => compositionTokens.has(token)).length;
  const manufacturerHits = queryTokens.filter(token => manufacturerTokens.has(token)).length;
  const strengthTokens = [...new Set(
    (normalizedLabel.match(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)\b/g) || [])
      .map(strength => strength.replace(/\s+/g, ''))
  )];
  const recordStrengths = [...new Set(
    `${fields[1]} ${fields[7]}`.toLowerCase().match(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)\b/g)?.map(strength => strength.replace(/\s+/g, '')) || []
  )];
  const strengthHits = strengthTokens.filter(strength => recordStrengths.includes(strength)).length;
  const nameSequence = medicineTokensInOrder(fields[1]);
  let orderedNameHits = 0;
  for (let start = 0; start <= labelTokens.length - nameSequence.length; start++) {
    let length = 0;
    while (length < nameSequence.length && labelTokens[start + length] === nameSequence[length]) length++;
    orderedNameHits = Math.max(orderedNameHits, length);
  }
  const normalizedName = fields[1].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const exactNameMatch = normalizedLabel.includes(normalizedName);
  const nameTokenMatches = [...nameTokens].filter(nameToken =>
    labelTokens.some(labelToken => labelToken.length >= 5 &&
      (labelToken.startsWith(nameToken) || nameToken.startsWith(labelToken)))
  ).length;
  const capsuleMatch = /\bcapsules?\b/.test(normalizedLabel) && /\bcapsule\b/.test(fields[1].toLowerCase());
  const tabletMatch = /\btablets?\b/.test(normalizedLabel) && /\btablet\b/.test(fields[1].toLowerCase());
  const dosageFormMatch = capsuleMatch || tabletMatch;

  return {
    nameHits,
    compositionHits,
    manufacturerHits,
    strengthHits,
    dosageFormMatch,
    score: nameHits * 5 + compositionHits * 2 + orderedNameHits * 4 +
      manufacturerHits * 30 + strengthHits * 7 + nameTokenMatches * 4 +
      (dosageFormMatch ? 8 : 0) +
      (exactNameMatch ? 12 : 0),
    exactNameMatch
  };
}

function medicineTokensInOrder(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function toMedicineRecord(fields) {
  const name = fields[1];
  const composition = fields[7];
  const strength = name.match(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%))?/i)?.[0] || '';

  return {
    id: fields[0],
    name,
    price: fields[2],
    isDiscontinued: fields[3].toLowerCase() === 'true',
    manufacturer: fields[4],
    category: fields[5],
    packSize: fields[6],
    composition,
    strength
  };
}

async function findMedicineInDataset(ocrText) {
  const queryTokens = medicineTokens(ocrText);
  const labelTokens = medicineTokensInOrder(ocrText);
  const normalizedLabel = ocrText.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (queryTokens.length === 0) {
    throw new MedicineLookupError('No readable medicine name or ingredient was found. Upload a clear photo of the printed medicine label.');
  }

  const stream = fs.createReadStream(MEDICINE_DATASET_PATH);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let bestMatches = [];
  let isHeader = true;

  for await (const line of lines) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (!line) continue;

    const fields = parseCsvRow(line);
    if (fields.length !== DATASET_HEADERS.length) {
      throw new Error('A row in the medicine dataset has an unexpected number of columns.');
    }

    const match = scoreMedicineRecord(queryTokens, labelTokens, normalizedLabel, fields);
    if ((match.nameHits > 0 && match.nameHits + match.compositionHits >= 2) ||
        (match.nameHits === 0 && match.compositionHits >= 3)) {
      bestMatches.push({ ...match, fields });
      bestMatches.sort((a, b) => b.score - a.score || b.nameHits - a.nameHits);
      if (bestMatches.length > 2) bestMatches.pop();
    }
  }

  if (bestMatches.length === 0) {
    throw new MedicineLookupError('The label text could not be matched to the medicine dataset. Try a sharper photo showing the full brand name and strength.');
  }

  const [best, second] = bestMatches;
  const hasDistinctivePackageMatch = best.manufacturerHits > 0 &&
    best.strengthHits >= 2 && best.dosageFormMatch;
  if (second && best.score - second.score < 3 && !best.exactNameMatch && !hasDistinctivePackageMatch) {
    throw new MedicineLookupError('The label matches more than one medicine in the dataset. Try a clearer photo showing the full brand name and strength.');
  }

  if (best.nameHits === 0 && best.compositionHits < 3 && !hasDistinctivePackageMatch) {
    throw new MedicineLookupError('The label match is uncertain. Try a sharper photo showing the medicine name, or search for the name manually.');
  }

  const confidence = best.exactNameMatch || hasDistinctivePackageMatch ? 0.92 : best.nameHits >= 2 ? 0.82 : 0.7;
  return { medicine: toMedicineRecord(best.fields), confidence };
}

function medicineIngredients(composition) {
  return [...new Set(
    composition.split(',')
      .map(ingredient => ingredient.replace(/\([^)]*\)/g, '').replace(/[^a-zA-Z -]/g, ' ').trim())
      .filter(ingredient => ingredient.length >= 4)
  )].slice(0, 3);
}

function firstLabelText(value) {
  if (!Array.isArray(value)) return '';
  return value[0]?.replace(/\s+/g, ' ').trim().slice(0, 1200) || '';
}

async function findOpenFdaDrugInfo(composition) {
  const ingredients = medicineIngredients(composition);
  const records = await Promise.all(ingredients.map(async ingredient => {
    const query = `openfda.generic_name:"${ingredient}"`;
    const endpoint = new URL('https://api.fda.gov/drug/label.json');
    endpoint.searchParams.set('search', query);
    endpoint.searchParams.set('limit', '1');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`openFDA returned HTTP ${response.status}.`);
    }

    const payload = await response.json();
    const label = payload.results?.[0];
    if (!label) return null;
    return {
      ingredient,
      brandNames: label.openfda?.brand_name?.slice(0, 3) || [],
      sections: {
        indications: firstLabelText(label.indications_and_usage || label.purpose),
        dosage: firstLabelText(label.dosage_and_administration),
        warnings: firstLabelText(label.warnings || label.warnings_and_cautions),
        adverseReactions: firstLabelText(label.adverse_reactions)
      }
    };
  }));
  return records.filter(Boolean);
}

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'MedScan AI Server', timestamp: new Date().toISOString() }));
      return;
    }

    if (pathname === '/api/medicine-search' && req.method === 'POST') {
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        if (tooLarge) return;
        body += chunk.toString();
        if (Buffer.byteLength(body, 'utf8') > 10000) {
          tooLarge = true;
          body = '';
        }
      });
      req.on('end', async () => {
        if (tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'The recognized label text is too long to search.' }));
          return;
        }
        try {
          const payload = JSON.parse(body);
          if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Recognized medicine text is required.' }));
            return;
          }
          const result = await findMedicineInDataset(payload.text);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          const status = error instanceof SyntaxError ? 400 : error instanceof MedicineLookupError ? 422 : 500;
          if (status === 500) console.error('Medicine dataset search failed:', error);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: status === 500 ? 'The medicine dataset could not be searched. Check the server log for details.' : error.message }));
        }
      });
      return;
    }

    if (pathname === '/api/drug-info' && req.method === 'POST') {
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        if (tooLarge) return;
        body += chunk.toString();
        if (Buffer.byteLength(body, 'utf8') > 2000) {
          tooLarge = true;
          body = '';
        }
      });
      req.on('end', async () => {
        if (tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Medicine information request is too large.' }));
          return;
        }
        try {
          const payload = JSON.parse(body);
          if (!payload || typeof payload.composition !== 'string' || !payload.composition.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Medicine composition is required.' }));
            return;
          }
          const records = await findOpenFdaDrugInfo(payload.composition);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            source: 'openFDA US drug labeling',
            disclaimer: 'Label information may describe an ingredient or different product, not this exact brand. Verify all information with a pharmacist or doctor.',
            records
          }));
        } catch (error) {
          const status = error instanceof SyntaxError ? 400 : 502;
          if (status === 502) console.error('openFDA medicine lookup failed:', error);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: status === 502 ? 'The external drug-label service is temporarily unavailable.' : error.message }));
        }
      });
      return;
    }

    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    const isMedicineDataset = pathname === '/data/indian_medicine_data.csv';
    const vendorFilePath = getVendorFile(pathname);
    const publicFilePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
    const relativePublicPath = path.relative(PUBLIC_DIR, publicFilePath);
    const isInsidePublicDirectory = relativePublicPath !== '..' &&
      !relativePublicPath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePublicPath);
    const filePath = isMedicineDataset
      ? MEDICINE_DATASET_PATH
      : vendorFilePath || publicFilePath;

    if (!isMedicineDataset && !vendorFilePath && !isInsidePublicDirectory) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(`<h1>404 Not Found</h1><p>The file ${pathname} was not found on this server.</p>`);
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Cache-Control': 'no-cache'
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    });
  });
}

function startServer(port) {
  const server = createServer();

  server.on('error', (err) => {
    console.error(`Unable to start MedScan AI on port ${port}:`, err);
    process.exitCode = 1;
  });

  server.listen(port, () => {
    console.log(`===================================================`);
    console.log(` 🩺 MedScan AI Web Application running!`);
    console.log(` Local URL: http://localhost:${port}`);
    console.log(` Public Dir: ${PUBLIC_DIR}`);
    console.log(`===================================================`);
  });
}

if (require.main === module) {
  startServer(DEFAULT_PORT);
}

module.exports = { createServer };
