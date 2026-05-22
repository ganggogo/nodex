#!/usr/bin/env node

import { program } from 'commander';
import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import dayjs from 'dayjs';
import chalk from 'chalk';
import archiver from 'archiver';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

/**
 * Vue 项目自动化构建工作流
 * @param {object} options
 * @param {string} options.gitName    - Git 用户名
 * @param {string} options.projectPath    - Vue 项目的绝对路径
 * @param {string} options.date    - 过滤时间 (格式: YYYY-MM-DD)
 * @param {string} options.email    - Git 用户邮箱
 * @param {string} options.prjName    - 项目名称
 * @returns {Promise<{ zipPath: string, logPath: string }>}
 */
export async function runBuildWorkflow({ gitName, projectPath, date, email, prjName }) {
  projectPath = path.resolve(projectPath);
  const inputDate = dayjs(date).startOf('day');

  const distPath = path.join(projectPath, 'dist');
  const logFileName = `${date}-今日研发更新日志.txt`;
  const logFilePath = path.join(distPath, logFileName);

  console.log(chalk.cyan(`🚀 开始工作流...`));
  console.log(`📂 项目路径: ${projectPath}`);
  console.log(`📅 过滤时间: ${date}`);

  if (!await fs.pathExists(projectPath)) {
    throw new Error(`路径不存在 - ${projectPath}`);
  }

  const git = simpleGit(projectPath);

  // 1. 切换分支
  try {
    await git.checkout('main');
    console.log('✅ 已切换到 main 分支');
  } catch (e) {
    throw new Error(`切换分支失败: ${e.message}`);
  }

  // 2. Git 提交本地代码
  console.log(chalk.yellow('1️⃣ 正在检查状态并提交本地更改...'));
  const status = await git.status();
  if (!status.isClean()) {
    await git.add('.');
    await git.raw(['config', 'user.name', gitName]);
    await git.raw(['config', 'user.email', email]);
    await git.commit('Auto commit: save local changes before workflow');
  }

  // 3. 拉取远程代码
  console.log(chalk.yellow('2️⃣ 正在拉取远程代码...'));
  await git.pull(['--no-edit']);
  console.log(chalk.green('✅ 远程代码已拉取'));

  // 4.推送远端代码
  await git.push(['--set-upstream', 'origin','main']);
  console.log(chalk.green('✅ 本地代码已提交'));

  // 5.收集日志并分析文件
  console.log(chalk.yellow('3️⃣ 正在收集 Git 日志并分析变更文件...'));
  await git.raw(['config', 'core.quotePath', 'false']);

  const allLogs = await git.log();
  const filteredLogs = allLogs.all.filter(log => dayjs(log.date).isAfter(inputDate));

  const keepPaths = new Set();
  let fullLogContent = `Git 变更日志 (自 ${date} 起)\n========================================\n`;

  if (filteredLogs.length === 0) {
    fullLogContent += '无相关更新记录\n';
  }

  for (const log of filteredLogs) {
    try {
      const showResult = await git.show([log.hash, '--name-status', '--format=']);
      const files = [];

      showResult.split('\n').forEach(line => {
        if (!line.trim()) return;
        const [status, filePath] = line.split(/\t/);
        if (filePath) {
          files.push({ status, file: filePath });
          if (['M', 'A', 'R'].includes(status) && filePath.startsWith('public/static/')) {
            keepPaths.add(filePath.replace('public/', ''));
          }
        }
      });

      fullLogContent += `\n提交者: ${log.author_name}\n`;
      fullLogContent += `时间: ${dayjs(log.date).format('YYYY-MM-DD HH:mm:ss')}\n`;
      fullLogContent += `内容: ${log.message}\n`;
      fullLogContent += `影响文件:\n`;
      files.length > 0
        ? files.forEach(f => fullLogContent += `  [${f.status}] ${f.file}\n`)
        : (fullLogContent += `  (无文件变更)\n`);
      fullLogContent += `----------------------------------------\n`;
    } catch (err) {
      console.warn(chalk.yellow(`⚠️ 无法获取提交 ${log.hash} 的文件列表: ${err.message}`));
    }
  }

  await git.raw(['config', 'core.quotePath', 'true']);
  console.log(chalk.green(`✅ 分析完成，共有 ${keepPaths.size} 个 static 文件需要保留。`));

  // 5. 执行 npm run build
  console.log(chalk.yellow('4️⃣ 正在执行 npm run build...'));
  try {
    await execPromise('npm run build', { cwd: projectPath, maxBuffer: 1024 * 1024 * 100 });
    console.log(chalk.green('✅ 打包完成'));
  } catch (err) {
    throw new Error(`打包失败: ${err.message}`);
  }

  // 6. 写入日志到 dist
  console.log(chalk.yellow('5️⃣ 正在写入日志文件到 dist 目录...'));
  await fs.writeFile(logFilePath, fullLogContent, 'utf8');
  console.log(chalk.green(`✅ 日志已写入: ${logFilePath}`));

  // 7. 清理 dist/app/static
  console.log(chalk.yellow('6️⃣ 正在根据白名单清理 static 目录...'));
  const targetDir = path.join(distPath, 'app', 'static');

  if (!await fs.pathExists(targetDir)) {
    console.warn(chalk.yellow('⚠️ static 目录不存在，跳过清理步骤'));
  } else {
    console.log(chalk.gray('   [调试] 白名单内容:'));
    keepPaths.forEach(p => console.log(chalk.gray(`   - ${p}`)));

    const getAllFiles = async (dir, fileList = []) => {
      if (!await fs.pathExists(dir)) return fileList;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        entry.isDirectory()
          ? await getAllFiles(fullPath, fileList)
          : fileList.push(fullPath);
      }
      return fileList;
    };

    const allFiles = await getAllFiles(targetDir);
    let deletedCount = 0, keptCount = 0;

    for (const filePath of allFiles) {
      const relativeToApp = path
        .relative(path.join(distPath, 'app'), filePath)
        .replace(/\\/g, '/');

      if (!keepPaths.has(relativeToApp)) {
        await fs.remove(filePath);
        // console.log(chalk.gray(`   已删除: ${relativeToApp}`));
        deletedCount++;
      } else {
        console.log(chalk.green(`   保留: ${relativeToApp}`));
        keptCount++;
      }
    }

    const removeEmptyDirs = async (dir) => {
      if (!await fs.pathExists(dir)) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          await removeEmptyDirs(path.join(dir, entry.name));
        }
      }
      const remaining = await fs.readdir(dir);
      if (remaining.length === 0 && dir !== targetDir) {
        await fs.remove(dir);
        // console.log(chalk.gray(`   已删除空目录: ${dir}`));
      }
    };

    await removeEmptyDirs(targetDir);
    console.log(chalk.green(`✅ 清理完成 (保留: ${keptCount}, 删除: ${deletedCount})`));
  }

  // 8. 创建日期文件夹并整理文件
  let curDateTime = dayjs().format('YYYY-MM-DD HH:mm');
  // 空格替换成 '-'
  curDateTime = curDateTime.replace(/\s+/g, '-');
  // 把 ':' 替换成 '-'
  curDateTime = curDateTime.replace(':', '-');
  const folderName = `ZBCX-${curDateTime}-${prjName}项目补丁包`
  const finalFolderPath = path.join(distPath, folderName);
  console.log(chalk.yellow(`7️⃣ 正在整理文件到目录: ${folderName}...`));

  await fs.ensureDir(finalFolderPath);
  await fs.move(path.join(distPath, 'app'), path.join(finalFolderPath, 'app'), { overwrite: true });
  console.log(chalk.green(`   已移动: app/ -> ${folderName}/app/`));

  const destLogPath = path.join(finalFolderPath, logFileName);
  await fs.move(logFilePath, destLogPath, { overwrite: true });
  console.log(chalk.green(`   已移动: ${logFileName} -> ${folderName}/${logFileName}`));

  // 移动/dist/下的sql文件到finalFolderPath下
  let sqlpath = `${projectPath}/dist/${prjName}.sql`
  if (fs.existsSync(sqlpath)) {
    await fs.move(sqlpath, `${finalFolderPath}/${prjName}.sql`, { overwrite: true });
    console.log(chalk.green(`   已移动: ${prjName}.sql -> ${finalFolderPath}`));
  } else {
    console.error(chalk.red('数据库脚本不存在'));
  }

  // 判断finalFolderPath/app/文件夹下有没有除了assets和static以外的文件夹，有的话删除文件夹，文件不删
  const appDir = path.join(finalFolderPath, 'app');
  const excludedFolders = new Set(['assets', 'static']);

  fs.readdirSync(appDir).forEach((entry) => {
    const fullPath = path.join(appDir, entry);
    if (fs.lstatSync(fullPath).isDirectory() && !excludedFolders.has(entry)) {
      fs.rmSync(fullPath, { recursive: true, force: true }); // Node 16.7+
      console.log(`已删除文件夹: ${fullPath}`);
    }
  });


  // 9. 压缩
  const zipName = `${folderName}.zip`;
  const zipPath = path.join(distPath, zipName);
  console.log(chalk.yellow(`8️⃣ 正在压缩目录为 ${zipName}...`));

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(finalFolderPath, false);
    archive.finalize();
  });

  console.log(chalk.green(`✅ 压缩成功! 文件位于: ${zipPath}`));
  console.log(chalk.cyan(`🎉 打包工作流全部完成!`));

  return { zipPath, zipName, logPath: destLogPath };
}


// ---- CLI 入口（仅直接运行时生效）----
if (process.argv[1] === new URL(import.meta.url).pathname) {
  program
    .requiredOption('-p, --path <path>', 'Vue 项目的绝对路径')
    .requiredOption('-d, --date <date>', '时间参数 (格式: YYYY-MM-DD)')
    .action(async (options) => {
      try {
        await runBuildWorkflow({ gitName: options.gitName, path: options.path, date: options.date, email: options.email, prjName: options.prjName });
      } catch (error) {
        console.error(chalk.red('❌ 发生错误:'), error.message);
        process.exit(1);
      }
    });

  program.parse(process.argv);
}
