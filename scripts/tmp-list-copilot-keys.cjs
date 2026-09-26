const Database = require('better-sqlite3');
const path = process.env.APPDATA + '\\Code\\User\\globalStorage\\state.vscdb';
const db = new Database(path, { readonly: true });
const all = db.prepare("SELECT key FROM ItemTable WHERE key LIKE '%copilot%'").all();
console.log(all.map((r) => r.key).join('\n'));
db.close();
