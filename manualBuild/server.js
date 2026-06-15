import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import autoBuild from '../autoBuild/index.js';
import { getConfigPath, loadBuildConfig, saveBuildConfig } from '../autoBuild/config.js';
import { appendBuildHistory, getHistoryPath, loadBuildHistory } from '../autoBuild/history.js';

const port = Number(process.env.MANUAL_BUILD_PORT || process.env.PORT || 3918);
const sourceDir = process.pkg ? null : path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = process.pkg ? path.dirname(process.execPath) : path.join(sourceDir, '..');
const publicDir = process.pkg
  ? path.join(runtimeRoot, 'manualBuild', 'public')
  : path.join(sourceDir, 'public');
let activeTask = null;

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(publicDir));

function normalizeConfigForClient(config) {
  return {
    emailSender: config.emailSender || {},
    git: config.git || {},
    prjs: Array.isArray(config.prjs) ? config.prjs : [],
  };
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00`);
  const [year, month, day] = date.split('-').map(Number);
  return parsed.getFullYear() === year
    && parsed.getMonth() + 1 === month
    && parsed.getDate() === day;
}

function findProject(config, projectName) {
  return (config.prjs || []).find((project) => project.name === projectName);
}

function writeHistory(record) {
  try {
    appendBuildHistory(record);
  } catch (error) {
    console.warn('[manualBuild] 写入打包记录失败:', error.message);
  }
}

app.get('/api/config', (_req, res) => {
  try {
    const config = loadBuildConfig();
    res.json({
      configPath: getConfigPath(),
      config: normalizeConfigForClient(config),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const nextConfig = req.body?.config;

    if (!nextConfig || !Array.isArray(nextConfig.prjs)) {
      return res.status(400).json({ message: '配置内容不完整，缺少 prjs 列表。' });
    }

    const savedPath = saveBuildConfig(nextConfig);
    res.json({ configPath: savedPath, config: normalizeConfigForClient(nextConfig) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/history', (_req, res) => {
  try {
    res.json({
      historyPath: getHistoryPath(),
      history: loadBuildHistory(),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/build', async (req, res) => {
  if (activeTask) {
    return res.status(409).json({ message: '已有打包任务正在执行，请等待完成。' });
  }

  const { projectName, date, buildType = 'patch' } = req.body || {};
  if (!projectName) {
    return res.status(400).json({ message: '请选择要打包的项目。' });
  }

  if (!['patch', 'full'].includes(buildType)) {
    return res.status(400).json({ message: '打包类型不正确。' });
  }

  if (buildType === 'patch' && (!date || !isValidDate(date))) {
    return res.status(400).json({ message: '请选择正确的日期，格式为 YYYY-MM-DD。' });
  }

  try {
    const config = loadBuildConfig();
    const project = findProject(config, projectName);

    if (!project) {
      return res.status(404).json({ message: `配置里找不到项目: ${projectName}` });
    }

    activeTask = { projectName, date, buildType, startedAt: new Date().toISOString() };
    console.log(`[manualBuild] 开始打包: ${projectName} / ${buildType} / ${date || '-'}`);

    const result = await autoBuild(config, project, date, { buildType });
    const emailMessage = result.emailResult?.sent
      ? '邮件已发送。'
      : (result.emailResult?.reason || '邮件未发送。');

    writeHistory({
      projectName,
      projectKey: project.namee || '',
      buildType,
      date: date || '',
      status: 'success',
      startedAt: activeTask.startedAt,
      finishedAt: new Date().toISOString(),
      zipPath: result.zipPath,
      message: emailMessage,
    });

    console.log(`[manualBuild] 打包完成: ${projectName} / ${buildType} / ${date || '-'}`);
    res.json({ message: `打包完成。${emailMessage}` });
  } catch (error) {
    console.error('[manualBuild] 打包失败:', error);
    writeHistory({
      projectName,
      buildType,
      date: date || '',
      status: 'failed',
      startedAt: activeTask?.startedAt || new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: error.message,
    });
    res.status(500).json({ message: '打包失败，请在打包记录中查看详情。' });
  } finally {
    activeTask = null;
  }
});

app.get('/api/status', (_req, res) => {
  res.json({ running: Boolean(activeTask), task: activeTask });
});

app.use((_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;

  const command = process.platform === 'win32'
    ? 'cmd'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

app.listen(port, () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`打包界面已启动: ${url}`);
  openBrowser(url);
});
