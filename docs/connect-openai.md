# Connecting Anonify to OpenAI

The contextual detection pass can use OpenAI in two ways. Both are set up from
the command line with `pnpm ai`.

| | API key | ChatGPT subscription |
| --- | --- | --- |
| `AI_PROVIDER` | `openai` | `openai-subscription` |
| Credential | `OPENAI_API_KEY` in `.env` | A sign-in, sealed in the database |
| Billed | Per token, to your OpenAI API account | Against your ChatGPT plan's usage limits |
| Supported by OpenAI for this use | Yes | Not documented; see [the caveat](#the-caveat) |
| Recommended for | Anything deployed or shared | Trying Anonify on your own machine |

**If in doubt, use an API key.** The rest of this page covers both routes, then
how to check, switch and troubleshoot.

Everything here assumes Anonify is already installed (`pnpm setup`), and that
you run the commands from the repository root, where the `.env` is.

---

## Option A: an OpenAI API key

1. Create a key at <https://platform.openai.com/api-keys>.
2. Put it in `.env`:

   ```dotenv
   OPENAI_API_KEY=sk-...
   ```

   Or run `pnpm setup`, choose **OpenAI**, and paste it when asked. Setup does
   not echo it.
3. Choose and verify a model:

   ```bash
   pnpm ai verify --provider openai
   ```

   When no OpenAI model is configured yet, this lists the models your key can
   use and lets you search them. If one is already configured, it checks that
   model again instead. Either way, the model is verified with two small
   synthetic requests, a structured-output check and an image check. Those two
   requests are billed to your account like any others. No document is sent.

   To choose a particular model, name it:

   ```bash
   pnpm ai verify --provider openai --model <model id>
   ```

4. Restart the app so it reads the new settings: stop and rerun `pnpm dev`,
   or run `docker compose up -d`.

`verify` writes three lines to `.env` and leaves everything else alone:

```dotenv
AI_PROVIDER=openai
AI_MODEL=<model id>
AI_MODEL_CAPABILITIES='{"target":"[\"openai\",\"<model id>\",...]","structuredOutput":true,"vision":true}'
```

`AI_MODEL_CAPABILITIES` records what was verified, and for which provider and
model. Changing either one without verifying again turns the contextual pass
off, visibly, until you do. Don't edit it by hand.

For prices and a daily spend cap, see
[Prices and limits](ai-providers.md#prices-and-limits). Usage rows for this
provider are keyed `openai:<model id>`.

---

## Option B: sign in with a ChatGPT subscription

### The caveat

OpenAI does not offer other applications a supported way to use a ChatGPT plan
for API-style requests. `pnpm ai login` therefore signs in with the public
client OpenAI ships with its own Codex CLI, and sends requests to the backend
Codex uses. Several other open-source tools do the same.

- Whether a ChatGPT plan may be used this way is for **OpenAI's terms** to say,
  not this project, and those terms can change.
- The backend is not a documented API. It can change or start refusing
  requests without notice.
- Requests use your plan's usage limits, shared with your own use of ChatGPT
  and Codex.

The command prints this caveat every time. **For a deployed or shared
instance, use an API key (Option A).**

There is no equivalent for Claude. Anthropic's terms reserve Claude Free, Pro
and Max sign-in for Anthropic's own apps, so `pnpm ai login --provider
anthropic` explains that and exits. Use `ANTHROPIC_API_KEY` instead.

### Before you start

- **The database must be running and migrated.** The sign-in is stored there,
  not in `.env`. After `pnpm setup --local`, `docker compose up -d` starts
  Postgres, and `.env`'s `DATABASE_URL` already points at it.
- **Run the commands with the same `.env` the app uses.** The token is sealed
  with `ENCRYPTION_KEY`, so the app can only open a token that was sealed with
  its own key. In the standard setup, the app in Docker and the command on the
  host share one `.env`, so this is already true.
- **Port 1455 should be free.** It is the one address OpenAI sends the browser
  back to. If something else is using it, the paste method below still works.

### 1. Sign in

```bash
pnpm ai login --provider openai
```

The command prints the caveat and a sign-in link. What happens next depends on
where you run it.

**On a machine with a browser,** the link opens by itself. Sign in to ChatGPT
and approve. The browser lands on a page saying *Signed in. You can close this
tab*, and the terminal carries on without you. Use `--no-browser` if you'd
rather open the link yourself.

**On a server over SSH, or any machine without a browser:**

1. Copy the printed link and open it in a browser on any other machine, such
   as your laptop.
2. Sign in and approve.
3. The browser is sent to `http://localhost:1455/auth/callback?code=...&state=...`
   and shows a connection error. That is expected: nothing on your laptop is
   listening there.
4. Copy the **whole address** from the address bar.
5. Paste it at the terminal's `Redirected address (hidden)` prompt and press
   Enter. The pasted address is not echoed.

A pasted address from a different sign-in attempt is refused. Start again with
a new `pnpm ai login`. The attempt times out after ten minutes.

On success:

```
  ✓ Signed in. The token is sealed in the database and refreshed on use.
  To use it: pnpm ai verify --provider openai-subscription --model <model id>, or pnpm setup.
```

### 2. Choose and verify a model

```bash
pnpm ai verify --provider openai-subscription
```

When no model is configured for it yet, this lists the models your plan
offers, when OpenAI's backend will say. If the list can't be read, choose **Enter a model / deployment ID and
verify it** and type one. Either way, the model is verified before it is
saved, and the result is written to `.env`, as in Option A.

Without a terminal, name the model:

```bash
pnpm ai verify --provider openai-subscription --model <model id>
```

If the model cannot read images, verification fails unless you add
`--text-only`. With it, scanned pages still get OCR, and image-region analysis
is skipped and reported to the reviewer.

### 3. Restart the app

Run `docker compose up -d`, or restart `pnpm dev`. From then on, every model
call asks the database for the token, refreshes it if it expires within a
minute, and writes the new one back. You don't need to sign in again unless
the sign-in is revoked, or you change `ENCRYPTION_KEY`.

### Signing out

```bash
pnpm ai logout --provider openai
```

This deletes the stored token from this instance. It does not revoke it at
OpenAI, where it lapses when it expires. To end it sooner, sign out of other
sessions from your ChatGPT account settings. After logging out, the contextual
pass reports `authorization` until you sign in again or switch provider.

### What is stored, and what never is

- **Stored:** one database row, `Setting` with key `ai.login.openai`,
  containing the access token, refresh token, expiry time and ChatGPT
  workspace ID. All four are encrypted together with `ENCRYPTION_KEY`
  (AES-256-GCM).
- **Never stored in `.env`:** the token. `.env` holds only which provider
  and model to use.
- **Never printed or logged:** the tokens, the authorization code or the
  `state` value. Errors give an HTTP status, not the provider's response.
- **Never read:** another tool's credentials. Codex CLI's `~/.codex/auth.json`
  is not used. Two tools sharing one refresh token log each other out, so
  Anonify has its own sign-in.

---

## Checking what is in force

```bash
pnpm ai status
```

```
  Provider  ChatGPT subscription (sign in with pnpm ai login) (openai-subscription)
  Model     <model id>
  Usage rows and prices are keyed as openai-subscription:<model id>
  ✓ Verified: structured output and images
  ✓ Signed in; the access token expires in 52 minutes and is refreshed on use
```

`status` never prints a key or a token. For an API key, it says only whether
`OPENAI_API_KEY` is set.

## Switching between them

Run `verify` with the other provider:

```bash
pnpm ai verify --provider openai --model <model id>                # to the API key
pnpm ai verify --provider openai-subscription --model <model id>   # to the subscription
```

Then restart the app. Switching to the API key does not delete the stored
sign-in; `pnpm ai logout --provider openai` does. Historical usage rows keep
their own provider prefix, so estimates for past documents are unaffected.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `Could not read the stored sign-in. Check DATABASE_URL…` | The command cannot reach the database. | Start it (`docker compose up -d`), check `DATABASE_URL` in `.env`, and run `pnpm db:migrate:deploy` on a fresh database. |
| `…cannot be opened with this ENCRYPTION_KEY` | The token was sealed with a different key than the one in `.env`. | Run `pnpm ai login --provider openai` again with the right `.env`. |
| `Port 1455 is in use and there is no terminal to paste into` | Another program, often Codex CLI's own login, holds the callback port, and there is no terminal to paste into. | Close the other program, or run the command in an interactive terminal and use the paste method. |
| `The redirect is not from this sign-in attempt` | The pasted address came from an older or different attempt. | Start a new `pnpm ai login` and paste the address from that attempt. |
| `The sign-in was refused (access_denied)` | You declined in the browser, or the account cannot use this sign-in. | Try again, or use an API key. |
| `Structured-output verification failed` | The model could not be reached, is not available to you, or did not return the required JSON. | Check the model ID. For a subscription, run `pnpm ai status` to confirm you are signed in, then try another model. |
| `Image verification failed` | The model cannot read images. | Choose a vision model, or verify again with `--text-only`. |
| The reviewer sees *"the AI provider rejected this instance's key"* | The sign-in expired and could not be refreshed, or was revoked. For an API key, the key is invalid. | `pnpm ai login --provider openai` again, or replace `OPENAI_API_KEY`. |
| `Not verified for this model and endpoint` in `pnpm ai status` | The provider or model changed after the last verification. | `pnpm ai verify`. |

For every other provider, including local models that need no account, see
[AI providers](ai-providers.md).
