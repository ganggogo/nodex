import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import {processSvnSql} from '../sqlbuild/index.js'
import {runBuildWorkflow} from '../vuebuild/index.js';
import {sendFileEmail} from '../sendEmail/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 1. 读取配置文件内容
const configPath = path.join(__dirname, 'cfg.yaml');
const fileContent = fs.readFileSync(configPath, 'utf8');

// 2. 解析 YAML 字符串为 JS 对象
const config = yaml.load(fileContent);
// 3. 打印配置信息
// console.log(config);

/**
 * 自动构建项目
 * @param {object} config - 配置对象
 * @param {object} prj    - 项目配置对象
 * @param {string} date   - 过滤时间 (格式: YYYY-MM-DD)
 */
export default async function autoBuild(config, prj, date) {
  // 获取emailSender
  let {name, email, cpny, cpnyweb, dpt, tel} = config.emailSender;
  let emailTarget = prj.emailTarget
  // 获取第一个项目配置
  // let prj = config.prjs[0];
  let projectPath = prj.path
  // 把projectPath中的反斜杠转为正斜杠
  projectPath = projectPath.replace(/\\/g, '/');
  let prjName = prj.name

  // 1.拉取脚本
  let svnUrl = prj.sqlSvnUrl
  let localPath = prj.sqlpath
  let targetDirPath = projectPath + '/dist/'
  let gitName = config.git.name
  processSvnSql(svnUrl, localPath, targetDirPath, `${prjName}.sql`)

  // 2.执行打包
  let buildRes = await runBuildWorkflow({gitName, projectPath, date, email, prjName})
  let { zipPath, zipName, logPath: destLogPath } = buildRes;

  // 3.发送邮件
  let emailparam = {name, email, emailTarget, cpny, cpnyweb, dpt, tel}
  emailparam.filePath = zipPath
  emailparam.zipName = zipName
  await sendFileEmail(emailparam)
}

