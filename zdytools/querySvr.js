/**
 * Dify 自定义工具 - 通用 SQL 查询服务
 * 支持 MySQL / PostgreSQL / 人大金仓(KingbaseES) / SQLite / MSSQL
 *
 * 接口：
 *   POST /tables  - 获取表名列表（来自 cx_entity）
 *   POST /query   - 执行 SQL 查询（支持子句手写 + args 条件补充）
 */

import express from 'express';

const app = express();
app.use(express.json());

// ============================================================
// 类型归一化
// ============================================================

function normalizeType(dbType) {
  const t = String(dbType).toLowerCase().trim();
  if (['mysql', 'mysql2'].includes(t))                                               return 'mysql';
  if (['pg', 'postgres', 'postgresql', 'kingbase', 'kb', 'kingbasees'].includes(t))  return 'pg';
  if (['sqlite', 'sqlite3'].includes(t))                                             return 'sqlite';
  if (['mssql', 'sqlserver'].includes(t))                                            return 'mssql';
  throw new Error(`不支持的数据库类型: ${dbType}，支持: mysql / pg / kingbase / sqlite / mssql`);
}

// ============================================================
// 连接工厂
// 统一封装为 { type, query(sql, params), escape(val), end() }
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
      // pg 转义：字符串加单引号并转义内部单引号，数字直接返回
      escape(val) {
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number')           return String(val);
        if (typeof val === 'boolean')          return val ? 'TRUE' : 'FALSE';
        return `'${String(val).replace(/'/g, "''")}'`;
      },
      async end() { await pool.end(); },
    };
  }

  // ---------- MySQL ----------
  if (type === 'mysql') {
    const mysql2 = await import('mysql2/promise');
    const pool = mysql2.createPool({
      host:               conn.host     || '127.0.0.1',
      port:               parseInt(conn.port) || 3306,
      user:               conn.user     || conn.username,
      password:           conn.password || conn.pass,
      database:           conn.database || conn.db,
      waitForConnections: true,
      connectionLimit:    1,
    });
    return {
      type,
      async query(sql, params = []) {
        const [rows] = await pool.execute(sql, params);
        return rows;
      },
      escape(val) {
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number')           return String(val);
        if (typeof val === 'boolean')          return val ? 'TRUE' : 'FALSE';
        // mysql2 转义
        return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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
      escape(val) {
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number')           return String(val);
        if (typeof val === 'boolean')          return val ? '1' : '0';
        return `'${String(val).replace(/'/g, "''")}'`;
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
        const converted = sql.replace(/\?/g, () => {
          const name = `p${++idx}`;
          request.input(name, params[idx - 1]);
          return `@${name}`;
        });
        const result = await request.query(converted);
        return result.recordset;
      },
      escape(val) {
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number')           return String(val);
        if (typeof val === 'boolean')          return val ? '1' : '0';
        return `'${String(val).replace(/'/g, "''")}'`;
      },
      async end() { await pool.close(); },
    };
  }
}

// ============================================================
// 转义手写 where 子句中的值
//
// 支持格式：where 字符串中用 {值} 包裹需要转义的值
// 例如: "name = {张三} AND status = {1}"
// 服务端自动转义为: "name = '张三' AND status = 1"
//
// 如果 where 中没有 {}, 则原样拼入（用户自己保证安全）
// ============================================================

function escapeWhereString(where, escapeFn) {
  if (!where) return '';
  return where.replace(/\{([^}]*)\}/g, (_, val) => {
    // 尝试转为数字
    const num = Number(val);
    if (!isNaN(num) && val.trim() !== '') return escapeFn(num);
    return escapeFn(val);
  });
}

// ============================================================
// 构建 args 参数化 WHERE 片段
//
// args 格式（数组或对象均支持）：
//   数组: [字段, 操作符, 值, 逻辑符]
//   对象: { field, operator, value, logic }
//
// 返回: { clause: 'field = $1 AND ...', params: [...] }
// pg 用 $N，其他用 ?
// ============================================================

function buildArgsClause(args, type, startIdx = 1) {
  if (!Array.isArray(args) || args.length === 0) {
    return { clause: '', params: [] };
  }

  const isPg    = type === 'pg';
  const clauses = [];
  const params  = [];
  let   pgIdx   = startIdx;

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
      params.push(min, max);
      expr = `"${field}" BETWEEN ${placeholder()} AND ${placeholder()}`;
    } else if (op === 'like' || op === 'not like') {
      params.push(`%${value}%`);
      expr = `"${field}" ${op.toUpperCase()} ${placeholder()}`;
    } else {
      params.push(value);
      expr = `"${field}" ${op} ${placeholder()}`;
    }

    clauses.push(glue ? `${glue} ${expr}` : expr);
  });

  return { clause: clauses.join(' '), params };
}

// ============================================================
// 合并 where 字符串 和 args 子句
// 两者都有时用 AND 拼接，都没有时返回空字符串
// ============================================================

function mergeWhere(escapedWhere, argsClause) {
  const parts = [escapedWhere, argsClause].filter(Boolean);
  if (parts.length === 0) return '';
  return `WHERE ${parts.join(' AND ')}`;
}

// ============================================================
// POST /tables
// 返回 cx_entity 表中所有表数据
// ============================================================

app.post('/tables', async (req, res) => {
  const { dbType, conn } = req.body;

  if (!dbType || !conn) {
    return res.status(400).json({ success: false, error: '缺少 dbType 或 conn 参数' });
  }

  let client;
  try {
    client = await createClient(dbType, conn);
    const rows = await client.query('SELECT * FROM cx_entity ORDER BY name');
    res.json({ success: true, data: rows.map(r => r.name) });
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
//
// 支持两种模式，可混用：
//
// 模式一：手写子句（支持 JOIN、复杂表达式）
//   from:    "user_basic u LEFT JOIN dept d ON u.dept_id = d.id"
//   select:  "u.id, u.name, d.dept_name"
//   where:   "u.status = {1} AND u.name LIKE {张}"   ← {} 内的值自动转义
//   groupBy: "d.dept_name"
//   having:  "COUNT(*) > {5}"
//   orderBy: "u.created_at DESC"
//
// 模式二：args 数组条件（自动参数化，可与模式一混用）
//   args: [
//     ["u.deleted_at", "is null", null, "and"],
//     ["u.age", ">", 18, "and"]
//   ]
//
// 两者都传时：where 字符串 AND args 条件 合并
//
// 通用参数：
//   limit:  每页条数，默认 20，最大 5000
//   offset: 偏移量，默认 0
// ============================================================

app.post('/query', async (req, res) => {
  const {
    dbType,
    conn,
    from,
    select  = '*',
    where   = '',
    args    = [],
    groupBy = '',
    having  = '',
    orderBy = '',
    limit   = 20,
    offset  = 0,
  } = req.body;

  if (!dbType) return res.status(400).json({ success: false, error: '缺少 dbType' });
  if (!conn)   return res.status(400).json({ success: false, error: '缺少 conn' });
  if (!from)   return res.status(400).json({ success: false, error: '缺少 from（表名或 JOIN 子句）' });

  const safeLimit  = Math.min(Math.max(parseInt(limit)  || 20, 1), 5000);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  let client;
  try {
    client = await createClient(dbType, conn);
    const { type } = client;

    // 1. 转义手写 where 中的 {值}
    const escapedWhere = escapeWhereString(where, client.escape.bind(client));

    // 2. 构建 args 参数化子句（pg 占位符从 $1 开始）
    const { clause: argsClause, params: argsParams } = buildArgsClause(args, type, 1);

    // 3. 合并 WHERE
    const whereClause = mergeWhere(escapedWhere, argsClause);

    // 4. GROUP BY / HAVING
    const groupClause  = groupBy ? `GROUP BY ${groupBy}` : '';
    const havingClause = having  ? `HAVING ${escapeWhereString(having, client.escape.bind(client))}` : '';

    // 5. ORDER BY
    const orderClause = orderBy ? `ORDER BY ${orderBy}` : '';

    // 6. LIMIT / OFFSET（pg 追加到参数数组末尾）
    let limitClause, dataParams;
    if (type === 'pg') {
      const li = argsParams.length + 1;
      const oi = argsParams.length + 2;
      limitClause = `LIMIT $${li} OFFSET $${oi}`;
      dataParams  = [...argsParams, safeLimit, safeOffset];
    } else {
      limitClause = 'LIMIT ? OFFSET ?';
      dataParams  = [...argsParams, safeLimit, safeOffset];
    }

    // 7. 拼装 SQL
    const dataSql = [
      `SELECT ${select}`,
      `FROM ${from}`,
      whereClause,
      groupClause,
      havingClause,
      orderClause,
      limitClause,
    ].filter(Boolean).join('\n');

    const countSql = [
      `SELECT COUNT(*) AS total`,
      `FROM ${from}`,
      whereClause,
      groupClause,
      havingClause,
    ].filter(Boolean).join('\n');

    const [rows, countRows] = await Promise.all([
      client.query(dataSql,  dataParams),
      client.query(countSql, argsParams),   // count 不带 limit/offset
    ]);

    const total = parseInt(
      countRows[0]?.total ?? countRows[0]?.['count(*)'] ?? countRows[0]?.['COUNT(*)'] ?? 0
    );

    res.json({
      success: true,
      data: {
        from,
        rows,
        total,
        count:  rows.length,
        limit:  safeLimit,
        offset: safeOffset,
        sql:    dataSql,   // 方便调试，生产环境可去掉
      },
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
