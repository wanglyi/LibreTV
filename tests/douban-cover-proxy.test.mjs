import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/douban.js', import.meta.url), 'utf8');

function createContext(addAuthToProxyUrl) {
    const context = vm.createContext({
        AbortController,
        clearTimeout,
        console: {
            ...console,
            error() {}
        },
        document: { addEventListener() {} },
        fetch,
        localStorage: {
            getItem() { return null; },
            setItem() {}
        },
        setTimeout,
        window: {
            ProxyAuth: { addAuthToProxyUrl }
        }
    });

    vm.runInContext(`const PROXY_URL = '/proxy/';\n${source}`, context);
    return context;
}

function createImage() {
    return {
        classList: {
            values: [],
            add(value) { this.values.push(value); }
        },
        listeners: {},
        addEventListener(type, callback) {
            this.listeners[type] = callback;
        },
        get src() { return this.currentSrc; },
        set src(value) { this.currentSrc = value; }
    };
}

const originalCoverUrl = 'https://img3.doubanio.com/example.jpg';

{
    const expectedProxyUrl = '/proxy/' + encodeURIComponent(originalCoverUrl) + '?auth=test&t=1';
    const context = createContext(async (url) => `${url}?auth=test&t=1`);
    const image = createImage();

    await context.loadDoubanCoverThroughProxy(image, originalCoverUrl);

    assert.equal(image.src, expectedProxyUrl);
    assert.deepEqual(image.classList.values, ['object-contain']);
    assert.equal(typeof image.listeners.error, 'function');

    image.listeners.error();
    assert.equal(image.src, 'image/logo-black.png');
}

{
    const context = createContext(async () => {
        throw new Error('auth unavailable');
    });
    const image = createImage();

    await context.loadDoubanCoverThroughProxy(image, originalCoverUrl);

    assert.equal(image.src, 'image/logo-black.png');
}

console.log('douban cover proxy tests: ok');
