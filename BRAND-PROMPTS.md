# Courtly: image prompts

Generate each image, save it with the **exact filename** into `app/public/brand/`, and it appears on the site
automatically. Until a file exists, the dev site shows a dashed box with that filename.

**Paste this style block at the end of every prompt** so the set matches:

> Style: soft 3D claymorphism, matte clay material with subtle fingerprint texture, rounded puffy shapes,
> gentle studio lighting from the top left, soft long shadows, pastel palette only: lime #C8F169,
> sage green #B9E4CF, periwinkle #CBC4F8, peach #FFC9A6, cream #F3EEE6, charcoal accents #23212B.
> Clean, calm, premium, minimal. No text, no letters, no numbers, no logos, no watermark.

Never ask the generator for words. The word "Courtly" is set in the site's font next to the logo.

| File | Size / ratio | Background |
|---|---|---|
| `logo-mark.png` | 1024 × 1024, square | transparent |
| `app-icon.png` | 1024 × 1024, square | solid cream, full bleed |
| `hero.jpg` | 1600 × 1720 (≈ 4 : 4.3, portrait) | scene |
| `how-1.png`, `how-2.png`, `how-3.png` | 1024 × 1024 | transparent |
| `success.png` | 512 × 512 | transparent |
| `empty.png` | 800 × 640 | transparent |
| `og-image.jpg` | 1200 × 630 | scene |

---

### `logo-mark.png`: logo symbol
A single minimal logo symbol: a rounded clay pickleball in lime green with a few neat circular holes,
resting at an angle on a small sage-green clay tile shaped like a mini court seen from above,
with one thin cream line across its middle as the net. Simple, bold silhouette that still reads at
32 pixels. Centered, isolated object, transparent background.

### `app-icon.png`: phone home-screen icon
The same lime clay pickleball and small sage court tile as the logo symbol, centered on a solid cream
#F3EEE6 square background that fills the whole canvas edge to edge. Keep the object inside the middle
70% so phones can crop the corners. No border.

### `hero.jpg`: main hero image (right side of the home page)
A miniature clay diorama of two side-by-side pickleball courts seen from a high three-quarter angle,
one court sage green and one periwinkle, cream boundary lines, small rounded nets, a lime clay ball
mid-bounce, two cute rounded clay paddles leaning on the net, a tiny bench and a small potted plant.
Warm late-afternoon light, cream background fading softly at the edges. Leave calm empty space in the
lower-left corner (a card sits on top of it).

### `how-1.png`: step 1 "Tap an open slot"
A chunky clay smartphone lying at a slight angle, its screen showing a simple grid of soft rounded
tiles in two columns (sage and periwinkle), one tile raised and glowing lime as if just tapped by a
rounded clay fingertip. Isolated object, transparent background.

### `how-2.png`: step 2 "Type your code"
A soft clay envelope, half open, with a small rounded card rising out of it that shows six plain
rounded dots in a row (no numbers), and a little lime clay checkmark badge floating beside it.
Periwinkle and cream tones. Isolated object, transparent background.

### `how-3.png`: step 3 "Show it and play"
A clay ticket stub with a dashed tear line and rounded notches, peach colored, next to a lime
pickleball and a rounded clay paddle, arranged like a small celebratory still life. No writing on
the ticket. Isolated objects, transparent background.

### `success.png`: shown above the booking ticket after confirming
A happy lime clay pickleball with a tiny rounded clay confetti burst around it (sage, periwinkle and
peach pieces), slightly bouncing. Isolated, transparent background.

### `empty.png`: "nothing here" states
A single empty sage clay court tile with a small rounded net, one lime ball resting quietly in the
corner, and a tiny cream cloud floating above. Calm, a little wistful. Isolated, transparent background.

### `og-image.jpg`: link preview when the site is shared
A wide horizontal version of the hero diorama: two clay pickleball courts (sage and periwinkle) on a
cream background, the lime ball and paddles on the right two-thirds, with a large calm empty cream
area on the left third. No text.
