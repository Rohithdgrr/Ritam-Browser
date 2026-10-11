---
name: Serene Canvas
colors:
  surface: '#faf9f5'
  surface-dim: '#dbdad6'
  surface-bright: '#faf9f5'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f4f4f0'
  surface-container: '#efeeea'
  surface-container-high: '#e9e8e4'
  surface-container-highest: '#e3e2df'
  on-surface: '#1b1c1a'
  on-surface-variant: '#414844'
  inverse-surface: '#2f312e'
  inverse-on-surface: '#f2f1ed'
  outline: '#727974'
  outline-variant: '#c1c8c3'
  surface-tint: '#446557'
  primary: '#325346'
  on-primary: '#ffffff'
  primary-container: '#4a6b5d'
  on-primary-container: '#c6ead8'
  inverse-primary: '#abcebe'
  secondary: '#526069'
  on-secondary: '#ffffff'
  secondary-container: '#d3e2ec'
  on-secondary-container: '#57656d'
  tertiary: '#3f5048'
  on-tertiary: '#ffffff'
  tertiary-container: '#57685f'
  on-tertiary-container: '#d3e6db'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#c6ebd9'
  primary-fixed-dim: '#abcebe'
  on-primary-fixed: '#002116'
  on-primary-fixed-variant: '#2d4d40'
  secondary-fixed: '#d6e5ef'
  secondary-fixed-dim: '#bac9d3'
  on-secondary-fixed: '#0f1d25'
  on-secondary-fixed-variant: '#3b4951'
  tertiary-fixed: '#d4e7dc'
  tertiary-fixed-dim: '#b8cbc0'
  on-tertiary-fixed: '#0f1f18'
  on-tertiary-fixed-variant: '#3a4a42'
  background: '#faf9f5'
  on-background: '#1b1c1a'
  surface-variant: '#e3e2df'
typography:
  display-lg:
    fontFamily: Newsreader
    fontSize: 44px
    fontWeight: '400'
    lineHeight: 52px
    letterSpacing: -0.02em
  display-lg-mobile:
    fontFamily: Newsreader
    fontSize: 32px
    fontWeight: '400'
    lineHeight: 40px
    letterSpacing: -0.015em
  headline-lg:
    fontFamily: Newsreader
    fontSize: 32px
    fontWeight: '400'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Newsreader
    fontSize: 26px
    fontWeight: '400'
    lineHeight: 34px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Newsreader
    fontSize: 24px
    fontWeight: '400'
    lineHeight: 32px
    letterSpacing: 0em
  headline-sm:
    fontFamily: Newsreader
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 28px
    letterSpacing: 0em
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 17px
    fontWeight: '400'
    lineHeight: 28px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: 0em
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0.005em
  label-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.04em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1.25rem
  gutter-sm: 0.75rem
  margin: 2rem
  margin-sm: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

This design system embodies a meditative, tactile digital sanctuary inspired by traditional paper craft, Japanese wabi-sabi architecture, and editorial restraint. It is crafted specifically for deep, focused browsing, long-form reading, and distraction-free workspace utility.

### Personality & Emotional Resonance
The experience prioritizes intellectual clarity, tranquility, and intentionality over dopamine-driven urgency. Interactions should feel deliberate, quiet, and unobtrusive—like turning an archival book page in morning daylight.

### Design Movement & Aesthetic Form
The system adopts an editorial **Warm Warm-Minimalism** rooted in subtle physical metaphors:
- **Paper Substrates:** Interfaces rely on distinct, unhurried warmth rather than sterile clinical whites.
- **Micro-tactility:** Elements use low-contrast ghost dividers and quiet tonal layering to demarcate space instead of sharp geometric divides or jarring dark borders.
- **Typographic Poise:** Reading comfort takes structural priority over decorative flourishes.

## Colors

The palette draws directly from organic pigments, stone, and aged fibers, providing high legibility without retinal fatigue.

### Palette Architecture
- **Base Canvas (`#FAF9F5`):** A warm, unbleached rice-paper tone functioning as the foundational surface layer.
- **Primary Accent (`#4A6B5D`):** A grounded, desaturated sage green reserved for active focus indicators, confirmed states, primary actions, and reading highlights.
- **Secondary Accent (`#5E6C75`):** A muted mineral slate used for secondary utility actions, tab chrome indicators, and navigational metadata.
- **Tertiary Accent (`#8C9E94`):** A washed mist sage used for subtle active fills, selection backgrounds, and low-priority progress indicators.

### Surface Tiers & Neutral Scales
- **Surface Level 0 (Base Canvas):** `#FAF9F5` (Base browser frame and reader viewport).
- **Surface Level 1 (Panels / Chrome):** `#F4F2EC` (Tab strip, sidebar, settings panels).
- **Surface Level 2 (Floating Popovers / Menus):** `#EDEAE1` (Dropdowns, omnibox suggestions).
- **Borders & Dividers:** `#E2DDD3` at 100% opacity, or `#1A1D1C` at 8% opacity.
- **Text & Content Primary:** `#1E2321` (High-contrast deep forest ink, avoiding harsh `#000000`).
- **Text & Content Muted:** `#68706B` (Secondary metadata, URL paths, and keyboard shortcuts).

## Typography

The type system balances classical book typography with contemporary human-centered utility.

- **Headlines & Editorial Focus (`Newsreader`):** An optical serif optimized for high legibility and quiet literary rhythm. It gives headers, reader-mode titles, and empty-state bookmarks an unhurried, physical presence.
- **UI Structure & Body Prose (`Plus Jakarta Sans`):** Clean, geometric yet warm sans-serif with generous apertures. It handles browser chrome, omnibox input, settings, and dense interface listings without visual fatigue.
- **Vertical Rhythm:** Paragraphs in reader mode must maintain a loose 1.6 to 1.7 line-height ratio, while browser interface labels conform to rigid vertical alignments with tight bounding boxes.

## Layout & Spacing

The layout is structured around an asymmetrical breathing room model. It suppresses dense visual utility bars until hovered or focused, placing primary spatial value on the main web document or active tab content.

### Layout Philosophy
- **Responsive Workspace Grid:** A fluid grid utilizing a 12-column foundation for complex dashboard states (e.g., history, bookmark managers, extensions) and a centered single column (maximum 720px width) for reading modes.
- **Breakpoints:**
  - **Mobile (< 768px):** Minimal bottom navigation bar, collapsed single-layer chrome, horizontal swipe tabs, `margin-sm` canvas margins.
  - **Tablet (768px - 1024px):** Collapsible vertical rail sidebar, integrated omnibox header.
  - **Desktop (> 1024px):** Persistent or auto-hiding side shelf, spacious tab strip, generous `margin` gutters to isolate web views from interface noise.

## Elevation & Depth

This design system completely avoids heavy, pitch-black drop shadows in favor of tonal hierarchy and ambient, diffuse light.

### Depth Mechanics
- **Tonal Stepping:** Surfaces step forward via subtle shifts in warmth. As an element moves closer to the user (e.g., active tab, popup modal, context menu), its background shifts from `#FAF9F5` towards `#FFFFFF` or `#EDEAE1`, demarcated by faint borders.
- **Ghost Outlines:** Instead of harsh boundaries, elements use a 1px hairline border tinted with `#E2DDD3` (or `#1E2321` at 7% alpha).
- **Soft Ambient Halos:** For floating controls (e.g., floating omnibar, detached panels), depth is achieved through an ultra-soft atmospheric shadow:
  - `box-shadow: 0 4px 20px -2px rgba(60, 68, 64, 0.05), 0 12px 32px -4px rgba(60, 68, 64, 0.08);`
  - This simulates natural ambient diffused daylight filtered through an overcast window.

## Shapes

The shape system employs deliberate, organic curvature (`roundedness: 2`) that softens the visual field without feeling playful or toy-like.

- **Base Radius (0.5rem / 8px):** Applied to buttons, search inputs, tabs, and menu popovers.
- **Large Radius (1rem / 16px):** Used for reader cards, workspace grouping containers, and contextual bottom sheets.
- **Full Pill (`9999px`):** Reserved solely for active status chips, URL protocol badges, and floating command pills to signal touch/click focus.

## Components

### Buttons
- **Primary:** Filled with `#4A6B5D`, text in `#FAF9F5`, subtle hover state brightening to `#557A6A`. Zero shadow; depth is conveyed through internal color balance.
- **Secondary / Ghost:** Transparent background with a 1px border of `#E2DDD3`. Text in `#1E2321`. On hover, fills smoothly with `#F4F2EC`.
- **Text / Minimal Utility:** Borderless, text in `#5E6C75`, transitioning to `#1E2321` with a soft `#EDEAE1` background fill on hover.

### Inputs & Omnibox
- **Default State:** Background `#F4F2EC`, bordered by `#E2DDD3`, text in `#1E2321`, placeholder in `#68706B`.
- **Focused State:** Background lifts to `#FFFFFF`, border transitions to a crisp `#4A6B5D` stroke, with an outer 2px soft ring tint of `#8C9E94` at 25% opacity.
- **Unified Command Pill:** The central browser bar floats with a pill silhouette, minimal iconography, and subtle monospaced keyboard shortcuts trailing on the right.

### Tabs & Navigation Rails
- **Inactive Tabs:** Borderless, soft `#5E6C75` typography, blending invisibly into the `#F4F2EC` header background.
- **Active Tab:** Slightly raised surface of `#FAF9F5`, framed by hairline `#E2DDD3` on left, top, and right. Text is deep `#1E2321` with a subtle 2px accent indicator in `#4A6B5D` along the bottom or leading edge.

### Chips & Tags
- Used for bookmark tags and reading lists. Built with a pill profile, background of `#F4F2EC`, label in `label-sm`, and hover state transitioning to `#8C9E94` at 15% opacity.

### Selection Controls (Checkboxes & Radios)
- **Unchecked:** 1px border in `#5E6C75` against `#FAF9F5`.
- **Checked:** Filled with `#4A6B5D`, displaying a clean `#FAF9F5` check or dot mark. Soft spring transition on toggle.

### Content Cards & Reading Panels
- Background `#FAF9F5` or `#FFFFFF`, enclosed by a single-pixel ghost border `#E2DDD3`. Minimal padding following `space-md` or `space-lg`. Hover interactions avoid card translation, using only faint border darkening (`#D1CAC0`).