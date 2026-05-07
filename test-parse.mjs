import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');

const path = process.argv[2];
const buf = readFileSync(path);
const data = new Uint8Array(buf);

const doc = await getDocument({ data, disableWorker: true }).promise;
console.log(`Pages: ${doc.numPages}`);

let total = '';
let pagesWithText = 0;
let pagesWithoutText = 0;

for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent();
  const txt = tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
  if (txt.length > 20) pagesWithText++; else pagesWithoutText++;
  total += txt + '\n\n';
}

console.log(`Pages with extractable text: ${pagesWithText}`);
console.log(`Pages needing OCR: ${pagesWithoutText}`);
console.log(`Total chars: ${total.length}`);
console.log(`Estimated read time @ 1x: ~${Math.round(total.length / 900)} min`);
console.log('---');
console.log('First 500 chars:');
console.log(total.slice(0, 500));
console.log('---');
console.log('Sample from middle:');
const mid = Math.floor(total.length / 2);
console.log(total.slice(mid, mid + 500));
