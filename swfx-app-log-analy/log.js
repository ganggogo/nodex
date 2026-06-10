import axios from 'axios'
import readline from 'readline'

const LOG_URL =
  'http://192.168.2.122:18879/getSwfxWebLogs/swfx-app-access.log'

const logRegex =
  /^(\S+)\s+-\s+-\s+\[([^\]]+)\]\s+"(\S+)\s+([^"]+)\s+HTTP\/[^"]+"\s+(\d+)/

const staticExts = [
  '.js',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.map',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.json'
]

const visitMap = new Map()

function formatTime(nginxTime) {
  const timeStr = nginxTime.split(' ')[0]

  const firstColonIndex = timeStr.indexOf(':')

  const dayMonthYear = timeStr.substring(
    0,
    firstColonIndex
  )

  const time = timeStr.substring(
    firstColonIndex + 1
  )

  const [day, monthStr, year] =
    dayMonthYear.split('/')

  const monthMap = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12'
  }

  const month = monthMap[monthStr] || '01'

  return `${year}-${month}-${day} ${time}`
}

function processLine(line) {
  const match = line.match(logRegex)

  if (!match) return

  const ip = match[1]
  const rawTime = match[2]
  const url = match[4]
  const status = match[5]

  if (status !== '200') return

  const isStatic = staticExts.some(ext =>
    url.toLowerCase().includes(ext)
  )

  if (isStatic) return

  const formattedTime = formatTime(rawTime)

  if (!visitMap.has(ip)) {
    visitMap.set(ip, {
      count: 1,
      firstTime: formattedTime,
      lastTime: formattedTime
    })

    return
  }

  const item = visitMap.get(ip)

  item.count++

  if (formattedTime < item.firstTime) {
    item.firstTime = formattedTime
  }

  if (formattedTime > item.lastTime) {
    item.lastTime = formattedTime
  }
}

async function analyzeLog() {
  console.log('开始获取日志...\n')

  const response = await axios({
    method: 'get',
    url: LOG_URL,
    responseType: 'stream',
    timeout: 60000
  })

  const total =
    Number(response.headers['content-length']) || 0

  let downloaded = 0

  response.data.on('data', chunk => {
    downloaded += chunk.length

    if (total) {
      const percent = (
        (downloaded / total) *
        100
      ).toFixed(2)

      process.stdout.write(
        `\r下载进度: ${percent}%`
      )
    }
  })

  const rl = readline.createInterface({
    input: response.data,
    crlfDelay: Infinity
  })

  let lineCount = 0

  for await (const line of rl) {
    processLine(line)

    lineCount++

    if (lineCount % 50000 === 0) {
      process.stdout.write(
        `\r已解析 ${lineCount.toLocaleString()} 行`
      )
    }
  }

  const result = Array.from(
    visitMap.entries()
  ).map(([ip, info]) => ({
    IP: ip,
    访问次数: info.count,
    首次访问时间: info.firstTime,
    最后访问时间: info.lastTime
  }))

  // 按最后访问时间倒序
  result.sort(
    (a, b) =>
      new Date(b['最后访问时间']) -
      new Date(a['最后访问时间'])
  )

  console.log(
    '\n\n================ 访问统计 ================\n'
  )

  console.table(result)

  console.log(
    `\n总IP数: ${result.length}`
  )
}

analyzeLog().catch(err => {
  console.error(err)
  process.exit(1)
})