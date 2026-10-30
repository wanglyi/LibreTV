(function () {
    const state = { enabled: false, authenticated: false, ids: [] };
    const ready = (async () => {
        try {
            const response = await fetch('/api/native/config', { cache: 'no-store' });
            if (!response.ok) return;
            const config = await response.json();
            if (!config.enabled || !Array.isArray(config.sources)) return;
            state.enabled = true;
            for (const source of config.sources) {
                if (!/^native_(hongguo|hanxiaoquan|guipian)$/.test(source.id)) continue;
                window.API_SITES[source.id] = {name:source.name,api:`/api/native/vod/${source.source}`,native:true};
                state.ids.push(source.id);
            }
            const session = await fetch('/api/native/session', { cache:'no-store' }).then(r=>r.json());
            state.authenticated = session.authenticated === true;
        } catch { /* Existing sources remain usable when the optional service is unavailable. */ }
    })();
    function isNativeUrl(value) {try{const url=new URL(value,location.origin);return url.origin===location.origin&&url.pathname.startsWith('/api/native/')}catch{return false}}
    window.NativeSources = {
        state, ready, isNativeUrl,
        async authenticate(password) {
            await ready;if(!state.enabled)return true;
            const response=await fetch('/api/native/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
            state.authenticated=response.ok;return response.ok;
        },
        requireLogin() {state.authenticated=false;if(window.showPasswordModal)window.showPasswordModal();else if(typeof showPasswordModal==='function')showPasswordModal()},
        async requestUrl(url) {
            if(isNativeUrl(url)) {await ready;if(!state.authenticated){this.requireLogin();throw new Error('请重新验证访问密码以使用新增片源')}return new URL(url,location.origin).toString()}
            const proxy=PROXY_URL+encodeURIComponent(url);
            return window.ProxyAuth?.addAuthToProxyUrl ? window.ProxyAuth.addAuthToProxyUrl(proxy) : proxy;
        },
        async refreshPlayback(source,id,index) {
            await ready;
            if(!window.API_SITES[source]?.native || !id) return null;
            const response=await fetch(await this.requestUrl(`${window.API_SITES[source].api}?ac=videolist&ids=${encodeURIComponent(id)}`));
            if(response.status===401)this.requireLogin();
            const data=await response.json();if(!response.ok || !data.list?.[0])throw new Error(data.msg||'无法刷新播放地址');
            const episodes=(data.list[0].vod_play_url||'').split('$$$')[0].split('#').map(v=>v.slice(v.indexOf('$')+1)).filter(v=>this.isNativeUrl(v));
            if(!episodes[index])throw new Error('该分集暂不可用');
            return {episodes,url:episodes[index]};
        },
    };
})();
