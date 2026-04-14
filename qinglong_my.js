/*
new Env('HidenCloud 自动续期-毕业版');
checks: 自动续期、自动支付、Cookie自动持久化、消息推送
*/
//cron: 0 10 */7 * *

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// 尝试加载 notify，如果没有也不影响运行
let sendNotify = () => {};
try {
    const notify = require('./sendNotify');
    sendNotify = notify.sendNotify;
} catch (e) {
    console.log('未找到 sendNotify，跳过推送');
}

// 环境变量
const HIDEN_COOKIES_ENV = process.env.HIDEN_COOKIE ? process.env.HIDEN_COOKIE.split(/[&\n]/) : [];
const RENEW_DAYS = 7;
const CACHE_FILE = path.join(__dirname, 'hiden_cookies.json');

// 汇总消息
let summaryMsg = '';

const sleep = (min = 3000, max = 8000) => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
};

// 本地缓存管理
const CacheManager = {
    load() {
        if (fs.existsSync(CACHE_FILE)) {
            try {
                return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            } catch (e) {
                console.log('读取缓存文件失败，将重新创建');
            }
        }
        return {};
    },
    save(data) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    },
    get(index) {
        const data = this.load();
        return data[index] || null;
    },
    update(index, cookieStr) {
        const data = this.load();
        data[index] = cookieStr;
        this.save(data);
        console.log(`💾 [账号 ${index + 1}] 最新 Cookie 已保存到本地缓存`);
    }
};

class HidenCloudBot {
    constructor(envCookie, index) {
        this.index = index + 1;
        this.envCookie = envCookie;
        this.cookieData = {};
        this.logMsg = []; // 存储该账号的日志用于推送
        
        // 优先尝试读取缓存
        const cachedCookie = CacheManager.get(this.index - 1);
        if (cachedCookie) {
            console.log(`[账号 ${this.index}] 发现本地缓存 Cookie，优先使用...`);
            this.parseCookieStr(cachedCookie);
        } else {
            console.log(`[账号 ${this.index}] 使用环境变量 Cookie...`);
            this.parseCookieStr(envCookie);
        }

        this.commonHeaders = {
            'Host': 'dash.hidencloud.com',
            'Connection': 'keep-alive',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Referer': 'https://dash.hidencloud.com/',
        };

        this.client = axios.create({
            baseURL: 'https://dash.hidencloud.com',
            maxRedirects: 0, 
            validateStatus: status => status >= 200 && status < 500,
            timeout: 30000 
        });
        
        this.services = [];
        this.csrfToken = ''; 
    }

    log(msg) {
        console.log(`[账号 ${this.index}] ${msg}`);
        this.logMsg.push(msg);
    }

    parseCookieStr(str) {
        if (!str) return;
        str.split(';').forEach(pair => {
            const idx = pair.indexOf('=');
            if (idx > 0) {
                const key = pair.substring(0, idx).trim();
                const val = pair.substring(idx + 1).trim();
                if (!['path', 'domain', 'expires', 'httponly', 'secure', 'samesite'].includes(key.toLowerCase())) {
                    this.cookieData[key] = val;
                }
            }
        });
    }

    updateCookiesFromResponse(headers) {
        const setCookie = headers['set-cookie'];
        if (setCookie) {
            setCookie.forEach(sc => {
                const firstPart = sc.split(';')[0];
                const idx = firstPart.indexOf('=');
                if (idx > 0) {
                    const key = firstPart.substring(0, idx).trim();
                    const val = firstPart.substring(idx + 1).trim();
                    this.cookieData[key] = val;
                }
            });
            // 每次更新 Cookie 都保存到本地
            CacheManager.update(this.index - 1, this.getCookieStr());
        }
    }

    getCookieStr() {
        return Object.keys(this.cookieData).map(k => `${k}=${this.cookieData[k]}`).join('; ');
    }

    async request(method, url, data = null, extraHeaders = {}) {
        let currentUrl = url;
        let methodToUse = method;
        let finalResponse = null;

        const requestHeaders = {
            ...this.commonHeaders,
            ...extraHeaders,
            'Cookie': this.getCookieStr()
        };

        if (methodToUse === 'POST' && !requestHeaders['Content-Type']) {
            requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        try {
            const res = await this.client({
                method: methodToUse,
                url: currentUrl,
                headers: requestHeaders,
                data: data
            });
            
            this.updateCookiesFromResponse(res.headers);
            res.finalUrl = currentUrl; 
            finalResponse = res;

            if (res.status === 301 || res.status === 302) {
                const location = res.headers['location'];
                if (location) {
                    this.log(`🔄 重定向 -> ${location}`);
                    currentUrl = location.startsWith('http') ? location : `https://dash.hidencloud.com${location.startsWith('/') ? '' : '/'}${location}`;
                    return this.request('GET', currentUrl);
                }
            }
            finalResponse.finalUrl = currentUrl;
            return finalResponse;
        } catch (err) {
            throw err;
        }
    }

    extractTokens($) {
        const metaToken = $('meta[name="csrf-token"]').attr('content');
        if (metaToken) this.csrfToken = metaToken;
    }

    async init() {
        this.log('正在验证登录状态...');
        try {
            const res = await this.request('GET', '/dashboard');
            
            // 检查失效
            if (res.headers.location && res.headers.location.includes('/login')) {
                 this.log('❌ 当前 Cookie 已失效');
                 return false;
            }

            const $ = cheerio.load(res.data);
            this.extractTokens($);

            // 解析服务列表
            $('a[href*="/service/"]').each((i, el) => {
                const href = $(el).attr('href');
                const match = href.match(/\/service\/(\d+)\/manage/);
                if (match) {
                    this.services.push({ id: match[1], url: href });
                }
            });
            this.services = this.services.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);

            this.log(`✅ 登录成功，发现 ${this.services.length} 个服务。`);
            return true;
        } catch (e) {
            this.log(`❌ 初始化异常: ${e.message}`);
            return false;
        }
    }

    // 重置为环境变量 Cookie (用于缓存失效时重试)
    resetToEnv() {
        this.cookieData = {};
        this.parseCookieStr(this.envCookie);
        console.log(`[账号 ${this.index}] 切换回环境变量原始 Cookie 重试...`);
    }

    async processService(service) {
        await sleep(2000, 4000);
        this.log(`>>> 处理服务 ID: ${service.id}`);

        try {
            const manageRes = await this.request('GET', `/service/${service.id}/manage`);
            const $ = cheerio.load(manageRes.data);
            const formToken = $('input[name="_token"]').val();

            this.log(`提交续期 (${RENEW_DAYS}天)...`);
            await sleep(1000, 2000); 

            const params = new URLSearchParams();
            params.append('_token', formToken);
            params.append('days', RENEW_DAYS);

            const res = await this.request('POST', `/service/${service.id}/renew`, params, {
                'X-CSRF-TOKEN': this.csrfToken,
                'Referer': `https://dash.hidencloud.com/service/${service.id}/manage`
            });
            
            if (res.finalUrl && res.finalUrl.includes('/invoice/')) {
                this.log(`⚡️ 续期成功，前往支付`);
                await this.performPayFromHtml(res.data, res.finalUrl);
            } else {
                this.log('⚠️ 续期后未跳转，检查列表...');
                await this.checkAndPayInvoices(service.id);
            }

        } catch (e) {
            this.log(`处理异常: ${e.message}`);
        }
    }

    async checkAndPayInvoices(serviceId) {
        await sleep(2000, 3000);
        try {
            const res = await this.request('GET', `/service/${serviceId}/invoices?where=unpaid`);
            const $ = cheerio.load(res.data);
            
            const invoiceLinks = [];
            $('a[href*="/invoice/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href && !href.includes('download')) invoiceLinks.push(href);
            });

            const uniqueInvoices = [...new Set(invoiceLinks)];
            if (uniqueInvoices.length === 0) {
                this.log(`✅ 无未支付账单`);
                return;
            }

            for (const url of uniqueInvoices) {
                await this.paySingleInvoice(url);
                await sleep(3000, 5000); 
            }
        } catch (e) {
            this.log(`查账单出错: ${e.message}`);
        }
    }

    async paySingleInvoice(url) {
        try {
            this.log(`📄 打开账单: ${url}`);
            const res = await this.request('GET', url);
            await this.performPayFromHtml(res.data, url);
        } catch (e) {
            this.log(`访问失败: ${e.message}`);
        }
    }

    async performPayFromHtml(html, currentUrl) {
        const $ = cheerio.load(html);
        
        let targetForm = null;
        let targetAction = '';
        
        $('form').each((i, form) => {
            const btnText = $(form).find('button').text().trim().toLowerCase();
            const action = $(form).attr('action');
            if (btnText.includes('pay') && action && !action.includes('balance/add')) {
                targetForm = $(form);
                targetAction = action;
                return false; 
            }
        });

        if (!targetForm) {
            this.log(`⚪ 页面未找到支付表单 (可能已支付)。`);
            return;
        }

        const payParams = new URLSearchParams();
        targetForm.find('input').each((i, el) => {
            const name = $(el).attr('name');
            const value = $(el).val();
            if (name) payParams.append(name, value || '');
        });

        this.log(`👉 提交支付...`);
        
        try {
            const payRes = await this.request('POST', targetAction, payParams, {
                'X-CSRF-TOKEN': this.csrfToken,
                'Referer': currentUrl
            });

            if (payRes.status === 200) {
                 this.log(`✅ 支付成功！`);
            } else {
                this.log(`⚠️ 支付响应: ${payRes.status}`);
            }
        } catch (e) {
            this.log(`❌ 支付失败: ${e.message}`);
        }
    }
}

(async () => {
    if (HIDEN_COOKIES_ENV.length === 0) {
        console.log('❌ 未配置环境变量 HIDEN_COOKIE');
        return;
    }
    
    console.log(`=== HidenCloud 续期脚本启动 (账号数: ${HIDEN_COOKIES_ENV.length}) ===\n`);

    for (let i = 0; i < HIDEN_COOKIES_ENV.length; i++) {
        const bot = new HidenCloudBot(HIDEN_COOKIES_ENV[i], i);
        
        // 第一次尝试（可能用的是缓存）
        let success = await bot.init();
        
        // 如果失败，且当前用的是缓存，则回退到环境变量重试
        if (!success && CacheManager.get(i)) {
            bot.resetToEnv();
            success = await bot.init();
        }

        if (success) {
            for (const svc of bot.services) {
                await bot.processService(svc);
            }
            summaryMsg += `账号 ${i + 1}: 成功续期 ${bot.services.length} 个服务\n`;
        } else {
            summaryMsg += `账号 ${i + 1}: 登录失败，请更新 Cookie\n`;
        }
        
        console.log('\n----------------------------------------\n');
        if (i < HIDEN_COOKIES_ENV.length - 1) await sleep(5000, 10000);
    }

    // 发送推送
    if (summaryMsg) {
        await sendNotify('HidenCloud 续期报告', summaryMsg);
    }
})();
