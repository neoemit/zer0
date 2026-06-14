import { readFileSync } from 'node:fs';

const assetDefinitions = {
  'common.css': { type: 'text/css; charset=utf-8', file: './common.css' },
  'public.css': { type: 'text/css; charset=utf-8', file: './public.css' },
  'admin.css': { type: 'text/css; charset=utf-8', file: './admin.css' },
  'theme.js': { type: 'text/javascript; charset=utf-8', file: './theme.js' },
  'public.js': { type: 'text/javascript; charset=utf-8', file: './public.js' },
  'admin.js': { type: 'text/javascript; charset=utf-8', file: './admin.js' },
};

const assets = new Map(Object.entries(assetDefinitions).map(([name, definition]) => [
  name,
  {
    type: definition.type,
    content: readFileSync(new URL(definition.file, import.meta.url), 'utf8'),
  },
]));

export function getUiAsset(name) {
  return assets.get(name) || null;
}
