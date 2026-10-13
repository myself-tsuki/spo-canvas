import mysql from 'mysql2/promise';

const SOURCE_CONFIG = {
    host: process.env.SOURCE_DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    port: parseInt(process.env.SOURCE_DB_PORT || '4000'),
    user: process.env.SOURCE_DB_USER || '3jmws3vjSEBzHAs.root',
    password: process.env.SOURCE_DB_PASSWORD || 'yB3MSU7tNyUAh84n',
    database: process.env.SOURCE_DB_NAME || 'test',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 15
};

const TARGET_CONFIG = {
    host: process.env.TARGET_DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    port: parseInt(process.env.TARGET_DB_PORT || '4000'),
    user: process.env.TARGET_DB_USER || 'NJiLRqKxh1QG3am.root',
    password: process.env.TARGET_DB_PASSWORD || 'H6YEFIEODY97QvHQ',
    database: process.env.TARGET_DB_NAME || 'test',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 15
};

const DB_TABLE_SCHEMAS = [
    `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        avatar_url TEXT,
        google_id VARCHAR(255),
        premium INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS songs (
        video_id VARCHAR(500) PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        channel_name VARCHAR(255),
        thumbnail TEXT,
        duration INT,
        album_name VARCHAR(255),
        album_id VARCHAR(255)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS playlists (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        cover_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS playlist_songs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        playlist_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS favorites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        video_id VARCHAR(500) NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS followed_artists (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        browse_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        thumbnail TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function migrateTable(srcPool, dstPool, table) {
    const startTime = Date.now();
    const [[{ count: srcCount }]] = await srcPool.query(`SELECT COUNT(*) as count FROM \`${table}\``);

    if (srcCount === 0) {
        const [[{ count: dstCount }]] = await dstPool.query(`SELECT COUNT(*) as count FROM \`${table}\``);
        return { table, srcCount, dstCount, durationMs: Date.now() - startTime, status: 'MATCH (EMPTY)' };
    }

    const [columnsResult] = await srcPool.query(`SHOW COLUMNS FROM \`${table}\``);
    const columns = columnsResult.map(c => c.Field);
    const colList = columns.map(c => `\`${c}\``).join(', ');

    const BATCH_SIZE = 2000;
    let offset = 0;
    let processed = 0;

    while (offset < srcCount) {
        const [rows] = await srcPool.query(`SELECT * FROM \`${table}\` LIMIT ${BATCH_SIZE} OFFSET ${offset}`);
        if (!rows || rows.length === 0) break;

        // Fast multi-row bulk insert
        const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
        const allPlaceholders = new Array(rows.length).fill(rowPlaceholders).join(', ');
        const bulkInsertSql = `INSERT IGNORE INTO \`${table}\` (${colList}) VALUES ${allPlaceholders}`;

        const flattenedValues = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            for (let j = 0; j < columns.length; j++) {
                flattenedValues.push(row[columns[j]]);
            }
        }

        await dstPool.query(bulkInsertSql, flattenedValues);
        processed += rows.length;
        offset += BATCH_SIZE;
        console.log(`[${table}] Transferred ${processed}/${srcCount} rows...`);
    }

    const [[{ count: dstCount }]] = await dstPool.query(`SELECT COUNT(*) as count FROM \`${table}\``);
    const durationMs = Date.now() - startTime;
    const status = srcCount === dstCount ? 'SUCCESS' : `MISMATCH (src: ${srcCount}, dst: ${dstCount})`;
    console.log(`[${table}] Completed in ${(durationMs / 1000).toFixed(2)}s: ${status}`);

    return { table, srcCount, dstCount, durationMs, status };
}

async function run() {
    console.log('🚀 Starting Ultra-Fast Database Migration...');
    const overallStart = Date.now();

    // Ensure target database exists
    const initTargetConfig = { ...TARGET_CONFIG };
    delete initTargetConfig.database;
    const targetBootstrapConn = await mysql.createConnection(initTargetConfig);
    try {
        await targetBootstrapConn.query(`CREATE DATABASE IF NOT EXISTS \`${TARGET_CONFIG.database}\``);
        console.log(`✅ Ensured target database \`${TARGET_CONFIG.database}\` exists.`);
    } finally {
        await targetBootstrapConn.end();
    }

    const srcPool = mysql.createPool(SOURCE_CONFIG);
    const dstPool = mysql.createPool(TARGET_CONFIG);

    try {
        await Promise.all([
            srcPool.query('SELECT 1'),
            dstPool.query('SELECT 1')
        ]);
        console.log('✅ Connected to both Source and Target databases.');

        // Initialize target schema
        console.log('📋 Verifying schema on target database...');
        for (const sql of DB_TABLE_SCHEMAS) {
            await dstPool.query(sql);
        }

        // Discover all tables from source
        const [tablesResult] = await srcPool.query('SHOW TABLES');
        const dbColName = Object.keys(tablesResult[0])[0];
        const allSrcTables = tablesResult.map(r => r[dbColName]);
        console.log(`Discovered ${allSrcTables.length} tables in source:`, allSrcTables);

        // Ensure missing tables exist
        for (const table of allSrcTables) {
            try {
                const [createTableResult] = await srcPool.query(`SHOW CREATE TABLE \`${table}\``);
                const createSql = createTableResult[0]['Create Table'];
                await dstPool.query(createSql);
            } catch (err) {
                // Ignore if exists
            }
        }

        // Optimize target session for bulk ingestion
        await dstPool.query('SET FOREIGN_KEY_CHECKS = 0');
        await dstPool.query('SET UNIQUE_CHECKS = 0');

        const summary = [];

        // Parallel Phase 1: Independent master tables (users & songs)
        console.log('\n⏩ Phase 1: Migrating base tables (users, songs) in parallel...');
        const phase1Tables = ['users', 'songs'].filter(t => allSrcTables.includes(t));
        const phase1Results = await Promise.all(
            phase1Tables.map(t => migrateTable(srcPool, dstPool, t))
        );
        summary.push(...phase1Results);

        // Parallel Phase 2: Playlists
        if (allSrcTables.includes('playlists')) {
            console.log('\n⏩ Phase 2: Migrating playlists...');
            const pRes = await migrateTable(srcPool, dstPool, 'playlists');
            summary.push(pRes);
        }

        // Parallel Phase 3: Dependent / join tables in parallel
        console.log('\n⏩ Phase 3: Migrating dependent & remaining tables in parallel...');
        const phase3Tables = allSrcTables.filter(t => !['users', 'songs', 'playlists'].includes(t));
        const phase3Results = await Promise.all(
            phase3Tables.map(t => migrateTable(srcPool, dstPool, t))
        );
        summary.push(...phase3Results);

        await dstPool.query('SET FOREIGN_KEY_CHECKS = 1');
        await dstPool.query('SET UNIQUE_CHECKS = 1');

        const totalTime = ((Date.now() - overallStart) / 1000).toFixed(2);
        console.log(`\n🎉 Migration completed in ${totalTime}s!\n`);
        console.table(summary);

        const hasFailure = summary.some(s => s.status.startsWith('MISMATCH'));
        if (hasFailure) {
            throw new Error('One or more tables had record mismatches');
        }
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await srcPool.end();
        await dstPool.end();
    }
}

run();
