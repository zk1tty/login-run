function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLabel(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[:*]+$/g, '')
    .trim();
}

function pickFieldValue(lines, labelVariants) {
  const normalizedLines = Array.isArray(lines)
    ? lines.map(item => normalizeText(item)).filter(Boolean)
    : [];
  const normalizedVariants = labelVariants.map(item => normalizeLabel(item));

  for (let index = 0; index < normalizedLines.length; index += 1) {
    const line = normalizedLines[index];
    const normalizedLine = normalizeLabel(line);

    for (const variant of normalizedVariants) {
      if (normalizedLine === variant) {
        for (let cursor = index + 1; cursor < normalizedLines.length; cursor += 1) {
          const nextLine = normalizedLines[cursor];
          if (normalizeLabel(nextLine) === variant) {
            continue;
          }
          return nextLine;
        }
      }

      if (normalizedLine.startsWith(`${variant} `)) {
        return line.slice(variant.length).trim();
      }

      if (normalizedLine.startsWith(`${variant}:`)) {
        return line.slice(variant.length + 1).trim();
      }
    }
  }

  return '';
}

function mergeField(primaryValue, fallbackValue) {
  return normalizeText(primaryValue || fallbackValue || '');
}

function countNonEmptyValues(obj) {
  return Object.values(obj || {}).filter(value => normalizeText(value)).length;
}

function mapHsaExtractionSnapshot(snapshot = {}) {
  const profileLines = Array.isArray(snapshot.profileLines) ? snapshot.profileLines : [];
  const accountLines = Array.isArray(snapshot.accountLines) ? snapshot.accountLines : [];
  const allLines = Array.isArray(snapshot.allLines) ? snapshot.allLines : [];

  const profile = {
    fullName: mergeField(
      pickFieldValue(profileLines, ['Full Name', 'Name']),
      pickFieldValue(allLines, ['Full Name', 'Name'])
    ),
    email: mergeField(
      pickFieldValue(profileLines, ['Email']),
      pickFieldValue(allLines, ['Email'])
    ),
    phone: mergeField(
      pickFieldValue(profileLines, ['Phone']),
      pickFieldValue(allLines, ['Phone'])
    ),
    address: mergeField(
      pickFieldValue(profileLines, ['Address']),
      pickFieldValue(allLines, ['Address'])
    ),
  };

  const account = {
    cashBalance: mergeField(
      pickFieldValue(accountLines, ['Cash Balance']),
      pickFieldValue(allLines, ['Cash Balance'])
    ),
    investmentBalance: mergeField(
      pickFieldValue(accountLines, ['Investment Balance']),
      pickFieldValue(allLines, ['Investment Balance'])
    ),
    contributionLimit: mergeField(
      pickFieldValue(accountLines, ['Contribution Limit']),
      pickFieldValue(allLines, ['Contribution Limit'])
    ),
    contributedToDate: mergeField(
      pickFieldValue(accountLines, ['Contributed To Date']),
      pickFieldValue(allLines, ['Contributed To Date'])
    ),
    openedDate: mergeField(
      pickFieldValue(accountLines, ['Opened Date']),
      pickFieldValue(allLines, ['Opened Date'])
    ),
    routingNumber: mergeField(
      pickFieldValue(accountLines, ['Routing Number']),
      pickFieldValue(allLines, ['Routing Number'])
    ),
    accountNumberMasked: mergeField(
      pickFieldValue(accountLines, ['Account Number']),
      pickFieldValue(allLines, ['Account Number'])
    ),
  };

  const profileFieldsFound = countNonEmptyValues(profile);
  const accountFieldsFound = countNonEmptyValues(account);
  const nonEmptyFieldCount = profileFieldsFound + accountFieldsFound;

  return {
    profile,
    account,
    meta: {
      url: normalizeText(snapshot.url),
      title: normalizeText(snapshot.title),
      capturedAt: normalizeText(snapshot.capturedAt),
      source: 'live_dom',
    },
    completeness: {
      profileFieldsFound,
      accountFieldsFound,
      nonEmptyFieldCount,
      hasData: nonEmptyFieldCount > 0,
    },
    reason:
      nonEmptyFieldCount > 0
        ? ''
        : 'No HSA profile/account fields were detected from the live portal DOM.',
  };
}

module.exports = {
  mapHsaExtractionSnapshot,
};
