import {processSvnSql} from '../sqlbuild/index.js'
import {runBuildWorkflow} from '../vuebuild/index.js';
import {sendFileEmail} from '../sendEmail/index.js';

// 1. 读取配置文件内容

// 2. 解析 YAML 字符串为 JS 对象
// 3. 打印配置信息
// console.log(config);

/**
 * 自动构建项目
 * @param {object} config - 配置对象
 * @param {object} prj    - 项目配置对象
 * @param {string} date   - 过滤时间 (格式: YYYY-MM-DD)
 * @param {object} options
 * @param {'patch'|'full'} options.buildType - 打包类型
 */
export default async function autoBuild(config, prj, date, options = {}) {
  // 获取emailSender
  let {name, email, psd, cpny, cpnyweb, dpt, tel} = config.emailSender;
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
  let buildRes = await runBuildWorkflow({gitName, projectPath, date, email, prjName, buildType: options.buildType || 'patch'})
  let { zipPath, zipName, logPath: destLogPath } = buildRes;

  // 3.发送邮件
  let emailparam = {name, email, psd, emailTarget, cpny, cpnyweb, dpt, tel}
  emailparam.filePath = zipPath
  emailparam.zipName = zipName
  const emailResult = await sendFileEmail(emailparam)
  return { ...buildRes, emailResult }
}

