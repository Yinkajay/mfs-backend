# Service catalogue source notes

The catalogue contains the 18 service names transcribed in the backend blueprint plus the subsequently confirmed **Police Report and Affidavit** service. Source-facing names are preserved in the seed; descriptions remain unset until MFS provides them.

Confirmed pricing notes for the later pricing slice:

| Service                     | Variant   | Customer price |
| --------------------------- | --------- | -------------: |
| Police Report and Affidavit | Universal |         ₦6,500 |
| New Driver’s Licence        | 3 years   |        ₦50,000 |
| New Driver’s Licence        | 5 years   |        ₦55,000 |
| Renewal of Driver’s Licence | 3 years   |        ₦30,000 |
| Renewal of Driver’s Licence | 5 years   |        ₦35,000 |

These values are notes and resolver fixtures, not active database rules. Their effective dates are still undecided, so the catalogue endpoints intentionally return no price and the pricing migration seeds no rules. Blank source cells remain unspecified and must not be interpreted as zero or unavailable.
