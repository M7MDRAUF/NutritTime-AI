# Accessibility role and label audit — T-23-01

`Plan.md`'s T-23-01 requires _"Every interactive element has both"_ and names its evidence as an
**Audit table**. This is that table. The requirement it serves is `PRD.md` §10.5's first bullet:
_"Every control has an accessibility role and label."_

**This document is the readable half. The executable half is
`apps/mobile/src/shared/components/roles.dom.test.tsx`**, and the two are not interchangeable:
`docs/final-audit.md` records that a registration test which read its subject as _source text_ left
2012 tests green while an early `return` dropped every screen in the app to a placeholder. So every
row below was read off a **rendered DOM**, from a real mount of the real component through
react-native-web, and the test fails if any enumerated element has no role or no accessible name.
Nothing here was derived by grepping for `accessibilityLabel=`.

|                                                  |                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Measured at                                      | **2026-09-15T00:35:00Z** (2026-09-14 17:35 local)                                          |
| Measured by                                      | `apps/mobile/src/shared/components/roles.dom.test.tsx`, run under the `dom` Vitest project |
| Surfaces                                         | 18                                                                                         |
| Interactive elements enumerated                  | **231** instances (117 distinct role + id + name triples)                                  |
| Elements with no accessibility role              | **0**                                                                                      |
| Elements with no accessible name                 | **0**                                                                                      |
| Operable elements outside the accessibility tree | **9** — three per open `Sheet`, on three surfaces; itemised below                          |

**Why "231 instances" and not one number of controls.** Five of the eighteen surfaces are a _second
state_ of a screen already listed — `Saved (forget an orphan)`, `MealForm (edit)`,
`MealForm (confirm delete)`, `Settings (confirm erase)` and `Assistant (answered turn)` — so a
control that survives the state change is counted in both. That is deliberate:
the claim being evidenced is "every element **the app renders**, in every state this audit reached",
and a control whose name is correct on first paint and wrong after a state change is exactly the
defect a distinct-elements count would hide.

---

## The definition of "interactive"

An element is interactive when the **rendered DOM** makes it operable. Three clauses, and an element
qualifies on any one of them:

1. it is a native form control — `input`, `textarea`, `select`, `button`, `a[href]`; **or**
2. it carries `tabindex="0"`, which is what react-native-web 0.21.2 puts on an enabled `Pressable`;
   **or**
3. it carries one of ARIA 1.2's **standalone** widget roles: `button`, `checkbox`, `combobox`,
   `gridcell`, `link`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, `radio`,
   `scrollbar`, `searchbox`, `slider`, `spinbutton`, `switch`, `tab`, `textbox`, `treeitem`.

Clause 3 is not redundant with clause 2, and the reason was measured rather than assumed: **a
`disabled` `Pressable` renders `tabindex="-1"`**. A definition resting on `tabindex >= 0` alone would
drop every disabled control in the app, and a disabled control still has to announce what it is.
`disabled` on `AccessibleButton`, on `Chip` and on `IconButton` each render `tabindex="-1"` in this
environment, and all four appear in the table with their `tabindex` noted.

The **role** of each element is its `role` attribute, or the implicit role of its tag
(`input`/`textarea` → `textbox`, `button` → `button`, `select` → `combobox`, `a` → `link`). The
**accessible name** is not computed by this project: it is computed by `@testing-library/dom`'s own
accessible-name algorithm, asked per role with `name: /\S/`. A hand-rolled name computation is
exactly where leniency would hide.

### What the definition excludes, and why each exclusion is legitimate

Every exclusion below applies **only** to an element that failed all three positive clauses. A
landmark that is also focusable is still enumerated, so the exclusion cannot remove a control.

| Role met                                                | Why it is not a control                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `generic`                                               | a plain `View` with no role of its own                                               |
| `presentation` / `none`                                 | explicitly removed from the accessibility tree                                       |
| `heading`, `img`, `paragraph`, `list`, `listitem`       | structure, not a control                                                             |
| `alert`, `status`, `log`                                | a live region — its _insertion_ is the announcement, and there is nothing to operate |
| `toolbar`, `search`, `tablist`, `dialog`                | a container; every control inside it is enumerated in its own right                  |
| `main`, `region`, `banner`, `navigation`, `contentinfo` | a landmark                                                                           |
| `progressbar`, `separator`                              | a read-only widget with nothing to operate                                           |

Two of those are worth stating plainly rather than leaving implicit, because they are the cases where
the exclusion could be doing work it should not:

- **`tablist`** (the tab bar's container) **has no accessible name.** It is excluded because a
  `tablist` is not operated — its five `tab` children are, and each of those is in the table with the
  name its visible title gives it. Naming a `tablist` is an ARIA authoring-practices suggestion, not
  PRD §10.5's requirement, which is about controls.
- **`search`** (the wrapper `View` in `shared/components/SearchField.tsx`) **has no accessible name
  either**, for the same structural reason: the `input` inside it is the control, and it is named.
  See the observations below — this one is recorded as a real if minor mapping oddity.

**The exclusion list is closed, and that is enforced rather than promised.** The test asserts that
every role it met across all eighteen surfaces is either in the interactive set or in the table
above. A role that arrives in the app and is in neither turns the file red until someone classifies
it. That guard exists because of §23's own history: a coverage check once collapsed the two
directions of a pairing, and 218 passing theme tests sat on top of a live WCAG failure. An
accessibility suite that reports coverage is worth exactly what its definition of "covered" is worth.

### Operable elements outside the accessibility tree — all 9 of them

`aria-hidden` (on the element or an ancestor) and `role="presentation"` both mean assistive
technology never reaches the element, so there is no name for it to announce. These are **counted per
surface and asserted**, never filtered away: a fourth one appearing on a `Sheet` surface fails the
test until it is explained. Three per open `Sheet`, on three surfaces:

| Element                                         | Source                                        | Why it has no name                                                                                                                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the backdrop `Pressable`                        | `apps/mobile/src/shared/components/Sheet.tsx` | Hidden on all three platforms (`aria-hidden` + `accessibilityElementsHidden` + `importantForAccessibility="no-hide-descendants"`) because the labelled close button is the accessible way out; a second unlabelled "close" would be one more thing to swipe past |
| two `role="presentation" tabindex="0"` brackets | react-native-web's own `ModalFocusTrap`       | Library-rendered focus sentinels that bounce focus back into the dialog. No app code renders them, and no app code can name them                                                                                                                                 |

### What makes an empty enumeration fail

A suite that finds zero elements and asserts "all of them have a name" passes perfectly — T-19-09's
vacuity lesson on this axis (_"an empty permitted set forbids every figure; it does not skip the
check"_). So three further assertions carry counts:

- every surface declares the **fewest** controls it must render, and reddens if it renders fewer.
  A minimum rather than an exact figure on purpose: a sibling _adding_ a control is not a defect,
  and losing one is;
- the set of surfaces that render **zero** controls must be exactly `['Splash']`, asserted in both
  directions — so "zero interactive elements" can never become a silent pass for a screen that lost
  its controls;
- the total must be at least the sum of those minimums.

This was probed. Reducing the enumeration to nothing left **all eighteen** per-surface "every
interactive element has a role and an accessible name" tests **green**, and only the two count
assertions caught it. That is the whole reason they exist.

---

## The inventory

One row per interactive element, per surface. **No line numbers**: every screen file named here is
being edited by another agent in the same session, so a line citation would expire within the hour
(BRIEF §6.1q). The citation is the file plus the named prop or helper, which survives an insertion
above it.

"How the name is produced" is one of:

- **prop** — a caller passed `accessibilityLabel` explicitly;
- **derived** — the component computed it (`accessibilityLabel ?? label` on `AccessibleButton` and
  `Chip`; `accessibleName(...)` in `FormField` and `MealCard`; an interpolated template);
- **constant** — a module-level string in the component itself;
- **content** — no `aria-label` at all; the name is the element's own visible text.

### Splash — 0 interactive elements

Nothing to operate: a coloured ground, the app's name, and an `alert` live region.

### Onboarding — 1 interactive element

| Element               | Render site (`apps/mobile/src/…`)          | Component        | Role     | Accessible name       | How the name is produced |
| --------------------- | ------------------------------------------ | ---------------- | -------- | --------------------- | ------------------------ |
| `onboarding-continue` | `features/onboarding/OnboardingScreen.tsx` | AccessibleButton | `button` | Set up my preferences | derived from `label`     |

### DietarySetup — 27 interactive elements

| Element                      | Render site (`apps/mobile/src/…`)            | Component                    | Role       | Accessible name                                                                                              | How the name is produced                                                  |
| ---------------------------- | -------------------------------------------- | ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| _(no testID)_                | `features/onboarding/DietarySetupScreen.tsx` | FormField                    | `textbox`  | Your name. Optional. Used only to greet you.                                                                 | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `chip-diet-regular`          | `features/onboarding/ChipRow.tsx`            | Chip (single-select ChipRow) | `checkbox` | Regular                                                                                                      | derived — `chipLabel(value)` via Chip's `accessibilityLabel ?? label`     |
| `chip-diet-vegetarian`       | `features/onboarding/ChipRow.tsx`            | Chip (single-select ChipRow) | `checkbox` | Vegetarian                                                                                                   | derived — `chipLabel(value)` via Chip's `accessibilityLabel ?? label`     |
| `chip-diet-vegan`            | `features/onboarding/ChipRow.tsx`            | Chip (single-select ChipRow) | `checkbox` | Vegan                                                                                                        | derived — `chipLabel(value)` via Chip's `accessibilityLabel ?? label`     |
| `chip-diet-halal-preference` | `features/onboarding/ChipRow.tsx`            | Chip (single-select ChipRow) | `checkbox` | Halal preference                                                                                             | derived — `chipLabel(value)` via Chip's `accessibilityLabel ?? label`     |
| `chip-diet-gluten-aware`     | `features/onboarding/ChipRow.tsx`            | Chip (single-select ChipRow) | `checkbox` | Gluten aware                                                                                                 | derived — `chipLabel(value)` via Chip's `accessibilityLabel ?? label`     |
| `chip-allergy-peanut`        | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Peanut                                                                                                       | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-tree-nut`      | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Tree nut                                                                                                     | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-milk`          | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Milk                                                                                                         | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-egg`           | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Egg                                                                                                          | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-soy`           | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Soy                                                                                                          | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-wheat`         | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Wheat                                                                                                        | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-gluten`        | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Gluten                                                                                                       | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-fish`          | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Fish                                                                                                         | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-shellfish`     | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Shellfish                                                                                                    | derived — `chipLabel(allergen)`                                           |
| `chip-allergy-sesame`        | `features/onboarding/DietarySetupScreen.tsx` | Chip                         | `checkbox` | Sesame                                                                                                       | derived — `chipLabel(allergen)`                                           |
| `chip-goal-balanced`         | `features/onboarding/ChipRow.tsx`            | Chip                         | `checkbox` | Balanced                                                                                                     | derived — `chipLabel(value)`                                              |
| `chip-goal-high-protein`     | `features/onboarding/ChipRow.tsx`            | Chip                         | `checkbox` | High protein                                                                                                 | derived — `chipLabel(value)`                                              |
| `chip-goal-lower-calorie`    | `features/onboarding/ChipRow.tsx`            | Chip                         | `checkbox` | Lower calorie                                                                                                | derived — `chipLabel(value)`                                              |
| `chip-budget-low`            | `features/onboarding/ChipRow.tsx`            | Chip (single-select ChipRow) | `checkbox` | Low                                                                                                          | derived — `chipLabel(value)` via Chip's `accessibilityLabel ?? label`     |
| `chip-budget-medium`         | `features/onboarding/ChipRow.tsx`            | Chip (single-select ChipRow) | `checkbox` | Medium                                                                                                       | derived — `chipLabel(value)` via Chip's `accessibilityLabel ?? label`     |
| `chip-budget-high`           | `features/onboarding/ChipRow.tsx`            | Chip (single-select ChipRow) | `checkbox` | High                                                                                                         | derived — `chipLabel(value)` via Chip's `accessibilityLabel ?? label`     |
| _(no testID)_                | `features/onboarding/DietarySetupScreen.tsx` | FormField                    | `textbox`  | Ingredients you would rather avoid. Separate with commas. These lower a meal's score; they do not remove it. | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/onboarding/DietarySetupScreen.tsx` | FormField                    | `textbox`  | Breakfast time, required                                                                                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/onboarding/DietarySetupScreen.tsx` | FormField                    | `textbox`  | Lunch time, required                                                                                         | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/onboarding/DietarySetupScreen.tsx` | FormField                    | `textbox`  | Dinner time, required                                                                                        | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `dietary-setup-save`         | `features/onboarding/DietarySetupScreen.tsx` | AccessibleButton             | `button`   | Start using NutriTime                                                                                        | derived from `label`                                                      |

### Home — 2 interactive elements

| Element                       | Render site (`apps/mobile/src/…`)                                   | Component | Role     | Accessible name                                                             | How the name is produced                        |
| ----------------------------- | ------------------------------------------------------------------- | --------- | -------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| `meal-english-breakfast`      | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard  | `button` | English Breakfast. $9.50. 30 minutes. regular. Fits your preferences.       | derived — `accessibleName(...)` in MealCard.tsx |
| `meal-full-english-breakfast` | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard  | `button` | Full English Breakfast. $10.50. 35 minutes. regular. Fits your preferences. | derived — `accessibleName(...)` in MealCard.tsx |

### Explore — 22 interactive elements

| Element                                          | Render site (`apps/mobile/src/…`)                                   | Component        | Role       | Accessible name                                                          | How the name is produced                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------- | ---------------- | ---------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| _(no testID)_                                    | `features/catalog/ExploreScreen.tsx`                                | SearchField      | `textbox`  | Search meals                                                             | prop — `accessibilityLabel="Search meals"`                                 |
| `chip-period-breakfast`                          | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Breakfast                                                                | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-period-lunch`                              | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Lunch                                                                    | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-period-dinner`                             | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Dinner                                                                   | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-period-snack`                              | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Snack                                                                    | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-diet-regular`                              | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Regular                                                                  | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-diet-vegetarian`                           | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Vegetarian                                                               | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-diet-vegan`                                | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Vegan                                                                    | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-diet-halal-preference`                     | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Halal preference                                                         | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-diet-gluten-aware`                         | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Gluten aware                                                             | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-budget-low`                                | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Under $9                                                                 | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-budget-medium`                             | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Under $16                                                                | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `chip-budget-high`                               | `features/catalog/ExploreScreen.tsx`                                | Chip             | `checkbox` | Any price                                                                | derived — the filter spec's own `label`, via `accessibilityLabel ?? label` |
| `meal-english-breakfast`                         | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard         | `button`   | English Breakfast. $9.50. 30 minutes. regular                            | derived — `accessibleName(...)` in MealCard.tsx                            |
| `meal-full-english-breakfast`                    | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard         | `button`   | Full English Breakfast. $10.50. 35 minutes. regular                      | derived — `accessibleName(...)` in MealCard.tsx                            |
| `meal-fruit-and-cream-cheese-breakfast-pastries` | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard         | `button`   | Fruit and Cream Cheese Breakfast Pastries. $6.50. 40 minutes. vegetarian | derived — `accessibleName(...)` in MealCard.tsx                            |
| `meal-salmon-eggs-eggs-benedict`                 | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard         | `button`   | Salmon Eggs Eggs Benedict. $12.50. 30 minutes. regular                   | derived — `accessibleName(...)` in MealCard.tsx                            |
| `meal-smoked-haddock-kedgeree`                   | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard         | `button`   | Smoked Haddock Kedgeree. $11.50. 45 minutes. regular, gluten-aware       | derived — `accessibleName(...)` in MealCard.tsx                            |
| `meal-breakfast-potatoes`                        | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard         | `button`   | Breakfast Potatoes. $5.50. 40 minutes. regular, gluten-aware             | derived — `accessibleName(...)` in MealCard.tsx                            |
| `meal-home-made-mandazi`                         | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard         | `button`   | Home-made Mandazi. $4.00. 45 minutes. vegetarian                         | derived — `accessibleName(...)` in MealCard.tsx                            |
| `meal-spicy-arrabiata-penne`                     | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx` | MealCard         | `button`   | Spicy Arrabiata Penne. $7.50. 25 minutes. vegetarian                     | derived — `accessibleName(...)` in MealCard.tsx                            |
| `explore-more`                                   | `features/catalog/ExploreScreen.tsx`                                | AccessibleButton | `button`   | Show more meals                                                          | derived from `label`                                                       |

### MealDetails — 2 interactive elements

| Element                 | Render site (`apps/mobile/src/…`)        | Component  | Role     | Accessible name        | How the name is produced                                |
| ----------------------- | ---------------------------------------- | ---------- | -------- | ---------------------- | ------------------------------------------------------- |
| `meal-details-dismiss`  | `features/details/MealDetailsScreen.tsx` | IconButton | `button` | Close meal details     | prop — `accessibilityLabel={COPY.dismiss}`              |
| `meal-details-favorite` | `features/details/MealDetailsScreen.tsx` | IconButton | `button` | Remove from favourites | prop — `saved ? COPY.removeFavorite : COPY.addFavorite` |

### Saved — 4 interactive elements

| Element                                | Render site (`apps/mobile/src/…`)                            | Component        | Role     | Accessible name                                                 | How the name is produced                                  |
| -------------------------------------- | ------------------------------------------------------------ | ---------------- | -------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `saved-favorite-english-breakfast`     | `features/saved/SavedMealRow.tsx (via FavoritesSection.tsx)` | MealCard         | `button` | English Breakfast. $9.50. 30 minutes. regular                   | derived — `accessibleName(...)`                           |
| `saved-forget-a-meal-the-catalog-lost` | `features/saved/FavoritesSection.tsx`                        | AccessibleButton | `button` | Remove the missing meal a-meal-the-catalog-lost from favourites | prop — `accessibilityLabel` interpolating the orphaned id |
| `saved-new-meal`                       | `features/saved/CustomSection.tsx`                           | AccessibleButton | `button` | New meal                                                        | derived from `label`                                      |
| `saved-recipe-house-omelette`          | `features/saved/SavedMealRow.tsx (via CustomSection.tsx)`    | MealCard         | `button` | House omelette. $4.50. 10 minutes. vegetarian                   | derived — `accessibleName(...)`                           |

### Saved (forget an orphan) — 7 interactive elements

| Element                                | Render site (`apps/mobile/src/…`)                            | Component        | Role     | Accessible name                                                 | How the name is produced                                  |
| -------------------------------------- | ------------------------------------------------------------ | ---------------- | -------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `saved-favorite-english-breakfast`     | `features/saved/SavedMealRow.tsx (via FavoritesSection.tsx)` | MealCard         | `button` | English Breakfast. $9.50. 30 minutes. regular                   | derived — `accessibleName(...)`                           |
| `saved-forget-a-meal-the-catalog-lost` | `features/saved/FavoritesSection.tsx`                        | AccessibleButton | `button` | Remove the missing meal a-meal-the-catalog-lost from favourites | prop — `accessibilityLabel` interpolating the orphaned id |
| `saved-new-meal`                       | `features/saved/CustomSection.tsx`                           | AccessibleButton | `button` | New meal                                                        | derived from `label`                                      |
| `saved-recipe-house-omelette`          | `features/saved/SavedMealRow.tsx (via CustomSection.tsx)`    | MealCard         | `button` | House omelette. $4.50. 10 minutes. vegetarian                   | derived — `accessibleName(...)`                           |
| _(no testID)_                          | `shared/components/Sheet.tsx`                                | IconButton       | `button` | Close                                                           | constant — `CLOSE_LABEL`                                  |
| `saved-forget-confirm`                 | `features/saved/SavedScreen.tsx`                             | AccessibleButton | `button` | Remove                                                          | derived from `label`                                      |
| `saved-forget-cancel`                  | `features/saved/SavedScreen.tsx`                             | AccessibleButton | `button` | Keep it                                                         | derived from `label`                                      |

### MealForm (create) — 36 interactive elements

| Element                      | Render site (`apps/mobile/src/…`)                                         | Component                     | Role       | Accessible name                                                                            | How the name is produced                                                  |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------- | ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Meal name, required                                                                        | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Description. Optional. What it is, in a line or two.                                       | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `chip-period-breakfast`      | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Breakfast                                                                                  | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-lunch`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Lunch                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-dinner`         | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Dinner                                                                                     | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-snack`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Snack                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-regular`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Regular                                                                                    | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-vegetarian`       | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Vegetarian                                                                                 | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-vegan`            | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Vegan                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-halal-preference` | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Halal preference                                                                           | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-gluten-aware`     | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Gluten aware                                                                               | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-allergen-peanut`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Peanut                                                                                     | derived — `labelOf(value)`                                                |
| `chip-allergen-tree-nut`     | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Tree nut                                                                                   | derived — `labelOf(value)`                                                |
| `chip-allergen-milk`         | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Milk                                                                                       | derived — `labelOf(value)`                                                |
| `chip-allergen-egg`          | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Egg                                                                                        | derived — `labelOf(value)`                                                |
| `chip-allergen-soy`          | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Soy                                                                                        | derived — `labelOf(value)`                                                |
| `chip-allergen-wheat`        | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Wheat                                                                                      | derived — `labelOf(value)`                                                |
| `chip-allergen-gluten`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Gluten                                                                                     | derived — `labelOf(value)`                                                |
| `chip-allergen-fish`         | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Fish                                                                                       | derived — `labelOf(value)`                                                |
| `chip-allergen-shellfish`    | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Shellfish                                                                                  | derived — `labelOf(value)`                                                |
| `chip-allergen-sesame`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Sesame                                                                                     | derived — `labelOf(value)`                                                |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Ingredient 1                                                                               | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Measure                                                                                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `remove-ingredient-0`        | `features/saved/MealFormControls.tsx`                                     | IconButton                    | `button`   | Remove ingredient 1                                                                        | prop — `Remove ingredient ${position}`                                    |
| `add-ingredient`             | `features/saved/MealFormScreen.tsx`                                       | AccessibleButton              | `button`   | Add an ingredient                                                                          | derived from `label`                                                      |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Step 1                                                                                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `remove-instruction-0`       | `features/saved/MealFormControls.tsx`                                     | IconButton                    | `button`   | Remove step 1                                                                              | prop — `Remove step ${position}`                                          |
| `add-instruction`            | `features/saved/MealFormScreen.tsx`                                       | AccessibleButton              | `button`   | Add a step                                                                                 | derived from `label`                                                      |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Price, required. In dollars and cents. Enter 0 if it costs you nothing.                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Preparation time in minutes, required. Enter a preparation time between 0 and 600 minutes. | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Calories. Calories must be a whole number between 0 and 2000 kcal.                         | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Protein. Protein must be a whole number between 0 and 200 g.                               | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Carbohydrate. Carbohydrate must be a whole number between 0 and 300 g.                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Fat. Fat must be a whole number between 0 and 200 g.                                       | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Servings these figures are for. Enter a serving count between 1 and 24.                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `meal-form-save`             | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard                      | `button`   | Save meal                                                                                  | derived — `accessibleName(...)` in MealCard.tsx                           |

### MealForm (edit) — 39 interactive elements

| Element                      | Render site (`apps/mobile/src/…`)                                         | Component                     | Role       | Accessible name                                                                            | How the name is produced                                                  |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------- | ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Meal name, required                                                                        | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Description. Optional. What it is, in a line or two.                                       | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `chip-period-breakfast`      | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Breakfast                                                                                  | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-lunch`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Lunch                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-dinner`         | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Dinner                                                                                     | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-snack`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Snack                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-regular`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Regular                                                                                    | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-vegetarian`       | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Vegetarian                                                                                 | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-vegan`            | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Vegan                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-halal-preference` | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Halal preference                                                                           | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-gluten-aware`     | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Gluten aware                                                                               | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-allergen-peanut`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Peanut                                                                                     | derived — `labelOf(value)`                                                |
| `chip-allergen-tree-nut`     | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Tree nut                                                                                   | derived — `labelOf(value)`                                                |
| `chip-allergen-milk`         | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Milk                                                                                       | derived — `labelOf(value)`                                                |
| `chip-allergen-egg`          | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Egg                                                                                        | derived — `labelOf(value)`                                                |
| `chip-allergen-soy`          | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Soy                                                                                        | derived — `labelOf(value)`                                                |
| `chip-allergen-wheat`        | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Wheat                                                                                      | derived — `labelOf(value)`                                                |
| `chip-allergen-gluten`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Gluten                                                                                     | derived — `labelOf(value)`                                                |
| `chip-allergen-fish`         | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Fish                                                                                       | derived — `labelOf(value)`                                                |
| `chip-allergen-shellfish`    | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Shellfish                                                                                  | derived — `labelOf(value)`                                                |
| `chip-allergen-sesame`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Sesame                                                                                     | derived — `labelOf(value)`                                                |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Ingredient 1                                                                               | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Measure                                                                                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `remove-ingredient-0`        | `features/saved/MealFormControls.tsx`                                     | IconButton                    | `button`   | Remove ingredient 1                                                                        | prop — `Remove ingredient ${position}`                                    |
| `add-ingredient`             | `features/saved/MealFormScreen.tsx`                                       | AccessibleButton              | `button`   | Add an ingredient                                                                          | derived from `label`                                                      |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Step 1                                                                                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `remove-instruction-0`       | `features/saved/MealFormControls.tsx`                                     | IconButton                    | `button`   | Remove step 1                                                                              | prop — `Remove step ${position}`                                          |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Step 2                                                                                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `remove-instruction-1`       | `features/saved/MealFormControls.tsx`                                     | IconButton                    | `button`   | Remove step 2                                                                              | prop — `Remove step ${position}`                                          |
| `add-instruction`            | `features/saved/MealFormScreen.tsx`                                       | AccessibleButton              | `button`   | Add a step                                                                                 | derived from `label`                                                      |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Price, required. In dollars and cents. Enter 0 if it costs you nothing.                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Preparation time in minutes, required. Enter a preparation time between 0 and 600 minutes. | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Calories. Calories must be a whole number between 0 and 2000 kcal.                         | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Protein. Protein must be a whole number between 0 and 200 g.                               | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Carbohydrate. Carbohydrate must be a whole number between 0 and 300 g.                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Fat. Fat must be a whole number between 0 and 200 g.                                       | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Servings these figures are for. Enter a serving count between 1 and 24.                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `meal-form-save`             | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard                      | `button`   | Save changes                                                                               | derived — `accessibleName(...)` in MealCard.tsx                           |
| `meal-form-delete`           | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard                      | `button`   | Delete meal                                                                                | derived — `accessibleName(...)` in MealCard.tsx                           |

### MealForm (confirm delete) — 42 interactive elements

| Element                      | Render site (`apps/mobile/src/…`)                                         | Component                     | Role       | Accessible name                                                                            | How the name is produced                                                  |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------- | ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Meal name, required                                                                        | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Description. Optional. What it is, in a line or two.                                       | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `chip-period-breakfast`      | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Breakfast                                                                                  | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-lunch`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Lunch                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-dinner`         | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Dinner                                                                                     | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-period-snack`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Snack                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-regular`          | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Regular                                                                                    | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-vegetarian`       | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Vegetarian                                                                                 | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-vegan`            | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Vegan                                                                                      | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-halal-preference` | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Halal preference                                                                           | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-diet-gluten-aware`     | `features/saved/MealFormControls.tsx`                                     | Chip (multi-select ChipGroup) | `checkbox` | Gluten aware                                                                               | derived — `labelOf(value)`, via `accessibilityLabel ?? label`             |
| `chip-allergen-peanut`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Peanut                                                                                     | derived — `labelOf(value)`                                                |
| `chip-allergen-tree-nut`     | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Tree nut                                                                                   | derived — `labelOf(value)`                                                |
| `chip-allergen-milk`         | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Milk                                                                                       | derived — `labelOf(value)`                                                |
| `chip-allergen-egg`          | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Egg                                                                                        | derived — `labelOf(value)`                                                |
| `chip-allergen-soy`          | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Soy                                                                                        | derived — `labelOf(value)`                                                |
| `chip-allergen-wheat`        | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Wheat                                                                                      | derived — `labelOf(value)`                                                |
| `chip-allergen-gluten`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Gluten                                                                                     | derived — `labelOf(value)`                                                |
| `chip-allergen-fish`         | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Fish                                                                                       | derived — `labelOf(value)`                                                |
| `chip-allergen-shellfish`    | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Shellfish                                                                                  | derived — `labelOf(value)`                                                |
| `chip-allergen-sesame`       | `features/saved/MealFormControls.tsx`                                     | Chip (ChipGroup)              | `checkbox` | Sesame                                                                                     | derived — `labelOf(value)`                                                |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Ingredient 1                                                                               | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Measure                                                                                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `remove-ingredient-0`        | `features/saved/MealFormControls.tsx`                                     | IconButton                    | `button`   | Remove ingredient 1                                                                        | prop — `Remove ingredient ${position}`                                    |
| `add-ingredient`             | `features/saved/MealFormScreen.tsx`                                       | AccessibleButton              | `button`   | Add an ingredient                                                                          | derived from `label`                                                      |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Step 1                                                                                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `remove-instruction-0`       | `features/saved/MealFormControls.tsx`                                     | IconButton                    | `button`   | Remove step 1                                                                              | prop — `Remove step ${position}`                                          |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Step 2                                                                                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `remove-instruction-1`       | `features/saved/MealFormControls.tsx`                                     | IconButton                    | `button`   | Remove step 2                                                                              | prop — `Remove step ${position}`                                          |
| `add-instruction`            | `features/saved/MealFormScreen.tsx`                                       | AccessibleButton              | `button`   | Add a step                                                                                 | derived from `label`                                                      |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Price, required. In dollars and cents. Enter 0 if it costs you nothing.                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Preparation time in minutes, required. Enter a preparation time between 0 and 600 minutes. | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Calories. Calories must be a whole number between 0 and 2000 kcal.                         | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Protein. Protein must be a whole number between 0 and 200 g.                               | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Carbohydrate. Carbohydrate must be a whole number between 0 and 300 g.                     | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Fat. Fat must be a whole number between 0 and 200 g.                                       | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| _(no testID)_                | `features/saved/MealFormScreen.tsx + features/saved/MealFormControls.tsx` | FormField                     | `textbox`  | Servings these figures are for. Enter a serving count between 1 and 24.                    | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `meal-form-save`             | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard                      | `button`   | Save changes                                                                               | derived — `accessibleName(...)` in MealCard.tsx                           |
| `meal-form-delete`           | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard                      | `button`   | Delete meal                                                                                | derived — `accessibleName(...)` in MealCard.tsx                           |
| _(no testID)_                | `shared/components/Sheet.tsx`                                             | IconButton                    | `button`   | Close                                                                                      | constant — `CLOSE_LABEL`                                                  |
| `meal-form-delete-confirm`   | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard                      | `button`   | Delete meal                                                                                | derived — `accessibleName(...)` in MealCard.tsx                           |
| `meal-form-delete-cancel`    | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard                      | `button`   | Keep meal                                                                                  | derived — `accessibleName(...)` in MealCard.tsx                           |

### Settings — 9 interactive elements

| Element                      | Render site (`apps/mobile/src/…`)      | Component        | Role       | Accessible name                 | How the name is produced                                          |
| ---------------------------- | -------------------------------------- | ---------------- | ---------- | ------------------------------- | ----------------------------------------------------------------- |
| `settings-edit-preferences`  | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Edit preferences and meal times | derived from `label` (the counts are interpolated)                |
| `settings-ai-toggle`         | `features/settings/SettingsScreen.tsx` | Chip             | `checkbox` | Use AI                          | derived from `label`                                              |
| `chip-theme-system`          | `features/settings/SettingsScreen.tsx` | Chip             | `button`   | Theme: System, selected         | prop — explicit `accessibilityLabel`, carrying the selected state |
| `chip-theme-light`           | `features/settings/SettingsScreen.tsx` | Chip             | `button`   | Theme: Light                    | prop — explicit `accessibilityLabel`, carrying the selected state |
| `chip-theme-dark`            | `features/settings/SettingsScreen.tsx` | Chip             | `button`   | Theme: Dark                     | prop — explicit `accessibilityLabel`, carrying the selected state |
| `settings-clear-favorites`   | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Clear favourites (2)            | derived from `label` (the counts are interpolated)                |
| `settings-clear-customMeals` | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Delete my own meals (1)         | derived from `label` (the counts are interpolated)                |
| `settings-clear-preferences` | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Reset preferences to defaults   | derived from `label` (the counts are interpolated)                |
| `settings-reset-all`         | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Erase all data on this device   | derived from `label` (the counts are interpolated)                |

### Settings (confirm erase) — 12 interactive elements

| Element                      | Render site (`apps/mobile/src/…`)      | Component        | Role       | Accessible name                 | How the name is produced                                          |
| ---------------------------- | -------------------------------------- | ---------------- | ---------- | ------------------------------- | ----------------------------------------------------------------- |
| `settings-edit-preferences`  | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Edit preferences and meal times | derived from `label` (the counts are interpolated)                |
| `settings-ai-toggle`         | `features/settings/SettingsScreen.tsx` | Chip             | `checkbox` | Use AI                          | derived from `label`                                              |
| `chip-theme-system`          | `features/settings/SettingsScreen.tsx` | Chip             | `button`   | Theme: System, selected         | prop — explicit `accessibilityLabel`, carrying the selected state |
| `chip-theme-light`           | `features/settings/SettingsScreen.tsx` | Chip             | `button`   | Theme: Light                    | prop — explicit `accessibilityLabel`, carrying the selected state |
| `chip-theme-dark`            | `features/settings/SettingsScreen.tsx` | Chip             | `button`   | Theme: Dark                     | prop — explicit `accessibilityLabel`, carrying the selected state |
| `settings-clear-favorites`   | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Clear favourites (2)            | derived from `label` (the counts are interpolated)                |
| `settings-clear-customMeals` | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Delete my own meals (1)         | derived from `label` (the counts are interpolated)                |
| `settings-clear-preferences` | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Reset preferences to defaults   | derived from `label` (the counts are interpolated)                |
| `settings-reset-all`         | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Erase all data on this device   | derived from `label` (the counts are interpolated)                |
| _(no testID)_                | `shared/components/Sheet.tsx`          | IconButton       | `button`   | Close                           | constant — `CLOSE_LABEL`                                          |
| `settings-confirm`           | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Erase everything                | derived from `label` (the counts are interpolated)                |
| `settings-cancel`            | `features/settings/SettingsScreen.tsx` | AccessibleButton | `button`   | Keep my data                    | derived from `label` (the counts are interpolated)                |

### Assistant — 2 interactive elements

| Element         | Render site (`apps/mobile/src/…`)        | Component        | Role      | Accessible name                                                            | How the name is produced                                                  |
| --------------- | ---------------------------------------- | ---------------- | --------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| _(no testID)_   | `features/assistant/AssistantScreen.tsx` | FormField        | `textbox` | Your question. Up to 500 characters. Each question is answered on its own. | derived — `accessibleName(label, required, hint, error)` in FormField.tsx |
| `assistant-ask` | `features/assistant/AssistantScreen.tsx` | AccessibleButton | `button`  | Ask                                                                        | derived from `label` (`ASSISTANT_COPY.askLabel`)                          |

### Assistant (answered turn) — 3 interactive elements

| Element                                | Render site (`apps/mobile/src/…`)         | Component        | Role      | Accessible name                                                            | How the name is produced                                                         |
| -------------------------------------- | ----------------------------------------- | ---------------- | --------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| _(no testID)_                          | `features/assistant/AssistantScreen.tsx`  | FormField        | `textbox` | Your question. Up to 500 characters. Each question is answered on its own. | derived — `accessibleName(label, required, hint, error)` in FormField.tsx        |
| `assistant-ask`                        | `features/assistant/AssistantScreen.tsx`  | AccessibleButton | `button`  | Ask                                                                        | derived from `label` (`ASSISTANT_COPY.askLabel`)                                 |
| `assistant-citation-english-breakfast` | `features/assistant/AssistantTurnRow.tsx` | AccessibleButton | `button`  | English Breakfast                                                          | derived from `label={citation.name}` — **no `accessibilityLabel`**, deliberately |

### TabNavigator — 7 interactive elements

| Element                       | Render site (`apps/mobile/src/…`)                                         | Component        | Role     | Accessible name                                                             | How the name is produced                                                           |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------- | -------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `meal-english-breakfast`      | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard         | `button` | English Breakfast. $9.50. 30 minutes. regular. Fits your preferences.       | derived — `accessibleName(...)` in MealCard.tsx                                    |
| `meal-full-english-breakfast` | `features/home/HomeScreen.tsx + features/catalog/ExploreScreen.tsx`       | MealCard         | `button` | Full English Breakfast. $10.50. 35 minutes. regular. Fits your preferences. | derived — `accessibleName(...)` in MealCard.tsx                                    |
| _(no testID)_                 | `navigation/TabNavigator.tsx (rendered by @react-navigation/bottom-tabs)` | BottomTabBar tab | `tab`    | _(from content)_ Home                                                       | content — the tab's visible `title`; its icon is `aria-hidden`, so it adds nothing |
| _(no testID)_                 | `navigation/TabNavigator.tsx (rendered by @react-navigation/bottom-tabs)` | BottomTabBar tab | `tab`    | _(from content)_ Explore                                                    | content — the tab's visible `title`; its icon is `aria-hidden`, so it adds nothing |
| _(no testID)_                 | `navigation/TabNavigator.tsx (rendered by @react-navigation/bottom-tabs)` | BottomTabBar tab | `tab`    | _(from content)_ Assistant                                                  | content — the tab's visible `title`; its icon is `aria-hidden`, so it adds nothing |
| _(no testID)_                 | `navigation/TabNavigator.tsx (rendered by @react-navigation/bottom-tabs)` | BottomTabBar tab | `tab`    | _(from content)_ Saved                                                      | content — the tab's visible `title`; its icon is `aria-hidden`, so it adds nothing |
| _(no testID)_                 | `navigation/TabNavigator.tsx (rendered by @react-navigation/bottom-tabs)` | BottomTabBar tab | `tab`    | _(from content)_ Settings                                                   | content — the tab's visible `title`; its icon is `aria-hidden`, so it adds nothing |

### ErrorBoundary (fallback) — 1 interactive element

| Element       | Render site (`apps/mobile/src/…`)                                                    | Component        | Role     | Accessible name | How the name is produced                     |
| ------------- | ------------------------------------------------------------------------------------ | ---------------- | -------- | --------------- | -------------------------------------------- |
| _(no testID)_ | `shared/components/ErrorState.tsx · OfflineState.tsx · navigation/ErrorBoundary.tsx` | AccessibleButton | `button` | Try again       | constant — each state's default `retryLabel` |

### shared components, the variants no screen above reaches — 15 interactive elements

| Element                       | Render site (`apps/mobile/src/…`)                                                    | Component                   | Role       | Accessible name                     | How the name is produced                                     |
| ----------------------------- | ------------------------------------------------------------------------------------ | --------------------------- | ---------- | ----------------------------------- | ------------------------------------------------------------ |
| _(no testID)_                 | `shared/components/ErrorState.tsx · OfflineState.tsx · navigation/ErrorBoundary.tsx` | AccessibleButton            | `button`   | Try again                           | constant — each state's default `retryLabel`                 |
| _(no testID)_                 | `shared/components/ErrorState.tsx`                                                   | AccessibleButton            | `button`   | Go back                             | prop — `secondaryActionLabel`                                |
| _(no testID)_                 | `shared/components/EmptyState.tsx`                                                   | AccessibleButton            | `button`   | Add one                             | prop — `actionLabel`                                         |
| _(no testID)_                 | `shared/components/ErrorState.tsx · OfflineState.tsx · navigation/ErrorBoundary.tsx` | AccessibleButton            | `button`   | Try again                           | constant — each state's default `retryLabel`                 |
| _(no testID)_                 | `shared/components/StatusMessage.tsx`                                                | AccessibleButton            | `button`   | Go                                  | prop — `actionLabel`                                         |
| _(no testID)_                 | `shared/components/Toast.tsx`                                                        | Pressable                   | `button`   | Undo                                | prop — `accessibilityLabel={actionLabel}`                    |
| _(no testID)_                 | `shared/components/Toast.tsx`                                                        | Pressable                   | `button`   | Dismiss                             | constant — `DISMISS_LABEL`                                   |
| _(no testID)_ _(tabindex -1)_ | `shared/components/AccessibleButton.tsx`                                             | AccessibleButton (disabled) | `button`   | Save                                | derived from `label`                                         |
| _(no testID)_ _(tabindex -1)_ | `shared/components/AccessibleButton.tsx`                                             | AccessibleButton (loading)  | `button`   | Send                                | derived from `label`                                         |
| _(no testID)_ _(tabindex -1)_ | `shared/components/Chip.tsx`                                                         | Chip (disabled, toggle)     | `checkbox` | Vegan                               | derived from `label`                                         |
| _(no testID)_ _(tabindex -1)_ | `shared/components/Sheet.tsx`                                                        | IconButton                  | `button`   | Close                               | constant — `CLOSE_LABEL`                                     |
| _(no testID)_                 | `shared/components/SearchField.tsx`                                                  | SearchField                 | `textbox`  | Search                              | constant — `DEFAULT_LABEL`, used when the caller passes none |
| _(no testID)_                 | `shared/components/SearchField.tsx`                                                  | IconButton                  | `button`   | Clear search                        | constant — `CLEAR_LABEL`                                     |
| _(no testID)_                 | `shared/components/FormField.tsx`                                                    | FormField                   | `textbox`  | Name, required. Required            | derived — `accessibleName(label, required, hint, error)`     |
| _(no testID)_                 | `shared/components/MealCard.tsx`                                                     | MealCard (unavailable)      | `button`   | X. Not available now. $1. 5 minutes | derived — `accessibleName(...)`                              |

## The count

| Surface                                                 | Interactive elements | Outside the accessibility tree | Roles rendered                                                |
| ------------------------------------------------------- | -------------------- | ------------------------------ | ------------------------------------------------------------- |
| Splash                                                  | 0                    | 0                              | `generic,alert`                                               |
| Onboarding                                              | 1                    | 0                              | `generic,heading,button`                                      |
| DietarySetup                                            | 27                   | 0                              | `generic,heading,textbox,toolbar,checkbox,button`             |
| Home                                                    | 2                    | 0                              | `generic,heading,button,presentation`                         |
| Explore                                                 | 22                   | 0                              | `generic,search,textbox,toolbar,checkbox,button,presentation` |
| MealDetails                                             | 2                    | 0                              | `generic,button,heading,img`                                  |
| Saved                                                   | 4                    | 0                              | `generic,heading,button,presentation`                         |
| Saved (forget an orphan)                                | 7                    | 3                              | `generic,heading,button,presentation,dialog`                  |
| MealForm (create)                                       | 36                   | 0                              | `generic,heading,textbox,checkbox,button`                     |
| MealForm (edit)                                         | 39                   | 0                              | `generic,heading,textbox,checkbox,button`                     |
| MealForm (confirm delete)                               | 42                   | 3                              | `generic,heading,textbox,checkbox,button,presentation,dialog` |
| Settings                                                | 9                    | 0                              | `generic,heading,button,checkbox`                             |
| Settings (confirm erase)                                | 12                   | 3                              | `generic,heading,button,checkbox,presentation,dialog`         |
| Assistant                                               | 2                    | 0                              | `generic,heading,textbox,button`                              |
| Assistant (answered turn)                               | 3                    | 0                              | `generic,heading,textbox,button`                              |
| TabNavigator                                            | 7                    | 0                              | `generic,main,heading,button,presentation,tablist,tab`        |
| ErrorBoundary (fallback)                                | 1                    | 0                              | `generic,alert,button`                                        |
| shared components, the variants no screen above reaches | 15                   | 0                              | `generic,alert,button,checkbox,search,textbox`                |
| **Total across 18 surfaces**                            | **231**              | **9**                          |                                                               |

---

## Elements with no role or no name

**None.** Across 231 enumerated instances on 18 surfaces, every one carried both a role and a
non-blank accessible name.

That is a claim about what would happen if it stopped being true, not an absence of evidence:
stripping `accessibilityLabel` from one real control — `shared/components/IconButton.tsx`'s
`accessibilityLabel={accessibilityLabel}` replaced by `undefined`, applied as a load-time source
substitution so no file in the tree was ever written — turned **7 of the 18 surfaces red** and named
the affected controls individually (`meal-details-dismiss`, `meal-details-favorite`,
`remove-ingredient-0`, `remove-instruction-0`, `remove-instruction-1`, each `Sheet`'s close button,
and the disabled `IconButton`). An `IconButton` renders an icon whose glyph is `aria-hidden`, so it
has no content name to fall back on — losing the prop loses the name outright.

## Observations that are not T-23-01 failures

Recorded because they are real and because the next reader should not have to rediscover them.
**None of these is fixed here** — every file named belongs to another agent this wave.

1. **`role="search"` sits on the wrapper `View`, not on the input**
   (`apps/mobile/src/shared/components/SearchField.tsx`, `accessibilityRole="search"`). Read from
   the shipped library rather than from its documentation, at the pinned 0.21.2:
   `react-native-web/dist/modules/AccessibilityUtil/propsToAriaRole.js:20` is `search: 'search'`, so
   the prop produces the ARIA **landmark** role on that `View`; and React Native's own
   `Libraries/Components/View/ViewAccessibility.d.ts` declares `'search'` and `'searchbox'` as two
   distinct members, so the widget role was available and is not what was used. The measured
   consequence: the wrapper is an unnamed landmark and the `input` inside it has the implicit role
   `textbox` rather than `searchbox`. The control itself is named (`Search meals` on Explore), so
   T-23-01 holds either way. Severity MINOR, and not fixed here — the file is another agent's.
2. **`Toast` has no production call site.** `grep` for `<Toast` across `apps/mobile/src` and
   `apps/mobile/App.tsx` returns the component's own definition, the barrel export in
   `shared/components/index.ts`, and this audit's test — nothing else. Its two controls (`Undo`,
   `Dismiss`) are both correctly named, and both are named only because this audit renders the
   component directly. This is R-61's shape ("surfaces that exist and that no test renders"),
   one item further on: a surface that exists and that **no screen** renders.
3. **The tab buttons carry no `accessibilityLabel`, deliberately and correctly.**
   `apps/mobile/src/navigation/TabNavigator.tsx` says so in as many words, and the render confirms
   it: each tab's name comes from its visible `title`, and its icon is `aria-hidden` so it
   contributes nothing. A label would say the word twice.
4. **`assistant-citation-*` also carries no `accessibilityLabel`, deliberately.**
   `features/assistant/AssistantTurnRow.tsx` derives the name from `label={citation.name}` and puts
   what pressing it does in `accessibilityHint`. The rationale in that file is accurate.

## Files in flight when this was measured

The tree was being edited by roughly twenty agents while this table was produced. Every file below
had been modified within the six hours before the **2026-09-15T00:35:00Z** measurement, and the ones
marked ● render or shape something in the table above — so a row that disagrees with the tree should
be re-measured before it is treated as a finding about the code.

| Modified (local) | File                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| 17:33            | ● `apps/mobile/src/features/catalog/useMealSearch.ts`                           |
| 17:33            | `apps/mobile/src/shared/components/Sheet.dom.test.tsx`                          |
| 17:32            | ● `apps/mobile/src/features/onboarding/SplashSurface.tsx`                       |
| 17:31            | ● `apps/mobile/src/features/register.ts`                                        |
| 17:31            | `apps/mobile/src/navigation/RootNavigator.dom.test.tsx`                         |
| 17:28            | ● `apps/mobile/src/navigation/TabNavigator.tsx`                                 |
| 17:26            | ● `apps/mobile/App.tsx`                                                         |
| 17:26            | ● `apps/mobile/src/features/saved/SavedScreen.tsx`                              |
| 17:25            | `apps/mobile/src/navigation/linking.ts`                                         |
| 17:22            | ● `apps/mobile/src/shared/components/SearchField.tsx`                           |
| 17:21            | ● `apps/mobile/src/features/onboarding/DietarySetupScreen.tsx`                  |
| 17:20            | ● `apps/mobile/src/features/assistant/AssistantScreen.tsx`                      |
| 17:19            | ● `apps/mobile/src/features/catalog/ExploreScreen.tsx`                          |
| 17:18            | ● `apps/mobile/src/features/home/HomeScreen.tsx`                                |
| 17:17            | ● `apps/mobile/src/navigation/RootNavigator.tsx`                                |
| 17:17            | ● `apps/mobile/src/navigation/ErrorBoundary.dom.test.tsx` (the boundary itself) |
| 17:13            | ● `apps/mobile/src/features/saved/mealFormValidation.ts`                        |

One of those edits is already visible in the table: `TabNavigator`'s surface now renders
`role="main"`, from `RootNavigator.tsx`'s new `role={focused ? 'main' : undefined}` landmark. It was
classified as a landmark ahead of time so that its arrival did not redden this audit — and if a
sibling adds a role that has **not** been classified, the closure assertion will say so by name.

## What this audit did NOT reach

Stated plainly, because a coverage claim is only as honest as its gaps.

- **Error, empty and offline states of the data screens.** The stub API client resolves, so Home,
  Explore, Saved and MealDetails were enumerated in their loaded state. The _controls_ those states
  render are covered — `ErrorState`, `EmptyState`, `OfflineState` and `StatusMessage` are each
  rendered with their actions on the `shared components` surface — but not the screen-level call
  sites that pass their labels.
- **Later pages of Explore.** `FlatList` virtualises, so 8 of the 20 returned meals rendered, plus
  the `explore-more` footer button. The ninth row is the same `MealCard` call site as the first.
- **Explore's own filter sheet, if it gains one**, and any control behind a gesture. Nothing here is
  driven by a scroll or a swipe.
- **The native platforms.** This is react-native-web under jsdom. `accessibilityRole` and
  `accessibilityLabel` are the props iOS and Android read too, so a name present here is a name
  present there; a _mapping_ difference (the `search` role above is one) is not observable from this
  environment.
- **Contrast, touch-target size, focus order and text scaling.** T-23-02 through T-23-07 own those.
  This table is roles and names only.
