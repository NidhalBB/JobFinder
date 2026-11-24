import { parentPort, workerData } from 'node:worker_threads';
import { extractText, getDocumentProxy } from 'unpdf';

let pdf;
try {
  pdf = await getDocumentProxy(new Uint8Array(workerData), { isEvalSupported: false, maxImageSize: 1, disableFontFace: true, useSystemFonts: false });
  if (pdf.numPages > 20) throw new Error('Maximum 20 pages.');
  const result = await extractText(pdf, { mergePages: true });
  parentPort.postMessage({ text: result.text.slice(0, 60000) });
} catch {
  parentPort.postMessage({ error: 'Could not extract PDF text. Use a text-based PDF with at most 20 pages, or paste your CV text.' });
} finally { await pdf?.destroy(); }
