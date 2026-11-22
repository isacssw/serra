# Rate limits planning, 2026-11-21

_Fake meeting for Serra's evals: every person and company is invented._

**Ana:** So the burst limit. Right now it's 200 per merchant and the gateway is struggling at peak.
**Bo:** The load test last week fell over at about 160 sustained bursts across the big merchants.
**Robin:** Then 200 was a mistake. We lower the burst limit to 150 requests per merchant, for everyone.
**Ana:** Including enterprise?
**Robin:** Including enterprise, for now. We can raise individual merchants after a load test, as before.
**Bo:** Okay, 150 for all merchants. I'll change the gateway config by December 1.
**Ana:** Second thing: our 429s don't tell clients when to retry. The SDKs just guess.
**Robin:** Every 429 response includes a Retry-After header. That's the decision.
**Bo:** Yes, easy to add in the gateway.
**Ana:** And should the sandbox share limits with production? Today a noisy test can eat a merchant's production quota.
**Robin:** No. Sandbox traffic never counts against production rate limits. They're separate buckets.
**Bo:** Agreed.
**Ana:** I'll update the SDK retry docs to use Retry-After.
**Bo:** Do we tell the merchants who are above 150 today before we switch? There are maybe ten of them.
**Robin:** Good question, let's check the list first. Okay, that's it, thanks.
