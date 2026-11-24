import { build } from 'esbuild';
import { hostedConfig } from '../hosted/supabase.mjs';

hostedConfig();
await build({
  entryPoints: ['netlify/functions/api.mjs', 'netlify/functions/refresh-jobs.mjs', 'netlify/functions/email-digests.mjs', 'pdf-worker.mjs'],
  external: ['unpdf', 'nodemailer', 'countries-and-timezones'],
  bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false,
  outdir: '.netlify-validation', logLevel: 'warning',
});
console.log('Netlify configuration and function bundles validated. No credentials were written to public assets.');
