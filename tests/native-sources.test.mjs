import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {onRequest} from '../functions/api/native/[[path]].js';

const env={PASSWORD:'native-test-password',NATIVE_SOURCE_TOKEN:'test-native-service-token-with-at-least-32-characters',NATIVE_SOURCE_ORIGIN:'https://sources.example.test'};
const origin='https://tv.example.test';
const run=(path,options={})=>onRequest({request:new Request(origin+'/api/native/'+path,options),env});
assert.equal((await (await run('config')).json()).sources.length,3);
assert.equal((await run('vod/hongguo?wd=test')).status,401);
assert.equal((await run('vod/hongguo?wd=test',{headers:{Cookie:'libretv_native=forged'}})).status,401);
assert.equal((await run('login',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:JSON.stringify({password:env.PASSWORD})})).status,403);
assert.equal((await run('login',{method:'POST',headers:{Origin:origin},body:JSON.stringify({password:'incorrect'})})).status,401);
const login=await run('login',{method:'POST',headers:{Origin:origin},body:JSON.stringify({password:env.PASSWORD})});
assert.equal(login.status,200);
const cookie=login.headers.get('Set-Cookie').split(';')[0];
assert.match(login.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);
assert.equal((await (await run('session',{headers:{Cookie:cookie}})).json()).authenticated,true);
const originalFetch=globalThis.fetch;
let calls=0;
globalThis.fetch=async(url,options)=>{
    calls++;
    assert.equal(new URL(url).origin,env.NATIVE_SOURCE_ORIGIN);
    assert.equal(options.headers.get('X-Source-Token'),env.NATIVE_SOURCE_TOKEN);
    assert.equal(options.headers.get('Cookie'),null);
    assert.equal(options.redirect,'error');
    return new Response(new Uint8Array([0x47,0x80,0xff,0x00]),{headers:{'Content-Type':'video/mp2t','Content-Length':'1','Content-Encoding':'gzip'}});
};
try{
    const api=await run('vod/hongguo?wd=test&url=http://localhost',{headers:{Cookie:cookie}});
    assert.equal(api.status,200);
    const media=await run('play/abc.'+'x'.repeat(43)+'/seg000001.ts');
    assert.equal(media.headers.get('Content-Length'),null);
    assert.equal(media.headers.get('Content-Encoding'),null);
    assert.deepEqual(new Uint8Array(await media.arrayBuffer()),new Uint8Array([0x47,0x80,0xff,0x00]));
    assert.equal((await run('play/abc.'+'x'.repeat(43)+'/private.env')).status,404);
    assert.equal((await run('vod/unknown',{headers:{Cookie:cookie}})).status,404);
    assert.equal(calls,2);
    const rotated=await onRequest({request:new Request(origin+'/api/native/session',{headers:{Cookie:cookie}}),env:{...env,PASSWORD:'rotated'}});
    assert.equal((await rotated.json()).authenticated,false);
}finally{globalThis.fetch=originalFetch}

let forwarded=[];
const window={location:{origin},fetch:async(input,init)=>{forwarded.push([input,init]);return new Response('{"enabled":true}',{headers:{'Content-Type':'application/json'}})},NativeSources:{requireLogin(){throw new Error('unexpected login prompt')}}};
const context=vm.createContext({window,console,URL,Response});
vm.runInContext(fs.readFileSync(new URL('../js/api.js',import.meta.url),'utf8'),context);
const config=await window.fetch('/api/native/config');
assert.equal((await config.json()).enabled,true);
await window.fetch(new URL(origin+'/api/native/session'));
assert.equal(forwarded.length,2,'native endpoints must reach the server, not the legacy pseudo-API');
console.log('Native source authentication, routing and binary forwarding: ok');
