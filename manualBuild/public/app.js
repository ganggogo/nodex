let state = null;
let historyState = {};

const configPathEl = document.getElementById('configPath');
const projectSelect = document.getElementById('projectSelect');
const buildDate = document.getElementById('buildDate');
const dateRow = document.getElementById('dateRow');
const projectSummary = document.getElementById('projectSummary');
const projectEditor = document.getElementById('projectEditor');
const historyList = document.getElementById('historyList');
const toast = document.getElementById('toast');
const buildBtn = document.getElementById('buildBtn');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function currentBuildType() {
  return document.querySelector('input[name="buildType"]:checked')?.value || 'patch';
}

function updateDateMode() {
  const isPatch = currentBuildType() === 'patch';
  dateRow.hidden = !isPatch;
  buildDate.disabled = !isPatch;
  buildDate.required = isPatch;
}

function showToast(message, isError = false) {
  toast.hidden = false;
  toast.textContent = message;
  toast.style.background = isError ? '#b42318' : '#111827';
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 5000);
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || `请求失败: ${response.status}`);
  }

  return data;
}

function getCurrentConfig() {
  const config = structuredClone(state.config);
  document.querySelectorAll('[data-email-field]').forEach((input) => {
    config.emailSender[input.dataset.emailField] = input.value.trim();
  });
  document.querySelectorAll('[data-git-field]').forEach((input) => {
    config.git[input.dataset.gitField] = input.value.trim();
  });

  config.prjs = [...document.querySelectorAll('.project-row')].map((row) => {
    const project = {};
    row.querySelectorAll('[data-prj-field]').forEach((input) => {
      const key = input.dataset.prjField;
      if (key === 'emailTarget') {
        project[key] = input.value
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter(Boolean);
      } else {
        project[key] = input.value.trim();
      }
    });
    project.workspaces = [...row.querySelectorAll('.workspace-row')].map((workspaceRow) => {
      const workspace = {};
      workspaceRow.querySelectorAll('[data-workspace-field]').forEach((input) => {
        workspace[input.dataset.workspaceField] = input.value.trim();
      });
      return workspace;
    }).filter((workspace) => workspace.path || workspace.gitUrl);
    return project;
  });

  return config;
}

function renderProjectSelect(selectedProjectName = projectSelect.value) {
  projectSelect.innerHTML = '';
  state.config.prjs.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.name;
    option.textContent = project.name || '(未命名项目)';
    projectSelect.appendChild(option);
  });
  if (selectedProjectName && [...projectSelect.options].some((option) => option.value === selectedProjectName)) {
    projectSelect.value = selectedProjectName;
  }
  renderProjectSummary();
  renderHistory();
}

function renderProjectSummary() {
  const project = state.config.prjs.find((item) => item.name === projectSelect.value);
  if (!project) {
    projectSummary.textContent = '暂无项目配置。';
    return;
  }

  projectSummary.innerHTML = [
    `<strong>英文名:</strong> ${project.namee || '-'}`,
    `<strong>项目路径:</strong> ${project.path || '-'}`,
    `<strong>Git 分支:</strong> ${project.branch || 'main'}`,
    `<strong>工作目录:</strong> ${(project.workspaces || []).length}`,
    `<strong>SQL 路径:</strong> ${project.sqlpath || '-'}`,
    `<strong>收件人:</strong> ${(project.emailTarget || []).join(', ') || '-'}`,
  ].join('<br>');
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderHistory() {
  const projectName = projectSelect.value;
  const records = historyState[projectName] || [];

  if (!projectName) {
    historyList.innerHTML = '<div class="empty">请选择项目查看打包记录。</div>';
    return;
  }

  if (records.length === 0) {
    historyList.innerHTML = '<div class="empty">当前项目暂无打包记录。</div>';
    return;
  }

  historyList.innerHTML = records.slice(0, 10).map((record) => {
    const statusText = record.status === 'success' ? '成功' : '失败';
    const typeText = record.buildType === 'full' ? '全量包' : '补丁包';
    const dateText = record.buildType === 'patch' ? ` / ${record.date || '-'}` : '';
    const message = record.message ? `<div class="history-error">${record.message}</div>` : '';
    return `
      <article class="history-item ${record.status === 'success' ? 'ok' : 'fail'}">
        <div class="history-main">
          <span class="history-status">${statusText}</span>
          <span>${typeText}${dateText}</span>
        </div>
        <div class="history-time">${formatTime(record.finishedAt || record.startedAt)}</div>
        ${message}
      </article>
    `;
  }).join('');
}

async function loadHistory() {
  const data = await requestJson('/api/history');
  historyState = data.history || {};
  renderHistory();
}

function field(label, key, value, tag = 'input') {
  const wrapper = document.createElement('label');
  wrapper.textContent = label;
  const input = document.createElement(tag);
  input.dataset.prjField = key;
  input.value = Array.isArray(value) ? value.join('\n') : (value || '');
  wrapper.appendChild(input);
  return wrapper;
}

function fieldWithHint(label, key, value, hint, tag = 'input') {
  const wrapper = field(label, key, value, tag);
  const hintEl = document.createElement('span');
  hintEl.className = 'field-hint';
  hintEl.textContent = hint;
  wrapper.appendChild(hintEl);
  return wrapper;
}

function workspaceField(label, key, value) {
  const wrapper = document.createElement('label');
  wrapper.textContent = label;
  const input = document.createElement('input');
  input.dataset.workspaceField = key;
  input.value = value || '';
  wrapper.appendChild(input);
  return wrapper;
}

function createWorkspaceRow(workspace = {}) {
  const row = document.createElement('div');
  row.className = 'workspace-row';
  row.append(
    workspaceField('工作路径', 'path', workspace.path),
    workspaceField('Git 地址', 'gitUrl', workspace.gitUrl),
    workspaceField('分支名', 'branch', workspace.branch || 'main'),
  );

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'danger';
  removeBtn.textContent = '删除工作目录';
  removeBtn.addEventListener('click', () => row.remove());
  row.appendChild(removeBtn);
  return row;
}

function renderProjectEditor() {
  projectEditor.innerHTML = '';

  state.config.prjs.forEach((project, index) => {
    const row = document.createElement('details');
    row.className = 'project-row';

    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.textContent = project.name || `项目 ${index + 1}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = '删除';
    removeBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const name = project.name || `项目 ${index + 1}`;
      if (!window.confirm(`确认删除“${name}”吗？保存配置后会写入 cfg.yaml。`)) {
        return;
      }

      row.remove();
      state.config = getCurrentConfig();
      renderProjectSelect();
    });
    summary.append(title, removeBtn);

    const fields = document.createElement('div');
    fields.className = 'project-fields';
    fields.append(
      field('项目名称', 'name', project.name),
      field('项目标识', 'namee', project.namee),
      field('项目路径', 'path', project.path),
      field('Git 分支名', 'branch', project.branch || 'main'),
      field('SQL 本地路径', 'sqlpath', project.sqlpath),
      fieldWithHint('SQL 文件名', 'sqlFileName', project.sqlFileName, '若不配置，则默认抓取文件路径下第一个文件名包含 update 的 sql 文件。'),
      field('SQL SVN 地址', 'sqlSvnUrl', project.sqlSvnUrl),
      field('收件人，每行一个或逗号分隔', 'emailTarget', project.emailTarget, 'textarea'),
    );
    fields.children[6].classList.add('full');
    fields.children[7].classList.add('full');

    const workspaceBox = document.createElement('section');
    workspaceBox.className = 'workspace-box full';
    const workspaceTitle = document.createElement('div');
    workspaceTitle.className = 'workspace-title';
    const workspaceHeading = document.createElement('h3');
    workspaceHeading.textContent = '附加工作目录';
    const addWorkspaceBtn = document.createElement('button');
    addWorkspaceBtn.type = 'button';
    addWorkspaceBtn.textContent = '新增工作目录';
    const workspaceList = document.createElement('div');
    workspaceList.className = 'workspace-list';
    (Array.isArray(project.workspaces) ? project.workspaces : []).forEach((workspace) => {
      workspaceList.appendChild(createWorkspaceRow(workspace));
    });
    addWorkspaceBtn.addEventListener('click', () => {
      workspaceList.appendChild(createWorkspaceRow({ branch: 'main' }));
    });
    workspaceTitle.append(workspaceHeading, addWorkspaceBtn);
    workspaceBox.append(workspaceTitle, workspaceList);
    fields.appendChild(workspaceBox);

    row.append(summary, fields);
    projectEditor.appendChild(row);
  });
}

function fillTopLevelForms() {
  document.querySelectorAll('[data-email-field]').forEach((input) => {
    input.value = state.config.emailSender[input.dataset.emailField] || '';
  });
  document.querySelectorAll('[data-git-field]').forEach((input) => {
    input.value = state.config.git[input.dataset.gitField] || '';
  });
}

async function loadConfig() {
  const data = await requestJson('/api/config');
  state = data;
  configPathEl.textContent = `配置文件: ${data.configPath}`;
  buildDate.value ||= today();
  fillTopLevelForms();
  renderProjectSelect();
  renderProjectEditor();
  updateDateMode();
  await loadHistory();
}

async function saveConfig(selectedProjectName = projectSelect.value) {
  state.config = getCurrentConfig();
  const data = await requestJson('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ config: state.config }),
  });
  state = data;
  configPathEl.textContent = `配置文件: ${data.configPath}`;
  renderProjectSelect(selectedProjectName);
  renderProjectEditor();
  showToast('配置已保存。');
}

document.getElementById('reloadBtn').addEventListener('click', async () => {
  try {
    await loadConfig();
    showToast('配置已重新读取。');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  try {
    await saveConfig();
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById('addProjectBtn').addEventListener('click', () => {
  state.config = getCurrentConfig();
  state.config.prjs.push({
    name: '',
    namee: '',
    path: '',
    branch: 'main',
    workspaces: [],
    sqlpath: '',
    sqlFileName: '',
    sqlSvnUrl: '',
    emailTarget: [],
  });
  renderProjectSelect();
  renderProjectEditor();
});

document.getElementById('refreshHistoryBtn').addEventListener('click', async () => {
  try {
    await loadHistory();
    showToast('打包记录已刷新。');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelectorAll('input[name="buildType"]').forEach((input) => {
  input.addEventListener('change', updateDateMode);
});

projectSelect.addEventListener('change', () => {
  renderProjectSummary();
  renderHistory();
});

document.getElementById('buildForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const selectedProjectName = projectSelect.value;
  buildBtn.disabled = true;
  buildBtn.textContent = '打包中...';

  try {
    await saveConfig(selectedProjectName);
    const buildType = currentBuildType();
    const body = {
      projectName: selectedProjectName,
      buildType,
    };
    if (buildType === 'patch') {
      body.date = buildDate.value;
    }

    const data = await requestJson('/api/build', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await loadHistory();
    showToast(data.message || '打包完成。');
  } catch (error) {
    await loadHistory().catch(() => {});
    showToast(error.message, true);
  } finally {
    buildBtn.disabled = false;
    buildBtn.textContent = '开始打包';
  }
});

loadConfig().catch((error) => showToast(error.message, true));
