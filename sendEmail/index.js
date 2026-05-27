import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

const DEFAULT_MAX_ATTACHMENT_MB = 45;

function createTransporter(email, psd) {
  return nodemailer.createTransport({
    host: 'smtp.exmail.qq.com',
    port: 465,
    secure: true,
    auth: {
      user: email,
      pass: psd,
    },
  });
}

function fileSizeMb(filePath) {
  return fs.statSync(filePath).size / 1024 / 1024;
}

/**
 * @returns {Promise<{sent: boolean, skipped?: boolean, reason?: string, messageId?: string}>}
 */
export async function sendFileEmail({
  filePath,
  zipName,
  name,
  email,
  psd,
  emailTarget,
  cpny,
  cpnyweb,
  dpt,
  tel,
  maxAttachmentMb = DEFAULT_MAX_ATTACHMENT_MB,
}) {
  console.log('准备发送文件:', filePath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const sizeMb = fileSizeMb(filePath);
  if (sizeMb > maxAttachmentMb) {
    const reason = `文件 ${sizeMb.toFixed(1)}MB，超过邮件附件限制 ${maxAttachmentMb}MB，已跳过邮件发送。`;
    console.warn(reason);
    return { sent: false, skipped: true, reason };
  }

  if (!email || !psd) {
    const reason = '邮箱账号或授权码为空，已跳过邮件发送。';
    console.warn(reason);
    return { sent: false, skipped: true, reason };
  }

  if (!Array.isArray(emailTarget) || emailTarget.length === 0) {
    const reason = '收件人为空，已跳过邮件发送。';
    console.warn(reason);
    return { sent: false, skipped: true, reason };
  }

  try {
    const transporter = createTransporter(email, psd);
    const mailOptions = {
      from: `"${name}" <${email}>`,
      to: emailTarget.join(','),
      subject: `文件发送: ${zipName}`,
      text: `附件是 ${zipName}，请查收。`,
      html: `
        <div style="font-family: 'Microsoft YaHei', sans-serif; line-height: 1.6; color: #333; max-width: 600px;">
          <p>各位项目组负责人：</p>
          <p style="text-indent: 2em;">你们好，附件是 ${zipName}，请查收。</p>
          <hr style="border: 0; border-top: 1px solid #ccc; margin: 20px 0;">
          <div style="font-size: 14px; color: #555;">
            <p style="margin: 5px 0; font-size: 16px; font-weight: bold;"><strong>${cpny || ''}</strong> (${cpnyweb || ''})</p>
            <p style="margin: 5px 0;">${dpt || ''} &nbsp;&nbsp;&nbsp;&nbsp;${name || ''}</p>
            <p style="margin: 5px 0;">Tel: ${tel || ''}</p>
            <p style="margin: 5px 0;">Email: ${email || ''}</p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: path.basename(filePath),
          path: filePath,
        },
      ],
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('邮件发送成功: %s', info.messageId);
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    throw new Error(`邮件发送失败: ${error.response || error.message}`);
  }
}
