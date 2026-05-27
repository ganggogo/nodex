import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function getSourceHistoryPath() {
  const __filename = fileURLToPath(import.meta.url);
  return path.join(path.dirname(__filename), 'build-history.json');
}

export function getHistoryPath() {
  if (process.env.AUTO_BUILD_HISTORY) {
    return path.resolve(process.env.AUTO_BUILD_HISTORY);
  }

  if (process.pkg) {
    return path.join(path.dirname(process.execPath), 'autoBuild', 'build-history.json');
  }

  return getSourceHistoryPath();
}

export function loadBuildHistory() {
  const historyPath = getHistoryPath();
  if (!fs.existsSync(historyPath)) {
    return {};
  }

  const content = fs.readFileSync(historyPath, 'utf8').trim();
  if (!content) {
    return {};
  }

  const history = JSON.parse(content);
  return history && typeof history === 'object' ? history : {};
}

export function appendBuildHistory(record) {
  const historyPath = getHistoryPath();
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });

  const history = loadBuildHistory();
  const projectName = record.projectName || 'unknown';
  const records = Array.isArray(history[projectName]) ? history[projectName] : [];
  records.unshift({
    ...record,
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  history[projectName] = records.slice(0, 50);

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
  return history[projectName][0];
}
