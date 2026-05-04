const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapHsaExtractionSnapshot,
} = require('../src/sites/heq/hsa/heq-hsa-extractor');

test('maps profile/account fields from section lines', () => {
  const result = mapHsaExtractionSnapshot({
    url: 'https://member.my.healthequity.com/',
    title: 'Member Portal',
    capturedAt: '2026-04-26T20:00:00.000Z',
    profileLines: [
      'Profile Info',
      'Full Name',
      'Danny Friday',
      'Email',
      'nessup@gmail.com',
      'Phone',
      '(360)929-6526',
      'Address',
      '5101 E Peach St, Tucson, AZ, 85712',
    ],
    accountLines: [
      'Account Info',
      'Cash Balance',
      '$350.64',
      'Investment Balance',
      '$0',
      'Contribution Limit',
      '$4400',
      'Contributed To Date',
      '$0',
      'Opened Date',
      '2023-10-01',
      'Routing Number',
      '121000248',
      'Account Number',
      '••••••••6478',
    ],
  });

  assert.equal(result.profile.fullName, 'Danny Friday');
  assert.equal(result.profile.email, 'nessup@gmail.com');
  assert.equal(result.account.cashBalance, '$350.64');
  assert.equal(result.account.routingNumber, '121000248');
  assert.equal(result.account.accountNumberMasked, '••••••••6478');
  assert.equal(result.meta.source, 'live_dom');
  assert.equal(result.completeness.hasData, true);
  assert.equal(result.completeness.nonEmptyFieldCount > 4, true);
});

test('returns empty-data reason when no known fields are found', () => {
  const result = mapHsaExtractionSnapshot({
    url: 'https://member.my.healthequity.com/',
    title: 'Member Portal',
    capturedAt: '2026-04-26T20:00:00.000Z',
    profileLines: ['Profile Info'],
    accountLines: ['Account Info'],
  });

  assert.equal(result.completeness.hasData, false);
  assert.equal(result.completeness.nonEmptyFieldCount, 0);
  assert.equal(
    result.reason,
    'No HSA profile/account fields were detected from the live portal DOM.'
  );
});
