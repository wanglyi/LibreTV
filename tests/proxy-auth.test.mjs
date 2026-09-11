import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/proxy-auth.js', import.meta.url), 'utf8');
const values = new Map([
    ['proxyAuthHash', 'stale-browser-hash']
]);

const localStorage = {
    getItem(key) {
        return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
        values.set(key, value);
    },
    removeItem(key) {
        values.delete(key);
    }
};

const currentServerHash = 'a'.repeat(64);
const context = vm.createContext({
    console,
    localStorage,
    window: {
        __ENV__: { PASSWORD: currentServerHash },
        addEventListener() {}
    }
});

vm.runInContext(source, context);

const resolvedHash = await context.window.ProxyAuth.getPasswordHash();
assert.equal(resolvedHash, currentServerHash);
assert.equal(localStorage.getItem('proxyAuthHash'), currentServerHash);

const signedUrl = await context.window.ProxyAuth.addAuthToProxyUrl('/proxy/example');
assert.match(signedUrl, /^\/proxy\/example\?auth=a{64}&t=\d+$/);

console.log('proxy auth cache tests: ok');
