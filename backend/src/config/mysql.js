const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// mysql2's timezone option controls JavaScript Date conversion; it does not
// change MySQL's session time_zone. The pool emits `connection` before
// `acquire` and before returning a new connection to its caller, so queue this
// initialization statement before application commands can be queued.
pool.on('connection', connection => {
    const discardUninitializedConnection = () => {
        try {
            connection.destroy();
        } catch {
            // The connection must not be reused even if cleanup itself errors.
        }
        console.error('[NeuroLearn] MySQL UTC session initialization failed; connection discarded.');
    };

    try {
        connection.query("SET time_zone = '+00:00'", error => {
            if (error) discardUninitializedConnection();
        });
    } catch {
        discardUninitializedConnection();
    }
});

module.exports = pool;
