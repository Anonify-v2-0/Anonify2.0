# Redaction presets

A preset is a named set of detectors and categories chosen at upload. It changes
**what is looked for** and nothing else — not how removal works, not how
verification runs, not what the export report records.

Presets are data: `lib/redaction/presets/presets.json`. Adding or narrowing one
is a reviewable diff, and a narrowed search is carried forward everywhere it
matters (the chooser caveat, the editor label, the export report).

For the design rule presets must not violate — never named for a regulation or a
compliance claim — see the "Presets" section of the [README](../README.md).

---

## The five shipped presets

`detectors: null` and `categories: null` mean "no restriction" — every detector
runs and every category is in scope.

### Everything we can detect

The default. Every detector, and the contextual pass unrestricted.

- **Detectors:** all (`null`)
- **Categories:** all (`null`)
- Looks for: email/phone/postal addresses, people's names and
  customer/patient-named organizations, government identifiers, payment cards
  and bank/account numbers, dates of birth and customer/case references,
  credentials and API keys and token-bearing links, faces and signatures in
  images.

### Names and contact details

The things that identify a person directly, and nothing else.

- **Detectors:** `email-address`, `phone-number`, `street-address`
- **Categories:** `person`, `address`, `phone`, `email`, `face`
- Looks for: people's names, email addresses and telephone numbers, postal and
  street addresses, faces and signatures in images.

### Identifiers and dates

Reference numbers and dates that pin a record to a person.

- **Detectors:** `us-social-security`, `labelled-reference`,
  `labelled-date-of-birth`
- **Categories:** `government-id`, `customer-id`, `date-of-birth`
- Looks for: government identifiers (e.g. Social Security numbers), customer /
  client / member / policy / case / patient references, dates labelled as a date
  of birth.

### Payment and account numbers

Money: cards, bank accounts, and the numbers that reach them.

- **Detectors:** `payment-card`, `iban`, `labelled-account-number`
- **Categories:** `financial`, `bank-account`
- Looks for: Luhn-valid payment card numbers, IBANs, numbers labelled as an
  account or sort code, financial facts tied to a named party.

### Credentials and keys

What leaks out of engineering documents: secrets and private links.

- **Detectors:** `credential`, `link-with-token`
- **Categories:** `api-key`, `url`, `confidential`
- Looks for: API keys, tokens and provider credential formats, links carrying a
  token / invite / reset path, text marked confidential or internal.
