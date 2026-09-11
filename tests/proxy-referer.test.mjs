import assert from 'node:assert/strict';
import fs from 'node:fs';

const proxyFiles = [
    'functions/proxy/[[path]].js',
    'api/proxy/[...path].mjs',
    'netlify/functions/proxy.mjs',
    'server.mjs'
];

for (const file of proxyFiles) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /['"]Referer['"]\s*:\s*new URL\(targetUrl\)\.origin/);
    assert.doesNotMatch(source, /['"]referer['"]\]\s*\|\|\s*new URL\(targetUrl\)\.origin/i);
    assert.doesNotMatch(source, /request\.headers\.get\(['"]Referer['"]\)\s*\|\|/i);
}

console.log('proxy referer tests: ok');
