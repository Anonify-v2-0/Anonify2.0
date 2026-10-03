# Why precision is low in these results

> [!NOTE]
> **Both luna models have since been rerun** at `77b8d5e`, after #199, on the
> same 25 documents. Precision rose to **91.5%** for gpt-6-luna and **87.0%**
> for gpt-5.6-luna, with recall of 84.4% and 89.0%. The results files now hold
> the rerun. This note explains the earlier figures. Its causes 2 to 5 still
> apply, and the `customer_ref` column (#202) is now the largest share of the
> false positives left.

The first test-split results (`openai-subscription_gpt-6-luna.json`,
`openai-subscription_gpt-5.6-luna.json`, published in #201) report precision of
**68.9%** for gpt-6-luna and **56.5%** for gpt-5.6-luna, against recall of
85–88%. One in three proposed redactions touches no labelled value.

The number is real for the code it measured, but most of it is not the model
being careless. Every false positive in both files was read against the corpus
text. They come from five causes, and only one of them is the model judging
badly.

| Cause                                                       | gpt-6-luna FPs | gpt-5.6-luna FPs | Fixed by                                           |
| ----------------------------------------------------------- | -------------: | ---------------: | -------------------------------------------------- |
| 1. The model was never told what the categories mean        |            139 |              232 | #199, already merged, but these results predate it |
| 2. The corpus leaves a `customer_ref` column unlabelled     |             49 |               49 | #202                                               |
| 3. The phone pattern matches the tail of a reference number |              5 |                5 | #203                                               |
| Other model judgement                                       |             13 |               33 | —                                                  |
| **All false positives** (deterministic-first)               |        **206** |          **319** |                                                    |

Two more causes do not create false positives but distort the figure: the
sample is small and unrepresentative (4), and the scorer counts occurrences,
not decisions (5).

If cause 1's false positives are removed and cause 2's values are counted as the
real customer references they are, deterministic-first precision is **96.6%**
for gpt-6-luna and **92.4%** for gpt-5.6-luna on the same 25 documents.

Numbers below are for the `deterministic-first` run unless a run is named.

## 1. The results were measured before the category definitions existed

Both files were measured at `5d4c84c` (v1.13.0). The fix for exactly this
problem, #197, merged one commit later as `bf395dc` (#199, v1.14.0), and the
results were published on top of it without being rerun.

Before #199 the detection schema gave the model thirteen category names and
the description "The kind of sensitive information this is", and the default
request asked for "health or financial facts" and "job or role details tied to
an individual". The corpus defines the categories narrowly
(`financial` is a card, a salary, or a specific person's balance or debt;
`confidential` is a codename, an unreleased figure or a trade secret). So:

| Category        | Detections | Precision | What the false positives are                                                                                                                                         |
| --------------- | ---------: | --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confidential`  |         77 |     15.6% | whole sentences of board minutes, a patient's diagnoses and allergies, an employee's appointment schedule, the dates in an HR review log                             |
| `financial`     |         94 |     30.9% | every amount on an invoice or statement, plus phrases such as "completed successfully", "billing dispute", "changed to paid" and "One supplementary power-cost note" |
| `date-of-birth` |         20 |     55.0% | admission and discharge dates, a statement's generation date, a payment due date                                                                                     |

(gpt-6-luna. On gpt-5.6-luna, 68 of `confidential`'s false positives are spans
of four words or more.)

#199 defines every category once, in `lib/redaction/categories.ts`, with what
each is not, gives health its own `health` category, and leaves `health` out of
precision because the corpus cannot judge it. On the 20-document dev sample it
took precision from 0.68 to 0.89 (gpt-6-luna) and 0.60 to 0.86 (gpt-5.6-luna),
recall unchanged. The test-split files have not been rerun since, and nothing
in them or in `pnpm bench:charts` says they are stale: a results file records
the corpus hash and the commit, and the charts check only the corpus hash.
Tracked in #204.

## 2. Tabular exports with an unlabelled customer reference column

Two of the 25 documents are support-ticket exports with a `customer_ref`
column that the generator never labelled:

- `syn-v1-0022`: `customer_ref` holds `CT-94018`, `CT-11805`, `CT-22900`, … on
  every row. The same customers' `C-94018` references in the prose are
  labelled; the column is not.
- `syn-v1-0033`: `customer_ref` is `C-77104` on all 16 rows, unlabelled, while
  the person it belongs to, their address and phone number are labelled.

Both models flag these, correctly, and the local search extends each to every
row: **49 false positives that are true positives**, 24% of gpt-6-luna's total.
Labelling them alone moves gpt-6-luna from 68.9% to 76.3%.

The generator's checks catch a value labelled once and left bare elsewhere;
they cannot catch a value the model wrote and never labelled at all. The
cross-family validation and the human review that would catch it have not been
run on this corpus yet (the README lists it as "not yet reviewed"). Across the
whole test split the same shape turns up in at least `syn-v1-0152`
(`client_ref`, `CL-700018` …) and possibly `syn-v1-0592`, so it is a handful of
documents, not a systemic flaw. The sample in cause 4 happened to draw two of
them. Tracked in #202.

## 3. The phone pattern matches the tail of a reference number

The last alternative of the `phone-number` pattern in
`lib/redaction/detectors.ts` has no left boundary and accepts a hyphen, so the
digit groups after a reference's prefix match as a phone number:

| Text in the document                | Flagged as phone |
| ----------------------------------- | ---------------- |
| `Ref TXN-0098-4412-7700`            | `0098-4412-7700` |
| `Rechnungsnr.: 7000-4129-8841`      | `7000-4129-8841` |
| `Factura n.º: ES-0048-7712-0906`    | `0048-7712-0906` |
| `Invoice number: INV-000842-710395` | `0842-710395`    |

Across all 395 test documents, the patterns alone
(`benchmarks/results/synthetic-v1-test-patterns.json`) make 50 false phone
detections, and **48 of them are hard negatives** like these: look-alikes the
corpus planted to be missed. The detector's confidence, 0.88, is above
`VERIFY_BELOW` (0.75) in `lib/ai/analyze.ts`, so the model never gets a second
look at them, and the detector is `global`, so one bad match is proposed at
every occurrence (`syn-v1-0036` has eight). This is the only cause here that a
person running Anonify sees directly: invoice and transaction references
proposed as phone numbers. Tracked in #203.

## 4. 25 documents, and the first 25 rather than a sample

The run used `--limit 25`, which takes the first 25 test documents by id
(`syn-v1-0001` to `syn-v1-0035`), out of 395. That is 6% of the split, and not
stratified: it holds five tabular exports and five contracts but no incident
report or support chat, and one medical referral where the split has 33.

False positives are concentrated in a few documents. Three documents hold half
of gpt-6-luna's false positives (`syn-v1-0022` 57, `syn-v1-0005` 24,
`syn-v1-0035` 22), and `syn-v1-0022` alone is 28%. Resampling the 25 documents
gives a 95% interval of **60–80%** for gpt-6-luna's precision and **46–72%** for
gpt-5.6-luna's. The generated Results section says "test split" and gives no
document count or interval next to the headline figures, so it reads as a
measurement of the split. Tracked in #204.

## 5. Precision counts occurrences, and overlapping duplicates

Recall is counted per labelled value; precision is counted per detection. Two
consequences:

- **Expansion multiplies a single wrong call.** When the model marks a value
  `global`, the local search proposes it at every occurrence, and each one is a
  separate false positive. 58 of gpt-6-luna's 206 false positives (72 of
  gpt-5.6-luna's 319) are such copies; `syn-v1-0035`'s review-log dates are six
  model calls and six more copies. Counting each distinct (document, value,
  category) once, gpt-6-luna's precision is 70.8%, not 68.9%.
- **Nested duplicates inflate it.** `dedupeDetections` in
  `lib/redaction/entities.ts` removes only exact duplicates, so `Raman` inside
  `Priya Raman`, or `raman` inside `priya.raman@example.org`, survives as a
  second detection. There are 68 in gpt-6-luna's run, 65 of them over a label,
  so they count as extra correct detections. Without them, precision is 65.8%.

Both are reasonable choices on their own, and the occurrence count is what a
reviewer clicks through. But the two effects pull in opposite directions, the
report shows only the net, and the results record no confidence for any
detection, so nobody can see what precision a confidence threshold would buy.
Tracked in #205.

## What was not a cause

- **Language.** By locale, the English documents score lowest (en-GB 53% for
  gpt-6-luna), not the German, French or Spanish ones; #197 came to the same
  conclusion on the dev split.
- **The patterns.** The deterministic pass is 94% precise on the full test
  split and contributes 5 of gpt-6-luna's 206 false positives.
- **Names.** `person` is 99.2% precise for gpt-6-luna.

## How this was measured

Each run's `records` hold every detection as `[start, end, category]`, and the
corpus working copy (`pnpm corpus:unpack`) holds the text and labels at those
offsets. A detection that overlaps no label is a false positive, as in
`benchmarks/lib/scoring.ts`. Each was read in context and assigned to the first
cause above that explains it. The interval is a percentile bootstrap over the
25 documents, 5,000 resamples.
