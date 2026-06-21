---
name: "Marinara Engine"
description: "A playful immersive AI chat, roleplay, and game engine with retro Y2K visual warmth."
colors:
  void-night: "#050312"
  soft-silver: "#d4d4d4"
  ink-glass: "#141414d9"
  blush-primary: "#ffb3d9"
  blush-primary-foreground: "#0a0a0a"
  deep-violet: "#1a1a2e"
  lavender-text: "#e8d4ff"
  muted-orchid: "#d4adfc"
  plum-accent: "#2a1a3e"
  frost-text: "#f0e8ff"
  danger-rose: "#ff6b9d"
  orchid-border: "#d4adfc33"
  sidebar-night: "#08061a"
  sidebar-border-violet: "#d4adfc22"
  sidebar-blush-accent: "#ffb3d91a"
  y2k-pink: "#ffb3d9"
  y2k-purple: "#d4adfc"
  y2k-blue: "#a8d8ff"
  y2k-mint: "#b8f4d3"
  y2k-peach: "#ffd4b8"
  y2k-lavender: "#e8d4ff"
  y2k-yellow: "#fff5a8"
  pastel-rose: "#ffd1e3"
  pastel-lilac: "#e0b8ff"
  pastel-sky: "#c5e7ff"
  pastel-mint: "#c7f5e8"
  pastel-coral: "#ffb8a8"
  pastel-periwinkle: "#c8bfff"
  light-blush-bg: "#faf8ff"
  light-ink: "#1a1025"
  light-rose-primary: "#e0709a"
  light-panel: "#ffffffee"
  light-secondary: "#f0eaf7"
  light-secondary-foreground: "#3a2960"
  light-accent: "#ede4f7"
  sillytavern-blue: "#4a72b0"
  sillytavern-dark-bg: "#0b0b0f"
  sillytavern-dark-card: "#15151deb"
typography:
  display:
    fontFamily: "Straight Quotes, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0"
  headline:
    fontFamily: "Straight Quotes, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0"
  title:
    fontFamily: "Straight Quotes, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Straight Quotes, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "Straight Quotes, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0"
  micro-label:
    fontFamily: "Straight Quotes, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.05em"
rounded:
  xs: "2px"
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  "2xl": "24px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.blush-primary}"
    textColor: "{colors.blush-primary-foreground}"
    rounded: "{rounded.lg}"
    padding: "8px 20px"
  button-secondary:
    backgroundColor: "{colors.deep-violet}"
    textColor: "{colors.lavender-text}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  surface-glass:
    backgroundColor: "{colors.ink-glass}"
    textColor: "{colors.soft-silver}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input-default:
    backgroundColor: "{colors.deep-violet}"
    textColor: "{colors.soft-silver}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
---

# Design System: Marinara Engine

## 1. Overview

**Creative North Star: "The Velvet Y2K Game Console"**

Marinara should feel like a lovingly built story machine: visual, intimate, a little magical, and still practical enough for power users who live in settings panels. The default visual theme is called **Default (Marinara)** in settings and described in the app as a **Y2K / retro aesthetic with glow effects**. Its palette combines blush, violet, cyan, mint, peach, lavender, retro cursors, scanlines, geometric grids, glass panels, and mode-specific accent gradients.

The default surface is dark because the main play moment is long-form chat, roleplay, or game mode in a focused evening setting, where bright white UI would fight the scene. Light mode exists for comfort and accessibility, but the brand signal lives in blush, violet, soft glow, character art, and compact tools. SillyTavern is a compatibility visual theme selected through `data-visual-theme="sillytavern"`, not the default identity.

The system rejects sterile SaaS dashboards, bland SillyTavern cloning, generic Discord surfaces, and developer-only control panels. Dense product surfaces are allowed and common. They should still feel like tools inside a story engine, not generic enterprise panels.

**Key Characteristics:**

- Default (Marinara) theme is Y2K/retro with blush-violet core tokens and a wider decorative palette.
- Semantic CSS variables are the implementation contract for app chrome, panels, inputs, sidebars, and custom themes.
- Compact density is normal: `text-xs`, `0.6875rem` uppercase labels, `tracking-wider`, `rounded-xl`, and `rounded-2xl` all appear in dense surfaces.
- Category accents are part of the app identity: violet/purple for Agents, pink/rose for Characters, amber/orange for Lorebooks, cyan/blue for Browser and Connections, emerald/teal for Personas.
- Mobile layouts are first-class play surfaces, not reduced desktop leftovers.

## 2. Colors

The palette is a dark Y2K nocturne: near-black violet structure, rose-blush primary actions, lavender text and borders, plus decorative cyan, mint, peach, and yellow for effects and category accents.

### Primary

- **Blush Primary** (`--primary`, `#ffb3d9`): Main action color, active icons, links, focus rings, highlighted controls, and glow accents in the dark default theme.
- **Primary Foreground** (`--primary-foreground`, `#0a0a0a`): Text and icon color on dark-theme primary fills.
- **Light Rose Primary** (`--primary` in light mode, `#e0709a`): Light theme primary action and focus color.

### Secondary

- **Deep Violet Secondary** (`--secondary`, `#1a1a2e`): Subtle backgrounds, secondary buttons, compact filter rails, and muted control beds.
- **Lavender Secondary Foreground** (`--secondary-foreground`, `#e8d4ff`): Text on secondary dark surfaces.
- **Plum Accent** (`--accent`, `#2a1a3e`): Active tabs, hover surfaces, selected areas, and roleplay mood accents.
- **Frost Accent Foreground** (`--accent-foreground`, `#f0e8ff`): Text on accent surfaces.

### Tertiary

- **Y2K Palette** (`--y2k-pink`, `--y2k-purple`, `--y2k-blue`, `--y2k-mint`, `--y2k-peach`, `--y2k-lavender`, `--y2k-yellow`): Decorative effects, scrollbars, scanlines, gradient borders, category marks, and retro visual flavor. Components should not use these when a semantic token exists.
- **Pastel Palette** (`--pastel-*`): Softer decorative gradients and glow effects. Treat as visual atmosphere, not core UI state.
- **RGB Palette** (`--rgb-*`): Data visualization and decorative spectrum accents.
- **SillyTavern Blue** (`#4a72b0`): Compatibility-theme primary only. Do not let it overtake the Marinara default identity.

### Neutral

- **Void Night** (`--background`, `#050312`): Default app background.
- **Soft Silver** (`--foreground`, `#d4d4d4`): Default body text on dark surfaces.
- **Ink Glass** (`--card` and `--popover`, `#141414d9`): Card, popover, modal, and elevated shell surfaces.
- **Muted Orchid** (`--muted-foreground`, `#d4adfc`): Secondary emphasis, borders, quiet metadata, and decorative highlights.
- **Orchid Border** (`--border` and `--input`, `#d4adfc33`): Default border and input stroke.
- **Sidebar Night** (`--sidebar`, `#08061a`): Persistent navigation and app frame.
- **Sidebar Accent** (`--sidebar-accent`, `#ffb3d91a`): Sidebar active/hover background with `--sidebar-accent-foreground` for selected text and icons.
- **Danger Rose** (`--destructive`, `#ff6b9d`): Delete, destructive, and error actions in dark default theme.

### Named Rules

**The Semantic Contract Rule.** Use `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, and `--sidebar-*` before adding a one-off color.

**The Y2K Palette Is Effects Rule.** `--y2k-*`, `--pastel-*`, and `--rgb-*` exist for effects, decoration, custom theme compatibility, and data color. Do not use them as routine button or input state tokens when semantic tokens already fit.

**The Tracker Card Rule.** Tracker cards have their own derived token family, including `--tracker-card-neutral-*`, `--tracker-card-active-*`, `--tracker-card-material-*`, `--tracker-card-readable-*`, `--tracker-card-muted-*`, and `--tracker-card-nameplate-*`. These are real implementation tokens, many are `color-mix()` or OKLCH values, and they should stay in CSS rather than frontmatter hex tokens.

**The Category Accent Rule.** Category gradients are allowed when they identify a specific library or panel. Keep them consistent with the existing accent families: violet/purple for Agents, pink/rose for Characters, amber/orange for Lorebooks, cyan/blue for Browser and Connections, emerald/teal for Personas.

**The Compatibility Theme Rule.** SillyTavern is a compatibility skin. It defines the same 65-variable contract and deliberately disables or flattens Y2K effects.

## 3. Typography

**Display Font:** Straight Quotes with Inter and system sans fallbacks.
**Body Font:** Straight Quotes with Inter and system sans fallbacks.
**Label/Mono Font:** System sans for labels; Consolas, Monaco, Courier New for inline and fenced code.

**Character:** The type system is clean and product-readable. Personality comes from surfaces, glow, sprites, mode chrome, and category accents rather than decorative display fonts.

### Hierarchy

- **Display** (700, `1.5rem`, 1.3): Compact page, markdown h1, modal, and major surface headings. Reserve larger hero scale for true first-viewport brand moments.
- **Headline** (700, `1.25rem`, 1.3): Markdown h2, section headings, and important drawer titles.
- **Title** (700, `1rem`, 1.35): Card titles, message author labels, panel headings, and compact modal titles.
- **Body** (400, `0.875rem`, 1.5): Default app text, chat metadata, settings descriptions, and dense controls. Keep prose line length around 65 to 75 characters where possible.
- **Label** (600, `0.8125rem`, 1.25): Buttons, chips, tabs, field labels, compact status text.
- **Micro Label** (600, `0.6875rem`, uppercase, `tracking-wider`): Dense panel group headings, filters, mode metadata, and compact labels. Use only where density requires it.

### Named Rules

**The Product Scale Rule.** Use fixed rem sizes, not viewport-fluid type, for application UI.

**The Micro Label Rule.** `0.6875rem` uppercase labels with `tracking-wider` are allowed in dense panels, but not for primary actions or mobile-critical instructions.

**The Compact Is Not Cramped Rule.** Dense panels may use small type, but text must not clip, overlap, or rely on negative letter spacing.

## 4. Elevation

Marinara uses a hybrid of tonal layering, soft glow, and selective frosted surfaces. Core reading areas should stay stable and legible; blur and glow belong to shell chrome, overlays, popovers, and special immersive moments.

### Shadow Vocabulary

- **Glass Strong** (`--glass-strong-shadow`, dark: `0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px rgba(255, 255, 255, 0.1)`): Modals, strong popovers, and elevated shell panels.
- **Light Glass Strong** (`--glass-strong-shadow`, light: `0 4px 16px rgba(0, 0, 0, 0.06), inset 0 1px rgba(255, 255, 255, 0.5)`): Light-theme modal and panel lift.
- **Control Lift** (`0 2px 6px rgba(0, 0, 0, 0.2)`): Compact buttons and icon controls at rest.
- **Control Hover Lift** (`0 3px 8px rgba(0, 0, 0, 0.3)`): Buttons that rise on hover or focus.
- **Character Glow** (`0 0 12px rgba(255, 179, 217, 0.25), 0 4px 12px rgba(0, 0, 0, 0.15)`): Avatar rings, roleplay focus, and expressive character states.
- **Modal Lift** (`shadow-2xl shadow-black/50`): Current modal shell vocabulary, paired with a pastel gradient title bar and `150ms ease-out` opacity/transform transitions.

### Named Rules

**The Reading Surface Rule.** Never put heavy blur behind long chat text, JSON editors, prompt editors, logs, or repair modals. Use solid or near-solid surfaces there.

**The State Motion Rule.** Product motion is short and functional. Current modal transitions use `150ms ease-out`; range thumbs and controls use roughly `120ms` to `200ms` state feedback.

## 5. Components

### Buttons

- **Shape:** Compact rounded rectangles, usually `rounded-lg` to `rounded-xl` (8px to 12px). Icon-only buttons are square or circular with stable dimensions.
- **Primary:** Use `--primary` with `--primary-foreground` for canonical actions. Use category gradients only when the button's job is to create, open, or identify a specific content library.
- **Hover / Focus:** Small lift, opacity shift, glow, or border contrast. Focus states must be visible without relying on color alone.
- **Secondary / Ghost:** Use `--secondary`, `--accent`, `--border`, and semantic foreground tokens. Avoid inventing new one-off inactive colors.

### Chips

- **Style:** Small rounded pills or compact segmented controls with border and tint, often `rounded-full` or `rounded-lg`.
- **State:** Selected states need both tonal fill and clear text/icon treatment. Color alone is not enough.

### Cards / Containers

- **Corner Style:** Most panels use 8px to 12px. Modals, input composers, empty-state icons, and immersive chat elements may use `rounded-2xl` (24px).
- **Background:** Use `--card`, `--popover`, `--secondary`, and derived tracker-card tokens. Use stronger opacity for editors, logs, settings, JSON repair, and generation detail views.
- **Shadow Strategy:** Flat by default, lifted for popovers, modals, hoverable cards, and special game surfaces.
- **Border:** Use `--border`, `--input`, or semantic ring utilities. Avoid decorative side stripes.
- **Internal Padding:** 8px to 20px depending on density. Tool rows can be tighter; modals and editor panels need more breathing room.

### Inputs / Fields

- **Style:** Tokenized input stroke, `--secondary` or `--background` surface, 8px to 12px radius, readable contrast.
- **Focus:** Ring color uses `--ring` or `--primary`, with visible outline or border shift.
- **Range Inputs:** Global range styling uses `--range-*` variables, primary fill, muted track, and hidden thumbs that appear on hover, focus, or active.
- **Error / Disabled:** Error state uses `--destructive` plus text, icon, or state copy. Disabled controls reduce opacity but must remain readable.

### Navigation

- **Style:** Persistent sidebars use `--sidebar`, `--sidebar-foreground`, `--sidebar-border`, and `--sidebar-accent`. Active tabs use `--sidebar-accent` and `--sidebar-accent-foreground`.
- **Chat Modes:** The visible sidebar/new-chat tabs are Conversation, Roleplay, and Game. Shared code still defines `visual_novel` as a legacy/compatibility contract with a coming-soon config, so do not describe it as a fourth visible product tab.
- **Mobile Treatment:** Navigation and settings controls must be touch-friendly, avoid hover-only disclosure, and keep primary chat/game actions reachable.

### Chat, Roleplay, and Game Surfaces

Conversation mode can use familiar message bubbles and texting affordances. Roleplay uses immersive dark RPG surfaces, sprites, backgrounds, tracker widgets, scene banners, and world-state controls. Game mode adds a VN/RPG layer with Game Master narration, party, dice, maps, combat, audio, and image assets. Visual-novel language is still accurate as an experience layer, but current product navigation names the mode **Game**, not **Visual Novel**.

### Themes

- **Default (Marinara):** Current default. Settings describe it as Y2K / retro with glow effects. This theme owns the blush-violet/Y2K identity.
- **SillyTavern:** Compatibility visual theme. It keeps the same CSS variable contract, maps Y2K tokens to muted blue/gray values, and disables or flattens many Y2K effects.
- **Custom CSS Themes:** Synced themes can override any CSS variable. Documentation and new components must keep using the shared CSS variable contract so custom themes remain viable.

## 6. Do's and Don'ts

### Do:

- **Do** use the existing semantic tokens (`--primary`, `--secondary`, `--accent`, `--background`, `--foreground`, `--card`, `--popover`, `--muted`, `--destructive`, `--border`, `--input`, `--ring`, and `--sidebar-*`) before adding one-off colors.
- **Do** name the default theme **Default (Marinara)** or **Y2K Marinara** in product and design guidance.
- **Do** keep game and roleplay surfaces immersive, with room for sprites, backgrounds, voice, image prompts, tracker cards, command results, maps, party, dice, and combat.
- **Do** make mobile controls touch-friendly and readable, especially settings drawers, prompt editors, maps, logs, tracker panels, and modal workflows.
- **Do** pair color with labels, icons, shape, or state text for color-blind support.
- **Do** use solid or near-solid surfaces for long text, JSON repair, prompt previews, advanced parameter fields, and logs.
- **Do** keep category gradients consistent when a surface represents a library: Agents, Characters, Lorebooks, Browser, Connections, Personas, Presets, and Settings each have established accent families.

### Don't:

- **Don't** turn Marinara into a sterile SaaS dashboard with gray cards, dry labels, and enterprise emptiness.
- **Don't** make it a bland SillyTavern clone that copies structure without adding identity. Compatibility themes may exist, but Marinara's default should keep its own Y2K visual novel identity.
- **Don't** make it feel like a generic Discord clone. Chat familiarity is useful, but roleplay and game mode need their own atmosphere.
- **Don't** build developer-only control panels that assume technical confidence. Advanced settings still need clear labels, forgiving defaults, and helpful validation.
- **Don't** use colored side-stripe borders, decorative gradient text, nested cards, or glassmorphism as the default layout answer.
- **Don't** rely on hover for important mobile actions.
- **Don't** describe `visual_novel` as a visible fourth chat tab unless the UI exposes it again. It is still present in shared compatibility types, while the active creation/sidebar UI uses Conversation, Roleplay, and Game.
