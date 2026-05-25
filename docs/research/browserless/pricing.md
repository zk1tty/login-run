## Browserless Pricing Notes

This document captures the pricing assumptions for the HealthEquity retrieval
workflow using Browserless persistent sessions, residential proxy, and CAPTCHA
solving.

### Unit Rules

Browserless usage is counted in units. For this workflow, the relevant unit
drivers are:

| Usage type | Unit rule |
| --- | --- |
| Browser time | 1 unit per 30 seconds of connected browser runtime |
| Residential proxy | 6 units per MB transferred |
| CAPTCHA solving | 10 units per successful CAPTCHA solve |

Per retrieval:

```text
retrieval_units =
  ceil(connected_browser_seconds / 30)
  + residential_proxy_mb * 6
  + successful_captcha_solves * 10
```

Monthly estimate:

```text
monthly_units =
  user_count
  * retrievals_per_user_per_month
  * (
      ceil(avg_connected_browser_seconds / 30)
      + avg_residential_proxy_mb * 6
      + avg_successful_captcha_solves * 10
    )
```

For connected browser runtime:

```text
1 minute = 2 units
3 minutes = 6 units
5 minutes = 10 units
10 minutes = 20 units
30 minutes = 60 units
```

### Plan Assumptions

Current plan assumptions from the pricing page/screenshot:

| Plan | Monthly price | Included units | Displayed max concurrency | Persisted session/log storage |
| --- | ---: | ---: | ---: | --- |
| Prototyping | $35/month | 20k | 5 | 7 days |
| Starter | $200/month | 180k | 30 | 30 days |
| Scale | $500/month | 500k | 80 | 90 days |

### Current Findings

#### Detached `processKeepAlive` Time

Our Puppeteer keep-alive probe data suggests Browserless time units are counted
for active Puppeteer connection windows, not for detached `processKeepAlive`
windows.

On `2026-05-23`, probe logs showed 9 active Puppeteer connection windows
totaling about `245.653` seconds. Counting each run as
`ceil(runtime seconds / 30)` gives:

```text
2 + 4 + 1 + 1 + 1 + 2 + 1 + 1 + 1 = 14 time units
```

The Browserless metrics export for that same day reported:

```json
{ "timeUnits": 14 }
```

If detached `processKeepAlive=1800000` had been billed as browser runtime, the
same day would have included many more time units.

#### Concurrency Behavior

The dashboard shows `Concurrency Limit: 5`, but empirical Session API tests
showed:

```text
10 active Puppeteer-connected Browserless sessions held for 5 minutes: success
100 detached processKeepAlive sessions created and reconnected: success
10 detached residential-proxy processKeepAlive sessions with screenshots/HTML: success
```

The exported metrics still reported `maxConcurrentSessions: 1` for those days.
This suggests Browserless' displayed concurrency metric is not counting detached
`processKeepAlive` browser processes, and may not count this Session API/CDP
path the way we initially expected. This must be confirmed with Browserless
before relying on it contractually.

#### Proxy and CAPTCHA Metrics Export

From `/Users/norikakizawa/Downloads/metrics-1779664738074.json`:

| Day | Time Units | Proxy Units | Proxy MB | CAPTCHA Units | CAPTCHA Solves |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-05-24 | 403 | 46 | 7.67 | 0 | 0 |
| 2026-05-23 | 14 | 256 | 42.67 | 0 | 0 |
| 2026-05-22 | 3 | 80 | 13.33 | 0 | 0 |
| 2026-05-20 | 63 | 1190 | 198.33 | 30 | 3 |
| 2026-05-19 | 6 | 148 | 24.67 | 0 | 0 |
| 2026-05-18 | 9 | 36 | 6.00 | 40 | 4 |

Conversion:

```text
proxy_mb = proxy_units / 6
captcha_solves = captcha_units / 10
```

The `2026-05-20` row is the closest observed HealthEquity-heavy debugging day:

```text
proxyUnits = 1190
proxyMB ~= 198 MB
captchaUnits = 30
captchaSolves = 3
timeUnits = 63
connected runtime ~= 31.5 minutes
```

This is not a clean production retrieval. It likely includes repeated login
attempts, CAPTCHA experiments, OTP retries, screenshots, and extra navigation.
However, it shows that HealthEquity can be much more expensive than the earlier
1-10 MB assumptions.

### Production Estimate Ranges

Until we collect clean one-retrieval deltas, use these ranges:

| Scenario | Avg connected time | Avg proxy MB | Avg CAPTCHA solves | Units/user/day |
| --- | ---: | ---: | ---: | ---: |
| Optimistic cached session | 3 min | 20 MB | 0 | 126 |
| Planning baseline | 5 min | 50 MB | 0.25 | 312.5 |
| Conservative | 10 min | 100 MB | 1 | 630 |
| Bad debug-like day | 30 min | 200 MB | 3 | 1290 |

Formula examples:

```text
Optimistic:
ceil(180 / 30) + 20 * 6 + 0 * 10
= 6 + 120
= 126 units/user/day

Planning baseline:
ceil(300 / 30) + 50 * 6 + 0.25 * 10
= 10 + 300 + 2.5
= 312.5 units/user/day

Conservative:
ceil(600 / 30) + 100 * 6 + 1 * 10
= 20 + 600 + 10
= 630 units/user/day
```

### 100-User Monthly Estimates

Assume one retrieval per user per day and 30 retrievals per month:

| Scenario | Monthly units | Plan fit |
| --- | ---: | --- |
| Optimistic cached session | 378,000 | Above Starter, within Scale |
| Planning baseline | 937,500 | Above Scale |
| Conservative | 1,890,000 | Enterprise/custom |
| Bad debug-like day | 3,870,000 | Enterprise/custom |

Details:

```text
Optimistic:
100 users * 30 days * 126 = 378,000 units/month

Planning baseline:
100 users * 30 days * 312.5 = 937,500 units/month

Conservative:
100 users * 30 days * 630 = 1,890,000 units/month
```

Residential proxy dominates the pricing once HealthEquity traffic is above
roughly 20 MB per retrieval. Browser time is no longer the primary cost driver
unless the workflow waits connected for OTP, debugging, or retries.

### What To Measure Next

Run clean, controlled HealthEquity retrieval attempts and compare Browserless
metric deltas before and after each attempt.

Minimum measurement fields:

```text
connected browser seconds
proxy units delta
proxy MB = proxy units delta / 6
captcha units delta
captcha solves = captcha units delta / 10
terminal outcome: authed / OTP / CAPTCHA / error
whether the run used an existing processKeepAlive session
```

The target is to replace the current planning baseline with a measured median
and p90:

```text
avg_connected_browser_seconds
avg_residential_proxy_mb
avg_successful_captcha_solves
p90_connected_browser_seconds
p90_residential_proxy_mb
p90_successful_captcha_solves
```

### Recommendation

The previous Starter-plan estimate was too optimistic because it assumed only
1-10 MB of proxy traffic per user per day. The exported metrics show real
HealthEquity/debugging usage can reach tens or hundreds of MB.

For 100 users:

| Requirement | Recommended approach |
| --- | --- |
| Validate cost before plan choice | Run clean one-retrieval metric delta tests |
| Proxy MB stays near 20 MB/retrieval | Scale may be enough |
| Proxy MB is near 50 MB/retrieval | Negotiate custom/Enterprise units |
| Proxy MB is near 100+ MB/retrieval | Enterprise/custom or self-host + external proxy pricing |
| Need contractual confidence on processKeepAlive | Ask Browserless to confirm time/concurrency accounting |

### Negotiation Points

Ask Browserless to confirm these points explicitly:

1. Detached `processKeepAlive` time after Puppeteer `browser.disconnect()` does
   not bill as browser runtime units.
2. Detached `processKeepAlive` sessions do not count against displayed max
   concurrency.
3. How `maxConcurrentSessions` is defined for Session API + CDP reconnects,
   since our tests kept 10 active sessions for 5 minutes while metrics reported
   `maxConcurrentSessions: 1`.
4. Maximum practical number of detached persisted sessions per account.
5. Whether proxy units are charged only for transferred bytes during active
   page/network activity, and whether detached pages can generate background
   proxy traffic.
6. Enterprise/custom unit pricing for 100 users if average proxy traffic is
   20 MB, 50 MB, or 100 MB per retrieval.
