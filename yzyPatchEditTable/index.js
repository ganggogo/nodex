import path from 'path'
import fs from 'fs'
import XLSX from 'xlsx'
import pg from 'pg'

const { Client } = pg

async function main() {

  // =========================
  // 日志文件
  // =========================
  const logPath = path.join(
    process.cwd(),
    'update_log.txt'
  )

  function writeLog(message) {

    const time = new Date().toLocaleString()

    const text = `[${time}] ${message}\n`

    console.log(text)

    fs.appendFileSync(logPath, text)
  }

  writeLog('程序启动')

  // =========================
  // 数据库连接
  // =========================
  const client = new Client({
    host: '172.20.20.33',
    port: 55555,
    user: 'ddydkc',
    password: 'King@Base2025!#',
    database: 'geology_db'
  })

  await client.connect()

  writeLog('数据库连接成功')

  // =========================
  // 读取 Excel
  // =========================
  const excelPath = path.join(
    process.cwd(),
    '图层汇总表5w(1).xlsx'
  )

  const workbook = XLSX.readFile(excelPath)

  const sheetName = workbook.SheetNames[0]

  const sheet = workbook.Sheets[sheetName]

  const rows = XLSX.utils.sheet_to_json(sheet)

  writeLog(`读取到 ${rows.length} 条记录`)

  // =========================
  // 去重
  // =========================
  const handledSet = new Set()

  // =========================
  // 遍历 Excel
  // =========================
  for (const row of rows) {

    const tableName = String(
      row['入库表'] || ''
    ).trim()

    const layerCode = String(
      row['图层编码'] || ''
    ).trim()

    const featureCode = String(
      row['图元编码'] || ''
    ).trim()

    if (
      !tableName ||
      !layerCode ||
      !featureCode
    ) {

      writeLog('跳过空行')

      continue
    }

    // 唯一 key
    const uniqueKey =
      `${tableName}__${layerCode}`

    // 防止重复更新
    if (handledSet.has(uniqueKey)) {

      writeLog(`跳过重复项: ${uniqueKey}`)

      continue
    }

    handledSet.add(uniqueKey)

    writeLog('====================================')

    writeLog(`开始处理`)

    writeLog(`表名: ${tableName}`)

    writeLog(`图层编码: ${layerCode}`)

    writeLog(`图元编码: ${featureCode}`)

    try {

      const sql = `
WITH tmp AS (
    SELECT
        smid,
        REPLACE(
            '${featureCode}_' ||
            ROW_NUMBER() OVER (ORDER BY smid),
            ' ',
            ''
        ) AS new_chfcac
    FROM public."${tableName}"
    WHERE TRIM(tcbm) = '${layerCode}'
)
UPDATE public."${tableName}" q
SET chfcac = t.new_chfcac
FROM tmp t
WHERE q.smid = t.smid;
`

      const result = await client.query(sql)

      writeLog(
        `处理成功: ${tableName} -> ${layerCode}`
      )

      writeLog(
        `影响行数: ${result.rowCount}`
      )

    } catch (err) {

      writeLog('处理失败')

      writeLog(`表名: ${tableName}`)

      writeLog(`图层编码: ${layerCode}`)

      writeLog(`错误信息: ${err.message}`)
    }
  }

  // =========================
  // 关闭连接
  // =========================
  await client.end()

  writeLog('数据库连接关闭')

  writeLog('全部处理完成')
}

main().catch(err => {

  console.error(err)

  fs.appendFileSync(
    path.join(process.cwd(), 'update_log.txt'),
    `[FATAL] ${err.stack}\n`
  )
})
