import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { onRequest } from '../functions/proxy/[[path]].js';

// Deliberately includes invalid UTF-8: a text round trip corrupts these JPEG bytes.
const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x80, 0xfe, 0xff, 0xd9]);
const password = 'local-image-regression-test';
const hash = createHash('sha256').update(password).digest('hex');
const realFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = async (url, options) => {
    upstreamCalls++;
    assert.equal(options.headers.get('Referer'), 'https://img3.doubanio.com');
    return new Response(jpegBytes, { headers: {
        'Content-Type': 'image/jpeg', 'Content-Length': '10', 'Content-Encoding': 'gzip'
    } });
};

try {
    const kv = new Map();
    const target = 'https://img3.doubanio.com/test.jpg';
    // A previously cached text response must not be served as an image.
    kv.set(`proxy_raw:${target}`, JSON.stringify({ body: 'corrupt legacy image', headers: JSON.stringify({'content-type': 'image/jpeg'}) }));
    const pending = [];
    const context = {
        request: new Request(`https://tv.chrest.xyz/proxy/${encodeURIComponent(target)}?auth=${hash}&t=${Date.now()}`, { headers: { Referer: 'https://tv.chrest.xyz/' } }),
        env: { PASSWORD: password, LIBRETV_PROXY_KV: {
            get: async (key) => kv.get(key) || null,
            put: async (key, value) => { kv.set(key, value); }
        } },
        waitUntil: (promise) => pending.push(promise)
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await onRequest(context);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/jpeg');
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpegBytes);
        assert.equal(response.headers.get('content-encoding'), null);
        assert.equal(response.headers.get('content-length'), null);
        await Promise.all(pending);
    }
    assert.equal(upstreamCalls, 2, 'binary data must not enter the text-only KV cache');
    console.log('Cloudflare image byte preservation: ok');
} finally {
    globalThis.fetch = realFetch;
}
