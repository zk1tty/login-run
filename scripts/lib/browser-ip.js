function parseIpFromText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const direct =
        String(parsed.origin || parsed.ip || parsed.address || '').trim();
      if (direct) {
        // httpbin can return a comma-separated chain.
        return direct.split(',')[0].trim();
      }
    }
  } catch (error) {
    // Fall through to regex parsing.
  }

  // IPv4 (first match)
  const ipv4 = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (ipv4) {
    return ipv4[0];
  }

  // IPv6 (best-effort)
  const ipv6 = text.match(/\b(?:[A-Fa-f0-9]{1,4}:){2,}[A-Fa-f0-9]{1,4}\b/);
  if (ipv6) {
    return ipv6[0];
  }

  return '';
}

async function detectBrowserIp(context) {
  const probeUrl = String(process.env.BROWSER_IP_CHECK_URL || 'https://httpbin.io/ip').trim();
  const timeoutMs = Number(process.env.BROWSER_IP_CHECK_TIMEOUT_MS || 15000);
  const page = await context.newPage();

  try {
    await page.goto(probeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
    });
    const bodyText = await page.textContent('body');
    const ipAddress = parseIpFromText(bodyText);
    return {
      probeUrl,
      ipAddress,
      raw: String(bodyText || '').trim(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  detectBrowserIp,
};
