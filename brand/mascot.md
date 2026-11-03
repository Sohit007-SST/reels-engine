# Mascot design notes (v1)

Decision: DEC-010 (default applied, owner to confirm). Original character, drawn in SVG; no resemblance to any existing character, brand or real person.

## Concept

- **Working name:** TBD (owner picks; placeholder "Orbit").
- **What it is:** a small, round, friendly space probe with one large lens "eye", two short antenna ears and a soft glow ring. Floats; never walks.
- **Personality:** curious, a bit dramatic, kind. Asks the question the viewer is thinking ("Wait… what?").
- **Role in reels:** optional narrator cut-ins (MascotTalk scene), reaction beats, end-card CTA. Never the subject of factual claims.

## Visual spec

- Body: circle, primary `#5B8CFF` with a lighter top-left highlight; outline 6 px `#0B1020`.
- Eye: large circle, `#F5F7FF` sclera, `#0B1020` pupil, `#FFE066` catch-light.
- Glow ring: `#FFB547` at 40% opacity, slow pulse (2 s).
- Mouth: simple arc/oval driven by audio amplitude (Remotion audio visualization), 4 openness levels.
- Expressions (4): neutral, surprised (eye wide, mouth O), happy (eye squint, arc mouth), thinking (eye looks up-left, flat mouth).
- Blink every 3–5 s (random within range, deterministic per seed).
- Keep inside the safe zone; default placement lower-left above the bottom 20%.

## Rules

- Original SVG only, built in `assets/mascot/` by the render module (T3.2).
- No logos, no text on the body, no clothing referencing real brands.
- Not aimed at children: tone stays adult-curious, not cartoon-babyish.
