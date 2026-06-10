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
    'empty_chfcac_log.txt'
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
  // 统计
  // =========================
  let totalEmptyCount = 0

  const emptyTableList = []

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

    if (!tableName || !layerCode) {

      writeLog('跳过空行')

      continue
    }

    // 防止重复检查
    const uniqueKey =
      `${tableName}__${layerCode}`

    if (handledSet.has(uniqueKey)) {

      continue
    }

    handledSet.add(uniqueKey)

    writeLog('====================================')

    writeLog(`开始检查:`)

    writeLog(`表名: ${tableName}`)

    writeLog(`图层编码: ${layerCode}`)

    try {

      // =========================
      // 查询空值数量
      // =========================
      const sql = `
SELECT COUNT(*) AS count
FROM public."${tableName}"
WHERE TRIM(tcbm) = $1
AND (
    chfcac IS NULL
    OR TRIM(chfcac) = ''
)
`

      const result = await client.query(
        sql,
        [layerCode]
      )

      const count = Number(
        result.rows[0].count
      )

      if (count > 0) {

        totalEmptyCount += count

        emptyTableList.push({
          tableName,
          layerCode,
          count
        })

        writeLog(
          `发现空值 -> 数量: ${count}`
        )

      } else {

        writeLog('无空值')
      }

    } catch (err) {

      writeLog('检查失败')

      writeLog(`表名: ${tableName}`)

      writeLog(`图层编码: ${layerCode}`)

      writeLog(`错误信息: ${err.message}`)
    }
  }

  // =========================
  // 输出汇总
  // =========================
  writeLog('====================================')

  writeLog(
    `存在空值的图层数量: ${emptyTableList.length}`
  )

  writeLog(
    `空值总记录数: ${totalEmptyCount}`
  )

  writeLog('====================================')

  for (const item of emptyTableList) {

    writeLog(
      `表: ${item.tableName} | 图层编码: ${item.layerCode} | 空值数量: ${item.count}`
    )
  }

  // =========================
  // 关闭连接
  // =========================
  await client.end()

  writeLog('数据库连接关闭')

  writeLog('检查完成')
}

main().catch(err => {

  console.error(err)

  fs.appendFileSync(
    path.join(process.cwd(), 'empty_chfcac_log.txt'),
    `[FATAL] ${err.stack}\n`
  )
})
