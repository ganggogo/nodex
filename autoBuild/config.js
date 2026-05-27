import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

function getDefaultConfigPath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.join(__dirname, 'cfg.yaml');
}

export function resolveConfigPath(configPath) {
  if (configPath) {
    return path.resolve(configPath);
  }

  if (process.env.AUTO_BUILD_CFG) {
    return path.resolve(process.env.AUTO_BUILD_CFG);
  }

  if (process.pkg) {
    return path.join(path.dirname(process.execPath), 'autoBuild', 'cfg.yaml');
  }

  return getDefaultConfigPath();
}

export function loadBuildConfig(configPath) {
  const resolvedPath = resolveConfigPath(configPath);
  const fileContent = fs.readFileSync(resolvedPath, 'utf8');
  if (!fileContent.trim()) {
    return createEmptyBuildConfig();
  }

  const config = yaml.load(fileContent);

  if (!config || typeof config !== 'object') {
    throw new Error(`配置文件格式不正确: ${resolvedPath}`);
  }

  return config;
}

export function saveBuildConfig(config, configPath) {
  const resolvedPath = resolveConfigPath(configPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const yamlText = yaml.dump(config, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  fs.writeFileSync(resolvedPath, yamlText, 'utf8');
  return resolvedPath;
}

export function getConfigPath(configPath) {
  return resolveConfigPath(configPath);
}

export function createEmptyBuildConfig() {
  return {
    emailSender: {
      name: '',
      email: '',
      psd: '',
      dpt: '',
      cpny: '',
      cpnyweb: '',
      tel: '',
    },
    git: {
      name: '',
      email: '',
    },
    prjs: [],
  };
}
