# Superseded results

These are the 100-document runs of `gpt-5.6-luna` and `gpt-6-luna` through a
ChatGPT subscription (#213), measured at `34bacc1`. `pnpm bench:charts` does
not read this folder.

They are set aside, not deleted, because they still answer what they measured.
They predate two changes to what the model is told:

- #212: a doubtful pattern hit is no longer sent to the model as already
  found.
- #214: the verification call is given the category definitions.

Their patterns-first phase is therefore stale: its fingerprint names the old
verification prompt. Rerunning them was not possible: the subscription's usage
limit was reached partway through, and the gateway was not used for OpenAI
models.

With the patterns first, at `34bacc1`:

| Model | Precision | Recall | F1 | Model only, F1 |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.6-luna | 93.3% | 92.1% | 92.7% | 95.3% |
| gpt-6-luna | 94.9% | 89.8% | 92.2% | 94.0% |

Their `customer-id` recall with the patterns first, 77% for both, is mostly
#212's bug. On glm-5.3-flash, fixing it took that figure from 69% to 99%.

To bring them back, move a file up one level and run
`pnpm bench:models --models openai-subscription:<model> --phases deterministic-first --limit 100 --replace`.
