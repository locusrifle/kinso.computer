// Run in the foreground under dev_server. An isolated review, not the installed product.
import { kinsoLaunch } from '../locker/test/fixtures/kinso-launch.mjs';
const preview = await kinsoLaunch({ port: Number(process.env.PORT || 4339) });
console.log(`Kinso fixture preview: ${preview.url}`);
console.log('Isolated transports; no real inbox, model calls, payment or mail.');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true;
  await preview.close(); process.exit(0);
});
