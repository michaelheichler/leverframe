import { reserveSummarySpend } from '../../src/context/summary-spend.ts';

const reservation = reserveSummarySpend({
  limitMicros: 900,
  maximumMicros: process.argv[2] === 'compete' ? 900 : 1,
});

process.stdout.write(reservation ? 'reserved\n' : 'denied\n');
