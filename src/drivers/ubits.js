// ============================================================
// ubits — UBits PT 站点签到 Driver
//
// 签到方式：使用 Playwright 浏览器携带 Cookie 打开 /attendance.php，
// 自动通过 Cloudflare 验证后解析签到结果和 PT 账号统计数据。
// 支持 API-first 模式（直接 HTTP 请求）+ Playwright 回退。
// ============================================================

import BaseDriver from "./base.js";
import { get } from "../utils/http.js";
import logger from "../utils/logger.js";
import { resolveChromiumExecutablePath, launchBrowser } from "../utils/browser.js";
import { getCookieForSite, createHttpSession, htmlToText, readText } from "../utils/http-session.js";

function formatSignTime(date = new Date()) {
    return date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function normalizeCookieHeader(value = "") {
    return String(value || "")
        .trim()
        .split(/[\r\n]+/)
        .map(part => part.trim().replace(/;+$/, ""))
        .filter(Boolean)
        .join("; ");
}

function isAlreadySigned(text = "") {
    return /已经签到|今日已签到|重复签到|请勿重复|already\s*check|already\s*sign/i.test(text);
}

function isSignSuccess(text = "") {
    return /签到成功|签到已得|本次签到|获得\s*\d+|U币\s*\+|attendance\s*success/i.test(text);
}

function isCloudflareChallenge(text = "") {
    return /Checking your browser|Just a moment|Enable JavaScript|Cloudflare|cf-browser-verification|challenge-platform/i.test(text);
}

function extractBonusGain(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ");
    return normalized.match(/本次签到获得\s*([0-9,.]+)\s*(?:个)?(?:U币|魔力值?|bonus|积分)/i)?.[1]
        || normalized.match(/获得\s*([0-9,.]+)\s*(?:个)?(?:U币|魔力值?|bonus|积分)/i)?.[1]
        || normalized.match(/U币\s*[+＋]\s*([0-9,.]+)/i)?.[1]
        || normalized.match(/签到已得\s*([0-9,.]+)/i)?.[1]
        || null;
}

function extractSignText(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ");
    return normalized.match(/这是您的第\s*\d+\s*次签到[^。]*已连续签到\s*\d+\s*天[^。]*本次签到获得\s*[0-9,.]+\s*个U币/)?.[0]
        || normalized.match(/(?:这是您的第[^。]*。\s*)?本次签到获得[^。；;]*/)?.[0]
        || normalized.match(/签到已得[^。；;]*/)?.[0]
        || normalized.match(/签到成功[^。；;]*/)?.[0]
        || normalized.match(/今日已签到[^。；;]*/)?.[0]
        || normalized.match(/已经签到[^。；;]*/)?.[0]
        || "";
}

/**
 * 从 UBits info_block 区域解析 PT 账号统计数据
 */
function parsePtStats(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ");

    // 用户名: "欢迎回来, arthit"
    const username = normalized.match(/欢迎回来\s*[,，]\s*([^\s\[，,\]]+)/)?.[1] || "";

    // U币: "U币 [ 使用 ]: 677,454.0"
    const bonus = normalized.match(/U币\s*(?:\[\s*使用\s*\])?\s*[:：]?\s*([0-9,]+(?:\.[0-9]+)?)/)?.[1]
        || "";

    // 分享率: "分享率: 11.385"
    const ratio = normalized.match(/分享率\s*[:：]\s*([0-9.]+)/)?.[1] || "";

    // 上传量: "上传量: 762.69 GB"
    const upload = normalized.match(/上传量\s*[:：]\s*([0-9.]+\s*[KMGTPE]?i?B)/i)?.[1]?.replace(/\s+/g, " ") || "";

    // 下载量: "下载量: 66.99 GB"
    const download = normalized.match(/下载量\s*[:：]\s*([0-9.]+\s*[KMGTPE]?i?B)/i)?.[1]?.replace(/\s+/g, " ") || "";

    // 邀请: "邀请 [ 发送 ]: 0(0)"
    const inviteMatch = normalized.match(/邀请\s*(?:\[\s*发送\s*\])?\s*[:：]\s*([0-9]+)/);
    const invite = inviteMatch?.[1] || "";

    // 签到信息: "签到已得10, 补签卡: 310"
    const checkinInfo = normalized.match(/签到已得\s*([0-9,]+)/)?.[1] || "";

    // 连续签到天数
    const consecutiveDays = normalized.match(/已连续签到\s*(\d+)\s*天/)?.[1] || "";

    // 总签到次数
    const totalSignCount = normalized.match(/这是您的第\s*(\d+)\s*次签到/)?.[1] || "";

    // 签到排名
    const rankMatch = normalized.match(/今日签到排名\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/);
    const rank = rankMatch ? `${rankMatch[1]}/${rankMatch[2]}` : "";

    return {
        username,
        bonus,
        ratio,
        upload,
        download,
        invite,
        checkinInfo,
        consecutiveDays,
        totalSignCount,
        rank,
    };
}

function buildResultMessage(stats, signTime, { signText, bonusGain, alreadySigned } = {}) {
    const messageParts = [];
    if (alreadySigned) {
        messageParts.push("今日已签到");
        if (bonusGain) messageParts.push(`获得 ${bonusGain} U币`);
    } else if (signText) {
        messageParts.push(signText);
    } else if (bonusGain) {
        messageParts.push(`签到成功，获得 ${bonusGain} U币`);
    } else {
        messageParts.push("签到成功");
    }
    if (stats.bonus) messageParts.push(`U币 ${stats.bonus}`);
    if (stats.ratio) messageParts.push(`分享率 ${stats.ratio}`);
    if (stats.upload && stats.download) messageParts.push(`U: ${stats.upload} / D: ${stats.download}`);
    messageParts.push(`签到时间：${signTime}`);
    return messageParts.join("；");
}

/**
 * 尝试点击 Cloudflare Turnstile 复选框
 * Cloudflare Turnstile 嵌入在 iframe 中，需要定位 iframe 内的复选框并点击
 */
async function tryClickTurnstileCheckbox(page) {
    try {
        // 方法 1：通过 iframe 定位 Turnstile 复选框
        const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
        const checkbox = turnstileFrame.locator('input[type="checkbox"], .cb-lb, #cf-turnstile-checkbox, label.cb-lb, .mark');
        if (await checkbox.count().catch(() => 0) > 0) {
            await checkbox.click({ timeout: 5000, force: true }).catch(() => { });
            logger.info("[UBits] 已尝试点击 Turnstile iframe 内复选框");
            return true;
        }
    } catch { /* iframe 方式失败 */ }

    try {
        // 方法 2：直接点击 iframe 元素的中心位置（复选框通常在 iframe 左侧）
        const iframes = page.locator('iframe[src*="challenges.cloudflare.com"]');
        const count = await iframes.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
            const box = await iframes.nth(i).boundingBox().catch(() => null);
            if (box && box.width > 0 && box.height > 0) {
                // Turnstile 复选框通常在 iframe 的左侧区域
                const clickX = box.x + Math.min(box.width * 0.15, 35);
                const clickY = box.y + box.height / 2;
                await page.mouse.click(clickX, clickY);
                logger.info(`[UBits] 已点击 Turnstile iframe 坐标 (${Math.round(clickX)}, ${Math.round(clickY)})`);
                return true;
            }
        }
    } catch { /* 坐标方式失败 */ }

    try {
        // 方法 3：尝试点击 .cf-turnstile 容器区域
        const container = page.locator(".cf-turnstile").first();
        const box = await container.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
            const clickX = box.x + Math.min(box.width * 0.15, 35);
            const clickY = box.y + box.height / 2;
            await page.mouse.click(clickX, clickY);
            logger.info(`[UBits] 已点击 cf-turnstile 容器坐标 (${Math.round(clickX)}, ${Math.round(clickY)})`);
            return true;
        }
    } catch { /* 容器方式失败 */ }

    return false;
}

/**
 * 等待 Cloudflare JS Challenge / Turnstile 自动完成
 * 如果检测到 Turnstile 复选框，会自动尝试点击
 */
async function waitForCloudflarePass(page, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let clickAttempted = false;

    while (Date.now() < deadline) {
        const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");

        // Cloudflare 挑战完成后页面会跳转或显示站点内容
        if (!isCloudflareChallenge(bodyText) && bodyText.length > 200) {
            return { passed: true };
        }

        // 检查页面是否有 Turnstile
        const turnstileState = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
            const container = document.querySelector(".cf-turnstile");
            const token = document.querySelector('input[name="cf-turnstile-response"]')?.value || "";
            return {
                hasIframe: !!iframe,
                hasContainer: !!container,
                tokenLength: token.length,
                iframeBox: iframe ? iframe.getBoundingClientRect().toJSON() : null,
            };
        }).catch(() => ({ hasIframe: false, hasContainer: false, tokenLength: 0, iframeBox: null }));

        // token 已生成，说明验证已通过
        if (turnstileState.tokenLength > 0) {
            logger.info("[UBits] Turnstile token 已生成，验证通过");
            await page.waitForTimeout(1500);
            return { passed: true };
        }

        // 检测到 Turnstile，尝试点击复选框
        if ((turnstileState.hasIframe || turnstileState.hasContainer) && !clickAttempted) {
            logger.info("[UBits] 检测到 Cloudflare Turnstile 复选框，尝试自动点击...");
            await page.waitForTimeout(1500); // 等待 Turnstile 完全加载
            const clicked = await tryClickTurnstileCheckbox(page);
            if (clicked) {
                clickAttempted = true;
                // 点击后等待一段时间让验证处理
                await page.waitForTimeout(3000);
                continue;
            }
        }

        // 如果第一次点击后仍未通过，等待更长时间后再试
        if (clickAttempted && (turnstileState.hasIframe || turnstileState.hasContainer)) {
            // 可能需要等待 Turnstile 内部处理，每 5 秒重试一次点击
            const elapsed = timeoutMs - (deadline - Date.now());
            if (elapsed > 8000 && elapsed % 5000 < 2000) {
                logger.info("[UBits] 重新尝试点击 Turnstile 复选框...");
                await tryClickTurnstileCheckbox(page);
                await page.waitForTimeout(3000);
            }
        }

        await page.waitForTimeout(2000);
    }
    return { passed: false };
}

export default class UBitsDriver extends BaseDriver {
    getCookie() {
        const secrets = this.secrets?.ubits || this.secrets?.["ubits-club"] || {};
        const cookie = normalizeCookieHeader(secrets.cookie || "");
        if (!cookie || cookie.includes("<YOUR_")) return "";
        if (/[^\x00-\xff]/.test(cookie)) {
            throw new Error("Cookie 含非法字符（例如中文省略号），请重新从浏览器复制原始 Cookie");
        }
        return cookie;
    }

    /**
     * API-first 模式：直接 HTTP 请求签到页
     */
    async tryApiSignIn() {
        const { base_url = "https://ubits.club", timeout, proxy_url } = this.siteConfig;
        const signTime = formatSignTime();
        const cookie = this.getCookie();

        if (!cookie) return { handled: false, reason: "no_cookie" };

        const url = `${base_url.replace(/\/$/, "")}/attendance.php`;
        logger.info(`[UBits/API] 尝试 HTTP 直接签到 → ${url}`);

        let response;
        try {
            response = await get(url, {
                headers: {
                    "Cookie": cookie,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "Referer": base_url.replace(/\/$/, "") + "/",
                },
                timeout,
                proxyUrl: proxy_url,
            });
        } catch (err) {
            logger.warn(`[UBits/API] HTTP 请求失败: ${err.message}`);
            return { handled: false, reason: `http_error: ${err.message}` };
        }

        const text = await response.text().catch(() => "");

        // 被 Cloudflare 拦截 → 需要回退到 Playwright
        if (response.status === 403 || response.status === 503 || isCloudflareChallenge(text)) {
            logger.info(`[UBits/API] HTTP ${response.status} 被 Cloudflare 拦截，回退 Playwright`);
            return { handled: false, reason: "cloudflare_blocked" };
        }

        if (response.status >= 400) {
            return { handled: false, reason: `http_${response.status}` };
        }

        const stats = parsePtStats(text);
        const alreadySigned = isAlreadySigned(text);
        const signSuccess = isSignSuccess(text);
        const bonusGain = extractBonusGain(text);
        const signText = extractSignText(text);

        if (alreadySigned || signSuccess) {
            return {
                handled: true,
                result: {
                    success: true,
                    message: buildResultMessage(stats, signTime, { signText, bonusGain, alreadySigned }),
                    details: { ...stats, signTime, alreadySigned, bonusGain, signText, status: response.status, checkinAction: "api" },
                    steps: [
                        { label: "HTTP 直接签到", ok: true, detail: url },
                        { label: alreadySigned ? "今日已签到" : "签到成功", ok: true, detail: signText || (bonusGain ? `获得 ${bonusGain} U币` : "") },
                    ],
                },
            };
        }

        // 页面拿到了但未识别到签到结果 → 可能是重定向或页面异常，回退 Playwright
        logger.info("[UBits/API] HTTP 未识别到签到结果，回退 Playwright");
        return { handled: false, reason: "unrecognized_result" };
    }

    /**
     * Playwright 模式：通过真实浏览器自动通过 Cloudflare 验证后签到
     */
    async playwrightSignIn() {
        const { chromium } = await import("playwright-core");
        const {
            base_url = "https://ubits.club",
            timeout = 60_000,
            proxy_url,
            chromium_executable_path = await resolveChromiumExecutablePath(chromium),
        } = this.siteConfig;

        const signTime = formatSignTime();
        const cookie = this.getCookie();
        const url = base_url.replace(/\/$/, "");
        const proxy = proxy_url ? { server: proxy_url } : undefined;
        const steps = [];

        if (!cookie) {
            return {
                success: false,
                message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写",
                details: { signTime },
                steps: [{ label: "检查 Cookie", ok: false, detail: "未配置 Cookie" }],
            };
        }

        logger.info(`[UBits] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
        const browser = await launchBrowser({
            chromium,
            siteConfig: this.siteConfig,
            launchOptions: { executablePath: chromium_executable_path, headless: true, proxy, args: ["--no-sandbox"], timeout },
        });

        try {
            const context = await browser.newContext({
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
                locale: "zh-CN",
                timezoneId: "Asia/Shanghai",
                viewport: { width: 1440, height: 1000 },
            });
            steps.push({ label: "启动 Playwright 浏览器", ok: true });

            // 注入 Cookie
            logger.info("[UBits] 步骤 2/5：注入 Cookie");
            const hostname = new URL(url).hostname;
            const domain = hostname.startsWith("www.") ? `.${hostname.slice(4)}` : `.${hostname}`;
            const cookies = String(cookie || "").split(";").map(p => p.trim()).filter(Boolean).map(p => {
                const i = p.indexOf("=");
                if (i < 0) return null;
                return { name: p.slice(0, i), value: p.slice(i + 1), domain, path: "/", secure: true, httpOnly: false, sameSite: "Lax" };
            }).filter(Boolean);
            if (cookies.length) await context.addCookies(cookies);
            steps.push({ label: "注入 Cookie", ok: cookies.length > 0, detail: cookies.length ? `已注入 ${cookies.length} 个 Cookie` : "未配置 Cookie" });

            const page = await context.newPage();

            // 先打开首页让 Cloudflare 验证通过
            logger.info(`[UBits] 步骤 3/5：打开首页通过 Cloudflare → ${url}`);
            const homeResponse = await page.goto(url, { waitUntil: "commit", timeout });
            await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 15_000) }).catch(() => { });
            await page.waitForTimeout(2000);

            let homeText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
            const homeStatus = homeResponse?.status() || 0;

            // 如果遇到 Cloudflare 挑战，等待自动通过
            if (isCloudflareChallenge(homeText)) {
                logger.info("[UBits] 检测到 Cloudflare 挑战，等待浏览器自动通过...");
                const cfResult = await waitForCloudflarePass(page, this.siteConfig.cloudflare_wait_ms || 30_000);
                if (cfResult.passed) {
                    steps.push({ label: "通过 Cloudflare 验证", ok: true, detail: "浏览器已自动通过 Cloudflare JS Challenge" });
                    homeText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
                } else {
                    steps.push({ label: "通过 Cloudflare 验证", ok: false, detail: "Cloudflare 验证超时，未能自动通过" });
                    return {
                        success: false,
                        message: `Cloudflare 验证未通过，无法访问 UBits；签到时间：${signTime}`,
                        details: { signTime, status: homeStatus, verificationBlocked: true, verificationType: "cloudflare" },
                        steps,
                    };
                }
            } else {
                steps.push({ label: "打开首页", ok: homeStatus >= 200 && homeStatus < 400, status: homeStatus, detail: url });
            }

            // 确认登录态
            const loggedIn = /欢迎回来|退出|控制面板/.test(homeText);
            const homeStats = parsePtStats(homeText);
            steps.push({ label: "确认登录态", ok: loggedIn && !!homeStats.username, detail: homeStats.username ? `用户 ${homeStats.username}` : "未识别到登录用户" });

            if (!loggedIn) {
                return {
                    success: false,
                    message: `登录态异常，请确认 Cookie 是否有效；签到时间：${signTime}`,
                    details: { ...homeStats, signTime, status: homeStatus },
                    steps,
                };
            }

            // 导航到签到页
            const attendanceUrl = `${url}/attendance.php`;
            logger.info(`[UBits] 步骤 4/5：打开签到页 → ${attendanceUrl}`);
            const signResponse = await page.goto(attendanceUrl, { waitUntil: "commit", timeout });
            await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 15_000) }).catch(() => { });
            await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => { });
            await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 2000);

            let signText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
            const signStatus = signResponse?.status() || 0;

            // 签到页如果再次遇到 Cloudflare 挑战
            if (isCloudflareChallenge(signText)) {
                logger.info("[UBits] 签到页遇到 Cloudflare 挑战，等待通过...");
                const cfResult2 = await waitForCloudflarePass(page, this.siteConfig.cloudflare_wait_ms || 30_000);
                if (cfResult2.passed) {
                    steps.push({ label: "签到页 Cloudflare 验证", ok: true, detail: "已通过" });
                    signText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
                } else {
                    steps.push({ label: "签到页 Cloudflare 验证", ok: false, detail: "验证超时" });
                    return {
                        success: false,
                        message: `签到页 Cloudflare 验证未通过；签到时间：${signTime}`,
                        details: { ...homeStats, signTime, status: signStatus, verificationBlocked: true, verificationType: "cloudflare" },
                        steps,
                    };
                }
            }

            steps.push({ label: "打开签到页", ok: signStatus >= 200 && signStatus < 400, status: signStatus, detail: attendanceUrl });

            // 解析签到结果
            logger.info("[UBits] 步骤 5/5：解析签到结果");
            const stats = parsePtStats(signText);
            // 合并首页和签到页数据（签到页可能有更完整的统计）
            const mergedStats = {
                ...homeStats,
                ...Object.fromEntries(Object.entries(stats).filter(([, v]) => v !== "")),
            };

            const alreadySigned = isAlreadySigned(signText);
            const signSuccess = isSignSuccess(signText);
            const bonusGain = extractBonusGain(signText);
            const signTextResult = extractSignText(signText);

            if (alreadySigned || signSuccess) {
                steps.push({ label: alreadySigned ? "今日已签到" : "签到成功", ok: true, detail: signTextResult || (bonusGain ? `获得 ${bonusGain} U币` : "签到完成") });
                steps.push({ label: "读取 PT 账号信息", ok: !!mergedStats.username, detail: [`用户 ${mergedStats.username || "-"}`, mergedStats.bonus ? `U币 ${mergedStats.bonus}` : "", mergedStats.ratio ? `分享率 ${mergedStats.ratio}` : "", mergedStats.upload ? `上传 ${mergedStats.upload}` : "", mergedStats.download ? `下载 ${mergedStats.download}` : ""].filter(Boolean).join("；") });
                return {
                    success: true,
                    message: buildResultMessage(mergedStats, signTime, { signText: signTextResult, bonusGain, alreadySigned }),
                    details: { ...mergedStats, signTime, alreadySigned, bonusGain, signText: signTextResult, status: signStatus, checkinAction: "playwright" },
                    steps,
                };
            }

            // 未识别到签到结果
            const preview = signText.replace(/\s+/g, " ").slice(0, 300);
            steps.push({ label: "签到结果", ok: false, detail: `未识别到签到成功/已签到标志` });
            return {
                success: false,
                message: `签到结果未确认，HTTP ${signStatus}；签到时间：${signTime}`,
                details: { ...mergedStats, signTime, status: signStatus },
                steps,
                raw: preview,
            };
        } finally {
            await browser.close().catch(() => { });
        }
    }

    async signIn() {
        const cookie = this.getCookie();
        if (!cookie) {
            return {
                success: false,
                message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写",
                details: { signTime: formatSignTime() },
            };
        }

        // 先尝试 API 模式（快速路径）
        try {
            const api = await this.tryApiSignIn();
            if (api.handled) {
                logger.info("[UBits] API 模式签到成功，跳过 Playwright");
                return api.result;
            }
            logger.info(`[UBits] API 模式未处理 (${api.reason})，回退 Playwright`);
        } catch (err) {
            logger.warn(`[UBits] API 模式异常: ${err.message}，回退 Playwright`);
        }

        // 回退到 Playwright 模式
        return this.playwrightSignIn();
    }

    formatResult(result) {
        const icon = result.success ? "✅" : "❌";
        const lines = [`${icon} UBits 签到`];

        const details = result.details || {};
        const signText = details.signText || "";
        if (signText) {
            lines.push(`📝 ${signText}`);
        } else {
            lines.push(`📝 ${result.message}`);
        }

        // U币 + 增量
        if (details.bonus) {
            const gainPart = details.bonusGain ? `(+${details.bonusGain})` : "";
            lines.push(`🪙U币 ${details.bonus}${gainPart}`);
        }

        // 分享率
        if (details.ratio) {
            lines.push(`⚖️分享率 ${details.ratio}`);
        }

        // 上传/下载
        if (details.upload && details.download) {
            lines.push(`↕️U: ${details.upload} / D: ${details.download}`);
        }

        // 邀请数
        if (details.invite !== undefined && details.invite !== "") {
            lines.push(`🎟️邀请数 x${details.invite}`);
        }

        return lines.join("\n");
    }
}

// ============================================================
// 独立测试入口
// ============================================================
if (process.argv[1] === import.meta.filename) {
    logger.info("UBits Driver — Playwright 模式签到，自动通过 Cloudflare 验证");
}
