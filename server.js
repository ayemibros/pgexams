/** Entry point: `npm start` (or `node server.js`). Serves on HOST:PORT (default 0.0.0.0:8000). */
const config = require('./src/config');
const { createApp } = require('./src/app');
const { migrate } = require('./scripts/migrate');

async function main() {
  // Like the Procfile's `manage.py migrate` before start: make sure the schema exists.
  await migrate({ quiet: true });
  const app = createApp();
  const onListen = () => {
    console.log(typeof config.PORT === 'number'
      ? `CBT UI (Node.js) running on http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}/`
      : `CBT UI (Node.js) running on ${config.PORT}`);
    console.log(`Database: ${config.DB.user}@${config.DB.host}:${config.DB.port}/${config.DB.database}  ·  DEBUG=${config.DEBUG}  ·  ONLINE_MODE=${config.ONLINE_MODE}${config.PAYMENT_SIMULATION ? '  ·  PAYMENT_SIMULATION on' : ''}`);
  };
  // A named pipe (IIS) takes no host argument.
  if (typeof config.PORT === 'number') app.listen(config.PORT, config.HOST, onListen);
  else app.listen(config.PORT, onListen);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
