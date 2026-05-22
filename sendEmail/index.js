import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件目录路径 (ES Module 写法)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. 创建 transporter 对象
let transporter = nodemailer.createTransport({
  host: 'smtp.exmail.qq.com', 
  port: 465,
  secure: true, 
  auth: {
    user: 'xugang@whzbcx.com', // 你的企业邮箱账号
    pass: 'HosBhr3Et2ufkC5i',       // 客户端专用密码
  },
});

// 2. 定义发送邮件的函数 (接收绝对路径参数)

/**
 * @param {string} filePath 要发送的文件路径
 * @param {string} zipName 压缩包文件名
 * @param {string} name 发送人姓名
 * @param {string} email 发送人邮箱
 * @param {string} emailTarget 收件人邮箱
 * @param {string} cpny 公司名称
 * @param {string} cpnyweb 公司网站
 * @param {string} dpt 部门
 * @param {string} tel 联系电话
 * @returns 
 */
export async function sendFileEmail({filePath, zipName, name, email, emailTarget, cpny, cpnyweb, dpt, tel}) {
  console.log('🚀 准备发送文件:', filePath);

  // 检查文件是否存在，避免发送失败
  if (!fs.existsSync(filePath)) {
    console.error('❌ 错误：文件不存在 -', filePath);
    return;
  }

  try {
    // 3. 定义邮件选项
    let mailOptions = {
      from: `"${name}" <${email}>`, 
      to: `${emailTarget.join(',')}`,                      
      subject: `文件发送：${zipName}`,    // 标题自动使用文件名
      text: '请查收附件。',              
      html: `
        <div style="font-family: 'Microsoft YaHei', sans-serif; line-height: 1.6; color: #333; max-width: 600px;">
            <p>各位项目组负责人：</p>
            <p style="text-indent: 2em;">你们好，附件是${zipName}，请查收，谢谢</p>
            <p style="text-indent: 2em;">身体健康，</p>
            <p style="text-indent: 2em;">工作顺利。</p>
            
            <hr style="border: 0; border-top: 1px solid #ccc; margin: 20px 0;">
            
            <div style="font-size: 14px; color: #555;">
                <p style="margin: 5px 0; font-size: 16px; font-weight: bold;"><strong>${cpny}</strong> (<a href="${email}" target="_blank" style="color: #007BFF; text-decoration: none;">${cpnyweb}</a>)</p>
                <p style="margin: 5px 0;">${dpt} &nbsp;&nbsp;&nbsp;&nbsp;${name}</p>
                <p style="margin: 5px 0;">Tel: ${tel}</p>
                <p style="margin: 5px 0;">Email: <a href="mailto:${email}" style="color: #007BFF; text-decoration: none;">${email}</a></p>
            </div>
        </div>
      `,     
      attachments: [                                    
        {
          filename: path.basename(filePath), // 附件名自动使用文件名
          path: filePath                     // 使用传入的绝对路径
        },
      ]
    };

    // 4. 发送邮件
    let info = await transporter.sendMail(mailOptions);
    console.log('✅ 邮件发送成功! Message ID: %s', info.messageId);

  } catch (error) {
    console.error('❌ 邮件发送失败:', error);
  }
}

// --- 调用示例 ---

// 方式 A: 传入绝对路径 (Windows 示例)
// sendFileEmail('D:\\Work\\Project\\report.pdf');

// 方式 B: 传入绝对路径 (Mac/Linux 示例)
// sendFileEmail('/Users/name/files/report.pdf');

// 方式 C: 基于当前脚本目录拼接路径
// sendFileEmail(path.join(__dirname, 'example.pdf'));

// 这里演示调用，请替换为你实际的文件路径
// sendFileEmail('E:/2025Prjs/项目文件/厦门地下空间/工程/js_ddy_dzsjgljzhfxxt/26_js_ddy_dzsjglfx_web-测试打包/dist/2026-04-22.zip'); 
