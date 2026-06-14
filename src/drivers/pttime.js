// ============================================================
// pttime — PTTime PT 站点签到 Driver
//
// 签到方式：携带 Cookie 向 /attendance.php?type=sign&uid={uid}
// 发起 GET 请求，解析响应 HTML 判断签到是否成功，
// 并提取 PT 账号统计数据。
// ============================================================

import BaseDriver from "./base.js";
import { get } from "../utils/http.js";
import logger from "../utils/logger.js";

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
    return /已经签到|今日已签到|重复签到|请勿重复|already\s*check|already\s*sign|您今天已经签到过了/i.test(text);
}

function isSignSuccess(text = "") {
    return /签到成功|签到已得|本次签到|获得\s*\d+|魔力值\s*\+|attendance\s*success|这是您的第/i.test(text);
}

function extractBonusGain(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ");
    return normalized.match(/本次签到获得\s*([0-9,.]+)\s*(?:个)?(?:魔力值?|bonus|积分)/i)?.[1]
        || normalized.match(/获得\s*([0-9,.]+)\s*(?:个)?(?:魔力值?|bonus|积分)/i)?.[1]
        || normalized.match(/魔力值?\s*[+＋]\s*([0-9,.]+)/i)?.[1]
        || normalized.match(/签到已得\s*([0-9,.]+)/i)?.[1]
        || null;
}

function extractSignText(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ");
    return normalized.match(/这是您的第\s*\d+\s*次签到[^。]*已连续签到\s*\d+\s*天[^。]*本次签到获得\s*[0-9,.]+\s*个魔力值/)?.[0]
        || normalized.match(/(?:这是您的第[^。]*。\s*)?本次签到获得[^。；;]*/)?.[0]
        || normalized.match(/签到已得[^。；;]*/)?.[0]
        || normalized.match(/签到成功[^。；;]*/)?.[0]
        || normalized.match(/今日已签到[^。；;]*/)?.[0]
        || normalized.match(/已经签到[^。；;]*/)?.[0]
        || normalized.match(/您今天已经签到过了[^。；;]*/)?.[0]
        || "";
}

/**
 * 从 PTTime 页面解析 PT 账号统计数据
 */
function parsePtStats(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ");

    // 用户名: "欢迎回来, xxx"
    const username = normalized.match(/欢迎回来\s*[,，]\s*([^\s\[，,\]]+)/)?.[1] || "";

    // 魔力值
    const bonus = normalized.match(/魔力值\s*(?:\[\s*使用\s*\])?\s*[:：]?\s*([0-9,]+(?:\.[0-9]+)?)/)?.[1]
        || normalized.match(/魔力值?\s*[:：]\s*([0-9,]+(?:\.[0-9]+)?)/)?.[1]
        || "";

    // 分享率
    const ratio = normalized.match(/分享率\s*[:：]\s*([0-9.]+)/)?.[1] || "";

    // 上传量
    const upload = normalized.match(/上传量?\s*[:：]\s*([0-9.]+\s*[KMGTPE]?i?B)/i)?.[1]?.replace(/\s+/g, " ") || "";

    // 下载量
    const download = normalized.match(/下载量?\s*[:：]\s*([0-9.]+\s*[KMGTPE]?i?B)/i)?.[1]?.replace(/\s+/g, " ") || "";

    // 邀请
    const invite = normalized.match(/邀请\s*(?:\[\s*发送\s*\])?\s*[:：]\s*([0-9]+)/)?.[1] || "";

    // 签到累计
    const checkinInfo = normalized.match(/签到已得\s*([0-9,]+)/)?.[1] || "";

    // 连续签到天数
    const consecutiveDays = normalized.match(/已连续签到\s*(\d+)\s*天/)?.[1] || "";

    // 总签到次数
    const totalSignCount = normalized.match(/这是您的第\s*(\d+)\s*次签到/)?.[1] || "";

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
    };
}

export default class PTTimeDriver extends BaseDriver {
    getCookie() {
        const secrets = this.secrets?.["pttime-org"] || this.secrets?.pttime || {};
        const cookie = normalizeCookieHeader(secrets.cookie || "");
        if (!cookie || cookie.includes("<YOUR_")) return "";
        if (/[^\x00-\xff]/.test(cookie)) {
            throw new Error("Cookie 含非法字符（例如中文省略号），请重新从浏览器复制原始 Cookie");
        }
        return cookie;
    }

    getUid() {
        const secrets = this.secrets?.["pttime-org"] || this.secrets?.pttime || {};
        return String(secrets.uid || "").trim();
    }

    async signIn() {
        const { base_url = "https://www.pttime.org", timeout, proxy_url } = this.siteConfig;
        const signTime = formatSignTime();

        const cookie = this.getCookie();
        if (!cookie) {
            return {
                success: false,
                message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写",
                details: { signTime },
            };
        }

        const uid = this.getUid();
        if (!uid) {
            return {
                success: false,
                message: "⚠️ UID 未配置，请在 secrets.yaml 的 pttime-org 中添加 uid 字段",
                details: { signTime },
            };
        }

        const url = `${base_url.replace(/\/$/, "")}/attendance.php?type=sign&uid=${uid}`;
        logger.info(`[PTTime] 发起签到请求 → ${url}`);

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
            logger.warn(`[PTTime] 请求失败: ${err.message}`);
            return {
                success: false,
                message: `请求失败：${err.message}`,
                details: { signTime },
            };
        }

        const text = await response.text().catch(() => "");
        const preview = text.replace(/\s+/g, " ").slice(0, 500);
        logger.info(`[PTTime] HTTP ${response.status} | ${preview.slice(0, 300)}`);

        if (response.status === 401 || response.status === 403) {
            return {
                success: false,
                message: `HTTP ${response.status} — 登录态被拒绝，请确认 Cookie 是否完整有效`,
                details: { signTime, status: response.status },
            };
        }

        if (response.status >= 400) {
            return {
                success: false,
                message: `HTTP ${response.status} — 请求失败`,
                details: { signTime, status: response.status },
                raw: preview,
            };
        }

        // 解析 PT 账号统计数据
        const stats = parsePtStats(text);
        const alreadySigned = isAlreadySigned(text);
        const signSuccess = isSignSuccess(text);
        const bonusGain = extractBonusGain(text);
        const signText = extractSignText(text);

        if (alreadySigned) {
            const messageParts = ["今日已签到"];
            if (bonusGain) messageParts.push(`获得 ${bonusGain} 魔力值`);
            if (stats.bonus) messageParts.push(`魔力值 ${stats.bonus}`);
            if (stats.ratio) messageParts.push(`分享率 ${stats.ratio}`);
            if (stats.upload && stats.download) messageParts.push(`U: ${stats.upload} / D: ${stats.download}`);
            messageParts.push(`签到时间：${signTime}`);
            return {
                success: true,
                message: messageParts.join("；"),
                details: { ...stats, signTime, alreadySigned: true, bonusGain, signText, status: response.status },
                raw: preview,
            };
        }

        if (signSuccess) {
            const messageParts = [];
            if (signText) messageParts.push(signText);
            else if (bonusGain) messageParts.push(`签到成功，获得 ${bonusGain} 魔力值`);
            else messageParts.push("签到成功");
            if (stats.bonus) messageParts.push(`魔力值 ${stats.bonus}`);
            if (stats.ratio) messageParts.push(`分享率 ${stats.ratio}`);
            if (stats.upload && stats.download) messageParts.push(`U: ${stats.upload} / D: ${stats.download}`);
            messageParts.push(`签到时间：${signTime}`);
            return {
                success: true,
                message: messageParts.join("；"),
                details: { ...stats, signTime, alreadySigned: false, bonusGain, signText, status: response.status },
                raw: preview,
            };
        }

        // 未识别到明确的成功/已签到标志
        return {
            success: false,
            message: `签到结果未确认，HTTP ${response.status}；签到时间：${signTime}`,
            details: { ...stats, signTime, status: response.status },
            raw: preview,
        };
    }

    formatResult(result) {
        const icon = result.success ? "✅" : "❌";
        const lines = [`${icon} PTTime 签到`];

        const details = result.details || {};
        const signText = details.signText || "";
        if (signText) {
            lines.push(`📝 ${signText}`);
        } else {
            lines.push(`📝 ${result.message}`);
        }

        // 魔力值 + 增量
        if (details.bonus) {
            const gainPart = details.bonusGain ? `(+${details.bonusGain})` : "";
            lines.push(`🪄魔力值 ${details.bonus}${gainPart}`);
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
