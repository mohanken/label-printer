// Stamp a release version into every asset URL, so a phone never runs a mix of old and new
// files after an update (GitHub Pages lets browsers cache each file for up to 10 minutes).
// Run before committing a release: npm run stamp

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const version = new Date().toISOString().replace(/\D/g, '').slice(0, 14); // yyyymmddhhmmss (UTC)

const update = (path, fn) => {
  const url = new URL(path, root);
  const before = readFileSync(url, 'utf8');
  const after = fn(before);
  if (after !== before) writeFileSync(url, after);
};

// index.html: stylesheet and scripts.
update('index.html', (s) =>
  s.replace(/((?:href|src)="(?:css\/app\.css|js\/app\.js|vendor\/[\w.-]+\.js))(?:\?v=\w*)?"/g, `$1?v=${version}"`),
);

// Every relative module import, so the whole module graph moves to the new version together.
for (const file of readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js'))) {
  update(`js/${file}`, (s) => s.replace(/(from '\.\/[\w-]+\.js)(?:\?v=\w*)?'/g, `$1?v=${version}'`));
}

// The version shown in the app.
update('js/app.js', (s) => s.replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${version}';`));

console.log(`Stamped version ${version}`);
