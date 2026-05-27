import Imap from 'imap';
import { simpleParser } from 'mailparser';
import autoBuild from '../autoBuild/index.js'
import { loadBuildConfig } from '../autoBuild/config.js';

// 1. 读取配置文件内容

// 2. 解析 YAML 字符串为 JS 对象
const buildconfig = loadBuildConfig();
// 3. 打印配置信息
// console.log(buildconfig);

const prjs = buildconfig.prjs;

const POLL_INTERVAL = 5000; // 每 5 秒轮询一次
const {email, psd} = buildconfig.emailSender
const config = {
    user: email,
    password: psd,
    host: 'imap.exmail.qq.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 10000,
};

const processedUids = new Set();
let reconnectTimer = null;
let pollTimer = null;
let imap = null;

// ─── 入口 ─────────────────────────────────────────────────────────────────────
function start() {
    clearTimeout(reconnectTimer);
    clearTimeout(pollTimer);
    reconnectTimer = null;
    pollTimer = null;

    imap = new Imap(config);
    imap.once('ready', onReady);
    imap.on('error', onError);
    imap.once('end', onEnd);
    imap.connect();
    console.log('🔌 正在连接邮箱...');
}

// ─── 连接就绪 ─────────────────────────────────────────────────────────────────
function onReady() {
    console.log('✅ 连接成功');

    imap.openBox('INBOX', false, (err) => {
        if (err) return handleError(err);

        // 记录当前所有 UID，避免启动时重复处理历史邮件
        imap.search(['ALL'], (err, uids) => {
            if (err) return handleError(err);

            uids.forEach(uid => processedUids.add(uid));
            console.log(`📦 已记录 ${processedUids.size} 封历史邮件`);
            console.log(`🔄 开始轮询，每 ${POLL_INTERVAL / 1000} 秒检查一次新邮件...`);

            schedulePoll();
        });
    });
}

// ─── 轮询调度 ─────────────────────────────────────────────────────────────────
function schedulePoll() {
    pollTimer = setTimeout(async () => {
        await poll();
        schedulePoll();
    }, POLL_INTERVAL);
}

// ─── 单次轮询 ─────────────────────────────────────────────────────────────────
async function poll() {
    return new Promise((resolve) => {
        imap.search(['ALL'], (err, uids) => {
            if (err) {
                console.error('⚠️ 搜索失败:', err.message);
                return resolve();
            }

            const newUids = uids.filter(uid => !processedUids.has(uid));
            if (newUids.length === 0) return resolve();

            console.log(`📬 发现 ${newUids.length} 封新邮件，正在拉取...`);
            fetchEmails(newUids, resolve);
        });
    });
}

// ─── 拉取并解析邮件 ───────────────────────────────────────────────────────────
function fetchEmails(uids, done) {
    const f = imap.fetch(uids, { bodies: '', struct: true });
    const tasks = [];

    f.on('message', (msg) => {
        let uid = null;
        const chunks = [];

        msg.on('body', stream => stream.on('data', chunk => chunks.push(chunk)));
        msg.on('attributes', attrs => { uid = attrs.uid; });

        msg.once('end', () => {
            const task = (async () => {
                if (!uid || processedUids.has(uid)) return;
                processedUids.add(uid);

                if (processedUids.size > 1000) {
                    [...processedUids].slice(0, 200).forEach(u => processedUids.delete(u));
                }

                try {
                    const mail = await simpleParser(Buffer.concat(chunks));
                    let maincontent = (mail.text ?? '').substring(0, 200).trim()
                    console.log('─'.repeat(50));
                    console.log('📩 发现新邮件');
                    console.log('👤 发件人:', mail.from?.text ?? '未知');
                    console.log('📝 主题:  ', mail.subject ?? '(无主题)');
                    console.log('📄 正文:  ', maincontent);
                    console.log('🕐 时间:  ', mail.date ? mail.date.toLocaleString('zh-CN') : '未知');
                    console.log('─'.repeat(50));
                    // 判断是否要去打包
                    const matchRes = parseCustomFormat(maincontent);
                    if (matchRes && matchRes.success) {
                        let { prjName, date } = matchRes;
                        let prj = prjs.find(p => p.name.includes(prjName));
                        if (prj) {
                            console.log(`🔨 准备打包项目《${prjName}》--${date}...`);
                            await autoBuild(buildconfig, prj, date)
                            console.log('─'.repeat(50));
                            console.log(`✅ 打包完成~`);
                        }
                    }

                } catch (e) {
                    console.error('⚠️ 解析失败:', e.message);
                }
            })();
            tasks.push(task);
        });
    });

    f.once('error', err => {
        console.error('⚠️ 拉取失败:', err.message);
        done();
    });

    f.once('end', async () => {
        await Promise.all(tasks);
        done();
    });
}

/**
 * 验证并提取特定格式的字符串
 * 格式要求：zbcx打包|内容|YYYY-MM-DD
 * @param {string} str - 待检测的字符串
 * @returns {object|null} - 如果匹配成功返回包含值的对象，否则返回 null
 */
function parseCustomFormat(str)
{
    // 正则解释：
    // ^zbcx打包      : 必须以 "zbcx打包" 开头
    // \|            : 匹配第一个竖线 "|"
    // ([^|]+)       : 捕获组1 - 匹配除了竖线以外的任意字符（内容），至少一个
    // \|            : 匹配第二个竖线 "|"
    // (\d{4}-\d{2}-\d{2}) : 捕获组2 - 匹配日期格式 YYYY-MM-DD
    // $             : 字符串结尾
    const regex = /^zbcx打包\|([^|]+)\|(\d{4}-\d{2}-\d{2})$/;

    const match = str.match(regex);

    if (!match) {
        return null; // 格式不匹配
    }

    const content = match[1];
    const dateStr = match[2];

    // 额外校验日期是否合法 (例如防止 2026-13-40 这种通过正则但非法的日期)
    const dateObj = new Date(dateStr);
    const isValidDate = dateObj instanceof Date && !isNaN(dateObj);
    
    // 进一步确保日期格式严格对应 (防止 new Date("2026-04-32") 自动进位到下个月)
    const [y, m, d] = dateStr.split('-').map(Number);
    const isStrictDate = (dateObj.getFullYear() === y && 
                          (dateObj.getMonth() + 1) === m && 
                          dateObj.getDate() === d);

    if (isValidDate && isStrictDate) {
        return {
            success: true,
            prjName: content,
            date: dateStr
        };
    }

    return {success: false};
}

// ─── 错误 & 断线 ──────────────────────────────────────────────────────────────
function handleError(err) {
    console.error('❌ 错误:', err.message);
    scheduleReconnect();
}

function onError(err) {
    console.error('❌ 连接错误:', err.message);
    scheduleReconnect();
}

function onEnd() {
    console.log('🔌 连接断开');
    scheduleReconnect();
}

function scheduleReconnect() {
    clearTimeout(pollTimer);
    if (reconnectTimer) return;
    console.log('🔄 10 秒后重连...');
    reconnectTimer = setTimeout(start, 10_000);
}

// ─── 启动 ─────────────────────────────────────────────────────────────────────
start();
