const SOURCES = [
    { id: 'native_hongguo', source: 'hongguo', name: '红果短剧' },
    { id: 'native_hanxiaoquan', source: 'hanxiaoquan', name: '韩小圈' },
    { id: 'native_guipian', source: 'guipian', name: '鬼片影视' },
];
const encoder = new TextEncoder();
const COOKIE = 'libretv_native';
const MAX_AGE = 24 * 60 * 60;

function json(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}
function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unbase64url(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
async function passwordDigest(password) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(password)))); }
async function signingKey(env) { return crypto.subtle.importKey('raw', encoder.encode(env.NATIVE_SOURCE_TOKEN), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']); }
async function issueSession(env) {
    const payload = `${Math.floor(Date.now()/1000)+MAX_AGE}.${base64url(crypto.getRandomValues(new Uint8Array(16)))}.${await passwordDigest(env.PASSWORD)}`;
    const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC',await signingKey(env),encoder.encode(payload))));
    return `${payload}.${signature}`;
}
async function validSession(request, env) {
    try {
        const cookie = (request.headers.get('Cookie') || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE}=`));
        if (!cookie) return false;
        const value = cookie.slice(COOKIE.length+1);
        if (value.length > 512) return false;
        const parts=value.split('.');
        const expiry=Number(parts[0]);const now=Math.floor(Date.now()/1000);
        if(parts.length!==4 || !Number.isSafeInteger(expiry) || expiry<now || expiry>now+MAX_AGE || parts[2]!==await passwordDigest(env.PASSWORD)) return false;
        return await crypto.subtle.verify('HMAC',await signingKey(env),unbase64url(parts[3]),encoder.encode(parts.slice(0,3).join('.')));
    } catch { return false; }
}

export async function onRequest(context) {
    const {request,env}=context;const url=new URL(request.url);
    const route=url.pathname.replace(/^\/api\/native\/?/,'');
    const configured=Boolean(env.NATIVE_SOURCE_ORIGIN && env.NATIVE_SOURCE_TOKEN?.length>=32 && env.PASSWORD);
    if(route==='config') return json({enabled:configured,sources:configured?SOURCES:[]});
    if(!configured) return json({code:503,msg:'新增片源暂未启用'},503);
    if(route==='session') return json({authenticated:await validSession(request,env)});
    if(route==='login') {
        if(request.method!=='POST')return json({code:405},405);
        if(url.protocol!=='https:' && !['localhost','127.0.0.1'].includes(url.hostname))return json({code:400,msg:'请使用 HTTPS 访问'},400);
        if(request.headers.get('Origin')!==url.origin) return json({code:403},403);
        const reader=request.body?.getReader();let text='';
        if(reader) {const decoder=new TextDecoder();let size=0;while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();return json({code:413},413)}text+=decoder.decode(value,{stream:true})}text+=decoder.decode()}
        let input;try{input=JSON.parse(text)}catch{return json({code:400},400)}
        if(typeof input.password!=='string' || await passwordDigest(input.password)!==await passwordDigest(env.PASSWORD))return json({code:401,msg:'密码不正确'},401);
        const session=await issueSession(env);
        return json({ok:true},200,{'Set-Cookie':`${COOKIE}=${session}; Path=/api/native; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`});
    }
    if(request.method!=='GET' && request.method!=='HEAD')return json({code:405},405);
    const media=/^play\/[A-Za-z0-9_-]{1,700}\.[A-Za-z0-9_-]{43}\/(index\.m3u8|seg\d{6}\.ts)$/.test(route);
    const vod=/^vod\/(hongguo|hanxiaoquan|guipian)$/.test(route);
    if(!media && !vod)return json({code:404},404);
    if(vod && !await validSession(request,env))return json({code:401,msg:'请重新输入网站访问密码后使用新增片源'},401);
    let upstream;
    try {
        upstream=new URL(env.NATIVE_SOURCE_ORIGIN);
        if(upstream.protocol!=='https:' || upstream.username || upstream.password || upstream.search || upstream.hash)throw new Error();
    } catch {return json({code:503,msg:'片源服务配置无效'},503)}
    upstream.pathname=upstream.pathname.replace(/\/$/,'')+'/'+route;
    if(vod) for(const key of ['ac','wd','ids','pg']) { const value=url.searchParams.get(key);if(value!==null)upstream.searchParams.set(key,value); }
    const headers=new Headers({'X-Source-Token':env.NATIVE_SOURCE_TOKEN,'Accept-Encoding':'identity'});
    if(media && request.headers.has('Range')) headers.set('Range',request.headers.get('Range'));
    try {
        const result=await fetch(upstream.toString(),{method:request.method,headers,redirect:'error',signal:request.signal});
        const responseHeaders=new Headers({'X-Content-Type-Options':'nosniff','X-Native-Upstream-Status':String(result.status),'Cache-Control':media&&!route.endsWith('.m3u8')?'private, max-age=60':'no-store'});
        for(const key of ['Content-Type','Content-Range','Accept-Ranges','Retry-After'])if(result.headers.has(key))responseHeaders.set(key,result.headers.get(key));
        return new Response(result.body,{status:result.status,headers:responseHeaders});
    } catch {return json({code:502,msg:'片源服务暂时无法连接，请稍后重试'},502)}
}
