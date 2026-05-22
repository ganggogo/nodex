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

program
  .requiredOption('-p, --path <path>', 'Vue 项目的绝对路径')
  .requiredOption('-d, --date <date>', '时间参数 (格式: YYYY-MM-DD)')
  .action(async (options) => {
    const projectPath = path.resolve(options.path);
    const inputDate = dayjs(options.date).startOf('day');
    
    // 定义 dist 路径，方便后续使用
    const distPath = path.join(projectPath, 'dist');
    // 修改：日志文件现在生成在 dist 目录下
    const logFileName = `changes_since_${options.date}.txt`;
    const logFilePath = path.join(distPath, logFileName);

    console.log(chalk.cyan(`🚀 开始工作流...`));
    console.log(`📂 项目路径: ${projectPath}`);
    console.log(`📅 过滤时间: ${options.date}`);

    if (!await fs.pathExists(projectPath)) {
      console.error(chalk.red(`❌ 错误: 路径不存在 - ${projectPath}`));
      return;
    }

    try {
      const git = simpleGit(projectPath);

      try {
        await git.checkout('main'); 
        console.log('✅ 已切换到 main 分支');
      } catch (e) {
        console.error('❌ 切换分支失败:', e);
      }

      // 1. Git 提交本地代码
      console.log(chalk.yellow('1️⃣ 正在检查状态并提交本地更改...'));
      const status = await git.status();
      
      if (!status.isClean()) {
        await git.add('.');
        await git.raw(['config', 'user.name', 'xugang']);
        await git.raw(['config', 'user.email', 'xugang@whzbcx.com']);
        await git.commit('Auto commit: save local changes before workflow');
        console.log(chalk.green('✅ 本地代码已提交'));
      }

      // 2. 拉取远程代码
      console.log(chalk.yellow('2️⃣ 正在拉取远程代码...'));
      await git.pull(['--no-edit']);
      console.log(chalk.green('✅ 远程代码已拉取'));

      // 3. 收集日志并分析文件
      console.log(chalk.yellow('3️⃣ 正在收集 Git 日志并分析变更文件...'));
      
      await git.raw(['config', 'core.quotePath', 'false']);
      
      const allLogs = await git.log();
      const filteredLogs = allLogs.all.filter(log => {
        const logDate = dayjs(log.date);
        return logDate.isAfter(inputDate);
      });

      const keepPaths = new Set();
      let fullLogContent = `Git 变更日志 (自 ${options.date} 起)\n========================================\n`;

      if (filteredLogs.length === 0) {
        fullLogContent += "无相关更新记录\n";
      }

      for (const log of filteredLogs) {
        try {
          const showResult = await git.show([log.hash, '--name-status', '--format=']);
          const lines = showResult.split('\n');
          const files = [];

          lines.forEach(line => {
            if (!line.trim()) return;
            const parts = line.split(/\t/);
            const [status, filePath] = parts;

            if (filePath) {
                files.push({ status, file: filePath });
                if (['M', 'A', 'R'].includes(status) && filePath.startsWith('public/static/')) {
                   const relativePath = filePath.replace('public/', '');
                   keepPaths.add(relativePath);
                }
            }
          });

          fullLogContent += `\n提交者: ${log.author_name}\n`;
          fullLogContent += `时间: ${dayjs(log.date).format('YYYY-MM-DD HH:mm:ss')}\n`;
          fullLogContent += `内容: ${log.message}\n`;
          fullLogContent += `影响文件:\n`;
          
          if (files.length > 0) {
            files.forEach(f => fullLogContent += `  [${f.status}] ${f.file}\n`);
          } else {
            fullLogContent += `  (无文件变更)\n`;
          }
          fullLogContent += `----------------------------------------\n`;

        } catch (err) {
          console.warn(chalk.yellow(`⚠️ 无法获取提交 ${log.hash} 的文件列表: ${err.message}`));
        }
      }

      await git.raw(['config', 'core.quotePath', 'true']);

      console.log(chalk.green(`✅ 分析完成，共有 ${keepPaths.size} 个 static 文件需要保留。`));

      // 4. 执行 NPM 打包
      console.log(chalk.yellow('4️⃣ 正在执行 npm run build...'));
      
      try {
        await execPromise('npm run build', { 
          cwd: projectPath,
          maxBuffer: 1024 * 1024 * 100 
        });
        console.log(chalk.green('✅ 打包完成'));
      } catch (err) {
        console.error(chalk.red('❌ 打包失败:'), err.message);
        return;
      }

      // --- 修改部分开始 ---

      // 5. 写入日志文件 (在打包完成后写入 dist，防止打包清空 dist 时丢失)
      console.log(chalk.yellow('5️⃣ 正在写入日志文件到 dist 目录...'));
      await fs.writeFile(logFilePath, fullLogContent, 'utf8');
      console.log(chalk.green(`✅ 日志已写入: ${logFilePath}`));

      // 6. 清理 dist/app/static 文件

      console.log(chalk.yellow('6️⃣ 正在根据白名单清理 static 目录...'));
      
      const targetDir = path.join(projectPath, 'dist', 'app', 'static');
      
      if (!await fs.pathExists(targetDir)) {
        console.error(chalk.red(`❌ 错误: 打包输出目录不存在 - ${targetDir}`));
        // 如果 static 目录本身就不存在（可能被 build 配置跳过了），直接跳过清理步骤，不要报错退出
        console.log(chalk.yellow('⚠️ 跳过清理步骤'));
      } else {
        console.log(chalk.yellow('5️⃣ 正在根据白名单清理 static 目录...'));
        
        // --- 调试：打印白名单内容 ---
        console.log(chalk.gray('   [调试] 白名单内容:'));
        keepPaths.forEach(p => console.log(chalk.gray(`   - ${p}`)));

        // --- 优化：使用扁平化列表遍历 ---
        const getAllFiles = async (dir, fileList = []) => {
          // 防止目录不存在导致报错
          if (!await fs.pathExists(dir)) return fileList; 
          
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await getAllFiles(fullPath, fileList);
            } else {
              fileList.push(fullPath);
            }
          }
          return fileList;
        };

        const allFiles = await getAllFiles(targetDir);
        let deletedCount = 0;
        let keptCount = 0;

        for (const filePath of allFiles) {
          // 计算相对于 dist/app 的路径
          let relativeToApp = path.relative(path.join(projectPath, 'dist', 'app'), filePath);
          
          // 【核心修复】将所有反斜杠替换为正斜杠，确保与 Git 日志格式一致
          relativeToApp = relativeToApp.replace(/\\/g, '/');

          if (!keepPaths.has(relativeToApp)) {
            await fs.remove(filePath);
            console.log(chalk.gray(`   已删除: ${relativeToApp}`));
            deletedCount++;
          } else {
            console.log(chalk.green(`   保留: ${relativeToApp}`));
            keptCount++;
          }
        }

        // 单独处理空目录清理
        const removeEmptyDirs = async (dir) => {
          if (!await fs.pathExists(dir)) return;
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const subDirPath = path.join(dir, entry.name);
              await removeEmptyDirs(subDirPath);
            }
          }
          const finalEntries = await fs.readdir(dir);
          if (finalEntries.length === 0 && dir !== targetDir) {
             await fs.remove(dir);
             console.log(chalk.gray(`   已删除空目录: ${dir}`));
          }
        };
        
        await removeEmptyDirs(targetDir);
        console.log(chalk.green(`✅ static 目录清理完成 (保留: ${keptCount}, 删除: ${deletedCount})`));
      }

      // 7. 创建日期文件夹并移动文件
      const now = dayjs();
      const folderName = now.format('YYYY-MM-DD');
      const finalFolderPath = path.join(distPath, folderName);
      
      console.log(chalk.yellow(`7️⃣ 正在创建目录并整理文件: ${folderName}...`));

      // 确保目标目录存在
      await fs.ensureDir(finalFolderPath);

      // 移动 app 文件夹 -> 日期文件夹/app
      const sourceAppPath = path.join(distPath, 'app');
      const destAppPath = path.join(finalFolderPath, 'app');
      await fs.move(sourceAppPath, destAppPath, { overwrite: true });
      console.log(chalk.green(`   已移动: app/ -> ${folderName}/app/`));

      // 移动 日志文件 -> 日期文件夹/日志.txt
      const destLogPath = path.join(finalFolderPath, logFileName);
      await fs.move(logFilePath, destLogPath, { overwrite: true });
      console.log(chalk.green(`   已移动: ${logFileName} -> ${folderName}/${logFileName}`));

      // 8. 压缩文件夹
      const zipName = `${folderName}.zip`;
      const zipPath = path.join(distPath, zipName);
      
      console.log(chalk.yellow(`8️⃣ 正在压缩目录为 ${zipName}...`));
      
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        console.log(chalk.green(`✅ 压缩成功! 文件位于: ${zipPath}`));
        console.log(chalk.cyan(`🎉 工作流全部完成!`));
      });

      archive.on('error', (err) => {
        throw err;
      });

      archive.pipe(output);
      // 重点：这里压缩的是 finalFolderPath (日期文件夹)，false 表示不保留最外层的日期目录层级
      archive.directory(finalFolderPath, false);
      archive.finalize();

    } catch (error) {
      console.error(chalk.red('❌ 发生错误:'), error);
    }
  });

program.parse(process.argv);
