import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

/**
 * 执行系统命令的辅助函数
 */
function runCommand(command, workingDir) {
    try {
        console.log(`⏳ 执行: ${command}`);
        const output = execSync(command, { 
            encoding: 'utf8',
            cwd: workingDir 
        });
        return output.trim();
    } catch (error) {
        console.error(`❌ 命令执行失败: ${command}`);
        console.error(error.stderr || error.message);
        throw error;
    }
}

/**
 * 核心处理函数
 * @param {string} svnUrl - SVN 仓库地址
 * @param {string} localPath - 本地SQL文件所在的绝对路径 (工作目录)
 * @param {string} targetDirPath - 目标文件夹的绝对路径
 * @param {string} outputFileName - 想要生成的文件名
 */
export function processSvnSql(svnUrl, localPath, targetDirPath, outputFileName) {
    // 1. 校验本地路径
    if (!fs.existsSync(localPath)) {
        throw new Error(`❌ 本地路径不存在: ${localPath}`);
    }

    console.log(`📂 设定工作目录: ${localPath}`);

    try {
        // 2. 拉取 SVN 内容
        const svnMetaDir = path.join(localPath, '.svn');
        if (fs.existsSync(svnMetaDir)) {
            console.log(`⏬ 正在当前目录更新 SVN 内容...`);
            runCommand(`svn update`, localPath);
        } else {
            console.log(`⚠️ 未检测到 .svn 目录，正在从 ${svnUrl} 检出到 ${localPath}...`);
            runCommand(`svn checkout ${svnUrl} .`, localPath);
        }

        // 3. 查找目标文件
        const files = fs.readdirSync(localPath);
        const matchedFile = files.find(file => file.includes('update') && path.extname(file) === '.sql');

        if (!matchedFile) {
            throw new Error(`❌ 在路径 ${localPath} 下未找到包含 'update' 的 SQL 文件。`);
        }

        const oldFilePath = path.join(localPath, matchedFile);
        console.log(`📄 找到目标文件: ${matchedFile}`);

        // 4. 读取文件内容
        let content = fs.readFileSync(oldFilePath, 'utf8');
        const separator = '******------';
        const separatorIndex = content.lastIndexOf(separator);

        if (separatorIndex === -1) {
            throw new Error(`❌ 在文件 ${matchedFile} 中未找到分隔符 '${separator}'`);
        }

        // ================= 修改点：截取逻辑 =================
        
        // 计算截取起始位置：分隔符的索引 + 分隔符的长度
        // 这样就能从分隔符的下一位开始截取，从而不包含分隔符本身
        const startIndex = separatorIndex + separator.length;
        
        // 截取从 startIndex 直到字符串末尾的内容
        const extractedContent = content.substring(startIndex);

        // =================================================

        // 5. 定义临时文件路径 (在当前 SVN 工作目录下创建)
        const tempFileName = `temp_${outputFileName}`;
        const tempFilePath = path.join(localPath, tempFileName);

        // 6. 写入临时文件 (新建文件)
        console.log(`📝 正在本地创建临时文件: ${tempFilePath}`);
        fs.writeFileSync(tempFilePath, extractedContent);

        // 7. 确保目标目录存在
        if (!fs.existsSync(targetDirPath)) {
            console.log(`📁 目标目录不存在，正在创建: ${targetDirPath}`);
            fs.mkdirSync(targetDirPath, { recursive: true });
        }

        // 8. 定义最终文件路径
        const finalFilePath = path.join(targetDirPath, outputFileName);

        // 9. 移动文件 (使用 fs-extra 的 moveSync，支持跨分区移动并覆盖)
        console.log(`🚚 正在移动文件到目标路径: ${finalFilePath}`);
        fs.moveSync(tempFilePath, finalFilePath, { overwrite: true });

        console.log(`✅ 文件已生成并移动到: ${finalFilePath}`);

        // 10. 修改旧文件 (追加标记)
        const now = new Date();
        // const timeStr = now.toISOString().replace('T', ' ').substring(0, 19); // 会比北京时间慢八个小时，因为读取的是操作系统的时间，而北京时间比 UTC 时间快八个小时
        const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
        const footer = `\n------******${timeStr} 打包******------`;
        
        fs.appendFileSync(oldFilePath, footer);
        console.log(`📝 旧文件已追加打包标记`);

        // 11. 提交 SVN
        try {
            const commitMsg = `Update: Packaged ${matchedFile} at ${timeStr}`;
            runCommand(`svn commit ${oldFilePath} -m "${commitMsg}"`, localPath);
            console.log(`🚀 SVN 提交成功`);
            console.log(chalk.green(`✅ 数据库脚本操作完成···`));
        } catch (e) {
            console.warn(`⚠️ SVN 提交失败: ${e.message}`);
        }

    } catch (err) {
        console.error('💥 流程发生错误:', err.message);
        process.exit(1);
    }
}
