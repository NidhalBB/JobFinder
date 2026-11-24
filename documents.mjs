import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
let active = 0;

export async function extractDocument(bytes, type) {
  if (type !== 'application/pdf') {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0/g, '').slice(0, 60000) }; }
    catch { throw Object.assign(new Error('Save this document as UTF-8 text or upload a PDF.'), { status: 400 }); }
  }
  if (active >= 2) throw Object.assign(new Error('Document processing is busy. Please try again shortly.'), { status: 503 });
  active++;
  try { return await new Promise(resolve => {
    const worker = new Worker(join(process.cwd(), 'pdf-worker.mjs'), {
      workerData: new Uint8Array(bytes), resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let finished = false;
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); void worker.terminate(); resolve(result); };
    const timer = setTimeout(() => finish({ text: '', warning: 'PDF extraction exceeded its safe processing limit. Paste your CV text instead.' }), 5000);
    worker.once('message', result => finish(result.error ? { text: '', warning: result.error } : { text: result.text, ...(!result.text.trim() ? { warning: 'No selectable text found. Scanned PDFs need OCR; paste your CV text instead.' } : {}) }));
    worker.once('error', () => finish({ text: '', warning: 'PDF processing failed. Paste your CV text instead.' }));
    worker.once('exit', () => finish({ text: '', warning: 'PDF processing stopped. Paste your CV text instead.' }));
  }); } finally { active--; }
}
