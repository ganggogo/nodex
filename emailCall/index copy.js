import Imap from 'imap';
import { simpleParser } from 'mailparser';

const POLL_INTERVAL = 5000; // 每 5 秒轮询一次

const config = {
    user: '798710853@qq.com',
    password: 'kdyuezpmbpgsbbfg',
    host: 'imap.qq.com',
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
                    console.log('─'.repeat(50));
                    console.log('📩 新邮件');
                    console.log('👤 发件人:', mail.from?.text ?? '未知');
                    console.log('📝 主题:  ', mail.subject ?? '(无主题)');
                    console.log('📄 正文:  ', (mail.text ?? '').substring(0, 200).trim());
                    console.log('─'.repeat(50));
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
