import * as XLSX from 'xlsx';
import fs from 'fs';

// 1. 读取数据
const appendixData = JSON.parse(fs.readFileSync('data.json', 'utf8'));

// 2. 创建 Workbook
const wb = XLSX.utils.book_new();

// --- 过滤 Sheet 名称的函数 ---
function sanitizeSheetName(name) {
    if (!name) return "Sheet";
    // 替换 Excel 不允许的特殊字符: : \ / ? * [ ]
    // 同时去掉首尾空格
    let cleanName = name.replace(/[:\\\/?*\[\]]/g, "_").trim();
    
    // Excel Sheet 名称最大长度为 31 个字符
    return cleanName.substring(0, 31);
}

// 记录已使用的名称，防止重复导致报错
const usedNames = new Set();

appendixData.forEach((table, index) => {
    // 3. 构造数据
    const sheetData = [
        table.headers,
        table.values
    ];

    // 4. 清洗表名
    let sheetName = sanitizeSheetName(table.tableName);
    
    // 如果名称重复（清洗后可能变成一样的），加个后缀
    if (usedNames.has(sheetName)) {
        sheetName = sheetName.substring(0, 28) + "_" + index;
    }
    usedNames.add(sheetName);

    // 5. 生成 Sheet 并追加
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
});

// 6. 保存文件
const outputName = 'Final_Export_' + Date.now() + '.xlsx';
XLSX.writeFile(wb, outputName);

console.log(`成功生成 Excel: ${outputName}`);
