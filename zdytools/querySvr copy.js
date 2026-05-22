/**
 * Dify 自定义工具 - 通用 SQL 查询服务
 * 支持 MySQL / PostgreSQL / 人大金仓(KingbaseES) / SQLite / MSSQL
 * 使用各数据库原生驱动，不依赖 knex
 *
 * 接口：
 *   POST /tables  - 获取表名列表（来自 cx_entity）
 *   POST /query   - 执行条件查询
 */

import express from 'express';

const app = express();
app.use(express.json());

// ============================================================
// 类型归一化
// ============================================================

function normalizeType(dbType) {
  const t = String(dbType).toLowerCase().trim();
  if (['mysql', 'mysql2'].includes(t))                                              return 'mysql';
  if (['pg', 'postgres', 'postgresql', 'kingbase', 'kb', 'kingbasees'].includes(t)) return 'pg';
  if (['sqlite', 'sqlite3'].includes(t))                                            return 'sqlite';
  if (['mssql', 'sqlserver'].includes(t))                                           return 'mssql';
  throw new Error(`不支持的数据库类型: ${dbType}，支持: mysql / pg / kingbase / sqlite / mssql`);
}

// ============================================================
// 连接工厂
// 每种驱动统一封装为 { type, query(sql, params), end() }
// ============================================================

async function createClient(dbType, conn) {
  const type = normalizeType(dbType);

  // ---------- PostgreSQL / 人大金仓 ----------
  if (type === 'pg') {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      host:     conn.host     || '127.0.0.1',
      port:     parseInt(conn.port) || 5432,
      user:     conn.user     || conn.username,
      password: conn.password || conn.pass,
      database: conn.database || conn.db,
    });
    return {
      type,
      async query(sql, params = []) {
        const result = await pool.query(sql, params);
        return result.rows;
      },
      async end() { await pool.end(); },
    };
  }

  // ---------- MySQL ----------
  if (type === 'mysql') {
    const mysql2 = await import('mysql2/promise');
    const pool = mysql2.createPool({
      host:            conn.host     || '127.0.0.1',
      port:            parseInt(conn.port) || 3306,
      user:            conn.user     || conn.username,
      password:        conn.password || conn.pass,
      database:        conn.database || conn.db,
      waitForConnections: true,
      connectionLimit: 1,
    });
    return {
      type,
      async query(sql, params = []) {
        const [rows] = await pool.execute(sql, params);
        return rows;
      },
      async end() { await pool.end(); },
    };
  }

  // ---------- SQLite ----------
  if (type === 'sqlite') {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(conn.database || conn.filename);
    return {
      type,
      async query(sql, params = []) {
        const stmt = db.prepare(sql);
        return /^\s*select/i.test(sql) ? stmt.all(...params) : [stmt.run(...params)];
      },
      async end() { db.close(); },
    };
  }

  // ---------- MSSQL ----------
  if (type === 'mssql') {
    const mssql = await import('mssql');
    const pool = await mssql.connect({
      server:   conn.host     || '127.0.0.1',
      port:     parseInt(conn.port) || 1433,
      user:     conn.user     || conn.username,
      password: conn.password || conn.pass,
      database: conn.database || conn.db,
      options:  { encrypt: false, trustServerCertificate: true },
    });
    return {
      type,
      async query(sql, params = []) {
        const request = pool.request();
        let idx = 0;
        // MSSQL 占位符用 @p1 @p2，输入时转换
        const converted = sql.replace(/\?/g, () => {
          const name = `p${++idx}`;
          request.input(name, params[idx - 1]);
          return `@${name}`;
        });
        const result = await request.query(converted);
        return result.recordset;
      },
      async end() { await pool.close(); },
    };
  }
}

// ============================================================
// 构建 WHERE 子句（参数化）
//
// args 支持数组或对象两种格式：
//   数组: [字段, 操作符, 值, 逻辑符]
//   对象: { field, operator, value, logic }
//
// 操作符: = != > >= < <= like not like in not in between is null is not null
// 逻辑符: and / or
//
// 返回: { where: 'WHERE ...', params: [] }
//   pg  → 占位符 $1 $2 $3 ...
//   其他 → 占位符 ? ? ? ...
// ============================================================

function buildWhere(args, type) {
  if (!Array.isArray(args) || args.length === 0) {
    return { where: '', params: [] };
  }

  const isPg    = type === 'pg';
  const clauses = [];
  const params  = [];
  let   pgIdx   = 1;

  const placeholder = () => isPg ? `$${pgIdx++}` : '?';

  args.forEach((item, idx) => {
    let field, operator, value, logic;
    if (Array.isArray(item)) {
      [field, operator, value, logic] = item;
    } else {
      ({ field, operator, value, logic } = item);
    }

    const op   = String(operator || '=').toLowerCase().trim();
    const glue = idx === 0 ? '' : (String(logic || 'and').toLowerCase() === 'or' ? 'OR' : 'AND');

    let expr;

    if (op === 'is null') {
      expr = `"${field}" IS NULL`;

    } else if (op === 'is not null') {
      expr = `"${field}" IS NOT NULL`;

    } else if (op === 'in' || op === 'not in') {
      const vals = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim());
      const phs  = vals.map(() => placeholder()).join(', ');
      params.push(...vals);
      expr = `"${field}" ${op.toUpperCase()} (${phs})`;

    } else if (op === 'between') {
      const [min, max] = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim());
      const p1 = placeholder();
      const p2 = placeholder();
      params.push(min, max);
      expr = `"${field}" BETWEEN ${p1} AND ${p2}`;

    } else if (op === 'like' || op === 'not like') {
      const p = placeholder();
      params.push(`%${value}%`);
      expr = `"${field}" ${op.toUpperCase()} ${p}`;

    } else {
      const p = placeholder();
      params.push(value);
      expr = `"${field}" ${op} ${p}`;
    }

    clauses.push(glue ? `${glue} ${expr}` : expr);
  });

  return {
    where: `WHERE ${clauses.join(' ')}`,
    params,
  };
}

// ============================================================
// POST /tables
// 返回 cx_entity 表中所有 数据
// ============================================================
app.post('/tables', async (req, res) => {
  const { dbType, conn } = req.body;

  if (!dbType || !conn) {
    return res.status(400).json({ success: false, error: '缺少 dbType 或 conn 参数' });
  }

  let client;
  try {
    client = await createClient(dbType, conn);
    const rows = await client.query('SELECT * FROM cx_entity ORDER BY id asc;');
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (client) await client.end();
  }
});

// ============================================================
// POST /tableCols
// 返回表的所有列信息
// ============================================================
app.post('/tablecols', async (req, res) => {
  const { dbType, conn, tableName } = req.body;
  if (!dbType || !conn || !tableName) {
    return res.status(400).json({ success: false, error: '缺少 dbType、conn 或 tableName 参数' });
  }
  let client;
  try {
    client = await createClient(dbType, conn);
    const rows = await client.query(`SELECT * FROM cx_fld WHERE tabname = '${tableName}' ORDER BY id ASC;`);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (client) await client.end();
  }
});

// ============================================================
// POST /query
// 执行条件查询，支持字段选择、WHERE、ORDER BY、分页
//
// Body 示例：
// {
//   "dbType": "pg",
//   "conn": { "host": "127.0.0.1", "port": 5432, "user": "admin", "password": "123456", "database": "mydb" },
//   "table": "user_basic",
//   "fields": ["id", "name", "email"],
//   "args": [
//     ["status", "in",      "1,2,3", "and"],
//     ["name",   "like",    "张",    "and"],
//     ["deleted_at", "is null", null, "and"]
//   ],
//   "orderBy": [{ "field": "created_at", "direction": "desc" }],
//   "limit": 20,
//   "offset": 0
// }
// ============================================================
app.post('/query', async (req, res) => {
  const {
    dbType,
    conn,
    table,
    fields,
    args    = [],
    orderBy = [],
    limit   = 20,
    offset  = 0,
  } = req.body;

  if (!dbType) return res.status(400).json({ success: false, error: '缺少 dbType' });
  if (!conn)   return res.status(400).json({ success: false, error: '缺少 conn' });
  if (!table)  return res.status(400).json({ success: false, error: '缺少 table' });

  const safeLimit  = Math.min(Math.max(parseInt(limit)  || 20, 1), 5000);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  let client;
  try {
    client = await createClient(dbType, conn);
    const { type } = client;

    // SELECT 字段
    const selectFields = Array.isArray(fields) && fields.length > 0
      ? fields.map(f => `"${f}"`).join(', ')
      : '*';

    // WHERE（先基于当前已有 params 长度生成占位符）
    const { where, params: whereParams } = buildWhere(args, type);

    // COUNT 查询用独立 params
    const countParams = [...whereParams];

    // ORDER BY
    const orderClause = Array.isArray(orderBy) && orderBy.length > 0
      ? 'ORDER BY ' + orderBy.map(({ field, direction }) =>
          `"${field}" ${direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`
        ).join(', ')
      : '';

    // LIMIT / OFFSET
    let dataParams, limitClause;
    if (type === 'pg') {
      const li = whereParams.length + 1;
      const oi = whereParams.length + 2;
      limitClause = `LIMIT $${li} OFFSET $${oi}`;
      dataParams  = [...whereParams, safeLimit, safeOffset];
    } else {
      limitClause = 'LIMIT ? OFFSET ?';
      dataParams  = [...whereParams, safeLimit, safeOffset];
    }

    const dataSql  = [`SELECT ${selectFields} FROM "${table}"`, where, orderClause, limitClause]
      .filter(Boolean).join(' ');
    const countSql = [`SELECT COUNT(*) AS total FROM "${table}"`, where]
      .filter(Boolean).join(' ');

    const [rows, countRows] = await Promise.all([
      client.query(dataSql,  dataParams),
      client.query(countSql, countParams),
    ]);

    const total = parseInt(
      countRows[0]?.total ?? countRows[0]?.['count(*)'] ?? countRows[0]?.['COUNT(*)'] ?? 0
    );

    res.json({
      success: true,
      data: { table, rows, total, count: rows.length, limit: safeLimit, offset: safeOffset },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (client) await client.end();
  }
});

// ============================================================
// 启动
// ============================================================
const PORT = process.env.PORT || 18090;
app.listen(PORT, () => {
  console.log(`✅ Dify SQL Tool 启动: http://localhost:${PORT}`);
});
