// Preload for tests that need a cron boundary soon: `bun --preload <this> supervisor/main.ts`
// with TEST_CLOCK_SHIFT_MS set moves Date.now() forward by that many ms in the
// child only, so "* * * * *" fires within seconds instead of up to a minute.
const shift = Number(process.env.TEST_CLOCK_SHIFT_MS ?? "0");
if (Number.isFinite(shift) && shift !== 0) {
  const real = Date.now.bind(Date);
  Date.now = () => real() + shift;
}
