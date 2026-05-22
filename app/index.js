import { Pool } from 'pg'

// 江苏大数据服务平台现场库
const pool = new Pool({
  host: '172.20.20.33',
  port: 55555,
  user: 'ddydkc',
  password: 'King@Base2025!#',
  database: 'geology_db'
})

import express from 'express'
const app = express();
app.use(express.json());

/**
 * ✅ 缓存表字段信息（避免每次查 information_schema）
 */
const tableGeomCache = new Map();

async function hasGeomColumn(tableName) {
  if (tableGeomCache.has(tableName)) {
    return tableGeomCache.get(tableName);
  }

  const checkSql = `
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = $1 AND column_name = 'geom'
    LIMIT 1
  `;

  const res = await pool.query(checkSql, [tableName]);
  const hasGeom = res.rows.length > 0;

  tableGeomCache.set(tableName, hasGeom);
  return hasGeom;
}

app.post('/query', async (req, res) => {
  const { sqlList } = req.body;
  console.log(sqlList)

  if (!Array.isArray(sqlList) || sqlList.length === 0) {
    return res.status(400).json({ error: 'sqlList must be a non-empty array' });
  }

  const FORBIDDEN_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|exec|execute)\b/i;
  const ALLOWED_TABLES = ['eg_hole', 'eg_holelayer', 'dcsx'];

  function validateSql(sql) {
    const trimmed = sql.trim();
    if (!trimmed.match(/^select\b/i)) return false;
    if (FORBIDDEN_KEYWORDS.test(trimmed)) return false;
    return true;
  }

  function extractTableName(sql) {
    const m = sql.match(/\bfrom\s+([a-zA-Z0-9_]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  // ==============================
  // 核心：解析 SQL 结构
  // 返回 { selectFields, mainTable, mainAlias, joins, where, tail }
  // ==============================
  function parseSql(sql) {
    // 提取 SELECT 字段
    const selectMatch = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+/i);
    if (!selectMatch) return null;
    const selectFields = selectMatch[1].trim();

    // 提取主表和别名：FROM eg_hole h
    const fromMatch = sql.match(/\bFROM\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/i);
    if (!fromMatch) return null;
    const mainTable = fromMatch[1];
    const mainAlias = fromMatch[2] || fromMatch[1];

    // 提取所有 JOIN 块
    const joinRegex = /\b((?:INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN\s+[a-zA-Z0-9_]+(?:\s+(?:AS\s+)?[a-zA-Z0-9_]+)?\s+ON\s+[\s\S]+?)(?=\b(?:INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN\b|\bWHERE\b|\bORDER\b|\bLIMIT\b|\bGROUP\b|$)/gi;
    const joins = [];
    let joinMatch;
    while ((joinMatch = joinRegex.exec(sql)) !== null) {
      joins.push(joinMatch[1].trim());
    }

    // 提取 WHERE 条件
    const whereMatch = sql.match(/\bWHERE\s+([\s\S]+?)(?=\bORDER\b|\bLIMIT\b|\bGROUP\b|;|$)/i);
    const where = whereMatch ? whereMatch[1].trim() : null;

    // 提取 ORDER BY / LIMIT / OFFSET 等尾部
    const tailMatch = sql.match(/\b(ORDER\s+BY[\s\S]+?|LIMIT[\s\S]+?|GROUP\s+BY[\s\S]+?)(?=;|$)/i);
    const tail = tailMatch ? tailMatch[0].trim() : '';

    // 更完整的尾部：从 ORDER/GROUP/LIMIT 开始到结尾
    const tailFull = sql.match(/\b((?:GROUP\s+BY|ORDER\s+BY|LIMIT)[\s\S]+?)(?:;|$)/i);
    
    return {
      selectFields,
      mainTable,
      mainAlias,
      joins,
      where,
      tail: tailFull ? tailFull[1].trim() : '',
    };
  }

  // ==============================
  // 判断是否是主表通配符查询（h.* 或 *）
  // ==============================
  function isWildcardSelect(selectFields, mainAlias) {
    const f = selectFields.trim();
    return (
      f === '*' ||
      f.toLowerCase() === `${mainAlias.toLowerCase()}.*` ||
      f.split(',').some(part => {
        const t = part.trim();
        return t === '*' || t.toLowerCase() === `${mainAlias.toLowerCase()}.*`;
      })
    );
  }

  // ==============================
  // 把 JOIN 改写成 EXISTS 子查询（只保留主表数据，不重复）
  // ==============================
  function rewriteJoinAsExists(parsed) {
    const { selectFields, mainTable, mainAlias, joins, where, tail } = parsed;

    if (joins.length === 0) return null; // 没有 JOIN，不需要改写

    // 把所有 JOIN 转成 EXISTS 子查询
    const existsClause = `EXISTS (
      SELECT 1
      FROM ${joins.map(j => {
        // 提取 JOIN 的表名和 ON 条件
        const jm = j.match(/JOIN\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\s+ON\s+([\s\S]+)/i);
        if (!jm) return '';
        const joinTable = jm[1];
        const joinAlias = jm[2] || jm[1];
        const onCondition = jm[3].trim();
        return `${joinTable} ${joinAlias}`;
      }).join(', ')}
      WHERE ${joins.map(j => {
        const jm = j.match(/JOIN\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\s+ON\s+([\s\S]+)/i);
        return jm ? jm[3].trim() : '';
      }).filter(Boolean).join(' AND ')}
    )`;

    // 重新组装 WHERE
    const newWhere = where
      ? `WHERE ${where} AND ${existsClause}`
      : `WHERE ${existsClause}`;

    return `SELECT ${selectFields} FROM ${mainTable} ${mainAlias} ${newWhere} ${tail}`.trim();
  }

  // ==============================
  // 改造 SQL：注入 geom 转换字段
  // ==============================
  function buildGeomSql(rawSql) {
    const match = rawSql.match(/^(\s*SELECT\s+)([\s\S]+?)(\s+FROM\s+[\s\S]+)$/i);
    if (!match) return rawSql;

    const [, selectKeyword, fields, fromAndBeyond] = match;
    if (fields.trim().toLowerCase().startsWith('count(')) return rawSql;

    const injected = [
      `ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geojson`,
      `ST_X(ST_Transform(geom, 4326)) AS _lon`,
      `ST_Y(ST_Transform(geom, 4326)) AS _lat`,
    ].join(', ');

    const trimmedFields = fields.trim();
    const hasWildcard =
      trimmedFields === '*' ||
      /^[a-zA-Z_]\w*\.\*$/.test(trimmedFields) ||
      trimmedFields.split(',').some(f => {
        const t = f.trim();
        return t === '*' || /^[a-zA-Z_]\w*\.\*$/.test(t);
      });
    const hasGeom = /\bgeom\b/i.test(fields);

    let newFields;
    if (hasWildcard) {
      newFields = `${injected}, ${fields}`;
    } else if (hasGeom) {
      newFields = fields.replace(/\bgeom\b/gi, injected);
    } else {
      return rawSql;
    }

    return `${selectKeyword}${newFields}${fromAndBeyond}`;
  }

  // ==============================
  // 处理单行结果
  // ==============================
  function processRow(row) {
    const { geojson, _lon, _lat, geom, ...rest } = row;
    if (!geojson) return rest;

    const geo = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
    const result = { ...rest, geojson: geo };

    if (geo.type === 'Point') {
      result.lon = _lon != null ? parseFloat(_lon) : null;
      result.lat = _lat != null ? parseFloat(_lat) : null;
    }

    return result;
  }

  // ==============================
  // 主流程
  // ==============================
  for (let i = 0; i < sqlList.length; i++) {
    const rawSql = sqlList[i];
    console.log(rawSql);
    if (!rawSql || typeof rawSql !== 'string') continue;

    if (!validateSql(rawSql)) {
      console.warn(`[skip] 安全校验不通过: ${rawSql}`);
      continue;
    }

    const tableName = extractTableName(rawSql);
    if (!tableName || !ALLOWED_TABLES.includes(tableName)) {
      console.warn(`[skip] 表名不在白名单: ${tableName}`);
      continue;
    }

    let finalSql = rawSql;

    // ✅ 第一步：如果有 JOIN 且是通配符查询，改写成 EXISTS
    const parsed = parseSql(rawSql);
    if (parsed && parsed.joins.length > 0 && isWildcardSelect(parsed.selectFields, parsed.mainAlias)) {
      const rewritten = rewriteJoinAsExists(parsed);
      if (rewritten) {
        console.log('[JOIN 改写为 EXISTS]', rewritten);
        finalSql = rewritten;
      }
    }

    // ✅ 第二步：注入 geom 转换
    try {
      const geomExists = await hasGeomColumn(tableName);
      if (geomExists) {
        finalSql = buildGeomSql(finalSql);
      }
    } catch (e) {
      // hasGeomColumn 失败，保持原样
    }

    console.log('[原始 SQL]', rawSql);
    console.log('[执行 SQL]', finalSql);

    try {
      const result = await pool.query(finalSql);
      if (result.rows && result.rows.length > 0) {
        const data = result.rows.map(processRow);
        return res.json({ hitIndex: i, data });
      }
    } catch (err) {
      console.warn(`[error] 第 ${i} 条 SQL 执行失败: ${err.message}`);
      continue;
    }
  }

  return res.json({ hitIndex: -1, data: [] });
});


// 启动服务

app.listen(3001, () => {
  console.log('API running: http://localhost:3001')
})
