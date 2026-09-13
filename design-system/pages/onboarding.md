# Onboarding Page Overrides

> **PROJECT:** NutriTime AI
> **Generated:** 2026-09-13 14:32:23
> **Page Type:** General

> ⚠️ **IMPORTANT:** Rules in this file **override** the Master file (`design-system/MASTER.md`).
> Only deviations from the Master are documented here. For all other rules, refer to the Master.

---

## Page-Specific Rules

### Layout Overrides

- **Max Width:** 1200px (standard)
- **Layout:** Full-width sections, centered content
- **Sections:** Hero (community value prop) > Popular topics/categories > Active members showcase > Join CTA

### Spacing Overrides

- No overrides — use Master spacing

### Typography Overrides

- No overrides — use Master typography

### Color Overrides

- **Strategy:** Warm, welcoming. Member photos add humanity. Topic badges in brand colors. Activity indicators green.

### Component Overrides

- Avoid: Force linear unskippable tour
- Avoid: Desktop-first causing mobile issues
- Avoid: Large blocking CSS files

---

## Page-Specific Components

- No unique components for this page

---

## Recommendations

- Effects: Hard offset shadows (4px 4px 0px black), mechanical press active:translate, no smooth hover — instant 0ms transitions, dot grid pattern on sections, slide-over transitions
- Onboarding: Provide Skip and Back buttons
- Responsive: Start with mobile styles then add breakpoints
- Performance: Inline critical CSS defer non-critical
- CTA Placement: Join button prominent + After member showcase
