// TEMPORARY: upload as server.js to the site root, open https://pgexams.telifort.com/,
// note the version shown, then delete this file. No dependencies needed.
const http = require('http');

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Node.js version: ${process.version}\nnode:sqlite available: ${(() => { try { require('node:sqlite'); return 'yes'; } catch (_) { return 'no'; } })()}\nPORT given by host: ${process.env.PORT}\n`);
}).listen(process.env.PORT || 3000);
