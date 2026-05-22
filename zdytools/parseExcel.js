import express from 'express';
import axios from 'axios';
import * as XLSX from 'xlsx';

const app = express();
app.use(express.json());

app.post('/parse', async (req, res) => {
    const { file_url } = req.body;

    if (!file_url) {
        return res.status(400).json({ error: 'Missing file_url' });
    }

    try {
        // 1. 下载文件
        const response = await axios.get(file_url, {
            responseType: 'arraybuffer'
        });

        // 2. 解析 Excel
        const workbook = XLSX.read(response.data);
        
        // 3. 按 Sheet 分类数据
        const result = {
            totalSheets: workbook.SheetNames.length,
            sheets: {}
        };

        workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            // 将当前 Sheet 转换为 JSON
            const data = XLSX.utils.sheet_to_json(worksheet);
            
            // 只有当 Sheet 不为空时才添加
            result.sheets[sheetName] = data;
        });

        // 4. 返回结果
        res.json(result);

    } catch (error) {
        console.error('Parser Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Excel 解析分类失败',
            error: error.message
        });
    }
});

const PORT = 18091;
app.listen(PORT, () => {
    console.log(`🚀 Excel Parser (Multi-Sheet) running on port ${PORT}`);
});
