# Qwakk project instructions

## Product and brand

- Qwakk (formerly Qora) is a simple, fast, non-custodial DEX interface for QoreChain. The product name lives only in `lib/brand.ts`. Internal identifiers (file names, `qora-*` storage keys and events, `QORA_*` environment variables) keep the old prefix so deployments keep working.
- The core message is: "Simple swaps on QoreChain." The slogan is "Swap it. Qwakk it."
- Write in an energetic, playful, pump-style voice that stays honest and trustworthy. Short punchy lines and the duck personality (quacks, waddles, ponds) are welcome in moderation. Never let playfulness blur facts: amounts, fees, risks and transaction status are always stated plainly. Avoid unnecessary crypto jargon and developer-facing language in marketing copy.
- Avoid repeated copy within the same component. A heading, supporting copy and primary button must each add distinct information or intent. Do not repeat the same action label, such as "Send QOR", in more than one of those elements.
- Do not use em dashes anywhere in user-facing copy, metadata or documentation. Use a full stop, comma, colon or parentheses instead.
- Never render untrusted wallet, API or provider error text directly. Convert it to controlled Qwakk copy that follows the no-em-dash rule.
- Qwakk and QoreChain are distinct brands. Use the duck mark (`components/BrandMark.tsx`, `public/brand-mark.svg`) only for Qwakk branding. Each coin and token must use its own official icon. Use `public/qorechain-mark.png` for the native QOR coin, never the Qwakk mark.
- Brand colors: duck yellow `#ffd43b` for the brand and primary actions, beak orange `#ff8a3d` as the secondary accent. Green and red are reserved for gains and losses. CSS tokens live in `app/globals.css` and chart colors in `lib/theme.ts`.
- Display QOR to users. Convert to the native `uqor` denomination only at the API or transaction boundary. QOR has 6 decimals.
- Refer to the connected Diana network as "QoreChain Diana" when the network name must be shown. Do not make testnet language prominent in marketing surfaces.

## Product safeguards

- Never claim that signing, broadcasting, swaps, pool creation or fee collection is live unless it has been implemented and verified with QoreX on QoreChain.
- Do not render an interactive product feature until it truly works end to end. Do not ship placeholders, prepared states or buttons that imply an unavailable on-chain action.
- Non-custodial is mandatory. Do not introduce private-key handling, wallet custody or server-side transaction signing.
- Keep native QoreChain interactions behind server routes where needed to avoid browser CORS issues.
- Every transaction detail link must use `https://explore.qore.network/tx/<hash>`.
- Treat `https://docs.qorechain.io/` and official QoreChain packages as the source of truth for chain integrations. Verify the documented path before implementation.
- Never make a premature technical conclusion about a QoreChain or QoreX capability. First inspect `https://docs.qorechain.io/` and the official QoreChain packages. If the answer is not documented there, inspect the relevant official source code, SDKs, adapters and QoreX integration surfaces to trace the actual implementation before proposing a blocker or asking QoreChain for help.
- Treat QoreX's own working product behaviour as evidence to investigate, not as a reason to assume an integration is unavailable. Reproduce its documented or inspectable transaction path and develop a non-custodial solution from it whenever possible.
- Ask QoreChain only after the public documentation, official packages and available official source have been exhausted, and ask for one precise missing API contract or example rather than a broad feasibility opinion.
- Qwakk's trading and wallet actions must use the QoreChain Native rail. Do not substitute the EVM rail as a workaround for an unavailable Native integration.

## Engineering

- Preserve the existing Next.js/Vinext structure and CapRover deployment setup.
- Do not start a development server unless explicitly asked. The user runs `npm run dev` locally.
- Use `apply_patch` for source edits. Do not overwrite unrelated user changes.
- Run `npm run build` for relevant implementation changes before handing work over.
- Keep shared navigation in `components/QoraHeader.tsx` and keep its layout consistent across pages.

## Git

- Conventional Commits are mandatory for every commit.
- Format: `type(scope): concise imperative summary`.
- Allowed types include `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `build`, `chore` and `perf`.
- Do not create a commit or push unless the user asks for it.
